# Shellbell Plan 06 — Rings, hosted infrastructure, polish, release

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> **Tasks 1–8 are `[AGENT]` and must run unattended. Tasks 9–13 are `[HUMAN]`: Bilal runs them.
> An agent must never run, simulate, or report the outcome of a `[HUMAN]` step.**

**Goal:** Push notifications ring the phone when a command finishes, a program goes quiet, or a
coding agent is blocked; tapping one lands on the right session. The hosted relay runs at
`relay.shellbell.dev`, the agent is on npm as `shellbell`, the app ships to TestFlight and Google
Play internal testing, and the docs let a stranger set it up.

**Architecture:** No new components. This plan finishes `expo-notifications` in the app (permission
→ token → `push-token` ctrl; tap/deep link → validated route; foreground toast), splits the relay's
hosted config away from the self-hosted one, fixes the agent's publishing plumbing so
`npx shellbell` actually installs, adds release automation, and hands Bilal a set of clearly
bounded manual tasks for everything that needs an account, a device, or a console.

**Tech Stack:** expo-notifications 57.x, expo-haptics, expo-linking, EAS Build/Submit, Cloudflare
Workers + Wrangler 4.129, Changesets 3.0.1, pnpm 11.12.0, npm.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — §8.8, §9.2/9.3/9.4, §10.8,
§10.9, §11, §16, §17 (M5, M6). Plans 01–05 and 04b are merged; this branch starts from
main @ `890e51c`.

---

## Pre-execution corrections (2026-09-06)

A read-only pre-flight scan against main @ `890e51c` found 94 rows (full report:
`.superpowers/sdd/2026-09-03-shellbell-06-rings-release/preflight-scan.md`). This plan has been
rewritten under ruling **R62**. One line per change, tagged with the scan's row ids.

**Work that was already shipped and is now deleted from this plan**

- **[S1]** `ComputerConnection.unpairSelf()` already exists (`connection.ts:196`) and
  `app/c/[fp]/settings.tsx:36-37` already calls it plus `close("user")`. Removed from Task 1.
- **[S2]** The proposed `resendPushToken()` already exists as `ComputerConnection.sendPushToken()`
  + `Manager.notifyPushToggle()`, already wired to the Notifications switch. Task 1 now *uses*
  them instead of re-adding them.
- **[S3]** `push-token` is already sent on every `auth-ok` (`connection.ts:301-312`). Task 1's only
  wiring change is replacing the `pushToken: async () => null` stub at `_layout.tsx:49`.
- **[S5]** The agent's `Ring.kind` already includes `"blocked"` and `Notifier` already sends ctrl
  `notify`. No agent-side ring work in this plan.
- **[S6]** The relay already ships the `blocked` push body and `DeviceNotRegistered` handling
  (`push.ts:29-49,73-80`), with tests. No relay push work in this plan.
- **[S13]** `DEFAULT_RELAY` is already `wss://relay.shellbell.dev`. Confirm-only.

**Defects fixed in the plan text**

- **[C1]** `import type { Router } from "expo-router"` does not exist in expo-router 57. Task 1 now
  uses the `router` singleton (typed `ImperativeRouter` where an annotation is needed) and keeps
  expo-router out of the notifications module entirely.
- **[C5]** `manager.ts` must not import the notifications module — `test/manager.test.ts` would
  pull `expo-notifications` into a node vitest env and break. Task 1 inverts the dependency: the
  manager gains an injected `onForegroundEvent` callback and stays native-free. Nothing runs at
  module scope; `installNotificationHandler()` is called from `_layout.tsx`.
- **[S7, C3, V1]** The foreground copy now has a `blocked` branch (04b shipped `blocked` events);
  previously a blocked agent rendered "session ended".
- **[C4]** `getPushToken` now treats the shipped placeholder `REPLACE_AFTER_eas_init` as absent.
- **[C7, P2]** Permission is requested after the first pairing and the token is registered
  immediately via `notifyPushToggle(fp, true)`, instead of leaving the race for Task 4 to debug.
- **[C8]** The deep-link retry loop is bounded *and* cancellable.
- **[C10]** A root-level `ToastHost` replaces the session-screen-only Toast, so a foreground event
  raised while on the computers or sessions list is visible instead of popping later.
- **[C6, V11]** Task 1 ships `apps/mobile/test/notifications.test.ts` covering `computerFp`
  validation, deep-link parsing, the kind→copy mapping (incl. `blocked`), and the token→ctrl call.
- **[S10, C20, T9, T10]** `@shellbell/protocol` becomes `private: true` and moves to the agent's
  `devDependencies` (tsdown already bundles it); publishing is `pnpm publish --no-git-checks` with
  a `prepublishOnly` gate. As written before, the published tarball declared a `workspace:*`
  dependency on an unpublished package and `npx shellbell` could not install.
- **[S8, C22, C23]** The Changesets config versions only `shellbell`; no `ignore` list (both other
  packages are already `private: true`), and the protocol package is private and unversioned.
- **[C24]** The release job moves to `ubuntu-latest`. **[C25]** it gains
  `permissions: { contents: write, pull-requests: write, id-token: write }`.
- **[S11, V15]** New `apps/relay/wrangler.hosted.jsonc` carries the custom-domain `routes`;
  `apps/relay/wrangler.jsonc` stays untouched so a self-hoster can still `wrangler deploy` from a
  clone. `deploy-relay.yml` passes `--config wrangler.hosted.jsonc`.
- **[S17]** `eas.json` gains `autoIncrement` and a `submit` section with explicit placeholders.
- **[S18, V4]** EAS Update is **deferred to v1.1**: `expo-updates` is not installed and no
  `channel`/`runtimeVersion` is configured, so the old "Step 4: `eas update`" was unrunnable.
- **[S19]** `app.json` now references the icon, splash and Android adaptive-icon assets that have
  been sitting unused in `apps/mobile/assets/` since Plan 05.
- **[C27]** Store subtitle shortened to ≤ 30 characters (was 32; the App Store limit is 30).
  **[C28]** the `ssh` keyword is dropped — Shellbell has no SSH feature (§1.2).
- **[C17]** `z.toJSONSchema` is called with `{ unrepresentable: "any" }`; the protocol schemas embed
  byte types that otherwise throw.
- **[S15]** Herdr is added to the README / CONTRIBUTING / PRIVACY content lists (the plan predated
  04b). **[S16]** `PRIVACY.md` becomes the source of truth and `docs/self-hosting.md` links to it.
- **[V3]** The Android channel uses `AndroidImportance.HIGH`, matching spec §10.8 verbatim (was
  `MAX`).
- **[C15]** A `blocked` scenario is added to both the automated (Task 2) and device (Task 11) ring
  tests.
- **[C12]** `google-services.json` stays gitignored and is uploaded as an EAS **file** env var —
  otherwise the Android build fails.
- **[C13]** Task 10 gets the missing `cd apps/relay` and a note about the `miambi` wrangler profile.
- **[C31]** Every task ends with a commit step.
- **[C29]** `CHANGELOG.md` paths are named explicitly (root for the app, `apps/agent/` for the
  agent, written by Changesets).
- **[S21]** `@shellbell/mobile`'s stale `version: "1.0.0"` is set to `0.1.0` to match `app.json`.
- **[P9]** Task 11 updates `apps/mobile/QA.md`'s dangling "verify with a ring in Plan 06" line.
- **[R4, C14, C18, C19, C30]** "Placeholders: none" was false. Task 8 ships a **Before first
  release** checklist enumerating every placeholder token in the repo, and Tasks 11/13 ship
  *templates* with blanks that only Bilal fills in.
- **[R1, R2]** TDD applies to Tasks 1–8 only; it is explicitly waived for `[HUMAN]` tasks so a
  worker neither stalls nor invents tests for `eas build`.
- **[V8]** Spec §16's CI list should be amended to name `release-agent.yml` (spec edit, noted in
  the ledger — this plan does not edit the spec).
- **[S12]** `wrangler.jsonc`'s `compatibility_date` (`2026-08-22`) is deliberately left alone;
  spec §9.3's `2026-09-01` is the stale side.
- **[V13]** URL deep links are not a spec requirement but the Plan 05 review recorded them as a
  carry-over, so Task 1 covers `shellbell://c/<fp>[/s/<sid>]` with validation and tests.
- **[T1–T13]** Pins verified: `@changesets/cli@3.0.1` exists (latest 3.0.2), `eas-cli` 23.2.0
  satisfies `eas.json`'s `>= 16.0.0`, `expo-notifications` 57.0.17 is installed and its handler /
  token API matches the code below exactly, and `dist/cli.js` already carries the
  `#!/usr/bin/env node` banner.

**Not applied**

- Adding `expo-updates` (EAS Update) — deferred to v1.1 per ruling 2.
- Editing the spec — outside this plan's one-file authorization. The spec errata (§9.3
  `compatibility_date`, §16 `release-agent.yml`, Appendix C `expo-notifications ~57.0.16`) are
  recorded in the ledger for a later spec pass.

---

## Global Constraints

**The `[HUMAN]` rule.** Any step tagged `[HUMAN]` requires an account, a device, a console, a
purchase, or a person. An agent must **stop** at such a step, leave the checkbox unticked, and
report which step it stopped at. An agent must never:

- run `eas` in any form (`login`, `init`, `credentials`, `build`, `submit`, `update`);
- run `npm publish`, `pnpm publish`, `npm login`, or `npm adduser`;
- run `wrangler login`, `wrangler deploy`, `wrangler secret put`, or any dashboard action;
- open App Store Connect, Play Console, expo.dev, or the Cloudflare dashboard;
- fabricate a timestamp, device model, latency, screenshot, tester name, or "confirmed working".

If a `[HUMAN]` result is needed by a later step, stop there too. Leaving a template blank is
correct; filling it in with plausible-looking data is a failure.

**Bounded commands.** Every command an agent runs must terminate on its own. Use `vitest run`
(never watch mode), never `--follow`/`-w`, never `expo start`, never anything that waits for stdin.
Prefer the repo's own scripts.

**Verification gate.** Before every commit an agent makes:

```
pnpm lint && pnpm typecheck && pnpm test
```

For a mobile-only change the fast loop is
`pnpm -F @shellbell/mobile typecheck && pnpm -F @shellbell/mobile test`, but the full gate must
still pass before the commit.

**Package filters.** `shellbell` (the agent — that is the package name, not `@shellbell/agent`),
`@shellbell/mobile`, `@shellbell/relay`, `@shellbell/protocol`. The repo root is
`shellbell-monorepo`. Example: `pnpm -F shellbell build`.

