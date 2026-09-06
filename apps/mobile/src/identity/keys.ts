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

const ID_KEY = "shellbell.identity.v1";
const pairKey = (fp: string) => `shellbell.pair.${fp}`;

export async function loadOrCreateIdentity(): Promise<{ identity: Identity; fp: string }> {
  const raw = await SecureStore.getItemAsync(ID_KEY);
  let identity: Identity;
  if (raw) {
    identity = identityFromJson(JSON.parse(raw));
  } else {
    identity = generateIdentity();
    await SecureStore.setItemAsync(ID_KEY, JSON.stringify(identityToJson(identity)));
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
  await SecureStore.setItemAsync(pairKey(computerFp), json);
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
