import { SELF } from "cloudflare:test";
import {
  authMessage,
  type CtrlMessage,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  type Identity,
  parseCtrl,
  type Role,
  sha256,
  sign,
} from "@shellbell/protocol";

export class TestDevice {
  readonly id: Identity;
  readonly fp: string;
  constructor(readonly name: string) {
    this.id = generateIdentity();
    this.fp = fingerprint(this.id.ed25519.pub);
  }
}

export interface Conn {
  ws: WebSocket;
  next(timeoutMs?: number): Promise<Envelope>;
  nextCtrl(timeoutMs?: number): Promise<CtrlMessage>;
  sendCtrl(from: string, body: unknown): void;
  sendEnvelope(e: Envelope): void;
  sendRaw(bytes: Uint8Array): void;
  closed: Promise<{ code: number }>;
}

export async function connect(computerFp: string): Promise<Conn> {
  const res = await SELF.fetch(`https://relay.test/ws/${computerFp}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  ws.binaryType = "arraybuffer";
  const queue: Envelope[] = [];
  const waiters: ((e: Envelope) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    const env = decodeEnvelope(new Uint8Array(ev.data as ArrayBuffer));
    const w = waiters.shift();
    if (w) w(env);
    else queue.push(env);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.addEventListener("close", (ev) => resolve({ code: ev.code }));
  });
  const next = (timeoutMs = 2000) =>
    new Promise<Envelope>((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      waiters.push((e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
  return {
    ws,
    next,
    nextCtrl: async (t) => parseCtrl((await next(t)).body),
    sendCtrl: (from, body) => ws.send(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })),
    sendEnvelope: (e) => ws.send(encodeEnvelope(e)),
    sendRaw: (bytes) => ws.send(bytes),
    closed,
  };
}

/** Answers the challenge; returns auth-ok or auth-fail. */
export async function authenticate(
  conn: Conn,
  dev: TestDevice,
  role: Role,
  opts: { gate?: Uint8Array } = {},
): Promise<CtrlMessage> {
  const ch = await conn.nextCtrl();
  if (ch.type !== "challenge") throw new Error(`expected challenge, got ${ch.type}`);
  const sig = sign(dev.id.ed25519.priv, authMessage(ch.connId, role, dev.fp, ch.nonce));
  conn.sendCtrl(dev.fp, {
    type: "auth",
    role,
    fp: dev.fp,
    ed25519Pub: dev.id.ed25519.pub,
    sig,
    name: dev.name,
    appVersion: "test",
    gate: opts.gate,
  });
  return conn.nextCtrl();
}

/**
 * Connect + auth an agent; drains auth-ok, unpaired, phones.
 * Returns the conn and the drained messages.
 */
export async function agentOnline(
  mac: TestDevice,
): Promise<{ agent: Conn; unpaired: CtrlMessage; phones: CtrlMessage }> {
  const agent = await connect(mac.fp);
  const ok = await authenticate(agent, mac, "agent");
  if (ok.type !== "auth-ok") throw new Error(`agent auth failed: ${JSON.stringify(ok)}`);
  const unpaired = await agent.nextCtrl();
  const phones = await agent.nextCtrl();
  return { agent, unpaired, phones };
}

export const box = () => ({ n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) });

/** Relay-side pairing dance with a gate; leaves the pairing row in place. */
export async function pairPhone(mac: TestDevice, agent: Conn, phone: TestDevice): Promise<void> {
  const gate = new Uint8Array(16).fill(7);
  agent.sendCtrl(mac.fp, {
    type: "pairing-open",
    gateHash: sha256(gate),
    expiresAt: Date.now() + 300_000,
  });
  const pairing = await connect(mac.fp);
  const ok = await authenticate(pairing, phone, "pairing", { gate });
  if (ok.type !== "auth-ok") throw new Error(`pairing auth failed: ${JSON.stringify(ok)}`);
  pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
  const fwd = await agent.nextCtrl();
  if (fwd.type !== "pairing-request") throw new Error(`expected pairing-request, got ${fwd.type}`);
  agent.sendCtrl(mac.fp, {
    type: "pairing-add",
    phoneFp: phone.fp,
    ed25519Pub: phone.id.ed25519.pub,
    name: phone.name,
  });
  agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: box() });
  agent.sendCtrl(mac.fp, { type: "pairing-close" });
  const resp = await pairing.nextCtrl();
  if (resp.type !== "pairing-response")
    throw new Error(`expected pairing-response, got ${resp.type}`);
  pairing.ws.close();
}
