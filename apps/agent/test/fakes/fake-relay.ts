import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authMessage,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  parseCtrl,
  randomBytes,
  toBase64Url,
  verify,
} from "@shellbell/protocol";
import { type WebSocket, WebSocketServer } from "ws";

interface Peer {
  ws: WebSocket;
  fp: string;
  role: "agent" | "phone" | "pairing";
  connId: string;
}

export interface FakeRelayOptions {
  /** Forwarded to `WebSocketServer` — set false to simulate a peer that never answers pings. */
  autoPong?: boolean;
}

/** Minimal in-process relay double: one computer, any number of phones. */
export class FakeRelay {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = "";
  agent: Peer | null = null;
  phones = new Map<string, Peer>();
  pairing = new Map<string, Peer>();
  received: { from: Peer; env: Envelope }[] = [];
  ctrlFromAgent: CtrlMessage[] = [];
  /** Total sockets ever accepted, including ones that never completed auth. */
  connections = 0;
  connectionTimes: number[] = [];
  /** One-shot fault injection: next agent auth attempt gets this auth-fail reason instead of the real check. */
  nextAuthFailReason: CtrlMessageOf<"auth-fail">["reason"] | null = null;
  /** While set, every newly accepted connection is closed immediately with this code, before any challenge. */
  rejectCode: number | null = null;
  rejectReason = "";
  private waiters: ((m: CtrlMessage) => void)[] = [];
  private ctrlBuffer: CtrlMessage[] = [];

  constructor(
    private readonly computerFp: string,
    private readonly opts: FakeRelayOptions = {},
  ) {}

  async start(): Promise<void> {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server, autoPong: this.opts.autoPong });
    this.wss.on("connection", (ws, req) => {
      this.connections++;
      this.connectionTimes.push(Date.now());
      if (this.rejectCode !== null) {
        ws.close(this.rejectCode, this.rejectReason);
        return;
      }
      const fpInUrl = (req.url ?? "").split("/").pop();
      if (fpInUrl !== this.computerFp) {
        ws.close(4001, "unknown computer");
        return;
      }
      const nonce = randomBytes(32);
      const connId = toBase64Url(randomBytes(16));
      let peer: Peer | null = null;
      this.sendCtrl(ws, { type: "challenge", nonce, connId });
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeEnvelope(new Uint8Array(data as Buffer));
        if (!peer) {
          const msg = parseCtrl(env.body);
          if (msg.type !== "auth") return ws.close(4403);
          if (msg.role === "agent" && this.nextAuthFailReason) {
            const reason = this.nextAuthFailReason;
            this.nextAuthFailReason = null;
            this.sendCtrl(ws, { type: "auth-fail", reason });
            return ws.close(4001);
          }
          const ok =
            fingerprint(msg.ed25519Pub) === msg.fp &&
            verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig);
          if (!ok) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "bad-sig" });
            return ws.close(4001);
          }
          if (msg.role === "agent" && msg.fp !== this.computerFp) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "fp-mismatch" });
            return ws.close(4001);
          }
          peer = { ws, fp: msg.fp, role: msg.role, connId };
          const okMsg: CtrlMessage = {
            type: "auth-ok",
            role: msg.role,
            agentOnline: this.agent !== null || msg.role === "agent",
            computerName: "FakeMac",
            serverTime: Date.now(),
            minFrameMs: 125,
          };
          if (msg.role === "agent") {
            this.agent?.ws.close(4005, "superseded");
            this.agent = peer;
            this.sendCtrl(ws, okMsg);
            this.sendCtrl(ws, { type: "unpaired", phoneFps: [] });
            this.sendCtrl(ws, {
              type: "phones",
              connected: [...this.phones.values()].map((p) => ({
                phoneFp: p.fp,
                connId: p.connId,
                name: "phone",
              })),
            });
          } else if (msg.role === "phone") {
            this.phones.get(msg.fp)?.ws.close(4005);
            this.phones.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
            if (this.agent)
              this.sendCtrl(this.agent.ws, {
                type: "phone-connected",
                phoneFp: msg.fp,
                connId,
                name: msg.name,
              });
          } else {
            this.pairing.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
          }
          return;
        }
        if (env.t === "ctrl") {
          const msg = parseCtrl(env.body);
          if (peer.role === "agent") {
            this.ctrlFromAgent.push(msg);
            const waiter = this.waiters.shift();
            if (waiter) waiter(msg);
            else this.ctrlBuffer.push(msg);
            if (msg.type === "pairing-response" || msg.type === "pairing-reject") {
              const target = this.pairing.get(msg.phoneFp);
              if (target) this.sendCtrl(target.ws, msg);
            }
          } else if (peer.role === "pairing" && msg.type === "pairing-request" && this.agent) {
            this.sendCtrl(this.agent.ws, msg);
          }
          return;
        }
        this.received.push({ from: peer, env });
        const target = peer.role === "agent" ? this.phones.get(env.to ?? "")?.ws : this.agent?.ws;
        if (target) target.send(data as Buffer, { binary: true });
      });
      ws.on("close", () => {
        if (!peer) return;
        if (peer.role === "agent" && this.agent === peer) this.agent = null;
        if (peer.role === "phone" && this.phones.get(peer.fp) === peer) {
          this.phones.delete(peer.fp);
          if (this.agent)
            this.sendCtrl(this.agent.ws, {
              type: "phone-disconnected",
              phoneFp: peer.fp,
              connId: peer.connId,
            });
        }
        if (peer.role === "pairing") this.pairing.delete(peer.fp);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }), { binary: true });
  }

  sendToAgent(body: CtrlMessage): void {
    if (this.agent) this.sendCtrl(this.agent.ws, body);
  }

  /** Force-close the current agent socket with an arbitrary close code (e.g. 4413/4429). */
  closeAgent(code: number, reason = ""): void {
    this.agent?.ws.close(code, reason);
  }

  nextCtrlFromAgent(timeoutMs = 2000): Promise<CtrlMessage> {
    const buffered = this.ctrlBuffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for agent ctrl")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  dropAgent(): void {
    this.agent?.ws.terminate();
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => this.wss?.close(() => r()));
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
