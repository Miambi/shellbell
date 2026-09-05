import { EventEmitter } from "node:events";
import {
  authMessage,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  type Identity,
  parseCtrl,
  relayWsUrl,
  sign,
} from "@shellbell/protocol";
import WebSocket from "ws";
import type { Logger } from "./log.js";

export interface RelayClientOptions {
  relayUrl: string;
  fp: string;
  identity: Identity;
  name: string;
  appVersion: string;
  log: Logger;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface RelayClientEvents {
  "auth-ok": [CtrlMessageOf<"auth-ok">];
  "auth-fail": [CtrlMessageOf<"auth-fail">["reason"]];
  ctrl: [CtrlMessage];
  e2e: [Envelope];
  down: [];
}

export class RelayClient extends EventEmitter<RelayClientEvents> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private authed = false;
  private readonly log: Logger;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this.log = opts.log.child({ unit: "relay" });
  }

  get online(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "stop");
    this.ws = null;
    this.authed = false;
  }

  sendCtrl(body: CtrlMessage): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.opts.fp, seq: 0, body });
  }

  sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeEnvelope(env), { binary: true });
  }

  private connect(): void {
    if (this.stopped) return;
    const url = relayWsUrl(this.opts.relayUrl, this.opts.fp);
    this.log.info("connecting", { attempt: this.attempt });
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => this.log.debug("socket open"));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      let env: Envelope;
      try {
        env = decodeEnvelope(new Uint8Array(data as Buffer));
      } catch (err) {
        this.log.warn("malformed frame from relay", { err: String(err) });
        return;
      }
      if (env.t === "e2e") {
        if (this.authed) this.emit("e2e", env);
        return;
      }
      let msg: CtrlMessage;
      try {
        msg = parseCtrl(env.body);
      } catch (err) {
        this.log.warn("malformed ctrl from relay", { err: String(err) });
        return;
      }
      this.onCtrl(msg);
    });
    ws.on("pong", () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    ws.on("close", (code, reason) => {
      this.log.info("socket closed", { code, reason: reason.toString() });
      this.onDown();
    });
    ws.on("error", (err) => {
      this.log.warn("socket error", { err: err.message });
    });
  }

  private onCtrl(msg: CtrlMessage): void {
    if (msg.type === "challenge") {
      const sig = sign(
        this.opts.identity.ed25519.priv,
        authMessage(msg.connId, "agent", this.opts.fp, msg.nonce),
      );
      this.sendCtrl({
        type: "auth",
        role: "agent",
        fp: this.opts.fp,
        ed25519Pub: this.opts.identity.ed25519.pub,
        sig,
        name: this.opts.name,
        appVersion: this.opts.appVersion,
      });
      return;
    }
    if (msg.type === "auth-ok") {
      this.authed = true;
      this.attempt = 0;
      this.startPing();
      this.log.info("authenticated", { minFrameMs: msg.minFrameMs });
      this.emit("auth-ok", msg);
      return;
    }
    if (msg.type === "auth-fail") {
      this.log.error("auth failed", { reason: msg.reason });
      this.emit("auth-fail", msg.reason);
      if (msg.reason === "fp-mismatch") this.stopped = true;
      return;
    }
    this.emit("ctrl", msg);
  }

  private onDown(): void {
    const wasAuthed = this.authed;
    this.authed = false;
    this.clearTimers();
    this.ws = null;
    if (wasAuthed) this.emit("down");
    if (this.stopped) return;
    const min = this.opts.backoffMinMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.reconnectTimer = setTimeout(() => this.connect(), Math.max(0, base + jitter));
  }

  private startPing(): void {
    const interval = this.opts.pingIntervalMs ?? 45_000;
    const timeout = this.opts.pongTimeoutMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.log.warn("pong timeout; reconnecting");
        this.ws?.terminate();
      }, timeout);
    }, interval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.pingTimer = this.pongTimer = null;
  }
}
