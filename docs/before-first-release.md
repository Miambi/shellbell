# Before the first release

Everything below must be resolved before Task 13 publishes anything — npm versions and store
builds cannot be taken back. Re-run this grep (Task 8 Step 7's search, copied verbatim); once
every row below is resolved it should return nothing but this file itself:

```
grep -rn "REPLACE_SECURITY_CONTACT\|REPLACE_APPLE_ID_EMAIL\|REPLACE_ASC_APP_ID\|REPLACE_APPLE_TEAM_ID\|REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH\|before-first-release\|YYYY-MM-DD" \
  --include='*.json' --include='*.jsonc' --include='*.md' --include='*.ts' --include='*.tsx' . \
  | grep -v node_modules
```

## Placeholders

| Placeholder | File | Filled by | Task |
|---|---|---|---|
| ~~`REPLACE_AFTER_eas_init`~~ | `apps/mobile/app.json` | **done 2026-09-06** — `eas init` linked project `4a002a82-…` (`@miambi/shellbell`) | 9 |
| `REPLACE_SECURITY_CONTACT` | `SECURITY.md` | Bilal's chosen address | 13 |
| `REPLACE_APPLE_ID_EMAIL` / `REPLACE_ASC_APP_ID` / `REPLACE_APPLE_TEAM_ID` | `apps/mobile/eas.json` | App Store Connect | 13 |
| `REPLACE_PLAY_SERVICE_ACCOUNT_JSON_PATH` | `apps/mobile/eas.json` | Play Console service account | 13 |
| `docs/demo.gif` | `README.md` | screen recording | 13 |
| every blank (`__`) | `docs/spike-render.md` | on-device render spike (carried from Plan 05) | 12 |
| every blank (`____-__-__ __:__` / `__`) | `docs/e2e-ring.md` | device ring test | 11 |
| every blank (`__`) | `docs/feedback-0.1.md` | two testers | 13 |

## Decisions (2026-09-06)

- **Store accounts: Miambi** (registered entity). Apple Developer Program as an *Organization*
  membership and a Google Play *organization* account, both under `bilal@miambi.ai`; both need
  Miambi's D-U-N-S number. Seller name shown in the stores: Miambi.
- **Status:** Apple Developer Program organization enrollment submitted 2026-09-06; Apple asked for
  further information, which Bilal supplied — still awaiting Apple's authority verification as of
  2026-09-14. Google Play organization account created 2026-09-06 (Miambi, organization account).
- **Bundle id / package stays `dev.bilalahmad.shellbell`** (Bilal's call; permanent once shipped).
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
  **Only one item left:** a Cloudflare rate-limiting rule on `/ws/*` (30 req/min per IP). Dashboard
  work — the local wrangler OAuth token is `zone (read)` only and cannot write rulesets.
- **Task 11 — Device end-to-end ring test.** On real hardware, with Tasks 1/9/10 done: prompt,
  idle, blocked and attentive-suppression scenarios, recorded in `docs/e2e-ring.md`; update
  `apps/mobile/QA.md`'s ring line to point at it.
- **Task 12 — Visual design and device QA pass.** Walk every screen on an OLED iPhone and an
  Android device (accent colors, motion, icon/splash, accessibility); run the full
  `apps/mobile/QA.md` checklist on both; fill in `docs/spike-render.md`.
- **Task 13 — First release.** Resolve every placeholder above and re-run the grep; create the
  `NPM_TOKEN` secret and publish `shellbell` to npm via the `release-agent` workflow; EAS
  production builds and submission to TestFlight / Play internal testing; store metadata; tag
  `v0.1.0`; then the M6 gate — two people other than the author pair and use Shellbell from the
  written docs alone, recorded in `docs/feedback-0.1.md`.

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
