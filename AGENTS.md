# AGENTS.md

Shared guidance for coding agents (Codex, Claude Code, others) working in this repository.
`CLAUDE.md` points here so both tools read the same thing.

## What this is

Shellbell mirrors a Mac's terminal sessions to a phone, rings when a command finishes / a session
goes quiet / a coding agent is blocked, and lets you type back. Everything between phone and Mac is
end-to-end encrypted; the relay routes ciphertext and cannot read it.

## Commands

Everything runs from the repo root via pnpm workspaces (pnpm 11, Node 22).

```
pnpm lint            # biome check .        (pnpm lint:fix to write)
pnpm typecheck       # tsc --noEmit, all four projects
pnpm test            # vitest run, all four projects
pnpm build
```

Per project, use `-F` with the package name — note the agent's package is `shellbell`, not
`@shellbell/agent`:

```
pnpm -F shellbell test
pnpm -F @shellbell/relay test
pnpm -F @shellbell/mobile test
pnpm -F @shellbell/protocol test
```

**A single test file or case:**

```
pnpm -F shellbell exec vitest run test/herdr-backend.test.ts
pnpm -F shellbell exec vitest run test/herdr-backend.test.ts -t "some test name"
pnpm -F shellbell exec vitest run test/foo.test.ts --reporter=verbose   # shows console.log
```

**Running the agent in development** (tsx on `src/cli.ts`) — note there is no `--` separator, it
would be forwarded to the CLI and break it:

```
pnpm -F shellbell run dev --version
pnpm -F shellbell exec tsx src/cli.ts --version    # equivalent
```

Relay: `pnpm -F @shellbell/relay dev` (wrangler). Mobile: `pnpm -F @shellbell/mobile start`
(needs a dev client build, not Expo Go).

**Live-hardware tests are env-gated and skipped by default** — they need a real iTerm2/tmux/Herdr
running and will type into real panes:

```
SHELLBELL_LIVE=1        # live-iterm2.test.ts, live-herdr.test.ts
SHELLBELL_TMUX_E2E=1    # live-tmux.test.ts
```

### CI gates beyond lint/typecheck/test

CI (`.github/workflows/ci.yml`, macos-15) also runs, and these catch things local `pnpm test` will
not:

```
pnpm -F @shellbell/mobile check:vectors     # crypto vectors synced into the app
pnpm -F @shellbell/mobile doctor            # expo-doctor: Expo dep versions must match the SDK
pnpm -F @shellbell/protocol gen:protocol-doc && git diff --exit-code docs/protocol.md
pnpm -F shellbell check:bundle              # published tarball contents
bash apps/agent/scripts/pack-smoke.sh
```

If you touch protocol zod schemas, regenerate `docs/protocol.md` or CI fails — it is generated, not
hand-written.

## Architecture

Four workspace projects. The dependency direction is one-way: everything depends on `protocol`,
nothing depends on the apps.

**`packages/protocol`** — the source of truth for anything on the wire. Zod schemas (`ctrl.ts`
control-plane, `inner.ts` end-to-end payloads, `envelope.ts`), crypto and identity (`crypto.ts`,
`keys.ts`), the QR pairing payload (`qr.ts`), and the screen model (`screen.ts`, `sgr.ts`,
`width.ts`, `colors.ts`). `docs/protocol.md` and the mobile app's test vectors are both generated
from here.

**`apps/agent`** — the `shellbell` npm package, a Node CLI running on the Mac. The important
abstraction is `TerminalBackend` (`src/backends/types.ts`): `connect`, `listSessions`, `getScreen`,
`getHistory`, `sendText`, … implemented three times, in `backends/iterm2` (native API over
protobuf, hence the `buf generate` prebuild step), `backends/tmux` (control mode) and
`backends/herdr` (NDJSON over a unix socket). `backends/registry.ts` multiplexes them so several
run at once and sessions carry a `backend:` id prefix.

Around the backends: `events.ts` (`EventEngine`) turns backend events into rings
(prompt / idle / blocked); `notifier.ts` sends them; `screen-tracker.ts` pushes screen frames to
whichever phone is viewing a session; `relay-client.ts` holds the websocket; `pairing.ts` and
`identity.ts` own the QR pairing and keys.

