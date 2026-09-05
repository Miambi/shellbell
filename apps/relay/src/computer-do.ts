import { DurableObject } from "cloudflare:workers";
import {
  bytesEqual,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fromBase64Url,
  MAX_PAIRINGS,
  ProtocolError,
  parseCtrl,
  randomBytes,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";
import { verifyAuthMessage } from "./auth.js";
import type { Env } from "./env.js";
import { frameLimitFor, peekIsCtrl, type SocketState, TokenBucket } from "./limits.js";
import { type ExpoMessage, pushBody, sendExpoPush } from "./push.js";
import { SCHEMA_SQL } from "./schema.js";

interface Attachment {
  state: SocketState;
  connId: string;
  nonce: string; // base64url
  since: number;
  fp: string | null;
  name: string | null;
  leaseUntil: number;
  used?: boolean; // pairing sockets: request already sent
}

type PairingRow = {
  phone_fp: string;
  ed25519_pub: ArrayBuffer;
  name: string;
  push_token: string | null;
  push_platform: string | null;
  push_enabled: number;
};

type WindowRow = {
  gate_hash: ArrayBuffer;
  expires_at: number;
  admitted: number;
};

const UNAUTH_TIMEOUT_MS = 10_000;
const PAIRING_TIMEOUT_MS = 90_000;
const WINDOW_MAX_ADMITTED = 5;
const GC_AFTER_MS = 90 * 24 * 3600 * 1000;
const RING_LIMIT_MS = 60_000;
const RING_ROWS_CAP = 200;
const PUSH_PER_HOUR = 20;

function blob(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export class ComputerDO extends DurableObject<Env> {
  private readonly fp: string;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fp = ctx.id.name ?? "";
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------- connection

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const nonce = randomBytes(32);
    const att: Attachment = {
      state: "unauth",
      connId: toBase64Url(randomBytes(16)),
      nonce: toBase64Url(nonce),
      since: Date.now(),
      fp: null,
      name: null,
      leaseUntil: 0,
    };
    server.serializeAttachment(att);
    this.sendCtrl(server, { type: "challenge", nonce, connId: att.connId });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return;
    const att = ws.deserializeAttachment() as Attachment;
    const bytes = new Uint8Array(message);
    const isCtrl = peekIsCtrl(bytes);
    if (bytes.byteLength > frameLimitFor(att.state, isCtrl)) {
      ws.close(4413, "too large");
      return;
    }
    let bucket = this.buckets.get(att.connId);
    if (!bucket) {
      bucket = new TokenBucket();
      this.buckets.set(att.connId, bucket);
    }
    if (!bucket.take(Date.now())) {
      ws.close(4429, "rate limited");
      return;
    }
    let env: Envelope;
    try {
      env = decodeEnvelope(bytes);
    } catch {
      ws.close(4400, "malformed");
      return;
    }
    try {
      if (env.t === "ctrl") await this.onCtrl(ws, att, env);
      else this.onE2E(ws, att, env, message);
    } catch (err) {
      if (err instanceof ProtocolError) ws.close(4400, err.code);
      else throw err;
    }
  }

  override async webSocketClose(ws: WebSocket, _code: number): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.buckets.delete(att.connId);
    if (att.state === "agent") {
      const otherAgent = this.socketsByState("agent").some(
        (s) => (s.deserializeAttachment() as Attachment).connId !== att.connId,
      );
      if (otherAgent) return;
      this.closeWindow();
      for (const p of this.socketsByState("phone")) {
        this.sendCtrl(p, {
          type: "presence",
          agentOnline: false,
          computerName: this.computerName(),
        });
      }
    } else if (att.state === "phone" && att.fp) {
      const agent = this.agentSocket();
      if (agent) {
        this.sendCtrl(agent, {
          type: "phone-disconnected",
          phoneFp: att.fp,
          connId: att.connId,
        });
      }
    }
  }

  override async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    await this.webSocketClose(ws, 1006);
  }

  // ---------------------------------------------------------------- alarm

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.state === "unauth" && now - att.since > UNAUTH_TIMEOUT_MS) {
        ws.close(4408, "auth timeout");
      } else if (att.state === "pairing" && now - att.since > PAIRING_TIMEOUT_MS) {
        ws.close(4408, "pairing timeout");
      }
    }
    const win = this.window();
    if (win && now >= win.expires_at) this.closeWindow();
    const computer = this.ctx.storage.sql
      .exec<{ last_seen: number }>("SELECT last_seen FROM computer WHERE fp = ?", this.fp)
      .toArray()[0];
    if (computer && now - computer.last_seen > GC_AFTER_MS && !this.agentSocket()) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, "computer expired");
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm();
  }

  /**
   * Earliest of: unauth/pairing socket deadlines, window expiry, GC deadline.
   * Always at most 5 s out when something is pending.
   */
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.state === "unauth") earliest = Math.min(earliest, att.since + UNAUTH_TIMEOUT_MS);
      if (att.state === "pairing") earliest = Math.min(earliest, att.since + PAIRING_TIMEOUT_MS);
    }
    const win = this.window();
    if (win) earliest = Math.min(earliest, win.expires_at);
    const computer = this.ctx.storage.sql
      .exec<{ last_seen: number }>("SELECT last_seen FROM computer WHERE fp = ?", this.fp)
      .toArray()[0];
    if (computer) earliest = Math.min(earliest, computer.last_seen + GC_AFTER_MS);
    if (earliest === Number.POSITIVE_INFINITY) return;
    await this.ctx.storage.setAlarm(Math.max(now + 1000, earliest));
  }

  // ---------------------------------------------------------------- ctrl dispatch

  private async onCtrl(ws: WebSocket, att: Attachment, env: Envelope): Promise<void> {
    const msg = parseCtrl(env.body);
    if (att.state === "unauth") {
      if (msg.type !== "auth") {
        ws.close(4403, "auth first");
        return;
      }
      await this.onAuth(ws, att, msg);
      return;
    }
    if (env.from !== att.fp) {
      ws.close(4403, "from mismatch");
      return;
    }
    switch (att.state) {
      case "agent":
        await this.onAgentCtrl(ws, msg);
        return;
      case "phone":
        await this.onPhoneCtrl(ws, att, msg);
        return;
      case "pairing":
        await this.onPairingCtrl(ws, att, msg);
        return;
    }
  }

  private async onAuth(ws: WebSocket, att: Attachment, msg: CtrlMessageOf<"auth">): Promise<void> {
    const fail = (reason: CtrlMessageOf<"auth-fail">["reason"]) => {
      this.sendCtrl(ws, { type: "auth-fail", reason });
      ws.close(4001, reason);
    };
    const v = verifyAuthMessage(msg, att.connId, fromBase64Url(att.nonce));
    if (v !== "ok") return fail(v);
    const now = Date.now();
    const minFrameMs = Number(this.env.MIN_FRAME_MS ?? "125") || 125;

    if (msg.role === "agent") {
      if (msg.fp !== this.fp) return fail("fp-mismatch");
      this.ctx.storage.sql.exec(
        `INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fp) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        this.fp,
        blob(msg.ed25519Pub),
        msg.name,
        now,
        now,
      );
      for (const old of this.socketsByState("agent")) old.close(4005, "superseded");
      this.setState(ws, { ...att, state: "agent", fp: msg.fp, name: msg.name });
      this.sendCtrl(ws, {
        type: "auth-ok",
        role: "agent",
        agentOnline: true,
        computerName: msg.name,
        serverTime: now,
        minFrameMs,
      });
      const tombstones = this.ctx.storage.sql
        .exec<{ phone_fp: string }>("SELECT phone_fp FROM pending_unpairs")
        .toArray()
        .map((r) => r.phone_fp);
      this.sendCtrl(ws, { type: "unpaired", phoneFps: tombstones });
      const connected = this.socketsByState("phone").map((p) => {
        const a = p.deserializeAttachment() as Attachment;
        return { phoneFp: a.fp as string, connId: a.connId, name: a.name ?? "" };
      });
      this.sendCtrl(ws, { type: "phones", connected });
      for (const p of this.socketsByState("phone")) {
        this.sendCtrl(p, { type: "presence", agentOnline: true, computerName: msg.name });
      }
      return;
    }

    if (msg.role === "phone") {
      const row = this.pairing(msg.fp);
      if (!row || !bytesEqual(new Uint8Array(row.ed25519_pub), msg.ed25519Pub)) {
        return fail("not-paired");
      }
      this.ctx.storage.sql.exec(
        "UPDATE pairings SET last_seen = ? WHERE phone_fp = ?",
        now,
        msg.fp,
      );
      for (const old of this.phoneSockets(msg.fp)) old.close(4005, "superseded");
      this.setState(ws, { ...att, state: "phone", fp: msg.fp, name: msg.name });
      const agent = this.agentSocket();
      this.sendCtrl(ws, {
        type: "auth-ok",
        role: "phone",
        agentOnline: agent !== null,
        computerName: this.computerName(),
        serverTime: now,
        minFrameMs,
      });
      if (agent) {
        this.sendCtrl(agent, {
          type: "phone-connected",
          phoneFp: msg.fp,
          connId: att.connId,
          name: msg.name,
        });
      }
      return;
    }

    // pairing
    if (!this.agentSocket()) return fail("no-agent");
    const win = this.window();
    if (!win || now >= win.expires_at || win.admitted >= WINDOW_MAX_ADMITTED || !msg.gate) {
      return fail("no-window");
    }
    if (!bytesEqual(new Uint8Array(win.gate_hash), sha256(msg.gate))) return fail("no-window");
    this.ctx.storage.sql.exec("UPDATE pairing_window SET admitted = admitted + 1 WHERE id = 1");
    this.setState(ws, { ...att, state: "pairing", fp: msg.fp, name: msg.name });
    this.sendCtrl(ws, {
      type: "auth-ok",
      role: "pairing",
      agentOnline: true,
      computerName: this.computerName(),
      serverTime: now,
      minFrameMs,
    });
  }

  private async onAgentCtrl(_ws: WebSocket, _msg: CtrlMessage): Promise<void> {
    // Task 4 (pairing window, sync, unpair) and Task 6 (notify)
  }

  private async onPhoneCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // Task 4 (unpair), Task 6 (push-token, lease)
  }

  private async onPairingCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // Task 4
  }

  private onE2E(ws: WebSocket, att: Attachment, _env: Envelope, _raw: ArrayBuffer): void {
    if (att.state === "unauth") {
      ws.close(4403, "auth first");
      return;
    }
    // Task 5
  }

  // ---------------------------------------------------------------- helpers

  protected sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    try {
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }));
    } catch {
      // socket already closed
    }
  }

  protected setState(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  protected socketsByState(state: SocketState): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.state === state);
  }

  protected agentSocket(): WebSocket | null {
    return this.socketsByState("agent")[0] ?? null;
  }

  protected phoneSockets(fp: string): WebSocket[] {
    return this.socketsByState("phone").filter(
      (ws) => (ws.deserializeAttachment() as Attachment).fp === fp,
    );
  }

  protected pairingSocket(fp: string): WebSocket | null {
    return (
      this.socketsByState("pairing").find(
        (ws) => (ws.deserializeAttachment() as Attachment).fp === fp,
      ) ?? null
    );
  }

  protected pairing(phoneFp: string): PairingRow | null {
    return (
      this.ctx.storage.sql
        .exec<PairingRow>("SELECT * FROM pairings WHERE phone_fp = ?", phoneFp)
        .toArray()[0] ?? null
    );
  }

  protected window(): WindowRow | null {
    return (
      this.ctx.storage.sql
        .exec<WindowRow>("SELECT gate_hash, expires_at, admitted FROM pairing_window WHERE id = 1")
        .toArray()[0] ?? null
    );
  }

  protected closeWindow(): void {
    this.ctx.storage.sql.exec("DELETE FROM pairing_window WHERE id = 1");
  }

  protected computerName(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ name: string | null }>("SELECT name FROM computer WHERE fp = ?", this.fp)
        .toArray()[0]?.name ?? null
    );
  }
}
