# Shellbell Plan 06 — Rings, hosted infrastructure, polish, release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push notifications ring the phone when a command finishes or a program goes quiet, tapping one lands on the right session; the hosted relay runs at `relay.shellbell.app`; the app ships to TestFlight and Google Play internal testing; the agent is on npm; docs let a stranger set it up.

**Architecture:** No new components. This plan wires `expo-notifications` into the app (token → `push-token`, tap → validated route), deploys the relay and agent for real, runs the end-to-end ring test, does the design polish pass, and sets up release automation.

**Tech Stack:** expo-notifications, EAS Build/Submit/Update, Cloudflare Workers, Changesets, npm.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 10.8, 11, 16, 17 (M5, M6), 9.3/9.4 (hosted config). Plans 01–05 complete.

## Global Constraints

- Accounts needed before starting: Cloudflare (free), Expo (free), Apple Developer ($99/yr), Google Play Console ($25), npm (free), domain registrar for `shellbell.app` (~$14/yr). Nothing in this plan can be finished without them; Tasks 1 and 5 can be done first.
- Notification payloads carry only `{ computerFp, sessionId, kind }` and generic text (spec 11.1). The app **validates** `computerFp` against its paired list before navigating.
- The official Expo project keeps "enhanced push security" **off** (spec 9.2).
- Store listings say: no accounts, end-to-end encrypted, the relay stores only pairing metadata and push tokens.

---

### Task 1: Notifications in the app (spec 10.8, 11)

**Files:**
- Create: `apps/mobile/src/notifications/index.ts`
- Modify: `apps/mobile/app/_layout.tsx` (provider, handlers, deep-link), `apps/mobile/src/net/manager.ts` (`pushToken` provider), `apps/mobile/src/net/connection.ts` (add `unpairSelf()`), `apps/mobile/app/c/[fp]/settings.tsx` (use `unpairSelf`), `apps/mobile/app/pair.tsx` (ask permission after first pairing)

**Interfaces:**
- `notifications/index.ts`: `ensureChannel(): Promise<void>` (Android `rings` channel, importance MAX, vibration), `requestPermissionOnce(): Promise<boolean>`, `getPushToken(): Promise<{ token: string; platform: "ios" | "android" } | null>` (uses `Constants.expoConfig?.extra?.eas?.projectId`; returns null without permission), `installTapHandler(router)`, `showForegroundEvent(computerName, sessionTitle, kind)` (toast + `Haptics.notificationAsync(Warning)`).
- `ComputerConnection.unpairSelf(): void` — sends ctrl `unpair { phoneFp }` then `close("user")`.

- [ ] **Step 1: Implement `notifications/index.ts`**

```ts
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import type { Router } from "expo-router";
import { Platform } from "react-native";
import { useComputersStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { sidToRoute } from "../util/routes";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("rings", { name: "Rings", importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 250, 100, 250], lightColor: "#10B981" });
}

export async function requestPermissionOnce(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  const res = await Notifications.requestPermissionsAsync();
  return res.granted;
}

export async function getPushToken(): Promise<{ token: string; platform: "ios" | "android" } | null> {
  const perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: t.data, platform: Platform.OS === "ios" ? "ios" : "android" };
  } catch {
    return null;
  }
}

/** Routes a tapped notification: validate the computer, open it, then the session once it is known to exist. */
export function installTapHandler(router: Router): () => void {
  const handle = (data: Record<string, unknown> | undefined) => {
    const fp = typeof data?.computerFp === "string" ? data.computerFp : null;
    const sid = typeof data?.sessionId === "string" ? data.sessionId : null;
    if (!fp || !useComputersStore.getState().computers.some((c) => c.fp === fp)) return;
    router.push(`/c/${fp}`);
    if (!sid) return;
    const tryOpen = (attempt: number) => {
      const conn = useConnectionsStore.getState().byComputer[fp];
      if (conn?.sessions.some((s) => s.id === sid)) router.push(`/c/${fp}/s/${sidToRoute(sid)}`);
      else if (attempt < 20) setTimeout(() => tryOpen(attempt + 1), 500);
    };
    tryOpen(0);
  };
  const sub = Notifications.addNotificationResponseReceivedListener((r) => handle(r.notification.request.content.data as Record<string, unknown>));
  void Notifications.getLastNotificationResponseAsync().then((r) => r && handle(r.notification.request.content.data as Record<string, unknown>));
  return () => sub.remove();
}

export function showForegroundEvent(fp: string, sessionTitle: string, kind: string): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  useConnectionsStore.getState().patch(fp, () => ({ toast: `${sessionTitle}: ${kind === "prompt" ? "command finished" : kind === "idle" ? "went quiet — waiting?" : "session ended"}` }));
}
```

