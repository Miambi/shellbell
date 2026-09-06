import {
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
});
