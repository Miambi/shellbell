import { buildRingNotification, type RingPayload, type SessionLabel } from "./content";

/**
 * Pure decision logic for replacing the relay's generic ring notification with one that names its
 * session (spec 2026-09-20 §4). No Expo or react-native import here on purpose, so this file can
 * be imported by node tests. The real, Expo-backed deps (and the background task that wires them
 * up) live in `./index.ts`, which node tests never import.
 */
export interface RingHandlerDeps {
  lookup: (fp: string, sessionId: string) => SessionLabel | undefined;
  present: (n: { identifier: string; title: string; body: string }) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
}

/**
 * Spec 2026-09-20 §4: the relay always sends a real notification so delivery is never at risk;
 * when this task gets to run we replace it with one that names the session. Keyed
 * `${fp}:${sessionId}`, so a session's next ring overwrites its previous notification instead of
 * stacking. If this never runs, the generic notification simply stands — no regression.
 */
export async function handleIncomingRing(
  payload: RingPayload,
  incomingIdentifier: string,
  deps: RingHandlerDeps,
): Promise<void> {
  if (!payload.computerFp || !payload.sessionId || !payload.kind) return;
  const n = buildRingNotification(payload, deps.lookup);
  await deps.present(n);
  await deps.dismiss(incomingIdentifier);
}