- [ ] **Step 2: Wire it**

- `app/_layout.tsx`: `await ensureChannel()` at startup; `installTapHandler(router)` in an effect; pass `pushToken: async (fp) => { const t = await getPushToken(); const c = useComputersStore.getState().computers.find((x) => x.fp === fp); return t && c ? { ...t, enabled: c.pushEnabled } : null; }` to `connectionManager.start`.
- `manager.ts` `onInner` case `"event"`: also call `showForegroundEvent(fp, sessionTitle, m.kind)` where `sessionTitle` is looked up from `c.sessions` (fallback "Session").
- `pair.tsx`: after the first successful pairing (`computers.length === 0` before adding), call `requestPermissionOnce()` and, if granted, nothing else — the next `auth-ok` sends the token. Show a one-line explanation above the system dialog: "Shellbell rings you when a command finishes or a program is waiting."
- `connection.ts`: add
  ```ts
  unpairSelf(): void {
    this.sendCtrl({ type: "unpair", phoneFp: this.o.phoneFp });
    this.close("user");
  }
  ```
  and use it from `c/[fp]/settings.tsx` before deleting the secret and removing the computer.
- Computer settings "Notifications" switch: on change, `update(fp, { pushEnabled })` and, if the connection is online, re-send `push-token` with the new `enabled` (add `ComputerConnection.resendPushToken()` that calls the `pushToken` provider and sends the ctrl).

- [ ] **Step 3: Commit** — `git add apps/mobile && git commit -m "feat(mobile): push token registration, notification tap routing, foreground events, self-unpair"`.

---

### Task 2: EAS project, builds, push credentials (spec 16)

- [ ] **Step 1:** `cd apps/mobile && npx eas-cli@latest login && npx eas init` → copies the project id into `app.json` `extra.eas.projectId` (replace `REPLACE_AFTER_eas_init`). Commit.
- [ ] **Step 2:** iOS credentials: `npx eas credentials -p ios` → let EAS create the distribution certificate, provisioning profile, and an **APNs key** (required for push). Android: create a Firebase project, download `google-services.json` into `apps/mobile/` (add to `.gitignore`; upload the FCM V1 service account key via `npx eas credentials -p android`). Add `"googleServicesFile": "./google-services.json"` under `android` in `app.json`.
- [ ] **Step 3:** In expo.dev → project → Push notifications, confirm "Enhanced push security" is **off** (spec 9.2).
- [ ] **Step 4:** `npx eas build -p ios --profile development` and `-p android --profile development`; install on the test devices; run the QA checklist from Plan 05 with these builds (the render spike and self-test must pass on the EAS build too).
- [ ] **Step 5:** Commit `app.json`, `eas.json`, `.gitignore`.

---

### Task 3: Hosted relay and agent defaults (spec 9.3, 9.4, 16)

- [ ] **Step 1:** Buy `shellbell.app` (Cloudflare Registrar if available, else any registrar; point DNS to Cloudflare). Add the zone to the Cloudflare account.
- [ ] **Step 2:** In `apps/relay/wrangler.jsonc` add `"routes": [{ "pattern": "relay.shellbell.app", "custom_domain": true }]`. `pnpm wrangler login && pnpm wrangler deploy`. Verify `curl https://relay.shellbell.app/healthz` → `ok`.
- [ ] **Step 3:** Create an Expo access token (expo.dev → Account settings → Access tokens) and `pnpm wrangler secret put EXPO_ACCESS_TOKEN`.
- [ ] **Step 4:** Cloudflare dashboard → the zone → Security → WAF → Rate limiting rules: "shellbell-ws", expression `http.request.uri.path contains "/ws/"`, 30 requests per 1 minute per IP, action Block for 1 minute. (Free plan allows one rule.)
- [ ] **Step 5:** GitHub repository secrets `CLOUDFLARE_API_TOKEN` (Workers deploy permission) and `CLOUDFLARE_ACCOUNT_ID`; push tag `relay-v0.1.0` and confirm `deploy-relay.yml` deploys.
- [ ] **Step 6:** Confirm `DEFAULT_RELAY` in `apps/agent/src/config.ts` is `wss://relay.shellbell.app`. Run `shellbell doctor` → relay ✓.
- [ ] **Step 7:** Commit.

