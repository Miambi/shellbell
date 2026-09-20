# Notification identity and grouping

Status: **approved 2026-09-20**, not yet implemented. Android only (see Non-goals).

Authority for how rings are presented on the phone. The product spec
(`2026-09-03-shellbell-design.md`) remains authoritative for when a ring is *emitted*; this
document covers only what the user sees once one arrives.

## 1. The problem, diagnosed

Reported from real use on 2026-09-20: *"I keep getting spammed with nonsense / the same
notification."* Two distinct causes, found by reading the code rather than guessing.

**They are indistinguishable.** The ring rate limit is **per session** — `RING_LIMIT_MS = 60_000`
in `apps/relay/src/computer-do.ts:539`, keyed on `session_id`. With six live sessions, six rings a
minute is within limits (capped by `PUSH_PER_HOUR = 20`). And every one is identical on screen: the
**title is the computer name**, the same for all sessions, and the **body is a fixed string per
event kind** from `pushBody()` in `apps/relay/src/push.ts`. Nothing names the session. Six
different sessions therefore read as one notification repeated.

**They fire too readily.** `idleQuietMs` defaults to **4 s** (`apps/agent/src/config.ts:108`), so a
plain shell rings "A session went quiet" after 4 s of no output following 1.5 s of activity — which
is most shells, most of the time. Agent panes are excluded from this heuristic
(`apps/agent/src/events.ts:186`, Ruling R44); the noise is plain shells.

This document fixes the first. The second is a tuning change, covered in §7.

## 2. What a notification says

**Session title plus event kind.** `claude-code — agent is waiting`, grouped under the computer.

Chosen over including output or an agent's question. The complaint is that notifications are
*indistinguishable*, not that they are uninformative, and naming the session fixes exactly that at
the smallest privacy cost (§5).

## 3. How they collapse

**Group per computer, expandable.**

| Level | Content | Identity |
|---|---|---|
| Child | One per session: `<title> — <kind>` | `${fp}:${sessionId}` |
| Summary | `<computer name> · N sessions need attention` | `${fp}` |

A new event for a session **replaces** that session's child notification rather than adding one.
One session ringing looks like an ordinary notification; six look like one expandable group. This
also scales to multiple paired Macs — one group each.

## 4. Delivery: enrich, never replace, the delivery guarantee

**The relay keeps sending a normal notification push.** The OS therefore always displays
something. When the app's background task runs, it *replaces* that notification with the enriched,
grouped version.

This was chosen over data-only pushes deliberately. Data-only gives total control but depends on
Android waking the app — Doze, OEM battery management, a force-stopped app — and when it fails the
user gets **nothing**. For a product whose entire value is that the ring arrives, silence is the
one unacceptable failure mode.

So the degradation ladder is:

- **JS runs** → enriched, named, grouped.
- **JS does not run** → today's generic notification. No regression.

The visible cost is a brief flash of generic text before replacement when the app wakes slowly.
Accepted.

No protocol change. The push data payload already carries `{ computerFp, sessionId, kind }`
(`computer-do.ts:568`) — everything the client needs.

## 5. Session titles must be persisted, and that is new stored data

`useConnectionsStore` (`apps/mobile/src/store/connections.ts`) is a plain zustand store with **no
persistence**. Session titles live in memory only, so a backgrounded app cannot name a session
today. This is the constraint that makes the work non-trivial.

**A minimal map is persisted**: `fp → sessionId → { title, backend }`, written whenever the session
list changes, using the same `expo-sqlite/kv-store` the computer list already uses
(`apps/mobile/src/store/computers.ts`). Bounded — evict entries for sessions absent from the
latest list, and cap total entries per computer.

**This is terminal-derived content at rest on the phone, and it is new.** Today the phone holds
titles only in memory. `PRIVACY.md` must be updated to say so plainly: session *titles* (not
output, not commands) are stored locally on the phone so notifications can name the session; they
are never sent anywhere, and the relay still never sees them. The end-to-end guarantee is
unchanged — this is an endpoint storing its own plaintext — but the privacy document should not
have to be read charitably.

Titles are stored unencrypted in `kv-store`. Acceptable for a title; **do not** extend this store
to output or commands without revisiting the decision.

## 6. Behaviour details

- **Tap** opens that session: deep-link `/c/{fp}/s/{sid}`, using the existing response data path
  (`notifications/index.ts:62`). Tapping the summary opens the computer's session list.
- **Unknown title** — a session the phone has not seen (first run, or a session created while
  unpaired) falls back to the backend label if known (`iTerm2` / `tmux` / `Herdr`), else
  `Session`. Never show the raw session id: it is opaque and means nothing to the user.
- **Opening a session dismisses its notification** and decrements the group summary. Consistent
  with spec §11.3's attentive suppression: if you are looking at it, it is not waiting for you.
- **Foreground** behaviour is unchanged — spec §10.8's in-app toast, no OS banner.
- The `rings` channel and its emerald light colour are unchanged. Brand amber deliberately does
  not apply to in-app accents (brand spec §4).

## 7. Related, separate: the idle heuristic fires too readily

Not part of this design, recorded so the two are not confused. `idleQuietMs` at 4 s produces most
of the volume. Grouping (§3) hides that volume behind one tray entry, but the underlying churn
remains and the summary count will flicker.

Raising the default is a one-line change with no architecture behind it. **Recommended: 30 s.** It
should be decided and changed separately from this work, and ideally made settable via
`shellbell config set`, which today only accepts `relay`, `name` and `accent`.

## 8. Non-goals

- **iOS.** Needs a Notification Service Extension and the `mutableContent` capability, which was
  deliberately declined on 2026-09-19 (see the session record). There is also no iPhone to test on
  (`docs/before-first-release.md`). Android first; iOS when both change.
- **Output or agent questions in the notification body.** §2.
- **Any protocol change.** §4.
- **Multi-line input / bracketed paste.** Unrelated, still deferred.

## 9. Open

- Whether the summary count should mean "sessions with an unacknowledged event" or "events since
  last open". The former is simpler and matches "N sessions need attention"; assume it unless
  implementation shows otherwise.
- Whether a session's notification should auto-dismiss when the agent reports it resolved, rather
  than only on open. Desirable; needs a resolution signal that may not exist yet.