**`apps/relay`** — a Cloudflare Worker plus one Durable Object class, `ComputerDO`
(`src/computer-do.ts`), one instance per paired Mac. It routes encrypted frames between agent and
phones, gates pairing, and sends Expo pushes (`src/push.ts`). It never sees plaintext terminal
content. Two wrangler configs: `wrangler.jsonc` is what self-hosters deploy;
`wrangler.hosted.jsonc` adds the `relay.shellbell.dev` custom domain and is CI-only. Keep them in
sync by hand.

**`apps/mobile`** — Expo/React Native app (SDK 57, expo-router).

## Conventions that are not obvious

- **The spec is the authority.** `docs/superpowers/specs/2026-09-03-shellbell-design.md` is the
  design document; the plans under `docs/superpowers/plans/` are execution records. When a plan and
  the spec disagree, the spec wins and the plan gets fixed. Corrections are made **in place** with
  an errata marker naming the source, e.g. `(Plan 04 errata: …)` — grep for `errata` to see the
  house style.
- **Async tests: wait for the condition, never a fixed sleep.** Three separate flaky tests were
  traced to this in one day. The trap: `registry.connected()` flips the moment `connect()`
  resolves, *before* the bootstrap snapshot has populated sessions and before `onConnected` fires —
  so waiting on it and then asserting races on a loaded CI runner while always passing locally.
  Use the `waitFor` / `waitForAsync` helpers on the thing you are actually asserting. Same applies
  to the relay's push tests, where a late push is counted by the *next* test's fetch stub.
  When you think you have fixed a flake, prove it: widen the window artificially (slow the stub,
  spin on `setImmediate` instead of a poll tick) and show the old code fails and the new passes.
- **`apps/mobile/google-services.json` is committed on purpose** — it is client config that ships
  inside the APK. Real credentials (the FCM service-account key, the Play service-account key at
  `apps/mobile/play-service-account.json`) are gitignored and must stay that way.
- **EAS Build does not use this repo's pnpm unless told to.** The builder image ships its own pnpm
  (11.9.0 as of 2026-09-19) and ignores `package.json`'s `packageManager` field, so a lockfile
  written by a newer pnpm makes `pnpm install --frozen-lockfile` die in `INSTALL_DEPENDENCIES`
  with `Cannot use 'in' operator to search for 'integrity' in undefined` — a crash inside pnpm, not
  a corrupt lockfile. `eas.json`'s `base` profile sets `corepack: true` so the pinned version is
  used; every build profile must `extends` it, since `corepack` is per-profile and all of them run
  the same install phase. **Local `pnpm test`/CI cannot catch a regression here** — both run the
  pinned pnpm. To reproduce a builder failure, run the builder's version against a clean checkout:
  `git archive HEAD | tar -x -C $TMP && cd $TMP && npx pnpm@<builder-version> install
  --frozen-lockfile --store-dir $TMP/.store`.
- **EAS build logs are Brotli-encoded** despite the `.txt` URL, so `gunzip` fails and `curl
  --compressed` may not handle it. Decode with
  `node -e "require('fs').writeFileSync('log.txt',require('zlib').brotliDecompressSync(require('fs').readFileSync('raw.bin')))"`,
  then parse the JSON-per-line records. The CLI's `--json` output truncates the real error;
  the log file has it.
- `.superpowers/` is gitignored agent working state; `docs/superpowers/` is the committed record.

## Release state — read this before touching anything release-related

**`docs/before-first-release.md` is the live checklist and the single source of truth for release
state.** It lists every remaining placeholder, who fills it, and why the blocked ones are blocked.

As of 2026-09-14 the short version:

- Nothing is published. `shellbell` is **unclaimed on npm** and PR #9 "Version Packages" is open
  and **must not be merged** — merging runs `changeset publish`, an npm publish that cannot be
  taken back. Bilal's decision on 2026-09-14 was to ship when ready rather than publish early to
  reserve the name; do not re-raise it.
- The hosted relay is live at `relay.shellbell.dev` and redeploys from CI on `relay-v*` tags.
- Everything still open is blocked on Apple Developer Program and Google Play **organization
  verification**, which gate the APNs key, dev builds, the device ring test, device QA, the demo
  GIF, and the three `REPLACE_APPLE_*` values in `apps/mobile/eas.json`.

Tasks marked `[HUMAN]` in the plans are steps needing credentials or physical devices. Historically
an agent must never run them; Bilal has since asked that they be run where local `wrangler`/`gh`
credentials already allow, stopping at what genuinely cannot be done (minting API tokens,
org-admin settings, anything needing a device or store account).