---

### Task 4: End-to-end ring test (spec 17.1 M5)

**Files:**
- Create: `docs/e2e-ring.md`

- [ ] **Step 1:** Install iTerm2 shell integration in the test shell (iTerm2 → Install Shell Integration) so `command-end` events exist.
- [ ] **Step 2:** With the hosted relay, a development build, and `shellbell start` on the Mac: pair, open a session, background the app. In iTerm2 run `sleep 15; echo done`. Expected: within ~2 s of `done`, a push "A command finished — exit 0 after 15s" from "Bilal's MBP"; tapping it opens that session.
- [ ] **Step 3:** Idle path: in a plain (no shell integration) tmux pane run `python3 -c "import time; print('working'); time.sleep(3); print('still'); time.sleep(6)"` with the app backgrounded. Expected: an idle ring ~4 s after the last output.
- [ ] **Step 4:** Attentive suppression: keep the app foregrounded on that session and repeat step 2. Expected: no push; an in-app toast + haptic instead.
- [ ] **Step 5:** Record all four outcomes with timestamps and device models in `docs/e2e-ring.md`. Fix whatever failed before proceeding (typical culprits: token not sent because permission was granted after connect → `resendPushToken`; APNs key missing on the EAS project; `push_enabled` 0).
- [ ] **Step 6:** Commit.

---

### Task 5: Design polish pass (spec 10.9)

Use the `frontend-design` skill for this task (the only task in these plans that invokes it). Scope is polish within the fixed tokens and structure — no new screens, no architecture changes.

- [ ] **Step 1:** Audit every screen against spec 10.9: OLED black, accent-per-computer applied to card stripe, header dot, cursor, send button, connection indicator; `radius.lg` cards with 1-px borders; no shadows; Reanimated layout transitions on list changes (150 ms ease-out); empty states are one sentence with one action.
- [ ] **Step 2:** Session screen: header shows title, accent dot, backend badge (`iTerm2`/`tmux`, tiny, muted), state badge; "Jump to live" pill; the input bar hides its chips row when not applicable without layout jump; keyboard avoidance is smooth on both platforms.
- [ ] **Step 3:** Haptics: `Light` on send, `Success` on pair, `Warning` on ring; nothing else buzzes.
- [ ] **Step 4:** App icon and splash: bell + `$` glyph on black; export 1024×1024 icon, adaptive icon layers for Android; splash background `#000000`.
- [ ] **Step 5:** Accessibility: every quick key has `accessibilityLabel`; UI text scales with system settings; terminal font does not.
- [ ] **Step 6:** Commit — `git commit -m "style(mobile): design pass — accents, motion, empty states, icon"`.

---

### Task 6: Documentation and legal (spec 16)

**Files:**
- Create/replace: `README.md` (root), `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/protocol.md`, `packages/protocol/scripts/gen-protocol-doc.ts`

