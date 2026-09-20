# Before the first release

Everything below must be resolved before Task 13 publishes anything — npm versions and store
builds cannot be taken back. Re-run this grep (Task 8 Step 7's search, copied verbatim); once
every row below is resolved it should return only **this file** and
**`docs/superpowers/plans/2026-09-03-shellbell-06-rings-release.md`** — the plan quotes the
`eas.json` template and its own copy of this table, both historical record rather than live
placeholders. Any hit in a `.json`/`.jsonc` outside those two is a real one:

```
grep -rn "REPLACE_SECURITY_CONTACT\|REPLACE_APPLE_ID_EMAIL\|REPLACE_ASC_APP_ID\|REPLACE_APPLE_TEAM_ID\|REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH\|before-first-release\|YYYY-MM-DD" \
  --include='*.json' --include='*.jsonc' --include='*.md' --include='*.ts' --include='*.tsx' . \
  | grep -v node_modules
```

## Placeholders

| Placeholder | File | Filled by | Task |
|---|---|---|---|
| ~~`REPLACE_AFTER_eas_init`~~ | `apps/mobile/app.json` | **done 2026-09-06** — `eas init` linked project `4a002a82-…` (`@miambi/shellbell`) | 9 |
| ~~`REPLACE_SECURITY_CONTACT`~~ | `SECURITY.md` | **done 2026-09-14** — `security@shellbell.dev`, a Cloudflare Email Routing catch-all on `shellbell.dev` forwarding to `bilal@miambi.ai`; delivery tested end to end, not just configured | 13 |
| ~~`REPLACE_APPLE_ID_EMAIL`~~ / ~~`REPLACE_ASC_APP_ID`~~ / ~~`REPLACE_APPLE_TEAM_ID`~~ | `apps/mobile/eas.json` | **done 2026-09-19** — `bilal@miambi.ai`, Team ID `2CW9DK45CV`, `ascAppId` `6813929475` (listing "Shellbell Terminal", SKU `dev.bilalahmad.shellbell`) | 13 |
| ~~`REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH`~~ | `apps/mobile/eas.json` | **done 2026-09-14** — points at `./play-service-account.json`, gitignored. The key itself is not generated yet; only needed when `eas submit` automates the Android upload, not for a hand-uploaded first build | 13 |
| `docs/demo.gif` | `README.md` | screen recording | 13 |
| ~~**App icon and splash are untouched Expo template placeholders**~~ | `apps/mobile/assets/` (`icon.png`, `splash-icon.png`, the three `android-icon-*`, `favicon.png`) | **done 2026-09-20** — all six PNGs rendered from the SVG sources per `docs/superpowers/specs/2026-09-19-shellbell-brand-design.md` (`4f19421` render, `a9e7f01` fixed the Android adaptive-icon layering); regression tests in `apps/mobile/test/brand-assets.test.ts` guard against a template or a broken Android adaptive-icon layer (transparent foreground/monochrome, opaque gradient background) returning. Added 2026-09-19 | 13 |
| every blank (`__`) | `docs/spike-render.md` | on-device render spike (carried from Plan 05) | 12 |
| every blank (`____-__-__ __:__` / `__`) | `docs/e2e-ring.md` | device ring test | 11 |
| every blank (`__`) | `docs/feedback-0.1.md` | two testers | 13 |

## Decisions (2026-09-06)

- **Store accounts: Miambi** (registered entity). Apple Developer Program as an *Organization*
  membership and a Google Play *organization* account, both under `bilal@miambi.ai`; both need
  Miambi's D-U-N-S number. Seller name shown in the stores: Miambi.
- **Status:** Apple Developer Program organization enrollment submitted 2026-09-06; Apple asked for
  further information, which Bilal supplied; verification cleared and the Organization membership
  was **set up 2026-09-19**, the $99 fee paid and posted the same day. **Team ID `2CW9DK45CV`**,
  Apple ID `bilal@miambi.ai`; both are now in `apps/mobile/eas.json`. The App ID for
  `dev.bilalahmad.shellbell` was registered with **Push Notifications** as its only capability
  (nothing else the app does needs one — the camera is an Info.plist usage string, `expo-secure-store`
  uses the App ID's default keychain group, and spec §11.3 rules out background modes) and **no
  account-level capability requests**. Still open on iOS: `eas credentials -p ios` for the APNs key,
  and the App Store Connect app record that yields `ascAppId`.
  **Google Play:** the Miambi organization account
  (Account ID `9220450949259514576`) is live and the `shellbell` app record already exists as a
  **Draft** for `dev.bilalahmad.shellbell`, created 2026-09-07.
  **API access is not available on this account** (as of 2026-09-15), so the Play service-account
  key cannot be created yet. Established by elimination, after two wrong guesses recorded here
  first — it is *not* that the app record is missing (it exists), and *not* that the page moved to
  another menu. The nav has no "Setup" section, "Developer account" holds only About you / Contact
  details, and the deep link
  `play.google.com/console/u/0/developers/9220450949259514576/api-access` **redirects to
  `app-list`**. A redirect rather than a 404 means the route exists but the account is not
  provisioned for it.
  **Android developer verification is complete and is not the gate** (checked 2026-09-15):
  `dev.bilalahmad.shellbell` is Registered with 3 signing-key fingerprints all Verified since
  2026-09-07, which also satisfies Google's 30 September 2026 deadline for removing unregistered
  apps from Play. Four hypotheses have now been eliminated — missing app record, relocated menu,
  permissions (Bilal is Account Owner), developer verification. **The cause is unknown; take it to
  Play Console support rather than guessing again.** It is not worth chasing before release #2.
  (Aside: those fingerprints are SHA-256. The separate Firebase API-key restriction follow-up needs
  the SHA-1, which is under Play Console → App integrity, not here.)
  None of this blocks anything today: Google requires the first AAB of a new app to be uploaded
  through the Console by hand, so the Play service-account key only matters from the second release
  onward.
- **Bundle id / package stays `dev.bilalahmad.shellbell`** (Bilal's call; permanent once shipped).
- **Public support contact is `support@shellbell.dev`** (2026-09-19) — used for the Play listing's
  required support email, the App Store listing, and `PRIVACY.md`. It needs no setup: the
  `shellbell.dev` Email Routing catch-all already forwards every address to `bilal@miambi.ai`, and
  Bilal will re-point it when he wants to. Chosen over a personal address (`self@bilalahmad.dev`)
  so that the public contact matches `SECURITY.md`'s `security@shellbell.dev` — for an
  end-to-end-encrypted app, a single project-owned domain is part of what users verify, and a
  store listing outlives any one person's mailbox.
  **The App Review Information contact is separate and private** (only Apple's reviewer sees it);
  use whichever address Bilal reads fastest, since an unread rejection is expensive.
- **App Store listing name is `Shellbell Terminal`** (2026-09-19). Plain "Shellbell" is rejected as
  taken — [Shell Bell](https://apps.apple.com/us/app/shell-bell/id6754162416), an unrelated egg-timer
  app; Apple's uniqueness check folds the space. This is the *listing* name only: `app.json`'s
  `"name": "Shellbell"` becomes `CFBundleDisplayName`, so the home-screen name is still **Shellbell**
  and `app.json` needs no change. "Terminal" also adds a search keyword the invented word lacks.
  Apple's trademark-claim route was considered and **rejected** — `TRADEMARK.md` asserts only
  common-law rights, the other app is live rather than a dormant name reservation, and a claim would
  take weeks to probably fail while blocking 0.1.0. Do not re-raise.
  ASC record created 2026-09-19 with SKU `dev.bilalahmad.shellbell` (private, account-scoped).
- **Expo:** project `@miambi/shellbell` (`4a002a82-…`) under the `miambi` organization; `owner:
  "miambi"` in `apps/mobile/app.json`. (A first project under the personal account was deleted.)
- **Builds:** EAS project is required for Expo push; EAS Build/Submit are optional (`eas build
  --local` works). EAS Update is not used (`expo-updates` is not installed).

## `[HUMAN]` tasks (plan Tasks 9–13)

Summarized here; the plan (`docs/superpowers/plans/2026-09-03-shellbell-06-rings-release.md`) has
the exact steps. An agent must never run, simulate, or report the outcome of any of these.

- **Task 9 — EAS project, credentials, development builds.** `eas init` (**done**); iOS distribution cert + provisioning profile + APNs push key;
  Android Firebase project `shellbell-1c407` and `apps/mobile/google-services.json` (**done 2026-09-06**, committed — it is client config that ships inside the APK; restrict its API key to the Android app in Google Cloud) and the FCM V1 service-account key (never committed; uploaded to EAS via `eas credentials` on 2026-09-06 — **Android push credentials done**; the Google Cloud org policy `iam.disableServiceAccountKeyCreation` had to be overridden for project `shellbell-1c407` to create the key);
  confirm "enhanced push security" is off; build and install development builds on both test
  devices.
- **Task 10 — Domain, hosted relay deploy, secrets, WAF.** Domain and first deploy **done
  2026-09-14**: `shellbell.dev` bought on the `miambi` Cloudflare account (`shellbell.app` was the
  planned domain but was priced well above budget); code, config and docs now say
  `relay.shellbell.dev`. `wrangler deploy --config wrangler.hosted.jsonc` ran (version
  `2cf0919f-…`), the `relay.shellbell.dev` custom domain is bound and enabled, and
  `https://relay.shellbell.dev/healthz` returns `ok`. Secrets are all in place:
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `NPM_TOKEN` as Actions secrets, and
  `EXPO_ACCESS_TOKEN` as a Worker secret (optional in practice — `push.ts` only sends the
  `Authorization` header when it is set, and enhanced push security is off).
  Tagged `relay-v0.1.0`; `deploy-relay.yml` redeployed from CI (version `6783d329-…`) and
  re-asserted the custom domain, so the release path is proven end to end.
  **Task 10 is complete as of 2026-09-19.** The last item, the Cloudflare rate-limiting rule on
  `/ws/*`, was created in the dashboard (the local wrangler OAuth token is `zone (read)` only and
  cannot write rulesets). It is `shellbell-ws`: URI Path *starts with* `/ws/`, **5 requests / 10 s
  per IP, block for 10 s** — not the 30/min the spec first called for, because a 1-minute period is
  Pro and above; see the spec §9.1 errata. Same sustained rate, stricter on bursts.
- **Task 11 — Device end-to-end ring test.** On real hardware, with Tasks 1/9/10 done: prompt,
  idle, blocked and attentive-suppression scenarios, recorded in `docs/e2e-ring.md`; update
  `apps/mobile/QA.md`'s ring line to point at it.
- **Task 12 — Visual design and device QA pass.** Walk every screen on an OLED iPhone and an
  Android device (accent colors, motion, icon/splash, accessibility); run the full
  `apps/mobile/QA.md` checklist on both; fill in `docs/spike-render.md`.
  **Constraint (2026-09-19): there is no iPhone.** The registered Apple device is an **iPad**
  (`00008103-001A09103EA3001E`), and iPhone coverage is planned on the simulator. Two consequences,
  neither yet resolved:
  - Task 12's OLED pass cannot be done as written. An iPad is not OLED, so true-black backgrounds
    and accent behaviour on an OLED panel go unverified until hardware is borrowed.
  - Task 11's iOS half may not be possible on a simulator at all: Expo push tokens have
    historically required a physical device (`Device.isDevice`). **Verify before relying on it.**
    The Android device covers the ring test end to end, so this is not blocking.
- **Task 13 — First release.** Resolve every placeholder above and re-run the grep; create the
  `NPM_TOKEN` secret and publish `shellbell` to npm via the `release-agent` workflow; EAS
  production builds and submission to TestFlight / Play internal testing; store metadata; tag
  `v0.1.0`; then the M6 gate — two people other than the author pair and use Shellbell from the
  written docs alone, recorded in `docs/feedback-0.1.md`.

## Scope that exists nowhere in the plan (added 2026-09-19)

The numbered plan makes Task 13 look like it follows Task 12 directly. It does not. Bilal's own
ordering, stated while dogfooding on 2026-09-19:

1. Dev builds on devices — **done for Android**
2. **Dogfooding. Weeks, not hours.** This is the gate, not a step
3. Tasks 11 and 12 largely fall out of dogfooding rather than being separate exercises
4. **A website and branding pass** — no spec, no plan, no estimate; simply not written down before
5. Task 13, when it is actually ready

"Release is the last thing on my mind" (2026-09-19). Do not treat Task 13 as imminent, and do not
re-raise merging PR #9 on the strength of Tasks 11/12 being finishable.

## Found by using it (2026-09-19, first real dogfooding session)

Everything here came out of one evening of actually running Shellbell, not from review. That is
the argument for doing more of it before release, not less.

- **The documented setup leaves the agent dead.** `README.md`'s 60-second setup is `npx shellbell`
  → install app → scan QR → confirm. It never mentions `shellbell service install`, and `start`
  never offers it. A user follows the docs exactly, pairs, closes the terminal — and the agent
  exits. Their phone goes quiet and nothing explains why. **This silently breaks the core promise
  and is the most valuable pre-release fix on this list.** Cheapest form: after a successful pair,
  `start` asks "keep Shellbell running when you close this window? [Y/n]" and runs the install.
- **`service install` cannot work from a dev checkout.** `install()` uses `process.argv[1]` as the
  program path, so from the repo it writes a plist running `node src/cli.ts` — which node cannot
  execute. `isGlobalInstall()` rejects npx paths but not a `.ts` entry point, so it fails silently
  at boot rather than refusing up front. Workaround used on 2026-09-19: `pnpm -F shellbell build`,
  `pnpm pack`, `npm i -g ./shellbell-0.0.1.tgz`, then `shellbell service install`.
- **A sleeping Mac looks exactly like a broken Shellbell.** `KeepAlive` restarts a *crashed* agent;
  nothing can run a *sleeping* one. Closed lid → no events, no rings, no explanation. Bilal is
  running **Amphetamine** to work around this, with nothing in either app indicating they are
  related. Note closed-display mode is a separate Amphetamine toggle and generally needs the power
  adapter.
- **Login Items shows "Node.js Foundation", not Shellbell.** macOS attributes a background item to
  the code signature of the program being run, and the program is node
  (`Developer ID Application: Node.js Foundation (HX7739G8FX)`); the plist `Label` is not used.
  **Publishing to npm does not fix this** — `npm i -g shellbell` produces the same entry. Only a
  binary signed with Miambi's own Developer ID does. It matters more than it looks: an
  unattributable background process is what a careful user disables, and "trust us with your
  terminal, end-to-end encrypted" is exactly the pitch it undercuts. Mitigating factor: the entry
  only appears if the user runs `service install`, which the documented path never tells them to.
- **The local agent config kept a dead relay URL.** `~/.shellbell/config.json` still held
  `wss://relay.shellbell.app` from before the 2026-09-14 domain change, because `relayUrl` is
  persisted and changing `DEFAULT_RELAY` does not migrate an existing install. Harmless now (one
  install, nothing published) but the same shape of bug bites hard after a post-release domain
  change.
- **`expo-doctor` is a CI gate that fails on upstream time, not on this repo.** It resolves the
  SDK's expected versions from the network, so main went red on 2026-09-19 with no code change
  when Expo published four patch releases. Before hunting a cause in the diff, check whether
  anything here actually changed.
- **Dev-client builds are useless away from the Mac.** The `development` profile ships no JS and
  fetches its bundle from Metro over the LAN. Off-network it is a blank shell. Use the `preview`
  profile for anything resembling real use — that is a standalone APK. The relay itself has no
  such constraint: agent and phone both dial *outbound* to `relay.shellbell.dev`, so cellular from
  anywhere works, and creating sessions from the phone (`session.create`, supported by all three
  backends) works the same way.

- **Notifications need a revamp — they all look alike and they stack.** Observed on device
  2026-09-19. Three complaints, and they are *not* one problem:
  - **They never replace or update each other.** Every ring creates a new notification instead of
    updating the existing one for that session. `ExpoMessage` in `apps/relay/src/push.ts` carries
    no thread or collapse identifier at all — no iOS `thread-id`/`apns-collapse-id`, no Android
    `tag`. **This is the cheap half and should be done first:** the data payload *already* carries
    an opaque session id, so threading and collapsing by it leaks nothing that is not already
    sent, needs no privacy change, and needs no client rearchitecture. Check what Expo's push API
    actually exposes before designing.
  - **They all look the same.** `pushBody()` returns one generic string per event kind. Only
    `prompt` adds anything (exit code and duration); `idle` and `blocked` are fixed sentences.
  - **They should carry detail — and this half is genuinely hard.** The relay cannot supply it:
    it never sees plaintext, and `PRIVACY.md` publishes the promise that a push carries "never the
    session title, the command, or its output". `push.ts` even cites spec 8.13/11.3 at the
    `blocked` case for exactly this reason. So richer text cannot come from the server without
    breaking a published guarantee. The only honest route is to **decrypt on the device and
    rewrite the notification locally** — an iOS Notification Service Extension with
    `mutableContent`, and an Android data message that builds the notification client-side. That
    is an architectural change with its own spec, and it would add an App ID capability we
    deliberately declined (see the session record).

  Do not let the second half block the first. Grouping per session is a small, self-contained win.

- **The brand-family generators live at the repo root and duplicate two dependencies.**
  `scripts/extract-brand-family.mjs` and `scripts/render-brand-family.mjs` sit at the root, which
  required adding `opentype.js` and `sharp` to the **root** `package.json` — the same version
  specifiers already declared in `apps/mobile/package.json`. Two declarations of one dependency can
  drift on a future version bump. The whole-branch reviewer recommended moving the generators under
  `apps/mobile/scripts/`, writing to `../../../brand/`, and having the root script shell in via
  `pnpm --dir apps/mobile` — which removes the duplication entirely.
  It also dismantled the justification given for root placement: `sync-vectors.mjs` was cited as
  precedent for a mobile script writing outside itself, but it only *reads* from
  `packages/protocol` and writes *within* `apps/mobile`. It is not the precedent claimed.
  **Deferred deliberately (2026-09-20).** The reviewer's own urgency argument is "before the family
  assets get more consumers", and there are currently zero — the website does not exist and has no
  spec. The fix requires a lockfile change, and therefore a full workspace reinstall, which under
  the hoisted layout is a ~20 minute operation. Do it when the website work starts and something
  actually consumes `brand/`, not before. The reviewer explicitly called it "not a blocker".

## Deferred by decision, with the reasoning (2026-09-19)

- **A signed macOS menu bar app.** Post-1.0, needs its own spec. Three independent arguments
  arrived separately from real use, which is why it is worth more than it first sounds: (a) setup —
  "people won't need complex lines to execute and will have an app they can install"; (b) sleep —
  a user is already running Amphetamine to keep Shellbell working, and nothing connects the two;
  (c) identity — it is the only thing that fixes the Login Items attribution, and Miambi now holds
  the Developer ID (Team `2CW9DK45CV`) it would be signed with. It also subsumes the
  `service install` gap entirely.
- **Multi-line input composition.** Deliberately *not* built on 2026-09-19. The input bar now grows
  to three lines and Return still sends; what was dropped is Return-inserts-newline plus a Send
  button. Reason: `apps/agent/src/backends/tmux/backend.ts` splits text on newlines and presses
  Enter between the parts, so a multi-line body submits once per line inside a coding agent — the
  exact opposite of what composing an agent prompt needs, and that prompt is the motivating use
  case. Doing it properly means **bracketed paste**: tmux can do it correctly via
  `load-buffer` + `paste-buffer -p` (which emits it only if the application enabled it), iTerm2's
  `sendText` has no equivalent guard and would emit `ESC[200~` blind, and the protocol probably
  needs to distinguish "type this" from "paste this". Three components and a wire change — its own
  spec. **Before designing it, run the cheap experiment:** paste a three-line prompt into a real
  Claude Code pane through Herdr and observe what actually happens.

## Known follow-ups (not placeholders, but not yet done)

- **Herdr fixtures are real except for three panes.** Plan 04b Task 7 ran on 2026-09-06 against a
  live Herdr 0.8.2 and `docs/spike-herdr.md` records it, so `apps/agent/test/fixtures/herdr-*.json`
  are real captures now. The spike only had one workspace with one plain shell pane, so the
  multi-workspace and `blocked`-agent shapes in `herdr-session-snapshot.json` are still
  hand-authored — they carry `"_synthetic": true`. A spike run with a second workspace and a
  blocked agent would let those be replaced with real ones.
- **Restrict the Firebase Android API key.** `apps/mobile/google-services.json` is committed by
  design (client config that ships inside the APK) and the repo is public as of 2026-09-14, so the
  key `AIzaSyB-XXsN…` is now readable by anyone. It is not a secret, but it must be restricted in
  Google Cloud to the `dev.bilalahmad.shellbell` Android app so it cannot be used from elsewhere.
- **GitHub Actions was billing-blocked while the repo was private.** Runs on 2026-09-14 failed with
  "recent account payments have failed or spending limit needs to be increased" before any step
  started. The repo went public the same day and Actions runs again — public repos get the minutes
  free.
- **⚠️ Do not merge PR #9 "Version Packages" until Task 13 is ready.** The org policy that blocked
  Actions from opening PRs was lifted on 2026-09-14 (Miambi org → Actions → General → Workflow
  permissions → "allow GitHub Actions to create and approve pull requests"; the repo keeps
  `default_workflow_permissions: read`, since `release-agent.yml` requests what it needs per job).
  `release-agent` is green and PR #9 is open, bumping `shellbell` 0.0.1 → 0.1.0.
  **Merging it runs `changeset publish` — an npm publish that cannot be taken back.** Merge only
  once the placeholders above are resolved and `NPM_TOKEN` exists. Until then the PR just sits
  there and rebases itself on each push to `main`.
  Asked on 2026-09-14 whether to publish early purely to reserve the unclaimed npm name
  `shellbell`: **Bilal's call is no** — ship when it is ready, accepting the squatting risk. Do not
  re-raise.
