import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authMessage,
  type CtrlMessage,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  type InnerMessage,
  open,
  pairingAd,
  parseCtrl,
  parseQr,
  seal,
  sign,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { loadConfig, loadPairings, type Paths, paths } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakePhone } from "./fakes/fake-phone.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });

/** A phone-side WebSocket client speaking the relay protocol. */
class PhoneSocket {
  ws!: WebSocket;
  ctrl: CtrlMessage[] = [];
  e2e: Envelope[] = [];
  inner: InnerMessage[] = [];
  phone: FakePhone | null = null;
  constructor(readonly identity = generateIdentity()) {}
  get fp() {
    return fingerprint(this.identity.ed25519.pub);
  }
  connect(
    url: string,
    computerFp: string,
    role: "phone" | "pairing",
    gate?: Uint8Array,
  ): Promise<void> {
    this.ws = new WebSocket(`${url}/ws/${computerFp}`);
    return new Promise((resolve) => {
      this.ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeEnvelope(new Uint8Array(data as Buffer));
        if (env.t === "e2e") {
          this.e2e.push(env);
          if (this.phone) {
            if (env.seq === 0) this.phone.acceptHello(env);
            else this.inner.push(this.phone.open(env));
          }
          return;
        }
        const m = parseCtrl(env.body);
        this.ctrl.push(m);
        if (m.type === "challenge") {
          const sig = sign(
            this.identity.ed25519.priv,
            authMessage(m.connId, role, this.fp, m.nonce),
          );
          this.sendCtrl({
            type: "auth",
            role,
            fp: this.fp,
            ed25519Pub: this.identity.ed25519.pub,
            sig,
            name: "iPhone",
            appVersion: "t",
            gate,
          });
        }
        if (m.type === "auth-ok") resolve();
      });
    });
  }
  sendCtrl(body: CtrlMessage) {
    this.ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: this.fp, seq: 0, body }), {
      binary: true,
    });
  }
  send(env: Envelope) {
    this.ws.send(encodeEnvelope(env), { binary: true });
  }
}

let relay: FakeRelay;
let backend: FakeBackend;
let agent: Agent;
let computerFp: string;
let agentPaths: Paths;

/** A PhoneSocket that has completed conn.hello, so `phone` is non-null. */
type ConnectedPhone = PhoneSocket & { phone: FakePhone };

/**
 * Runs the whole pairing dance for one phone and returns a connected, handshaken phone socket.
 * Used by every test below so the flow is written exactly once.
 */
async function pairAndConnect(): Promise<ConnectedPhone> {
  const { qrText } = agent.openPairing();
  const qr = parseQr(qrText, { allowInsecure: true });
  const pairSock = new PhoneSocket();
  await pairSock.connect(relay.url, computerFp, "pairing", fromBase64Url(qr.g));
  const code = fromBase64Url(qr.p);
  const kPsk = derivePskKey(code, computerFp);
  const box = seal(
    kPsk,
    encodeCbor({
      ed25519Pub: pairSock.identity.ed25519.pub,
      x25519Pub: pairSock.identity.x25519.pub,
      name: "iPhone",
      platform: "ios",
    }),
    pairingAd("request", computerFp, pairSock.fp),
  );
  pairSock.sendCtrl({ type: "pairing-request", phoneFp: pairSock.fp, box });
  await waitFor(() => pairSock.ctrl.some((m) => m.type === "pairing-response"));
  const resp = pairSock.ctrl.find((m) => m.type === "pairing-response");
  if (resp?.type !== "pairing-response") throw new Error("no pairing-response");
  const inner = decodeCbor(
    open(kPsk, resp.box, pairingAd("response", computerFp, pairSock.fp)),
  ) as { x25519Pub: Uint8Array };
  const kPair = derivePairKey(
    pairSock.identity.x25519.priv,
    inner.x25519Pub,
    code,
    computerFp,
    pairSock.fp,
  );
  pairSock.ws.close();

  const ph = new PhoneSocket(pairSock.identity);
  ph.phone = new FakePhone(pairSock.identity, computerFp, kPair);
  await ph.connect(relay.url, computerFp, "phone");
  ph.send(ph.phone.hello());
  await waitFor(() => ph.inner.some((m) => m.type === "sessions"));
  return ph as ConnectedPhone;
}

