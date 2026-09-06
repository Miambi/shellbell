import {
  authMessage,
  type CtrlMessageLoose,
  decodeCbor,
  decodeEnvelope,
  deriveConnKey,
  E2EBodySchema,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  frameAd,
  helloAd,
  type Identity,
  type InnerMessageLoose,
  type InnerMessageLooseOf,
  open,
  parseCtrlLoose,
  parseInnerLoose,
  randomBytes,
  relayWsUrl,
  seal,
  sign,
  toBase64Url,
} from "@shellbell/protocol";
import type { ErrorKind, Status } from "../store/connections";

export class DeliveryUnknownError extends Error {
  constructor() {
    super("delivery unknown: the connection closed before an ack arrived");
    this.name = "DeliveryUnknownError";
  }
}

type WsLike = {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface StatusExtra {
  agentOnline?: boolean;
  error?: ErrorKind;
  closeCode?: number;
  /** reqIds that were in flight when the connection went down (spec 12 toast) */
  lostReqIds?: string[];
}

export interface PushTokenInfo {
  token: string;
  platform: "ios" | "android";
  enabled: boolean;
}

export interface ConnectionOptions {
  computerFp: string;
  relayUrl: string;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  kPair: Uint8Array;
  pushToken?: () => Promise<PushTokenInfo | null>;
  onCtrl?: (m: CtrlMessageLoose) => void;
  onInner: (m: InnerMessageLoose) => void;
  onStatus: (s: Status, extra?: StatusExtra) => void;
  WebSocketImpl?: new (url: string) => WsLike;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
}

const LEASE_MS = 60_000;
const KEEPALIVE_MS = 30_000;
const MAX_DECRYPT_FAILURES = 20;

/** Mirrors apps/agent/src/relay-client.ts: these mean the config will never work. */
const PERMANENT_AUTH_FAIL: Record<string, ErrorKind | undefined> = {
  "bad-sig": "rejected",
  "fp-mismatch": "rejected",
  "not-paired": "unpaired",
};

/** Close codes that must never be retried. */
const PERMANENT_CLOSE: Record<number, ErrorKind> = {
  4004: "unpaired",
  4005: "superseded",
  4400: "relay",
  4403: "relay",
};

/** Transient, but reconnecting fast is what caused them: keep the backoff where it is. */
const KEEP_BACKOFF_CLOSE = new Set([4413, 4429]);

export class ComputerConnection {
  status: Status = "idle";
  private ws: WsLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private agentOnline = false;
  private nPhone: Uint8Array | null = null;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seqOut = 0;
  private seqIn = 0;
  private failures = 0;
  private minFrameMs = 125;
  private readonly pending = new Map<
    string,
    { resolve: (a: InnerMessageLooseOf<"ack">) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly o: ConnectionOptions) {}

  get online(): boolean {
    return this.status === "online";
  }

  /** The relay's advertised minimum frame interval; surfaced for Plan 06 perf work. */
  get frameIntervalMs(): number {
    return this.minFrameMs;
  }

  newReqId(): string {
    return toBase64Url(randomBytes(8));
  }

  pendingReqIds(): string[] {
    return [...this.pending.keys()];
  }

  connect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  close(reason: "background" | "user" = "user"): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws && this.ws.readyState === 1) {
      // Spec 10.4/11.3: the relay must treat this phone as push-eligible immediately.
      if (reason === "background") this.sendCtrl({ type: "lease", ttlMs: 0 });
      this.ws.close(1000, reason);
    }
    this.ws = null;
    this.failPending();
    this.resetSession();
    this.setStatus("idle");
  }

  subscribe(sessionId: string | null): boolean {
    return this.send({ type: "subscribe", sessionId });
  }

  send(msg: InnerMessageLoose): boolean {
    if (!this.kConn || this.status !== "online" || !this.ws) return false;
    this.seqOut += 1;
    const ad = frameAd(this.o.phoneFp, this.o.computerFp, this.connTag, this.seqOut);
    const box = seal(this.kConn, encodeCbor(msg), ad);
    this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: this.seqOut,
      body: box,
    });
    return true;
  }

  request(msg: InnerMessageLoose & { reqId: string }): Promise<InnerMessageLooseOf<"ack">> {
    return new Promise((resolve, reject) => {
      if (!this.send(msg)) return reject(new DeliveryUnknownError());
      this.pending.set(msg.reqId, { resolve, reject });
    });
  }

  // ---- internals ----

  private setStatus(s: Status, extra?: StatusExtra): void {
    this.status = s;
    this.o.onStatus(s, extra);
  }

  private stopWith(error: ErrorKind, closeCode?: number): void {
    this.stopped = true;
    this.clearTimers();
    this.setStatus("error", { error, closeCode, lostReqIds: this.pendingReqIds() });
    this.failPending();
  }

  private open(): void {
    if (this.stopped) return;
    const Ws =
      this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const ws = new Ws(relayWsUrl(this.o.relayUrl, this.o.computerFp));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => this.setStatus("auth");
    ws.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === "string") return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      let env: Envelope;
      try {
        env = decodeEnvelope(bytes);
      } catch {
        return;
      }
      if (env.t === "ctrl") {
        let m: CtrlMessageLoose;
        try {
          m = parseCtrlLoose(env.body);
        } catch {
          return;
        }
        this.onCtrl(m);
      } else {
        this.onE2E(env);
      }
    };
    ws.onclose = (ev) => this.onDown(ev.code);
    ws.onerror = () => {
      /* onclose always follows */
    };
  }

  private sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState === 1) this.ws.send(encodeEnvelope(env));
  }

  private sendCtrl(body: CtrlMessageLoose): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.o.phoneFp, seq: 0, body } as Envelope);
  }

  private onCtrl(m: CtrlMessageLoose): void {
    this.o.onCtrl?.(m);
    switch (m.type) {
      case "challenge": {
        const msg = authMessage(m.connId, "phone", this.o.phoneFp, m.nonce);
        this.sendCtrl({
          type: "auth",
          role: "phone",
          fp: this.o.phoneFp,
          ed25519Pub: this.o.identity.ed25519.pub,
          sig: sign(this.o.identity.ed25519.priv, msg),
          name: this.o.phoneName,
          appVersion: this.o.appVersion,
        });
        return;
      }
      case "auth-ok": {
        this.attempt = 0;
        this.agentOnline = m.agentOnline;
        this.minFrameMs = m.minFrameMs;
        this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        void this.o.pushToken?.().then((t) => {
          if (!t) return;
          this.sendCtrl({
            type: "push-token",
            token: t.token,
            platform: t.platform,
            enabled: t.enabled,
          });
        });
        this.keepalive = setInterval(() => {
          this.ws?.send("ping");
          this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        }, KEEPALIVE_MS);
        if (m.agentOnline) this.startHandshake();
        else this.setStatus("offline", { agentOnline: false });
        return;
      }
      case "auth-fail": {
        const permanent = PERMANENT_AUTH_FAIL[m.reason];
        if (permanent) {
          this.stopWith(permanent);
          this.ws?.close(1000, m.reason);
        } else {
          this.setStatus("offline", { agentOnline: false });
        }
        return;
      }
      case "presence": {
        this.agentOnline = m.agentOnline;
        if (m.agentOnline && !this.kConn) {
          this.startHandshake();
          return;
        }
        if (!m.agentOnline) {
          const lost = this.pendingReqIds();
          this.resetSession();
          this.failPending();
          this.setStatus("offline", { agentOnline: false, lostReqIds: lost });
        }
        return;
      }
      default:
        return;
    }
  }

  private startHandshake(): void {
    this.resetSession();
    this.setStatus("handshake");
    this.nPhone = randomBytes(16);
    const box = seal(
      this.o.kPair,
      encodeCbor({ type: "conn.hello", n: this.nPhone }),
      helloAd(this.o.phoneFp, this.o.computerFp),
    );
    this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: 0,
      body: box,
    });
    this.helloTimer = setTimeout(() => {
      if (!this.kConn) this.ws?.close(4000, "hello timeout");
    }, this.o.helloTimeoutMs ?? 10_000);
  }

  private onE2E(env: Envelope): void {
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return;
    if (env.seq === 0) {
      if (!this.nPhone) return;
      try {
        const ad = helloAd(this.o.computerFp, this.o.phoneFp);
        const inner = parseInnerLoose(decodeCbor(open(this.o.kPair, body.data, ad)));
        if (inner.type !== "conn.hello") return;
        const d = deriveConnKey(
          this.o.kPair,
          this.nPhone,
          inner.n,
          this.o.computerFp,
          this.o.phoneFp,
        );
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        this.failures = 0;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.setStatus("online", { agentOnline: true });
      } catch {
        this.stopWith("re-pair");
        this.ws?.close(1000, "kpair mismatch");
      }
      return;
    }
    if (!this.kConn || env.seq <= this.seqIn) return;
    let inner: InnerMessageLoose;
    try {
      const ad = frameAd(this.o.computerFp, this.o.phoneFp, this.connTag, env.seq);
      inner = parseInnerLoose(decodeCbor(open(this.kConn, body.data, ad)));
    } catch {
      this.failures += 1;
      if (this.failures >= MAX_DECRYPT_FAILURES) this.ws?.close(4000, "decrypt failures");
      return;
    }
    this.failures = 0;
    this.seqIn = env.seq;
    if (inner.type === "ack") {
      const p = this.pending.get(inner.reqId);
      if (p) {
        this.pending.delete(inner.reqId);
        p.resolve(inner);
      }
    }
    this.o.onInner(inner);
  }

  private onDown(code: number): void {
    this.clearTimers();
    this.ws = null;
    const lost = this.pendingReqIds();
    this.resetSession();
    const permanent = PERMANENT_CLOSE[code];
    if (permanent) {
      this.stopped = true;
      this.setStatus("error", { error: permanent, closeCode: code, lostReqIds: lost });
      this.failPending();
      return;
    }
    this.failPending();
    if (this.stopped) return;
    this.setStatus("offline", { closeCode: code, lostReqIds: lost });
    const min = this.o.backoffMinMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    // 4413/4429 mean we were too loud: advance the attempt counter but never reset it elsewhere.
    if (!KEEP_BACKOFF_CLOSE.has(code) || this.attempt === 0) {
      this.attempt = Math.min(this.attempt + 1, 10);
    }
    const wait = KEEP_BACKOFF_CLOSE.has(code) ? max : base + base * 0.2 * (Math.random() * 2 - 1);
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private resetSession(): void {
    this.kConn = null;
    this.nPhone = null;
    this.connTag = "";
    this.seqOut = 0;
    this.seqIn = 0;
    this.failures = 0;
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new DeliveryUnknownError());
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.reconnectTimer = null;
    this.keepalive = null;
    this.helloTimer = null;
  }
}
