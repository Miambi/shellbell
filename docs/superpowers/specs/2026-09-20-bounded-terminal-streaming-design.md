# Bounded terminal streaming

Date: 2026-09-20. Status: written design for review; not implemented.

## Requirement and scope

Source: Bilal approved viewport-first delivery, incremental screen changes,
byte-bounded snapshot/history transfers, backpressure, cancellation and bounded
mobile memory during the service-design discussion.

Opening a session must not download its entire history. Stream only the currently
viewed terminal's state, fetch older history when requested, and keep every queue
bounded. This is a protocol/agent/client workstream, not a mobile UI redesign.
It follows the existing service-hardening work; it does not replace the S1
pending-frame delivery fix or authorize a wholesale terminal-engine rewrite.

Keep the current end-to-end-encrypted relay transport. Direct peer-to-peer routing
is not part of this delivery. The relay must not assemble, decrypt or persist
terminal transfers. Preserve existing input acknowledgement semantics: screen
flow control must never introduce automatic replay of terminal input.

## Existing behavior versus changes

The current tracker already sends viewport snapshots followed by row/scroll/cursor
diffs. It sends snapshots again when resizing, resynchronizing or when a diff is
unsuitable. History is separately requested, currently up to 200 lines per page.
The client uses virtualized rendering and a 5,000-line history cap.

Missing protections: a line-count cap is not a byte cap, style stripping is not
a guaranteed size bound, snapshots are single messages, and send success is not
proof that a slow receiver is keeping up. Application queues and reassembly need
explicit byte budgets and cancellation boundaries.

Alternatives considered:

| Approach | Decision |
|---|---|
| Existing viewport/diff model with bounded transfer and flow control | Selected: preserves TUI rendering, backend abstractions and encryption |
| Raw PTY byte stream and a new terminal emulator on the phone | Not selected: substantially different backend and client architecture |
| Entire scrollback download or one message per character | Rejected: unnecessary data/memory or excessive per-message overhead |

## Delivery behavior

1. Subscribe to one session with a fresh subscription identifier.
2. Deliver the current viewport as the baseline, not the session's scrollback.
3. Apply subsequent row/scroll/cursor diffs only against the correct generation.
4. Fetch history when the user approaches the loaded history boundary, with one
   history request in flight per subscription.
5. On leaving the view, backgrounding, session removal or disconnect, cancel
   pending transfers and release subscription-local state.

A full viewport remains necessary for initialization and recovery. It is a
bounded terminal grid, not an image and not the whole session. Do not force a
desktop TUI into a phone-width terminal or silently resize the user's host pane.

## Proposed budgets for the upgraded transport

These are initial design constants, not measured performance claims. Keep them
centralized with tests and change them through an explicit design revision.

| Boundary | Budget |
|---|---|
| Serialized encrypted screen/history envelope | At most 32 KiB, including envelope and crypto overhead |
| Reassembled normalized viewport snapshot or diff | At most 512 KiB encoded CBOR |
| History response | At most 200 lines and 64 KiB encoded CBOR, whichever is smaller |
| Concurrent reassemblies per subscription | One screen transfer and one history transfer |
| Chunks per logical transfer | At most 32 |
| Unacknowledged screen/history envelopes per link | At most 4, sharing the 32 KiB envelope cap |
| Client history cache | At most 5,000 lines and 4 MiB of normalized encoded line data |
| No receive progress / assembly deadline | 5 seconds without progress / 15 seconds total |

Encoded-byte accounting is not the same as JavaScript heap consumption. Bound
decoded structures too: an upgraded viewport has at most 512 columns, 256 rows,
32,768 style runs and 131,072 Unicode code points in total, in addition to the
encoded byte bound. Individual run validation remains at least as strict as the
existing protocol. Measure actual memory under worst-case fixtures on device.
Reject excessive advertised sizes before allocation. Both sender and receiver
enforce these limits independently.

Size the actual encoded envelope, not string length or plaintext alone. A very
long or heavily styled row must not bypass limits merely because it is one line.
Attempt the existing explicit style-degradation fallback for an oversized screen;
if even the normalized plain viewport exceeds the logical bound, return a visible
unsupported-size error. Never silently cut off terminal text or retry forever.

## Chunking and consistent screen state

Small updates remain single messages. Larger logical transfers use bounded chunks
carrying a subscription ID, transfer ID, kind, screen generation or history cursor,
chunk index/count and declared total bytes. All transfer metadata stays inside
the encrypted payload; the relay remains an opaque frame forwarder.

Encode the bounded logical record once and chunk its bytes. The receiver verifies
chunk metadata, byte totals and completeness before decoding/applying the record.
Do not independently parse arbitrary UTF-8 fragments or splice partial styled
rows. The per-chunk encryption uses the existing per-connection keys and unique
envelope sequence numbers; never reuse an AEAD sequence/nonce to retry a chunk.

Apply snapshots atomically. During a transfer show a loading/updating state or
the prior complete viewport, not a half-old, half-new terminal. Do not apply a
diff against an incomplete baseline or mix generations. On stale/missing baseline,
discard the unusable transfer and request one bounded fresh snapshot.

