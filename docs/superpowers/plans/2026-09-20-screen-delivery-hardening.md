# Reliable pending screen delivery implementation plan

Completed 2026-09-20 on `fix/screen-delivery-hardening`; see the
[execution record](../sessions/2026-09-20-screen-delivery-hardening.md) for regression evidence,
review corrections, verification and remaining scope. Merged locally into `main` on 2026-09-20
at the user's request; not pushed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the last terminal update even when the frame budget was exhausted and no further terminal output arrives.

**Architecture:** Separate backend capture from delivery. Retain one prepared frame generation per watched session, retry stale viewers without recapturing, and acknowledge local transport acceptance before advancing viewer state. Rotate session scheduling as well as viewer scheduling under the existing shared budget.

**Tech Stack:** Node 22, TypeScript, pnpm 11, Vitest fake timers; existing protocol and backend interfaces.

**Spec:** `docs/superpowers/specs/2026-09-20-service-hardening-design.md`, section S1. The bounded-streaming spec remains a separate protocol project.

## Global Constraints

- Keep the existing shared 40-fps frame budget and current wire schemas.
- No terminal-content persistence, new dependencies, live terminal tests, deployment, npm publication, or real service restart.
- Preserve identities, encryption, backend behavior, and unrelated working-tree changes.
- Retrying delivery must not manufacture screen generations or cause an unbounded `getScreen()` polling loop.
- A successful send here means accepted by the local WebSocket transport, not acknowledged by the phone. Receiver acknowledgements belong to the later streaming protocol.
- Use condition-based assertions; fake time advances exercise the actual scheduler, not wall-clock sleeps.

## Scope and sequence

This is the first independently testable hardening slice, not a claim to complete the entire service design. Subsequent plans cover S2 backend disconnect cleanup; S3/S4 relay admission; S5/S6 installation, lifecycle and diagnostics; and S8 rolling push limits. Reproduce the additional audit candidates before planning fixes. S7 notification delivery, Linux per-user hosting, native macOS UI, and chunked streaming remain separate projects under their approved designs.

Before execution, use the worktree skill and inspect `git status --short`. Existing uncommitted audit documentation must not be discarded or silently copied over. Read the source spec from the committed tree; defer audit status edits if that audit is not present in the execution worktree.

## File map

| File | Responsibility |
| --- | --- |
| `apps/agent/src/screen-tracker.ts` | Cache prepared generation, schedule capture and delivery separately, rotate sessions |
| `apps/agent/test/screen-tracker.test.ts` | Deterministic budget, fairness, cancellation and capture-race regressions |
| `apps/agent/src/phone-link.ts` | Preserve transport refusal through encrypted send |
| `apps/agent/test/phone-link.test.ts` | Transport acceptance and nonce-sequence regression |
| `apps/agent/src/agent.ts` | Forward send result to tracker |

No protocol schema or relay changes are necessary.

### Task 1: Retry pending generations without backend polling

**Files:** Modify `apps/agent/src/screen-tracker.ts`; test `apps/agent/test/screen-tracker.test.ts`.

**Interfaces:** Keep `ScreenTracker` public methods unchanged. Add private `PreparedFrame` with `gen: number`, `diff: InnerMessage`, `forceSnapshotAll: boolean`, and `snapshotFor: (degraded: boolean) => InnerMessage`. Add `prepared: PreparedFrame | null` to `SessionState`. Extract `deliver(s: SessionState): void` from the existing viewer loop.

- [x] Add this regression inside the existing describe block, using its existing fake backend and timer setup:

```ts
it("delivers six static viewers without recapturing", async () => {
  for (let i = 0; i < 6; i++) tracker.setViewed(`p${i}`, "S");
  await vi.advanceTimersByTimeAsync(125);
  expect(new Set(sent.map((x) => x.conn)).size).toBe(5);
  const captures = backend.getScreenCalls;
  await vi.advanceTimersByTimeAsync(125);
  expect(new Set(sent.map((x) => x.conn)).size).toBe(6);
  expect(backend.getScreenCalls).toBe(captures);
  expect(new Set(sent.map((x) => "gen" in x.msg ? x.msg.gen : -1))).toEqual(new Set([1]));
});
```

