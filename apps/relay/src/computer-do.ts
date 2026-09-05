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
      if (err instanceof ProtocolError) {
        ws.close(4400, err.code);
      } else {
        console.error("do error", err instanceof Error ? err.name : "unknown");
        ws.close(1011, "internal error");
      }
    }
  }

  override async webSocketClose(ws: WebSocket, _code: number): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.buckets.delete(att.connId);
    try {
      if (att.state === "agent") {
        const otherAgent = this.socketsByState("agent").some(
          (s) => (s.deserializeAttachment() as Attachment).connId !== att.connId,
        );
        if (otherAgent) return;
        this.ctx.storage.sql.exec(
          "UPDATE computer SET last_seen = ? WHERE fp = ?",
          Date.now(),
          this.fp,
        );
        this.closeWindow();
        for (const p of this.socketsByState("phone")) {
          this.sendCtrl(p, {
            type: "presence",
            agentOnline: false,
            computerName: this.computerName(),
          });
        }
        await this.scheduleAlarm();
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
    } finally {
      // Client-initiated closes need the server side to close too, or the
      // closing handshake never completes and the client's own close event
      // never fires (observed on the pinned workerd runtime).
      try {
        ws.close();
      } catch {
        // already closed
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
    if (computer && !this.agentSocket()) {
      earliest = Math.min(earliest, computer.last_seen + GC_AFTER_MS);
    }
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
      this.setState(ws, { ...att, state: "agent", fp: msg.fp, name: msg.name });
      for (const old of this.socketsByState("agent")) {
        if (old !== ws) old.close(4005, "superseded");
      }
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
      this.setState(ws, { ...att, state: "phone", fp: msg.fp, name: msg.name });
      for (const old of this.phoneSockets(msg.fp)) {
        if (old !== ws) old.close(4005, "superseded");
      }
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

  private async onAgentCtrl(ws: WebSocket, msg: CtrlMessage): Promise<void> {
    const now = Date.now();
    switch (msg.type) {
      case "pairing-open":
        this.ctx.storage.sql.exec(
          `INSERT INTO pairing_window (id, gate_hash, expires_at, admitted) VALUES (1, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET gate_hash = excluded.gate_hash,
             expires_at = excluded.expires_at, admitted = 0`,
          blob(msg.gateHash),
          Math.min(msg.expiresAt, now + 10 * 60_000),
        );
        await this.scheduleAlarm();
        return;
      case "pairing-close":
        this.closeWindow();
        return;
      case "pairing-add": {
        const count =
          this.ctx.storage.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM pairings WHERE phone_fp != ?",
              msg.phoneFp,
            )
            .toArray()[0]?.n ?? 0;
        if (count >= MAX_PAIRINGS) {
          this.sendCtrl(ws, {
            type: "error",
            code: "too-many-pairings",
            message: `max ${MAX_PAIRINGS} phones`,
          });
          return;
        }
        this.upsertPairing(msg.phoneFp, msg.ed25519Pub, msg.name, now);
        return;
      }
      case "pairing-response": {
        const target = this.pairingSocket(msg.phoneFp);
        if (target) this.sendCtrl(target, msg);
        return;
      }
      case "pairing-reject": {
        const target = this.pairingSocket(msg.phoneFp);
        if (target) {
          this.sendCtrl(target, msg);
          target.close(4003, msg.reason);
        }
        return;
      }
      case "pairings-sync": {
        const keep = new Set(msg.phones.map((p) => p.phoneFp));
        const existing = this.ctx.storage.sql
          .exec<{ phone_fp: string }>("SELECT phone_fp FROM pairings")
          .toArray();
        for (const row of existing)
          if (!keep.has(row.phone_fp)) this.removePairing(row.phone_fp, false);
        for (const p of msg.phones) this.upsertPairing(p.phoneFp, p.ed25519Pub, p.name, now);
        this.ctx.storage.sql.exec("DELETE FROM pending_unpairs");
        return;
      }
      case "unpair":
        this.removePairing(msg.phoneFp, false);
        return;
      case "notify":
        await this.onNotify(msg);
        return;
      default:
        ws.close(4403, `agent may not send ${msg.type}`);
    }
  }

  private async onPhoneCtrl(ws: WebSocket, att: Attachment, msg: CtrlMessage): Promise<void> {
    switch (msg.type) {
      case "unpair": {
        if (msg.phoneFp !== att.fp) {
          ws.close(4403, "may only unpair self");
          return;
        }
        const agent = this.agentSocket();
        if (agent) this.sendCtrl(agent, msg);
        this.removePairing(msg.phoneFp, agent === null);
        return;
      }
      case "push-token":
        this.ctx.storage.sql.exec(
          "UPDATE pairings SET push_token = ?, push_platform = ?, push_enabled = ? WHERE phone_fp = ?",
          msg.token,
          msg.platform,
          msg.enabled ? 1 : 0,
          att.fp,
        );
        return;
      case "lease":
        this.setState(ws, { ...att, leaseUntil: Date.now() + msg.ttlMs });
        return;
      default:
        ws.close(4403, `phone may not send ${msg.type}`);
    }
  }

  private async onPairingCtrl(ws: WebSocket, att: Attachment, msg: CtrlMessage): Promise<void> {
    if (msg.type !== "pairing-request" || msg.phoneFp !== att.fp || att.used) {
      ws.close(4403, "one pairing-request only");
      return;
    }
    const agent = this.agentSocket();
    if (!agent) {
      this.sendCtrl(ws, { type: "pairing-reject", phoneFp: msg.phoneFp, reason: "no-agent" });
      ws.close(4003, "no-agent");
      return;
    }
    this.setState(ws, { ...att, used: true });
    this.sendCtrl(agent, msg);
  }

  private upsertPairing(phoneFp: string, pub: Uint8Array, name: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at, last_seen)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(phone_fp) DO UPDATE SET ed25519_pub = excluded.ed25519_pub, name = excluded.name`,
      phoneFp,
      blob(pub),
      name,
      now,
    );
  }

  /** Delete the row, close the phone's sockets; optionally leave a tombstone for the agent. */
  private removePairing(phoneFp: string, tombstone: boolean): void {
    this.ctx.storage.sql.exec("DELETE FROM pairings WHERE phone_fp = ?", phoneFp);
    this.ctx.storage.sql.exec("DELETE FROM push_limits WHERE phone_fp = ?", phoneFp);
    if (tombstone) {
      const n =
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_unpairs")
          .toArray()[0]?.n ?? 0;
      if (n < MAX_PAIRINGS) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO pending_unpairs (phone_fp, at) VALUES (?, ?)",
          phoneFp,
          Date.now(),
        );
      }
    }
    for (const s of this.phoneSockets(phoneFp)) s.close(4004, "unpaired");
  }

  private async onNotify(_msg: CtrlMessageOf<"notify">): Promise<void> {
    // Task 6
  }

  private onE2E(ws: WebSocket, att: Attachment, env: Envelope, raw: ArrayBuffer): void {
    if (att.state !== "agent" && att.state !== "phone") {
      ws.close(4403, "e2e requires auth");
      return;
    }
    if (env.from !== att.fp) {
      ws.close(4403, "from mismatch");
      return;
    }
    if (!env.to) {
      ws.close(4400, "e2e needs to");
      return;
    }
    const targets =
      att.state === "agent"
        ? this.phoneSockets(env.to)
        : env.to === this.fp
          ? [this.agentSocket()].filter((s): s is WebSocket => s !== null)
          : [];
    for (const t of targets) {
      try {
        t.send(raw);
      } catch {
        // closed between lookup and send
      }
    }
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
