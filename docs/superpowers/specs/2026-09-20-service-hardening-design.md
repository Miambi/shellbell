# Service hardening — first delivery design

Date: 2026-09-20. Status: proposed implementation contract for review.
Baseline: `34e1de8`, plus the documentation-only service audit.

## Objective and boundary

Fix the reproduced service reliability/resource-limit defects and the immediate
installation/diagnostic failures before adding the headless Linux platform and
native Mac controller described in [the host architecture](2026-09-20-headless-host-design.md).
Preserve existing identities, wire encryption, backend capabilities and supported
macOS installations. No new host OS, GUI, publication or live-service migration
belongs in this first delivery.

The subsequently approved [bounded streaming workstream](2026-09-20-bounded-terminal-streaming-design.md)
adds protocol/client flow control and byte-bounded transfers separately. Fix S1
against the current wire format first; do not wait for a new client protocol to
restore eventual delivery. The hosting constraint is Workers Free, and fixes
must not introduce terminal-content persistence or paid infrastructure.

Source: Bilal requested fixes after the 2026-09-20 audit. S1–S8 below refer to its
finding IDs. Existing design requirements remain authoritative except for explicit
changes approved here. This document is a design, not evidence of completed fixes.

## Changes and acceptance criteria

### S1: screen frame budget must preserve pending delivery

Retain unsent viewer work until it is delivered, the viewer unsubscribes or its
session disappears. A clean backend screen does not imply all viewers are up to
date. Separate capture dirtiness from pending delivery where needed; do not
manufacture new generations or unbounded backend reads solely to retry a send.
Continue obeying the shared frame budget and maintain viewer fairness.

Regression cases: first snapshot under an empty bucket; last output before
quietness; six viewers of a static screen; several sessions sharing a bucket;
unsubscription while pending; relay disconnect during retry. Advance fake time
until the delivery condition, without injecting extra backend output to rescue it.
The old behavior must fail the static-screen test before the fix.

### S2: backend disconnect must invalidate health and session state

Expose iTerm2 connection state through the same registry contract as tmux/Herdr.
On loss, remove its connected advertisement and reconcile removed sessions so
screen tracking, event detection and ring throttles do not retain phantom work.
Do not clear the other backends' state. Reconnect performs a new bootstrap and
must not ring solely because old state was rediscovered.

Tests must assert hello/backend health, session removal and no stale idle rings,
not only an empty `listSessions`. Include disconnect while capture is in flight
and reconnect with native IDs reused.

### S3/S4: relay limits apply to actual message types

Unexpected text messages are rejected through an explicit bounded path instead
of silently bypassing application limits. Preserve the configured automatic
heartbeat response; test heartbeat handling separately from arbitrary text.

Apply an absolute state/role byte cap before CBOR decoding, then enforce the
16 KiB control cap against the decoded envelope type. A prefix heuristic can
remain only as an optimization, never the authoritative security decision.
Malformed frames and over-limit frames use the existing documented close/error
semantics where applicable. Rate limiting must cover every application-handled
message path. Do not widen unauthenticated or pairing admission limits.

Use the actual Workers harness: oversized unauthenticated text, arbitrary text
bursts, valid control CBOR with `t` late in the map/extra padding, exact byte
boundaries, normal binary E2E routing and automatic heartbeat. Assert closure
and absence of side effects, not only helper return values. These changes do
not constitute a deployment WAF audit or an E2E security certification.

### S5: service installation validates what will actually run

Reject source-runner and temporary/cache entrypoints instead of inferring a
durable executable from a pathname blacklist. Validate absolute executable and
built CLI paths, create the service definition, then wait a bounded interval for
the expected local agent identity/control endpoint. Bootstrap success alone is
not readiness. Relay-offline/backend-unavailable must be reported distinctly
from failure to launch the process.

Capture the selected state directory explicitly. Persist only a documented
allowlist of required backend environment (not the whole shell environment or
secrets), using correct plist escaping. Do not persist transient Herdr session
selection accidentally. Failed installation must leave the prior valid service
recoverable; do not swallow genuine unload/bootstrap errors.

Tests cover source and npm-cache rejection, valid packed install, paths with
spaces/XML characters, custom state directory, unavailable runtime, readiness
timeout, wrong process at the control endpoint and rollback after failed update.
Real launchd testing is isolated and separately approved; default tests mock it.

### S6: consistent diagnostics and explicit configuration application

Report process/service manager, control endpoint, relay and individual backends
separately. Absent optional backends are warnings; an explicitly required backend
failing is an error. At least one usable backend is needed for terminal-readiness,
but not for local management readiness. Text and JSON modes share exit semantics.
Keep machine-readable output structured and do not expose identity secrets.

Invalid config operations must return nonzero without mutating state. Successful
changes must say whether a restart is needed; do not pretend they hot-reloaded.
Add validated threshold keys for the existing notification settings without
changing the current defaults as an incidental fix.

Introduce tested service lifecycle operations (status/start/stop/restart) behind
a macOS adapter that can later support a Linux adapter. An explicit stop must
not be undone immediately by launchd KeepAlive. Distinguish a current-session
stop from disabling future autostart in help/status. Detailed command semantics
and backward compatibility are required in the implementation plan before code.

### S8: implement the stated rolling push budget

Keep the existing design's limit of 20 attempts per rolling hour, per phone per
computer relay object. Replace the fixed-window approximation with a bounded
rolling representation. Define the hour as `(now - 3,600,000 ms, now]`; an attempt
exactly one hour old expires. An accepted provider attempt consumes budget even
if delivery later fails. Retries are not introduced by this workstream.

Upgrade stored old counters conservatively: preserve existing count until its
old window expires rather than granting a fresh allowance. Bound stored data and
remove it on unpair/retention cleanup. Test boundary bursts, independent phones
and computers, persistence/reconstruction and legacy-state migration. Do not
rewrite the design to call the old fixed window correct merely to close S8.

## Related findings that need reproduction first

Investigate standalone-pair PID/socket ownership, log rotation under launchd,
prompt-state freshness and re-handshake/subscription coordination using isolated
regressions. If confirmed and bounded by these changes, fix with a failing test;
otherwise record a separate scoped follow-up. Never remove a live socket solely
because its PID file is absent, signal a PID without validating ownership, or
type into actual user terminal sessions to make a default test pass.

## Separate notification reliability workstream

S7 is not closed by these fixes. Receipt polling, bounded provider timeouts/retries,
durable attempt state, suppression of duplicate/stale notifications and privacy-
safe delivery diagnostics require a dedicated design. It must distinguish
provider acceptance, downstream receipt status and actual device visibility;
none is an unconditional delivery guarantee. Scope and quotas must be reviewed
before adding background alarms/queues or changing notification privacy promises.

## Verification and handoff

For each defect, demonstrate the old failure with deterministic fake time/fakes,
then the corrected behavior. Run protocol, agent and relay suites; lint/typecheck;
agent build, bundle and isolated pack smoke. Preserve live-hardware opt-ins.
Review error paths, backward compatibility and changes to generated protocol docs
if any schema changes prove necessary; prefer no wire schema changes here.

Update the audit finding statuses only with linked test evidence. Update intended
design and as-built references consistently with dated errata. Do not describe
the Linux host or native installer as shipped while doing this work. No npm
publication, release merge, production deploy or real service restart is implied.
