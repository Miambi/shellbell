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

/**
 * A "content"-shaped object as `expo-task-manager`'s background task actually delivers it.
 * Verified against the installed native source (not the SDK's own JS mapping, which never runs
 * on this path): `RemoteMessageSerializer.java` builds `{ data: { dataString, ...rawFcmFields },
 * notification, ... }` for a plain incoming push, and `NotificationSerializer.java` builds
 * `{ ..., content: { dataString, ... } }` for a background action-tap response — in both cases
 * `dataString` is the relay's `data` object (`{computerFp, sessionId, kind}`), JSON-encoded by
 * Expo's push service. `mapNotificationResponse.ts`'s `mapNotificationContent` performs this same
 * `dataString` → `JSON.parse` → `.data` mapping for the *other* paths (the emitter, the handler,
 * `getPresentedNotificationsAsync`) — confirming the shape — but is never wired into the
 * `expo-task-manager` background path, which is why reading `.data` alone (as opposed to
 * `.dataString`) leaves the background task permanently inert. `.data` is still checked, as a
 * fallback, in case a future SDK version (or a differently-shaped platform payload) maps it.
 */
export interface RawRingContent {
  data?: unknown;
  dataString?: unknown;
}

function isRingPayload(v: unknown): v is RingPayload {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.computerFp === "string" &&
    typeof r.sessionId === "string" &&
    typeof r.kind === "string"
  );
}

/**
 * Pure, fail-safe extraction: malformed JSON or a payload missing a required field yields
 * `undefined`, never a throw — a throw inside a background task is worse than the generic
 * notification standing (spec §4's designed fallback).
 */
export function extractRingPayload(
  content: RawRingContent | null | undefined,
): RingPayload | undefined {
  if (content === null || content === undefined) return undefined;
  if (typeof content.dataString === "string") {
    try {
      const parsed: unknown = JSON.parse(content.dataString);
      return isRingPayload(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRingPayload(content.data) ? content.data : undefined;
}
