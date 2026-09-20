# Notification identity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each ring name its session and replace that session's previous notification, instead
of stacking indistinguishable ones.

**Architecture:** The relay keeps sending an ordinary notification push, so delivery is never at
risk. A background notification task on the phone replaces it with an enriched one — session title
plus event kind — keyed `${fp}:${sessionId}` so each session owns exactly one. Session titles are
persisted locally because a backgrounded app has no in-memory store to read.

**Tech Stack:** Expo SDK 57, `expo-notifications`, `expo-task-manager` (new), `expo-sqlite/kv-store`,
zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-notification-grouping-design.md` — read it first,
including the §3 errata. This plan does not restate its reasoning.

## Global Constraints

- **No explicit Android grouping.** `expo-notifications` exposes no group key or group summary
  (§3 errata). Per-session replacement only. Do NOT add a config plugin or native module.
- Notification identifier is exactly **`${fp}:${sessionId}`**.
- Bodies must match the relay's existing wording in `apps/relay/src/push.ts` `pushBody()` so the
  enriched notification reads as a refinement, not a different message.
- Unknown title falls back to the **backend label** (`iTerm2` / `tmux` / `Herdr`), else `Session`.
  **Never render a raw session id.**
- Only session **titles** are persisted — never output, never commands (§5).
- No protocol change. No change to `apps/relay/`. No change to ring emission in `apps/agent/`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass, plus `check:vectors`, `doctor`,
  `brand:check`.
- tsconfig sets `noUncheckedIndexedAccess`; Biome enforces import order (`pnpm lint:fix`).

---

### Task 1: Pure notification content builder

**Files:**
- Create: `apps/mobile/src/notifications/content.ts`
- Test: `apps/mobile/test/notification-content.test.ts`

**Interfaces:**
- Produces: `buildRingNotification(payload, lookup)` returning
  `{ identifier: string; title: string; body: string }`. Tasks 4 and 5 consume it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/test/notification-content.test.ts
import { describe, expect, it } from "vitest";
import { buildRingNotification } from "../src/notifications/content";

const known = () => ({ title: "claude-code", backend: "herdr" as const });
const none = () => undefined;

describe("buildRingNotification", () => {
  it("names the session and keys the notification to it", () => {
    const n = buildRingNotification(
      { computerFp: "abc", sessionId: "s1", kind: "blocked" },
      known,
    );
    expect(n.identifier).toBe("abc:s1");
    expect(n.title).toBe("claude-code");
    expect(n.body).toBe("An agent is waiting for you");
  });

  it.each([
    ["prompt", "A command finished"],
    ["idle", "A session went quiet — waiting for you?"],
    ["blocked", "An agent is waiting for you"],
  ])("uses the relay's wording for %s", (kind, body) => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s1", kind }, known);
    expect(n.body).toBe(body);
  });

  it("falls back to the backend label when the title is unknown", () => {
    const n = buildRingNotification(
      { computerFp: "abc", sessionId: "s9", kind: "idle" },
      () => ({ title: "", backend: "tmux" as const }),
    );
    expect(n.title).toBe("tmux");
  });

  it("falls back to Session when nothing is known", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, none);
    expect(n.title).toBe("Session");
  });

  it("never renders a raw session id", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, none);
    expect(n.title).not.toContain("s9");
    expect(n.body).not.toContain("s9");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @shellbell/mobile exec vitest run test/notification-content.test.ts`
Expected: FAIL — cannot resolve `../src/notifications/content`.

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/notifications/content.ts
/**
 * Builds the enriched notification that replaces the relay's generic one (spec 2026-09-20 §2/§4).
 * Pure: the caller supplies the title lookup, so this is testable without storage or Expo.
 */
export interface RingPayload {
  computerFp: string;
  sessionId: string;
  kind: string;
}

export interface SessionLabel {
  title: string;
  backend: string;
}

