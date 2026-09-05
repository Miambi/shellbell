import { existsSync } from "node:fs";
import {
  fingerprint,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
} from "@shellbell/protocol";
import { ensureDir, type Paths, readJsonFile, writeSecretFile } from "./config.js";

export function loadOrCreateIdentity(p: Paths): { identity: Identity; fp: string } {
  ensureDir(p);
  let identity: Identity;
  if (existsSync(p.identity)) {
    try {
      identity = identityFromJson(readJsonFile(p.identity));
    } catch (err) {
      throw new Error(`shellbell: invalid identity at ${p.identity}: ${(err as Error).message}`);
    }
  } else {
    identity = generateIdentity();
    writeSecretFile(p.identity, `${JSON.stringify(identityToJson(identity), null, 2)}\n`);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}