- [ ] **Step 1:** `README.md`: what it is (three sentences), 60-second setup (`npx shellbell` → scan → confirm), a GIF of the flow, supported terminals (iTerm2 native; Ghostty/Warp/Terminal.app/Alacritty/Kitty/WezTerm via tmux), how notifications work and what the relay sees, self-hosting link, costs (free; author pays Apple), license + trademark, Buy Me a Coffee badge.
- [ ] **Step 2:** `PRIVACY.md`: the relay stores computer name, paired phone public keys and names, Expo push tokens, leases, rate-limit counters; connection metadata logs (fp prefix, timestamps, byte counts) retained 7 days; no terminal content ever; how to delete (unpair; 90-day GC). `SECURITY.md`: report to a security email address; 90-day disclosure; threat model link (spec §13).
- [ ] **Step 3:** `CONTRIBUTING.md`: pnpm/biome/vitest workflow, how to run the relay locally, how to run the agent against it, how to build the app, how to add a backend (implement `TerminalBackend`, register in the CLI, add a live test).
- [ ] **Step 4:** `gen-protocol-doc.ts`: walks `CtrlMessageSchema.options` and `InnerMessageSchema.options`, prints each `type` literal with its zod shape (`z.toJSONSchema` in zod 4) as fenced JSON into `docs/protocol.md` with the envelope, byte limits and close codes copied from the spec. Add `"gen:protocol-doc"` script and run it.
- [ ] **Step 5:** Commit.

---

### Task 7: Release automation and first release (spec 16, 17.1 M6)

- [ ] **Step 1:** Changesets: `pnpm add -Dw @changesets/cli@3.0.1 && pnpm changeset init`; configure `.changeset/config.json` with `"ignore": ["@shellbell/relay", "shellbell-mobile"]` so only `shellbell` (agent) and `@shellbell/protocol` version; `@shellbell/protocol` is `private: true` in `package.json` (bundled, never published). Add `.github/workflows/release-agent.yml`:
  ```yaml
  name: release-agent
  on:
    push:
      branches: [main]
  jobs:
    release:
      runs-on: macos-15
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
          with: { version: 11.12.0 }
        - uses: actions/setup-node@v4
          with: { node-version: 22, cache: pnpm, registry-url: https://registry.npmjs.org }
        - run: pnpm install --frozen-lockfile
        - run: pnpm -F shellbell build
        - uses: changesets/action@v1
          with:
            publish: pnpm -F shellbell exec npm publish --access public
          env:
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```
  Add a changeset `feat: initial release` bumping `shellbell` to `0.1.0`; merge; confirm `npm view shellbell version` → `0.1.0`; `npx shellbell@0.1.0 doctor` works on a clean machine.
- [ ] **Step 2:** App version `0.1.0` (build numbers managed by EAS `autoIncrement`): `npx eas build -p ios --profile production` and `npx eas submit -p ios`; TestFlight internal group with at least two testers who are not the author. Android: `npx eas build -p android --profile production` → `npx eas submit -p android` to the internal testing track.
- [ ] **Step 3:** Store metadata (App Store Connect / Play Console): name "Shellbell"; subtitle "Your terminal rings. You answer."; description from the README's first section; keywords `terminal, iterm2, tmux, ssh, remote, developer, notifications`; category Developer Tools; privacy: data collected = push token (app functionality), not linked to identity; no tracking. Play data safety mirrors it. Screenshots: computers list, session with a Claude Code prompt, notification on the lock screen, pairing QR.
- [ ] **Step 4:** EAS Update channel `production` for JS-only fixes: `npx eas update --branch production --message "…"`.
- [ ] **Step 5:** Tag `v0.1.0` in git; write `CHANGELOG.md` (Changesets generates it for the agent; add an app section by hand).
- [ ] **Step 6:** "Done when" check from spec 17.1 M6: two people other than the author pair and use it from the README alone. Record their feedback in `docs/feedback-0.1.md` and open issues.

---

## Plan self-review

- **Spec coverage:** 10.8 permission timing, token, tap validation, foreground toast → Task 1; 9.2/9.3/9.4 hosted config, secret, WAF rule, custom domain → Task 3; 16 EAS, changesets, npm publish, docs → Tasks 2, 6, 7; 17.1 M5 ring test → Task 4; M6 polish and stranger test → Tasks 5, 7; 11.3 attentive suppression verified → Task 4 step 4; phone-initiated unpair (7.3) → Task 1.
- **Type consistency:** `pushToken` provider returns `{ token, platform, enabled }` as `ComputerConnection` expects (Plan 05 Task 4); `showForegroundEvent` patches the `toast` field that Plan 05's session screen already renders; `unpairSelf` sends the `unpair` ctrl the relay accepts from phones (Plan 02 Task 4).
- **Placeholders:** none in code. Account-dependent values (project id, domain, secrets) are created by the steps themselves.
