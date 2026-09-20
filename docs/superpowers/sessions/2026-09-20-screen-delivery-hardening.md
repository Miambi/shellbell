# Screen delivery hardening — 2026-09-20

Implements S1 of the [service-hardening design](../specs/2026-09-20-service-hardening-design.md)
using the [screen delivery plan](../plans/2026-09-20-screen-delivery-hardening.md).
This is the first service-hardening slice, not the separate chunked-streaming protocol.

## As-built behavior

- Backend capture dirtiness and pending viewer delivery are independent. A budget-denied frame
  remains eligible for delivery on later ticks without extra backend captures or generations.
- Each watched session retains one prepared generation, replaced when the screen changes and
  released when the last viewer leaves. An unchanged recapture preserves its pending diff.
- One shared frame bucket still defaults to 40 frames/second. Session scheduling rotates after
  consumed tokens; existing viewer scheduling remains skipped-first with round-robin ties.
- Explicit transport refusal propagates from the relay client through PhoneLink and Agent to
  ScreenTracker. Refused and throwing sends consume their token but do not advance viewer state;
  retries use a snapshot. A throwing viewer does not block another viewer's delivery.
- Encrypted send sequence numbers advance even for refused attempts. Input commands are not
  automatically retried. Acceptance means local WebSocket acceptance, not phone receipt.
- Unsubscribe, disconnect cleanup, removal, and shutdown cancel delivery. Both successful and
  rejected obsolete captures are prevented from mutating a replacement session.

No wire schemas, dependencies, relay code, identities, or live services changed.

## Regression evidence and commits

| Commit | Behavior verified |
| --- | --- |
| `a0d8bbc` | Six static viewers originally stopped at five recipients; pending retry now delivers all six without recapture. Also covers empty bucket, final quiet output and cancellation. |
| `f8c1f56` | Busy session and throwing sender originally starved a quiet session under a one-fps shared budget; session rotation restores delivery. |
| `f3f7c19` | Explicit refusal originally reported success; thrown sink prevented another viewer's delivery; pending diff could be overwritten by unchanged recapture. |
| `dff28c6` | Strengthened the unchanged-recapture test to use budget starvation rather than refusal. Removing preservation produces one failure; restoring it passes. Receiver reconstruction verifies actual terminal content. |
| `0828905` | Rejected obsolete captures originally invoked removal after same-ID recreation or shutdown. Both deterministic regressions failed before the identity/stopped guard and passed after it. |

The test-strengthening commit matters: refusal forces a snapshot, which could mask a missing
pending diff. The replacement test explicitly receives a snapshot followed by a diff and checks
the reconstructed receiver against the backend.

## Verification

Fresh controller-run checks against `0828905` all exited successfully:

- `pnpm test`: protocol 162, agent 360, relay 40, mobile 338 — **900 passed**, four live-hardware
  tests skipped. No live-hardware opt-ins were enabled.
- `pnpm typecheck`: all four projects.
- `pnpm lint`: 291 files checked.
- `pnpm -F shellbell build` and `pnpm -F shellbell check:bundle`.
- `bash apps/agent/scripts/pack-smoke.sh`: temporary-prefix package installation, CLI version/help,
  and cleanup; no publication or daemon startup.
- `git diff --check`.

Task reviews completed; the whole-branch review identified the stale rejection race addressed
in `0828905`. Scoped re-review confirmed the correction, with no remaining findings.

## Remaining work

S2 backend disconnect cleanup, S3/S4 relay admission, S5/S6 installation/lifecycle/diagnostics,
S8 rolling push budgets, and the separately scoped S7 notification reliability work remain.
Linux per-user hosting, the native macOS installer/controller, and byte-bounded streaming with
receiver backpressure are not implemented by these commits.

Existing uncommitted audit documentation remains in the primary checkout unchanged. This work
was isolated on `fix/screen-delivery-hardening`, then fast-forward merged locally into `main`
at the user's request on 2026-09-20. No push, deployment, or release occurred.
