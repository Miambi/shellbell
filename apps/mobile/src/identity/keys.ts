import {
  fingerprint,
  fromBase64Url,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
  toBase64Url,
} from "@shellbell/protocol";
import * as SecureStore from "expo-secure-store";
import { migrateKeychainOnce } from "./keychainMigration";

const ID_KEY = "shellbell.identity.v1";
const pairKey = (fp: string) => `shellbell.pair.${fp}`;

// Review C1: without this, `WHEN_UNLOCKED` (the SecureStore default) lets both the identity seed
// and every K_pair leave the device in an encrypted backup and land on a restored/second device,
// contrary to spec 6.2/13. Reads intentionally pass no options -- the accessibility attribute
// only gates storage/backup behaviour, not query matching, so an item written under the old
// default is still found.
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Loads (or creates) the phone's Ed25519 identity. `pairedFps`, when the caller already knows the
 * paired-computer list (the root layout does, right after hydrating the computers store), lets
 * the one-time keychain migration (review C1) also cover every `K_pair` on this same pass; callers
 * without that context (settings, pairing) still cover the identity key itself, and the migration
 * is a no-op everywhere after the first successful run (gated by a marker, see
 * `keychainMigration.ts`).
 */
export async function loadOrCreateIdentity(
  pairedFps: readonly string[] = [],
): Promise<{ identity: Identity; fp: string }> {
  await migrateKeychainOnce(
    SecureStore,
    [ID_KEY, ...pairedFps.map(pairKey)],
    SECURE_OPTS as Record<string, unknown>,
  );
  const raw = await SecureStore.getItemAsync(ID_KEY);
  let identity: Identity;
  if (raw) {
    identity = identityFromJson(JSON.parse(raw));
  } else {
    identity = generateIdentity();
    await SecureStore.setItemAsync(ID_KEY, JSON.stringify(identityToJson(identity)), SECURE_OPTS);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}

export interface PairSecret {
  kPair: Uint8Array;
  computerEd25519Pub: Uint8Array;
  computerX25519Pub: Uint8Array;
}

export async function savePairSecret(computerFp: string, s: PairSecret): Promise<void> {
  const json = JSON.stringify({
    kPair: toBase64Url(s.kPair),
    e: toBase64Url(s.computerEd25519Pub),
    x: toBase64Url(s.computerX25519Pub),
  });
  await SecureStore.setItemAsync(pairKey(computerFp), json, SECURE_OPTS);
}

export async function loadPairSecret(computerFp: string): Promise<PairSecret | null> {
  const raw = await SecureStore.getItemAsync(pairKey(computerFp));
  if (!raw) return null;
  const j = JSON.parse(raw) as { kPair: string; e: string; x: string };
  return {
    kPair: fromBase64Url(j.kPair),
    computerEd25519Pub: fromBase64Url(j.e),
    computerX25519Pub: fromBase64Url(j.x),
  };
}

export async function deletePairSecret(computerFp: string): Promise<void> {
  await SecureStore.deleteItemAsync(pairKey(computerFp));
}
