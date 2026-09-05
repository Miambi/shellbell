import { existsSync, readFileSync } from "node:fs";
import {
  fingerprint,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
} from "@shellbell/protocol";
import { ensureDir, type Paths, writeSecretFile } from "./config.js";

export function loadOrCreateIdentity(p: Paths): { identity: Identity; fp: string } {
  ensureDir(p);
  let identity: Identity;
  if (existsSync(p.identity)) {
    identity = identityFromJson(JSON.parse(readFileSync(p.identity, "utf8")));
  } else {
    identity = generateIdentity();
    writeSecretFile(p.identity, `${JSON.stringify(identityToJson(identity), null, 2)}\n`);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}