**Style.** Biome 2.5.12: 2-space indent, double quotes, semicolons, **100 columns**. Run
`pnpm lint:fix` before the gate. TypeScript 5.9.3 strict with `noUncheckedIndexedAccess` on in the
mobile package — index reads are `T | undefined`.

**Secrets.** Never print, log, echo, commit, or paste a token, key, certificate, or push token.
Never add `google-services.json`, `*.p8`, `*.p12`, `*.jks`, or `*.mobileprovision` to git. Push
tokens are secrets: log at most a 6-character prefix.

**Commits.** Conventional commits, one per task, subject ≤ 72 chars. Never `git push`, never open
a PR, never tag — the coordinator does that.

---

## READ THESE SHIPPED FILES FIRST (pinned to main @ `890e51c`)

This plan was drafted before Plans 02–05 shipped. Read these before writing a line; several of them
already contain what an earlier draft of this plan asked you to build.

| File | Why |
|---|---|
| `apps/mobile/src/net/connection.ts` | `unpairSelf()` (l.196), `sendPushToken()` (l.202), and the `push-token`-on-`auth-ok` path (l.297-320) already exist. `PushTokenInfo` is `{ token, platform, enabled }`. |
| `apps/mobile/src/net/manager.ts` | `ManagerDeps.pushToken` (l.19), `notifyPushToggle()` (l.62), and the `case "event"` unread counter (l.229). Task 1 adds **one** optional dep here and nothing else. |
| `apps/mobile/app/_layout.tsx` | The `pushToken: async () => null` stub at l.49 is the single wiring point. Note the identity-error screen and the hydrate ordering. |
| `apps/mobile/app/c/[fp]/settings.tsx` | The Notifications `Switch` at l.103-110 already calls `notifyPushToggle`; Unpair at l.36-37 already calls `unpairSelf()` + `close()`. Do not duplicate either. |
| `apps/mobile/app.json` | `expo-notifications` plugin already present; `extra.eas.projectId` is the literal `"REPLACE_AFTER_eas_init"`; there is **no** `icon`, `splash`, or `android.adaptiveIcon` yet. |
| `apps/mobile/eas.json` | Three inert build profiles, `submit.production: {}`, no `autoIncrement`. |
| `apps/agent/package.json` | `name: "shellbell"`, `bin`, `files`, `os: ["darwin"]` — and `@shellbell/protocol` wrongly in `dependencies` (Task 6 fixes it). |
| `.github/workflows/deploy-relay.yml` | Already deploys on tag `relay-v*` with `CLOUDFLARE_*` secrets. Task 5 adds one flag. |
| `.github/workflows/ci.yml` | The gate every task must keep green: `check:vectors`, `expo-doctor`, `lint`, `typecheck`, `test`, `build` on `macos-15`. |

Also worth a skim: `apps/agent/src/events.ts` (`Ring.kind` includes `"blocked"`),
`apps/relay/src/push.ts` (`pushBody` incl. the `blocked` copy), `apps/mobile/src/ui/Toast.tsx`,
`apps/mobile/src/util/routes.ts` (`sidToRoute` / `sidFromRoute`), and
`apps/mobile/test/connection.test.ts` (the `FakeSocket` pattern Task 1's tests reuse).

---

## Task list

| # | Task | Who |
|---|---|---|
| 1 | Notifications in the app (spec §10.8, §11) | `[AGENT]` |
| 2 | Automated end-to-end ring test | `[AGENT]` |
| 3 | `app.json` / `eas.json` release configuration | `[AGENT]` |
| 4 | Design polish — code-level pass (spec §10.9) | `[AGENT]` |
| 5 | Hosted-relay config split (spec §9.3) | `[AGENT]` |
| 6 | Publishing plumbing for `shellbell` (spec §16) | `[AGENT]` |
| 7 | Release automation — Changesets + workflow (spec §16) | `[AGENT]` |
| 8 | Documentation, legal, protocol doc, release checklist (spec §16) | `[AGENT]` |
| 9 | EAS project, credentials, development builds | `[HUMAN]` |
| 10 | Domain, hosted relay deploy, secrets, WAF (spec §9.3/9.4) | `[HUMAN]` |
| 11 | Device end-to-end ring test (spec §17.1 M5) | `[HUMAN]` |
| 12 | Visual design + device QA pass (spec §10.9) | `[HUMAN]` |
| 13 | First release — npm, TestFlight, Play internal, listings (M6) | `[HUMAN]` |

Tasks 1–8 have no dependency on Tasks 9–13 and can all be completed unattended, in order. Task 11
needs Tasks 1, 9 and 10. Task 13 needs everything.

---

## Task 1 `[AGENT]`: Notifications in the app (spec §10.8, §11)

**Files**

- Create: `apps/mobile/src/notifications/routing.ts` (pure, node-testable)
- Create: `apps/mobile/src/notifications/index.ts` (the only module that touches
  `expo-notifications` / `expo-haptics`)
- Create: `apps/mobile/src/ui/ToastHost.tsx`
- Create: `apps/mobile/test/notifications.test.ts`
- Modify: `apps/mobile/src/net/manager.ts` (one optional dep, one call)
- Modify: `apps/mobile/app/_layout.tsx` (handler, channel, token provider, tap + deep link, toast host)
- Modify: `apps/mobile/app/pair.tsx` (ask permission after the first pairing, then register)
- Modify: `apps/mobile/app/c/[fp]/s/[sid].tsx` (drop the screen-local Toast — the host owns it now)

**Design notes (read before coding)**

- `manager.ts` must stay free of native imports so `test/manager.test.ts` keeps passing. The
  dependency is therefore **inverted**: the manager calls an injected `onForegroundEvent`, and
  `_layout.tsx` supplies the implementation from `src/notifications`. `src/notifications/index.ts`
  may import `connectionManager`; `manager.ts` must never import `src/notifications`.
- Nothing native runs at module scope. `installNotificationHandler()` is called from a
  `_layout.tsx` effect.
- Everything worth testing lives in `routing.ts` and takes plain data. `index.ts` is a thin port
  adapter over `expo-notifications`; tests inject a fake port where they need one.
- The paired-computer check (§11.1: "the app **validates** `computerFp`") lives in
  `resolveTarget`, which takes the paired fingerprint list as an argument.

- [ ] **Step 1: `apps/mobile/src/notifications/routing.ts`** — pure helpers, no native imports.

```ts
import { sidToRoute } from "../util/routes";

/** Spec 9.1 / 6.2: a fingerprint is 26 lowercase base32 characters. */
export const FP_RE = /^[a-z2-7]{26}$/;

/** A session id encoded for the router (`sidToRoute`), i.e. unpadded base64url. */
const SID_ROUTE_RE = /^[A-Za-z0-9_-]{1,512}$/;

/** Where a ring or a deep link wants to land. `sessionRoute` is already router-encoded. */
export interface NavTarget {
  computerFp: string;
  sessionRoute: string | null;
}

/**
 * Spec 11.1: a push is a *hint*. Nothing in it is trusted beyond routing, and the computer it
 * names must already be paired on this phone or the tap is ignored entirely.
 */
export function resolveTarget(data: unknown, pairedFps: readonly string[]): NavTarget | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const fp = typeof d.computerFp === "string" ? d.computerFp : null;
  if (fp === null || !FP_RE.test(fp) || !pairedFps.includes(fp)) return null;
  const sid = typeof d.sessionId === "string" && d.sessionId.length > 0 ? d.sessionId : null;
  return { computerFp: fp, sessionRoute: sid === null ? null : sidToRoute(sid) };
}

/**
 * `shellbell://c/<fp>` or `shellbell://c/<fp>/s/<sid-route>` (the session segment is already
 * base64url — it comes straight out of a route, not out of a push payload). Same trust rule as
 * `resolveTarget`: an unpaired or malformed fingerprint yields `null`.
 */
export function parseDeepLink(url: string, pairedFps: readonly string[]): NavTarget | null {
  const m = /^shellbell:\/\/c\/([^/?#]+)(?:\/s\/([^/?#]+))?\/?(?:[?#].*)?$/.exec(url);
  if (m === null) return null;
  const fp = m[1];
  if (fp === undefined || !FP_RE.test(fp) || !pairedFps.includes(fp)) return null;
  const route = m[2] ?? null;
  if (route !== null && !SID_ROUTE_RE.test(route)) return null;
  return { computerFp: fp, sessionRoute: route };
}

/**
 * Foreground copy (spec 10.8). Deliberately mirrors the relay's generic push bodies (9.2) but may
 * name the session, because nothing leaves the device. `exit` and unknown kinds return `null`:
 * the session screen already renders "Session ended." and nothing should buzz for it (8.8).
 */
export function foregroundToast(sessionTitle: string, kind: string): string | null {
  switch (kind) {
    case "prompt":
      return `${sessionTitle}: command finished`;
    case "idle":
      return `${sessionTitle}: went quiet — waiting?`;
    case "blocked":
      return `${sessionTitle}: an agent is waiting for you`;
    default:
      return null;
  }
}

/** The placeholder that ships in `app.json` until `eas init` runs (Task 9). */
export const PLACEHOLDER_PROJECT_ID = "REPLACE_AFTER_eas_init";

/** `null` until a real EAS project id exists, so no doomed token request is ever made. */
export function validProjectId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw === PLACEHOLDER_PROJECT_ID) return null;
  return raw;
}

/** The pure half of the tap handler: parse + validate + route. Injected with live paired fps. */
export function createTapHandler(
  open: (t: NavTarget) => void,
  pairedFps: () => readonly string[],
): (data: unknown) => void {
  return (data) => {
    const target = resolveTarget(data, pairedFps());
    if (target !== null) open(target);
  };
}
```

- [ ] **Step 2: `apps/mobile/src/notifications/index.ts`** — the native port. Note the narrow
  `NotificationsApi` interface: it exists so tests never have to satisfy expo's own types, and so
  this file is the only place `expo-notifications` is named.

```ts
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as ExpoNotifications from "expo-notifications";
import { Platform } from "react-native";
import { connectionManager } from "../net/manager";
import { useConnectionsStore } from "../store/connections";
import { foregroundToast, validProjectId } from "./routing";

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

/** A narrow port over `expo-notifications` so tests can inject a fake without expo's types. */
export interface NotificationsApi {
  setHandler(): void;
  ensureChannel(): Promise<void>;
  getPermissions(): Promise<PermissionState>;
  requestPermissions(): Promise<PermissionState>;
  getExpoPushToken(projectId: string): Promise<string>;
  onResponse(cb: (data: unknown) => void): () => void;
  getLastResponseData(): Promise<unknown>;
}