beforeEach(async () => {
  const p = paths(mkdtempSync(join(tmpdir(), "sb-agent-")));
  agentPaths = p;
  const { identity, fp } = loadOrCreateIdentity(p);
  computerFp = fp;
  relay = new FakeRelay(fp);
  await relay.start();
  backend = new FakeBackend();
  backend.addSession("S1", { rows: 3, lines: ["one", "two", "three"], scrollbackTotal: 5 });
  const registry = new BackendRegistry(log);
  registry.add(backend);
  // NB: config.relayUrl is deliberately left at its default (a wss:// URL) rather than set to
  // FakeRelay's ws://127.0.0.1 address: PairingManager round-trips the QR text through parseQr(),
  // which requires wss:// (spec-correct: a real phone must never be told to dial plaintext ws://).
  // relayUrlOverride below redirects only the agent's own relay *socket* to the fake server;
  // pairAndConnect() likewise dials `relay.url` directly rather than the (unreachable) `qr.r`.
  const config = { ...loadConfig(p), computerName: "MBP" };
  agent = new Agent({
    paths: p,
    config,
    identity,
    fp,
    registry,
    log,
    confirm: async () => true,
    appVersion: "0.0.1-test",
    relayUrlOverride: relay.url,
  });
  agent.start();
  await waitFor(() => agent.relayOnline);
});
afterEach(async () => {
  agent.stop();
  await relay.stop();
});

