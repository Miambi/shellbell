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
| ~~`REPLACE_AFTER_eas_init`~~ | `apps/mobile/app.json` | **done 2026-09-06** — `eas init` linked project `de15465f-…` (owner `bilal-miambi`) | 9 |
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
- **Bundle id / package stays `dev.bilalahmad.shellbell`** (Bilal's call; permanent once shipped).
- **Expo:** project `de15465f-…` was created under the personal account `bilal-miambi`; transfer it
  to the `miambi` organization before uploading push credentials, then set `owner: "miambi"` in
  `apps/mobile/app.json`.
- **Builds:** EAS project is required for Expo push; EAS Build/Submit are optional (`eas build
  --local` works). EAS Update is not used (`expo-updates` is not installed).

## `[HUMAN]` tasks (plan Tasks 9–13)

Summarized here; the plan (`docs/superpowers/plans/2026-09-03-shellbell-06-rings-release.md`) has
the exact steps. An agent must never run, simulate, or report the outcome of any of these.

- **Task 9 — EAS project, credentials, development builds.** `eas init` (**done**); iOS distribution cert + provisioning profile + APNs push key;
  Android Firebase project, `google-services.json` (kept out of git) and FCM V1 service account;
  confirm "enhanced push security" is off; build and install development builds on both test
  devices.
- **Task 10 — Domain, hosted relay deploy, secrets, WAF.** Buy `shellbell.app` on the `miambi`
  Cloudflare account; first `wrangler deploy --config wrangler.hosted.jsonc`; the
  `EXPO_ACCESS_TOKEN` Worker secret; a Cloudflare rate-limiting rule on `/ws/*`; the
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` GitHub Actions secrets; tag `relay-v0.1.0`.
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

- **Herdr spike fixture swap.** `apps/agent/test/fixtures/herdr-*.json` are synthetic fixtures
  captured without a real Herdr server. `pnpm -F shellbell spike:herdr` (Plan 04b Task 7, still
  pending) needs to run against a real Herdr server to capture real fixtures and write
  `docs/spike-herdr.md`, which does not exist yet.