export const expoNotificationsApi: NotificationsApi = {
  setHandler() {
    ExpoNotifications.setNotificationHandler({
      // Spec 10.8: a foregrounded phone shows an in-app toast, not an OS banner. It is also not
      // push-eligible at all (11.3) — this only covers the lease-expiry race.
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  },
  async ensureChannel() {
    if (Platform.OS !== "android") return;
    await ExpoNotifications.setNotificationChannelAsync("rings", {
      name: "Rings",
      importance: ExpoNotifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 100, 250],
      lightColor: "#10B981",
    });
  },
  async getPermissions() {
    const p = await ExpoNotifications.getPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain };
  },
  async requestPermissions() {
    const p = await ExpoNotifications.requestPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain };
  },
  async getExpoPushToken(projectId) {
    const t = await ExpoNotifications.getExpoPushTokenAsync({ projectId });
    return t.data;
  },
  onResponse(cb) {
    const sub = ExpoNotifications.addNotificationResponseReceivedListener((r) => {
      cb(r.notification.request.content.data);
    });
    return () => sub.remove();
  },
  async getLastResponseData() {
    const r = await ExpoNotifications.getLastNotificationResponseAsync();
    return r?.notification.request.content.data ?? null;
  },
};

/** Call once, from a `_layout.tsx` effect. Never at module scope (it would break node tests). */
export function installNotificationHandler(api: NotificationsApi = expoNotificationsApi): void {
  api.setHandler();
}

export async function ensureChannel(api: NotificationsApi = expoNotificationsApi): Promise<void> {
  await api.ensureChannel();
}

/** Spec 10.8: asked once, after the first successful pairing. `false` if already denied. */
export async function requestPermissionOnce(
  api: NotificationsApi = expoNotificationsApi,
): Promise<boolean> {
  const cur = await api.getPermissions();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  return (await api.requestPermissions()).granted;
}

export interface PushToken {
  token: string;
  platform: "ios" | "android";
}

/** `null` without permission, without a real EAS project id, or on any network failure. */
export async function getPushToken(
  api: NotificationsApi = expoNotificationsApi,
): Promise<PushToken | null> {
  const perm = await api.getPermissions();
  if (!perm.granted) return null;
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const projectId = validProjectId(extra?.eas?.projectId);
  if (projectId === null) return null;
  try {
    const token = await api.getExpoPushToken(projectId);
    return { token, platform: Platform.OS === "ios" ? "ios" : "android" };
  } catch {
    // Offline, or Expo's servers said no. The next `auth-ok` tries again.
    return null;
  }
}

/**
 * Subscribes to notification taps and replays a cold-start tap. `handle` is built by
 * `createTapHandler` in `_layout.tsx` so the validation stays pure and testable.
 */
export function installTapHandler(
  handle: (data: unknown) => void,
  api: NotificationsApi = expoNotificationsApi,
): () => void {
  const off = api.onResponse(handle);
  void api
    .getLastResponseData()
    .then((d) => {
      if (d !== null && d !== undefined) handle(d);
    })
    .catch(() => undefined);
  return off;
}

/** Spec 10.8 foreground path: in-app toast + haptic. `unread` is already bumped by the manager. */
export function showForegroundEvent(fp: string, sessionTitle: string, kind: string): void {
  const text = foregroundToast(sessionTitle, kind);
  if (text === null) return;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  useConnectionsStore.getState().patch(fp, () => ({ toast: text }));
}

/**
 * Registers this phone's push token with a computer as soon as its socket exists. Needed because
 * permission is granted seconds *after* the first `auth-ok` has already run with no permission
 * (review row C7/P2). `notifyPushToggle` is a no-op while no connection exists, hence the bounded
 * retry rather than a single call.
 */
