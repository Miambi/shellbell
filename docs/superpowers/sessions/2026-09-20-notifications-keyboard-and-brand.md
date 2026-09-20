# Session record — 2026-09-20: notifications, keyboard, brand, and a concurrent rebuild

Written as a handoff. Tool-neutral: this should be equally usable from Codex or Claude Code.
`docs/before-first-release.md` remains the live checklist; this is the narrative and the state of
play.

**Repo state at the time of writing:** `main` at `0d45724`, pushed, CI green, 838 tests passing
across the workspace (mobile 294, agent 342 + 4 skipped, protocol 162, relay 40).

## 1. The single most important thing

**Almost everything shipped today is unverified on hardware.** Three separate pieces of work were
built, reviewed and pushed without ever running on a phone:

| Work | Unverified claim |
|---|---|
| Notification identity | That the background task runs at all; that notifications name the session; that tap-to-open works; that one ring produces one buzz on the `rings` channel |
| Android grouping | Whether One UI auto-bundles per-session notifications acceptably — this is the **trigger condition** for deciding about native grouping (brand-new spec §3 errata) |
| Keyboard occlusion | Whether the terminal actually clears the keyboard. **This is the second attempt**; the first was asserted as fixed and was not |
| Line-mode dictation | Whether Gboard's mic actually appears |

The last APK built from `0d45724`:
`https://expo.dev/artifacts/eas/7gTUGYOsWcTT-4PvMrpz-gKWQg4xpR_C0q1Jga5_kao.apk`

**Do not mark any of these done from a green test run.** That mistake was made once today already.

## 2. Notifications — what was wrong and what shipped

Reported as *"spammed with nonsense / the same notification."* Two distinct causes, found by
reading code:

- **Indistinguishable**: the ring rate limit is **per session** (`RING_LIMIT_MS` in
  `apps/relay/src/computer-do.ts`), so N sessions means N rings — and every one showed the computer
  name as title plus a fixed body per event kind. Nothing named the session.
- **Too frequent**: `idleQuietMs` defaults to **4 s** (`apps/agent/src/config.ts`), so a plain
  shell rings after four seconds of quiet. **Still unfixed** — it is a one-line tuning change,
  recommended 30 s, deliberately kept separate (spec §7).

Shipped: per-session replacement keyed `${fp}:${sessionId}`, named from a locally persisted title
map, enriched by a background task that replaces the relay's generic notification. The relay still
sends a normal push, so if the task never runs the user gets today's generic notification rather
than silence.

**Explicit non-goal:** native Android grouping. `expo-notifications` exposes no group key or
summary (verified against installed types); reaching `setGroup()` needs a config plugin. Android's
own auto-bundling is expected to cover it. Evidence first.

## 3. Three Criticals, all in one file

Every Critical in the notification work lived in `apps/mobile/src/notifications/index.ts` — the one
file tests cannot import, because it pulls Expo in at module scope.

1. **Payload extraction read the wrong field.** Expo delivers the push body as
   `content.dataString` (a JSON string), not `content.data`; the `dataString → data` mapping is
   wired into the emitter/handler paths but **not** the `expo-task-manager` background path. The
   feature would have been **silently inert in production** with every test green.
2. **The enriched notification carried no `data`**, so tapping it resolved to `null` — and the
   generic notification that *did* carry the data was dismissed. Tap-to-open destroyed.
3. **`trigger: null` posted on Expo's fallback channel**, not `rings`: lost light colour and
   vibration pattern, a second channel in system settings, muting "Rings" stopped working, and
   every ring buzzed **twice**. A fix for notification spam that doubled the buzzing.

Each fix moved logic **out** of `index.ts` and into pure, tested modules — `extractRingPayload`,
then `selectRingInput`, then the trigger construction. That is the durable outcome: the file where
bugs become invisible got smaller three times.

**The lesson worth carrying:** the repo separates pure node-testable logic (`routing.ts`,
`content.ts`, `ring.ts`, `sessionTitles.ts`) from Expo plumbing (`index.ts`). `index.ts` line 73
has said so all along. Treat that boundary as the architecture, not as a style preference — three
rulings this session existed only because a plan ignored it.

## 4. Brand — and a concurrent rebuild in the working tree

A complete brand system was specced, built and pushed today: the `$\a` mark (from BEL, the
terminal's own attention character), the `shellbell` two-tone wordmark, four variants in two
colourways, the six app icon assets, generators, a CI drift guard (`brand:check`), and tests.

**As of the end of this session, Codex is rebuilding it.** The working tree carries ~45 modified
files plus a large set of new ones, uncommitted:

- A different naming convention — `-black`/`-white` instead of `-on-dark`/`-on-light`
- Much broader platform coverage — `brand/{android,ios,macos,windows,linux,web,tray,icons}/`,
  `apple-layers/`, `asset-manifest.json`, `index.html`, `preview.png`, `reference/`
- New generators — `scripts/brand-art.mjs`, `render-platform-icons.mjs`,
  `render-brand-preview.mjs`
- The brand spec, plan, README, and every brand test modified to match

**Anyone continuing this work should treat the committed brand assets as superseded by whatever
Codex lands.** Do not "fix" the working tree to match what is committed. In particular, the
old-named files (`*-on-dark`, `*-on-light`) and the tests referencing them are mid-migration.

The reasoning behind the *design* — why `$\a` and not a drawn bell, why amber not emerald, why
top-left anchoring, why depth belongs to the tile — is in
`docs/superpowers/specs/2026-09-19-shellbell-brand-design.md` and should survive any re-rendering.
The exploration images that argued those points were committed and then deliberately removed;
they remain retrievable at `e6406ab`.

## 5. Also done today

- **Apple fully provisioned.** Team ID `2CW9DK45CV`, App ID with Push Notifications as its only
  capability, APNs key via EAS, App Store Connect record `6813929475` ("Shellbell Terminal").
- **Task 10 closed.** The `/ws/*` rate-limiting rule exists as `shellbell-ws`: 5 requests / 10 s
  per IP, block 10 s — the free plan cannot express the spec's original 30/min.
- **`nodeLinker` was silently inert.** `.npmrc`'s `node-linker=hoisted` stopped being read when
  pnpm moved its config to `pnpm-workspace.yaml`. React Native needs that hoisting; the app was
  very likely never bundleable for release. Fixed, and `.npmrc` now says plainly that it does
  nothing.
- **EAS ships its own pnpm** (11.9.0) and ignores `packageManager`. `corepack: true` in a `base`
  profile fixes it. Neither local tests nor CI can catch this class — both run the pinned version.

## 6. Open, and who owns it

| Item | State |
|---|---|
| Install the APK and verify §1 | **Bilal.** Nothing else matters until this happens |
| `idleQuietMs` 4 s → 30 s | Decided in principle, not done. One line |
| SHA-1 for the Firebase API key restriction | Waiting on Play Console → App integrity since 2026-09-19 |
| Splash mark sits ~12 dp left / ~37 dp high | Top-left anchoring needs a visible tile; a splash has none. May be moot after Codex's rebuild |
| Brand-family generators at repo root duplicate two deps | Deferred; may be moot after Codex's rebuild |
| Native Android notification grouping | Blocked on evidence that auto-bundling is insufficient |
| Multi-line input / bracketed paste | Deferred. Dictation makes it more valuable: spoken prose contains line breaks, and a multi-line body submits at the first one inside an agent TUI |
| PR #9 "Version Packages" | Still open, still must not be merged |
