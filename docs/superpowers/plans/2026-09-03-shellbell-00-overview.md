# Shellbell — Implementation plans: overview and execution order

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2, reviewed by Gemini 3.1 Pro and Codex; dispositions in spec §19).

Six plans, executed in order. Each produces working, tested software on its own and ends with a self-review. Every task in every plan is written for an implementer with no prior context: exact files, exact code, exact commands, expected output, commit message.

| # | Plan | Spec milestone | Depends on | Output |
|---|---|---|---|---|
| 01 | [Foundation](2026-09-03-shellbell-01-foundation.md) | M0 (spikes), M1 (protocol) | — | monorepo; iTerm2 + tmux spikes with recorded evidence; `@shellbell/protocol` with golden vectors; CI |
| 02 | [Relay](2026-09-03-shellbell-02-relay.md) | M2 | 01 | Cloudflare Worker + `ComputerDO`: auth, gated pairing, sync, leases, routing, limits, push |
| 03 | [Agent core + iTerm2](2026-09-03-shellbell-03-agent.md) | M3 | 01, 02 | `npx shellbell`: relay client, phone links, iTerm2 backend, tracker, rings, confirmed pairing, CLI, LaunchAgent |
| 04 | [tmux backend](2026-09-03-shellbell-04-tmux.md) | M3b | 03 | control-mode client, tmux backend, de-dup with iTerm2 `-CC` |
| 05 | [Mobile core](2026-09-03-shellbell-05-mobile.md) | M4 | 01, 02, 03 (a running agent) | Expo app: render spike, pairing, computers, sessions, session view, input |
| 06 | [Rings & release](2026-09-03-shellbell-06-rings-release.md) | M5, M6 | 01–05 | push notifications, hosted relay, EAS builds, design pass, docs, npm + stores |

## How to execute

Use `superpowers:subagent-driven-development` (recommended): one fresh subagent per task, review between tasks. Each plan's header states the required sub-skill. Plans 03 and 05 are the longest (12 and 8 tasks); Plan 04 can run in parallel with Plan 05 once Plan 03 is done.

Before Plan 01 Task 2: iTerm2 must be running with the Python API enabled (it is, on the author's Mac). Before Plan 01 Task 3: `brew install tmux`.

## Accounts and money (needed only from Plan 06)

| Account | Cost | Used for |
|---|---|---|
| Cloudflare | free | relay (Workers + Durable Objects) |
| Expo (EAS) | free tier | builds, updates, push service |
| Apple Developer Program | $99 / year | TestFlight + App Store, APNs |
| Google Play Console | $25 once | internal testing + Play Store, FCM via Firebase (free) |
| npm | free | publishing `shellbell` |
| Domain `shellbell.dev` | ~$14 / year | `relay.shellbell.dev` |

## Decisions you should not relitigate mid-execution

They are in spec §3 (decision log) and §19 (review dispositions). If a task seems to contradict the spec, the spec wins and the plan gets fixed — not the other way round.

## Verification gates between plans

- After 01: `pnpm lint && pnpm typecheck && pnpm test` green; `docs/spike-iterm2.md` and `docs/spike-tmux.md` have real numbers.
- After 02: relay tests green under the workers pool; `wrangler dev` answers `/healthz`.
- After 03: `agent.integration.test.ts` green; `SHELLBELL_ITERM_E2E=1` live test green; `npx shellbell` prints a QR.
- After 04: `SHELLBELL_TMUX_E2E=1` live test green; a Ghostty/Terminal.app tmux pane shows up in `shellbell status --json`.
- After 05: QA.md checklist passes on one iPhone and one Android; `docs/spike-render.md` records the decision.
- After 06: `docs/e2e-ring.md` shows all four ring scenarios passing; two non-authors complete setup from the README.