export async function registerPushTokenWhenConnected(fp: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (connectionManager.get(fp) !== undefined) {
      connectionManager.notifyPushToggle(fp, true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
```

- [ ] **Step 3: `apps/mobile/src/ui/ToastHost.tsx`** — one toast for the whole app.

Both selectors return primitives; a selector returning a fresh object each render would trip
zustand v5's snapshot check.

```tsx
import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { useConnectionsStore } from "../store/connections";
import { Toast } from "./Toast";

/**
 * Renders whichever computer currently has a toast (spec 12 lost-input, spec 10.8 foreground
 * rings). Mounted at the root so a ring that arrives while the user is on the computers or
 * sessions list is visible immediately instead of surfacing later on a session screen.
 */
export function ToastHost() {
  const fp = useConnectionsStore(
    (s) => Object.keys(s.byComputer).find((k) => s.byComputer[k]?.toast !== undefined) ?? null,
  );
  const text = useConnectionsStore((s) => (fp === null ? null : (s.byComputer[fp]?.toast ?? null)));
  const onDone = useCallback(() => {
    if (fp === null) return;
    useConnectionsStore.getState().patch(fp, () => ({ toast: undefined }));
  }, [fp]);

  if (fp === null || text === null) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Toast text={text} onDone={onDone} />
    </View>
  );
}
```

- [ ] **Step 4: `apps/mobile/src/net/manager.ts`** — two small edits, no new imports.

Add to `ManagerDeps` (after `pushToken`):

```ts
  /** Spec 10.8 foreground path. Injected by `_layout.tsx` so this module stays native-free:
   *  importing `src/notifications` here would pull `expo-notifications` into `manager.test.ts`. */
  onForegroundEvent?: (computerFp: string, sessionTitle: string, kind: string) => void;
```

Replace the `case "event":` block in `onInner` with:

```ts
      case "event": {
        const title = store.read(fp).sessions.find((s) => s.id === m.sessionId)?.title ?? "Session";
        store.patch(fp, (c) => ({
          events: {
            ...c.events,
            [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m],
          },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        this.deps?.onForegroundEvent?.(fp, title, m.kind);
        return;
      }
```

- [ ] **Step 5: `apps/mobile/app/_layout.tsx`** — full replacement file.

```tsx
import "../src/bootstrap/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { connectionManager } from "../src/net/manager";
import {
  ensureChannel,
  getPushToken,
  installNotificationHandler,
  installTapHandler,
  showForegroundEvent,
} from "../src/notifications";
import { createTapHandler, type NavTarget, parseDeepLink } from "../src/notifications/routing";
import { useComputersStore, useUiStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";
import { tokens } from "../src/theme/tokens";
import { ToastHost } from "../src/ui/ToastHost";
import { sidFromRoute } from "../src/util/routes";

void SplashScreen.preventAutoHideAsync();

// M1: the manifest version, not a hardcoded literal that would silently drift from the real
// build (the relay records `appVersion` on every phone socket).
const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

const pairedFps = (): string[] => useComputersStore.getState().computers.map((c) => c.fp);

/** Cancellable so a second tap (or an unmount) cannot leave a chain of timers running (C8). */
let sessionOpenTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingOpen(): void {
  if (sessionOpenTimer !== null) clearTimeout(sessionOpenTimer);
  sessionOpenTimer = null;
}

/**
 * Spec 10.8: open the computer immediately, then the session once `sessions` has actually arrived
 * and contains it. If it never arrives (a session that ended while the phone was away), stay on
 * the sessions list — a push is a hint, never an instruction.
 */
function openTarget(t: NavTarget): void {
  cancelPendingOpen();
  router.push(`/c/${t.computerFp}`);
  const route = t.sessionRoute;
  if (route === null) return;
  const sessionId = sidFromRoute(route);
  let attempts = 0;
  const tryOpen = () => {
    sessionOpenTimer = null;
    const conn = useConnectionsStore.getState().byComputer[t.computerFp];
    if (conn?.sessions.some((s) => s.id === sessionId) === true) {
      router.push(`/c/${t.computerFp}/s/${route}`);
      return;
    }
    attempts += 1;
    if (attempts < 20) sessionOpenTimer = setTimeout(tryOpen, 500);
  };
  tryOpen();
}

export default function RootLayout() {
  // I6: a corrupt/unreadable keychain (or a locked one on Android) must not leave the app
  // silently stuck on "idle" forever with no connection manager ever started -- it gets an
  // honest, non-actionable-detail error screen instead. The message deliberately never includes
  // the underlying exception (it can name on-device key paths).
  const [identityError, setIdentityError] = useState(false);

  useEffect(() => {
    useComputersStore.getState().hydrate();
    useUiStore.getState().hydrate();
    // Fonts are natively embedded (expo-font config plugin, review I2) -- there is no JS font
    // load to gate on, so the splash can come down as soon as the tree is ready to paint.
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    // Spec 10.8: the handler and the Android `rings` channel must exist before any push can
    // arrive, so both are installed at startup rather than at permission time.
    installNotificationHandler();
    void ensureChannel();
    const handle = createTapHandler(openTarget, pairedFps);
    const offTap = installTapHandler(handle);
    const onUrl = (url: string) => {
      const t = parseDeepLink(url, pairedFps());
      if (t !== null) openTarget(t);
    };
    const urlSub = Linking.addEventListener("url", (e) => onUrl(e.url));
    void Linking.getInitialURL()
      .then((u) => {
        if (u !== null) onUrl(u);
      })
      .catch(() => undefined);
    return () => {
      offTap();
      urlSub.remove();
      cancelPendingOpen();
    };
  }, []);

  useEffect(() => {
    // Covers this cold start's paired computers' `K_pair`s in the same one-time keychain
    // migration pass as the identity key (review C1) -- safe because the hydrate effect above
    // runs first (declaration order within one commit).
    const startFps = useComputersStore.getState().computers.map((c) => c.fp);
    loadOrCreateIdentity(startFps)
      .then(({ identity, fp }) => {
        connectionManager.start({
          identity,
          phoneFp: fp,
          phoneName: Device.deviceName ?? "My phone",
          appVersion: APP_VERSION,
          // Spec 10.8: sent as `push-token` on every `auth-ok` by `ComputerConnection`.
          pushToken: async (computerFp) => {
            const t = await getPushToken();
            if (t === null) return null;
            const c = useComputersStore.getState().computers.find((x) => x.fp === computerFp);
            if (c === undefined) return null;
            return { ...t, enabled: c.pushEnabled };
          },
          onForegroundEvent: showForegroundEvent,
        });
      })
      .catch(() => setIdentityError(true));
  }, []);

  if (identityError) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 8,
          backgroundColor: tokens.bg,
        }}
      >
        <StatusBar style="light" />
        <Text style={{ color: tokens.text, textAlign: "center", fontSize: 16 }}>
          Could not access secure storage.
        </Text>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
          Restart Shellbell. If this keeps happening, reinstall the app and re-pair.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: tokens.bg }}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: tokens.bg },
            headerTintColor: tokens.text,
            contentStyle: { backgroundColor: tokens.bg },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Computers" }} />
          <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="c/[fp]" options={{ headerShown: false }} />
          <Stack.Screen name="dev/render-spike" options={{ title: "Render spike" }} />
        </Stack>
        <ToastHost />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
```

Typed routes are **not** enabled (`app.json` has no `experiments.typedRoutes`), so the template
strings above type-check as plain `Href` strings. If `tsc` disagrees, do not cast — check whether
someone enabled typed routes and fix the route literal instead.

- [ ] **Step 6: `apps/mobile/app/pair.tsx`** — ask for permission after the *first* pairing, then
  register the token immediately.

Add to the imports:

```ts
import { registerPushTokenWhenConnected, requestPermissionOnce } from "../src/notifications";
```

In `onScan`, capture whether this is the first computer *before* `add(...)`, and insert the
permission flow between `guard.current.end("success")` and `router.replace(...)`:

```ts
      const isFirstComputer = useComputersStore.getState().computers.length === 0;
      await savePairSecret(r.computerFp, r.secret);
      add({
        fp: r.computerFp,
        name: r.computerName,
        accent: r.accent,
        relayUrl: r.relayUrl,
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pushEnabled: true,
      });
      guard.current.end("success");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (isFirstComputer) {
        // Spec 10.8: one line of context before the system dialog, which is otherwise unexplained.
        await new Promise<void>((resolve) => {
          Alert.alert(
            "Let Shellbell ring you?",
            "Shellbell rings you when a command finishes or a program is waiting.",
            [{ text: "Continue", onPress: () => resolve() }],
          );
        });
        if (await requestPermissionOnce()) {
          // The socket already authenticated without a token (permission came later), so register
          // now rather than waiting for the next foreground (review row C7/P2).
          void registerPushTokenWhenConnected(r.computerFp);
        }
      }
      router.replace(`/c/${r.computerFp}`);
```

- [ ] **Step 7: `apps/mobile/app/c/[fp]/s/[sid].tsx`** — remove the screen-local toast, now that
  `ToastHost` owns it. Delete the import line

```ts
import { Toast } from "../../../../src/ui/Toast";
```

and the whole JSX block

```tsx
        {conn?.toast ? (
          <Toast
            text={conn.toast}
            onDone={() =>
              useConnectionsStore.getState().patch(fp ?? "", () => ({ toast: undefined }))
            }
          />
        ) : null}
```

Leave every other use of `useConnectionsStore` in that file alone.

- [ ] **Step 8: `apps/mobile/test/notifications.test.ts`** — write these tests **before** wiring
  Steps 5–7 if you are working TDD-style; they only depend on Steps 1–2.

The suite imports `src/notifications/routing` (pure) and `src/net/connection` — never
`src/notifications/index.ts`, which would pull `expo-notifications` into node.

```ts
import {
  type CtrlMessageLoose,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  parseCtrlLoose,
  randomBytes,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { ComputerConnection } from "../src/net/connection";
import {
  createTapHandler,
  foregroundToast,
  type NavTarget,
  parseDeepLink,
  PLACEHOLDER_PROJECT_ID,
  resolveTarget,
  validProjectId,
} from "../src/notifications/routing";
import { sidToRoute } from "../src/util/routes";

const PAIRED = "a".repeat(26);
const OTHER = "b".repeat(26);

describe("resolveTarget (spec 11.1: validate computerFp before navigating)", () => {
  it("routes a paired computer with a session", () => {
    expect(resolveTarget({ computerFp: PAIRED, sessionId: "iterm2:w0t0p0", kind: "prompt" }, [
      PAIRED,
    ])).toEqual({ computerFp: PAIRED, sessionRoute: sidToRoute("iterm2:w0t0p0") });
  });

  it("routes a paired computer with no session", () => {
    expect(resolveTarget({ computerFp: PAIRED }, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: null,
    });
  });

  it("ignores a computer this phone is not paired with", () => {
    expect(resolveTarget({ computerFp: OTHER, sessionId: "s" }, [PAIRED])).toBeNull();
  });

  it("ignores a malformed fingerprint even when the list is empty-checked loosely", () => {
    expect(resolveTarget({ computerFp: "NOT-A-FP" }, ["NOT-A-FP"])).toBeNull();
    expect(resolveTarget({ computerFp: `${PAIRED}x` }, [`${PAIRED}x`])).toBeNull();
  });

  it("ignores junk payloads", () => {
    for (const junk of [null, undefined, 42, "string", [], {}, { computerFp: 7 }]) {
      expect(resolveTarget(junk, [PAIRED])).toBeNull();
    }
  });
});

describe("parseDeepLink", () => {
  it("parses a computer link and a session link", () => {
    expect(parseDeepLink(`shellbell://c/${PAIRED}`, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: null,
    });
    const route = sidToRoute("tmux:%3");
    expect(parseDeepLink(`shellbell://c/${PAIRED}/s/${route}`, [PAIRED])).toEqual({
      computerFp: PAIRED,
      sessionRoute: route,
    });
  });

  it("rejects other schemes, unpaired computers, and non-base64url session segments", () => {
    expect(parseDeepLink(`https://c/${PAIRED}`, [PAIRED])).toBeNull();
    expect(parseDeepLink(`shellbell://c/${OTHER}`, [PAIRED])).toBeNull();
    expect(parseDeepLink(`shellbell://c/${PAIRED}/s/has spaces`, [PAIRED])).toBeNull();
    expect(parseDeepLink("shellbell://pair", [PAIRED])).toBeNull();
  });
});

describe("foregroundToast (spec 10.8 / 8.13)", () => {
  it("maps every ringing kind, including blocked", () => {
    expect(foregroundToast("build", "prompt")).toBe("build: command finished");
    expect(foregroundToast("build", "idle")).toBe("build: went quiet — waiting?");
    expect(foregroundToast("claude", "blocked")).toBe("claude: an agent is waiting for you");
  });

  it("stays silent for exit and unknown kinds", () => {
    expect(foregroundToast("build", "exit")).toBeNull();
    expect(foregroundToast("build", "bell")).toBeNull();
  });
});

describe("validProjectId", () => {
  it("rejects the shipped placeholder and anything non-string", () => {
    expect(validProjectId(PLACEHOLDER_PROJECT_ID)).toBeNull();
    expect(validProjectId("")).toBeNull();
    expect(validProjectId(undefined)).toBeNull();
    expect(validProjectId(123)).toBeNull();
  });

  it("accepts a real id", () => {
    expect(validProjectId("6f0b1c2d-1111-2222-3333-444455556666")).toBe(
      "6f0b1c2d-1111-2222-3333-444455556666",
    );
  });
});

describe("createTapHandler", () => {
  it("opens only validated targets and re-reads the paired list on every tap", () => {
    const opened: NavTarget[] = [];
    let paired: string[] = [];
    const handle = createTapHandler((t) => opened.push(t), () => paired);
    handle({ computerFp: PAIRED });
    expect(opened).toHaveLength(0);
    paired = [PAIRED];
    handle({ computerFp: PAIRED });
    handle({ computerFp: OTHER });
    expect(opened).toEqual([{ computerFp: PAIRED, sessionRoute: null }]);
  });
});

/** A recording `WsLike` double — same shape as the one in `connection.test.ts`. */
class RecordingSocket {
  binaryType = "";
  readyState = 0;
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") return;
    this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  ctrl(body: CtrlMessageLoose): void {
    const env: Envelope = { v: 1, t: "ctrl", from: "relay", seq: 0, body } as Envelope;
    this.onmessage?.({ data: encodeEnvelope(env) });
  }

  ctrlsSent(): CtrlMessageLoose[] {
    const out: CtrlMessageLoose[] = [];
    for (const bytes of this.sent) {
      const env = decodeEnvelope(bytes);
      if (env.t === "ctrl") out.push(parseCtrlLoose(env.body));
    }
    return out;
  }
}

describe("token -> push-token ctrl (spec 10.8)", () => {
  it("sends the provider's token on auth-ok", async () => {
    const identity = generateIdentity();
    const phoneFp = fingerprint(identity.ed25519.pub);
    let socket: RecordingSocket | null = null;
    const conn = new ComputerConnection({
      computerFp: "c".repeat(26),
      relayUrl: "wss://relay.example",
      identity,
      phoneFp,
      phoneName: "Test phone",
      appVersion: "0.1.0",
      kPair: randomBytes(32),
      pushToken: async () => ({ token: "ExponentPushToken[xxx]", platform: "ios", enabled: true }),
      onInner: () => undefined,
      onStatus: () => undefined,
      WebSocketImpl: class extends RecordingSocket {
        constructor(url: string) {
          super(url);
          socket = this;
        }
      },
    });
    conn.connect();
    const s = socket as RecordingSocket | null;
    if (s === null) throw new Error("socket was not created");
    s.open();
    s.ctrl({ type: "challenge", nonce: randomBytes(32), connId: "conn-1" });
    s.ctrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: false,
      computerName: "MBP",
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    // The provider is async; let its microtask chain settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pushCtrl = s.ctrlsSent().find((m) => m.type === "push-token");
    expect(pushCtrl).toEqual({
      type: "push-token",
      token: "ExponentPushToken[xxx]",
      platform: "ios",
      enabled: true,
    });
    conn.close("user");
  });
});
```

If `WebSocketImpl`'s anonymous subclass fights the `new (url: string) => WsLike` signature, hoist a
named class and a module-level `let lastSocket` instead of the inline expression — the assertion is
what matters, not the construction style.

- [ ] **Step 9: gate and commit.**

```
pnpm -F @shellbell/mobile typecheck && pnpm -F @shellbell/mobile test
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add apps/mobile && git commit -m "feat(mobile): push tokens, ring tap routing, deep links, foreground toasts"
```

---

## Task 2 `[AGENT]`: Automated end-to-end ring test

The device half of M5 is Task 11 and is `[HUMAN]`. This task builds the part a machine *can*
prove: a backend event on the agent side produces the right `event` inner message on the phone and
the right `notify` ctrl at the relay, for all three ringing kinds — **including `blocked`** (04b),
which nothing currently covers end to end. The relay's own push gating and bodies are already
covered by `apps/relay/test/push.test.ts`; do not duplicate them.

**Files:** Create `apps/mobile/test/ring-e2e.test.ts`.

- [ ] **Step 1: read the existing harness.** `apps/mobile/test/connection.test.ts` already wires
  `FakeRelay` (from `apps/agent/test/fakes/fake-relay.ts`) + the agent's `RelayClient` and
  `PhoneLink` against a real `ComputerConnection`. Reuse that `fakeAgent` shape verbatim; do not
  invent a new harness. `apps/agent/test/events.test.ts` shows how to drive `EventEngine` with an
  injected clock.

- [ ] **Step 2: write the test.** Structure:

1. Start a `FakeRelay` for a computer fingerprint.
2. Stand up the agent side: `RelayClient` + `PhoneLink` (as in `connection.test.ts`'s `fakeAgent`),
   plus a real `EventEngine` (injected `now`) and a real `Notifier` whose `send` is
   `relayClient.sendCtrl`.
3. Stand up the phone side: a real `ComputerConnection` with a `pushToken` provider returning a
   fixed token, collecting `onInner` messages.
4. Wire `events.on("event", (ev) => phoneLink.send(ev))` and
   `events.on("ring", (r) => notifier.ring(r))` — the same wiring `apps/agent/src/agent.ts:158-160`
   uses.
5. Drive three scenarios and assert both halves each time:

| Scenario | Driver | Phone must receive | `relay.ctrlFromAgent` must contain |
|---|---|---|---|
| prompt | `command-start`, advance 15 s, `command-end { exitCode: 0 }` | inner `event` `kind: "prompt"`, `exitCode: 0`, `durationMs >= 15000` | `notify` `{ kind: "prompt", exitCode: 0 }` |
| idle | `screen-changed`, advance 2 s, `screen-changed`, advance 5 s + `tick()` | inner `event` `kind: "idle"` | `notify` `{ kind: "idle" }` |
| blocked | `agent-state { state: "working" }` then `{ state: "blocked" }` | inner `event` `kind: "blocked"` | `notify` `{ kind: "blocked" }` |

The `blocked` case needs a **prior** non-null agent state: `events.ts:137-139` deliberately does not
ring on the first `agent-state` it ever sees for a session (agent start / herdr reconnect), so send
`working` first.

6. Assert the phone's own ctrl traffic once, from `relay.ctrlFromPhones`: a `lease` with
   `ttlMs: 60000` and a `push-token` with the provider's token and `enabled: true` (spec §11.3,
   §10.8).
7. Assert a short command does **not** ring: `command-end` after 2 s emits an `event` but no
   `notify` (spec §8.8, `notifyMinCommandMs` 10 000).

Use `waitFor` (copy the 10 ms-poll helper from `connection.test.ts`) rather than fixed sleeps, and
keep the whole suite under the 15 s `testTimeout` already configured in
`apps/mobile/vitest.config.mts`. Close every socket and stop the relay in `afterEach`.

- [ ] **Step 3: gate and commit.**

```
pnpm -F @shellbell/mobile test
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add apps/mobile && git commit -m "test(mobile): end-to-end ring path incl. blocked agent state"
```

---

## Task 3 `[AGENT]`: `app.json` / `eas.json` release configuration

Config only — no `eas` command is run here. Task 9 consumes this.

**Files:** Modify `apps/mobile/app.json`, `apps/mobile/eas.json`, `apps/mobile/package.json`.

- [ ] **Step 1: `app.json` — icon, splash and Android adaptive icon.** The assets have existed
  since Plan 05 (`apps/mobile/assets/icon.png`, `splash-icon.png`,
  `android-icon-{background,foreground,monochrome}.png`, `favicon.png`) but nothing references
  them, so a production build would ship Expo's default icon. Add, alongside the existing keys:

```jsonc
    "icon": "./assets/icon.png",
    "ios": {
      // ...existing ios block, plus:
      "icon": "./assets/icon.png"
    },
    "android": {
      // ...existing android block, plus:
      "adaptiveIcon": {
        "foregroundImage": "./assets/android-icon-foreground.png",
        "backgroundImage": "./assets/android-icon-background.png",
        "monochromeImage": "./assets/android-icon-monochrome.png",
        "backgroundColor": "#000000"
      }
    },
```

and add the splash plugin to the `plugins` array (spec §10.9: OLED black):

```jsonc
      [
        "expo-splash-screen",
        {
          "image": "./assets/splash-icon.png",
          "backgroundColor": "#000000",
          "imageWidth": 200
        }
      ],
```

Keep `expo-router` first in `plugins`. Do **not** add `expo-updates` — EAS Update is v1.1.

- [ ] **Step 2: `eas.json`** — build numbers and a submit section with explicit, obviously-fake
  placeholders that Task 13 replaces.

```jsonc
{
  "cli": { "version": ">= 16.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {
      "autoIncrement": true,
      "env": {}
    }
  },
  "submit": {
    "production": {
      "ios": {
        // [HUMAN] Task 13: replace all three from App Store Connect.
        "appleId": "REPLACE_APPLE_ID_EMAIL",
        "ascAppId": "REPLACE_ASC_APP_ID",
        "appleTeamId": "REPLACE_APPLE_TEAM_ID"
      },
      "android": {
        // [HUMAN] Task 13: a Play service-account JSON kept OUT of git (EAS file env var).
        "serviceAccountKeyPath": "REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH",
        "track": "internal"
      }
    }
  }
}
```

`autoIncrement: true` bumps `buildNumber` (iOS) and `versionCode` (Android); the human-facing
version stays `app.json`'s `version`.

- [ ] **Step 3: `apps/mobile/package.json`** — set `"version": "0.1.0"` (it is a stale `1.0.0` from
  the Expo template; the package is `private: true` so nothing depends on it, but it should not
  contradict `app.json`).

- [ ] **Step 4: gate and commit.** `pnpm -F @shellbell/mobile doctor` must stay green (CI runs it).

```
pnpm -F @shellbell/mobile doctor
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add apps/mobile && git commit -m "chore(mobile): icon, splash, adaptive icon, EAS build/submit config"
```

---

## Task 4 `[AGENT]`: Design polish — code-level pass (spec §10.9)

Use the `frontend-design` skill for judgement, but the scope is fixed: apply §10.9's **existing**
tokens consistently. No new screens, no new tokens, no architecture changes. Everything requiring a
running app or an eye on a device is Task 12.

- [ ] **Step 1: accent audit.** For every screen, confirm the computer's accent tints exactly the
  five surfaces §10.9 names — card stripe, session header dot, cursor, send button, connection
  indicator — and nothing else. Read `app/index.tsx`, `app/c/[fp]/index.tsx`,
  `app/c/[fp]/s/[sid].tsx`, `src/ui/Card.tsx`, `src/ui/Pill.tsx`, `src/screen/Cursor.tsx`,
  `src/input/InputBar.tsx`. Fix drift; do not add new accented surfaces.

- [ ] **Step 2: surface audit.** `radius.lg` on cards, 1-px `tokens.border` borders, **no shadows**
  (OLED), `tokens.bg` `#000000` behind every screen. Grep for `shadow`, `elevation`, and any hex
  literal that should be a token: `grep -rn "shadow\|elevation\|#[0-9A-Fa-f]\{6\}" apps/mobile/src apps/mobile/app`.
  Every remaining hex literal must be justified in a comment or replaced by a token.

- [ ] **Step 3: motion.** Reanimated layout transitions on the computers and sessions lists,
  150 ms ease-out (§10.9). Add `LinearTransition.duration(150)` where a list item is added or
  removed; do not animate the terminal grid.

- [ ] **Step 4: empty states.** Every `EmptyState` is one sentence with at most one action
  (§10.9). Check the computers list, sessions list, session screen, and the unpaired/offline paths.

- [ ] **Step 5: haptics.** Exactly three: `Light` on send, `Success` on pair, `Warning` on ring
  (Task 1's `showForegroundEvent`). `grep -rn "Haptics\." apps/mobile` and remove any other buzz.

- [ ] **Step 6: accessibility.** Every quick key and icon-only pressable has an
  `accessibilityLabel`; UI text scales with the system setting; the terminal font does **not**
  (`allowFontScaling={false}` on `ScreenRow`/`LineView` only).

- [ ] **Step 7: gate and commit.**

```
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add apps/mobile && git commit -m "style(mobile): design pass — accents, motion, empty states, a11y"
```

Record anything you could not verify without a device in the Task 12 checklist rather than guessing.

---

## Task 5 `[AGENT]`: Hosted-relay config split (spec §9.3)

Spec §9.3 puts the custom-domain `routes` in `wrangler.jsonc`; the shipped file deliberately keeps
it as a comment so a self-hoster can `wrangler deploy` a clone without owning `shellbell.dev`
(`docs/self-hosting.md` step 3 depends on that). **Ruling R62.3:** keep both — a separate hosted
config, used only by CI.

**Files:** Create `apps/relay/wrangler.hosted.jsonc`; modify `.github/workflows/deploy-relay.yml`,
`docs/self-hosting.md`.

- [ ] **Step 1: `apps/relay/wrangler.hosted.jsonc`** — identical to `wrangler.jsonc` plus `routes`.
  Copy the shipped values exactly (do **not** change `compatibility_date`).

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  // The HOSTED relay only (relay.shellbell.dev). Self-hosters use `wrangler.jsonc`, which is
  // identical minus `routes`. Keep the two files in sync by hand — a self-hoster who deploys with
  // this file would try to claim a domain they do not own.
  "name": "shellbell-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-22",
  "durable_objects": {
    "bindings": [{ "name": "COMPUTER", "class_name": "ComputerDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ComputerDO"] }],
  "observability": { "enabled": true },
  "vars": { "MIN_FRAME_MS": "125" },
  "routes": [{ "pattern": "relay.shellbell.dev", "custom_domain": true }]
}
```

- [ ] **Step 2: `.github/workflows/deploy-relay.yml`** — point the deploy step at it:

```yaml
      - run: pnpm -F @shellbell/relay exec wrangler deploy --config wrangler.hosted.jsonc
```

Leave the trigger (`tags: ["relay-v*"]`), the test step, and both `CLOUDFLARE_*` env vars alone.

- [ ] **Step 3: `apps/relay/wrangler.jsonc`** — replace the trailing comment with an accurate one:

```jsonc
  // Self-hosted default: no `routes`, so `wrangler deploy` publishes to
  // https://shellbell-relay.<account>.workers.dev. The hosted relay (relay.shellbell.dev) is
  // deployed from wrangler.hosted.jsonc by .github/workflows/deploy-relay.yml — keep the two in
  // sync when either changes.
```

- [ ] **Step 4: `docs/self-hosting.md`** — after step 3, add one line: "Ignore
  `wrangler.hosted.jsonc`; it binds the author's `relay.shellbell.dev` domain and is used only by
  CI."

- [ ] **Step 5: verify without deploying.** `pnpm -F @shellbell/relay exec wrangler deploy --config wrangler.hosted.jsonc --dry-run --outdir .wrangler/dry`
  type-checks and bundles the Worker without touching Cloudflare and without needing credentials.
  If it asks for login or an account id, **stop** — that is a `[HUMAN]` step. `.wrangler/` is
  already gitignored.

- [ ] **Step 6: gate and commit.**

```
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add apps/relay docs/self-hosting.md .github/workflows/deploy-relay.yml
git commit -m "chore(relay): split hosted custom-domain config from the self-hosted default"
```

---

## Task 6 `[AGENT]`: Publishing plumbing for `shellbell` (spec §16)

Today `apps/agent/package.json` lists `"@shellbell/protocol": "workspace:*"` in `dependencies`
while `tsdown` bundles that package into `dist/cli.js`. Publishing as-is ships a tarball declaring a
dependency on a package that does not exist on npm, so `npx shellbell` cannot install. This task
fixes that and adds a gate an agent can actually run.

**Files:** Modify `packages/protocol/package.json`, `apps/agent/package.json`; create
`apps/agent/scripts/check-bundle.mjs`.

- [ ] **Step 1: make the protocol package private.** In `packages/protocol/package.json` add
  `"private": true` next to `"version"`. It is consumed only through the workspace and its `main`
  points at TypeScript source — it was never publishable. This also keeps Changesets (Task 7) from
  trying to version it.

- [ ] **Step 2: move the dependency.** In `apps/agent/package.json`, delete
  `"@shellbell/protocol": "workspace:*"` from `dependencies` and add it to `devDependencies`
  (same specifier). Leave `ws`, `@bufbuild/protobuf`, `commander`, `qrcode-terminal` and `zod` in
  `dependencies` — `tsdown.config.ts` lists them under `deps.neverBundle`, so they are genuine
  runtime deps of the published bundle.

- [ ] **Step 3: confirm the bundler still inlines it.** `tsdown.config.ts` uses
  `deps.alwaysBundle: [/^@shellbell\//, "cborg", /^@noble\//]` (tsdown 0.23's replacement for the
  deprecated `noExternal`). Moving a package to `devDependencies` does not change bundling — Step 5
  proves it rather than assuming it. Do **not** rename these options.

- [ ] **Step 4: `apps/agent/scripts/check-bundle.mjs`** — the leak/shape check that runs before
  every publish.

```js
#!/usr/bin/env node
// Publish gate for `shellbell`. Fails loudly rather than shipping a tarball that cannot install.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const bundle = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");
const fail = (msg) => {
  console.error(`check-bundle: ${msg}`);
  process.exitCode = 1;
};

if (!bundle.startsWith("#!/usr/bin/env node")) fail("dist/cli.js is missing the shebang (spec 16)");

// 1. Nothing may still import a workspace package: those are bundled, never published.
if (/["']@shellbell\/[^"']+["']/.test(bundle)) {
  fail("dist/cli.js still references @shellbell/* — it must be bundled (tsdown alwaysBundle)");
}

// 2. Every bare import left in the bundle must be a declared runtime dependency.
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const specifiers = new Set();
for (const m of bundle.matchAll(/\bfrom\s*["']([^"'.][^"']*)["']/g)) specifiers.add(m[1]);
for (const m of bundle.matchAll(/\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g)) specifiers.add(m[1]);
for (const spec of specifiers) {
  if (spec.startsWith("node:")) continue;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (!deps.has(name)) fail(`dist/cli.js imports "${spec}" which is not in dependencies`);
}

// 3. No workspace protocol may reach the tarball's manifest.
for (const [k, v] of Object.entries(pkg.dependencies ?? {})) {
  if (String(v).startsWith("workspace:")) fail(`dependency ${k} is "${v}" — move it to devDependencies`);
}

// 4. Nothing that looks like a credential may be in the bundle.
for (const marker of ["BEGIN PRIVATE KEY", "BEGIN RSA", "EXPO_ACCESS_TOKEN", "npm_", "ExponentPushToken["]) {
  if (bundle.includes(marker)) fail(`dist/cli.js contains the marker ${JSON.stringify(marker)}`);
}

if (process.exitCode) process.exit(1);
console.log("check-bundle: ok");
```

- [ ] **Step 5: add the publish gate and the pack smoke test** to `apps/agent/package.json`
  `scripts`:

```jsonc
    "check:bundle": "node scripts/check-bundle.mjs",
    "prepublishOnly": "pnpm build && pnpm check:bundle && node dist/cli.js --version",
    "pack:smoke": "bash scripts/pack-smoke.sh"
```

`prepublishOnly` runs on `pnpm publish` (Task 13) and on `pnpm pack`, so the gate cannot be skipped.
`node dist/cli.js --version` exercises the bundle's own entry point (commander's `--version` is
wired at `src/cli.ts:41`) and exits immediately.

- [ ] **Step 6: `apps/agent/scripts/pack-smoke.sh`** — proves the tarball installs standalone
  without publishing anything. An agent **may** run this (it needs network to fetch the five runtime
  deps; skip and say so if the network is unavailable).

```bash
#!/usr/bin/env bash
# Packs `shellbell` and installs the tarball into a throwaway prefix to prove `npx shellbell`
# would work. Publishes nothing and touches nothing outside $TMPDIR.
set -euo pipefail
cd "$(dirname "$0")/.."
PREFIX="$(mktemp -d)"
trap 'rm -rf "$PREFIX"' EXIT
rm -f shellbell-*.tgz
pnpm pack
TARBALL="$(ls shellbell-*.tgz)"
echo "packed $TARBALL"
npm install -g --prefix "$PREFIX" "./$TARBALL"
"$PREFIX/bin/shellbell" --version
npm uninstall -g --prefix "$PREFIX" shellbell
rm -f "$TARBALL"
echo "pack-smoke: ok"
```

`chmod +x apps/agent/scripts/pack-smoke.sh`. Add `apps/agent/shellbell-*.tgz` to the root
`.gitignore` so a stray tarball is never committed.

- [ ] **Step 7: run the gates.**

```
pnpm -F shellbell build
pnpm -F shellbell check:bundle
pnpm -F shellbell pack:smoke
```

All three must print `ok` / a version. If `check:bundle` reports an unexpected import, fix
`tsdown.config.ts`'s `deps` lists — do not relax the check.

- [ ] **Step 8: gate and commit.**

```
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add packages/protocol apps/agent .gitignore
git commit -m "fix(agent): publishable tarball — bundle protocol, add prepublish gate and pack smoke"
```

---

## Task 7 `[AGENT]`: Release automation — Changesets + workflow (spec §16)

Files only; the first actual publish is Task 13.

**Files:** Create `.changeset/config.json` (via the CLI) and a changeset; create
`.github/workflows/release-agent.yml`; modify the root `package.json`.

- [ ] **Step 1: install Changesets.**

```
pnpm add -Dw @changesets/cli@3.0.1
pnpm changeset init
```

- [ ] **Step 2: `.changeset/config.json`** — only `shellbell` is publishable. No `ignore` list:
  `@shellbell/relay` and `@shellbell/mobile` are already `private: true` and `@shellbell/protocol`
  became private in Task 6, and Changesets skips private packages by default.

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch"
}
```

- [ ] **Step 3: `.github/workflows/release-agent.yml`.**

```yaml
# Opens a "Version Packages" PR on every push to main that carries changesets; publishing happens
# when that PR is merged. Requires the NPM_TOKEN repo secret ([HUMAN], Task 13).
name: release-agent
on:
  push:
    branches: [main]
