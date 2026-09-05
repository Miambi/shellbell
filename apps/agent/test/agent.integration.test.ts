import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDiff,
  applySnapshot,
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
  type ScreenDiff,
  type ScreenSnapshot,
  type ScreenState,
  seal,
  sign,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import * as configModule from "../src/config.js";
import { loadConfig, loadPairings, type Paths, paths } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import type { Logger } from "../src/log.js";
import { createLogger } from "../src/log.js";
import { RelayClient } from "../src/relay-client.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakePhone } from "./fakes/fake-phone.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });

/** A `Logger` that records every call instead of writing anywhere, for white-box assertions. */
function capturingLogger(): {
  log: Logger;
  calls: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const calls: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const mk = (): Logger => ({
    debug: (msg, fields) => calls.push({ level: "debug", msg, fields }),
    info: (msg, fields) => calls.push({ level: "info", msg, fields }),
    warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
    error: (msg, fields) => calls.push({ level: "error", msg, fields }),
    child: () => mk(),
  });
  return { log: mk(), calls };
}

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

interface PairTarget {
  agent: Agent;
  relay: FakeRelay;
  computerFp: string;
}

/**
 * Runs the whole pairing dance for one phone and returns a connected, handshaken phone socket.
 * Used by every test below so the flow is written exactly once. Defaults to the shared
 * `agent`/`relay`/`computerFp` from `beforeEach`; a test that stands up its own second agent
 * (e.g. the `superseded` and fire-and-forget-guard tests) passes its own instead.
 */
