# Session record — 2026-09-19: Apple unblock, first dogfooding, four defects

A working session, recorded because most of what it produced is reasoning that would otherwise
only exist in a chat log. `docs/before-first-release.md` remains the live checklist; this is the
narrative behind the entries added to it on this date.

## What it started as, and what it became

It started as "my developer account is set up, what's next" and ended with Shellbell paired,
installed as a service, and used from a phone. Nothing on the morning's list caused the four
defects found — every one surfaced from doing the work.

## Apple: from sole blocker to fully provisioned

Apple's Organization verification cleared and the $99 fee posted. Everything downstream opened at
once.

- **Team ID `2CW9DK45CV`**, entity **Miambi Consulting LLC**, Apple ID `bilal@miambi.ai`
- **App ID** registered for `dev.bilalahmad.shellbell` with **Push Notifications as its only
  capability**. Everything else was declined deliberately: the camera needs only an Info.plist
  usage string, `expo-secure-store` uses the App ID's default keychain group, spec §11.3 rules out
  background modes, and unused entitlements invite App Review questions.
- **No account-level capability requests.** Critical Alerts was the one that looked relevant — it
  bypasses Focus and Do Not Disturb, which sounds ideal for a ringing app — but Apple grants it
  almost exclusively to medical and safety apps. A denial on a first app is a cost with no upside.
  **Time Sensitive Notifications** is the realistic path if rings should ever pierce Focus; it
  needs no approval, but `apps/relay/src/push.ts` currently sends no `interruptionLevel`, so
  enabling the entitlement alone would do nothing.
- **APNs key** created through EAS; app record `6813929475`.
- **Listing name is `Shellbell Terminal`.** Plain "Shellbell" collides with an unrelated egg-timer
  app and Apple folds the space. Only the *listing* name changes — `CFBundleDisplayName` stays
  "Shellbell", so the home-screen name is unaffected. The trademark-claim route was considered and
  rejected: common-law rights only, the other app is live rather than a dormant reservation, weeks
  of delay to probably fail.

**Constraint discovered: there is no iPhone.** The only registered Apple device is an iPad, with
simulator planned for iPhone coverage. Task 12's OLED pass cannot be done as written, and Task
11's iOS half may be impossible on a simulator at all since Expo push tokens have historically
required a physical device. Verify rather than assume; Android covers the ring test end to end.

## Four defects, none of which were on anyone's list

**1. The distribution certificate's password was one `git add -A` from being public.**
`eas credentials -p ios` writes `apps/mobile/credentials.json` next to the cert it downloads. The
`.p12` and `.mobileprovision` were already ignored; `credentials.json` was not, and it stores the
password in plaintext. The repo has been public since 2026-09-14. Caught before the first commit
that would have touched it — `git log` confirms it was never committed.

**2. EAS could not install dependencies at all.** The first Android build died in 17 seconds with
`Cannot use 'in' operator to search for 'integrity' in undefined` — an error that reads like a
corrupt lockfile and is not. Root cause: the builder image ships **pnpm 11.9.0** and ignores
`packageManager`, while the lockfile is written by **11.12.0**; newer pnpm emits peer-dependency
snapshot entries without a `resolution` block, and 11.9.0 reads `resolution.integrity` on them
unguarded.

Worth recording *how* it was found, because two plausible hypotheses were wrong first:

| Hypothesis | Test | Result |
|---|---|---|
| Lockfile is stale or corrupt | `pnpm install --frozen-lockfile`, cold, isolated store | ✅ passed — wrong |
| EAS clobbers `.npmrc`, losing `node-linker=hoisted` | Same, with `.npmrc` deleted | ✅ passed — wrong |
| Builder pnpm is older than the lockfile | `npx pnpm@11.9.0` against a clean `git archive` | ❌ **identical error** |

The builder's version was sitting in the build log the whole time (`pnpm 11.9.0` in
`SPIN_UP_BUILDER`). Reading the log first would have skipped both wrong guesses. Note the log is
**Brotli-encoded** despite its `.txt` URL, and the CLI's `--json` truncates the real error.

Neither local tests nor CI can catch this class of bug — both run the pinned pnpm, so the skew
exists only on EAS.

**3. `doctor` told a user with Herdr installed that it was not installed.** `checkHerdr` probed only
the socket, which Herdr creates only while running. Fixed to distinguish the states via the binary
on `$PATH`; both remain a PASS per spec 8.13 ruling 14, so a wrong guess changes wording and never
the exit code. Fixing it exposed a second bug: `doctor.test.ts` asserted the absent-Herdr wording
against the live `$PATH`, so it would pass on CI (no Herdr) and fail on any developer machine that
has it — green exactly where nobody would see it fail.

**4. The Android keyboard covered the terminal.** `KeyboardAvoidingView` passed
`behavior={undefined}` on Android, relying on the OS to resize the window — which edge-to-edge (the
default since SDK 54 / RN 0.81) no longer does.

## Things confirmed empirically, so nobody re-derives them

- **Herdr's macOS socket path.** A running 0.8.2 server log printed
  `api_socket=~/.config/herdr/herdr.sock` with a `herdr-client.sock` sibling, independently
  confirming `docs/spike-herdr.md`'s Q1. A stale ⚠ in `client.ts` claiming this was unobserved on
  macOS was deleted — it was sending readers to re-answer a closed question. No
  `~/Library/Application Support` candidate is needed.
- **Herdr is a server, not a daemon.** Running `herdr` creates the socket; no process means no
  socket, which is why `doctor` saw nothing.
- **Cloudflare Free cannot express the specified rate limit.** Spec §9.1 called for 30 req/min per
  IP; Free fixes both the counting period and mitigation timeout at 10 s (1 minute is Pro and
  above). Deployed as **5 requests / 10 s per IP, block 10 s** — same sustained rate, stricter on
  bursts. Errata recorded in the spec, the plan and `docs/self-hosting.md`, which aimed the same
  impossible instruction at self-hosters.
- **The relay stays free because the DO hibernates.** `computer-do.ts:84` uses `ctx.acceptWebSocket`
  with `setWebSocketAutoResponse` for ping/pong. Without hibernation a single always-connected Mac
  would burn roughly 10,800 GB-s/day against a ~13,000 GB-s/day free allowance — **one user would
  nearly exhaust the free tier.** Also: Cloudflare's free tier fails closed. Exceeding it stops
  operations, it never bills.

## A decision worth not relitigating

`bilal@miambi.ai` appears in `eas.json` as the Apple ID. Flagged before pushing, because publishing
to a public repo is irreversible — then found to be **already on `origin/main`** in two places in
`docs/before-first-release.md` since 2026-09-14. Scrubbing one occurrence while leaving two would
have been the appearance of a fix. Pushed as-is knowingly; 2FA is the real mitigation. Genuinely
removing it would mean rewriting public history for data already indexed.

## Cost, since it gates decisions

Apple $99/yr (the only meaningful recurring cost), Google Play $25 once, domain ~$10–15/yr, and
**$0** for both Cloudflare and EAS. EAS free tier is 15 iOS + 15 Android builds per month —
a monthly count, not a spend, and `eas build --local` uses none of it.