concurrency:
  group: release-agent
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
        with:
          version: 11.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - run: pnpm -F shellbell build
      - uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm -F shellbell publish --no-git-checks --access public
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`pnpm publish` (not `npm publish`) is required: it is what rewrites workspace specifiers and honours
the workspace layout. `--no-git-checks` is needed because the action publishes from a merge commit.
`prepublishOnly` from Task 6 runs the build + bundle check + smoke automatically.

- [ ] **Step 4: add the first changeset.** Create `.changeset/initial-release.md`:

```md
---
"shellbell": minor
---

Initial public release: pair a phone by QR, mirror iTerm2, tmux and Herdr sessions end-to-end
encrypted, reply from the phone, and get a push when a command finishes, a program goes quiet, or
a coding agent is blocked.
```

`minor` takes `0.0.1` → `0.1.0`, matching `app.json`'s version. Do **not** hand-edit
`apps/agent/package.json`'s version — Changesets owns it.

- [ ] **Step 5: verify locally without publishing.**

```
pnpm changeset status
pnpm changeset version --snapshot preflight   # writes versions
git diff --stat                                # inspect
git checkout -- .                              # revert; Task 13 does the real bump
```

Confirm the diff touches only `apps/agent/package.json`, `apps/agent/CHANGELOG.md` and
`.changeset/`. If it touches `@shellbell/protocol`, Step 1 of Task 6 was not applied.

