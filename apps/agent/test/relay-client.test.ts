import {
  authMessage,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  parseCtrl,
  randomBytes,
  relayWsUrl,
  sign,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../src/log.js";
import { computeBackoff, RelayClient } from "../src/relay-client.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let relay: FakeRelay;
let clients: RelayClient[];
const id = generateIdentity();
const fp = fingerprint(id.ed25519.pub);

function makeClient(overrides: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const c = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity: id,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
    ...overrides,
  });
  clients.push(c);
  return c;
}

/** Connects a raw phone-role socket to the fake relay and completes its handshake. */
async function connectFakePhone(target: FakeRelay, computerFp: string) {
  const phoneId = generateIdentity();
  const phoneFp = fingerprint(phoneId.ed25519.pub);
  const ws = new WebSocket(relayWsUrl(target.url, computerFp));
  const received: Envelope[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const env = decodeEnvelope(new Uint8Array(data as Buffer));
      if (env.t === "ctrl") {
        const msg = parseCtrl(env.body);
        if (msg.type === "challenge") {
          const sig = sign(
            phoneId.ed25519.priv,
            authMessage(msg.connId, "phone", phoneFp, msg.nonce),
          );
          ws.send(
            encodeEnvelope({
              v: 1,
              t: "ctrl",
              from: phoneFp,
              seq: 0,
              body: {
                type: "auth",
                role: "phone",
                fp: phoneFp,
                ed25519Pub: phoneId.ed25519.pub,
                sig,
                name: "iPhone",
                appVersion: "t",
              },
            }),
            { binary: true },
          );
        } else if (msg.type === "auth-ok") {
          resolve();
        }
        return;
      }
      received.push(env);
    });
  });
  return { fp: phoneFp, ws, received };
}

beforeEach(async () => {
  relay = new FakeRelay(fp);
  await relay.start();
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.stop();
  clients = [];
  await relay.stop();
});

