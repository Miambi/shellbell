import {
  type CtrlMessage,
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  open,
  pairingAd,
  parseQr,
  seal,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import type { Pairing } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { PairingManager } from "../src/pairing.js";

function setup(confirm: (fp: string, name: string) => Promise<boolean>) {
  const identity = generateIdentity();
  const fp = fingerprint(identity.ed25519.pub);
  const sent: CtrlMessage[] = [];
  const saved: Pairing[] = [];
  let t = 0;
  const pm = new PairingManager({
    identity,
    fp,
    computerName: "MBP",
    accent: "emerald",
    relayUrl: "wss://relay.test",
    sendCtrl: (m) => sent.push(m),
    savePairing: (p) => saved.push(p),
    confirm,
    log: createLogger({ stdout: false }),
    now: () => t,
  });
  return {
    pm,
    identity,
    fp,
    sent,
    saved,
    advance: (ms: number) => {
      t += ms;
      pm.tick();
    },
  };
}

function phoneRequest(qrText: string, phone = generateIdentity()) {
  const qr = parseQr(qrText);
  const code = fromBase64Url(qr.p);
  const phoneFp = fingerprint(phone.ed25519.pub);
  const kPsk = derivePskKey(code, qr.c);
  const box = seal(
    kPsk,
    encodeCbor({
      ed25519Pub: phone.ed25519.pub,
      x25519Pub: phone.x25519.pub,
      name: "iPhone",
      platform: "ios",
    }),
    pairingAd("request", qr.c, phoneFp),
  );
  return {
    phone,
    phoneFp,
    code,
    kPsk,
    qr,
    msg: { type: "pairing-request" as const, phoneFp, box },
  };
}

describe("PairingManager", () => {
  it("opens a window: QR carries relay, fp, pub, name, code, gate; relay gets gateHash", () => {
    const { pm, fp, identity, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const qr = parseQr(qrText);
    expect(qr.c).toBe(fp);
    expect(qr.e).toBe(toBase64Url(identity.ed25519.pub));
    expect(qr.r).toBe("wss://relay.test");
    const opened = sent[0];
    if (opened?.type !== "pairing-open") throw new Error();
    expect(opened.gateHash).toEqual(sha256(fromBase64Url(qr.g)));
    expect(pm.isOpen).toBe(true);
  });

  it("accepts a valid request after confirmation and derives the same K_pair as the phone", async () => {
    const confirmed: string[] = [];
    const { pm, identity, fp, sent, saved } = setup(async (pfp, name) => {
      confirmed.push(`${name}:${pfp.slice(0, 4)}`);
      return true;
    });
    const { qrText } = pm.openWindow();
    const req = phoneRequest(qrText);
    await pm.handleRequest(req.msg);
    expect(confirmed).toHaveLength(1);
    const types = sent.map((m) => m.type);
    expect(types).toEqual(["pairing-open", "pairing-add", "pairing-response", "pairing-close"]);
    const resp = sent[2];
    if (resp?.type !== "pairing-response") throw new Error();
    const inner = decodeCbor(open(req.kPsk, resp.box, pairingAd("response", fp, req.phoneFp))) as {
      x25519Pub: Uint8Array;
      computerName: string;
      accent: string;
    };
    expect(inner.computerName).toBe("MBP");
    const phoneK = derivePairKey(req.phone.x25519.priv, inner.x25519Pub, req.code, fp, req.phoneFp);
    expect(fromBase64Url(saved[0]?.kPair ?? "")).toEqual(phoneK);
    expect(saved[0]?.phoneFp).toBe(req.phoneFp);
    expect(pm.isOpen).toBe(false);
    void identity;
  });

  it("declined confirmation → pairing-reject declined, window stays open", async () => {
    const { pm, sent } = setup(async () => false);
    const { qrText } = pm.openWindow();
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "declined" });
    expect(pm.isOpen).toBe(true);
  });

  it("bad code → reject bad-code; three failures close the window", async () => {
    const { pm, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const good = parseQr(qrText);
    const badQr = JSON.stringify({ ...good, p: toBase64Url(new Uint8Array(16).fill(9)) });
    for (let i = 0; i < 3; i++) await pm.handleRequest(phoneRequest(badQr).msg);
    const rejects = sent.filter((m) => m.type === "pairing-reject");
    expect(rejects).toHaveLength(3);
    expect(rejects[0]).toMatchObject({ reason: "bad-code" });
    expect(pm.isOpen).toBe(false);
    expect(sent.at(-1)?.type).toBe("pairing-close");
  });

  it("expires after the window and rejects late requests with window-closed", async () => {
    const { pm, sent, advance } = setup(async () => true);
    const { qrText } = pm.openWindow();
    advance(300_001);
    expect(pm.isOpen).toBe(false);
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "window-closed" });
  });
});