- [ ] **Step 6: gate and commit.**

```
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add .changeset package.json pnpm-lock.yaml .github/workflows/release-agent.yml
git commit -m "ci: changesets release pipeline for the shellbell agent"
```

---

## Task 8 `[AGENT]`: Documentation, legal, protocol doc, release checklist (spec §16)

**Files:** Replace `README.md`; create `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`docs/protocol.md`, `docs/e2e-ring.md` (template), `docs/feedback-0.1.md` (template),
`docs/before-first-release.md`; create `packages/protocol/scripts/gen-protocol-doc.ts`; modify
`packages/protocol/package.json`, `docs/self-hosting.md`.

- [ ] **Step 1: `README.md`.** Sections, in order:

1. Name, the line "Your terminal rings. You answer.", and three sentences of what it is.
2. 60-second setup: `npx shellbell` on the Mac → install the app → scan the QR → confirm on the Mac.
3. A `![demo](docs/demo.gif)` reference. **The GIF itself is `[HUMAN]` (Task 13).** Leave the
   reference and add an HTML comment `<!-- TODO(before-first-release): record docs/demo.gif -->`.
4. Supported terminals: iTerm2 natively; Ghostty, Warp, Terminal.app, Alacritty, Kitty and WezTerm
   through tmux; **Herdr** coding-agent panes natively (04b) — link https://herdr.dev.
5. How notifications work and exactly what the relay sees, in three bullets, linking `PRIVACY.md`.
6. Self-hosting → `docs/self-hosting.md`. Protocol → `docs/protocol.md`.
7. Costs: free for users; the author pays Apple ($99/yr), Google ($25 once) and the domain.
8. License (MIT, `LICENSE`), trademark (`TRADEMARK.md`), and the Buy Me a Coffee badge pointing at
   `https://buymeacoffee.com/bilaldev` (the URL already in `.github/FUNDING.yml`).