- [x] Run `pnpm -F shellbell exec vitest run test/screen-tracker.test.ts -t "six static viewers"`. Confirm failure: only five unique recipients. Do not add another backend event to rescue the missing recipient.
- [x] Extract preparation and delivery. Initialize `prepared: null`. Keep existing delta, reset, lazy encoding, degradation and generation calculations. After building `diff` and `snapshotFor`, assign:

```ts
s.prepared = { gen: s.gen, diff, forceSnapshotAll, snapshotFor };
```

Move the viewer ordering and send loop into `deliver`; start it with:

```ts
const frame = s.prepared;
if (!frame || s.viewers.size === 0) return;
const { gen, diff, forceSnapshotAll, snapshotFor } = frame;
```

Use `gen` from this immutable preparation in all delivery comparisons. In `tick`, skip only in-flight or unviewed sessions; capture only when dirty, then run `deliver` even when not dirty. Retain transient capture-error resync behavior. Before committing a completed capture, check `this.sessions.get(sessionId) === s` as well as `!this.stopped`; this prevents a removed/recreated session receiving an obsolete capture. Delivery exceptions retain the prepared generation and force a snapshot; they do not mark capture dirty. Replace the previous prepared generation on new capture; do not accumulate a queue.

- [x] Add final-output and empty-bucket regressions with a fresh tracker configured `maxFramesPerSecond: 1`. Subscribe, advance 1000 ms for the initial snapshot, append one line, advance 125 ms, assert no new send, then advance 875 ms and assert the final line arrives without another backend event. For the empty-bucket case subscribe and advance 125 ms, assert zero sends, then advance 875 ms and assert one snapshot. In both cases record `getScreenCalls` after the denied send and assert it remains unchanged through retry.
- [x] Add cancellation cases using that same one-fps fixture: unsubscribe, emit `session-removed`, and stop while pending, each in its own test; advance 1000 ms and assert no sends. Use `backend.getScreenGate` with a manually resolved promise to remove and recreate a session while capture is pending; assert the old capture is never delivered. Explicitly stop the default fixture tracker before replacing it.
- [x] Run `pnpm -F shellbell exec vitest run test/screen-tracker.test.ts`; all existing diff, scroll, degradation, watched-session and race tests must pass.
- [x] Commit only the two task files: `git add apps/agent/src/screen-tracker.ts apps/agent/test/screen-tracker.test.ts` then `git commit -m "fix: retain pending screen delivery without recapturing"`.

### Task 2: Share scarce tokens fairly across sessions

**Files:** Modify `apps/agent/src/screen-tracker.ts`; test `apps/agent/test/screen-tracker.test.ts`.

**Interfaces:** Consume Task 1's `deliver(s: SessionState): void`; add private `sessionOffset = 0`. No public or wire interface changes.

- [x] Add a regression with a one-fps tracker, sessions `S` and `T`, one viewer each. Before each 125-ms scheduler tick append a line to `S`. After 3000 ms require at least one frame for `T`, while total sends stay at most three. Current insertion-order scheduling allows busy `S` to consume each available token.
- [x] Run `pnpm -F shellbell exec vitest run test/screen-tracker.test.ts -t "across sessions"` and confirm the quiet-session fairness assertion fails before the fix.
- [x] Rotate the starting session only when a pass actually consumes a token. Rotation on every 125-ms tick can alias with a one-second refill and still starve the same session. Build the traversal from a stable snapshot:

```ts
const entries = [...this.sessions.entries()];
if (entries.length === 0) return;
const offset = this.sessionOffset % entries.length;
const ordered = entries.slice(offset).concat(entries.slice(0, offset));
```

Change `deliver` to return `boolean`, true when any token was spent, including a refused or throwing transport send. Track token spending before calling the sink. In `tick`, after a token-consuming session set the next pass's offset to the position immediately following that session in `entries`. Keep the existing per-session skipped-first viewer sorting and round-robin tie breaking. Never create a budget per session or reset the shared bucket on rotation.
- [x] Run the fairness case and the complete tracker suite. Add a two-session static case and assert all viewers eventually receive generation 1 without recapture; retain exact shared-budget assertions.
- [x] Commit the same two scoped files with `git commit -m "fix: rotate screen sessions under shared frame budget"`.

