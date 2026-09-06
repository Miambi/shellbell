import {
  type CtrlMessageLoose,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  type Identity,
  type InnerMessageLoose,
  randomBytes,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../../agent/src/log.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { ComputerConnection, type ConnectionOptions } from "../src/net/connection.js";
import type { Status } from "../src/store/connections.js";

const waitFor = (fn: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });

/**
 * A fully scripted `WsLike` double for tests that need deterministic control over exactly which
 * ctrl frame arrives when (e.g. a `presence` mid-handshake) without racing a real relay/agent.
 */
class FakeSocket {
  binaryType = "";
  readyState = 0;
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(_data: ArrayBuffer | Uint8Array | string): void {
    // Outgoing frames are not inspected by the tests that use this double.
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  triggerEnvelope(env: Envelope): void {
    this.onmessage?.({ data: encodeEnvelope(env) });
  }

  triggerCtrl(body: CtrlMessageLoose): void {
    this.triggerEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body } as Envelope);
  }
}

/** Minimal "agent" on the fake relay: authenticates, answers conn.hello, acks every reqId. */
async function fakeAgent(relay: FakeRelay, mac: Identity, kPair: Uint8Array, phoneFp: string) {
  const fp = fingerprint(mac.ed25519.pub);
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity: mac,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  let link: PhoneLink | null = null;
  const received: InnerMessageLoose[] = [];
  rc.on("ctrl", (m) => {
    if (m.type !== "phone-connected") return;
    link = new PhoneLink({
      phoneFp,
      connId: m.connId,
      name: m.name,
      kPair,
      computerFp: fp,
      send: (e) => {
        rc.sendEnvelope(e);
      },
      log,
    });
  });
  rc.on("e2e", (env) => {
    const current = link;
    if (!current) return;
    const was = current.handshaken;
    const msg = current.handleEnvelope(env);
    if (!was && current.handshaken) {
      current.send({
        type: "hello",
        agentVersion: "t",
        backends: [],
        computerName: "MBP",
        accent: "emerald",
      });
    }
    if (!msg) return;
    received.push(msg as InnerMessageLoose);
    if ("reqId" in msg) current.send({ type: "ack", reqId: msg.reqId, ok: true });
  });
  rc.start();
  await waitFor(() => rc.online);
  return { rc, received };
}

let relay: FakeRelay;
const mac = generateIdentity();
const phone = generateIdentity();
const macFp = fingerprint(mac.ed25519.pub);
const phoneFp = fingerprint(phone.ed25519.pub);
const kPair = randomBytes(32);

function makeConn(over: Partial<ConnectionOptions> = {}) {
  const inner: InnerMessageLoose[] = [];
  const statuses: Status[] = [];
  const c = new ComputerConnection({
    computerFp: macFp,
    relayUrl: relay.url,
    identity: phone,
    phoneFp,
    phoneName: "iPhone",
    appVersion: "t",
    kPair,
    onInner: (m) => inner.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: WebSocket as never,
    backoffMinMs: 50,
    backoffMaxMs: 100,
    ...over,
  });
  return { c, inner, statuses };
}

const leases = () => relay.ctrlFromPhones.filter((r) => r.fp === phoneFp && r.msg.type === "lease");

beforeEach(async () => {
  relay = new FakeRelay(macFp);
  await relay.start();
});
afterEach(async () => {
  await relay.stop();
});