async function pairAndConnect(
  target: PairTarget = { agent, relay, computerFp },
): Promise<ConnectedPhone> {
  const { qrText } = target.agent.openPairing();
  const qr = parseQr(qrText, { allowInsecure: true });
  const pairSock = new PhoneSocket();
  await pairSock.connect(target.relay.url, target.computerFp, "pairing", fromBase64Url(qr.g));
  const code = fromBase64Url(qr.p);
  const kPsk = derivePskKey(code, target.computerFp);
  const box = seal(
    kPsk,
    encodeCbor({
      ed25519Pub: pairSock.identity.ed25519.pub,
      x25519Pub: pairSock.identity.x25519.pub,
      name: "iPhone",
      platform: "ios",
    }),
    pairingAd("request", target.computerFp, pairSock.fp),
  );
  pairSock.sendCtrl({ type: "pairing-request", phoneFp: pairSock.fp, box });
  await waitFor(() => pairSock.ctrl.some((m) => m.type === "pairing-response"));
  const resp = pairSock.ctrl.find((m) => m.type === "pairing-response");
  if (resp?.type !== "pairing-response") throw new Error("no pairing-response");
  const inner = decodeCbor(
    open(kPsk, resp.box, pairingAd("response", target.computerFp, pairSock.fp)),
  ) as { x25519Pub: Uint8Array };
  const kPair = derivePairKey(
    pairSock.identity.x25519.priv,
    inner.x25519Pub,
    code,
    target.computerFp,
    pairSock.fp,
  );
  pairSock.ws.close();

  const ph = new PhoneSocket(pairSock.identity);
  ph.phone = new FakePhone(pairSock.identity, target.computerFp, kPair);
  await ph.connect(target.relay.url, target.computerFp, "phone");
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

    // Reconstruct the phone's local screen state through the *shipped* applySnapshot/applyDiff,
    // exactly as a real client would, rather than merely asserting a diff frame arrived: this is
    // the end-to-end proof that the diff actually reconstructs what the backend now shows.
    let screenState: ScreenState | undefined;
    for (const m of ph.inner) {
      if (m.type === "screen.snapshot")
        screenState = applySnapshot(screenState, m as ScreenSnapshot);
      else if (m.type === "screen.diff") {
        if (!screenState) throw new Error("diff arrived before any snapshot");
        const applied = applyDiff(screenState, m as ScreenDiff);
        if (applied.gap) throw new Error("unexpected gap reconstructing screen state");
        screenState = applied.state;
      }
    }
    expect(screenState?.lines.map((l) => l.r[0]?.t)).toEqual(["two", "three", "four"]);

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
    expect(agent.unpair("")).toBe(false); // guard: `"".startsWith("")` must not match the first pairing
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

  it("session.focus on an unknown/unregistered-backend session id acks session-gone, not unsupported (spec 7.4)", async () => {
    const ph = await pairAndConnect();
    // The registry in this suite only ever has an "iterm2" backend added -- "tmux:nope" names a
    // backend that isn't registered, so `capabilitiesOf()` returns null.
    ph.send(ph.phone.seal({ type: "session.focus", reqId: "rfocus", sessionId: "tmux:nope" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rfocus"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rfocus")).toMatchObject({
      ok: false,
      error: "session-gone",
    });
    ph.ws.close();
  });

  it("input to a session on an unregistered backend acks session-gone", async () => {
    const ph = await pairAndConnect();
    ph.send(ph.phone.seal({ type: "input.line", reqId: "rin", sessionId: "tmux:nope", text: "x" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rin"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rin")).toMatchObject({
      ok: false,
      error: "session-gone",
    });
    ph.ws.close();
  });

  it("snapshot.get for a session the phone is not viewing acks an error, not ok", async () => {
    const ph = await pairAndConnect();
    // No `subscribe` was sent, so `link.viewed` is still null -- this must not silently ack ok.
    ph.send(ph.phone.seal({ type: "snapshot.get", reqId: "rsnap", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rsnap"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rsnap")).toMatchObject({
      ok: false,
      error: "not-viewing",
    });
    ph.ws.close();
  });

  it("session.create broadcasts `sessions` exactly once", async () => {
    const ph = await pairAndConnect();
    const before = ph.inner.filter((m) => m.type === "sessions").length;
    ph.send(
      ph.phone.seal({
        type: "session.create",
        reqId: "rcreate",
        in: { kind: "tab", backend: "iterm2" },
      }),
    );
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rcreate"));
    // The `sessions` refresh is debounced 100 ms; give it (generously) time to land, then make
    // sure it landed exactly once rather than counting an absence as success.
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length > before, 1000);
    await new Promise((r) => setTimeout(r, 150));
    expect(ph.inner.filter((m) => m.type === "sessions").length - before).toBe(1);
    ph.ws.close();
  });

  it("exactly-once: a duplicate reqId arriving while the first is still executing is not re-executed (spec 7.4)", async () => {
    const ph = await pairAndConnect();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSendText = backend.sendText.bind(backend);
    backend.sendText = async (id: string, text: string) => {
      await gate;
      return realSendText(id, text);
    };
    try {
      // Both frames are sent before either has any chance to finish executing.
      ph.send(
        ph.phone.seal({ type: "input.line", reqId: "dup1", sessionId: "iterm2:S1", text: "z" }),
      );
      ph.send(
        ph.phone.seal({ type: "input.line", reqId: "dup1", sessionId: "iterm2:S1", text: "z" }),
      );
      // Give the agent time to receive & decrypt both frames (and reserve the reqId for the
      // first) while `sendText` is still gated, so the second frame provably observes the first
      // still in flight rather than an already-completed cached ack.
      await new Promise((r) => setTimeout(r, 30));
      release();
      await waitFor(
        () => ph.inner.filter((m) => m.type === "ack" && m.reqId === "dup1").length === 2,
      );
      expect(backend.sentText.filter((t) => t.text === "z\r")).toHaveLength(1);
      for (const ack of ph.inner.filter((m) => m.type === "ack" && m.reqId === "dup1")) {
        expect(ack).toMatchObject({ ok: true });
      }
    } finally {
      backend.sendText = realSendText;
    }
    ph.ws.close();
  });

  it("stop() closes any open pairing window and drops every phone link + tracker viewer (Important)", async () => {
    const ph = await pairAndConnect();
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "screen.snapshot"));
    expect(agent.connectedPhones).toHaveLength(1);

    agent.openPairing(); // leave a pairing window open across stop()
    const closeWindowSpy = vi.spyOn(agent.pairing, "closeWindow");
    const dropViewerSpy = vi.spyOn(agent.tracker, "dropViewer");

    agent.stop();

    expect(closeWindowSpy).toHaveBeenCalled();
    expect(dropViewerSpy).toHaveBeenCalled();
    expect(agent.connectedPhones).toHaveLength(0);
    ph.ws.close();
  });

  it("superseded (relay closes with 4005): stops the agent and calls onSuperseded (spec §12, Important)", async () => {
    const p3 = paths(mkdtempSync(join(tmpdir(), "sb-agent-superseded-")));
    const { identity: id3, fp: fp3 } = loadOrCreateIdentity(p3);
    const relay3 = new FakeRelay(fp3);
    await relay3.start();
    const registry3 = new BackendRegistry(log);
    registry3.add(new FakeBackend());
    const config3 = { ...loadConfig(p3), computerName: "MBP3" };
    let supersededCalls = 0;
    const agent3 = new Agent({
      paths: p3,
      config: config3,
      identity: id3,
      fp: fp3,
      registry: registry3,
      log,
      confirm: async () => true,
      appVersion: "0.0.1-test",
      relayUrlOverride: relay3.url,
      onSuperseded: () => {
        supersededCalls += 1;
      },
    });
    agent3.start();
    try {
      await waitFor(() => agent3.relayOnline);
      const stopSpy = vi.spyOn(agent3, "stop");

      // A second "agent" socket authenticating with the *same* fp supersedes the first, closing
      // its socket with 4005 (spec §12: "Duplicate agent process: New wins; old exits").
      const impostor = new RelayClient({
        relayUrl: relay3.url,
        fp: fp3,
        identity: id3,
        name: "impostor",
        appVersion: "0.0.1-test",
        log,
      });
      impostor.start();
      try {
        await waitFor(() => supersededCalls === 1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(agent3.relayOnline).toBe(false);
        expect(agent3.connectedPhones).toHaveLength(0);
      } finally {
        impostor.stop();
      }
    } finally {
      agent3.stop();
      await relay3.stop();
    }
  });

  it("guards a fire-and-forget ctrl handler: a savePairings failure during `unpaired` is logged, not thrown (Critical)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);

    const { log: log2, calls } = capturingLogger();
    const p2 = paths(mkdtempSync(join(tmpdir(), "sb-agent-guard-")));
    const { identity: id2, fp: fp2 } = loadOrCreateIdentity(p2);
    const relay2 = new FakeRelay(fp2);
    await relay2.start();
    const registry2 = new BackendRegistry(log2);
    registry2.add(new FakeBackend());
    const config2 = { ...loadConfig(p2), computerName: "MBP2" };
    const agent2 = new Agent({
      paths: p2,
      config: config2,
      identity: id2,
      fp: fp2,
      registry: registry2,
      log: log2,
      confirm: async () => true,
      appVersion: "0.0.1-test",
      relayUrlOverride: relay2.url,
    });
    agent2.start();
    try {
      await waitFor(() => agent2.relayOnline);
      const ph2 = await pairAndConnect({ agent: agent2, relay: relay2, computerFp: fp2 });
      expect(agent2.pairingList).toHaveLength(1);

      const spy = vi.spyOn(configModule, "savePairings").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      try {
        relay2.sendToAgent({ type: "unpaired", phoneFps: [ph2.fp] });
        await waitFor(() => calls.some((c) => c.level === "error" && c.msg === "handler failed"));
      } finally {
        spy.mockRestore();
      }

      expect(calls.find((c) => c.level === "error" && c.msg === "handler failed")).toMatchObject({
        fields: { where: "ctrl" },
      });
      // The agent survived the failure: the relay connection is still up.
      expect(agent2.relayOnline).toBe(true);
      await new Promise((r) => setTimeout(r, 30)); // let any unhandled rejection surface
      expect(rejections).toHaveLength(0);

      ph2.ws.close();
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      agent2.stop();
      await relay2.stop();
    }
  });
});