### Task 3: Do not mark refused transport sends as delivered

**Files:** Modify `apps/agent/src/phone-link.ts`, `apps/agent/src/agent.ts`, `apps/agent/src/screen-tracker.ts`; test `apps/agent/test/phone-link.test.ts` and `apps/agent/test/screen-tracker.test.ts`.

**Interfaces:** Change `PhoneLinkOptions.send` and `ScreenTrackerOptions.sink` to return `boolean | void`; explicit `false` means refused, `void` preserves existing callbacks. `PhoneLink.send(msg: InnerMessage): boolean` keeps its public signature. Change agent `sendTo(connId: string, msg: InnerMessage): boolean` to forward the result or false for a missing link.

- [x] In the existing handshaken phone-link fixture, make the transport callback return false and assert `link.send` returns false; restore acceptance and assert true. Capture both encrypted envelopes and assert the second sequence number exceeds the first: refusal must not reuse a nonce. Run `pnpm -F shellbell exec vitest run test/phone-link.test.ts` and confirm the new refusal assertion fails first.
- [x] Change the final send in `PhoneLink.send` to return `this.opts.send(envelope) !== false`, preserving sequence increment and sealing before the call. Do not retry input commands. Preserve the agent's existing relay callback return value and implement:

```ts
private sendTo(connId: string, msg: InnerMessage): boolean {
  return this.links.get(connId)?.send(msg) ?? false;
}
```

- [x] Add a tracker fixture whose sink records attempts but returns false until a local `available` flag becomes true. Subscribe, advance 125 ms, record captures, set `available = true`, advance 125 ms. Require two attempted snapshots with the same generation and unchanged capture count. Before fixing tracker bookkeeping, this test must fail because the second attempt is absent.
- [x] Change delivery bookkeeping so refusal cannot advance the viewer:

```ts
const accepted = this.opts.sink(conn, upToDate ? diff : snapshotFor(starved));
if (accepted === false) {
  v.skipped += 1;
  v.forceSnapshot = true;
  continue;
}
v.lastSentGen = gen;
v.forceSnapshot = false;
v.skipped = 0;
```

Catch a sink exception per viewer, increment skipped, force its snapshot, and continue other viewers. Do not capture again solely because sending failed. Do not refund spent tokens: repeated failures must remain rate-bounded. Clear prepared content when the last viewer leaves; a later subscription captures fresh state. Relay disconnect already drops links and viewers; preserve that cleanup, and require a fresh snapshot on resubscription rather than replaying an old connection's frame.
- [x] Add thrown-send, disconnect/drop-viewer, and resubscribe cases to tracker tests. A thrown send to one viewer must not prevent another viewer's send. A dropped viewer must never receive retries. A new subscription must receive a snapshot of current backend content, not an obsolete cached frame.
- [x] Run `pnpm -F shellbell exec vitest run test/phone-link.test.ts test/screen-tracker.test.ts`, then `pnpm -F shellbell test`, `pnpm typecheck`, and `pnpm lint`. Repair any test sink callbacks returning an array length by using a block body with no return; do not broaden acceptance types to arbitrary numbers.
- [x] Commit only these five files with `git commit -m "fix: preserve screen retries when transport refuses sends"`.

## Final verification and handoff

- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm -F shellbell build`, and `pnpm -F shellbell check:bundle`. Record exact results and skipped live tests. No protocol regeneration should be necessary because wire schemas are unchanged.
- [x] Review the diff against S1: empty bucket, final quiet output, six static viewers, shared-session fairness, unsubscribe/removal/in-flight cancellation, and transport refusal all have regression coverage. Confirm cached memory holds only the latest prepared generation per watched session.
- [x] Run `git diff --check` and inspect `git status --short`. Do not commit unrelated audit files. Report remaining S2–S8 work explicitly; this slice does not introduce chunking, receiver backpressure, Linux hosting, or a macOS installer.