describe("ComputerConnection", () => {
  it("authenticates, leases, handshakes, receives hello, sends inputs with acks", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner, statuses } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    expect(statuses).toEqual(["connecting", "auth", "handshake", "online"]);
    await waitFor(() => leases().length > 0);
    expect(leases()[0]?.msg).toMatchObject({ type: "lease", ttlMs: 60_000 });
    const ack = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "y",
    });
    expect(ack.ok).toBe(true);
    expect(agent.received[0]).toMatchObject({ type: "input.line", text: "y" });
    c.close("user");
    agent.rc.stop();
  });

  it("close('background') sends lease 0 and fails pending requests", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // Stop the agent so nothing can ack; the phone socket stays up.
    agent.rc.stop();
    await waitFor(() => relay.agent === null);
    const before = leases().length;
    const p = c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "x",
    });
    expect(c.pendingReqIds()).toHaveLength(1);
    c.close("background");
    await expect(p).rejects.toThrow(/delivery unknown/i);
    expect(c.pendingReqIds()).toHaveLength(0);
    expect(c.status).toBe("idle");
    await waitFor(() => leases().length > before);
    expect(leases().at(-1)?.msg).toMatchObject({ type: "lease", ttlMs: 0 });
  });

  it("reconnects after the relay drops the socket", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    relay.phones.get(phoneFp)?.ws.terminate();
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
    c.close("user");
    agent.rc.stop();
  });

  it("stops permanently on 4005 (superseded) instead of racing the winner", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const first = makeConn();
    first.c.connect();
    await waitFor(() => first.inner.some((m) => m.type === "hello"));
    const connections = relay.connections;
    const second = makeConn();
    second.c.connect();
    await waitFor(() => first.c.status === "error");
    expect(first.statuses.at(-1)).toBe("error");
    await new Promise((r) => setTimeout(r, 300));
    // No third socket: the loser must not reconnect.
    expect(relay.connections).toBe(connections + 1);
    second.c.close("user");
    agent.rc.stop();
  });

  it("stops permanently when the relay rejects the identity", async () => {
    const { c, statuses } = makeConn({ identity: generateIdentity() });
    c.connect();
    await waitFor(() => c.status === "error");
    const connections = relay.connections;
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.connections).toBe(connections);
    expect(statuses.at(-1)).toBe("error");
  });

  it("ignores a replayed agent conn.hello: seq counters untouched, later frames still decrypt", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // The agent's conn.hello reply: the first e2e frame FROM the agent, at envelope seq 0.
    const helloReply = relay.received.find((r) => r.from.role === "agent" && r.env.seq === 0);
    if (!helloReply) throw new Error("test setup: no agent conn.hello reply observed");
    const replayBytes = encodeEnvelope(helloReply.env);

    // Advance the session with one legitimate round trip first (seqIn/seqOut > 0 both sides).
    const ack1 = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "one",
    });
    expect(ack1.ok).toBe(true);

    // Replay the captured hello reply straight at the phone's socket, as a relay bug or an
    // attacker who recorded the wire would.
    relay.phones.get(phoneFp)?.ws.send(replayBytes, { binary: true });
    await new Promise((r) => setTimeout(r, 200));

    // No re-handshake is directly observable; prove the session survived intact instead — a
    // phone that re-derived K_conn and rewound seqOut to 0 would desync from the agent's
    // already-advanced seqIn and this second request would never be acked (it would hang until
    // the test's timeout).
    const ack2 = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "two",
    });
    expect(ack2.ok).toBe(true);
    expect(agent.received.map((m) => (m as { text?: string }).text)).toEqual(["one", "two"]);
    c.close("user");
    agent.rc.stop();
  });

  it("close() then immediate connect() ignores the stale socket's late close event", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    const connectionsBefore = relay.connections;
    c.close();
    c.connect();
    // The reconnect completes a fresh handshake: a second "hello" app message arrives.
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
    expect(c.status).toBe("online");
    // Give the stale socket's own close event (whatever code it carries — ours, or the relay's
    // 4005 once the reconnect authenticates under the same phone fp) time to arrive and settle.
    await new Promise((r) => setTimeout(r, 300));
    // The socket-identity guard must have ignored it: the live (reconnected) socket is untouched
    // and exactly one extra socket was dialled, never a phantom third one.
    expect(c.status).toBe("online");
    expect(relay.connections).toBe(connectionsBefore + 1);
    c.close("user");
    agent.rc.stop();
  });

  it("close() while still CONNECTING closes the underlying socket instead of leaking it", () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({ WebSocketImpl: RecordingSocket });
    c.connect();
    const sock = sockets[0];
    if (!sock) throw new Error("test setup: no socket constructed");
    // Never opened: still CONNECTING when close() is called.
    expect(sock.readyState).toBe(0);
    c.close();
    // The socket itself must be told to close, not merely abandoned (readyState === OPEN is not
    // the only state close() must act on).
    expect(sock.closed).toBe(true);
    expect(c.status).toBe("idle");
    expect(statuses).toEqual(["connecting", "idle"]);
  });

  it("presence agentOnline:false during handshake clears the hello timer but keeps the socket open", async () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({
      WebSocketImpl: RecordingSocket,
      helloTimeoutMs: 100,
    });
    c.connect();
    const sock = sockets[0];
    if (!sock) throw new Error("test setup: no socket constructed");
    sock.triggerOpen();
    sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
    sock.triggerCtrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      computerName: null,
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    await waitFor(() => c.status === "handshake");
    sock.triggerCtrl({ type: "presence", agentOnline: false, computerName: null });
    await waitFor(() => c.status === "offline");
    // Long enough for the 100ms hello timer to have fired had it not been disarmed.
    await new Promise((r) => setTimeout(r, 300));
    expect(sock.closed).toBe(false);
    expect(statuses.at(-1)).toBe("offline");
  });

  it("tolerates malformed seq-0 hello frames below the shared failure counter", async () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({ WebSocketImpl: RecordingSocket });
    c.connect();
    const sock = sockets[0];
    if (!sock) throw new Error("test setup: no socket constructed");
    sock.triggerOpen();
    sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
    sock.triggerCtrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      computerName: null,
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    await waitFor(() => c.status === "handshake");
    const garbageHello = (): Envelope => ({
      v: 1,
      t: "e2e",
      from: macFp,
      to: phoneFp,
      seq: 0,
      body: { n: randomBytes(24), c: randomBytes(32) },
    });
    // 19 undecryptable hellos in a row: below the 20-failure breaker (spec 6.7), the handshake
    // must be tolerated, not permanently killed by the first one.
    for (let i = 0; i < 19; i++) sock.triggerEnvelope(garbageHello());
    await new Promise((r) => setTimeout(r, 20));
    expect(c.status).toBe("handshake");
    expect(sock.closed).toBe(false);
    // The 20th tips the shared counter over: only now does it become a permanent re-pair.
    sock.triggerEnvelope(garbageHello());
    await waitFor(() => c.status === "error");
    expect(statuses.at(-1)).toBe("error");
  });
});
