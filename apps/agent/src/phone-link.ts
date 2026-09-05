import {
  decodeCbor,
  deriveConnKey,
  E2EBodySchema,
  type Envelope,
  encodeCbor,
  frameAd,
  helloAd,
  type InnerMessage,
  type InnerMessageOf,
  open,
  parseInner,
  randomBytes,
  seal,
} from "@shellbell/protocol";
import type { Logger } from "./log.js";

export interface PhoneLinkOptions {
  phoneFp: string;
  connId: string;
  name: string;
  kPair: Uint8Array;
  computerFp: string;
  send: (env: Envelope) => void;
  log: Logger;
  now?: () => number;
}

const MAX_FAILURES = 20;
const ACK_CACHE = 256;
const HELLO_TIMEOUT_MS = 10_000;

export class PhoneLink {
  readonly phoneFp: string;
  readonly connId: string;
  readonly name: string;
  readonly openedAt: number;
  handshaken = false;
  broken = false;
  /** Set by the agent when no conn.hello arrived within 10 s; cleared by a late conn.hello. */
  dormant = false;
  viewed: string | null = null;
  onBroken?: () => void;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seqOut = 0;
  private seqIn = 0;
  private failures = 0;
  private readonly acks = new Map<string, InnerMessageOf<"ack">>();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: PhoneLinkOptions) {
    this.phoneFp = opts.phoneFp;
    this.connId = opts.connId;
    this.name = opts.name;
    this.now = opts.now ?? (() => Date.now());
    this.openedAt = this.now();
    this.log = opts.log.child({ phone: opts.phoneFp.slice(0, 8), conn: opts.connId.slice(0, 6) });
  }

  /** True once the 10 s conn.hello window (spec 6.6) has passed with no handshake. */
  helloOverdue(now: number = this.now()): boolean {
    return !this.handshaken && !this.dormant && now - this.openedAt >= HELLO_TIMEOUT_MS;
  }

  handleEnvelope(env: Envelope): InnerMessage | null {
    if (this.broken) return null;
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return this.fail("bad body");
    // conn.hello is always accepted under K_pair with seq 0 (re-handshake resets the connection)
    if (env.seq === 0) {
      try {
        const inner = parseInner(
          decodeCbor(open(this.opts.kPair, body.data, helloAd(this.phoneFp, this.opts.computerFp))),
        );
        if (inner.type !== "conn.hello") return this.fail("expected conn.hello");
        const nAgent = randomBytes(16);
        const d = deriveConnKey(
          this.opts.kPair,
          inner.n,
          nAgent,
          this.opts.computerFp,
          this.phoneFp,
        );
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        this.handshaken = true;
        this.dormant = false;
        this.failures = 0;
        this.acks.clear();
        const reply = seal(
          this.opts.kPair,
          encodeCbor({ type: "conn.hello", n: nAgent }),
          helloAd(this.opts.computerFp, this.phoneFp),
        );
        this.opts.send({
          v: 1,
          t: "e2e",
          from: this.opts.computerFp,
          to: this.phoneFp,
          seq: 0,
          body: reply,
        });
        this.log.info("handshake complete");
        return null;
      } catch {
        return this.fail("hello decrypt failed");
      }
    }
    if (!this.kConn) return this.fail("frame before handshake");
    if (env.seq <= this.seqIn) {
      this.log.warn("replayed or reordered frame dropped", { seq: env.seq, last: this.seqIn });
      return null;
    }
    let inner: InnerMessage;
    try {
      inner = parseInner(
        decodeCbor(
          open(
            this.kConn,
            body.data,
            frameAd(this.phoneFp, this.opts.computerFp, this.connTag, env.seq),
          ),
        ),
      );
    } catch {
      return this.fail("frame decrypt failed");
    }
    this.seqIn = env.seq;
    this.failures = 0;
    if ("reqId" in inner) {
      const cached = this.acks.get(inner.reqId);
      if (cached) {
        this.send(cached);
        return null;
      }
    }
    return inner;
  }

  send(msg: InnerMessage): boolean {
    if (!this.kConn || this.broken) return false;
    this.seqOut += 1;
    const box = seal(
      this.kConn,
      encodeCbor(msg),
      frameAd(this.opts.computerFp, this.phoneFp, this.connTag, this.seqOut),
    );
    this.opts.send({
      v: 1,
      t: "e2e",
      from: this.opts.computerFp,
      to: this.phoneFp,
      seq: this.seqOut,
      body: box,
    });
    return true;
  }

  rememberAck(reqId: string, ack: InnerMessageOf<"ack">): void {
    this.acks.set(reqId, ack);
    if (this.acks.size > ACK_CACHE) {
      const first = this.acks.keys().next().value;
      if (first !== undefined) this.acks.delete(first);
    }
  }

  private fail(reason: string): null {
    this.failures += 1;
    this.log.warn(reason, { failures: this.failures });
    if (this.failures >= MAX_FAILURES && !this.broken) {
      this.broken = true;
      this.onBroken?.();
    }
    return null;
  }
}