A resubscription/re-handshake creates a new stream identity. Old chunks, history
responses and acknowledgements cannot mutate the replacement stream, even when
the same native session ID is reused.

## Backpressure, batching and priority

Use end-to-end bounded receive acknowledgements/credits for screen and history
traffic. Socket writability alone is insufficient: bytes can be queued in several
places before reaching the client. A receive acknowledgement releases transport
credit only after the receiver has validated and accepted data into bounded
storage; it does not mean a shell command completed or a screen was rendered.

Batch cumulative acknowledgements after four accepted envelopes or 500 ms,
whichever occurs first. Validate against the current subscription and sent range;
a fabricated future acknowledgement must not grant unlimited credit. Check
local socket buffering as an additional bound, not as a substitute for credits.

Stop producing transfers when credits are exhausted. Keep bounded current screen
state and a pending-refresh flag, not an unbounded FIFO of every repaint. Coalesce
unsent screen work to the newest reconstructible state; if intermediate diffs
are discarded, send a fresh baseline rather than applying a diff to the wrong
generation. New input/control work takes priority over history and unsent bulk
screen chunks, while honoring existing message rate limits.

Timeouts release incomplete state and surface stalled delivery. Recovery must be
bounded and event-driven; do not create a snapshot/retry loop while the peer is
unresponsive. A slow viewer must not block unrelated viewers or backend events.

Do not blindly reduce latency by emitting one message per character/run. Batch
changes within the existing frame interval and avoid sending no-op frames. Keep
frame-rate tuning separate from chunk size: chunking alone does not reduce bytes
and may increase Cloudflare's metered message count.

## History paging and memory

Responses identify the request/subscription and the returned absolute range,
with a continuation cursor and oldest-available marker. Compute the next cursor
from the range actually returned, not the requested 200-line count. Short pages
caused by the byte cap must still make progress without gaps or duplicates.

If one history line exceeds the page bound, report an explicit oversized-line
result and its cursor. Offer an intentional skip; do not silently truncate the
line, falsely claim history ended or repeatedly request the same impossible page.
Handle backend history truncation/reset separately from a temporarily empty page.

Keep live viewport state separate from the bounded history browsing window.
Evict history outside the user's current visible anchor; do not immediately evict
the just-requested older page merely to retain the newest cached history. Preserve
stable scroll position and keep rendering virtualized. Fetching older history
must never turn into automatic fetching of the entire session.

Cancellation invalidates late results locally and tells the sender to stop work
where possible. A backend RPC already in flight may finish, but its cancelled
result must not be queued or displayed. Backgrounding stops the view stream;
attention detection and generic notification routing continue independently.

## Compatibility and rollout

Negotiate the bounded-stream capability within the encrypted connection handshake
before sending any new message types. Feature negotiation is additive and must be
tested against the actual old parsers; protocol support cannot be inferred from
the app's display version or assumed because unknown fields appear harmless.

Updated endpoints use the new transport only when both advertise support. The
legacy path keeps existing snapshot/diff/history types and strict legacy frame
limits; it cannot claim the new 32 KiB/credit guarantees. If legacy limits cannot
represent a screen safely, fail visibly where the peer supports it and require
an upgrade rather than silently corrupting content or repeatedly flooding it.

The implementation plan must include the exact Zod schemas, negotiation tests,
old/new compatibility matrix and generated protocol documentation. Deliver agent
and client integration together behind negotiation; do not ship only half the
transport. The opaque relay should not require knowledge of chunk contents.

## Privacy and free-tier acceptance

- No terminal history, chunks, decrypted titles or input written at the relay.
- No new terminal content in push payloads, diagnostics, crash reports or metrics.
- Measure aggregate frame counts/bytes/latency without recording payloads or
  introducing a customer activity-history database.
- Benchmark complete open/check/respond/background cycles, including handshake,
  flow-control acknowledgements, history, notifications and reconnect overhead.
- Keep Cloudflare Workers Free as the deployment constraint; do not enable paid
  features, upgrade the account or promise a user count from frame arithmetic.
- Existing relay metadata remains a separate minimization review; this transport
  does not erase device names, push tokens or pairing records by itself.

## Test and release gates

Test large styled grids, multibyte/combining/wide characters, pathological long
rows, huge scrollback, resize/reset during transfer, missing/duplicate/stale chunks,
malicious sizes/acks, slow receivers, cancellation races and subscription reuse.
Verify exact text reconstruction, frame byte bounds, memory/queue bounds, cursor
progress and eventual quiet-frame delivery after budget pressure.

Exercise one slow client alongside healthy clients. Test that a terminal producing
output for hours with no viewer produces no screen stream, and that backgrounding
the app cancels capture/transfer demand. Live terminal/phone checks remain opt-in
and must not be represented as passing based on unit tests alone.

Run protocol/agent/client/relay compatibility tests, regenerated protocol-doc
checks, client crypto-vector checks and relevant workspace gates. Measure actual
device memory/scroll stability and usage before revising capacity estimates.
