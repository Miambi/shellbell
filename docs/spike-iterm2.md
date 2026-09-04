# Spike: iTerm2 API from Node — results (2026-09-04)

- Connection mode that works: `socketpath` (the agent will use this one).
  - The brief's default `unix-url` mode (`ws+unix://${encodeURI(SOCKET)}:/`) fails
    with `ENOENT` because the macOS socket path contains a space
    (`.../Library/Application Support/iTerm2/private/socket`): the WHATWG `URL`
    parser always percent-encodes that space to `%20` when computing `.pathname`,
    and `ws@8.21.3` splits that pathname on `:` and uses it verbatim as the
    filesystem socket path — it never decodes the `%20` back to a space, so the
    connect always targets a nonexistent path.
  - The brief's `socketpath` mode as literally written (passing `socketPath` in the
    `WebSocket` constructor's `options` alongside a plain `ws://localhost/` URL) is
    also dead code in `ws@8.21.3`: `initAsClient` unconditionally resets
    `opts.socketPath = undefined` after spreading the caller's options, and only
    ever sets it again by parsing a `ws+unix://` URL. Confirmed by reading
    `node_modules/ws/lib/websocket.js` and by the observed failure
    (`ECONNREFUSED 127.0.0.1:80` / `::1:80` — it fell back to a normal TCP
    connection to `localhost:80`, proving the socket path was discarded).
  - Fix applied in `apps/agent/scripts/spike-iterm2.ts`: `socketpath` mode now uses
    `ws`'s documented `createConnection` hook to dial the real Unix domain socket
    directly (`createConnection: () => netConnect({ path: SOCKET })`), bypassing URL
    parsing entirely. This is a targeted fix to the connect() function only — the
    rest of the spike script is unchanged from the brief. Verified with a
    standalone repro before patching: the same approach got an `HTTP 400`
    unexpected-response from iTerm2 (i.e. reached the real socket) instead of
    `ENOENT`/`ECONNREFUSED`.
- iTerm2 version: 3.6.11. Consent dialog seen: yes (the human clicked "Allow" on
  iTerm2's "Allow Shellbell to control iTerm2?" dialog; two earlier unattended
  attempts each hung for the full ~120s AppleEvent timeout and failed with
  `AppleEvent timed out. (-1712)` before the human answered it).
- Sessions listed: 2. First session grid: 179x43 (second session: 213x53).
- GetBuffer (screen only, styles on) latency over 20 calls: p50 = 2.2 ms, p95 = 8.7 ms,
  max = 8.7 ms (a first, otherwise-identical run measured p50 = 2.2 ms, p95 = 8.2 ms,
  max = 8.2 ms — consistent).
  Spec 14/18.2: p50 (2.2 ms) is well under 40 ms, so `MIN_FRAME_MS` does **not** need
  to be raised to 200 in the relay config.
- SendText with `"\r"`: the API call succeeded (`sendTextResponse` status `OK`), and
  a follow-up `GetBuffer` call confirmed `echo shellbell-spike-ok` landed in the
  target session's buffer (`› echo shellbell-spike-ok` visible as the last input
  line). It did **not** produce a new plain-shell prompt line, because the first
  session in the list happened to be running an interactive TUI program (a Codex
  CLI session) rather than a bare shell — the `\r` was accepted into that program's
  input box (shown queued, "tab to queue message") instead of executing a shell
  `echo` command. This is a property of which session was first in the list, not of
  `SendText` itself; `SendText`/`\r` is expected to reach a normal shell prompt
  (produce a new prompt line) when the target session is a plain shell. Not retried
  with `\n` since the API-level goal (text delivered to the session) was met, and
  the brief's ruling was to do the send exactly once.
- Fixtures: `apps/agent/test/fixtures/getbuffer-1788542830080.json`,
  `apps/agent/test/fixtures/listsessions-1788542830080.json`.
  Reviewed for secrets before committing: yes — scanned all string fields for API
  key/token patterns (`sk-`, `ghp_`, `gho_`, AWS `AKIA...`, Slack `xox...`, PEM
  private key headers, `Bearer ...`, generic `password=`/`api_key=` patterns) and
  for IP addresses. None matched. The scrollback did, however, reveal a real client
  project name and internal tooling/container names (this repo is MIT/public), so
  every `"text"` field (getbuffer) and `"title"` field (listsessions) was sanitized
  with a one-off script: each ASCII letter `[A-Za-z]` → `x` and each ASCII digit
  `[0-9]` → `0`, leaving all other characters (spaces, punctuation, non-ASCII glyphs
  like `›` and box-drawing characters, emoji) untouched, so string length and
  `code_points_per_cell`/`style` runs stay valid. No other fields were touched. The
  second-run fixture pair (`*-1788542835682.json`, from the `ITERM2_SPIKE_SEND=1`
  run) was deleted rather than sanitized, since the first pair already demonstrates
  everything needed.
