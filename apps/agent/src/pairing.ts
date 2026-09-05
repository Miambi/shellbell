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
  open,
  pairingAd,
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
  log: Logger;
  now?: () => number;
  windowMs?: number;
}

const RequestBody = z.object({
  ed25519Pub: z.instanceof(Uint8Array),
  x25519Pub: z.instanceof(Uint8Array),
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
    const code = randomBytes(16);
    const gate = randomBytes(16);
    const expiresAt = this.now() + (this.opts.windowMs ?? 300_000);
    this.window = { code, gate, expiresAt, failures: 0 };
    this.opts.sendCtrl({ type: "pairing-open", gateHash: sha256(gate), expiresAt });
    const qrText = encodeQr({
      v: 1,
      r: this.opts.relayUrl,
      c: this.opts.fp,
      e: toBase64Url(this.opts.identity.ed25519.pub),
      n: this.opts.computerName.slice(0, 40),
      p: toBase64Url(code),
      g: toBase64Url(gate),
    });
    this.log.info("pairing window opened");
    return { qrText, expiresAt };
  }

  closeWindow(): void {
    if (!this.window) return;
    this.window = null;
    this.opts.sendCtrl({ type: "pairing-close" });
    this.log.info("pairing window closed");
  }

  /** Call once per second. */
  tick(): void {
    if (this.window && this.now() >= this.window.expiresAt) this.closeWindow();
  }

  async handleRequest(msg: CtrlMessageOf<"pairing-request">): Promise<void> {
    const reject = (reason: CtrlMessageOf<"pairing-reject">["reason"]) => {
      this.opts.sendCtrl({ type: "pairing-reject", phoneFp: msg.phoneFp, reason });
      this.log.warn("pairing rejected", { reason, phone: msg.phoneFp.slice(0, 8) });
    };
    if (!this.isOpen || !this.window) return reject("window-closed");
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
    const ok = await this.opts.confirm(msg.phoneFp, body.name);
    if (!ok) return reject("declined");
    if (!this.isOpen) return reject("window-closed");

    const kPair = derivePairKey(
      this.opts.identity.x25519.priv,
      body.x25519Pub,
      win.code,
      this.opts.fp,
      msg.phoneFp,
    );
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
  }
}
