import { bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import {
  deriveConnKey,
  derivePairKey,
  derivePskKey,
  fingerprint,
  frameAd,
  identityFromSeeds,
  open,
  sealWithNonce,
  sign,
  verify,
} from "./crypto.js";

export interface Vectors {
  v: 1;
  computer: { edSeed: string; xSeed: string; fp: string };
  phone: { edSeed: string; xSeed: string; fp: string };
  code: string;
  kPsk: string;
  kPair: string;
  nPhone: string;
  nAgent: string;
  connTag: string;
  kConn: string;
  frame: { nonce: string; plaintext: string; seq: number; ciphertext: string };
  auth: { connId: string; nonce: string; role: string; sig: string };
}

export function runVectorChecks(vec: Vectors): { name: string; ok: boolean }[] {
  const out: { name: string; ok: boolean }[] = [];
  const check = (name: string, fn: () => boolean) => {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    out.push({ name, ok });
  };
  const c = identityFromSeeds(
    hexToBytes(vec.computer.edSeed),
    hexToBytes(vec.computer.xSeed),
    "2026-01-01T00:00:00Z",
  );
  const p = identityFromSeeds(
    hexToBytes(vec.phone.edSeed),
    hexToBytes(vec.phone.xSeed),
    "2026-01-01T00:00:00Z",
  );
  const code = hexToBytes(vec.code);
  check("fingerprint computer", () => fingerprint(c.ed25519.pub) === vec.computer.fp);
  check("fingerprint phone", () => fingerprint(p.ed25519.pub) === vec.phone.fp);
  check("kPsk", () => bytesToHex(derivePskKey(code, vec.computer.fp)) === vec.kPsk);
  const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, vec.computer.fp, vec.phone.fp);
  check("kPair computer side", () => bytesToHex(kPair) === vec.kPair);
  check(
    "kPair phone side",
    () =>
      bytesToHex(
        derivePairKey(p.x25519.priv, c.x25519.pub, code, vec.computer.fp, vec.phone.fp),
      ) === vec.kPair,
  );
  const conn = deriveConnKey(
    kPair,
    hexToBytes(vec.nPhone),
    hexToBytes(vec.nAgent),
    vec.computer.fp,
    vec.phone.fp,
  );
  check("connTag", () => conn.connTag === vec.connTag);
  check("kConn", () => bytesToHex(conn.kConn) === vec.kConn);
  const ad = frameAd(vec.phone.fp, vec.computer.fp, vec.connTag, vec.frame.seq);
  check(
    "frame seal",
    () =>
      bytesToHex(
        sealWithNonce(conn.kConn, hexToBytes(vec.frame.nonce), utf8(vec.frame.plaintext), ad).c,
      ) === vec.frame.ciphertext,
  );
  check(
    "frame open",
    () =>
      new TextDecoder().decode(
        open(
          conn.kConn,
          { n: hexToBytes(vec.frame.nonce), c: hexToBytes(vec.frame.ciphertext) },
          ad,
        ),
      ) === vec.frame.plaintext,
  );
  const authMsg = `shellbell-auth-v1|${vec.auth.connId}|${vec.auth.role}|${vec.phone.fp}|${vec.auth.nonce}`;
  check(
    "auth signature",
    () =>
      bytesToHex(sign(p.ed25519.priv, authMsg)) === vec.auth.sig &&
      verify(p.ed25519.pub, authMsg, hexToBytes(vec.auth.sig)),
  );
  return out;
}