- [ ] **Step 2: `PRIVACY.md`.** Make this the single source of truth and have `docs/self-hosting.md`
  link to it instead of restating. Contents: the relay stores computer name, paired phone public
  keys and names, Expo push tokens, leases and rate-limit counters (spec §9.2's schema); connection
  metadata logs (fingerprint prefix, timestamps, byte counts) retained 7 days; **no terminal
  content, session titles, commands or input, ever** (§11.1); pushes carry only a computer name, a
  generic body by kind, and `{ computerFp, sessionId, kind }`; deletion by unpairing, plus the
  90-day GC (§9.2). State plainly that everything between phone and Mac is end-to-end encrypted and
  the relay cannot read it (§6.7).

- [ ] **Step 3: `SECURITY.md`.** Reporting address, 90-day coordinated disclosure, in-scope /
  out-of-scope, and a link to the threat model (spec §13). Write the address as the literal
  placeholder `REPLACE_SECURITY_CONTACT` — **choosing it is `[HUMAN]`** and it is listed in the
  Step 7 checklist. Do not invent an email.

- [ ] **Step 4: `CONTRIBUTING.md`.** pnpm 11 / Biome / Vitest workflow; the four package filters;
  how to run the relay locally (`pnpm -F @shellbell/relay dev`) and point an agent at it
  (`shellbell config set relay ws://127.0.0.1:8787`); how to build the app; and how to add a
  backend — implement `TerminalBackend` (`apps/agent/src/backends/types.ts`), register it in
  `apps/agent/src/backends/registry.ts`, add a live test alongside `test/live-tmux.test.ts` /
  `test/live-herdr.test.ts`. Mention that `apps/agent/dist` is bundled and that
  `pnpm -F shellbell check:bundle` gates the publish.

- [ ] **Step 5: `packages/protocol/scripts/gen-protocol-doc.ts`.** Walks
  `CtrlMessageSchema.options` and `InnerMessageSchema.options` (both are `z.discriminatedUnion`, so
  `.options` is an array of object schemas), reads each variant's `type` literal, and writes a
  fenced JSON block per message into `docs/protocol.md`, preceded by the envelope shape, the byte
  limits and the close codes copied from spec §7.1/§7.2 and §12.

  **The protocol schemas embed byte types (`Bytes(32)` etc.), which `z.toJSONSchema` refuses by
  default.** Call it as:

```ts
const json = z.toJSONSchema(variant, { unrepresentable: "any" });
```

  If zod still throws on an input-only refinement, add `io: "input"` to the same options object.
  Add the script to `packages/protocol/package.json`:

```jsonc
    "gen:protocol-doc": "tsx scripts/gen-protocol-doc.ts"
```

  Run `pnpm -F @shellbell/protocol gen:protocol-doc` and commit the generated `docs/protocol.md`.
  Add a header line to the generated file saying it is generated and naming the script.

- [ ] **Step 6: templates that only Bilal fills in.** Create both with blanks, and never fill them:

  `docs/e2e-ring.md` — a table with one row per Task 11 scenario (prompt, idle, blocked, attentive
  suppression) and columns: scenario · date/time (`____-__-__ __:__`) · device + OS (`____`) ·
  seconds from event to notification (`__`) · notification text observed (`____`) · tap landed on
  the right session (`yes/no`) · notes. Plus a header block for agent version, app build number,
  relay URL, and Mac model.

  `docs/feedback-0.1.md` — a header explaining it records M6's two non-author testers, then per
  tester: name/handle · platform · date · "got to a first ring in __ minutes" · what confused them ·
  issues filed.

  Both files must carry the line:
  `> Filled in by hand from a real device. An agent must never populate this file.`

- [ ] **Step 7: `docs/before-first-release.md`** — the `[HUMAN]` placeholder checklist. Generate the
  list from the repo, do not copy this one blindly:

```
grep -rn "REPLACE_AFTER_eas_init\|REPLACE_SECURITY_CONTACT\|REPLACE_APPLE_ID_EMAIL\|REPLACE_ASC_APP_ID\|REPLACE_APPLE_TEAM_ID\|REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH\|before-first-release\|YYYY-MM-DD" \
  --include='*.json' --include='*.jsonc' --include='*.md' --include='*.ts' --include='*.tsx' . \
  | grep -v node_modules
```

  The checklist must have one row per hit, each naming the file, the token, who supplies the value,
  and which task consumes it. At minimum it covers:

  | Placeholder | File | Filled by | Task |
  |---|---|---|---|
  | `REPLACE_AFTER_eas_init` | `apps/mobile/app.json` | `eas init` output | 9 |
  | `REPLACE_SECURITY_CONTACT` | `SECURITY.md` | Bilal's chosen address | 13 |
  | `REPLACE_APPLE_ID_EMAIL` / `REPLACE_ASC_APP_ID` / `REPLACE_APPLE_TEAM_ID` | `apps/mobile/eas.json` | App Store Connect | 13 |
  | `REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH` | `apps/mobile/eas.json` | Play Console service account | 13 |
  | `docs/demo.gif` | `README.md` | screen recording | 13 |
  | every blank in `docs/spike-render.md` | — | on-device render spike (carried from Plan 05) | 12 |
  | every blank in `docs/e2e-ring.md` | — | device ring test | 11 |
  | every blank in `docs/feedback-0.1.md` | — | two testers | 13 |

- [ ] **Step 8: gate and commit.**

```
pnpm -F @shellbell/protocol gen:protocol-doc
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
git add README.md PRIVACY.md SECURITY.md CONTRIBUTING.md docs packages/protocol
git commit -m "docs: README, privacy, security, contributing, generated protocol reference"
```

---

## Task 9 `[HUMAN]`: EAS project, credentials, development builds (spec §16)

Bilal runs every step. Needs: an Expo account (free), an Apple Developer account ($99/yr), a Google
Play Console account ($25 once), a Firebase project (free), and both test devices.
**Prerequisite: Task 3 is committed.**

- [ ] **Step 1: create the EAS project.**

```
cd apps/mobile
npx eas-cli@latest login
npx eas init
```

Expected: `eas init` prints a project id and rewrites `app.json`'s `extra.eas.projectId`. Confirm
`REPLACE_AFTER_eas_init` is gone: `grep -n projectId apps/mobile/app.json`. Commit `app.json`.

- [ ] **Step 2: iOS credentials, including the APNs key** (without it, pushes silently never
  arrive).

```
npx eas credentials -p ios
```

Let EAS create and store the distribution certificate, the provisioning profile, and a **Push Key
(APNs)**. Expected: the summary lists a Push Key with a key id. Nothing is written to the repo.

- [ ] **Step 3: Android credentials (FCM V1).** Create a Firebase project for
  `dev.bilalahmad.shellbell`, download `google-services.json`, and place it at
  `apps/mobile/google-services.json`. It must stay **out of git**:

```
echo "apps/mobile/google-services.json" >> .gitignore
cd apps/mobile
npx eas env:create --scope project --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment production --environment preview --environment development
```

Then add to `app.json`'s `android` block: `"googleServicesFile": "./google-services.json"`, and
upload the FCM V1 service-account key:

```
npx eas credentials -p android
```

Expected: EAS reports an FCM V1 service account is configured. Commit `app.json` and `.gitignore`
only — never `google-services.json`.

- [ ] **Step 4: turn enhanced push security OFF.** expo.dev → the project → Push notifications →
  confirm **Enhanced push security is off** (spec §9.2 — self-hosted relays must be able to push to
  the official app without the author's token). Expected: the toggle reads "off".

- [ ] **Step 5: development builds.**

```
cd apps/mobile
npx eas build -p ios --profile development
npx eas build -p android --profile development
```

Install both on the test devices. Expected: the app launches, Settings → self-test is all ✓, and
Settings → Render spike runs.

- [ ] **Step 6: commit** `app.json` and `.gitignore`.
      `git commit -m "chore(mobile): EAS project id and Android google-services wiring"`

---

## Task 10 `[HUMAN]`: Domain, hosted relay deploy, secrets, WAF (spec §9.3, §9.4)

Bilal runs every step. **Prerequisite: Task 5 is committed.** Wrangler on Bilal's Mac already
resolves the `miambi` profile for this directory (`docs/self-hosting.md` § Multiple Cloudflare
accounts) — confirm with `pnpm -F @shellbell/relay exec wrangler whoami` before deploying, and
check the output says `Active profile: miambi`.

- [ ] **Step 1: buy `shellbell.dev`** (Cloudflare Registrar if available, otherwise any registrar
  with nameservers pointed at Cloudflare) and add the zone to the `miambi` account. Expected: the
  zone shows **Active** in the dashboard.

- [ ] **Step 2: first deploy.**

```
cd apps/relay
pnpm wrangler whoami          # must print: Active profile: miambi
pnpm wrangler deploy --config wrangler.hosted.jsonc
curl -s https://relay.shellbell.dev/healthz
```

Expected: the last command prints `ok`. Also expect `curl -s https://relay.shellbell.dev/` to
return JSON `{"name":"shellbell-relay",...}` (spec §9.1).

- [ ] **Step 3: the Expo access token secret.** expo.dev → Account settings → Access tokens → create
  one, then:

```
cd apps/relay
pnpm wrangler secret put EXPO_ACCESS_TOKEN --config wrangler.hosted.jsonc
```

Paste at the prompt. **Never** echo the token or put it in a file. Expected: "Success! Uploaded
secret EXPO_ACCESS_TOKEN".

- [ ] **Step 4: the rate-limiting rule** (spec §9.1/§9.4). Cloudflare dashboard → the
  `shellbell.dev` zone → Security → WAF → Rate limiting rules → Create:
  name `shellbell-ws`, expression `http.request.uri.path contains "/ws/"`, 30 requests per 1 minute
  per IP, action **Block** for 1 minute. (The free plan allows exactly one rule.) Expected: the rule
  shows as enabled.

- [ ] **Step 5: CI deploy secrets.** GitHub → the repo → Settings → Secrets and variables →
  Actions: add `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the `miambi` account) and
  `CLOUDFLARE_ACCOUNT_ID`. Then tag and push:

```
git tag relay-v0.1.0 && git push origin relay-v0.1.0
```

Expected: the `deploy-relay` workflow runs `wrangler deploy --config wrangler.hosted.jsonc` and goes
green; `curl https://relay.shellbell.dev/healthz` still prints `ok`.

- [ ] **Step 6: confirm the agent default.** `apps/agent/src/config.ts`'s `DEFAULT_RELAY` is already
  `wss://relay.shellbell.dev` — no change. Verify end to end:

```
pnpm -F shellbell build && node apps/agent/dist/cli.js doctor
```

Expected: the `relay` line reads ✓ with detail `wss://relay.shellbell.dev`.

---

## Task 11 `[HUMAN]`: Device end-to-end ring test (spec §17.1 M5, §11.3)

Bilal runs every step, on real hardware. **Prerequisites: Tasks 1, 9 and 10.** Record every outcome
in `docs/e2e-ring.md` (the template from Task 8). **An agent must never fill this in.**

- [ ] **Step 1:** Install iTerm2 shell integration in the test shell (iTerm2 → Install Shell
  Integration) so `command-start`/`command-end` events exist at all (spec §8.8, risk 18.9).
  Verify: `shellbell doctor` and a `shellbell logs` line showing a `command-end` after a command.

- [ ] **Step 2 — prompt ring.** Hosted relay, development build, `shellbell start` on the Mac. Pair,
  open a session, then **background the app**. In iTerm2: `sleep 15; echo done`.
  Expected: within ~2 s of `done`, a push titled with the computer name and body
  `A command finished — exit 0 after 15s`; tapping it opens that session.

- [ ] **Step 3 — idle ring.** In a plain tmux pane with no shell integration, with the app
  backgrounded: `python3 -c "import time; print('working'); time.sleep(3); print('still'); time.sleep(6)"`.
  Expected: a push `A session went quiet — waiting for you?` roughly 4 s after the last output.

- [ ] **Step 4 — blocked ring (04b).** With a Herdr server running and a coding-agent pane that
  stops to ask a question, app backgrounded. Expected: a push `An agent is waiting for you`, and the
  session shows as `blocked` (not `running`) in the app. If no Herdr pane is available, mark this
  row **not run** — do not substitute another scenario.

- [ ] **Step 5 — attentive suppression (§11.3).** Keep the app foregrounded on that session and
  repeat Step 2. Expected: **no push**; an in-app toast (`<title>: command finished`) plus a
  `Warning` haptic instead, and the unread badge increments.

- [ ] **Step 6:** Fill in `docs/e2e-ring.md` with real timestamps, device models, OS versions and
  measured delays. If something failed, fix it and re-run before continuing; the usual culprits are
  a missing APNs key on the EAS project (Task 9 Step 2), `push_enabled = 0` on the relay row, and a
  token that was never registered because permission was granted after connect (Task 1 Step 6
  should have closed that).

- [ ] **Step 7:** Update `apps/mobile/QA.md`: the line "Background the app → relay treats phone as
  away (verify with a ring in Plan 06)" now has an answer — replace the parenthetical with a
  reference to `docs/e2e-ring.md`.

- [ ] **Step 8:** `git add docs/e2e-ring.md apps/mobile/QA.md && git commit -m "docs: M5 end-to-end ring results"`

---

## Task 12 `[HUMAN]`: Visual design and device QA pass (spec §10.9)

Bilal runs every step, on both devices, using the Task 9 development builds. Task 4 already did
everything checkable from source; this is what needs eyes.

- [ ] **Step 1:** Walk every screen on an OLED iPhone and an Android device. Confirm true black,
  the per-computer accent on the card stripe / header dot / cursor / send button / connection
  indicator, `radius.lg` cards with hairline borders, and no shadows.

- [ ] **Step 2:** Session screen: title, accent dot, backend badge (`iTerm2` / `tmux` / `Herdr`,
  tiny and muted), state badge; "Jump to live" pill behaves; the input bar's chips row appears and
  disappears without a layout jump; keyboard avoidance is smooth on both platforms.

- [ ] **Step 3:** Motion: list insertions/removals animate at ~150 ms ease-out and never jitter the
  terminal grid.

- [ ] **Step 4:** Icon and splash on both platforms — the bell + `$` glyph on black, no letterboxing
  on Android adaptive icons. If the art needs changing, replace the files in `apps/mobile/assets/`
  (the `app.json` wiring from Task 3 already points at them).

- [ ] **Step 5:** Accessibility: VoiceOver / TalkBack read every quick key; UI text scales with the
  system setting; the terminal font does not.

- [ ] **Step 6:** Run the full `apps/mobile/QA.md` checklist on both devices with the EAS
  development builds, and fill in `docs/spike-render.md` (still an empty template carried over from
  Plan 05): device/OS, 5 000-line fling fps, 60×160 htop-style redraw ms per frame, CJK/emoji
  alignment.

- [ ] **Step 7:** `git commit -m "docs: render spike measurements and device QA results"` (plus any
  asset changes).

---

## Task 13 `[HUMAN]`: First release — npm, TestFlight, Play internal, listings (spec §16, §17.1 M6)

Bilal runs every step. **Prerequisites: Tasks 1–12.** Work through
`docs/before-first-release.md` first — every placeholder in it must be resolved before anything is
published, because npm versions and store builds cannot be taken back.

- [ ] **Step 1: placeholders.** Fill `REPLACE_SECURITY_CONTACT` in `SECURITY.md`, record
  `docs/demo.gif`, and fill the four `eas.json` submit placeholders from App Store Connect and the
  Play service account. Re-run the Task 8 Step 7 grep; it must return nothing but the checklist
  itself. Commit.

- [ ] **Step 2: the npm token.** npmjs.com → Access Tokens → create a **Granular** token with
  publish rights on `shellbell` → GitHub → repo → Settings → Secrets → Actions → `NPM_TOKEN`.
  Never paste it anywhere else.

- [ ] **Step 3: publish the agent.** Merge the branch to `main`. `release-agent.yml` opens a
  "Version Packages" PR; merge that too. Expected afterwards:

```
npm view shellbell version        # 0.1.0
```

Then, on a machine that has never built this repo:

```
npx shellbell@0.1.0 doctor
```

Expected: the doctor table prints and the `relay` row is ✓. If install fails, do **not** republish —
`0.1.0` is burned; fix and ship `0.1.1`.

- [ ] **Step 4: production builds and submission.**

```
cd apps/mobile
npx eas build -p ios --profile production
npx eas submit -p ios --profile production
npx eas build -p android --profile production
npx eas submit -p android --profile production
```

Expected: a TestFlight build appears in App Store Connect, and an Android bundle lands on the
**internal testing** track. Add at least two TestFlight internal testers who are not the author.

- [ ] **Step 5: store metadata.** App Store Connect and Play Console:

  - Name: **Shellbell**
  - Subtitle (≤ 30 characters): **`Your terminal rings`** (19)
  - Description: the README's first section, lightly reflowed.
  - Keywords: `terminal, iterm2, tmux, ghostty, claude code, agent, developer, notifications`
    — **no `ssh`**; Shellbell has no SSH feature and claiming one is a review and expectation risk.
  - Category: Developer Tools.
  - Privacy: data collected = **push token**, purpose *app functionality*, **not** linked to
    identity, **no** tracking. Play Data safety must mirror this exactly.
  - Screenshots: computers list; a session with a Claude Code prompt; a ring on the lock screen;
    the pairing QR.
  - Support / privacy URLs: the repo's `SECURITY.md` and `PRIVACY.md`.

- [ ] **Step 6: tag and changelog.** `git tag v0.1.0 && git push origin v0.1.0`. Changesets has
  already written `apps/agent/CHANGELOG.md`; add a root `CHANGELOG.md` with an `## App 0.1.0`
  section written by hand (Changesets does not manage the private mobile package).

- [ ] **Step 7: M6 "done when" (spec §17.1).** Two people other than the author pair and use
  Shellbell from the written docs alone. Record their experience in `docs/feedback-0.1.md` and open
  a GitHub issue per problem. **This is the milestone gate — it is not met until two real people
  have done it.**

- [ ] **Step 8:** `git commit -m "docs: 0.1.0 changelog and first-release feedback"`

---

## Plan self-review

- **Spec coverage.** §10.8 (permission timing, token, tap validation, foreground toast, Android
  channel) → Task 1. §11.1/§11.3 (generic bodies, `computerFp` validation, attentive suppression,
  `blocked`) → Tasks 1, 2, 11. §9.2 enhanced-push-security off → Task 9 Step 4. §9.3/§9.4 (hosted
  config, custom domain, `EXPO_ACCESS_TOKEN`, WAF rule) → Tasks 5, 10. §10.9 design system → Tasks
  4, 12. §16 (EAS profiles, Changesets, npm publish, docs, protocol doc) → Tasks 3, 6, 7, 8, 13.
  §17.1 M5 → Tasks 2 (automated) + 11 (device). §17.1 M6 → Task 13. Phone-initiated unpair (§7.3)
  already shipped in Plan 05 — no task.
- **Deliberately deferred to v1.1:** EAS Update / `expo-updates`; iOS notification actions
  (Reply y/n, §10.8); Expo push receipt polling (§9.2); a `ring` category registration.
- **Type consistency.** `pushToken` returns `{ token, platform, enabled }` exactly as
  `ComputerConnection.PushTokenInfo` declares; `onForegroundEvent` is a new *optional* `ManagerDeps`
  field so no existing caller breaks; `showForegroundEvent` writes the `toast` field the shipped
  `Toast`/`ToastHost` render; the notifications module never imports `expo-router` and `manager.ts`
  never imports the notifications module.
- **Placeholders.** Six live placeholder tokens ship deliberately (`REPLACE_AFTER_eas_init`,
  `REPLACE_SECURITY_CONTACT`, three `eas.json` Apple values, one Play value) plus four blank
  templates (`docs/e2e-ring.md`, `docs/feedback-0.1.md`, `docs/spike-render.md`, `docs/demo.gif`).
  All are enumerated in `docs/before-first-release.md` (Task 8 Step 7) and all are resolved by a
  `[HUMAN]` task before anything is published.
