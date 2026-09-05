import {
  type CtrlMessage,
  type CtrlMessageOf,
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeQr,
  fingerprint,
  type Identity,
  MAX_PAIRINGS,
  open,
  pairingAd,
  parseQr,
  randomBytes,
  seal,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";
import { z } from "zod";
import type { Pairing } from "./config.js";
import type { Logger } from "./log.js";

export interface PairingManagerOptions {
  identity: Identity;
  fp: string;
  computerName: string;
  accent: string;
  relayUrl: string;
  sendCtrl: (m: CtrlMessage) => void;
  savePairing: (p: Pairing) => void;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  /** Number of pairings already persisted for this computer; checked against MAX_PAIRINGS. */
  pairingCount: () => number;
  log: Logger;
  now?: () => number;
  windowMs?: number;
  /** How long to wait for a human to answer the confirmation prompt. Default 60 s. */
  confirmTimeoutMs?: number;
}

const Key32 = z
  .instanceof(Uint8Array)
  .refine((b) => b.length === 32, { message: "expected 32 bytes" });

const RequestBody = z.object({
  ed25519Pub: Key32,
  x25519Pub: Key32,
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
});

interface Window {
  code: Uint8Array;
  gate: Uint8Array;
  expiresAt: number;
  failures: number;
}

export class PairingManager {
  private window: Window | null = null;
  /** Set to the phoneFp of the request currently awaiting human confirmation, if any. */
  private pendingFp: string | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: PairingManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "pairing" });
  }

  get isOpen(): boolean {
    return this.window !== null && this.now() < this.window.expiresAt;
  }

  openWindow(): { qrText: string; expiresAt: number } {
    if (this.window) this.closeWindow();
    const code = randomBytes(16);
    const gate = randomBytes(16);
    const expiresAt = this.now() + (this.opts.windowMs ?? 300_000);
    const qrText = encodeQr({
      v: 1,
      r: this.opts.relayUrl,
      c: this.opts.fp,
      e: toBase64Url(this.opts.identity.ed25519.pub),
      n: this.opts.computerName.slice(0, 40),
      p: toBase64Url(code),
      g: toBase64Url(gate),
    });
    // Round-trip validation: throws if relayUrl/computerName/etc. don't satisfy the QR
    // schema (wss:// scheme, no trailing slash, non-empty name, ...), before anything is
    // sent or any state is mutated.
    parseQr(qrText);
    this.window = { code, gate, expiresAt, failures: 0 };
    this.opts.sendCtrl({ type: "pairing-open", gateHash: sha256(gate), expiresAt });
    this.log.info("pairing window opened");
    return { qrText, expiresAt };
  }

  closeWindow(): void {
    if (!this.window) return;
    this.window.code.fill(0);
    this.window.gate.fill(0);
    this.window = null;
    this.opts.sendCtrl({ type: "pairing-close" });
    this.log.info("pairing window closed");
  }

  /** Call once per second. */
  tick(): void {
    if (this.window && this.now() >= this.window.expiresAt) this.closeWindow();
  }

  private confirmWithTimeout(phoneFp: string, name: string): Promise<boolean> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 60_000;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.warn("confirmation timed out", { phone: phoneFp.slice(0, 8) });
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.opts.confirm(phoneFp, name).then(
        (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  async handleRequest(msg: CtrlMessageOf<"pairing-request">): Promise<void> {
    const reject = (reason: CtrlMessageOf<"pairing-reject">["reason"]) => {
      this.opts.sendCtrl({ type: "pairing-reject", phoneFp: msg.phoneFp, reason });
      this.log.warn("pairing rejected", { reason, phone: msg.phoneFp.slice(0, 8) });
    };
    if (!this.isOpen || !this.window) return reject("window-closed");
    if (this.opts.pairingCount() >= MAX_PAIRINGS) return reject("too-many");
    if (this.pendingFp !== null) return reject("too-many");
    const win = this.window;
    const kPsk = derivePskKey(win.code, this.opts.fp);
    let body: z.infer<typeof RequestBody>;
    try {
      body = RequestBody.parse(
        decodeCbor(open(kPsk, msg.box, pairingAd("request", this.opts.fp, msg.phoneFp))),
      );
      if (fingerprint(body.ed25519Pub) !== msg.phoneFp) throw new Error("fp mismatch");
    } catch {
      win.failures += 1;
      reject("bad-code");
      if (win.failures >= 3) this.closeWindow();
      return;
    }

    this.pendingFp = msg.phoneFp;
    try {
      const ok = await this.confirmWithTimeout(msg.phoneFp, body.name);
      if (!ok) return reject("declined");
      // The window may have been closed and re-opened while the human was deciding.
      if (!this.isOpen || this.window !== win) return reject("window-closed");

      let kPair: Uint8Array;
      try {
        kPair = derivePairKey(
          this.opts.identity.x25519.priv,
          body.x25519Pub,
          win.code,
          this.opts.fp,
          msg.phoneFp,
        );
      } catch {
        win.failures += 1;
        reject("bad-code");
        if (win.failures >= 3) this.closeWindow();
        return;
      }

      this.opts.savePairing({
        phoneFp: msg.phoneFp,
        name: body.name,
        platform: body.platform,
        ed25519Pub: toBase64Url(body.ed25519Pub),
        x25519Pub: toBase64Url(body.x25519Pub),
        kPair: toBase64Url(kPair),
        pairedAt: new Date(this.now()).toISOString(),
        lastSeenAt: null,
      });
      this.opts.sendCtrl({
        type: "pairing-add",
        phoneFp: msg.phoneFp,
        ed25519Pub: body.ed25519Pub,
        name: body.name,
      });
      const response = seal(
        kPsk,
        encodeCbor({
          x25519Pub: this.opts.identity.x25519.pub,
          computerName: this.opts.computerName,
          accent: this.opts.accent,
        }),
        pairingAd("response", this.opts.fp, msg.phoneFp),
      );
      this.opts.sendCtrl({ type: "pairing-response", phoneFp: msg.phoneFp, box: response });
      this.log.info("paired", { phone: msg.phoneFp.slice(0, 8) });
      this.closeWindow();
    } finally {
      this.pendingFp = null;
    }
  }
}