describe("RelayClient", () => {
  it("authenticates, receives unpaired+phones, reports online", async () => {
    const c = makeClient();
    const ctrl: string[] = [];
    c.on("ctrl", (m) => ctrl.push(m.type));
    c.start();
    await waitFor(() => c.online);
    await waitFor(() => ctrl.includes("phones"));
    expect(ctrl).toEqual(["unpaired", "phones"]);
  });

  it("reconnects with backoff after the relay drops it", async () => {
    const c = makeClient();
    let downs = 0;
    c.on("down", () => downs++);
    c.start();
    await waitFor(() => c.online);
    relay.dropAgent();
    await waitFor(() => downs === 1);
    await waitFor(() => c.online);
    expect(relay.agent).not.toBeNull();
  });

  it("reports auth-fail bad-sig when the signing key does not match the fp", async () => {
    const other = generateIdentity();
    const c = makeClient({ identity: other });
    let reason = "";
    c.on("auth-fail", (r) => (reason = r));
    c.start();
    await waitFor(() => reason !== "");
    expect(reason).toBe("bad-sig");
    await new Promise((r) => setTimeout(r, 150));
    expect(c.online).toBe(false);
    expect(reason).toBe("bad-sig");
  });

  it("forwards ctrl from the relay and sends ctrl to it", async () => {
    const c = makeClient();
    c.start();
    await waitFor(() => c.online);
    c.sendCtrl({ type: "pairing-close" });
    expect((await relay.nextCtrlFromAgent()).type).toBe("pairing-close");
    const got: string[] = [];
    c.on("ctrl", (m) => got.push(m.type));
    relay.sendToAgent({ type: "presence", agentOnline: true, computerName: "x" });
    await waitFor(() => got.includes("presence"));
  });

  describe("socket-scoped handlers (A)", () => {
    it("start; stop; start leaves exactly one live socket and no stray timers", async () => {
      const c = makeClient();
      c.start();
      c.stop();
      c.start();
      await waitFor(() => c.online);
      await new Promise((r) => setTimeout(r, 150));
      expect(c.online).toBe(true);
      expect(relay.connections).toBe(1);
    });

    it("start() is a no-op while already running", async () => {
      const c = makeClient();
      c.start();
      c.start();
      await waitFor(() => c.online);
      await new Promise((r) => setTimeout(r, 150));
      expect(relay.connections).toBe(1);
    });

    it("stop() emits down once when it was online and terminates the socket", async () => {
      const c = makeClient();
      let downs = 0;
      c.on("down", () => downs++);
      c.start();
      await waitFor(() => c.online);
      c.stop();
      expect(downs).toBe(1);
      expect(c.online).toBe(false);
    });
  });

  describe("close-code semantics (B)", () => {
    it("emits superseded and stops permanently on 4005, without reconnecting", async () => {
      const c1 = makeClient();
      let superseded = false;
      let downs = 0;
      c1.on("superseded", () => (superseded = true));
      c1.on("down", () => downs++);
      c1.start();
      await waitFor(() => c1.online);

      const c2 = makeClient();
      c2.start();
      await waitFor(() => c2.online);

      await waitFor(() => superseded);
      expect(downs).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, 150));
      expect(c1.online).toBe(false);
      expect(relay.agent?.fp).toBe(fp);
      expect(relay.connections).toBe(2);
    });

    it("stops permanently on auth-fail fp-mismatch", async () => {
      relay.nextAuthFailReason = "fp-mismatch";
      const c = makeClient();
      const reasons: string[] = [];
      c.on("auth-fail", (r) => reasons.push(r));
      c.start();
      await waitFor(() => reasons.length >= 1);
      expect(reasons).toEqual(["fp-mismatch"]);
      await new Promise((r) => setTimeout(r, 150));
      expect(c.online).toBe(false);
      expect(reasons).toEqual(["fp-mismatch"]);
    });

    it("reconnects after a transient auth-fail reason", async () => {
      relay.nextAuthFailReason = "timeout";
      const c = makeClient();
      const reasons: string[] = [];
      c.on("auth-fail", (r) => reasons.push(r));
      c.start();
      await waitFor(() => reasons.length >= 1);
      expect(reasons).toEqual(["timeout"]);
      await waitFor(() => c.online);
    });

    it("logs and reconnects on 4429 without giving up", async () => {
      const c = makeClient();
      c.start();
      await waitFor(() => c.online);
      relay.closeAgent(4429, "too fast");
      await waitFor(() => c.online);
      expect(relay.agent).not.toBeNull();
    });

    it("does not reset the backoff attempt counter across repeated 4413/4429 closes", async () => {
      const c = makeClient({ backoffMinMs: 20, backoffMaxMs: 5000 });
      // Reject every raw connection with 4429 before any challenge/auth-ok is ever sent, so nothing
      // can reset the attempt counter except (buggy) special-casing of the close code itself.
      relay.rejectCode = 4429;
      c.start();
      await waitFor(() => relay.connections >= 4);
      relay.rejectCode = null;
      await waitFor(() => c.online);

      const times = relay.connectionTimes;
      const gap1 = (times[1] as number) - (times[0] as number); // attempt 0 -> raw ~20ms
      const gap3 = (times[3] as number) - (times[2] as number); // attempt 2 -> raw ~80ms
      // A correctly-growing backoff should roughly quadruple over two doublings even with +/-20% jitter;
      // a reset bug would keep every gap pinned near backoffMinMs.
      expect(gap3).toBeGreaterThan(gap1 * 2);
    });
  });

  describe("sends gated on auth (C)", () => {
    it("drops sendEnvelope before auth and accepts it after", async () => {
      const c = makeClient();
      c.start();
      const preAuth = c.sendEnvelope({
        v: 1,
        t: "e2e",
        from: fp,
        to: fp,
        seq: 0,
        body: { n: randomBytes(24), c: randomBytes(8) },
      });
      expect(preAuth).toBe(false);
      expect(relay.received.length).toBe(0);

      await waitFor(() => c.online);
      const postAuth = c.sendEnvelope({
        v: 1,
        t: "e2e",
        from: fp,
        to: fp,
        seq: 0,
        body: { n: randomBytes(24), c: randomBytes(8) },
      });
      expect(postAuth).toBe(true);
      await waitFor(() => relay.received.length === 1);
    });

    it("sendCtrl returns false before auth and true after", async () => {
      const c = makeClient();
      c.start();
      expect(c.sendCtrl({ type: "pairing-close" })).toBe(false);
      await waitFor(() => c.online);
      expect(c.sendCtrl({ type: "pairing-close" })).toBe(true);
      await relay.nextCtrlFromAgent();
    });
  });

  describe("keepalive (D)", () => {
    it("stays online across multiple ping intervals when the relay answers pings", async () => {
      const c = makeClient({ pingIntervalMs: 30, pongTimeoutMs: 30 });
      c.start();
      await waitFor(() => c.online);
      const t0 = Date.now();
      await waitFor(() => c.online && Date.now() - t0 >= 30 * 3 + 60);
      expect(c.online).toBe(true);
    });

    it("terminates and reconnects when pongs stop arriving", async () => {
      const noPongRelay = new FakeRelay(fp, { autoPong: false });
      await noPongRelay.start();
      try {
        const c = new RelayClient({
          relayUrl: noPongRelay.url,
          fp,
          identity: id,
          name: "MBP",
          appVersion: "t",
          log,
          backoffMinMs: 30,
          backoffMaxMs: 60,
          pingIntervalMs: 30,
          pongTimeoutMs: 30,
        });
        clients.push(c);
        let downs = 0;
        c.on("down", () => downs++);
        c.start();
        await waitFor(() => c.online);
        await waitFor(() => downs === 1, 2000);
        await waitFor(() => c.online, 2000);
        expect(noPongRelay.agent).not.toBeNull();
      } finally {
        await noPongRelay.stop();
      }
    });
  });

  describe("e2e path (E)", () => {
    it("forwards e2e envelopes between the agent and a fake phone", async () => {
      const c = makeClient();
      c.start();
      await waitFor(() => c.online);

      const phone = await connectFakePhone(relay, fp);
      await waitFor(() => relay.phones.has(phone.fp));

      const toPhone: Envelope = {
        v: 1,
        t: "e2e",
        from: fp,
        to: phone.fp,
        seq: 1,
        body: { n: randomBytes(24), c: randomBytes(8) },
      };
      expect(c.sendEnvelope(toPhone)).toBe(true);
      await waitFor(() => phone.received.length === 1);
      expect(phone.received[0]?.body).toEqual(toPhone.body);

      const e2eEvents: Envelope[] = [];
      c.on("e2e", (env) => e2eEvents.push(env));
      const toAgent: Envelope = {
        v: 1,
        t: "e2e",
        from: phone.fp,
        to: fp,
        seq: 1,
        body: { n: randomBytes(24), c: randomBytes(8) },
      };
      phone.ws.send(encodeEnvelope(toAgent), { binary: true });
      await waitFor(() => e2eEvents.length === 1);
      expect(e2eEvents[0]?.body).toEqual(toAgent.body);

      phone.ws.terminate();
    });
  });

  describe("backoff jitter bound (G)", () => {
    it("never exceeds backoffMaxMs regardless of jitter", () => {
      const min = 1000;
      const max = 30_000;
      const randomSpy = vi.spyOn(Math, "random");
      try {
        for (let i = 0; i < 50; i++) {
          randomSpy.mockReturnValueOnce(i / 50);
          for (let attempt = 0; attempt < 8; attempt++) {
            const delay = computeBackoff(attempt, min, max);
            expect(delay).toBeLessThanOrEqual(max);
            expect(delay).toBeGreaterThanOrEqual(0);
          }
        }
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
});