describe("Agent end to end (fake relay, fake backend)", () => {
  it("pairs, handshakes, receives hello+sessions, views a session, types with ack, gets diffs and events", async () => {
    // --- pair, reconnect as a phone, run conn.hello (the dance lives in pairAndConnect) ---
    const ph = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(1);
    expect(ph.inner[0]).toMatchObject({
      type: "hello",
      computerName: "MBP",
      backends: [{ name: "iterm2" }],
    });
    const sessions = ph.inner.find((m) => m.type === "sessions");
    if (sessions?.type !== "sessions") throw new Error();
    expect(sessions.list.map((s) => s.id)).toEqual(["iterm2:S1"]);

    // --- view + snapshot ---
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "screen.snapshot"));
    const snap = ph.inner.find((m) => m.type === "screen.snapshot");
    if (snap?.type !== "screen.snapshot") throw new Error();
    expect(snap.lines.map((l) => l.r[0]?.t)).toEqual(["one", "two", "three"]);

    // --- input with ack, duplicate reqId not re-executed ---
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack"));
    expect(backend.sentText).toEqual([{ id: "S1", text: "y\r" }]);
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.filter((m) => m.type === "ack").length === 2);
    expect(backend.sentText).toHaveLength(1);

    // --- output → diff; command-end → event to the phone; ring to the relay ---
    backend.appendLine("S1", "four");
    await waitFor(() => ph.inner.some((m) => m.type === "screen.diff"));
    backend.emit({
      type: "command-start",
      sessionId: "S1",
      command: "make",
      at: Date.now() - 20_000,
    });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 0, at: Date.now() });
    await waitFor(() => ph.inner.some((m) => m.type === "event"));
    expect(ph.inner.find((m) => m.type === "event")).toMatchObject({
      kind: "prompt",
      sessionId: "iterm2:S1",
      exitCode: 0,
    });
    // durationMs is 0 here because command-start was only just observed; ring requires ≥10 s → none expected
    expect(relay.ctrlFromAgent.filter((m) => m.type === "notify")).toHaveLength(0);

    // --- unsupported focus is acked with an error ---
    backend.capabilities = { ...backend.capabilities, focus: false };
    ph.send(ph.phone.seal({ type: "session.focus", reqId: "r2", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r2"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r2")).toMatchObject({
      ok: false,
      error: "unsupported",
    });

    // --- a mismatched windowId is acked bad-window, not "failed" (spec 8.12) ---
    ph.send(
      ph.phone.seal({
        type: "session.create",
        reqId: "r3",
        in: { kind: "tab", backend: "tmux", windowId: "iterm2:w1" },
      }),
    );
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r3"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r3")).toMatchObject({
      ok: false,
      error: "bad-window",
    });
    ph.ws.close();
  });

  it("applies the relay's minFrameMs to the flush interval", async () => {
    // FakeRelay advertises minFrameMs 125 in auth-ok; the agent must have applied it (spec 4.2/8.6).
    const spy = vi.spyOn(agent.tracker, "setIntervalMs");
    agent.relay.emit("auth-ok", {
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "FakeMac",
      serverTime: Date.now(),
      minFrameMs: 400,
    });
    expect(spy).toHaveBeenCalledWith(400);
    agent.relay.emit("auth-ok", {
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "FakeMac",
      serverTime: Date.now(),
      minFrameMs: 50,
    });
    expect(spy).toHaveBeenLastCalledWith(125); // never below the 125 ms floor
    spy.mockRestore();
  });

  it("applies unpaired tombstones BEFORE sending pairings-sync (Plan 02 parked item)", async () => {
    // The relay clears every tombstone when it handles pairings-sync, so a sync that still lists a
    // tombstoned phone would resurrect it. Order is the whole contract.
    const ph = await pairAndConnect();
    const removedFp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([removedFp]);
    ph.ws.close();

    relay.ctrlFromAgent.length = 0;
    relay.sendToAgent({ type: "unpaired", phoneFps: [removedFp] });
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "pairings-sync"));
    const sync = relay.ctrlFromAgent.find((m) => m.type === "pairings-sync");
    if (sync?.type !== "pairings-sync") throw new Error("no pairings-sync");
    // The tombstone was applied first: the sync must NOT re-register the removed phone.
    expect(sync.phones.map((p) => p.phoneFp)).not.toContain(removedFp);
    expect(agent.pairingList).toHaveLength(0);
    // And it is written through to disk, not just held in memory.
    expect(loadPairings(agentPaths)).toHaveLength(0);
  });

  it("unpair removes the pairing, persists it, drops the link and tells the relay", async () => {
    const ph = await pairAndConnect();
    const fp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([fp]);
    await waitFor(() => agent.connectedPhones.length === 1);
    relay.ctrlFromAgent.length = 0;

    expect(agent.unpair("nobody")).toBe(false);
    expect(agent.unpair(fp.slice(0, 6))).toBe(true); // fp prefix, per spec 8.1

    expect(agent.pairingList).toHaveLength(0);
    expect(loadPairings(agentPaths)).toHaveLength(0); // persisted
    expect(agent.connectedPhones).toHaveLength(0); // link dropped
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "unpair"));
    expect(relay.ctrlFromAgent.find((m) => m.type === "unpair")).toMatchObject({
      type: "unpair",
      phoneFp: fp,
    });
    ph.ws.close();
  });

  it("sends `event` to every handshaken phone, not just the viewer (spec 4.4, 7.4)", async () => {
    const a = await pairAndConnect();
    const b = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(2);
    // Only `a` is viewing anything.
    a.send(a.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => a.inner.some((m) => m.type === "screen.snapshot"));

    backend.emit({ type: "command-start", sessionId: "S1", command: "make", at: Date.now() });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 3, at: Date.now() });
    await waitFor(
      () => a.inner.some((m) => m.type === "event") && b.inner.some((m) => m.type === "event"),
    );
    for (const p of [a, b]) {
      expect(p.inner.find((m) => m.type === "event")).toMatchObject({
        kind: "prompt",
        sessionId: "iterm2:S1",
        exitCode: 3,
      });
    }
    // `b` never subscribed, so it got no screen frames at all.
    expect(
      b.inner.filter((m) => m.type === "screen.snapshot" || m.type === "screen.diff"),
    ).toHaveLength(0);
    a.ws.close();
    b.ws.close();
  });
});