export type TitleLookup = (fp: string, sessionId: string) => SessionLabel | undefined;

/** Mirrors `pushBody()` in apps/relay/src/push.ts so the replacement reads as a refinement. */
function bodyFor(kind: string): string {
  switch (kind) {
    case "prompt":
      return "A command finished";
    case "idle":
      return "A session went quiet — waiting for you?";
    case "blocked":
      return "An agent is waiting for you";
    default:
      return "A session needs attention";
  }
}

const BACKEND_LABEL: Record<string, string> = {
  iterm2: "iTerm2",
  tmux: "tmux",
  herdr: "Herdr",
};

/**
 * Spec §6: never render a raw session id — it is opaque and means nothing to a human. Fall back to
 * the backend label, then to a generic word.
 */
function titleFor(label: SessionLabel | undefined): string {
  if (label?.title) return label.title;
  const backend = label?.backend;
  if (backend && BACKEND_LABEL[backend]) return BACKEND_LABEL[backend] as string;
  return "Session";
}

export function buildRingNotification(
  payload: RingPayload,
  lookup: TitleLookup,
): { identifier: string; title: string; body: string } {
  return {
    identifier: `${payload.computerFp}:${payload.sessionId}`,
    title: titleFor(lookup(payload.computerFp, payload.sessionId)),
    body: bodyFor(payload.kind),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -F @shellbell/mobile exec vitest run test/notification-content.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/notifications/content.ts apps/mobile/test/notification-content.test.ts
git commit -m "feat(notifications): pure builder for the enriched ring notification"
```

---

### Task 2: Persisted session-title store

**Files:**
- Create: `apps/mobile/src/notifications/sessionTitles.ts`
- Test: `apps/mobile/test/session-titles.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `saveSessionTitles(fp, sessions, storage?)`, `lookupSessionTitle(fp, sessionId, storage?)`
  — the latter matches Task 1's `TitleLookup` shape when partially applied. Tasks 3 and 4 use both.

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/test/session-titles.test.ts
import { describe, expect, it } from "vitest";
import {
  type TitleStorage,
  lookupSessionTitle,
  saveSessionTitles,
} from "../src/notifications/sessionTitles";

function memory(): TitleStorage {
  const m = new Map<string, string>();
  return {
    getItemSync: (k) => m.get(k) ?? null,
    setItemSync: (k, v) => void m.set(k, v),
  };
}
const s = (id: string, title: string, backend = "tmux") => ({ id, title, backend });

describe("session title persistence", () => {
  it("round-trips a title so a backgrounded app can name the session", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "claude-code", "herdr")], st);
    expect(lookupSessionTitle("fp1", "s1", st)).toEqual({ title: "claude-code", backend: "herdr" });
  });

  it("returns undefined for an unseen session", () => {
    expect(lookupSessionTitle("fp1", "nope", memory())).toBeUndefined();
  });

  it("keeps computers separate", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one")], st);
    saveSessionTitles("fp2", [s("s1", "two")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("one");
    expect(lookupSessionTitle("fp2", "s1", st)?.title).toBe("two");
  });

  it("evicts sessions absent from the latest list", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one"), s("s2", "two")], st);
    saveSessionTitles("fp1", [s("s1", "one")], st);
    expect(lookupSessionTitle("fp1", "s2", st)).toBeUndefined();
  });

  it("survives corrupt stored JSON instead of throwing", () => {
    const st = memory();
    st.setItemSync("shellbell.sessionTitles", "{not json");
    expect(lookupSessionTitle("fp1", "s1", st)).toBeUndefined();
    saveSessionTitles("fp1", [s("s1", "ok")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @shellbell/mobile exec vitest run test/session-titles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/notifications/sessionTitles.ts
import Storage from "expo-sqlite/kv-store";
import type { SessionLabel } from "./content";

/**
 * Spec 2026-09-20 §5: a backgrounded app has no in-memory session list, so notifications cannot
 * name a session without this. ONLY titles are stored — never output, never commands. Extending
 * this store to anything else requires revisiting the privacy decision in PRIVACY.md.
 */
export interface TitleStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

const KEY = "shellbell.sessionTitles";

/** Injectable so tests need neither expo-sqlite nor a device. */
const defaultStorage: TitleStorage = {
  getItemSync: (k) => Storage.getItemSync(k),
  setItemSync: (k, v) => Storage.setItemSync(k, v),
};

type Book = Record<string, Record<string, SessionLabel>>;

function read(storage: TitleStorage): Book {
  const raw = storage.getItemSync(KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Book;
  } catch {
    // A corrupt value must not break rings. Start over rather than throw in a background task.
    return {};
  }
}

export interface SessionLike {
  id: string;
  title: string;
  backend: string;
}

/**
 * Replaces this computer's entry wholesale, so sessions that have gone away are evicted rather
 * than accumulating. The list is already bounded by the protocol (`max(500)`).
 */
export function saveSessionTitles(
  fp: string,
  sessions: readonly SessionLike[],
  storage: TitleStorage = defaultStorage,
): void {
  const book = read(storage);
  const next: Record<string, SessionLabel> = {};
  for (const s of sessions) next[s.id] = { title: s.title, backend: s.backend };
  book[fp] = next;
  storage.setItemSync(KEY, JSON.stringify(book));
}

export function lookupSessionTitle(
  fp: string,
  sessionId: string,
  storage: TitleStorage = defaultStorage,
): SessionLabel | undefined {
  return read(storage)[fp]?.[sessionId];
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -F @shellbell/mobile exec vitest run test/session-titles.test.ts`
Expected: PASS, 5 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/notifications/sessionTitles.ts apps/mobile/test/session-titles.test.ts
git commit -m "feat(notifications): persist session titles so a backgrounded app can name them"
```

---

### Task 3: Persist titles whenever the session list changes

**Files:**
- Modify: `apps/mobile/src/net/manager.ts:214`
- Test: `apps/mobile/test/session-titles-wiring.test.ts`

**Interfaces:**
- Consumes: `saveSessionTitles` from Task 2.

- [ ] **Step 1: Read the current site**

`apps/mobile/src/net/manager.ts` line 214 currently reads:

```ts
      case "sessions":
        store.patch(fp, () => ({ sessions: m.list }));
        return;
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/mobile/test/session-titles-wiring.test.ts
import { describe, expect, it } from "vitest";
import { onSessionsMessage } from "../src/net/manager";
import { type TitleStorage, lookupSessionTitle } from "../src/notifications/sessionTitles";

function memory(): TitleStorage {
  const m = new Map<string, string>();
  return { getItemSync: (k) => m.get(k) ?? null, setItemSync: (k, v) => void m.set(k, v) };
}

describe("sessions message persists titles (spec 2026-09-20 §5)", () => {
  it("writes every session's title for later notification lookup", () => {
    const st = memory();
    onSessionsMessage(
      "fp1",
      [
        { id: "s1", title: "claude-code", backend: "herdr" },
        { id: "s2", title: "build", backend: "tmux" },
      ],
      st,
    );
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("claude-code");
    expect(lookupSessionTitle("fp1", "s2", st)?.backend).toBe("tmux");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm -F @shellbell/mobile exec vitest run test/session-titles-wiring.test.ts`
Expected: FAIL — `onSessionsMessage` is not exported.

- [ ] **Step 4: Extract and wire**

Add to `apps/mobile/src/net/manager.ts` (exported so it is testable without a socket):

```ts
/**
 * Spec 2026-09-20 §5: titles must outlive the in-memory store, or a backgrounded app cannot name
 * the session a ring came from. Exported for tests; `storage` is injectable for the same reason.
 */
export function onSessionsMessage(
  fp: string,
  list: readonly SessionLike[],
  storage?: TitleStorage,
): void {
  saveSessionTitles(fp, list, storage);
}
```

with imports:

```ts
import {
  type SessionLike,
  type TitleStorage,
  saveSessionTitles,
} from "../notifications/sessionTitles";
```

and change the case at line 214 to:

```ts
      case "sessions":
        store.patch(fp, () => ({ sessions: m.list }));
        onSessionsMessage(fp, m.list);
        return;
```

- [ ] **Step 5: Run the test**

Run: `pnpm -F @shellbell/mobile exec vitest run test/session-titles-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/net/manager.ts apps/mobile/test/session-titles-wiring.test.ts
git commit -m "feat(notifications): save session titles when the list arrives"
```

---

### Task 4: Background task replaces the generic notification

**Files:**
- Modify: `apps/mobile/src/notifications/index.ts`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/package.json` (add `expo-task-manager`)
- Test: `apps/mobile/test/notification-replace.test.ts`

**Interfaces:**
- Consumes: `buildRingNotification` (Task 1), `lookupSessionTitle` (Task 2).
- Produces: `handleIncomingRing(payload, deps)` — pure-ish, dependency-injected, so the decision
  logic is testable without Expo.

- [ ] **Step 1: Add the dependency**

```bash
cd apps/mobile && npx expo install expo-task-manager
```

`expo-notifications`' `registerTaskAsync` requires it. This is a native dependency: a new build is
needed to test on device, and a full workspace reinstall will run. Expected.

- [ ] **Step 2: Write the failing test**

```ts
// apps/mobile/test/notification-replace.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleIncomingRing } from "../src/notifications/index";

function deps() {
  return {
    lookup: () => ({ title: "claude-code", backend: "herdr" }),
    present: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
  };
}

describe("handleIncomingRing (spec 2026-09-20 §4)", () => {
  it("presents an enriched notification keyed to the session", async () => {
    const d = deps();
    await handleIncomingRing(
      { computerFp: "abc", sessionId: "s1", kind: "blocked" },
      "incoming-id",
      d,
    );
    expect(d.present).toHaveBeenCalledWith({
      identifier: "abc:s1",
      title: "claude-code",
      body: "An agent is waiting for you",
    });
  });

  it("dismisses the relay's generic notification it replaced", async () => {
    const d = deps();
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "incoming-id", d);
    expect(d.dismiss).toHaveBeenCalledWith("incoming-id");
  });

  it("does nothing when the payload is not a ring", async () => {
    const d = deps();
    await handleIncomingRing({ computerFp: "", sessionId: "", kind: "" }, "incoming-id", d);
    expect(d.present).not.toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });

  it("still presents when the title is unknown, using the fallback", async () => {
    const d = { ...deps(), lookup: () => undefined };
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "i", d);
    expect(d.present).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Session", identifier: "abc:s1" }),
    );
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm -F @shellbell/mobile exec vitest run test/notification-replace.test.ts`
Expected: FAIL — `handleIncomingRing` is not exported.

- [ ] **Step 4: Implement the decision logic**

Add to `apps/mobile/src/notifications/index.ts`:

```ts
import { buildRingNotification, type RingPayload, type SessionLabel } from "./content";
import { lookupSessionTitle } from "./sessionTitles";

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

export const defaultRingHandlerDeps: RingHandlerDeps = {
  lookup: (fp, sessionId) => lookupSessionTitle(fp, sessionId),
  present: async (n) => {
    await ExpoNotifications.scheduleNotificationAsync({
      identifier: n.identifier,
      content: { title: n.title, body: n.body, sound: "default" },
      trigger: null,
    });
  },
  dismiss: async (id) => {
    await ExpoNotifications.dismissNotificationAsync(id);
  },
};
```

- [ ] **Step 5: Register the background task**

Also in `apps/mobile/src/notifications/index.ts`:

```ts
import * as TaskManager from "expo-task-manager";

export const RING_TASK = "shellbell-ring";

/** Defined at module scope: the OS may start the task before any React tree exists. */
TaskManager.defineTask(RING_TASK, async ({ data, error }) => {
  if (error) return;
  const n = (data as { notification?: { request?: { identifier?: string; content?: { data?: unknown } } } })
    ?.notification?.request;
  const payload = n?.content?.data as RingPayload | undefined;
  if (!payload) return;
  await handleIncomingRing(payload, n?.identifier ?? "", defaultRingHandlerDeps);
});

export async function registerRingTask(): Promise<void> {
  await ExpoNotifications.registerTaskAsync(RING_TASK);
}
```

and call `registerRingTask()` from the existing notification effect in `apps/mobile/app/_layout.tsx`,
beside the current handler installation. Failures must be swallowed — an unregistered task means
generic notifications, not a crash.

- [ ] **Step 6: Run the test and the suite**

```bash
pnpm -F @shellbell/mobile exec vitest run test/notification-replace.test.ts
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/notifications/index.ts apps/mobile/app/_layout.tsx apps/mobile/package.json pnpm-lock.yaml apps/mobile/test/notification-replace.test.ts
git commit -m "feat(notifications): replace the generic ring with one that names its session"
```

---

### Task 5: Dismiss on open, and the privacy record

**Files:**
- Modify: `apps/mobile/app/c/[fp]/s/[sid].tsx`
- Modify: `PRIVACY.md`
- Test: `apps/mobile/test/notification-dismiss.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/test/notification-dismiss.test.ts
import { describe, expect, it } from "vitest";
import { notificationIdFor } from "../src/notifications/content";

describe("notificationIdFor", () => {
  it("matches the identifier the ring handler presents under", () => {
    expect(notificationIdFor("abc", "s1")).toBe("abc:s1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @shellbell/mobile exec vitest run test/notification-dismiss.test.ts`
Expected: FAIL — `notificationIdFor` is not exported.

- [ ] **Step 3: Extract the identifier helper**

In `apps/mobile/src/notifications/content.ts`, add and use it inside `buildRingNotification` so the
two can never drift:

```ts
/** One definition of the identifier, shared by the presenter and the dismisser. */
export function notificationIdFor(fp: string, sessionId: string): string {
  return `${fp}:${sessionId}`;
}
```

- [ ] **Step 4: Dismiss when the session is opened**

In `apps/mobile/app/c/[fp]/s/[sid].tsx`, in the existing mount effect, call
`dismissNotificationAsync(notificationIdFor(fp, sid))`, wrapped so a failure cannot break the
screen. Spec §6: if you are looking at it, it is not waiting for you.

- [ ] **Step 5: Update PRIVACY.md**

Under "What the relay stores", add a short subsection — **What your phone stores** — recording
plainly that session *titles* are kept on the phone so notifications can name the session, that
they are never sent anywhere, that the relay still never sees them, and that output and commands
are **not** stored. Do not bury it; the point is that the document should not need a charitable
reading.

- [ ] **Step 6: Full verification**

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm -F @shellbell/mobile check:vectors && pnpm -F @shellbell/mobile doctor
pnpm -F @shellbell/mobile brand:check
```

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/notifications/content.ts "apps/mobile/app/c/[fp]/s/[sid].tsx" PRIVACY.md apps/mobile/test/notification-dismiss.test.ts
git commit -m "feat(notifications): dismiss on open, and record what the phone stores"
```

---

## Notes

**What cannot be tested without a device:** whether Android actually runs the background task
before the user sees the generic notification, and whether One UI auto-bundles the per-session
notifications acceptably (§3 errata — that observation is the trigger for deciding about native
grouping). Both need a build and real use. Do not claim either works from a green test run.

**Out of scope:** the `idleQuietMs` tuning (spec §7), iOS (§8), native grouping (§3 errata),
multi-line input.
