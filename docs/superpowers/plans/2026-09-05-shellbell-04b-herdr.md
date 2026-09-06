# Shellbell Plan 04b — Herdr backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panes owned by [Herdr](https://herdr.dev) — the Rust runtime that hosts coding agents (Claude Code, Codex, Cursor, OpenCode, …) — appear in the Shellbell app next to iTerm2 sessions, stream styled screens, accept input, can be created and focused from the phone, and **ring the phone the moment an agent goes `blocked`** ("An agent is waiting for you"). Herdr is the third `TerminalBackend`; it runs alongside iTerm2 and tmux with no de-duplication rule.

**Architecture:** `HerdrClient` owns the transport: newline-delimited JSON over a Unix socket with **one request per connection**, plus one long-lived `events.subscribe` connection. `convert.ts` turns a `pane.read {format:"ansi"}` snapshot into `Line[]` with `parseSgrLine`. `HerdrBackend` implements `TerminalBackend` on top of both. Its central rule — forced by the fact that **Herdr events carry no revision or sequence number** — is that **`session.snapshot` is the only writer of the pane map**: lifecycle events are *hints* that schedule one debounced, single-flight snapshot refresh, and only `pane.agent_status_changed` is applied directly (its payload *is* the new value). Screen changes have no push at all, so an adaptive `pane.copy_motion` revision poller runs for the panes a phone is viewing (new `TerminalBackend.setWatched?` hook, driven by `ScreenTracker`). Losing the socket emits `session-removed` for every Herdr pane and flips `connected` to `false`, so the registry drops Herdr from `hello.backends` and reconnect re-adds the panes as fresh sessions.

**Tech Stack:** Node 22, TypeScript 5.9, `@shellbell/protocol` (`parseSgrLine`, `stringCells`, `emptyLine`), vitest 5, `node:net` (no new runtime dependency). Herdr ≥ 0.7.2 on the user's machine — never installed by this plan.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — **§8.13** (authority for this plan; revised 2026-09-05 after external review), plus §8.4 (`TerminalBackend`, `AgentState`, `setWatched?`, `isConnected?`), §8.6 (tracker), §8.8 (events and ringing), §8.12 (registry, `hello` on backend-set change, per-session capabilities), §7.3/§7.4 (wire protocol), §7.5 (named keys), §9.2/§11.3 (push bodies), §10.5 (badges, unknown enums are opaque), §15 (testing). Plan 03 is complete and shipped **through commit `5601537`** (Task 11 landed at `6bb2a53`, followed by six fix/hardening commits: `9efd19a`, `d349b99`, `5e22a2c`, `0e11af5`, `b8b8b70`, `9ba0fc1`, `55c53bd`, `5601537`); Plan 04 (tmux) is **not** required. The verified Herdr research report is `.superpowers/research/herdr-socket-api.md` — every JSON shape in this plan comes from it.

> **⚠ Read these shipped files before editing them** (they changed *after* this plan was first drafted, and the tasks below are written against `5601537`, not against the older snapshot):
> - `apps/agent/src/cli.ts` — `buildAgent` now returns `releaseOutput` **and** `stopFirstConnect`; `start` destructures both; the SIGINT/SIGTERM handler carries a `shuttingDown` double-Ctrl-C guard and calls `shutdown(agent, control, process.exit, stopFirstConnect).catch(…)`; `onSuperseded` calls `shutdown(…, stopFirstConnect)`; every backend startup line goes through the buffered `print()` closure and is flushed by `releaseOutput()` so it cannot interleave with spec 8.1's exact-text header block. **Task 6 only inserts into this code; it never replaces it.**
> - `apps/agent/src/screen-tracker.ts` — per-session `absoluteLines` **already shipped**: `processScreen` computes `this.opts.backend.capabilitiesOf?.(sessionId)?.absoluteLines ?? this.opts.backend.capabilities.absoluteLines`. Task 6 adds only the watched-set plumbing.
> - `apps/agent/src/backends/types.ts` — `TerminalBackend` already has `capabilitiesOf?(sessionId): Capabilities | null`.
> - `apps/agent/src/backends/registry.ts` — `BackendRegistry.capabilitiesOf(id)` already exists; only `splitId`, `listSessions`, `connected()` and the new `setWatched` change.
> - `apps/agent/src/agent.ts` — the `safe()` wrapper, `refreshSessions`, `scheduleSessions` and the `hello`/`sessions` handshake broadcast are all shipped; Task 5 edits three specific spots and nothing else.
> - `apps/agent/src/doctor.ts` (`Check` shape), `apps/agent/test/fakes/fake-backend.ts`, `apps/agent/test/{events,screen-tracker,registry,doctor}.test.ts` (existing helpers and describes).

## Global Constraints

- All Plan 01/03 constraints apply. **No new runtime dependency**: the Herdr transport is `node:net` + `JSON`. Nothing from Herdr is vendored — no schema file, no code (spec 8.13 "Licensing"); the wire types in `src/backends/herdr/types.ts` are hand-written from the research report. Say "works with Herdr"; never use Herdr branding in a product name.
- **Steps marked "Human-run only" are never executed by implementers.** An implementer who reaches such a step records "not run (human-run only)" and moves on.
- **Never install Herdr in an implementer step.** `curl … | sh` appears in this plan only inside user-facing hint strings and inside Task 7, which is Human-run only. Implementers never run it, never start a `herdr` server, and never touch `~/.config/herdr/`. Every automated test in this plan talks to a **fake Herdr server on a temp Unix socket**.
- Plan code blocks may exceed Biome's 100-column limit; implementers wrap lines (`pnpm lint:fix`) without changing semantics. `pnpm lint` must pass before every commit.
- Never log keys, cookies, pairing codes, terminal content, or input text. `pane.read` text, `pane.send_text` text and pane titles are terminal content: log **lengths** and ids only. The fixtures committed by Task 7 must be sanitized by the human who captures them.
- **Snapshot-only membership.** Herdr events carry no revision, so ordering an event against a snapshot is impossible. `applySnapshot` is the only code that adds, removes or re-identifies a pane; every lifecycle event just calls `scheduleSync("snapshot")`. The two exceptions are **per-pane values on a pane that already exists**: `pane.agent_status_changed` (latest-wins) and `pane.scroll_changed` (scroll metrics). Never add or drop a pane from an event handler, and never let a handler schedule the sync that produced it.
- Timers: Herdr request timeout **5 s**; `events.subscribe` ack timeout **5 s**; reconnect poll after the socket dies **2 s, fixed** (spec 8.13 — *not* the iTerm2 exponential backoff); sync debounce **250 ms**; revision poll **adaptive 200 ms → 500 ms after 5 s unchanged → 1000 ms cap**; scroll-metric refresh at most **1/s per pane**; backend detection retry while Herdr is absent **10 s** (spec 8.12). Every one is an option with these defaults so tests can shrink it.
- Tests use a real Unix socket under `mkdtempSync(join(tmpdir(), …))` and **real** timers with short intervals plus `waitFor` from `test/fakes/wait.ts` (a **synchronous** predicate). Do not mix `vi.useFakeTimers()` with live sockets.
- The agent package is named **`shellbell`**. Run its tests with `pnpm -F shellbell test`. Bound every test command: `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.
- Session ids leaving the registry are `"<backend>:<native>"`. The Herdr native id is the pane's **`terminal_id`** (`term_abc123`), never the positional `pane_id` (`w1:p1`), which Herdr reassigns across restarts and `pane.move`.
- Commit after every task with `type(scope): summary`.

---

## File structure created by this plan

```
packages/protocol/
├── src/inner.ts            (modified) BackendName += "herdr"; SessionInfo.state += "blocked"
├── src/ctrl.ts             (modified) EventKind += "blocked"; notify.kind += "blocked"
└── test/messages.test.ts   (modified) round-trip the new enum members

apps/relay/
├── src/push.ts             (modified) pushBody("blocked") = "An agent is waiting for you"
└── test/push.test.ts       (modified)

apps/agent/
├── package.json            (modified) "spike:herdr" script
├── scripts/spike-herdr.ts  Human-run capture script
├── src/
│   ├── agent.ts            (modified) hello on backend-set change; state merge; agent-state
│   ├── cli.ts              (modified) start the herdr detector; banner line; shutdown
│   ├── doctor.ts           (modified) herdr check (absent = passing, optional)
│   ├── events.ts           (modified) agent-state -> blocked/prompt rings
│   ├── screen-tracker.ts   (modified) push the viewed set via setWatched
│   │                       (per-session absoluteLines ALREADY SHIPPED — do not re-add)
│   └── backends/
│       ├── types.ts        (modified) AgentState, agent-state event, setWatched?, isConnected?
│       ├── registry.ts     (modified) herdr routing; connected() filter; setWatched fan-out
│       └── herdr/
│           ├── types.ts    hand-written Herdr wire shapes
│           ├── client.ts   HerdrClient, HerdrError, socket discovery, semver gate, subscribe
│           ├── convert.ts  ANSI read -> Screen (faked, clamped cursor)
│           ├── keys.ts     NamedKey bytes -> herdr key names
│           ├── backend.ts  HerdrBackend
│           └── start.ts    checkHerdr() + startHerdrBackend()
└── test/
    ├── fakes/fake-herdr.ts        fake Herdr server (one request per connection, NDJSON,
    │                              per-stream subscription filtering, restartable)
    ├── herdr-client.test.ts  herdr-convert.test.ts  herdr-backend.test.ts
    ├── herdr-start.test.ts   herdr-agent.test.ts    live-herdr.test.ts
    └── fixtures/herdr-ping.json  herdr-session-snapshot.json
        herdr-pane-read-visible.json  herdr-pane-read-recent.json
        herdr-agent-status-event.json  herdr-copy-motion.json

docs/
├── spike-herdr.md          Human-run spike results
├── self-hosting.md         (modified) "works with Herdr"
└── ../README.md            (modified) "works with Herdr"
```

---

### Task 1: Protocol and relay — the `herdr` backend name and the `blocked` ring (spec 8.13, 7.3, 7.4, 9.2, 11.3)

**Files:**
- Modify: `packages/protocol/src/inner.ts`, `packages/protocol/src/ctrl.ts`, `packages/protocol/test/messages.test.ts`
- Modify: `apps/relay/src/push.ts`, `apps/relay/test/push.test.ts`

**Interfaces (after this task):**
- `BackendNameSchema = z.enum(["iterm2", "tmux", "herdr"])`
- `SessionInfoSchema.state = z.enum(["unknown", "editing", "running", "finished", "blocked"])`
- `EventKindSchema = z.enum(["prompt", "idle", "exit", "blocked"])`
- ctrl `notify.kind = z.enum(["prompt", "idle", "blocked"])`
- `pushBody("blocked") === "An agent is waiting for you"`

**Compatibility note (spec 10.5):** widening these enums is a **one-way** change — a phone built
before this plan rejects `backend: "herdr"`, `state: "blocked"` and `kind: "blocked"` at the Zod
boundary and would drop the whole `sessions` frame. Spec §10.5 now requires the app to treat an
unrecognised `backend`/`state`/`event.kind` as an opaque string (generic badge). Implementing that
is Plan 05's job, not this plan's; **do not** ship a Herdr-enabled agent to a phone older than that
change. Record it in the task report.

**Golden vectors:** `packages/protocol/test/vectors.json` encodes only crypto material plus the
single plaintext `{"type":"input.line","reqId":"r1","sessionId":"iterm2:x","text":"y"}` (see
`packages/protocol/scripts/gen-vectors.ts`). **No vector encodes `BackendName`, `EventKind`,
`notify.kind` or `SessionInfo.state`, so no vector is regenerated by this plan.** Step 4 proves it.

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/test/messages.test.ts`, add to the ctrl `ok` array (after the existing
`notify` entry):

```ts
      { type: "notify", sessionId: "herdr:term_a", kind: "blocked" },
```

add to the inner `ok` array (after the existing `event` entry):

```ts
      { type: "event", sessionId: "herdr:term_a", kind: "blocked", at: 1 },
      {
        type: "sessions",
        list: [
          {
            id: "herdr:term_a",
            backend: "herdr",
            title: "Claude Code",
            cols: 80,
            rows: 24,
            windowId: "herdr:w1",
            windowNumber: 1,
            tabId: "herdr:w1:t1",
            tabIndex: 0,
            paneIndex: 0,
            isFocusedOnMac: false,
            state: "blocked",
          },
        ],
      },
      { type: "session.create", reqId: "r10", in: { kind: "tab", backend: "herdr" } },
```

and add a rejection case to the inner "rejects …" test:

```ts
    expect(() =>
      parseInner({ type: "session.create", reqId: "r", in: { kind: "tab", backend: "kitty" } }),
    ).toThrow(/malformed/);
```

In `apps/relay/test/push.test.ts`, extend the "formats durations and bodies" test:

```ts
    expect(pushBody("blocked")).toBe("An agent is waiting for you");
    expect(pushBody("exit")).toBe("A session needs attention");
```

and add an end-to-end push test next to the existing ones (it proves a `blocked` ring survives the
whole relay path, which no other test covers):

```ts
  it("pushes the blocked body for a blocked notify", async () => {
    const { sent } = installFetchStub();
    // `pairedWithToken()` leaves the phone connected with NO lease, and the DO only treats a phone
    // as attentive while `leaseUntil > now` -- so this really is pushed.
    const { mac, agent, p } = await pairedWithToken();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "herdr:term_a", kind: "blocked" });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      body: "An agent is waiting for you",
      data: { sessionId: "herdr:term_a", kind: "blocked" },
    });
    // Close both sockets, exactly like every sibling test in this file.
    agent.ws.close();
    p.ws.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/protocol test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/relay test
```
Expected: the protocol suite fails on `backend: "herdr"` / `kind: "blocked"` / `state: "blocked"`;
the relay suite fails on the `"blocked"` body.

- [ ] **Step 3: Implement**

`packages/protocol/src/inner.ts` — two lines change:

```ts
export const BackendNameSchema = z.enum(["iterm2", "tmux", "herdr"]);
```

```ts
  // spec 8.13: `blocked` is Herdr's "an agent is waiting for a human" state. It is a first-class
  // session state, not a flavour of `running`: the app renders it differently and it rings.
  state: z.enum(["unknown", "editing", "running", "finished", "blocked"]),
```

`packages/protocol/src/ctrl.ts` — two changes:

```ts
export const EventKindSchema = z.enum(["prompt", "idle", "exit", "blocked"]);
```

```ts
  z.object({
    type: z.literal("notify"),
    sessionId: z.string().min(1).max(128),
    kind: z.enum(["prompt", "idle", "blocked"]),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
```

`apps/relay/src/push.ts` — add one case to `pushBody`, above `default`:

```ts
    case "blocked":
      // spec 8.13/11.3: deliberately generic — the relay never learns which agent, which
      // session title, or what it is asking.
      return "An agent is waiting for you";
```

- [ ] **Step 4: Run the tests, and prove no golden vector changed**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/protocol test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/relay test
grep -c -e '"backend"' -e '"kind"' -e '"state"' packages/protocol/test/vectors.json || true
git diff --stat packages/protocol/test/vectors.json
```
Expected: both suites pass; the `grep -c` prints `0`; the `git diff --stat` prints nothing. If the
grep is ever non-zero, run `pnpm -F @shellbell/protocol gen:vectors` and commit the regenerated file
with an explanation — it is not expected here.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol apps/relay
git commit -m "feat(protocol): add the herdr backend name and the blocked event kind"
```

---

### Task 2: `HerdrClient` — NDJSON socket transport (spec 8.13 "Discovery and transport")

**Files:**
- Create: `apps/agent/src/backends/herdr/types.ts`, `apps/agent/src/backends/herdr/client.ts`
- **Modify: `apps/agent/src/backends/types.ts`** — this task adds `AgentState`, the `agent-state`
  `BackendEvent` variant, `TerminalBackend.setWatched?` and `TerminalBackend.isConnected?`. Do it in
  Step 3, **before** writing `herdr/types.ts`, which imports `AgentState` from it.
- Create: `apps/agent/test/fakes/fake-herdr.ts`, `apps/agent/test/herdr-client.test.ts`

**Interfaces:**
- `herdrSocketPath(env?, home?): string` — `$HERDR_SOCKET_PATH` → (`$HERDR_SESSION` set)
  `<config>/herdr/sessions/<name>/herdr.sock` → `<config>/herdr/herdr.sock`, where `<config>` is
  `$XDG_CONFIG_HOME` or `~/.config`.
- `class HerdrError extends Error { readonly code: string }` — `code` is Herdr's own error code
  (`not_found`, `pane_not_found`, `stale_pane_target`, `agent_not_idle`, `invalid_params`, …) or one
  of ours: `timeout`, `unavailable`, `closed`, `malformed`, `overflow`, `socket`.
- `GONE_CODES: Set<string>`, `UNSUPPORTED_CODES: Set<string>`, `MIN_VERSION`, `INSTALL_HINT`,
  `UPGRADE_HINT`, `semverAtLeast(version, min): boolean | null` (`null` = unparseable).
- `interface HerdrStream { close(): void }`,
  `interface HerdrStreamHandlers { onEvent(e: HerdrEvent): void; onEnd(reason: string): void }`.
- `class HerdrClient { constructor(opts: { log: Logger; socketPath?: string; requestTimeoutMs?: number }); get socketPath: string; request<T>(method, params?): Promise<T>; subscribe(subscriptions, handlers): Promise<HerdrStream>; ping(): Promise<Pong> }`.

**Rulings this task pins:**

| Ruling | What it means here |
|---|---|
| 12 | The version gate is **semver ≥ 0.7.2** on `ping.version`, never `protocol` (that number is Herdr's *binary* client/server generation). An unparseable version is accepted with a warning; the `session.snapshot` feature probe (Task 4/6) is the real second gate. |
| 13 | Socket discovery honours `HERDR_SESSION`. |
| 16 | Wire shapes match the research exactly: fields the research lists as required are required. |
| 17 | The line limit is counted in **bytes** and only against an incomplete line; a post-ack oversized line ends the stream with an error; a pre-ack EOF rejects immediately instead of waiting out the 5 s timeout. |
| 22 | `subscribe()` rejects the moment the socket closes before the ack. |

- [ ] **Step 1: Write the fake Herdr server**

`apps/agent/test/fakes/fake-herdr.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

interface Stream {
  socket: Socket;
  /** Subscription entries this connection asked for, verbatim. */
  subscriptions: { type: string; pane_id?: string }[];
}

/**
 * Stand-in for the Herdr socket server. It models the transport facts that shape our client
 * (research §1): **one request per connection** — the server reads exactly one line, answers it and
 * hangs up — NDJSON framing, and an `events.subscribe` connection that stays open, acks with
 * `subscription_started`, and then streams bare `{"event":…,"data":…}` lines carrying no `id`.
 * Events are delivered only to streams that actually subscribed to them, so subscription bugs
 * surface in tests instead of being papered over.
 */
export class FakeHerdr {
  readonly dir = mkdtempSync(join(tmpdir(), "sb-herdr-"));
  readonly path: string;
  readonly requests: FakeHerdrRequest[] = [];
  /** Lines written on a connection after its first one: the real server never reads them. */
  readonly ignoredLines: string[] = [];
  connections = 0;
  /** What `pane.copy_motion` reports as `content_revision`; tests bump it. */
  revision = 2;
  /**
   * Events to write in the SAME buffer as the next `events.subscribe` ack. A real server can
   * coalesce the ack and the first event lines into one TCP chunk; this is how a test reproduces
   * that exactly, instead of writing them separately and calling it a coalesced chunk.
   */
  readonly ackRider: { event: string; data: Record<string, unknown> }[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly failures = new Map<string, { code: string; message: string }>();
  private readonly silenced = new Set<string>();
  private readonly streams = new Set<Stream>();
  /**
   * EVERY accepted connection, not just the event streams. `stop()` must destroy all of them:
   * `server.close()` only stops accepting and its callback fires when the last connection ends,
   * so a connection the fake never answered (`silence()`) would otherwise wedge `stop()` forever.
   */
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  /** `path` lets a test bind a chosen socket file (one that does not exist yet, or a restart). */
  constructor(path?: string) {
    this.path = path ?? join(this.dir, "herdr.sock");
  }

  reply(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, fn);
    this.failures.delete(method);
    this.silenced.delete(method);
  }
  fail(method: string, code: string, message = code): void {
    this.failures.set(method, { code, message });
  }
  /** Accept the request and never answer it — drives the timeout tests. */
  silence(method: string): void {
    this.silenced.add(method);
  }
  called(method: string): FakeHerdrRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
  get streamCount(): number {
    return this.streams.size;
  }
  /** The subscription list of the most recently opened stream. */
  get lastSubscriptions(): { type: string; pane_id?: string }[] {
    return [...this.streams].at(-1)?.subscriptions ?? [];
  }

  /** Deliver an event to every stream that subscribed to it (dotted subscription names). */
  pushEvent(event: string, data: Record<string, unknown> = {}): number {
    const dotted = event.replaceAll("_", ".");
    const line = `${JSON.stringify({ event, data })}\n`;
    let delivered = 0;
    for (const s of this.streams) {
      const match = s.subscriptions.some(
        (sub) =>
          (sub.type === event || sub.type === dotted) &&
          (sub.pane_id === undefined || sub.pane_id === data.pane_id),
      );
      if (!match) continue;
      s.socket.write(line);
      delivered++;
    }
    return delivered;
  }
  /** Write a raw line to every stream, bypassing subscription filtering (framing tests). */
  pushRaw(line: string): void {
    this.pushBytes(Buffer.from(line, "utf8"));
  }
  /** Write raw bytes to every stream — lets a test choose exactly where a chunk is split. */
  pushBytes(bytes: Buffer): void {
    for (const s of this.streams) s.socket.write(bytes);
  }
  /** `herdr server stop`: every open connection dies with EOF. */
  dropStreams(): void {
    for (const s of this.streams) s.socket.destroy();
    this.streams.clear();
  }

  start(): Promise<void> {
    const server = createServer((socket) => {
      this.connections++;
      this.sockets.add(socket);
      let first = true;
      let buf = "";
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (first) {
            first = false;
            this.dispatch(socket, line);
          } else {
            this.ignoredLines.push(line);
          }
          i = buf.indexOf("\n");
        }
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        for (const s of this.streams) if (s.socket === socket) this.streams.delete(s);
      });
    });
    this.server = server;
    return new Promise((resolve) => server.listen(this.path, () => resolve()));
  }

  /**
   * Closes the listener and removes the socket file, exactly like a herdr server exiting.
   *
   * Every accepted connection is destroyed first — not just the registered event streams. A
   * connection parked by `silence()` was never added to `streams`, and `server.close()` waits for
   * the last connection to end before firing its callback, so without this `stop()` never resolves
   * and the test (plus its `afterEach`) hangs.
   */
  stop(): Promise<void> {
    this.dropStreams();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private dispatch(socket: Socket, line: string): void {
    let msg: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      socket.end();
      return;
    }
    const method = msg.method ?? "";
    const params = msg.params ?? {};
    this.requests.push({ method, params });
    if (this.silenced.has(method)) return;
    const failure = this.failures.get(method);
    if (failure) {
      socket.end(`${JSON.stringify({ id: msg.id, error: failure })}\n`);
      return;
    }
    if (method === "events.subscribe") {
      const subscriptions = (params.subscriptions ?? []) as { type: string; pane_id?: string }[];
      this.streams.add({ socket, subscriptions });
      // NB: `events.subscribe` is handled HERE, before `this.handlers` is consulted, so a
      // `reply("events.subscribe", …)` would be dead code. `fail("events.subscribe", …)` above
      // still works, and `ackRider` is how a test makes the ack share a chunk with its events.
      let out = `${JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })}\n`;
      for (const e of this.ackRider.splice(0)) out += `${JSON.stringify(e)}\n`;
      socket.write(out); // ONE write: ack + riders land in the same chunk
      return;
    }
    const handler = this.handlers.get(method) ?? this.defaultHandler(method);
    const value = handler(params);
    // A handler may answer with an error for SOME parameters by returning `{ __error: {…} }`
    // (e.g. `pane.read` refusing only `source:"recent"`), which `fail()` cannot express.
    if (value && typeof value === "object" && "__error" in value) {
      const error = (value as { __error: { code: string; message?: string } }).__error;
      socket.end(`${JSON.stringify({ id: msg.id, error })}\n`);
      return;
    }
    socket.end(`${JSON.stringify({ id: msg.id, result: value })}\n`);
  }

  private defaultHandler(method: string): (params: Record<string, unknown>) => unknown {
    switch (method) {
      case "ping":
        return () => ({
          type: "pong",
          version: "0.8.2",
          protocol: 22,
          capabilities: { live_handoff: true, detached_server_daemon: true },
        });
      case "pane.copy_motion":
        return (p) => ({
          type: "pane_copy_motion",
          pane_id: p.pane_id,
          cursor: p.cursor,
          content_revision: this.revision,
        });
      default:
        return () => ({ type: "ok" });
    }
  }
}
```

- [ ] **Step 2: Write the failing client tests**

`apps/agent/test/herdr-client.test.ts`:

```ts
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HerdrClient,
  HerdrError,
  herdrSocketPath,
  semverAtLeast,
} from "../src/backends/herdr/client.js";
import { BackendUnavailable } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let herdr: FakeHerdr;

beforeEach(async () => {
  herdr = new FakeHerdr();
  await herdr.start();
});
afterEach(async () => {
  await herdr.stop();
});

const client = (timeoutMs = 500) =>
  new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: timeoutMs });

describe("herdrSocketPath", () => {
  it("prefers HERDR_SOCKET_PATH, then HERDR_SESSION, then XDG, then ~/.config", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/tmp/x.sock" }, "/home/u")).toBe("/tmp/x.sock");
    expect(herdrSocketPath({ HERDR_SESSION: "work" }, "/home/u")).toBe(
      "/home/u/.config/herdr/sessions/work/herdr.sock",
    );
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg", HERDR_SESSION: "work" }, "/home/u")).toBe(
      "/cfg/herdr/sessions/work/herdr.sock",
    );
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/herdr/herdr.sock");
    expect(herdrSocketPath({}, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
  });
});

describe("semverAtLeast", () => {
  it("compares numerically and reports unparseable versions as null", () => {
    expect(semverAtLeast("0.8.2", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.2", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.10", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.10.0", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("0.7.1", [0, 7, 2])).toBe(false);
    expect(semverAtLeast("0.6.9", [0, 7, 2])).toBe(false);
    expect(semverAtLeast("1.0.0-rc.1", [0, 7, 2])).toBe(true);
    expect(semverAtLeast("master", [0, 7, 2])).toBeNull();
  });
});

describe("HerdrClient.request", () => {
  it("uses one connection per request and never pipelines", async () => {
    const c = client();
    herdr.reply("pane.get", (p) => ({ type: "pane_info", pane: { pane_id: p.pane_id } }));
    const a = await c.request<{ type: string }>("ping", {});
    const b = await c.request<{ type: string; pane: { pane_id: string } }>("pane.get", {
      pane_id: "w1:p1",
    });
    expect(a.type).toBe("pong");
    expect(b.pane.pane_id).toBe("w1:p1");
    expect(herdr.connections).toBe(2);
    expect(herdr.ignoredLines).toEqual([]);
  });

  it("maps a herdr error response onto HerdrError with its code", async () => {
    herdr.fail("pane.read", "pane_not_found", "pane not found");
    await expect(client().request("pane.read", { pane_id: "w9:p9" })).rejects.toMatchObject({
      name: "HerdrError",
      code: "pane_not_found",
    });
  });

  it("accepts a response whose id does not echo ours, and rejects a missing result", async () => {
    // One request per connection means the id is decorative; a mismatch must not deadlock us.
    herdr.reply("pane.get", () => ({ type: "pane_info", pane: { pane_id: "w1:p1" } }));
    await expect(client().request("pane.get", {})).resolves.toMatchObject({ type: "pane_info" });
    herdr.reply("session.snapshot", () => undefined);
    await expect(client().request("session.snapshot", {})).rejects.toMatchObject({
      code: "malformed",
    });
  });

  it("times out a request the server never answers", async () => {
    herdr.silence("session.snapshot");
    const err = await client(120)
      .request("session.snapshot", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("timeout");
  });

  it("reports a missing socket as `unavailable`", async () => {
    const c = new HerdrClient({ log, socketPath: join(herdr.dir, "gone.sock") });
    await expect(c.request("ping", {})).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("HerdrClient.ping", () => {
  it("returns the pong for a supported version", async () => {
    const pong = await client().ping();
    expect(pong).toMatchObject({ version: "0.8.2", protocol: 22 });
  });

  it("refuses an old herdr by VERSION, not by protocol number", async () => {
    // protocol 22 with an old version must still be refused: `protocol` is herdr's binary
    // client/server generation, not a JSON-API compatibility floor.
    herdr.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 22 }));
    const err = await client()
      .ping()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).message).toMatch(/0\.6\.9/);
    expect((err as BackendUnavailable).hint).toMatch(/0\.7\.2/);
  });

  it("accepts an unparseable version and lets the feature probe decide", async () => {
    herdr.reply("ping", () => ({ type: "pong", version: "dev-master", protocol: 3 }));
    await expect(client().ping()).resolves.toMatchObject({ version: "dev-master" });
  });

  it("turns a missing socket into BackendUnavailable with the install hint", async () => {
    const c = new HerdrClient({ log, socketPath: join(herdr.dir, "gone.sock") });
    const err = await c.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).hint).toMatch(/curl -fsSL https:\/\/herdr\.dev\/install\.sh/);
  });
});

describe("HerdrClient.subscribe", () => {
  it("resolves on the ack, streams bare event lines, and reports EOF", async () => {
    const events: string[] = [];
    const ends: string[] = [];
    const stream = await client().subscribe(
      [{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      {
        onEvent: (e) => events.push(`${e.event}:${String(e.data.pane_id ?? "")}`),
        onEnd: (reason) => ends.push(reason),
      },
    );
    await waitFor(() => herdr.streamCount === 1);
    herdr.pushEvent("pane_created", { pane_id: "w1:p4" });
    herdr.pushEvent("pane.agent_status_changed", { pane_id: "w1:p1", agent_status: "blocked" });
    // Not subscribed for this pane: the fake must not deliver it.
    expect(herdr.pushEvent("pane.agent_status_changed", { pane_id: "w9:p9" })).toBe(0);
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["pane_created:w1:p4", "pane.agent_status_changed:w1:p1"]);

    herdr.dropStreams();
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual(["eof"]);
    stream.close();
  });

  it("delivers an ack and an event that arrive in one chunk", async () => {
    // The ack and the first event really do share ONE TCP chunk here (`ackRider` makes the fake
    // emit them in a single `socket.write`). The event must not be lost, and it must reach
    // `onEvent` even though `pipeLines` runs it before the caller's `await` below resumes --
    // which is exactly why `subscribe`'s contract says the caller must arm its buffer first.
    const events: string[] = [];
    herdr.ackRider.push({ event: "pane_created", data: { pane_id: "w1:p9" } });
    const stream = await client().subscribe([{ type: "pane.created" }], {
      onEvent: (e) => events.push(e.event),
      onEnd: () => undefined,
    });
    await waitFor(() => events.length === 1);
    expect(events).toEqual(["pane_created"]);
    stream.close();
  });

  it("splits coalesced lines and reassembles a UTF-8 sequence torn across chunks", async () => {
    const events: string[] = [];
    const stream = await client().subscribe([{ type: "pane.updated" }], {
      onEvent: (e) => events.push(String(e.data.title ?? "")),
      onEnd: () => undefined,
    });
    await waitFor(() => herdr.streamCount === 1);
    // Two complete NDJSON lines in one buffer, split mid-way through the last multi-byte
    // character: `chunk.toString()` would corrupt it, `StringDecoder` must not.
    const bytes = Buffer.from(
      `${JSON.stringify({ event: "pane_updated", data: { title: "one" } })}\n` +
        `${JSON.stringify({ event: "pane_updated", data: { title: "漢字" } })}\n`,
      "utf8",
    );
    const cut = bytes.length - 4; // lands inside the final wide character's bytes
    herdr.pushBytes(bytes.subarray(0, cut));
    herdr.pushBytes(bytes.subarray(cut));
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["one", "漢字"]);
    stream.close();
  });

  it("reports `closed` when we close the stream ourselves", async () => {
    const ends: string[] = [];
    const stream = await client().subscribe([], {
      onEvent: () => undefined,
      onEnd: (reason) => ends.push(reason),
    });
    stream.close();
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual(["closed"]);
  });

  it("rejects immediately when the socket dies before the ack", async () => {
    // Regression: a pre-ack EOF used to hang for the full 5 s ack timeout.
    herdr.silence("events.subscribe");
    const c = client(5000);
    const started = Date.now();
    const p = c.subscribe([], { onEvent: () => undefined, onEnd: () => undefined });
    await waitFor(() => herdr.connections >= 1);
    // `silence` accepted the connection and never answered, so it was never registered as a
    // stream -- `dropStreams()` would miss it. `stop()` destroys EVERY accepted socket (see the
    // fake's `sockets` set), which is both what kills this connection and what stops `stop()`
    // itself from hanging on it. `afterEach`'s second `stop()` is a no-op.
    await herdr.stop();
    await expect(p).rejects.toMatchObject({ code: "closed" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects when the subscription is refused", async () => {
    herdr.fail("events.subscribe", "invalid_params", "unknown subscription type");
    await expect(
      client().subscribe([{ type: "pane.output_changed" }], {
        onEvent: () => undefined,
        onEnd: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("ends the stream with an error when a post-ack line exceeds the byte limit", async () => {
    const ends: string[] = [];
    const stream = await client(5000).subscribe([{ type: "pane.updated" }], {
      onEvent: () => undefined,
      onEnd: (reason) => ends.push(reason),
    });
    await waitFor(() => herdr.streamCount === 1);
    herdr.pushRaw("x".repeat(1_048_577)); // no newline: an unterminated, oversized line
    await waitFor(() => ends.length === 1, 3000);
    expect(ends).toEqual(["overflow"]);
    stream.close();
  });
});
```

- [ ] **Step 3: Extend `apps/agent/src/backends/types.ts`**

This is a shipped file; the diff is exactly:

```ts
/** Spec 8.13: the semantic state Herdr reports per pane. Shared with the `agent-state` event. */
export type AgentState = "working" | "blocked" | "idle" | "done" | "unknown";
```

```ts
export type BackendEvent =
  | { type: "screen-changed"; sessionId: string }
  | { type: "layout-changed" }
  | { type: "session-added"; sessionId: string }
  | { type: "session-removed"; sessionId: string }
  | { type: "focus-changed" }
  | { type: "title-changed"; sessionId: string }
  | { type: "command-start"; sessionId: string; command: string; at: number }
  | { type: "command-end"; sessionId: string; exitCode: number; at: number }
  | { type: "prompt"; sessionId: string; at: number }
  /**
   * Spec 8.13: Herdr's semantic per-pane agent state. Only the herdr backend emits it; the
   * `EventEngine` turns it into `blocked` and `prompt` rings (Task 5). Herdr has no command
   * lifecycle, so this replaces `command-start`/`command-end` rather than supplementing them.
   */
  | { type: "agent-state"; sessionId: string; state: AgentState; agent?: string; at: number };
```

The complete interface after this edit — **no ellipsis; this is the whole declaration**, with the
three new members appended after the shipped `capabilitiesOf?`:

```ts
export interface TerminalBackend {
  readonly name: BackendName;
  readonly capabilities: Capabilities;
  connect(): Promise<void>;
  close(): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getScreen(sessionId: string): Promise<Screen>;
  getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }>;
  sendText(sessionId: string, text: string): Promise<void>;
  createSession(where: CreateWhere): Promise<string>;
  focus(sessionId: string): Promise<void>;
  on(handler: (e: BackendEvent) => void): () => void;
  tmuxWindowIds?(): Set<string>;
  tmuxWindowIdOf?(nativeId: string): string | undefined;
  /** SHIPPED — do not remove. Per-session capabilities, when this backend can distinguish (e.g.
   * `BackendRegistry` fanning out to distinct member backends by id prefix). Optional: a
   * single-backend implementation can omit it, and callers fall back to the aggregate
   * `capabilities` getter above. `ScreenTracker.processScreen` already consults this for its
   * per-session `absoluteLines` decision. */
  capabilitiesOf?(sessionId: string): Capabilities | null;
  /**
   * Spec 8.13: the complete set of native session ids at least one phone is currently viewing.
   * A backend with no screen-change push (herdr) polls only these. `ScreenTracker` calls it
   * through the registry on every viewer change, always with the full set (never a delta), and
   * with `[]` when nothing is viewed. Backends that push screen changes ignore it.
   */
  setWatched?(nativeIds: string[]): void;
  /**
   * Spec 8.12/8.13: `false` while the backend's transport is down. The registry keeps such a
   * member registered (it reconnects itself) but leaves it out of `hello.backends`. A backend
   * that omits this property is always considered connected.
   */
  readonly isConnected?: boolean;
}
```

- [ ] **Step 4: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test` (module not found).

- [ ] **Step 5: Implement the wire types**

`apps/agent/src/backends/herdr/types.ts` — fields the research lists as **required** are required
here; everything the research marks optional is optional, and unknown fields are ignored (Herdr's
own rule for JSON clients):

```ts
/**
 * Herdr socket-API wire shapes, hand-written from the verified research report
 * (`.superpowers/research/herdr-socket-api.md` §2). Nothing is vendored from Herdr — no schema
 * file, no generated code (spec 8.13 "Licensing").
 */
import type { AgentState } from "../types.js";

/** Herdr's `AgentStatus` is byte-for-byte our `AgentState`; keep one definition. */
export type AgentStatus = AgentState;

export interface Pong {
  type: "pong";
  version?: string;
  /** Herdr's BINARY client/server generation. Never a JSON-API floor — see spec 8.13. */
  protocol?: number;
  capabilities?: Record<string, unknown> | null;
}

export interface PaneScroll {
  offset_from_bottom?: number;
  max_offset_from_bottom?: number;
  viewport_rows?: number;
}

/** research §2 `PaneInfo`: pane_id, terminal_id, workspace_id, tab_id, focused, agent_status,
 * revision are required; the rest are optional. */
export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: string;
  revision: number;
  label?: string;
  title?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  display_agent?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  scroll?: PaneScroll;
}

/** research §2 `AgentInfo` = `PaneInfo` + these. */
export interface AgentInfo extends PaneInfo {
  name?: string;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  screen_detection_skipped?: boolean;
  state_change_seq?: number;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count?: number;
  tab_count?: number;
  active_tab_id?: string;
  agent_status?: string;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count?: number;
  agent_status?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed?: boolean;
  area?: Rect;
  focused_pane_id?: string | null;
  panes: { pane_id: string; focused?: boolean; rect: Rect }[];
  splits?: { id?: string; direction?: string; ratio?: number; rect?: Rect }[];
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: AgentInfo[];
}

export interface SessionSnapshotResult {
  type: "session_snapshot";
  snapshot: SessionSnapshot;
}

export interface PaneReadResult {
  type: "pane_read";
  read: {
    pane_id: string;
    workspace_id?: string;
    tab_id?: string;
    source: string;
    format: string;
    /** ⚠ always 0 on `pane.read` (hard-coded upstream) — never usable as a change cursor. */
    revision: number;
    truncated: boolean;
    text: string;
  };
}

export interface PaneInfoResult {
  type: "pane_info";
  pane: PaneInfo;
}

export interface TabCreatedResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

export interface CopyMotionResult {
  type: "pane_copy_motion";
  pane_id: string;
  cursor: { row: number; col: number };
  /** `runtime.content_seq()` — the terminal's real content counter. Odd = a write is in flight. */
  content_revision: number;
}

/** A streamed event line: lifecycle events are snake_case, subscription events are dotted. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}
```

- [ ] **Step 6: Implement the client**

`apps/agent/src/backends/herdr/client.ts`:

```ts
import { connect as netConnect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../../log.js";
import { BackendUnavailable } from "../types.js";
import type { HerdrEvent, Pong } from "./types.js";

/**
 * Spec 8.13: the JSON-API floor is a SEMVER version, not `ping.protocol` (which is herdr's binary
 * client/server generation and bumps for reasons that do not affect this API). `session.snapshot`
 * landed in 0.7.2 and is the feature probe the backend and `doctor` run as the second gate.
 */
export const MIN_VERSION: [number, number, number] = [0, 7, 2];
export const INSTALL_HINT =
  'Install Herdr: curl -fsSL https://herdr.dev/install.sh | sh, then start it with "herdr".';
export const UPGRADE_HINT =
  "Upgrade Herdr to 0.7.2 or newer: curl -fsSL https://herdr.dev/install.sh | sh, then restart it.";
/** Herdr's own per-line cap (`src/api/server.rs`): 1 MiB, counted in BYTES. */
const MAX_LINE_BYTES = 1_048_576;

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`herdr ${code}: ${message}`);
    this.name = "HerdrError";
  }
}

/** Herdr error codes that mean "that pane target is stale" (spec 8.13: trigger a resync). */
export const GONE_CODES = new Set(["not_found", "pane_not_found", "stale_pane_target"]);
/** Codes that mean "this build does not have that method" — the feature probe's failure modes. */
export const UNSUPPORTED_CODES = new Set([
  "invalid_request",
  "unsupported",
  "unknown_method",
  "method_not_found",
]);

export interface HerdrStream {
  close(): void;
}

export interface HerdrStreamHandlers {
  onEvent(e: HerdrEvent): void;
  /** Called once, after the ack, when the stream dies: "eof" | "error" | "closed" | "overflow". */
  onEnd(reason: string): void;
}

export interface HerdrClientOptions {
  log: Logger;
  socketPath?: string;
  requestTimeoutMs?: number;
}

interface WireResponse {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  data?: unknown;
}

/** `null` when `version` is not semver-shaped (a dev build): the caller lets the probe decide. */
export function semverAtLeast(version: string, min: [number, number, number]): boolean | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const a = got[i] as number;
    const b = min[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Spec 8.13: `$HERDR_SOCKET_PATH`, else — when `$HERDR_SESSION` names a session —
 * `<config>/herdr/sessions/<name>/herdr.sock`, else `<config>/herdr/herdr.sock`, where `<config>`
 * is `$XDG_CONFIG_HOME` or `~/.config`.
 *
 * ⚠ The macOS default is the one thing here that is READ FROM THE RUST SOURCE BUT NOT YET
 * OBSERVED ON A MAC: research §1 shows the config dir resolving through `$XDG_CONFIG_HOME` →
 * `~/.config` with no `~/Library/Application Support` branch, and spec 8.13 states that as fact,
 * but the research's own spike checklist still lists it as unconfirmed. **Spike question 1 must
 * print the socket path herdr actually created on macOS.** If it turns out to live under
 * `~/Library/Application Support/herdr/`, this function needs a second candidate (probe both with
 * `existsSync` and prefer the one that exists) — nothing else in the plan changes, because every
 * caller already treats "no socket" as "herdr is not installed". Users are never stuck meanwhile:
 * `$HERDR_SOCKET_PATH` overrides everything.
 */
export function herdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.HERDR_SOCKET_PATH;
  if (explicit) return explicit;
  const config = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "herdr") : join(home, ".config", "herdr");
  const session = env.HERDR_SESSION;
  return session ? join(config, "sessions", session, "herdr.sock") : join(config, "herdr.sock");
}

function socketError(err: NodeJS.ErrnoException, method: string, path: string): HerdrError {
  const code = err.code ?? "";
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM")
    return new HerdrError("unavailable", `cannot reach the herdr socket at ${path} (${code})`);
  return new HerdrError("socket", `${method}: ${err.message}`);
}

/**
 * Feeds complete NDJSON lines to `onLine`. A `StringDecoder` is required, not `chunk.toString()`:
 * a styled `pane.read` carries multi-byte UTF-8 that can straddle a chunk boundary. Complete lines
 * are drained BEFORE the size check, so a chunk holding many valid lines is never rejected; only an
 * unterminated line longer than 1 MiB (in bytes) trips `onOverflow`.
 */
function pipeLines(socket: Socket, onLine: (line: string) => void, onOverflow: () => void): void {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
      i = buf.indexOf("\n");
    }
    if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) {
      buf = "";
      onOverflow();
    }
  });
}

export class HerdrClient {
  private readonly log: Logger;
  private nextId = 1;

  constructor(private readonly opts: HerdrClientOptions) {
    this.log = opts.log.child({ unit: "herdr" });
  }

  get socketPath(): string {
    return this.opts.socketPath ?? herdrSocketPath();
  }

  /**
   * One request, one connection (research §1: the server reads exactly one line per connection and
   * then drops it). There is deliberately no request-id map and no pipelining; the echoed `id` is
   * decorative, so a mismatch is logged, not treated as an error.
   */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `sb${this.nextId++}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    const path = this.socketPath;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const socket = netConnect({ path });
      const done = (err: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => done(new HerdrError("timeout", `${method} did not answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      pipeLines(
        socket,
        (line) => {
          let msg: WireResponse;
          try {
            msg = JSON.parse(line) as WireResponse;
          } catch {
            done(new HerdrError("malformed", `${method} answered with a non-JSON line`));
            return;
          }
          if (msg.id !== undefined && msg.id !== id)
            this.log.debug("herdr echoed a different id", { method });
          if (msg.error) {
            done(new HerdrError(msg.error.code || "error", msg.error.message || method));
            return;
          }
          if (msg.result === undefined || msg.result === null) {
            done(new HerdrError("malformed", `${method} answered without a result`));
            return;
          }
          done(null, msg.result as T);
        },
        () => done(new HerdrError("overflow", `${method} answered with an oversized line`)),
      );
      socket.on("error", (err: NodeJS.ErrnoException) => done(socketError(err, method, path)));
      socket.on("close", () =>
        done(new HerdrError("closed", `herdr closed the connection before answering ${method}`)),
      );
    });
  }

  /**
   * Opens the long-lived event stream. Resolves once Herdr has acked with `subscription_started`;
   * after that, every bare `{"event":…,"data":…}` line reaches `onEvent`, and the stream dying
   * reaches `onEnd` exactly once. Herdr has no "add subscription" method, so changing the per-pane
   * subscription set means opening a new stream and closing this one (spec 8.13, two-phase).
   */
  subscribe(subscriptions: unknown[], handlers: HerdrStreamHandlers): Promise<HerdrStream> {
    const id = `sb${this.nextId++}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    const path = this.socketPath;
    return new Promise<HerdrStream>((resolve, reject) => {
      const socket = netConnect({ path });
      let acked = false;
      let ended = false;
      let closedByUs = false;
      const stream: HerdrStream = {
        close() {
          closedByUs = true;
          socket.destroy();
        },
      };
      const failBeforeAck = (err: Error): void => {
        if (acked) return;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const end = (reason: string): void => {
        if (ended) return;
        ended = true;
        handlers.onEnd(closedByUs ? "closed" : reason);
      };
      const timer = setTimeout(
        () => failBeforeAck(new HerdrError("timeout", "events.subscribe was not acknowledged")),
        timeoutMs,
      );
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
        );
      });
      pipeLines(
        socket,
        (line) => {
          let msg: WireResponse;
          try {
            msg = JSON.parse(line) as WireResponse;
          } catch {
            this.log.warn("undecodable herdr stream line", { chars: line.length });
            return;
          }
          if (!acked) {
            if (msg.error) {
              failBeforeAck(
                new HerdrError(msg.error.code || "error", msg.error.message || "events.subscribe"),
              );
              return;
            }
            const type = (msg.result as { type?: string } | undefined)?.type;
            if (type !== "subscription_started") {
              failBeforeAck(new HerdrError("malformed", `events.subscribe answered ${type}`));
              return;
            }
            acked = true;
            clearTimeout(timer);
            resolve(stream);
            return;
          }
          // Event lines carry no `id`. The ack and the first events can arrive in one chunk, so
          // this can run before the caller's `await` resumes — the caller must arm its buffer
          // before calling `subscribe`.
          if (typeof msg.event === "string") {
            const data =
              msg.data && typeof msg.data === "object" ? (msg.data as Record<string, unknown>) : {};
            handlers.onEvent({ event: msg.event, data });
          }
        },
        () => {
          // An oversized line is unrecoverable: we have lost stream position either way.
          if (!acked) failBeforeAck(new HerdrError("overflow", "events.subscribe line too long"));
          else {
            socket.destroy();
            end("overflow");
          }
        },
      );
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (!acked) failBeforeAck(socketError(err, "events.subscribe", path));
        else end("error");
      });
      // A socket that dies before the ack must reject NOW, not after the 5 s ack timeout.
      socket.on("close", () => {
        if (!acked) {
          failBeforeAck(
            new HerdrError("closed", "herdr closed the connection before acknowledging the stream"),
          );
          return;
        }
        end("eof");
      });
    });
  }

  /**
   * Discovery call. Throws `BackendUnavailable` (never `HerdrError`) so `connect()` and `doctor`
   * both get an actionable hint: no socket -> install/start Herdr; version < 0.7.2 -> upgrade. An
   * unparseable version is accepted with a warning — the `session.snapshot` feature probe run by
   * the caller is the second gate (spec 8.13).
   */
  async ping(): Promise<Pong> {
    let pong: Pong;
    try {
      pong = await this.request<Pong>("ping", {});
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BackendUnavailable(detail, INSTALL_HINT);
    }
    const version = typeof pong.version === "string" ? pong.version : "";
    const ok = semverAtLeast(version, MIN_VERSION);
    if (ok === false)
      throw new BackendUnavailable(
        `herdr ${version} is older than 0.7.2 (session.snapshot and scroll metrics landed there)`,
        UPGRADE_HINT,
      );
    if (ok === null)
      this.log.warn("herdr reported an unparseable version; relying on the feature probe", {
        version,
      });
    this.log.debug("herdr ping ok", { version, protocol: pong.protocol });
    return pong;
  }
}
```

- [ ] **Step 7: Run the tests**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck
pnpm lint:fix && pnpm lint
```
Expected: all green, including the previously shipped suites.

- [ ] **Step 8: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): HerdrClient — NDJSON socket transport for herdr"
```

---

### Task 3: `convert.ts` — an ANSI read becomes a `Screen` (spec 8.13 "Screen")

**Files:**
- Create: `apps/agent/src/backends/herdr/convert.ts`, `apps/agent/test/herdr-convert.test.ts`
- Create: `apps/agent/test/fixtures/herdr-pane-read-visible.json` (hand-written now; Task 8 replaces it with the captured one)

**Interfaces:**
- `parseAnsiLines(text: string): Line[]` — split the ANSI blob on `\n` into per-row `Line`s with
  `parseSgrLine`. A single trailing empty element (from a trailing newline) is dropped.
  `parseSgrLine` already discards control bytes below 0x20, so a stray `\r` needs no handling.
- `fitLines(lines: Line[], rows: number): Line[]` — pad with `emptyLine()` to `rows` and, when there
  are **more** rows than fit, keep the **last** `rows` (ruling 22/G4.3: a terminal viewport is
  bottom-anchored — truncating from the bottom would throw away the prompt).
- `lineCells(line: Line): number` — cell width of a row (`r.n ?? stringCells(r.t)` summed).
- `fakeCursor(lines: Line[], cols: number): Cursor` — spec 8.13: Herdr exposes **no cursor**, so it
  goes at the end of the last non-blank row (`y` = that row, `x` = its cell width **clamped to
  `cols - 1`**, ruling 4/G1.4). All-blank screen → `{ x: 0, y: 0 }`.
- `herdrScreen(input: { text; rows; cols; scrollMax }): Screen` — `scrollbackTotal = scrollMax`
  (ruling 5): `scroll.max_offset_from_bottom` is the count of rows **above** the viewport, which is
  exactly the origin the phone's `historyFrom` expects (7.4: `lines[k]` is
  `before - lines.length + k`). **Not** `scrollMax + rows`.

- [ ] **Step 1: Write the fixture**

`apps/agent/test/fixtures/herdr-pane-read-visible.json` — the **whole response line** as Herdr
writes it, so Task 8 can overwrite it with a captured one verbatim:

```json
{
  "id": "sb7",
  "result": {
    "type": "pane_read",
    "read": {
      "pane_id": "w1:p1",
      "workspace_id": "w1",
      "tab_id": "w1:t1",
      "source": "visible",
      "format": "ansi",
      "revision": 0,
      "truncated": false,
      "text": "\u001b[1;32m➜\u001b[0m  \u001b[36mshellbell\u001b[0m git:(\u001b[31mmain\u001b[0m)\n$ pnpm -F shellbell test\n\u001b[32m✓\u001b[0m test/herdr-client.test.ts (7)\n\u001b[33m漢字\u001b[0m wide-cell row\n"
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/herdr-convert.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  fakeCursor,
  fitLines,
  herdrScreen,
  lineCells,
  parseAnsiLines,
} from "../src/backends/herdr/convert.js";
import type { PaneReadResult } from "../src/backends/herdr/types.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "herdr-pane-read-visible.json"), "utf8"),
) as { result: PaneReadResult };
const TEXT = fixture.result.read.text;
const flat = (l: Line) => l.r.map((r) => r.t).join("");

describe("parseAnsiLines", () => {
  it("splits the ANSI blob into styled rows and drops the trailing newline's empty row", () => {
    const lines = parseAnsiLines(TEXT);
    expect(lines.map(flat)).toEqual([
      "➜  shellbell git:(main)",
      "$ pnpm -F shellbell test",
      "✓ test/herdr-client.test.ts (7)",
      "漢字 wide-cell row",
    ]);
    expect(lines[0]?.r[0]).toMatchObject({ t: "➜", fg: 2, b: true });
    expect(lines[0]?.r[2]).toMatchObject({ t: "shellbell", fg: 6 });
    // Ghostty's VT formatter trims trailing blanks, so rows are ragged and never padded to cols.
    expect(lines[3]?.r[0]).toMatchObject({ t: "漢字", fg: 3, n: 4 });
  });

  it("returns an empty array for an empty read", () => {
    expect(parseAnsiLines("")).toEqual([]);
    expect(parseAnsiLines("\n")).toEqual([{ r: [] }]);
  });
});

describe("fitLines", () => {
  it("pads at the bottom and, when overfull, keeps the BOTTOM rows", () => {
    const l = (t: string): Line => ({ r: [{ t }] });
    expect(fitLines([l("a")], 3).map(flat)).toEqual(["a", "", ""]);
    // A terminal viewport is bottom-anchored: the prompt is the row that must survive.
    expect(fitLines([l("a"), l("b"), l("c"), l("d")], 2).map(flat)).toEqual(["c", "d"]);
  });
});

describe("lineCells / fakeCursor", () => {
  it("counts wide cells and parks the cursor after the last non-blank row", () => {
    const lines = parseAnsiLines(TEXT);
    expect(lineCells(lines[3] as Line)).toBe(18); // 漢字 = 4 cells + " wide-cell row" = 14
    expect(fakeCursor(lines, 80)).toEqual({ x: 18, y: 3 });
    expect(fakeCursor([{ r: [] }, { r: [] }], 80)).toEqual({ x: 0, y: 0 });
    expect(fakeCursor([], 80)).toEqual({ x: 0, y: 0 });
  });

  it("clamps x to the last column of a full-width row", () => {
    // A row filled to `cols` would otherwise put the cursor at x === cols, outside the grid.
    const full: Line = { r: [{ t: "x".repeat(80) }] };
    expect(fakeCursor([full], 80)).toEqual({ x: 79, y: 0 });
    expect(fakeCursor([full], 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("herdrScreen", () => {
  it("pads to rows, keeps cols from the layout rect, and reports rows-above-viewport", () => {
    const screen = herdrScreen({ text: TEXT, rows: 6, cols: 80, scrollMax: 120 });
    expect(screen.rows).toBe(6);
    expect(screen.cols).toBe(80);
    expect(screen.lines).toHaveLength(6);
    expect(screen.lines[4]).toEqual({ r: [] });
    expect(screen.lines[5]).toEqual({ r: [] });
    // spec 8.13 (ruling 5): scrollbackTotal is max_offset_from_bottom -- the rows ABOVE the
    // viewport -- so the phone's `historyFrom` starts exactly where our history pages end.
    expect(screen.scrollbackTotal).toBe(120);
    expect(screen.cursor).toEqual({ x: 18, y: 3 });
  });

  it("keeps the bottom of a read that is longer than the viewport", () => {
    const screen = herdrScreen({ text: "a\nb\nc\nd\n", rows: 2, cols: 10, scrollMax: 0 });
    expect(screen.lines.map(flat)).toEqual(["c", "d"]);
    expect(screen.scrollbackTotal).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.

- [ ] **Step 4: Implement**

`apps/agent/src/backends/herdr/convert.ts`:

```ts
import { type Cursor, emptyLine, type Line, parseSgrLine, stringCells } from "@shellbell/protocol";
import type { Screen } from "../types.js";

export interface HerdrScreenInput {
  /** `pane.read {source:"visible", format:"ansi"}` -> `result.read.text`. */
  text: string;
  /** The pane's viewport height: the layout rect's height, else `scroll.viewport_rows`. */
  rows: number;
  /** The pane's layout rect width. */
  cols: number;
  /** `scroll.max_offset_from_bottom` — rows of scrollback ABOVE the viewport. */
  scrollMax: number;
}

/**
 * One row per line. Herdr's ANSI reads go through Ghostty's VT selection formatter with
 * `trim: true`, so rows carry real SGR sequences but no CUP/erase sequences, no padding to `cols`,
 * and no trailing blanks — exactly what `parseSgrLine` expects. Control bytes below 0x20 (a stray
 * CR included) are dropped by `parseSgrLine` itself.
 */
export function parseAnsiLines(text: string): Line[] {
  if (text === "") return [];
  const rows = text.split("\n");
  // A trailing newline yields one empty tail element that is not a row.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows.map(parseSgrLine);
}

/**
 * Exactly `rows` lines. Padding goes at the bottom (Ghostty trims trailing blank rows), and an
 * overfull read keeps the LAST `rows`: a terminal viewport is bottom-anchored, so dropping the
 * bottom would throw away the prompt and the newest output.
 */
export function fitLines(lines: Line[], rows: number): Line[] {
  if (lines.length > rows) return lines.slice(lines.length - rows);
  const out = lines.slice();
  while (out.length < rows) out.push(emptyLine());
  return out;
}

export function lineCells(line: Line): number {
  return line.r.reduce((n, r) => n + (r.n ?? stringCells(r.t)), 0);
}

/**
 * Spec 8.13: Herdr exposes no cursor anywhere in its API, so we place one at the end of the last
 * non-blank visible row and the app dims it for `herdr` sessions. `x` is clamped to `cols - 1`: a
 * row filled to the full width would otherwise report a column outside the grid.
 */
export function fakeCursor(lines: Line[], cols: number): Cursor {
  const maxX = Math.max(0, cols - 1);
  for (let y = lines.length - 1; y >= 0; y--) {
    const line = lines[y] as Line;
    if (line.r.some((r) => r.t.trim().length > 0))
      return { x: Math.min(maxX, lineCells(line)), y };
  }
  return { x: 0, y: 0 };
}

export function herdrScreen(input: HerdrScreenInput): Screen {
  const rows = Math.max(1, input.rows);
  const cols = Math.max(1, input.cols);
  const lines = fitLines(parseAnsiLines(input.text), rows);
  return {
    cols,
    rows,
    cursor: fakeCursor(lines, cols),
    lines,
    // spec 8.13 (ruling 5): the rows above the viewport, i.e. the absolute index of the screen's
    // first row. `capabilities.absoluteLines` stays false because Herdr's counter is not stable
    // once its scrollback saturates, but the ORIGIN matches what `history` pages against.
    scrollbackTotal: Math.max(0, input.scrollMax),
  };
}
```

- [ ] **Step 5: Run the tests** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`; then `pnpm lint:fix && pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): herdr screen conversion (ANSI reads -> Line[])"
```

---

### Task 4: `HerdrBackend` (spec 8.13 "Bootstrap and event handling", "Screen", "Input", "Create / focus")

**Files:**
- Create: `apps/agent/src/backends/herdr/keys.ts`, `apps/agent/src/backends/herdr/backend.ts`
- Create: `apps/agent/test/herdr-backend.test.ts`
- Create fixtures: `apps/agent/test/fixtures/herdr-ping.json`, `herdr-session-snapshot.json`, `herdr-pane-read-recent.json`, `herdr-agent-status-event.json`, `herdr-copy-motion.json`

**Interfaces:**
- `herdr/keys.ts`: `HERDR_KEYS: Partial<Record<NamedKey, string>>`,
  `herdrKeyForBytes(text: string): string | undefined`.
- `herdr/backend.ts`: `herdrSubscriptions(paneIds: string[]): Record<string, unknown>[]`,
  `interface HerdrBackendOptions { client: HerdrClient; log: Logger; reconnectMs?: number; revisionPollMs?: number; syncDebounceMs?: number; scrollRefreshMs?: number }`,
  `class HerdrBackend implements TerminalBackend` with `readonly name = "herdr"`,
  `get connected(): boolean`, and capabilities
  `{ subscribe: true, prompts: false, createSession: true, focus: true, history: true, absoluteLines: false }`.

**The rules this task implements (each one is a controller ruling; the tests below pin them):**

| # | Rule |
|---|---|
| 2 | **`session.snapshot` is the only writer of pane membership.** Bootstrap = subscribe (ack) → snapshot → apply → *then* process the events buffered since the ack. Lifecycle events (`pane_created/closed/exited/moved/updated`, `tab.*`, `workspace.*`) only `scheduleSync("snapshot")` — one debounced, single-flight refresh. `pane_agent_status_changed` and `pane_scroll_changed` update values on an existing pane. Nothing a handler does can schedule the sync that produced it, so there is no loop. |
| 3 | Losing the stream emits `session-removed` for **every** Herdr pane, clears the maps and flips `connected` to `false`. Reconnect re-adds them with `session-added` + an initial `agent-state`, which the engine sees as a first sighting → no adoption ring. |
| 4 | Cursor `x` is clamped to `cols - 1`; `rows` come from the layout rect (fallback `scroll.viewport_rows`) and **both axes** update on `layout.updated`. |
| 5 | `scrollbackTotal = scroll.max_offset_from_bottom`; `pane.scroll_changed` keeps it fresh. **The research documents that event as `{ pane_id }` with no scroll object, so the rate-limited `pane.get` refresh is the PRIMARY path** and reading numbers straight off the payload is an opportunistic shortcut for a build that sends them (spike item 8). History arithmetic pages against that same number; `agent_not_idle` or a short read falls back to a visible read and sets `oldestAvailable`. |
| 7 | `\r`/`\n` → `pane.send_keys ["enter"]`, `\t` → `["tab"]`; a payload ending in a newline is `send_text(body)` + `send_keys ["enter"]` so `input.line` actually submits. |
| 9 | Adaptive poller: 200 ms while changing → 500 ms after 5 s unchanged → 1000 ms cap; odd `content_revision` is skipped silently; probes run **sequentially** and re-check `closed`, watched membership and the pane generation after every await. |
| 10 | Two-phase resubscribe: the new stream is opened **and acked** (and already buffering) before it replaces the old one; a snapshot failure closes the new stream and hands over to the reconnect poll. |
| 12 | `ping` semver gate (client) + `session.snapshot` feature probe (here): an `invalid_request`-class failure on the first snapshot is `BackendUnavailable` with the upgrade hint. |
| 15 | `not_found`/`pane_not_found`/`stale_pane_target` on any pane call → `scheduleSync("snapshot")` (which emits `session-removed` if the pane is really gone) **and** `SessionGone` to the caller. Never a silent local drop. |
| 19 | `tab.create {focus:false}`; Shellbell `vertical` → Herdr `right`. |

- [ ] **Step 1: Write the fixtures**

`apps/agent/test/fixtures/herdr-ping.json`:

```json
{
  "id": "sb1",
  "result": {
    "type": "pong",
    "version": "0.8.2",
    "protocol": 22,
    "capabilities": {
      "live_handoff": true,
      "detached_server_daemon": true,
      "endpoint_protocol_generation": 1
    }
  }
}
```

`apps/agent/test/fixtures/herdr-session-snapshot.json` — two workspaces (so window ordering is
covered), three panes; the first tab's layout deliberately lists `w1:p2` **before** `w1:p1` so the
rect-order rule is tested:

```json
{
  "id": "sb2",
  "result": {
    "type": "session_snapshot",
    "snapshot": {
      "version": "0.8.2",
      "protocol": 22,
      "focused_workspace_id": "w1",
      "focused_tab_id": "w1:t1",
      "focused_pane_id": "w1:p1",
      "workspaces": [
        { "workspace_id": "w2", "number": 2, "label": "notes", "focused": false, "pane_count": 1, "tab_count": 1 },
        { "workspace_id": "w1", "number": 1, "label": "shellbell", "focused": true, "pane_count": 2, "tab_count": 1 }
      ],
      "tabs": [
        { "tab_id": "w1:t1", "workspace_id": "w1", "number": 1, "label": "agents", "focused": true, "pane_count": 2 },
        { "tab_id": "w2:t1", "workspace_id": "w2", "number": 1, "label": "logs", "focused": false, "pane_count": 1 }
      ],
      "panes": [
        {
          "pane_id": "w2:p1",
          "terminal_id": "term_c",
          "workspace_id": "w2",
          "tab_id": "w2:t1",
          "focused": false,
          "agent_status": "working",
          "revision": 1,
          "terminal_title_stripped": "pnpm test",
          "cwd": "/Users/dev/code/shellbell",
          "scroll": { "offset_from_bottom": 0, "max_offset_from_bottom": 40, "viewport_rows": 40 }
        },
        {
          "pane_id": "w1:p1",
          "terminal_id": "term_a",
          "workspace_id": "w1",
          "tab_id": "w1:t1",
          "focused": true,
          "agent_status": "blocked",
          "revision": 7,
          "title": "claude",
          "cwd": "/Users/dev/code/shellbell",
          "foreground_cwd": "/Users/dev/code/shellbell",
          "agent": "claude-code",
          "display_agent": "Claude Code",
          "terminal_title_stripped": "claude",
          "scroll": { "offset_from_bottom": 0, "max_offset_from_bottom": 120, "viewport_rows": 24 }
        },
        {
          "pane_id": "w1:p2",
          "terminal_id": "term_b",
          "workspace_id": "w1",
          "tab_id": "w1:t1",
          "focused": false,
          "agent_status": "unknown",
          "revision": 2,
          "title": "zsh",
          "cwd": "/Users/dev",
          "scroll": { "offset_from_bottom": 0, "max_offset_from_bottom": 0, "viewport_rows": 24 }
        }
      ],
      "layouts": [
        {
          "workspace_id": "w1",
          "tab_id": "w1:t1",
          "zoomed": false,
          "area": { "x": 0, "y": 0, "width": 160, "height": 24 },
          "focused_pane_id": "w1:p1",
          "panes": [
            { "pane_id": "w1:p2", "focused": false, "rect": { "x": 81, "y": 0, "width": 79, "height": 24 } },
            { "pane_id": "w1:p1", "focused": true, "rect": { "x": 0, "y": 0, "width": 80, "height": 24 } }
          ],
          "splits": []
        },
        {
          "workspace_id": "w2",
          "tab_id": "w2:t1",
          "zoomed": false,
          "area": { "x": 0, "y": 0, "width": 160, "height": 40 },
          "focused_pane_id": "w2:p1",
          "panes": [
            { "pane_id": "w2:p1", "focused": false, "rect": { "x": 0, "y": 0, "width": 160, "height": 40 } }
          ],
          "splits": []
        }
      ],
      "agents": [
        {
          "pane_id": "w1:p1",
          "terminal_id": "term_a",
          "workspace_id": "w1",
          "tab_id": "w1:t1",
          "focused": true,
          "agent_status": "blocked",
          "revision": 7,
          "name": "claude-code",
          "interactive_ready": true,
          "launch_pending": false,
          "screen_detection_skipped": false,
          "state_change_seq": 12
        }
      ]
    }
  }
}
```

`apps/agent/test/fixtures/herdr-pane-read-recent.json` (50 numbered rows — the fake serves the
**last** N of these, which is what `source:"recent"` means):

```json
{
  "id": "sb8",
  "result": {
    "type": "pane_read",
    "read": {
      "pane_id": "w1:p1",
      "workspace_id": "w1",
      "tab_id": "w1:t1",
      "source": "recent",
      "format": "ansi",
      "revision": 0,
      "truncated": true,
      "text": "line 01\nline 02\nline 03\nline 04\nline 05\nline 06\nline 07\nline 08\nline 09\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\nline 16\nline 17\nline 18\nline 19\nline 20\nline 21\nline 22\nline 23\nline 24\nline 25\nline 26\nline 27\nline 28\nline 29\nline 30\nline 31\nline 32\nline 33\nline 34\nline 35\nline 36\nline 37\nline 38\nline 39\nline 40\nline 41\nline 42\nline 43\nline 44\nline 45\nline 46\nline 47\nline 48\nline 49\nline 50\n"
    }
  }
}
```

`apps/agent/test/fixtures/herdr-agent-status-event.json` (a streamed event line — note the **dotted**
event name: subscription-driven events keep the dotted form while lifecycle events are snake_case,
and there is no `id`):

```json
{
  "event": "pane.agent_status_changed",
  "data": {
    "pane_id": "w1:p1",
    "workspace_id": "w1",
    "agent_status": "idle",
    "agent": "claude-code",
    "display_agent": "Claude Code",
    "title": "claude · done",
    "state_labels": {}
  }
}
```

`apps/agent/test/fixtures/herdr-copy-motion.json`:

```json
{
  "id": "sb9",
  "result": {
    "type": "pane_copy_motion",
    "pane_id": "w1:p1",
    "cursor": { "row": 0, "col": 0 },
    "content_revision": 4242
  }
}
```

- [ ] **Step 2: Write the failing backend tests** — the whole file is in Step 3 below; write it,
      then run `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test` and confirm it fails on
      the missing module.

- [ ] **Step 3: `apps/agent/test/herdr-backend.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import { BadWindow, type BackendEvent, SessionGone } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
const load = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const SNAPSHOT = load("herdr-session-snapshot.json") as { result: unknown };
const VISIBLE = load("herdr-pane-read-visible.json") as { result: unknown };
const RECENT = load("herdr-pane-read-recent.json") as {
  result: { read: { text: string } };
};
const AGENT_EVENT = load("herdr-agent-status-event.json") as {
  event: string;
  data: Record<string, unknown>;
};
const recentRows = RECENT.result.read.text.split("\n").filter(Boolean);

/** Deep clone so a test can mutate the snapshot the fake serves without touching the fixture. */
const snapshotResult = () => JSON.parse(JSON.stringify(SNAPSHOT.result));

let herdr: FakeHerdr;
let backend: HerdrBackend | null = null;
let events: BackendEvent[] = [];

function installDefaults(server: FakeHerdr, snapshot: () => unknown = snapshotResult): void {
  server.reply("session.snapshot", () => snapshot());
  server.reply("pane.read", (p) => {
    if (p.source === "recent") {
      const n = Math.min(Number(p.lines ?? 80), recentRows.length);
      return {
        type: "pane_read",
        read: {
          pane_id: p.pane_id,
          source: "recent",
          format: "ansi",
          revision: 0,
          truncated: n < recentRows.length,
          text: `${recentRows.slice(-n).join("\n")}\n`,
        },
      };
    }
    return VISIBLE.result;
  });
}

async function connect(overrides: Record<string, number> = {}): Promise<HerdrBackend> {
  const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 500 });
  const b = new HerdrBackend({
    client,
    log,
    reconnectMs: 30,
    revisionPollMs: 20,
    syncDebounceMs: 20,
    scrollRefreshMs: 0,
    ...overrides,
  });
  backend = b;
  events = [];
  b.on((e) => events.push(e));
  await b.connect();
  return b;
}

type AgentStateEvent = Extract<BackendEvent, { type: "agent-state" }>;

const types = () => events.map((e) => e.type);
const idsOf = (type: BackendEvent["type"]) =>
  events.filter((e) => e.type === type).map((e) => ("sessionId" in e ? e.sessionId : ""));
/**
 * An EXPLICIT type predicate, deliberately not `events.filter((e) => e.type === "agent-state")`:
 * `Array.filter` with a bare boolean callback only narrows a discriminated union via TypeScript's
 * inferred type predicates (5.5+), and `sessionId`/`state` do not exist on every `BackendEvent`
 * member (`{ type: "layout-changed" }` has neither). Spelling the predicate out keeps this test
 * compiling regardless of that inference.
 */
const agentStateEvents = (): AgentStateEvent[] =>
  events.filter((e): e is AgentStateEvent => e.type === "agent-state");
const paneSubs = (subs: { type: string; pane_id?: string }[], type: string) =>
  subs.filter((s) => s.type === type).map((s) => s.pane_id);

beforeEach(async () => {
  herdr = new FakeHerdr();
  installDefaults(herdr);
  await herdr.start();
});

afterEach(async () => {
  await backend?.close();
  backend = null;
  await herdr.stop();
});

describe("HerdrBackend.connect", () => {
  it("pings, discovers panes, subscribes with them, then snapshots again", async () => {
    await connect();
    // The discovery snapshot exists so the FIRST subscription already covers every pane: herdr
    // has no incremental "add subscription" call, and re-subscribing costs a stream handover.
    expect(herdr.requests.map((r) => r.method)).toEqual([
      "ping",
      "session.snapshot",
      "events.subscribe",
      "session.snapshot",
    ]);
    expect(herdr.ignoredLines).toEqual([]);
    const subs = herdr.lastSubscriptions;
    expect(subs).toContainEqual({ type: "layout.updated" });
    expect(paneSubs(subs, "pane.agent_status_changed")).toEqual(["w2:p1", "w1:p1", "w1:p2"]);
    expect(paneSubs(subs, "pane.scroll_changed")).toEqual(["w2:p1", "w1:p1", "w1:p2"]);
    // …and it does not immediately re-subscribe, because the sets already match.
    await new Promise((r) => setTimeout(r, 60));
    expect(herdr.called("events.subscribe")).toHaveLength(1);
  });

  it("maps panes onto SessionInfo ordered by window, tab and rect", async () => {
    const b = await connect();
    const list = await b.listSessions();
    expect(list.map((s) => [s.id, s.title, s.cols, s.rows, s.windowNumber, s.paneIndex, s.state])).toEqual([
      ["term_a", "Claude Code", 80, 24, 1, 0, "blocked"],
      ["term_b", "zsh", 79, 24, 1, 1, "unknown"],
      ["term_c", "pnpm test", 160, 40, 2, 0, "running"],
    ]);
    expect(list[0]).toMatchObject({
      backend: "herdr",
      windowId: "w1",
      tabId: "w1:t1",
      tabIndex: 1,
      cwd: "/Users/dev/code/shellbell",
      isFocusedOnMac: true,
    });
    expect(b.capabilities).toEqual({
      subscribe: true,
      prompts: false,
      createSession: true,
      focus: true,
      history: true,
      absoluteLines: false,
    });
    expect(b.isConnected).toBe(true);
  });

  it("announces every pane it discovered, with its initial agent state", async () => {
    await connect();
    expect(idsOf("session-added")).toEqual(["term_a", "term_b", "term_c"]);
    expect(agentStateEvents().map((e) => [e.sessionId, e.state])).toEqual([
      ["term_a", "blocked"],
      ["term_b", "unknown"],
      ["term_c", "working"],
    ]);
    // `session-added` must reach the agent before the state that describes it.
    expect(types().indexOf("session-added")).toBeLessThan(types().indexOf("agent-state"));
  });

  it("refuses to connect when herdr is not running", async () => {
    await herdr.stop();
    const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 200 });
    const b = new HerdrBackend({ client, log, reconnectMs: 10_000 });
    await expect(b.connect()).rejects.toMatchObject({
      name: "BackendUnavailable",
      hint: expect.stringContaining("herdr.dev/install.sh"),
    });
    expect(b.isConnected).toBe(false);
    await b.close();
  });

  it("feature-probes session.snapshot and refuses a build that lacks it", async () => {
    herdr.fail("session.snapshot", "invalid_request", "unknown method");
    const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 200 });
    const b = new HerdrBackend({ client, log, reconnectMs: 10_000 });
    const err = await b.connect().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "BackendUnavailable" });
    expect((err as { hint: string }).hint).toMatch(/0\.7\.2/);
    await b.close();
  });

  it("rejects a snapshot that is not a snapshot", async () => {
    herdr.reply("session.snapshot", () => ({ type: "ok" }));
    const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 200 });
    const b = new HerdrBackend({ client, log, reconnectMs: 10_000 });
    await expect(b.connect()).rejects.toMatchObject({ name: "BackendUnavailable" });
    await b.close();
  });
});

describe("HerdrBackend.getScreen / getHistory", () => {
  it("reads the visible ANSI screen through the pane id and fakes a clamped cursor", async () => {
    const b = await connect();
    const screen = await b.getScreen("term_a");
    expect(herdr.called("pane.read")[0]?.params).toEqual({
      pane_id: "w1:p1",
      source: "visible",
      format: "ansi",
    });
    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);
    expect(screen.lines).toHaveLength(24);
    expect(screen.scrollbackTotal).toBe(120); // rows above the viewport, NOT +rows
    expect(screen.cursor).toEqual({ x: 18, y: 3 });
    await expect(b.getScreen("nope")).rejects.toBeInstanceOf(SessionGone);
  });

  it("turns a stale pane target into SessionGone AND a snapshot refresh", async () => {
    const b = await connect();
    // The pane is gone in herdr too: the refresh is what emits `session-removed`.
    herdr.fail("pane.read", "stale_pane_target", "pane moved");
    herdr.reply("session.snapshot", () => {
      const snap = snapshotResult() as { snapshot: { panes: { pane_id: string }[] } };
      snap.snapshot.panes = snap.snapshot.panes.filter((p) => p.pane_id !== "w1:p1");
      return snap;
    });
    events.length = 0;
    await expect(b.getScreen("term_a")).rejects.toBeInstanceOf(SessionGone);
    await waitFor(() => idsOf("session-removed").includes("term_a"));
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_b", "term_c"]);
  });

  it("pages history against the scrollbackTotal it emitted", async () => {
    const b = await connect();
    const screen = await b.getScreen("term_a");
    const page1 = await b.getHistory("term_a", screen.scrollbackTotal, 10); // before = 120
    expect(herdr.called("pane.read").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      source: "recent",
      format: "ansi",
      lines: 34, // depth 0 + count 10 + rows 24
    });
    expect(page1.lines.map((l) => l.r[0]?.t)).toEqual([
      "line 17",
      "line 18",
      "line 19",
      "line 20",
      "line 21",
      "line 22",
      "line 23",
      "line 24",
      "line 25",
      "line 26",
    ]);
    expect(page1.oldestAvailable).toBe(0);

    // Deeper than herdr's buffer: a short page, and `oldestAvailable` stops the phone paging.
    const page2 = await b.getHistory("term_a", 100, 10);
    expect(page2.lines.map((l) => l.r[0]?.t)).toEqual([
      "line 01",
      "line 02",
      "line 03",
      "line 04",
      "line 05",
      "line 06",
    ]);
    expect(page2.oldestAvailable).toBe(94);
  });

  it("caps a history read at herdr's 1000-line limit", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    await b.getHistory("term_a", 120, 200); // depth 0 + 200 + 24
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(224);
    await b.getHistory("term_a", 0, 200); // depth 120 + 200 + 24
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(344);
    herdr.pushEvent("pane.scroll_changed", {
      pane_id: "w1:p1",
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5000, viewport_rows: 24 },
    });
    await new Promise((r) => setTimeout(r, 30)); // let the scroll event land
    await b.getHistory("term_a", 0, 200);
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(1000);
  });

  it("falls back to a visible read when herdr refuses a deep read", async () => {
    const b = await connect();
    // Only the deep read is refused (a busy recognised agent); `visible` still answers.
    herdr.reply("pane.read", (p) =>
      p.source === "recent"
        ? { __error: { code: "agent_not_idle", message: "agent is working" } }
        : VISIBLE.result,
    );
    const page = await b.getHistory("term_a", 120, 10);
    // The visible screen is 4 rows in a 24-row viewport, so there is nothing above it to page:
    // an empty page plus `oldestAvailable = before` is how the phone learns to stop asking.
    expect(page.lines).toEqual([]);
    expect(page.oldestAvailable).toBe(120);
    expect(herdr.called("pane.read").at(-1)?.params.source).toBe("visible");
  });
});

describe("HerdrBackend input, create and focus", () => {
  it("submits with send_keys enter and maps the named keys herdr knows", async () => {
    const b = await connect();
    // `input.line` arrives as "…\r": the body goes as text, the newline as a real Enter key,
    // because `pane.send_text` writes literal bytes and does not submit.
    await b.sendText("term_a", "ls -la\r");
    expect(herdr.called("pane.send_text").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      text: "ls -la",
    });
    expect(herdr.called("pane.send_keys").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      keys: ["enter"],
    });
    await b.sendText("term_a", "\r");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["enter"]);
    await b.sendText("term_a", "\n");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["enter"]);
    await b.sendText("term_a", "\t");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["tab"]);
    await b.sendText("term_a", "\x03");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["ctrl+c"]);
    await b.sendText("term_a", "\x1b[Z");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["shift+tab"]);
    // `delete` has no verified herdr key name: raw bytes through send_text instead.
    await b.sendText("term_a", "\x1b[3~");
    expect(herdr.called("pane.send_text").at(-1)?.params.text).toBe("\x1b[3~");
    await expect(b.sendText("nope", "x")).rejects.toBeInstanceOf(SessionGone);
  });

  it("splits right for vertical and down for horizontal", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    herdr.reply("pane.split", () => ({
      type: "pane_info",
      pane: {
        pane_id: "w1:p4",
        terminal_id: "term_d",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: false,
        agent_status: "unknown",
        revision: 0,
      },
    }));
    expect(await b.createSession({ kind: "split", sessionId: "term_a", direction: "vertical" })).toBe(
      "term_d",
    );
    expect(herdr.called("pane.split").at(-1)?.params).toEqual({
      target_pane_id: "w1:p1",
      direction: "right",
      focus: false,
    });
    await b.createSession({ kind: "split", sessionId: "term_a", direction: "horizontal" });
    expect(herdr.called("pane.split").at(-1)?.params.direction).toBe("down");
    await expect(
      b.createSession({ kind: "split", sessionId: "gone", direction: "vertical" }),
    ).rejects.toBeInstanceOf(SessionGone);
  });

  it("creates a tab in a known workspace without stealing focus, and rejects an unknown one", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    herdr.reply("tab.create", () => ({
      type: "tab_created",
      tab: { tab_id: "w1:t3", workspace_id: "w1", number: 3, label: "", focused: false },
      root_pane: {
        pane_id: "w1:p5",
        terminal_id: "term_e",
        workspace_id: "w1",
        tab_id: "w1:t3",
        focused: false,
        agent_status: "unknown",
        revision: 0,
      },
    }));
    expect(await b.createSession({ kind: "tab", backend: "herdr", windowId: "w1" })).toBe("term_e");
    expect(herdr.called("tab.create").at(-1)?.params).toEqual({ workspace_id: "w1", focus: false });
    await b.createSession({ kind: "tab", backend: "herdr" });
    expect(herdr.called("tab.create").at(-1)?.params.workspace_id).toBe("w1"); // focused workspace
    await expect(
      b.createSession({ kind: "tab", backend: "herdr", windowId: "w9" }),
    ).rejects.toBeInstanceOf(BadWindow);
  });

  it("focuses through the pane id", async () => {
    const b = await connect();
    await b.focus("term_b");
    expect(herdr.called("pane.focus").at(-1)?.params).toEqual({ pane_id: "w1:p2" });
    await expect(b.focus("nope")).rejects.toBeInstanceOf(SessionGone);
  });
});

describe("HerdrBackend event handling", () => {
  it("coalesces lifecycle hints into ONE snapshot and never mutates the map directly", async () => {
    await connect();
    const snapshots = () => herdr.called("session.snapshot").length;
    const before = snapshots();
    events.length = 0;
    // Three hints inside one debounce window, none of which changes the pane set.
    herdr.pushEvent("pane_updated", { pane: { pane_id: "w1:p1", title: "ignored by us" } });
    herdr.pushEvent("tab_renamed", { tab_id: "w1:t1", workspace_id: "w1", label: "agents!" });
    herdr.pushEvent("workspace_focused", { workspace_id: "w2" });
    await waitFor(() => snapshots() === before + 1, 3000);
    await new Promise((r) => setTimeout(r, 80));
    expect(snapshots()).toBe(before + 1);
    expect(types()).toContain("focus-changed");
    expect(idsOf("session-added")).toEqual([]);
    expect(idsOf("session-removed")).toEqual([]);
    // No pane appeared or vanished, so no stream rebuild either.
    expect(herdr.called("events.subscribe")).toHaveLength(1);
  });

  it("adds a pane only when the snapshot shows it, then re-subscribes exactly once", async () => {
    const b = await connect();
    events.length = 0;
    herdr.reply("session.snapshot", () => {
      const snap = snapshotResult() as { snapshot: { panes: unknown[] } };
      snap.snapshot.panes.push({
        pane_id: "w1:p4",
        terminal_id: "term_d",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: false,
        agent_status: "idle",
        revision: 0,
        title: "new pane",
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 },
      });
      return snap;
    });
    herdr.pushEvent("pane_created", { pane: { pane_id: "w1:p4" } });
    await waitFor(() => idsOf("session-added").includes("term_d"), 3000);
    expect((await b.listSessions()).map((s) => s.id)).toContain("term_d");
    // The new pane needs its own per-pane subscriptions, so the stream is rebuilt -- once.
    await waitFor(
      () => paneSubs(herdr.lastSubscriptions, "pane.agent_status_changed").includes("w1:p4"),
      3000,
    );
    const streams = herdr.called("events.subscribe").length;
    expect(streams).toBe(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(herdr.called("events.subscribe").length).toBe(streams);
    // Two-phase handover: the old stream is closed only after the new one is acked.
    await waitFor(() => herdr.streamCount === 1);
  });

  it("reconciles a pane that disappeared from the snapshot", async () => {
    const b = await connect();
    events.length = 0;
    herdr.reply("session.snapshot", () => {
      const snap = snapshotResult() as { snapshot: { panes: { pane_id: string }[] } };
      snap.snapshot.panes = snap.snapshot.panes.filter((p) => p.pane_id !== "w1:p2");
      return snap;
    });
    herdr.pushEvent("pane_closed", { pane_id: "w1:p2", workspace_id: "w1" });
    await waitFor(() => idsOf("session-removed").includes("term_b"), 3000);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_a", "term_c"]);
    expect(types()).toContain("layout-changed");
  });

  it("keeps terminal ids stable when herdr renumbers pane ids (pane_moved)", async () => {
    const b = await connect();
    events.length = 0;
    herdr.reply("session.snapshot", () => {
      const snap = snapshotResult() as {
        snapshot: { panes: { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string }[]; layouts: { tab_id: string; panes: { pane_id: string }[] }[] };
      };
      const pane = snap.snapshot.panes.find((p) => p.terminal_id === "term_b");
      if (pane) pane.pane_id = "w1:p7";
      const layout = snap.snapshot.layouts.find((l) => l.tab_id === "w1:t1");
      const entry = layout?.panes.find((p) => p.pane_id === "w1:p2");
      if (entry) entry.pane_id = "w1:p7";
      return snap;
    });
    herdr.pushEvent("pane_moved", { previous_pane_id: "w1:p2", pane: { pane_id: "w1:p7" } });
    await waitFor(
      () => paneSubs(herdr.lastSubscriptions, "pane.agent_status_changed").includes("w1:p7"),
      3000,
    );
    // The session id never changed, so the phone keeps its subscription…
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_a", "term_b", "term_c"]);
    expect(idsOf("session-removed")).toEqual([]);
    expect(idsOf("session-added")).toEqual([]);
    // …and calls now route through the new pane id.
    await b.focus("term_b");
    expect(herdr.called("pane.focus").at(-1)?.params).toEqual({ pane_id: "w1:p7" });
  });

  it("applies agent status directly and updates the title", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    events.length = 0;
    herdr.pushEvent(AGENT_EVENT.event, AGENT_EVENT.data);
    await waitFor(() => types().includes("agent-state"));
    expect(events.find((e) => e.type === "agent-state")).toMatchObject({
      sessionId: "term_a",
      state: "idle",
      agent: "Claude Code", // display name wins over the CLI slug
    });
    // No snapshot was needed: this event's payload IS the new value.
    expect(herdr.called("session.snapshot")).toHaveLength(2);
    // A repeat of the same state is a no-op.
    events.length = 0;
    herdr.pushEvent(AGENT_EVENT.event, AGENT_EVENT.data);
    await new Promise((r) => setTimeout(r, 40));
    expect(types()).not.toContain("agent-state");

    // A different pane, and a title that really changed: routed by pane_id, title emitted.
    events.length = 0;
    herdr.pushEvent("pane.agent_status_changed", {
      pane_id: "w1:p2",
      workspace_id: "w1",
      agent_status: "working",
      title: "npm run dev",
    });
    await waitFor(() => types().includes("agent-state"));
    expect(idsOf("title-changed")).toEqual(["term_b"]);
    expect((await b.listSessions()).find((s) => s.id === "term_b")).toMatchObject({
      title: "npm run dev",
      state: "running",
    });
  });

  it("updates both axes on layout.updated and ignores unknown events", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    events.length = 0;
    herdr.pushEvent("layout_updated", {
      layout: {
        workspace_id: "w1",
        tab_id: "w1:t1",
        panes: [
          { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 30 } },
          { pane_id: "w1:p2", rect: { x: 101, y: 0, width: 59, height: 30 } },
        ],
      },
    });
    await waitFor(() => types().includes("layout-changed"));
    const resized = (await b.listSessions()).find((s) => s.id === "term_a");
    expect([resized?.cols, resized?.rows]).toEqual([100, 30]); // vertical resize included
    events.length = 0;
    // `pushRaw` bypasses the fake's subscription filter, so this really does reach handleEvent.
    herdr.pushRaw(`${JSON.stringify({ event: "nonsense_event", data: {} })}\n`);
    // A focus event for a pane we have never heard of: still a focus change, and a hint that our
    // map is behind (the snapshot decides, but this test parks the debounce far away).
    herdr.pushEvent("pane_focused", { pane_id: "w9:p9", workspace_id: "w9" });
    await new Promise((r) => setTimeout(r, 40));
    expect(types()).toEqual(["focus-changed"]);
  });

  // ⚠ UNVERIFIED PAYLOAD PATH (spike item 8). The research records the event as
  // `pane.scroll_changed { pane_id }` — i.e. it very likely carries NO scroll object at all, and
  // the `pane.get` refresh in the next test is the path production actually takes. This test
  // exists only to pin the opportunistic shortcut we take *if* a build ever does send numbers;
  // Task 8 either confirms it against the captured event or deletes it. Do not read a green run
  // here as evidence that herdr sends scroll metrics on the event.
  it("uses scroll numbers from pane.scroll_changed IF the payload carries them (unverified)", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    herdr.pushEvent("pane.scroll_changed", {
      pane_id: "w1:p1",
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 137, viewport_rows: 24 },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect((await b.getScreen("term_a")).scrollbackTotal).toBe(137);
    expect(herdr.called("pane.get")).toHaveLength(0); // the shortcut skipped the refresh
  });

  // THE PRIMARY PATH: `pane.scroll_changed { pane_id }` with no numbers, which is what the
  // research documents. The event only marks the pane stale; the next `getScreen` refreshes the
  // metrics with one rate-limited `pane.get`.
  it("refreshes scroll metrics with pane.get when the event carries none (primary path)", async () => {
    const b = await connect({ syncDebounceMs: 5000, scrollRefreshMs: 0 });
    herdr.reply("pane.get", (p) => ({
      type: "pane_info",
      pane: {
        pane_id: p.pane_id,
        terminal_id: "term_a",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: true,
        agent_status: "blocked",
        revision: 8,
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 200, viewport_rows: 24 },
      },
    }));
    herdr.pushEvent("pane.scroll_changed", { pane_id: "w1:p1" });
    await new Promise((r) => setTimeout(r, 30));
    expect((await b.getScreen("term_a")).scrollbackTotal).toBe(200);
    expect(herdr.called("pane.get")).toHaveLength(1);
  });
});

describe("HerdrBackend revision poller (spec 8.13 change detection)", () => {
  it("polls only watched panes, skips odd revisions, and backs off when quiet", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    expect(herdr.called("pane.copy_motion")).toHaveLength(0);

    b.setWatched(["term_a"]);
    await waitFor(() => herdr.called("pane.copy_motion").length >= 1);
    expect(herdr.called("pane.copy_motion")[0]?.params).toEqual({
      pane_id: "w1:p1",
      cursor: { row: 0, col: 0 },
      motion: "line_end",
    });
    // Every "nothing happened" window below MUST be longer than one poll interval, or it proves
    // nothing at all: after a probe, `nextAt = now + POLL_FAST_MS` (200 ms), so an 80 ms wait
    // would simply mean no probe ran. `probed()` + the explicit growth assertions make each
    // negative window state "a probe ran and chose not to emit", which is the actual rule.
    const probed = () => herdr.called("pane.copy_motion").length;

    // The first probe only takes a baseline — the tracker already snapshots on view.
    const afterBaseline = probed();
    await new Promise((r) => setTimeout(r, 300));
    expect(probed()).toBeGreaterThan(afterBaseline); // it really did keep polling
    expect(idsOf("screen-changed")).toEqual([]);

    events.length = 0;
    herdr.revision = 8;
    await waitFor(() => idsOf("screen-changed").includes("term_a"));

    // An odd revision means a write is in flight: no emit, and no baseline update either.
    events.length = 0;
    const beforeOdd = probed();
    herdr.revision = 9;
    await new Promise((r) => setTimeout(r, 300));
    expect(probed()).toBeGreaterThan(beforeOdd); // at least one probe SAW the odd revision
    expect(idsOf("screen-changed")).toEqual([]);
    // …and because the odd value never became the baseline, the next even one still reads as a
    // change even though 10 differs from the skipped 9 by the same amount it differs from 8.
    herdr.revision = 10;
    await waitFor(() => idsOf("screen-changed").includes("term_a"));

    // Steady state: nothing more while the revision holds.
    events.length = 0;
    const beforeQuiet = probed();
    await new Promise((r) => setTimeout(r, 300));
    expect(probed()).toBeGreaterThan(beforeQuiet);
    expect(idsOf("screen-changed")).toEqual([]);
  });

  it("stops polling on unwatch and on close, and never fires after them", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    b.setWatched(["term_a"]);
    await waitFor(() => herdr.called("pane.copy_motion").length >= 2);
    b.setWatched([]);
    const after = herdr.called("pane.copy_motion").length;
    // > one poll interval (200 ms), so "unchanged" means "the timer is really off", not
    // "the next tick had not come round yet".
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.called("pane.copy_motion").length).toBe(after);

    b.setWatched(["term_b"]);
    await waitFor(() => herdr.called("pane.copy_motion").length > after);
    events.length = 0;
    await b.close();
    const atClose = herdr.called("pane.copy_motion").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(herdr.called("pane.copy_motion").length).toBe(atClose);
    expect(idsOf("screen-changed")).toEqual([]);
    backend = null;
  });

  it("survives a probe that fails or answers without a revision", async () => {
    const b = await connect({ syncDebounceMs: 5000 });
    herdr.reply("pane.copy_motion", () => ({ type: "pane_copy_motion", pane_id: "w1:p1" }));
    b.setWatched(["term_a"]);
    await waitFor(() => herdr.called("pane.copy_motion").length >= 2);
    expect(idsOf("screen-changed")).toEqual([]);
    herdr.fail("pane.copy_motion", "internal_error", "boom");
    const beforeFailures = herdr.called("pane.copy_motion").length;
    await new Promise((r) => setTimeout(r, 300)); // > one poll interval: a failing probe DID run
    expect(herdr.called("pane.copy_motion").length).toBeGreaterThan(beforeFailures);
    expect(idsOf("screen-changed")).toEqual([]);
    expect(b.isConnected).toBe(true);
  });
});

describe("HerdrBackend restart (spec 8.13 socket-gone)", () => {
  it("removes every session on disconnect and re-adds them when herdr comes back", async () => {
    const b = await connect();
    const path = herdr.path;
    events.length = 0;

    // A real restart: the server exits, the socket file goes away, every connection EOFs.
    await herdr.stop();
    await waitFor(() => idsOf("session-removed").length === 3, 3000);
    expect(idsOf("session-removed").sort()).toEqual(["term_a", "term_b", "term_c"]);
    expect(b.isConnected).toBe(false);
    expect(await b.listSessions()).toEqual([]);

    // It comes back with renumbered pane ids, stable terminal ids, and one pane gone.
    herdr = new FakeHerdr(path);
    installDefaults(herdr, () => {
      const snap = snapshotResult() as {
        snapshot: {
          panes: { pane_id: string; terminal_id: string }[];
          layouts: { panes: { pane_id: string }[] }[];
        };
      };
      snap.snapshot.panes = snap.snapshot.panes.filter((p) => p.terminal_id !== "term_b");
      for (const p of snap.snapshot.panes) p.pane_id = p.pane_id.replace(":p", ":q");
      for (const l of snap.snapshot.layouts)
        for (const p of l.panes) p.pane_id = p.pane_id.replace(":p", ":q");
      return snap;
    });
    events.length = 0;
    await herdr.start();

    await waitFor(() => idsOf("session-added").length === 2, 5000);
    expect(idsOf("session-added").sort()).toEqual(["term_a", "term_c"]);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_a", "term_c"]);
    expect(b.isConnected).toBe(true);
    // The pane that vanished during downtime never comes back, and ids route to the NEW pane ids.
    await b.focus("term_a");
    expect(herdr.called("pane.focus").at(-1)?.params).toEqual({ pane_id: "w1:q1" });
    // A still-blocked agent is announced as an initial state again (the engine sees prev === null).
    expect(agentStateEvents().map((e) => e.sessionId)).toEqual(expect.arrayContaining(["term_a"]));
  });
});
```

- [ ] **Step 4: Implement the key table**

`apps/agent/src/backends/herdr/keys.ts`:

```ts
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

/**
 * Spec 8.13 "Input": Herdr validates every key name **before** writing any bytes, so a single
 * unknown name fails the whole `pane.send_keys` call. This table therefore contains only names the
 * research verified against Herdr's documented grammar. `delete`, `home`, `end`, `page-up`,
 * `page-down` and `ctrl-space` are deliberately absent — they are not in that grammar, so they go
 * out as their raw bytes through `pane.send_text`, which needs no key parsing at all. Task 7's
 * spike round-trips every name and Task 8 records the deltas here.
 */
export const HERDR_KEYS: Partial<Record<NamedKey, string>> = buildHerdrKeys();

function buildHerdrKeys(): Partial<Record<NamedKey, string>> {
  const out: Partial<Record<NamedKey, string>> = {
    enter: "enter",
    tab: "tab",
    "shift-tab": "shift+tab",
    esc: "esc",
    backspace: "backspace",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
  };
  for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
    if (/^ctrl-[a-z]$/.test(name)) out[name] = `ctrl+${name.slice(5)}`;
    else if (/^f([1-9]|1[0-2])$/.test(name)) out[name] = name;
  }
  return out;
}

/**
 * Reverse map: the exact byte string the agent hands `sendText` -> a Herdr key name.
 * `\r` (Enter), `\n` (also Enter — herdr has no separate name) and `\t` (Tab) are here on purpose:
 * `pane.send_text` writes literal bytes and does **not** submit, so a line typed on the phone would
 * never be executed if its trailing CR went through as text. They are inserted first, so the
 * `ctrl-m`/`ctrl-j`/`ctrl-i` aliases that share those bytes never claim them.
 */
const BYTES_TO_HERDR = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>([
    ["\r", "enter"],
    ["\n", "enter"],
    ["\t", "tab"],
  ]);
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    const herdr = HERDR_KEYS[name];
    if (herdr && !out.has(bytes)) out.set(bytes, herdr);
  }
  return out;
}

export function herdrKeyForBytes(text: string): string | undefined {
  return BYTES_TO_HERDR.get(text);
}
```

- [ ] **Step 5: Implement the backend**

`apps/agent/src/backends/herdr/backend.ts`:

```ts
import type { Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import {
  type AgentState,
  type BackendEvent,
  BackendUnavailable,
  BadWindow,
  type Screen,
  SessionGone,
  type TerminalBackend,
} from "../types.js";
import {
  GONE_CODES,
  type HerdrClient,
  HerdrError,
  type HerdrStream,
  INSTALL_HINT,
  UNSUPPORTED_CODES,
  UPGRADE_HINT,
} from "./client.js";
import { herdrScreen, parseAnsiLines } from "./convert.js";
import { herdrKeyForBytes } from "./keys.js";
import type {
  CopyMotionResult,
  HerdrEvent,
  PaneInfo,
  PaneInfoResult,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScroll,
  SessionSnapshot,
  SessionSnapshotResult,
  TabCreatedResult,
} from "./types.js";

/** Herdr caps a single `pane.read` at 1000 lines (`line_limit = lines.min(1000)`). */
const MAX_READ_LINES = 1000;
/** Cap on events buffered during a bootstrap, so a storm cannot grow without bound. */
const MAX_BUFFERED_EVENTS = 1000;
/** Adaptive poll intervals (spec 8.13): fast while changing, slower once the pane settles. */
const POLL_FAST_MS = 200;
const POLL_MEDIUM_MS = 500;
const POLL_SLOW_MS = 1000;
const SETTLE_MEDIUM_MS = 5000;
const SETTLE_SLOW_MS = 15_000;

/**
 * The lifecycle subscriptions we always want, plus the two per-pane ones. Herdr has no incremental
 * "add subscription" method, so this list is fixed for the life of a stream and the pane set
 * changing means opening a new stream (two-phase, see `openStream`).
 */
export function herdrSubscriptions(paneIds: string[]): Record<string, unknown>[] {
  const subs: Record<string, unknown>[] = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
    { type: "pane.updated" },
    { type: "pane.focused" },
    { type: "pane.moved" },
    { type: "pane.agent_detected" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.focused" },
    { type: "tab.renamed" },
    { type: "tab.moved" },
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.reordered" },
    { type: "layout.updated" },
  ];
  for (const paneId of paneIds) {
    subs.push({ type: "pane.agent_status_changed", pane_id: paneId });
    subs.push({ type: "pane.scroll_changed", pane_id: paneId });
  }
  return subs;
}

const AGENT_STATES = new Set<string>(["working", "blocked", "idle", "done", "unknown"]);

function agentStateOf(v: unknown): AgentState {
  return typeof v === "string" && AGENT_STATES.has(v) ? (v as AgentState) : "unknown";
}

/**
 * Spec 8.13: `working` -> running, `idle`/`done` -> finished, `blocked` -> the new state. Herdr's
 * `done` is "idle and not yet seen in the Herdr UI"; the phone cannot observe that, so both map to
 * `finished` on purpose.
 */
const SESSION_STATE: Record<AgentState, SessionInfo["state"]> = {
  working: "running",
  blocked: "blocked",
  idle: "finished",
  done: "finished",
  unknown: "unknown",
};

/** Spec 8.13: agent name, else pane title, else cwd basename, else "Pane". */
function titleOf(pane: PaneInfo): string {
  const cwd = pane.foreground_cwd ?? pane.cwd;
  const base = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  return (
    pane.display_agent || pane.agent || pane.title || pane.terminal_title_stripped || base || "Pane"
  );
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function scrollOf(v: unknown): PaneScroll | undefined {
  return v && typeof v === "object" ? (v as PaneScroll) : undefined;
}

function sameSet(a: string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((x) => b.has(x));
}

function intervalFor(unchangedMs: number): number {
  if (unchangedMs < SETTLE_MEDIUM_MS) return POLL_FAST_MS;
  return unchangedMs < SETTLE_SLOW_MS ? POLL_MEDIUM_MS : POLL_SLOW_MS;
}

interface Pane {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  title: string;
  cwd?: string;
  /** Layout rect width in cells, else 80. */
  cols: number;
  /** Layout rect height in cells, else `scroll.viewport_rows`, else 24. */
  rows: number;
  /** True when `rows` came from a layout rect, so a scroll refresh must not override it. */
  rowsFromRect: boolean;
  windowNumber: number;
  tabIndex: number;
  paneIndex: number;
  focused: boolean;
  agentStatus: AgentState;
  /** `scroll.max_offset_from_bottom`: rows above the viewport = our `scrollbackTotal`. */
  scrollMax: number;
  /** Set when a `pane.scroll_changed` event carried no usable numbers. */
  scrollStale: boolean;
  scrollFetchedAt: number;
}

interface ProbeState {
  revision: number | null;
  intervalMs: number;
  lastChangeAt: number;
  nextAt: number;
}

interface StreamState {
  cancelled: boolean;
  live: boolean;
  buffer: HerdrEvent[];
  stream: HerdrStream | null;
}

export interface HerdrBackendOptions {
  client: HerdrClient;
  log: Logger;
  /** Spec 8.13: poll for the socket every 2 s after the server goes away. */
  reconnectMs?: number;
  /** Base tick of the adaptive revision poller. */
  revisionPollMs?: number;
  /** Debounce before a lifecycle-hint snapshot refresh / stream rebuild. */
  syncDebounceMs?: number;
  /** Minimum gap between `pane.get` scroll refreshes for one pane. */
  scrollRefreshMs?: number;
}

export class HerdrBackend implements TerminalBackend {
  readonly name = "herdr" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    // Herdr has no prompt/command lifecycle and no exit codes at all: the idle heuristic (8.8) and
    // `agent-state` carry the whole notification story.
    prompts: false,
    createSession: true,
    focus: true,
    history: true,
    // `pane.read` has no stable absolute line numbering, so the tracker must use `lineKey` overlap.
    absoluteLines: false,
  };

  private panes = new Map<string, Pane>();
  private byPaneId = new Map<string, string>();
  private order: string[] = [];
  private workspaces = new Set<string>();
  private focusedWorkspace: string | null = null;
  /** Bumped on every snapshot apply; an in-flight probe from an older generation is discarded. */
  private paneGen = 0;

  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly log: Logger;
  private readonly client: HerdrClient;

  private active: StreamState | null = null;
  private subscribedPaneIds = new Set<string>();

  private closed = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncBusy = false;
  private wantSnapshot = false;
  private wantResubscribe = false;

  private watched = new Set<string>();
  private readonly probes = new Map<string, ProbeState>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly opts: HerdrBackendOptions) {
    this.client = opts.client;
    this.log = opts.log.child({ backend: "herdr" });
  }

  /** Spec 8.12/8.13: `false` while the socket is down, so the registry drops us from `hello`. */
  get connected(): boolean {
    return !this.closed && this.active !== null;
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    this.closed = false;
    // Gate 1: semver (throws BackendUnavailable). Gate 2: the discovery snapshot doubles as the
    // `session.snapshot` feature probe -- it landed in 0.7.2 -- and tells us which panes exist, so
    // the very first subscription already covers all of them.
    await this.client.ping();
    let discovered: string[] = [];
    try {
      const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
      discovered = assertSnapshot(res?.snapshot).panes.map((p) => p.pane_id);
    } catch (err) {
      throw this.unavailable(err);
    }
    try {
      await this.openStream(discovered);
    } catch (err) {
      if (err instanceof BackendUnavailable) throw err;
      throw this.unavailable(err);
    }
  }

  private unavailable(err: unknown): BackendUnavailable {
    if (err instanceof BackendUnavailable) return err;
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code))
      return new BackendUnavailable(`herdr does not support session.snapshot (${detail})`, UPGRADE_HINT);
    if (err instanceof HerdrError && err.code === "malformed")
      return new BackendUnavailable(`herdr answered session.snapshot with junk (${detail})`, UPGRADE_HINT);
    return new BackendUnavailable(detail, INSTALL_HINT);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const active = this.active;
    this.active = null;
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.watched.clear();
    this.probes.clear();
    this.paneGen++;
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionInfo[]> {
    return this.order
      .map((id) => this.panes.get(id))
      .filter((p): p is Pane => p !== undefined)
      .map((p) => this.toInfo(p));
  }

  async getScreen(sessionId: string): Promise<Screen> {
    const pane = this.pane(sessionId);
    if (pane.scrollStale) await this.refreshScroll(pane);
    const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
      pane_id: pane.paneId,
      source: "visible",
      format: "ansi",
    });
    return herdrScreen({
      text: res?.read?.text ?? "",
      rows: pane.rows,
      cols: pane.cols,
      scrollMax: pane.scrollMax,
    });
  }

  /**
   * Spec 8.13: best-effort, styled, bounded. `source:"recent"` returns the **last** N lines of the
   * buffer (screen included), N <= 1000. `before` is in the same coordinate system as the
   * `scrollbackTotal` we emit (`scroll.max_offset_from_bottom` = the index of the screen's first
   * row), so `depth` is how far above our own screen top the requested page ends. There is no
   * stable absolute numbering (`absoluteLines: false`), so a short page plus `oldestAvailable` is
   * how the phone learns it has reached the top.
   */
  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const pane = this.pane(sessionId);
    const depth = Math.max(0, pane.scrollMax - before);
    const want = Math.min(MAX_READ_LINES, depth + count + pane.rows);
    let text: string;
    try {
      const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
        pane_id: pane.paneId,
        source: "recent",
        format: "ansi",
        lines: want,
      });
      text = res?.read?.text ?? "";
    } catch (err) {
      // A deep read of a busy recognised agent is refused, and an ANSI read never scrolls a
      // full-screen TUI anyway. Fall back to what we can always get -- the visible screen -- and
      // tell the phone to stop paging.
      if (err instanceof HerdrError && err.code === "agent_not_idle") {
        this.log.debug("herdr refused a deep read while the agent is busy", { want });
        const visible = await this.call<PaneReadResult>(sessionId, "pane.read", {
          pane_id: pane.paneId,
          source: "visible",
          format: "ansi",
        });
        const rows = parseAnsiLines(visible?.read?.text ?? "");
        const page = rows.slice(0, Math.max(0, rows.length - pane.rows));
        return { lines: page, oldestAvailable: before };
      }
      throw err;
    }
    const all = parseAnsiLines(text);
    const end = Math.max(0, all.length - depth - pane.rows);
    const start = Math.max(0, end - count);
    const lines = all.slice(start, end);
    const exhausted = all.length < want;
    const oldestAvailable = exhausted && start === 0 ? Math.max(0, before - lines.length) : 0;
    return { lines, oldestAvailable };
  }

  /**
   * Spec 8.13: `pane.send_text` writes literal bytes and never submits, so anything that ends in a
   * newline is split into text + a real `enter` key, and a payload that is exactly one named key's
   * bytes goes out as that key.
   */
  async sendText(sessionId: string, text: string): Promise<void> {
    const pane = this.pane(sessionId);
    const whole = herdrKeyForBytes(text);
    if (whole) {
      // spec 8.10 / Global Constraints: NEVER log keys. A key name is still a keystroke, so this
      // records only that one key was sent -- not which one.
      this.log.debug("herdr key");
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: [whole] });
      return;
    }
    // Never log the text itself (spec 8.10) -- only its length.
    this.log.debug("herdr text", { len: text.length });
    if (text.endsWith("\r") || text.endsWith("\n")) {
      const body = text.slice(0, -1);
      if (body) await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text: body });
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: ["enter"] });
      return;
    }
    await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text });
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const pane = this.pane(where.sessionId);
      // Shellbell's axis names the DIVIDER (like iTerm2's SplitPane.VERTICAL): "vertical" puts the
      // new pane to the right. Herdr's "down" is a horizontal divider. It has no left/up split.
      const res = await this.client.request<PaneInfoResult>("pane.split", {
        target_pane_id: pane.paneId,
        direction: where.direction === "vertical" ? "right" : "down",
        focus: false,
      });
      const id = str(res?.pane?.terminal_id);
      if (!id) throw new Error("herdr pane.split returned no terminal_id");
      // The snapshot is the only writer of the map: ask for one and return the new id now.
      this.scheduleSync("snapshot");
      return id;
    }
    if (where.windowId !== undefined && !this.workspaces.has(where.windowId))
      throw new BadWindow(where.windowId);
    const workspaceId = where.windowId ?? this.focusedWorkspace ?? [...this.workspaces][0];
    if (!workspaceId) throw new Error("herdr has no workspace to create a tab in");
    const res = await this.client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    const id = str(res?.root_pane?.terminal_id);
    if (!id) throw new Error("herdr tab.create returned no terminal_id");
    this.scheduleSync("snapshot");
    return id;
  }

  /** Spec 8.13: only ever from an explicit user action — this marks a `done` agent as seen. */
  async focus(sessionId: string): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.focus", { pane_id: pane.paneId });
  }

  /**
   * Spec 8.13: Herdr pushes nothing when a screen changes, so we probe `pane.copy_motion` — the one
   * side-effect-free call that returns the terminal's real content counter — but only for panes a
   * phone is viewing. `setWatched([])` stops the timer entirely.
   */
  setWatched(nativeIds: string[]): void {
    const next = new Set(nativeIds);
    for (const id of [...this.probes.keys()]) if (!next.has(id)) this.probes.delete(id);
    const now = Date.now();
    for (const id of next)
      if (!this.probes.has(id))
        this.probes.set(id, {
          revision: null,
          intervalMs: POLL_FAST_MS,
          lastChangeAt: now,
          nextAt: now,
        });
    this.watched = next;
    if (this.watched.size === 0 || this.closed) {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      return;
    }
    if (!this.pollTimer) {
      const tick = this.opts.revisionPollMs ?? POLL_FAST_MS;
      this.pollTimer = setInterval(() => {
        if (!this.polling) void this.runProbes();
      }, tick);
      // Never hold the process open for a poller.
      this.pollTimer.unref?.();
    }
  }

  // ---- internals ----

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  private pane(sessionId: string): Pane {
    const pane = this.panes.get(sessionId);
    if (!pane) throw new SessionGone(sessionId);
    return pane;
  }

  /**
   * Every pane-targeted call goes through here so a stale pane target does two things: tell the
   * caller (`SessionGone`) and ask the snapshot -- the only authority -- to reconcile, which is
   * what actually emits `session-removed` if the pane is really gone (spec 8.13).
   */
  private async call<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      if (err instanceof HerdrError && GONE_CODES.has(err.code)) {
        this.scheduleSync("snapshot");
        throw new SessionGone(sessionId);
      }
      throw err;
    }
  }

  private toInfo(p: Pane): SessionInfo {
    return {
      id: p.terminalId,
      backend: "herdr",
      title: p.title,
      cwd: p.cwd,
      cols: Math.max(1, p.cols),
      rows: Math.max(1, p.rows),
      windowId: p.workspaceId,
      windowNumber: p.windowNumber,
      tabId: p.tabId,
      tabIndex: p.tabIndex,
      paneIndex: p.paneIndex,
      // Herdr has no "my window is frontmost" signal; pane focus is the closest thing.
      isFocusedOnMac: p.focused,
      state: SESSION_STATE[p.agentStatus],
    };
  }

  private sortOrder(): void {
    this.order = [...this.panes.values()]
      .sort(
        (a, b) =>
          a.windowNumber - b.windowNumber ||
          a.tabIndex - b.tabIndex ||
          a.paneIndex - b.paneIndex ||
          a.paneId.localeCompare(b.paneId),
      )
      .map((p) => p.terminalId);
  }

  // ---- stream / sync ----

  /**
   * Two-phase (spec 8.13): the new subscription connection is opened and **acked** — and is already
   * buffering events — before it replaces the current one, so the handover loses nothing. The
   * snapshot that follows is the only writer of the pane map; if it fails, the new stream is closed
   * and the reconnect poll takes over.
   */
  private async openStream(paneIds?: string[]): Promise<void> {
    const ids = paneIds ?? [...this.byPaneId.keys()];
    const state: StreamState = { cancelled: false, live: false, buffer: [], stream: null };
    const stream = await this.client.subscribe(herdrSubscriptions(ids), {
      onEvent: (e) => {
        if (state.cancelled) return;
        if (state.live) {
          this.onEvent(e);
          return;
        }
        if (state.buffer.length < MAX_BUFFERED_EVENTS) state.buffer.push(e);
      },
      onEnd: (reason) => {
        if (!state.cancelled && this.active === state) this.onStreamEnd(reason);
      },
    });
    state.stream = stream;
    if (this.closed) {
      state.cancelled = true;
      stream.close();
      return;
    }
    const previous = this.active;
    this.active = state;
    this.subscribedPaneIds = new Set(ids);
    if (previous) {
      previous.cancelled = true;
      previous.stream?.close();
    }
    try {
      await this.refreshSnapshot();
    } catch (err) {
      state.cancelled = true;
      stream.close();
      if (this.active === state) this.active = null;
      throw err;
    }
    // Only now do buffered events run — against a map the snapshot has already installed.
    state.live = true;
    const buffered = state.buffer;
    state.buffer = [];
    for (const e of buffered) this.onEvent(e);
    this.emit({ type: "layout-changed" });
  }

  private async refreshSnapshot(): Promise<void> {
    const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
    this.applySnapshot(assertSnapshot(res?.snapshot));
  }

  /**
   * Spec 8.13: every lifecycle event is a hint. They coalesce into one debounced, single-flight
   * snapshot (and, when the pane set changed, one stream rebuild). Nothing here can be scheduled by
   * the work it triggers, so there is no loop.
   */
  private scheduleSync(reason: "snapshot" | "resubscribe"): void {
    if (this.closed) return;
    if (reason === "resubscribe") this.wantResubscribe = true;
    else this.wantSnapshot = true;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSync();
    }, this.opts.syncDebounceMs ?? 250);
    this.syncTimer.unref?.();
  }

  private async runSync(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      while ((this.wantResubscribe || this.wantSnapshot) && !this.closed && this.active) {
        const resubscribe = this.wantResubscribe;
        this.wantResubscribe = false;
        this.wantSnapshot = false;
        if (resubscribe) await this.openStream();
        else await this.refreshSnapshot();
      }
    } catch (err) {
      // The socket is the only thing that can fail here; treat it as a disconnect so the normal
      // reconnect path (and its `session-removed` storm) runs exactly once.
      this.log.warn("herdr sync failed", { error: errName(err) });
      this.onStreamEnd("sync-failed");
    } finally {
      this.syncBusy = false;
    }
  }

  /** Spec 8.13: the server exiting removes the socket file; poll for it every 2 s. */
  private onStreamEnd(reason: string): void {
    if (this.closed) return;
    const active = this.active;
    this.active = null;
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.log.info("herdr stream ended", { reason });
    // Loudly: the tracker drops its viewers, the EventEngine forgets each session (so a pane that
    // comes back blocked counts as a first sighting, not a transition), and `connected` is false.
    const ids = [...this.order];
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.probes.clear();
    this.subscribedPaneIds.clear();
    this.paneGen++;
    for (const id of ids) this.emit({ type: "session-removed", sessionId: id });
    this.emit({ type: "layout-changed" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.opts.reconnectMs ?? 2000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err) => {
        this.log.debug("herdr reconnect failed", { error: errName(err) });
        this.scheduleReconnect();
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- snapshot ----

  private applySnapshot(snap: SessionSnapshot): void {
    const workspaceNumbers = new Map<string, number>();
    const workspaces = new Set<string>();
    for (const w of snap.workspaces ?? []) {
      workspaces.add(w.workspace_id);
      workspaceNumbers.set(w.workspace_id, w.number ?? 0);
    }
    const tabNumbers = new Map<string, number>();
    for (const t of snap.tabs ?? []) tabNumbers.set(t.tab_id, t.number ?? 0);
    const rects = rectIndex(snap.layouts ?? []);

    const prev = this.panes;
    const next = new Map<string, Pane>();
    const byPaneId = new Map<string, string>();
    const changed: { id: string; state: AgentState; agent?: string }[] = [];
    for (const info of snap.panes) {
      const id = info.terminal_id ?? info.pane_id;
      const was = prev.get(id);
      const rect = rects.get(info.pane_id);
      const state = agentStateOf(info.agent_status);
      const viewportRows = info.scroll?.viewport_rows;
      next.set(id, {
        terminalId: id,
        paneId: info.pane_id,
        workspaceId: info.workspace_id,
        tabId: info.tab_id,
        title: titleOf(info),
        cwd: info.foreground_cwd ?? info.cwd,
        cols: rect?.cols ?? was?.cols ?? 80,
        rows: Math.max(1, rect?.rows ?? viewportRows ?? was?.rows ?? 24),
        rowsFromRect: rect !== undefined,
        windowNumber: workspaceNumbers.get(info.workspace_id) ?? 0,
        tabIndex: tabNumbers.get(info.tab_id) ?? 0,
        paneIndex: rect?.order ?? 0,
        focused: info.focused === true || info.pane_id === snap.focused_pane_id,
        agentStatus: state,
        scrollMax: info.scroll?.max_offset_from_bottom ?? was?.scrollMax ?? 0,
        scrollStale: was?.scrollStale ?? false,
        scrollFetchedAt: was?.scrollFetchedAt ?? 0,
      });
      byPaneId.set(info.pane_id, id);
      workspaces.add(info.workspace_id);
      if (was?.agentStatus !== state)
        changed.push({ id, state, agent: info.display_agent ?? info.agent });
    }
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const added = [...next.keys()].filter((id) => !prev.has(id));

    this.panes = next;
    this.byPaneId = byPaneId;
    this.workspaces = workspaces;
    this.focusedWorkspace = snap.focused_workspace_id ?? null;
    this.paneGen++;
    this.sortOrder();
    for (const id of removed) {
      this.probes.delete(id);
      this.watched.delete(id);
    }

    // Order matters: the agent must learn a session exists before it hears about its state.
    for (const id of removed) this.emit({ type: "session-removed", sessionId: id });
    for (const id of added) this.emit({ type: "session-added", sessionId: id });
    const at = Date.now();
    for (const c of changed)
      this.emit({ type: "agent-state", sessionId: c.id, state: c.state, agent: c.agent, at });
    if (removed.length > 0 || added.length > 0) this.emit({ type: "layout-changed" });

    // Herdr has no incremental subscription call, so a changed pane set means a new stream.
    // This is the ONLY place that asks for one, and after it runs the sets match -- no loop.
    if (!sameSet([...byPaneId.keys()], this.subscribedPaneIds)) this.scheduleSync("resubscribe");
  }

  // ---- events ----

  private onEvent(e: HerdrEvent): void {
    try {
      this.handleEvent(e);
    } catch (err) {
      this.log.warn("herdr event handling failed", { event: e.event, error: errName(err) });
    }
  }

  /**
   * Lifecycle events arrive snake_case (`pane_created`) while the three subscription-driven ones
   * keep their dotted subscription name (`pane.agent_status_changed`). Normalising the separator
   * makes the table tolerant of both.
   */
  private handleEvent(e: HerdrEvent): void {
    const kind = e.event.replaceAll(".", "_");
    const data = e.data;
    switch (kind) {
      // --- hints: the snapshot decides what actually changed ---
      case "pane_created":
      case "pane_closed":
      case "pane_exited":
      case "pane_moved":
      case "pane_updated":
      case "pane_agent_detected":
      case "tab_created":
      case "tab_closed":
      case "tab_renamed":
      case "tab_moved":
      case "workspace_created":
      case "workspace_updated":
      case "workspace_closed":
      case "workspace_renamed":
      case "workspace_moved":
      case "workspace_reordered":
        this.scheduleSync("snapshot");
        return;

      // --- values on a pane that already exists ---
      case "pane_agent_status_changed": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        const state = agentStateOf(data.agent_status);
        const agent = str(data.display_agent) ?? str(data.agent);
        const title = str(data.title);
        // Herdr suppresses spinner-only churn, so any title here is a real one.
        if (agent || title) {
          const next = agent || title || pane.title;
          if (next !== pane.title) {
            pane.title = next;
            this.emit({ type: "title-changed", sessionId: pane.terminalId });
          }
        }
        if (pane.agentStatus === state) return;
        pane.agentStatus = state;
        this.emit({
          type: "agent-state",
          sessionId: pane.terminalId,
          state,
          agent,
          at: Date.now(),
        });
        return;
      }
      case "pane_scroll_changed": {
        // The research documents this event as `{ pane_id }` only, so the `pane.get` refresh
        // below is the PRIMARY path and the payload branch is an opportunistic shortcut for a
        // build that does send numbers. Both are cheap; neither is load-bearing on the other.
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        const scroll = scrollOf(data.scroll);
        if (scroll && typeof scroll.max_offset_from_bottom === "number") {
          pane.scrollMax = scroll.max_offset_from_bottom;
          if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
            pane.rows = Math.max(1, scroll.viewport_rows);
          pane.scrollStale = false;
          return;
        }
        // The payload shape is a spike item: mark it stale and let `getScreen` refresh it, at most
        // once a second, rather than firing a `pane.get` per scrolled line.
        pane.scrollStale = true;
        return;
      }
      case "layout_updated": {
        const layout = data.layout as PaneLayoutSnapshot | undefined;
        if (layout) {
          for (const [paneId, rect] of rectIndex([layout])) {
            const pane = this.paneByPaneId(paneId);
            if (!pane) continue;
            pane.cols = rect.cols;
            pane.rows = Math.max(1, rect.rows);
            pane.rowsFromRect = true;
            pane.paneIndex = rect.order;
          }
          this.sortOrder();
        }
        this.emit({ type: "layout-changed" });
        return;
      }
      case "pane_focused": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (pane) for (const p of this.panes.values()) p.focused = p === pane;
        // A pane we have never seen means our map is behind: ask the only authority there is.
        else this.scheduleSync("snapshot");
        this.emit({ type: "focus-changed" });
        return;
      }
      case "tab_focused":
      case "workspace_focused":
        this.emit({ type: "focus-changed" });
        return;
      default:
        this.log.debug("unhandled herdr event", { event: e.event });
        return;
    }
  }

  private paneByPaneId(paneId: string | undefined): Pane | undefined {
    const id = paneId ? this.byPaneId.get(paneId) : undefined;
    return id ? this.panes.get(id) : undefined;
  }

  private async refreshScroll(pane: Pane): Promise<void> {
    const now = Date.now();
    const gap = this.opts.scrollRefreshMs ?? 1000;
    if (now - pane.scrollFetchedAt < gap) return;
    pane.scrollFetchedAt = now;
    try {
      const res = await this.client.request<PaneInfoResult>("pane.get", { pane_id: pane.paneId });
      const scroll = res?.pane?.scroll;
      if (scroll && typeof scroll.max_offset_from_bottom === "number") {
        pane.scrollMax = scroll.max_offset_from_bottom;
        if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
          pane.rows = Math.max(1, scroll.viewport_rows);
      }
      pane.scrollStale = false;
    } catch (err) {
      this.log.debug("herdr scroll refresh failed", { error: errName(err) });
    }
  }

  // ---- revision poller ----

  /**
   * One pass over the watched panes, **sequentially**: every probe is a fresh connection and Herdr
   * spawns a thread per connection, so a burst of parallel probes is exactly what we must not do.
   * After each await the world may have changed -- the pane may be unwatched, the backend closed,
   * or a snapshot may have renumbered everything -- so all of that is re-checked before anything is
   * emitted or stored.
   */
  private async runProbes(): Promise<void> {
    this.polling = true;
    try {
      for (const id of [...this.watched]) {
        if (this.closed || !this.watched.has(id)) continue;
        const pane = this.panes.get(id);
        const probe = this.probes.get(id);
        if (!pane || !probe) continue;
        const now = Date.now();
        if (now < probe.nextAt) continue;
        const gen = this.paneGen;
        const paneId = pane.paneId;
        let revision: number | undefined;
        try {
          const res = await this.client.request<CopyMotionResult>("pane.copy_motion", {
            pane_id: paneId,
            cursor: { row: 0, col: 0 },
            motion: "line_end",
          });
          revision = typeof res?.content_revision === "number" ? res.content_revision : undefined;
        } catch (err) {
          if (err instanceof HerdrError && GONE_CODES.has(err.code)) this.scheduleSync("snapshot");
          else this.log.debug("herdr revision probe failed", { error: errName(err) });
        }
        if (this.closed || !this.watched.has(id) || this.paneGen !== gen) continue;
        const current = this.panes.get(id);
        const state = this.probes.get(id);
        if (!current || !state || current.paneId !== paneId) continue;
        const t = Date.now();
        state.nextAt = t + state.intervalMs;
        // Odd = a write is in flight: skip it entirely, and keep the old baseline so the settled
        // even value still reads as a change.
        if (revision === undefined || revision % 2 === 1) continue;
        if (state.revision === null) {
          // First probe: baseline only. The tracker already snapshots when a viewer arrives.
          state.revision = revision;
          continue;
        }
        if (revision !== state.revision) {
          state.revision = revision;
          state.lastChangeAt = t;
          this.emit({ type: "screen-changed", sessionId: id });
        }
        state.intervalMs = intervalFor(t - state.lastChangeAt);
        state.nextAt = t + state.intervalMs;
      }
    } finally {
      this.polling = false;
    }
  }
}

/** `session.snapshot` must actually be a snapshot; anything else is a broken/incompatible herdr. */
function assertSnapshot(snap: unknown): SessionSnapshot {
  const s = snap as SessionSnapshot | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.panes))
    throw new HerdrError("malformed", "session.snapshot returned no panes array");
  return s;
}

function rectIndex(
  layouts: PaneLayoutSnapshot[],
): Map<string, { cols: number; rows: number; order: number }> {
  const out = new Map<string, { cols: number; rows: number; order: number }>();
  for (const layout of layouts) {
    const panes = [...(layout.panes ?? [])].sort(
      (a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0) || (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );
    panes.forEach((p, order) => {
      out.set(p.pane_id, {
        cols: Math.max(1, p.rect?.width ?? 80),
        rows: Math.max(1, p.rect?.height ?? 24),
        order,
      });
    });
  }
  return out;
}
```

- [ ] **Step 6: Run the tests**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck
pnpm lint:fix && pnpm lint
```
Expected: green. If a socket-timing test flakes, raise its `waitFor` budget — never raise
`reconnectMs`/`revisionPollMs`, which are the behaviours under test.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): HerdrBackend — snapshot-driven sessions, screens, input and polling"
```

---

### Task 5: Ring on agent state — `EventEngine`, `Notifier`, `Agent` (spec 8.8, 8.13 "Agent state → rings")

**Files:**
- Modify: `apps/agent/src/events.ts`, `apps/agent/src/agent.ts`
- Modify: `apps/agent/test/events.test.ts`

**Interfaces:**
- `Ring.kind` widens to `"prompt" | "idle" | "blocked"`. `Notifier` needs **no change**: it already
  forwards `r.kind` into the ctrl `notify`, whose enum Task 1 widened.
- `EventEngine` per-session state gains `agentState: AgentState | null` and
  `workingSince: number | null`.
- `EventEngine.stateOf` can now return `"blocked"`.

**The rules this task implements (spec 8.13), stated once so the code and the tests agree:**

| Transition | Inner `event` to all phones | Ring |
|---|---|---|
| `* → blocked` when this session was never seen before (`prev === null`) | `kind: "blocked"` | **no** — adoption is not a transition. This is also the reconnect case: the backend emits `session-removed` for every pane when the socket dies, which makes `EventEngine.forget` drop the state, so a pane that comes back still blocked is a first sighting again |
| `working\|idle\|done\|unknown → blocked` | `kind: "blocked"` | `kind: "blocked"`, immediately (the `Notifier`'s 60 s per-session limit still applies) |
| `working → idle\|done` | `kind: "prompt"` with `durationMs`, **no `exitCode`** (Herdr has none) | only if `durationMs >= notifyMinCommandMs` |
| `blocked → idle\|done`, `* → working`, `* → unknown` | none | none |
| a repeat of the state we already hold | none | none |

`blocked`, and a `prompt` that rings, also set `lastPromptRingAt = now` and clear `activeSince`, so
the 8.8 idle heuristic cannot ring a second time for the same quiet screen.

`SessionInfo.state` follows `promptState`: `working → "running"`, `blocked → "blocked"`,
`idle|done → "finished"`, `unknown → "unknown"`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent/test/events.test.ts`, inside the existing `describe("EventEngine")` block
(the `engine()` helper with `advance` and `jump` already exists in that file):

```ts
  it("agent-state: blocked rings on a transition, never on the first sighting", () => {
    const { e, events, rings, now } = engine();
    // Bootstrap: the pane is already blocked the first time we see it. State only, no ring.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(e.stateOf("H")).toBe("blocked");
    expect(events).toEqual(["blocked:H::"]);
    expect(rings).toEqual([]);

    // A real transition rings immediately.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    expect(e.stateOf("H")).toBe("running");
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual(["blocked:H"]);

    // Repeats are no-ops.
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual(["blocked:H"]);
    expect(events).toEqual(["blocked:H::", "blocked:H::"]);
  });

  it("agent-state: a herdr restart re-adopts a blocked pane without ringing", () => {
    // spec 8.13: the backend removes every session when its socket dies, so the engine forgets
    // the pane; when herdr comes back the same pane is a FIRST sighting again, even though it
    // was `working` before the restart and is `blocked` after it.
    const { e, rings, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "session-removed", sessionId: "H" });
    e.onBackendEvent({ type: "session-added", sessionId: "H" });
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    expect(rings).toEqual([]);
    expect(e.stateOf("H")).toBe("blocked");
  });

  it("agent-state: working -> idle emits prompt, and rings past notifyMinCommandMs", () => {
    const { e, events, rings, jump, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    jump(2000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(events).toEqual(["prompt:H::2000"]);
    expect(rings).toEqual([]);
    expect(e.stateOf("H")).toBe("finished");

    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    jump(12_000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "done", at: now() });
    expect(events[1]).toBe("prompt:H::12000");
    expect(rings).toEqual(["prompt:H"]);
    expect(e.stateOf("H")).toBe("finished");
  });

  it("agent-state: answering a blocked agent neither rings nor emits", () => {
    const { e, events, rings, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "blocked", at: now() });
    events.length = 0;
    rings.length = 0;
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(events).toEqual([]);
    expect(rings).toEqual([]);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "unknown", at: now() });
    expect(e.stateOf("H")).toBe("unknown");
  });

  it("agent-state: the idle heuristic does not ring again for the same quiet screen", () => {
    const { e, rings, advance, jump, now } = engine();
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "working", at: now() });
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "H" });
    jump(11_000);
    e.onBackendEvent({ type: "agent-state", sessionId: "H", state: "idle", at: now() });
    expect(rings).toEqual(["prompt:H"]);
    advance(5000);
    expect(rings).toEqual(["prompt:H"]);
  });
```

and to `describe("Notifier")`:

```ts
  it("forwards a blocked ring as a notify with kind blocked", () => {
    const sent: CtrlMessage[] = [];
    const n = new Notifier(
      (m) => sent.push(m),
      createLogger({ stdout: false }),
      () => 0,
    );
    expect(n.ring({ sessionId: "herdr:term_a", kind: "blocked" })).toBe(true);
    expect(sent[0]).toEqual({
      type: "notify",
      sessionId: "herdr:term_a",
      kind: "blocked",
      exitCode: undefined,
      durationMs: undefined,
    });
    // The 60 s per-session limit covers blocked exactly like every other kind.
    expect(n.ring({ sessionId: "herdr:term_a", kind: "blocked" })).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.

- [ ] **Step 3: Implement `events.ts`**

Widen `Ring` and extend the per-session state:

```ts
export interface Ring {
  sessionId: string;
  kind: "prompt" | "idle" | "blocked";
  exitCode?: number;
  durationMs?: number;
}
```

```ts
interface S {
  promptState: SessionInfo["state"];
  commandStartedAt: number | null;
  command: string;
  lastChangeAt: number;
  activeSince: number | null;
  lastPromptRingAt: number;
  /** Spec 8.13: the last herdr agent state we saw; `null` until the first `agent-state` event. */
  agentState: AgentState | null;
  /** When the agent last entered `working`, for the `prompt` ring's durationMs. */
  workingSince: number | null;
}
```

with the two new fields seeded in `get()`:

```ts
        lastPromptRingAt: Number.NEGATIVE_INFINITY,
        agentState: null,
        workingSince: null,
```

and the import at the top of the file widened:

```ts
import type { AgentState, BackendEvent } from "./backends/types.js";
```

Then add the new case to `onBackendEvent`, immediately before `case "session-removed"`:

```ts
      case "agent-state": {
        // Spec 8.13. Herdr has no command lifecycle at all, so this is the whole prompt story for
        // herdr sessions: `blocked` means "a human is needed now", and working -> idle|done is the
        // analogue of `command-end` (with a duration, but never an exit code).
        const x = this.get(e.sessionId);
        const prev = x.agentState;
        if (prev === e.state) return;
        x.agentState = e.state;
        if (e.state === "working") {
          x.promptState = "running";
          x.workingSince = now;
          return;
        }
        if (e.state === "blocked") {
          x.promptState = "blocked";
          x.workingSince = null;
          // The screen is about to go quiet while the agent waits: suppress the idle heuristic so
          // one blocked agent cannot produce two rings.
          x.activeSince = null;
          x.lastPromptRingAt = now;
          this.emit("event", { type: "event", sessionId: e.sessionId, kind: "blocked", at: now });
          // `prev === null` means we have never seen this session before: agent start, or a herdr
          // reconnect (which removes and re-adds every pane, dropping this state). Adopt the
          // state, but never ring for history.
          if (prev !== null) this.emit("ring", { sessionId: e.sessionId, kind: "blocked" });
          return;
        }
        if (e.state === "idle" || e.state === "done") {
          x.promptState = "finished";
          const startedAt = x.workingSince;
          x.workingSince = null;
          if (prev !== "working" || startedAt === null) return;
          const durationMs = now - startedAt;
          this.emit("event", {
            type: "event",
            sessionId: e.sessionId,
            kind: "prompt",
            durationMs,
            at: now,
          });
          if (durationMs >= this.opts.notifyMinCommandMs) {
            x.lastPromptRingAt = now;
            x.activeSince = null;
            this.emit("ring", { sessionId: e.sessionId, kind: "prompt", durationMs });
          }
          return;
        }
        x.promptState = "unknown";
        x.workingSince = null;
        return;
      }
```

- [ ] **Step 4: Implement the `Agent` hooks**

`apps/agent/src/agent.ts`, three changes.

**(a)** In `onBackendEvent`'s switch, add `agent-state` to the group that re-broadcasts `sessions`:

```ts
      case "layout-changed":
      case "session-added":
      case "focus-changed":
      case "title-changed":
      // spec 8.13: `SessionInfo.state` comes from `EventEngine.stateOf`, which the
      // `this.events.onBackendEvent(e)` call above has just changed -- the phones need the new list.
      case "agent-state":
        this.scheduleSessions();
        return;
```

**(b)** `refreshSessions` must not flatten a backend-provided state (ruling 11): the engine wins
only once it actually knows something.

```ts
  private async refreshSessions(): Promise<void> {
    try {
      const list = await this.o.registry.listSessions();
      // spec 8.12/8.13: a backend can know a session's state before any event has been processed
      // (herdr's first snapshot reports `blocked` outright). The EventEngine is authoritative once
      // it has an opinion; `"unknown"` is not an opinion.
      this.sessions = list.map((s) => {
        const known = this.events.stateOf(s.id);
        return known === "unknown" ? s : { ...s, state: known };
      });
      this.broadcastHelloIfBackendsChanged();
      this.broadcast({ type: "sessions", list: this.sessions });
    } catch (err) {
      // Unchanged from the shipped code -- keep the error NAME, never `String(err)`: a backend's
      // error message can quote a session title or a command line (spec 8.10, log names/lengths).
      this.log.warn("listSessions failed", { err: err instanceof Error ? err.name : "unknown" });
    }
  }
```

Only three things change in this method: the `state` merge, the `broadcastHelloIfBackendsChanged()`
call, and the two comments. The `try`, the `await this.o.registry.listSessions()` and the `catch`
body are byte-for-byte the shipped ones.

**(c)** Spec 8.12: "changes trigger a new `hello`". Add the field and the method:

```ts
  /** Last `hello.backends` fingerprint sent, so a backend appearing or dying re-announces itself. */
  private backendsKey: string | null = null;
```

```ts
  /**
   * spec 8.12: `hello.backends` lists the CONNECTED backends, and a change to that set must reach
   * every phone. Herdr makes the set genuinely dynamic (it appears when the user starts herdr and
   * disappears when the socket dies), so this runs on every debounced refresh.
   */
  private broadcastHelloIfBackendsChanged(): void {
    const backends = this.o.registry.connected();
    const key = backends
      .map((b) => b.name)
      .sort()
      .join(",");
    if (key === this.backendsKey) return;
    const first = this.backendsKey === null;
    this.backendsKey = key;
    if (first) return; // the per-phone `hello` sent at handshake already carries this set
    for (const l of this.links.values())
      l.send({
        type: "hello",
        agentVersion: this.o.appVersion,
        backends,
        computerName: this.o.config.computerName,
        accent: this.o.config.accent,
      });
  }
```

- [ ] **Step 5: Run the tests** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`, then
`perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck`, then `pnpm lint:fix && pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): ring on herdr agent state (blocked and prompt)"
```

---

### Task 6: Wire it up — registry, tracker, detection, doctor and the CLI (spec 8.12, 8.13, 8.6)

**Files:**
- Modify: `apps/agent/src/backends/registry.ts`, `apps/agent/src/screen-tracker.ts`, `apps/agent/src/agent.ts`
- Modify: `apps/agent/src/cli.ts`, `apps/agent/src/doctor.ts`
- Modify: `apps/agent/test/fakes/fake-backend.ts`, `apps/agent/test/registry.test.ts`, `apps/agent/test/screen-tracker.test.ts`
- Create: `apps/agent/src/backends/herdr/start.ts`, `apps/agent/test/herdr-start.test.ts`, `apps/agent/test/herdr-agent.test.ts`
- Modify: `README.md`, `docs/self-hosting.md`

**Interfaces:**
- `registry.ts`: `splitId` accepts any `BackendName` (via the schema, not a hard-coded pair);
  `listSessions` iterates `BACKEND_ORDER = ["iterm2", "tmux", "herdr"]`; `connected()` **filters out
  members reporting `connected === false`** (ruling 3); new
  `BackendRegistry.setWatched(ids: string[]): void`.
- `screen-tracker.ts`: pushes the watched set through `backend.setWatched?.()` on every viewer
  change (and `[]` on `stop()`), de-duplicated. **Ruling 8 (per-session `absoluteLines`) needs no
  work here — it already shipped**: `processScreen` reads
  `this.opts.backend.capabilitiesOf?.(sessionId)?.absoluteLines ?? this.opts.backend.capabilities.absoluteLines`,
  and `BackendRegistry.capabilitiesOf` is the registry method it resolves to. Do **not** add a
  `capabilitiesOf` option to `ScreenTrackerOptions`.
- `start.ts`: `interface HerdrCheck { name: string; ok: boolean; detail: string; fix?: string }`
  (structurally identical to `doctor.ts`'s `Check`), `checkHerdr(opts?): Promise<HerdrCheck>`,
  `startHerdrBackend(opts): { stop(): void }`.

**Rulings this task pins:** 3 (`connected()` + `hello`),
11 (`registry.add` **before** `connect()`, and the production startup path is tested end to end),
14 (an absent Herdr is a **passing** doctor check), 22 (`startHerdrBackend`'s handle is wired into
the CLI's `shutdown`). **Ruling 8 (per-session `absoluteLines`) is already satisfied by shipped
code** (`screen-tracker.ts` + `BackendRegistry.capabilitiesOf`, with a dedicated describe block at
the bottom of `test/screen-tracker.test.ts`); this task must not re-implement or re-test it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent/test/fakes/fake-backend.ts` — two fields next to `sentText`:

```ts
  /** Every `setWatched` call the tracker or registry made, in order (spec 8.13). */
  watched: string[][] = [];
  /** Spec 8.12: `false` hides this backend from `hello.backends` without unregistering it. */
  isConnected = true;
```

and a method next to `focus`:

```ts
  setWatched(ids: string[]): void {
    this.watched.push([...ids]);
  }
```

Add to `apps/agent/test/registry.test.ts`:

```ts
  it("routes herdr ids and fans setWatched out to every member as native ids", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);

    expect((await reg.listSessions()).map((s) => s.id)).toEqual(["iterm2:A", "herdr:term_a"]);
    expect(splitId("herdr:term_a")).toEqual({ name: "herdr", native: "term_a" });
    await reg.sendText("herdr:term_a", "x");
    expect(herdr.sentText).toEqual([{ id: "term_a", text: "x" }]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);

    reg.setWatched(["herdr:term_a", "iterm2:A", "bogus"]);
    expect(herdr.watched.at(-1)).toEqual(["term_a"]);
    expect(iterm.watched.at(-1)).toEqual(["A"]);
    // A backend with no watchers still gets a call -- that is how it learns to stop polling.
    reg.setWatched([]);
    expect(herdr.watched.at(-1)).toEqual([]);
    expect(iterm.watched.at(-1)).toEqual([]);
  });

  it("hides a disconnected member from connected() but keeps routing to it", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2", "herdr"]);
    // spec 8.12/8.13: its socket died; it stays registered (it reconnects itself) but the phones
    // must not be told it is available.
    herdr.isConnected = false;
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2"]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);
  });
```

Add to `apps/agent/test/screen-tracker.test.ts`:

```ts
  it("pushes the viewed set to the backend and stops when the last viewer leaves", async () => {
    backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
    tracker.setViewed("p1", "S");
    expect(backend.watched.at(-1)).toEqual(["S"]);
    tracker.setViewed("p2", "T");
    expect(backend.watched.at(-1)).toEqual(["S", "T"]);
    // A second viewer on a session already watched changes nothing, so nothing is re-sent.
    const calls = backend.watched.length;
    tracker.setViewed("p3", "S");
    expect(backend.watched.length).toBe(calls);
    tracker.setViewed("p1", null);
    tracker.setViewed("p3", null);
    expect(backend.watched.at(-1)).toEqual(["T"]);
    tracker.sessionRemoved("T");
    expect(backend.watched.at(-1)).toEqual([]);
  });
```

That is the **only** test to add to `screen-tracker.test.ts`. Per-session `absoluteLines` is
already covered by the shipped describe block at the bottom of that file
(`describe("per-backend absoluteLines via BackendRegistry.capabilitiesOf …")`), which drives a real
`BackendRegistry` with an iTerm2 (`absoluteLines: true`) and a tmux (`absoluteLines: false`) member
and asserts the overlap heuristic runs for exactly one of them. Do not add a second, weaker copy.

Create `apps/agent/test/herdr-start.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHerdr, startHerdrBackend } from "../src/backends/herdr/start.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let server: FakeHerdr | null = null;
let handle: { stop(): void } | null = null;

afterEach(async () => {
  handle?.stop();
  handle = null;
  await server?.stop();
  server = null;
});

const emptySnapshot = () => ({
  type: "session_snapshot",
  snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] },
});

describe("checkHerdr", () => {
  it("reports the version and protocol when herdr answers", async () => {
    server = new FakeHerdr();
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    expect(await checkHerdr({ log, socketPath: server.path })).toEqual({
      name: "herdr",
      ok: true,
      detail: "v0.8.2 protocol 22",
    });
  });

  it("PASSES when herdr is not installed at all (it is optional)", async () => {
    // spec 8.13 (ruling 14): `doctor` exits 1 if any check fails, and most users have no herdr.
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-doctor-"));
    const check = await checkHerdr({ log, socketPath: join(dir, "herdr.sock") });
    expect(check).toEqual({ name: "herdr", ok: true, detail: "not installed (optional)" });
  });

  it("FAILS when a running herdr is too old, with the upgrade fix", async () => {
    server = new FakeHerdr();
    server.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 22 }));
    await server.start();
    const check = await checkHerdr({ log, socketPath: server.path });
    expect(check.ok).toBe(false);
    expect(check.fix).toMatch(/0\.7\.2/);
  });

  it("FAILS when a running herdr has no session.snapshot", async () => {
    server = new FakeHerdr();
    server.fail("session.snapshot", "invalid_request", "unknown method");
    await server.start();
    const check = await checkHerdr({ log, socketPath: server.path });
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/session\.snapshot/);
  });
});

describe("startHerdrBackend", () => {
  it("registers the backend BEFORE connecting, then keeps retrying until herdr appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    handle = startHerdrBackend({
      registry,
      log,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, revisionPollMs: 60_000, syncDebounceMs: 60_000 },
    });
    // spec 8.12 (ruling 11): the member is registered immediately, so the agent is subscribed to
    // its events before `connect()` can emit any -- but it is NOT advertised while it is down.
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.connected()).toEqual([]);
    expect(registry.nameOf("herdr:x")).toBe("herdr");

    server = new FakeHerdr(socketPath);
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    await waitFor(() => registry.connected().some((b) => b.name === "herdr"), 3000);
    expect(registry.connected().find((b) => b.name === "herdr")?.capabilities.prompts).toBe(false);
  });
});
```

Create `apps/agent/test/herdr-agent.test.ts` — the production startup path end to end (ruling 11 and
the "missing tests" list in both reviews):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHerdrBackend } from "../src/backends/herdr/start.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { EventEngine, type Ring } from "../src/events.js";
import { createLogger } from "../src/log.js";
import { Notifier } from "../src/notifier.js";
import type { BackendEvent } from "../src/backends/types.js";
import type { CtrlMessage, SessionInfo } from "@shellbell/protocol";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
const snapshot = () =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "herdr-session-snapshot.json"), "utf8"),
  ).result as unknown;

let server: FakeHerdr;
let handle: { stop(): void } | null = null;

beforeEach(async () => {
  server = new FakeHerdr();
  server.reply("session.snapshot", snapshot);
  await server.start();
});
afterEach(async () => {
  handle?.stop();
  handle = null;
  await server.stop();
});

/**
 * The real wiring in miniature: registry -> EventEngine -> Notifier, exactly as `Agent` composes
 * them, so the startup ordering bug (states emitted before anyone is listening, then flattened to
 * "unknown") cannot come back.
 */
function harness() {
  const registry = new BackendRegistry(log);
  const events = new EventEngine({
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4000,
    idleMinActiveMs: 1500,
  });
  const rings: Ring[] = [];
  const notified: CtrlMessage[] = [];
  const notifier = new Notifier((m) => notified.push(m), log);
  events.on("ring", (r) => {
    rings.push(r);
    notifier.ring(r);
  });
  const seen: BackendEvent[] = [];
  registry.on((e) => {
    seen.push(e);
    events.onBackendEvent(e);
  });
  const sessions = async (): Promise<SessionInfo[]> =>
    (await registry.listSessions()).map((s) => {
      const known = events.stateOf(s.id);
      return known === "unknown" ? s : { ...s, state: known };
    });
  return { registry, events, rings, notified, seen, sessions };
}

describe("herdr through the agent's units", () => {
  it("shows an already-blocked agent without ringing, then rings on the next transition", async () => {
    const h = harness();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, revisionPollMs: 60_000, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);

    const list = await h.sessions();
    expect(list.map((s) => [s.id, s.state])).toEqual([
      ["herdr:term_a", "blocked"],
      ["herdr:term_b", "unknown"],
      ["herdr:term_c", "running"],
    ]);
    // Adoption is not a transition: the phone sees `blocked`, but nothing rang.
    expect(h.rings).toEqual([]);
    expect(h.notified).toEqual([]);

    // Now a real transition: working -> blocked rings, and reaches the relay as `notify`.
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "working" });
    await waitFor(() => h.seen.some((e) => e.type === "agent-state" && e.sessionId === "herdr:term_b"));
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "blocked" });
    await waitFor(() => h.rings.length === 1, 3000);
    expect(h.rings[0]).toMatchObject({ sessionId: "herdr:term_b", kind: "blocked" });
    expect(h.notified[0]).toMatchObject({
      type: "notify",
      sessionId: "herdr:term_b",
      kind: "blocked",
    });
    expect((await h.sessions()).find((s) => s.id === "herdr:term_b")?.state).toBe("blocked");
  });

  it("drops every herdr session when the socket dies and re-adopts without ringing", async () => {
    const h = harness();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 30, revisionPollMs: 60_000, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);
    const path = server.path;

    await server.stop();
    await waitFor(() => h.seen.filter((e) => e.type === "session-removed").length === 3, 3000);
    expect(h.registry.connected()).toEqual([]); // spec 8.12: dropped from hello.backends
    expect(await h.sessions()).toEqual([]);

    server = new FakeHerdr(path);
    server.reply("session.snapshot", snapshot);
    await server.start();
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 5000);
    // term_a is still blocked, and it is a first sighting again -> state yes, ring no.
    expect((await h.sessions()).find((s) => s.id === "herdr:term_a")?.state).toBe("blocked");
    expect(h.rings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.

- [ ] **Step 3: Implement the registry changes**

`apps/agent/src/backends/registry.ts` — import the schema (a value, not just a type) and replace
`splitId`:

```ts
import {
  type BackendName,
  BackendNameSchema,
  type Capabilities,
  type CreateWhere,
  type Line,
  type SessionInfo,
} from "@shellbell/protocol";
```

```ts
/** Spec 8.12 ordering: iTerm2 first, then tmux, then herdr. */
const BACKEND_ORDER: BackendName[] = ["iterm2", "tmux", "herdr"];

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  // Validated against the schema rather than a hard-coded list: adding a backend name to the
  // protocol must never silently leave its ids unroutable here.
  const name = BackendNameSchema.safeParse(id.slice(0, i));
  if (!name.success) return null;
  return { name: name.data, native: id.slice(i + 1) };
}
```

Replace `connected()` and `listSessions`:

```ts
  /**
   * spec 8.12/8.13: only the backends that can actually serve a phone right now. A member whose
   * transport is down (`connected === false`) stays registered -- it reconnects itself and its
   * sessions must keep routing -- but it is not advertised in `hello.backends`.
   */
  connected(): { name: BackendName; capabilities: Capabilities }[] {
    return [...this.members.values()]
      .filter((b) => b.isConnected !== false)
      .map((b) => ({ name: b.name, capabilities: b.capabilities }));
  }

  async listSessions(): Promise<SessionInfo[]> {
    const iterm = this.members.get("iterm2");
    let hidden = new Set<string>();
    if (iterm) {
      try {
        hidden = iterm.tmuxWindowIds?.() ?? new Set<string>();
      } catch (err) {
        this.log.warn("tmuxWindowIds failed; tmux panes will not be de-duped this round", {
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    // spec 8.12/15: one backend's failure must never affect the others -- settle each member's
    // `listSessions()` independently, log the failure, and return whatever the survivors have.
    const lists = await Promise.all(
      BACKEND_ORDER.map((name) => this.safeListSessions(this.members.get(name), name)),
    );
    const out: SessionInfo[] = [];
    BACKEND_ORDER.forEach((name, i) => {
      for (const s of lists[i] as SessionInfo[]) {
        if (name === "tmux") {
          const w = this.members.get("tmux")?.tmuxWindowIdOf?.(s.id);
          if (w && hidden.has(w)) continue;
        }
        out.push(withPrefix(name, s));
      }
    });
    return out;
  }
```

Add `setWatched` next to `focus`:

```ts
  /**
   * Spec 8.13: fan the tracker's watched set out to every member, each with its own native ids.
   * Every member is called on every change, including with an empty array -- that is how a backend
   * learns that its last viewer went away and it can stop polling.
   */
  setWatched(ids: string[]): void {
    const byBackend = new Map<BackendName, string[]>();
    for (const name of this.members.keys()) byBackend.set(name, []);
    for (const id of ids) {
      const p = splitId(id);
      if (!p) continue;
      byBackend.get(p.name)?.push(p.native);
    }
    for (const [name, natives] of byBackend) {
      try {
        this.members.get(name)?.setWatched?.(natives);
      } catch (err) {
        this.log.warn("setWatched failed for backend", {
          backend: name,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
  }
```

**Note on `BackendRegistry.capabilities`:** leave the existing all-backends AND for `absoluteLines`
exactly as it is. It is only used for the registry-as-facade view; the tracker now asks per session
(next step), which is what ruling 8 requires.

- [ ] **Step 4: Implement the tracker changes**

`apps/agent/src/screen-tracker.ts` — **watched-set plumbing only.**

> **Do NOT touch `ScreenTrackerOptions`, `processScreen`, or `absoluteLines`.** Per-session
> `absoluteLines` shipped in the final Plan 03 fix wave and is already correct:
> ```ts
> // screen-tracker.ts, inside processScreen -- SHIPPED, leave exactly as it is
> const absoluteLines =
>   this.opts.backend.capabilitiesOf?.(sessionId)?.absoluteLines ??
>   this.opts.backend.capabilities.absoluteLines;
> ```
> The tracker's `backend` **is** the `BackendRegistry`, whose `capabilitiesOf(id)` resolves the
> owning member by id prefix — so registering herdr (`absoluteLines: false`) already cannot degrade
> an iTerm2 session. Adding a `capabilitiesOf` option, an `absoluteLinesFor()` helper, or rewriting
> the `else if` would duplicate shipped logic **and** orphan the `absoluteLines` const above, which
> fails `pnpm lint` (biome `noUnusedVariables`). No change to `agent.ts`'s `new ScreenTracker({…})`
> call either.

Add one field next to `stopped`:

```ts
  /** Last watched set pushed to the backend, joined; guards against re-sending an equal set. */
  private watchedKey = "";
```

rewrite `setViewed` so both branches end in one push (this is the shipped body with the early
`return` turned into an `if` block, plus the final `pushWatched()` — nothing else changes):

```ts
  setViewed(connId: string, sessionId: string | null): void {
    const prev = this.viewerSession.get(connId);
    if (prev) {
      this.sessions.get(prev)?.viewers.delete(connId);
      this.viewerSession.delete(connId);
    }
    if (sessionId) {
      const s = this.state(sessionId);
      s.viewers.set(connId, { lastSentGen: -1, forceSnapshot: true, skipped: 0 });
      s.dirty = true;
      this.viewerSession.set(connId, sessionId);
    }
    this.pushWatched();
  }
```

add the push as the last line of `sessionRemoved`:

```ts
  sessionRemoved(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const conn of s.viewers.keys()) this.viewerSession.delete(conn);
    this.sessions.delete(sessionId);
    this.pushWatched();
  }
```

and to `stop()`:

```ts
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // A stopped tracker must never leave a backend polling on our behalf.
    this.watchedKey = "stopped";
    try {
      this.opts.backend.setWatched?.([]);
    } catch (err) {
      this.log.warn("setWatched failed", { err: err instanceof Error ? err.name : String(err) });
    }
  }
```

plus **one** new private method, next to `state`:

```ts
  /**
   * Spec 8.13: tells the backend which sessions at least one phone is viewing. Backends that push
   * screen changes ignore it; the herdr backend polls exactly this set and nothing else. The full
   * set is sent every time it changes, never a delta.
   */
  private pushWatched(): void {
    const ids = [...this.sessions.entries()]
      .filter(([, s]) => s.viewers.size > 0)
      .map(([id]) => id)
      .sort();
    const key = ids.join(" ");
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    try {
      this.opts.backend.setWatched?.(ids);
    } catch (err) {
      this.log.warn("setWatched failed", { err: err instanceof Error ? err.name : String(err) });
    }
  }
```

That is the whole tracker diff: one field, one rewritten `setViewed`, one line appended to
`sessionRemoved`, the `stop()` addition, and `pushWatched()`. **`agent.ts` is not touched in this
step** — its `new ScreenTracker({ backend: o.registry, sink, log, onSessionGone })` call is already
correct, and the registry it passes is what makes `backend.capabilitiesOf` and
`backend.setWatched` resolve to the right member.

- [ ] **Step 5: Implement detection and the doctor check**

`apps/agent/src/backends/herdr/start.ts`:

```ts
import { existsSync } from "node:fs";
import { createLogger, type Logger } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
import { BackendUnavailable } from "../types.js";
import { HerdrBackend, type HerdrBackendOptions } from "./backend.js";
import { HerdrClient, UNSUPPORTED_CODES, HerdrError, INSTALL_HINT, UPGRADE_HINT } from "./client.js";
import type { SessionSnapshotResult } from "./types.js";

/** Structurally identical to `Check` in `src/doctor.ts`, so it drops straight into that list. */
export interface HerdrCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface CheckHerdrOptions {
  /** Optional so `doctor.ts`, which has no Logger, can call `checkHerdr()` with no arguments. */
  log?: Logger;
  socketPath?: string;
  client?: HerdrClient;
}

/**
 * Spec 8.13 (ruling 14): Herdr is OPTIONAL. `doctor` exits 1 if any check fails, so "not installed"
 * has to be a passing check — only a Herdr that is actually running and cannot be used is a
 * failure. When it is usable the line reads `herdr: v0.8.2 protocol 22`.
 */
export async function checkHerdr(opts: CheckHerdrOptions = {}): Promise<HerdrCheck> {
  const log = opts.log ?? createLogger({ stdout: false });
  const client =
    opts.client ?? new HerdrClient({ log, socketPath: opts.socketPath, requestTimeoutMs: 3000 });
  if (!existsSync(client.socketPath))
    return { name: "herdr", ok: true, detail: "not installed (optional)" };
  let pong: { version?: string; protocol?: number };
  try {
    pong = await client.ping();
  } catch (err) {
    if (err instanceof BackendUnavailable)
      return { name: "herdr", ok: false, detail: err.message, fix: err.hint };
    return { name: "herdr", ok: false, detail: String(err), fix: INSTALL_HINT };
  }
  // Gate 2 (ruling 12): the method that actually matters. `protocol` proves nothing about it.
  try {
    await client.request<SessionSnapshotResult>("session.snapshot", {});
  } catch (err) {
    const detail =
      err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code)
        ? `herdr ${pong.version ?? "?"} has no session.snapshot`
        : `session.snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    return { name: "herdr", ok: false, detail, fix: UPGRADE_HINT };
  }
  return {
    name: "herdr",
    ok: true,
    detail: `v${pong.version ?? "?"} protocol ${pong.protocol ?? "?"}`,
  };
}

export interface StartHerdrOptions {
  registry: BackendRegistry;
  log: Logger;
  socketPath?: string;
  client?: HerdrClient;
  /** Spec 8.12: retry every 10 s while the backend is absent. */
  retryMs?: number;
  /** Called once, with the pane count, when the backend connects — for the CLI's start banner. */
  onConnected?: (sessions: number) => void;
  backendOptions?: Omit<Partial<HerdrBackendOptions>, "client" | "log">;
}

/**
 * Spec 8.12/8.13: try Herdr at startup and every 10 s while it is not running.
 *
 * The backend is registered with the registry **before** `connect()` (ruling 11): `connect()` emits
 * `session-added` and the initial `agent-state` for every pane it discovers, and those must reach
 * the `EventEngine`, which only subscribes through the registry. A registered-but-disconnected
 * member reports `isConnected: false`, so it is not advertised in `hello.backends` until it is real.
 * Herdr not being installed is a perfectly normal state, so failures log at debug, never as errors.
 */
export function startHerdrBackend(opts: StartHerdrOptions): { stop(): void } {
  const log = opts.log.child({ unit: "herdr-start" });
  const client = opts.client ?? new HerdrClient({ log: opts.log, socketPath: opts.socketPath });
  const backend = new HerdrBackend({ client, log: opts.log, ...opts.backendOptions });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;

  opts.registry.add(backend);

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? 10_000);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || backend.isConnected) return;
    try {
      await backend.connect();
    } catch (err) {
      log.debug("herdr not available", {
        error: err instanceof Error ? err.message : String(err),
      });
      schedule();
      return;
    }
    if (stopped) return;
    log.info("herdr connected");
    if (opts.onConnected && !announced) {
      announced = true;
      const sessions = await backend.listSessions().catch(() => []);
      opts.onConnected(sessions.length);
    }
  };

  void attempt();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
    },
  };
}
```

- [ ] **Step 6: Wire into the CLI and the doctor**

`apps/agent/src/cli.ts` — **six minimal insertions. This file is shipped and hardened; every edit
below is an INSERT into existing code. Never replace `buildAgent`'s return object, `start`'s
destructure, or the signal handler wholesale** — they carry Plan 03's `releaseOutput`,
`stopFirstConnect`, double-Ctrl-C and `.catch` fixes (commits `5e22a2c` / `b8b8b70`). The shipped
lines are quoted from `apps/agent/src/cli.ts` at **`5601537`**; find each one and edit exactly as
shown.

**(1) Import** — next to the iTerm2 ones (`import { ITerm2Backend } …`):

```ts
import { startHerdrBackend } from "./backends/herdr/start.js";
```

**(2) `buildAgent` — start the detector.** Shipped anchor (`cli.ts:293`):

```ts
  void firstConnect();
```

Insert immediately **after** it. Note `print`, not `console.log`: `buildAgent` buffers every
backend startup line through `print()` and flushes it with `releaseOutput()` precisely so a fast
backend cannot interleave with spec 8.1's exact-text header block. `print` is already in scope
here (declared ~35 lines above, next to `output`).

```ts
  // spec 8.12/8.13: herdr is optional and usually absent, so this never blocks startup and never
  // prints an error -- it registers the backend, retries every 10 s, and announces itself if and
  // when it connects. Buffered through `print` like the iTerm2 line, for the same reason.
  const herdr = startHerdrBackend({
    registry,
    log,
    onConnected: (n) => print(`  herdr      connected · ${n} pane${n === 1 ? "" : "s"}`),
  });
```

**(3) `buildAgent` — one shared cleanup, so both exit paths stop the detector (ruling 22).**
Shipped anchor (`cli.ts:297–300`):

```ts
  const stopFirstConnect = () => {
    if (firstConnectTimer) clearTimeout(firstConnectTimer);
    firstConnectTimer = null;
  };
```

Insert **after** that block (it must come after insertion 2, which declares `herdr`):

```ts
  // `shutdown()`'s `cleanup` argument: cancel the iTerm2 first-connect retry AND stop the herdr
  // detector. Passed wherever `stopFirstConnect` used to be passed, so no exit path leaks either.
  const stopBackendDetectors = () => {
    stopFirstConnect();
    herdr.stop();
  };
```

**(4) `buildAgent` — `onSuperseded`.** Shipped anchor (`cli.ts:319–326`) — change **one argument**:

```ts
    onSuperseded: () => {
      console.log("  another shellbell agent took over; exiting");
      if (control.server) {
        void shutdown(agent, control.server, () => process.exit(0), stopFirstConnect).catch(() =>
          process.exit(1),
        );
      } else process.exit(0);
    },
```

becomes … `stopFirstConnect` → `stopBackendDetectors`:

```ts
        void shutdown(agent, control.server, () => process.exit(0), stopBackendDetectors).catch(
          () => process.exit(1),
        );
```

**(5) `buildAgent` — return.** Shipped anchor (`cli.ts:329`):

```ts
  return { agent, control: control.server, p, cfg, fp, releaseOutput, stopFirstConnect };
```

becomes — **`releaseOutput` and `stopFirstConnect` stay**; `stopBackendDetectors` is added and
`herdr` is exposed for tests/hosts:

```ts
  return {
    agent,
    control: control.server,
    p,
    cfg,
    fp,
    releaseOutput,
    stopFirstConnect,
    stopBackendDetectors,
    herdr,
  };
```

**(6) `start` — destructure and use the combined cleanup.** Shipped anchor (`cli.ts:338–341`):

```ts
    const { agent, control, p, cfg, fp, releaseOutput, stopFirstConnect } = await buildAgent(
      log,
      opts.relay,
    );
```

becomes (`releaseOutput` is still called at `cli.ts:364`; `stopFirstConnect` is simply superseded
by the combined cleanup here, so drop it from *this* destructure only):

```ts
    const { agent, control, p, cfg, fp, releaseOutput, stopBackendDetectors } = await buildAgent(
      log,
      opts.relay,
    );
```

**(7) `start` — the signal handler.** Shipped anchor (`cli.ts:371–383`) — **keep the comment, the
`shuttingDown` guard, the `process.exit` argument and the `.catch`**; only the fourth argument
changes:

```ts
    // Minor: a second Ctrl-C while shutdown is already in flight forces an immediate exit rather
    // than leaving the process to wait out a hung `control.stop()` -- shutdown() also carries its
    // own 5 s hard deadline, so this is belt-and-braces for an impatient human.
    let shuttingDown = false;
    const onSignal = () => {
      if (shuttingDown) {
        console.error("  forcing exit");
        process.exit(130);
        return;
      }
      shuttingDown = true;
      void shutdown(agent, control, process.exit, stopBackendDetectors).catch(() => process.exit(1));
    };
```

(the only edited token on that last line is `stopFirstConnect` → `stopBackendDetectors`).

**(8) `pair` — same one-token change.** Shipped anchors (`cli.ts:400–406` and `:418–424`): the
in-process fallback destructures
`{ agent, control, cfg: agentCfg, fp: agentFp, releaseOutput, stopFirstConnect }` and its 5-minute
timer calls `shutdown(agent, control, () => process.exit(0), stopFirstConnect)`. Swap
`stopFirstConnect` for `stopBackendDetectors` in both places (destructure and call), and change
nothing else — `printPairHeader`, `printQr` and `releaseOutput()` all stay exactly as they are.

**(9) `start` banner — one line.** Shipped anchor (`cli.ts:361`):

```ts
    console.log("  tmux       not running"); // Plan 04 adds the tmux backend.
```

Insert **after** it, still **before** the `releaseOutput()` call three lines below, so the header
block stays contiguous and any queued backend line lands underneath it:

```ts
    console.log("  herdr      detecting…"); // followed up by startHerdrBackend's onConnected line
```

**Nothing else in `cli.ts` changes.** `shutdown()`'s own signature
(`shutdown(agent, control, exit = process.exit, cleanup?)`, `cli.ts:187`) is untouched.

`apps/agent/src/doctor.ts` — add the import:

```ts
import { checkHerdr } from "./backends/herdr/start.js";
```

and push the check in `runDoctor`, right after the tmux `try/catch` block:

```ts
  // spec 8.13 (ruling 14): herdr is optional — absent is a PASS, only a broken/old running herdr
  // fails. `checkHerdr` already returns this module's `Check` shape.
  out.push(await checkHerdr());
```

- [ ] **Step 7: Documentation**

`README.md` — replace **exactly these three shipped lines** (`README.md:5–7`, the paragraph
directly under `Your terminal rings. You answer.` and directly above the `Status: pre-alpha.` line):

```md
Shellbell mirrors your Mac's terminal sessions (iTerm2 natively, everything else via
tmux) to your phone, pings you when a command finishes or a program is waiting, and lets
you reply — from anywhere, end-to-end encrypted, no accounts.
```

with:

```md
Shellbell mirrors your Mac's terminal sessions (iTerm2 natively, everything else via tmux, and
coding-agent panes via [Herdr](https://herdr.dev)) to your phone, pings you when a command
finishes, when a program goes quiet, or when an agent is blocked waiting on you, and lets you
reply — from anywhere, end-to-end encrypted, no accounts.
```

`docs/self-hosting.md` — add one paragraph after the numbered list (i.e. after step `6.` on
`docs/self-hosting.md:13`, before the `## Multiple Cloudflare accounts` heading on line 22):

```md
Shellbell also works with [Herdr](https://herdr.dev) 0.7.2 or newer: if a Herdr server is running
for your user, the agent finds its socket (`$HERDR_SOCKET_PATH`, else `$HERDR_SESSION`'s socket,
else `$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`) and mirrors its panes
automatically, ringing you when an agent is blocked. Nothing to configure, and no Herdr code is
bundled — Shellbell just speaks its local socket API.
```

- [ ] **Step 8: Run everything**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
perl -e 'alarm 600; exec @ARGV' -- pnpm test
perl -e 'alarm 300; exec @ARGV' -- pnpm typecheck
pnpm lint:fix && pnpm lint
```
Expected: green everywhere, including the shipped iTerm2, tracker, registry, CLI and relay suites.

- [ ] **Step 9: Commit**

```bash
git add apps/agent README.md docs/self-hosting.md
git commit -m "feat(agent): register, watch and doctor-check the herdr backend"
```

---

### Task 7: Spike — capture real Herdr traffic (spec 18, research §10)

**Files:**
- Create: `apps/agent/scripts/spike-herdr.ts`
- Modify: `apps/agent/package.json` (one script)
- Create (by the human, in Step 3): `docs/spike-herdr.md` and the captured fixtures

**Steps 1–2 are implementer steps (write the script, typecheck it). Step 3 is Human-run only and is
the only place Herdr is ever installed or started.**

- [ ] **Step 1: Add the script**

`apps/agent/package.json` — add to `scripts`:

```json
    "spike:herdr": "tsx scripts/spike-herdr.ts",
```

`apps/agent/scripts/spike-herdr.ts`:

```ts
/*
 * Spike: the Herdr socket API from Node. Run with `pnpm -F shellbell spike:herdr` while a real
 * herdr server is running for this user, ideally with at least one coding agent pane. It writes
 * sanitized fixtures into test/fixtures/ and prints the measurements docs/spike-herdr.md wants.
 *
 * Read-only by default. Set HERDR_SPIKE_KEYS=1 to also probe `pane.send_keys` — that TYPES INTO A
 * REAL PANE, so only do it against a scratch pane you created for the spike.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";
import { HerdrClient, herdrSocketPath, semverAtLeast } from "../src/backends/herdr/client.js";
import { HERDR_KEYS } from "../src/backends/herdr/keys.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: true, verbose: true });
const client = new HerdrClient({ log, requestTimeoutMs: 5000 });
const outDir = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(outDir, { recursive: true });

/** Replace this machine's identity before anything is written to disk. */
function sanitize<T>(value: T): T {
  const home = homedir();
  const user = userInfo().username;
  const text = JSON.stringify(value).split(home).join("/Users/dev").split(user).join("dev");
  return JSON.parse(text) as T;
}

function save(name: string, value: unknown): void {
  const file = join(outDir, name);
  writeFileSync(file, `${JSON.stringify(sanitize(value), null, 2)}\n`);
  console.log("wrote", file);
}

async function timed<T>(label: string, n: number, fn: () => Promise<T>): Promise<T> {
  const times: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? 0;
  console.log(
    `${label}: p50 ${p50.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms (n=${n})`,
  );
  return last as T;
}

/** Research §10.1: prove the server really does read exactly one line per connection. */
function twoRequestsOnOneConnection(path: string): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const socket = netConnect({ path });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "a", method: "ping", params: {} })}\n`);
      socket.write(`${JSON.stringify({ id: "b", method: "ping", params: {} })}\n`);
    });
    socket.on("data", (c) => lines.push(...c.toString().split("\n").filter(Boolean)));
    socket.on("close", () => resolve(lines));
    setTimeout(() => socket.destroy(), 2000);
  });
}

async function main(): Promise<void> {
  const path = herdrSocketPath();
  console.log("socket:", path, "HERDR_SESSION:", process.env.HERDR_SESSION ?? "(unset)");
  // Spike question 1 is blocking: the macOS default (`~/.config/herdr/…`, no
  // `~/Library/Application Support` branch) is read from the Rust source but never observed on a
  // Mac. Say so loudly rather than dying with a bare ENOENT that reads like "herdr isn't running".
  if (!existsSync(path)) {
    console.error(
      `\n!! No socket at ${path}\n` +
        "!! If a herdr server IS running, herdrSocketPath() is WRONG for this platform.\n" +
        '!! Check: ls -l ~/.config/herdr/ "$HOME/Library/Application Support/herdr/"\n' +
        "!! Record the real path as errata (spike question 1) — Task 6's detector and the doctor\n" +
        "!! check will both silently report \"not installed\" until herdrSocketPath() is fixed.\n" +
        "!! Workaround for the rest of this spike: HERDR_SOCKET_PATH=<real path> pnpm -F shellbell spike:herdr\n",
    );
  }

  const pong = await timed("ping", 5, () =>
    client.request<{ version?: string; protocol?: number }>("ping", {}),
  );
  console.log("version gate:", pong.version, "->", semverAtLeast(pong.version ?? "", [0, 7, 2]));
  save("herdr-ping.json", { id: "sb1", result: pong });

  const snapshot = await timed("session.snapshot", 5, () =>
    client.request<{ snapshot: Record<string, unknown> }>("session.snapshot", {}),
  );
  save("herdr-session-snapshot.json", { id: "sb2", result: snapshot });

  const panes = (snapshot.snapshot.panes ?? []) as {
    pane_id: string;
    terminal_id?: string;
    scroll?: Record<string, unknown>;
  }[];
  console.log("panes:", panes.map((p) => `${p.pane_id}/${p.terminal_id ?? "NO terminal_id"}`));
  console.log("scroll on pane 0:", JSON.stringify(panes[0]?.scroll ?? null));
  console.log("layouts:", JSON.stringify(snapshot.snapshot.layouts).slice(0, 400));
  const paneId = panes[0]?.pane_id;
  if (!paneId) throw new Error("no panes: open one in herdr first");

  const visible = await timed("pane.read visible ansi", 20, () =>
    client.request("pane.read", { pane_id: paneId, source: "visible", format: "ansi" }),
  );
  save("herdr-pane-read-visible.json", { id: "sb7", result: visible });
  const text = (visible as { read: { text?: string } }).read.text ?? "";
  const escapes = [...text.matchAll(/\u001b\[[0-9;?]*([A-Za-z])/g)].map((m) => m[1]);
  console.log("escape finals seen (expect only 'm'):", [...new Set(escapes)].join(" "));
  console.log("rows returned:", text.split("\n").length);

  const recent = await timed("pane.read recent ansi 200", 5, () =>
    client.request("pane.read", { pane_id: paneId, source: "recent", format: "ansi", lines: 200 }),
  );
  save("herdr-pane-read-recent.json", { id: "sb8", result: recent });

  const motion = await timed("pane.copy_motion", 20, () =>
    client.request("pane.copy_motion", {
      pane_id: paneId,
      cursor: { row: 0, col: 0 },
      motion: "line_end",
    }),
  );
  save("herdr-copy-motion.json", { id: "sb9", result: motion });

  // Poll cost at scale: the adaptive poller opens one connection per watched pane per tick.
  for (const n of [1, 5, 20]) {
    const targets = panes.slice(0, n).map((p) => p.pane_id);
    if (targets.length < n) break;
    const t0 = performance.now();
    for (const id of targets)
      await client.request("pane.copy_motion", {
        pane_id: id,
        cursor: { row: 0, col: 0 },
        motion: "line_end",
      });
    console.log(`sequential copy_motion x${n}: ${(performance.now() - t0).toFixed(1)} ms total`);
  }

  const two = await twoRequestsOnOneConnection(path);
  console.log("responses to two pipelined requests (expect 1):", two.length);

  if (process.env.HERDR_SPIKE_KEYS === "1") {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
      const candidate = HERDR_KEYS[name] ?? name.replace(/^ctrl-/, "ctrl+").replace(/-/g, "");
      try {
        await client.request("pane.send_keys", { pane_id: paneId, keys: [candidate] });
        accepted.push(`${name} -> ${candidate}`);
      } catch (err) {
        rejected.push(`${name} -> ${candidate}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`keys accepted:\n  ${accepted.join("\n  ")}`);
    console.log(`keys rejected:\n  ${rejected.join("\n  ")}`);
  }

  console.log("subscribing for 30 s — go make an agent ask you something…");
  let events = 0;
  const stream = await client.subscribe(
    [
      { type: "pane.created" },
      { type: "pane.closed" },
      { type: "pane.updated" },
      { type: "pane.focused" },
      { type: "pane.moved" },
      { type: "layout.updated" },
      ...panes.flatMap((p) => [
        { type: "pane.agent_status_changed", pane_id: p.pane_id },
        { type: "pane.scroll_changed", pane_id: p.pane_id },
      ]),
    ],
    {
      onEvent: (e) => {
        events++;
        console.log("EVENT", e.event, JSON.stringify(e.data).slice(0, 200));
        if (e.event.includes("agent_status_changed"))
          save("herdr-agent-status-event.json", { event: e.event, data: e.data });
      },
      onEnd: (reason) => console.log("stream ended:", reason),
    },
  );
  await new Promise((r) => setTimeout(r, 30_000));
  stream.close();
  console.log(`captured ${events} events`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
```

- [ ] **Step 2: Typecheck and lint the script (do not run it)**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck
pnpm lint:fix && pnpm lint
```
Expected: green. **Do not run `pnpm -F shellbell spike:herdr`** — it requires a real Herdr server.

- [ ] **Step 3: Run the spike — Human-run only**

**Implementers skip this step and report it as "not run (human-run only)".** It installs and runs
third-party software, drives the operator's real coding-agent panes, and (with
`HERDR_SPIKE_KEYS=1`) types into a live terminal.

A human does this:

```bash
curl -fsSL https://herdr.dev/install.sh | sh     # or brew, if that is how they ship it
herdr --version && herdr status
herdr                                            # start it, open two panes, run a coding agent
pnpm -F shellbell spike:herdr                    # read-only capture, ~60 s
# optional, in a throwaway pane only:
HERDR_SPIKE_KEYS=1 pnpm -F shellbell spike:herdr
```

While the 30 s subscription window is open: make the agent ask a question (→ `blocked`) and answer
it (→ `idle`/`done`), drag a pane divider (→ `layout.updated`), and scroll a pane / print a few
hundred lines (→ `pane.scroll_changed`).

Then write `docs/spike-herdr.md` in the style of `docs/spike-tmux.md`, answering with evidence:

1. **Socket path actually used on macOS**, its mode, whether `HERDR_SESSION` produces the
   documented per-session path, and whether a `-client.sock` sibling exists.
   **This is a blocking answer, not a nice-to-have:** `herdrSocketPath()` defaults to
   `~/.config/herdr/herdr.sock` on macOS with no `~/Library/Application Support` branch. Run
   `herdr` and then `ls -l ~/.config/herdr/ "$HOME/Library/Application Support/herdr/" 2>&1` and
   record which one exists. The spike script prints the path it resolved on its first line; if
   that file does not exist while a herdr server is running, **stop and record it as errata** —
   `herdrSocketPath` needs a second `existsSync` candidate before Task 6's detector can ever find
   a real Herdr on a Mac, and every doctor check will silently read "not installed (optional)".
2. `ping`: version, protocol, capabilities. **Does the semver gate accept it, and is `protocol`
   really unrelated to JSON-API compatibility (compare two builds if possible)?**
3. One request per connection: how many responses came back for two pipelined requests?
4. Latencies: `ping`, `session.snapshot`, `pane.read visible ansi` (80×24 and a large pane),
   `pane.read recent 200`, `pane.copy_motion` — p50/max — **plus the sequential 1/5/20-pane
   `copy_motion` totals. Does the adaptive poller (200 ms fast, 500 ms after 5 s, 1000 ms cap) fit?**
5. `pane.read {source:"visible",format:"ansi"}`: which CSI finals appear (must be only `m`)? Are
   rows padded to `cols` or trimmed? Does the row count equal the viewport height? 256-colour and
   truecolor encoding? CJK/emoji cell accounting?
6. Does every pane in `session.snapshot` carry a `terminal_id`?
7. `layout.updated`: exact rect field names, whether they are **cells**, whether the *event* payload
   matches the snapshot's shape, and whether dragging a divider fires it (compare `stty size`).
8. `pane.scroll_changed`: **what exactly is in `data`?** Does it carry a `scroll` object with
   `max_offset_from_bottom`/`viewport_rows`, or only `pane_id` (which forces our `pane.get`
   fallback)? How often does it fire while a pane streams output?
9. `content_revision` from `pane.copy_motion`: does it advance with output, hold still when idle,
   work without focus, and are odd values observable mid-write?
10. Agent state: measured latency from the agent visibly blocking to the event line landing, and for
    working→idle. Dotted or snake_case envelope? Does it carry `agent`/`display_agent`/`title`?
11. Keys (only under `HERDR_SPIKE_KEYS=1`): the accepted/rejected list, verbatim. Are `enter`, `tab`
    and `shift+tab` accepted? Do `delete`/`home`/`end`/`page-up`/`page-down`/`ctrl+space` work?
12. Restart: with a subscription open, run `herdr server stop`. Does the socket file disappear? Does
    the connection EOF? Do `pane_id`s change while `terminal_id`s survive?
13. Sanitization: confirm every captured fixture was reviewed for home paths, usernames, hostnames,
    repo names and terminal content, and say what was redacted.

- [ ] **Step 4: Commit — Human-run only**

```bash
git add apps/agent/scripts/spike-herdr.ts apps/agent/package.json apps/agent/test/fixtures docs/spike-herdr.md
git commit -m "chore(agent): herdr spike script and captured fixtures"
```

An implementer who reached Step 3 commits only the script and the `package.json` line:

```bash
git add apps/agent/scripts/spike-herdr.ts apps/agent/package.json
git commit -m "chore(agent): herdr spike script"
```

---

### Task 8: Adopt the captured fixtures and record the deltas (spec 15)

**Prerequisite:** Task 7 Step 3 was run by a human and `docs/spike-herdr.md` exists. **If it does
not, stop here and report "blocked on the Task 7 spike".** Do not invent measurements.

**Files:**
- Modify: `apps/agent/test/fixtures/herdr-*.json` (replaced with the captured ones)
- Modify: whichever of `herdr-convert.test.ts`, `herdr-backend.test.ts`, `keys.ts`, `convert.ts`,
  `backend.ts`, `client.ts` the captured data proves wrong
- Modify: this plan file (append to "Post-spike errata")

- [ ] **Step 1: Swap the fixtures in, keeping every filename**

The spike script already wrote them to `apps/agent/test/fixtures/` with exactly the names the tests
import, so this is usually `git status` plus a review that each file is sanitized.

- [ ] **Step 2: Re-run the tests and fix the expectations — the data, not the design**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
```

| Failing assertion | Meaning | Fix |
|---|---|---|
| `herdr-convert` line text/run expectations | The real screen differs | Update the expected strings; keep one styled run, one wide-cell row and one padded row |
| `fakeCursor` x/y | Real trailing content differs | Update the numbers; do not change the rule or drop the clamp |
| `getScreen` `rows`/`cols` | The rect is not in cells, or disagrees with `viewport_rows` | Fix `applySnapshot`; record it (spike item 7) |
| `listSessions` ids | A pane had no `terminal_id` | Keep the `pane_id` fallback and record it (spike item 6) |
| `pane_agent_status_changed` unhandled | The envelope differs | Fix the `handleEvent` case and record it |
| `pane.scroll_changed` carries no `scroll` | Expected — the `pane.get` fallback is the answer | Record the measured event rate and confirm the 1/s cap is enough |
| A key was rejected | `HERDR_KEYS` is wrong | Remove or correct that entry (unmapped keys fall back to raw bytes) and update the keys test |
| `copy_motion` is slower than the poll interval | The poller is too aggressive | Raise `POLL_FAST_MS`/the settle thresholds, record the measurement |

If the CSI finals in the captured ANSI include anything other than `m`, **stop**: `parseSgrLine` is
not sufficient and the plan needs a controller decision (the fallback is spec 8.13's deferred
`herdr terminal session observe` path, which is out of scope here).

- [ ] **Step 3: Record the errata**

Append to the "Post-spike errata" section at the end of this file: one bullet per delta — what the
plan assumed, what the spike measured, what changed. If nothing changed, say so and list the
assumptions the spike confirmed.

- [ ] **Step 4: Run everything and commit**

```bash
perl -e 'alarm 600; exec @ARGV' -- pnpm test
perl -e 'alarm 300; exec @ARGV' -- pnpm typecheck
pnpm lint:fix && pnpm lint
git add apps/agent docs/superpowers/plans/2026-09-05-shellbell-04b-herdr.md
git commit -m "test(agent): adopt captured herdr fixtures and record the deltas"
```

---

### Task 9: Live Herdr integration test (spec 15)

**Files:**
- Create: `apps/agent/test/live-herdr.test.ts`

- [ ] **Step 1: Write the env-gated test**

It creates **its own scratch tab** and always cleans it up (ruling 18): the operator's first pane may
well be a running coding agent, and typing into it would be destructive.

`apps/agent/test/live-herdr.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import type { BackendEvent } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import type { SessionSnapshotResult, TabCreatedResult } from "../src/backends/herdr/types.js";

// Same gate shape as the shipped `test/live-iterm2.test.ts` (`describe.skipIf(!process.env.…)`),
// so one `SHELLBELL_LIVE=1` opts into both live suites.
const live = Boolean(process.env.SHELLBELL_LIVE);
const log = createLogger({ stdout: true, verbose: true });

describe.skipIf(!live)("live herdr", () => {
  const client = new HerdrClient({ log });
  let backend: HerdrBackend | null = null;
  let tabId: string | null = null;
  let scratchTerminalId: string | null = null;

  beforeAll(async () => {
    // Our own tab, never the operator's agent pane, and never focused (spec 8.13).
    const snap = await client.request<SessionSnapshotResult>("session.snapshot", {});
    const workspaceId =
      snap.snapshot.focused_workspace_id ?? snap.snapshot.workspaces[0]?.workspace_id;
    if (!workspaceId) throw new Error("herdr has no workspace");
    const created = await client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    tabId = created.tab?.tab_id ?? null;
    scratchTerminalId = created.root_pane.terminal_id;
  }, 20_000);

  afterAll(async () => {
    // Always: a failed assertion must not leave a tab or a subscription behind.
    try {
      await backend?.close();
    } finally {
      if (tabId) await client.request("tab.close", { tab_id: tabId }).catch(() => undefined);
    }
  }, 20_000);

  it("lists the scratch pane, reads a styled screen, submits a line and sees the change", async () => {
    const b = new HerdrBackend({ client, log });
    backend = b;
    await b.connect();
    expect(b.isConnected).toBe(true);

    const sessions = await b.listSessions();
    const scratch = sessions.find((s) => s.id === scratchTerminalId);
    expect(scratch, "the scratch pane must be in listSessions").toBeTruthy();
    const id = (scratch as (typeof sessions)[number]).id;

    const before = await b.getScreen(id);
    expect(before.rows).toBe((scratch as (typeof sessions)[number]).rows);
    expect(before.lines).toHaveLength(before.rows);
    expect(before.cursor.x).toBeLessThan(before.cols);

    const events: BackendEvent[] = [];
    b.on((e) => events.push(e));
    // The revision poller only runs for watched panes (spec 8.13), so ask for this one.
    b.setWatched([id]);
    await b.sendText(id, "echo shellbell-herdr-live-ok\r");
    await new Promise((r) => setTimeout(r, 2500));

    expect(events.some((e) => e.type === "screen-changed" && e.sessionId === id)).toBe(true);
    const after = await b.getScreen(id);
    const text = after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text).toContain("shellbell-herdr-live-ok");

    const history = await b.getHistory(id, after.scrollbackTotal, 20);
    expect(Array.isArray(history.lines)).toBe(true);
  }, 40_000);
});
```

- [ ] **Step 2: Run it once for real — Human-run only**

**Implementers skip this step and report it as "not run (human-run only)".** The test needs a real
Herdr server (which this plan never installs) and it creates and closes a Herdr tab.

```bash
SHELLBELL_LIVE=1 perl -e 'alarm 300; exec @ARGV' -- \
  pnpm -F shellbell exec vitest run test/live-herdr.test.ts
```
(`exec`, not a bare `pnpm -F shellbell vitest …`: `vitest` is not a script in
`apps/agent/package.json` — its scripts are `test`, `typecheck`, `build`, `dev`, `proto:gen`,
`spike:iterm2`, `spike:tmux`, `spike:herdr`. Plan 03's equivalent step is
`SHELLBELL_LIVE=1 pnpm vitest run test/live-iterm2.test.ts` run from inside `apps/agent`, which
also works.)
Expected: PASS, a scratch tab appears and disappears, and `shellbell-herdr-live-ok` is echoed in it.
Without `SHELLBELL_LIVE` the suite is skipped, so `pnpm test` in CI is unaffected.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/test/live-herdr.test.ts
git commit -m "test(agent): env-gated live herdr integration"
```

---

## Plan self-review

**Spec coverage (§8.13 paragraph by paragraph):**

| Spec 8.13 requirement | Where |
|---|---|
| `BackendName` += `"herdr"`; `EventKind`/`notify.kind` += `"blocked"`; `SessionInfo.state` += `"blocked"`; push body | Task 1 |
| Socket discovery incl. `HERDR_SESSION` | Task 2 (`herdrSocketPath` + test) |
| NDJSON, one request per connection, 5 s timeout, byte-accurate line cap | Task 2 (`HerdrClient.request`, `pipeLines`; the fake enforces one-per-connection and `ignoredLines` proves it) |
| `events.subscribe` ack, bare event lines, pre-ack EOF, post-ack overflow | Task 2 (`subscribe` + four tests) |
| Version gate: semver ≥ 0.7.2 **and** `session.snapshot` probe; `protocol` is not the floor | Task 2 (`ping`), Task 4 (`connect`), Task 6 (`checkHerdr`) |
| Bootstrap: subscribe → snapshot → apply → replay buffer | Task 4 (`openStream`) |
| Lifecycle events are hints → one debounced single-flight snapshot; agent status/scroll applied directly | Task 4 (`handleEvent`, `scheduleSync`, `runSync`) + two tests |
| Two-phase resubscribe, snapshot-failure cleanup | Task 4 (`openStream` + "re-subscribes exactly once") |
| Disconnect → `session-removed` for every pane, `isConnected: false`, reconnect re-adds | Task 4 (`onStreamEnd` + the restart test), Task 6 (registry filter, `hello`), Task 5 (no adoption ring) |
| Native id = `terminal_id`; `terminal_id ↔ pane_id` map; title rule | Task 4 (`applySnapshot`, `titleOf`, `pane_moved` test) |
| rows/cols from the layout rect, refreshed on `layout.updated` (both axes) | Task 4 (`rectIndex`, `layout_updated` test) |
| `getScreen` = visible ANSI read → `parseSgrLine`; pad/truncate bottom-anchored; faked cursor clamped | Task 3 |
| `scrollbackTotal = max_offset_from_bottom`, kept fresh by `pane.scroll_changed` (+ `pane.get` fallback) | Task 3, Task 4 (two scroll tests) |
| `history` = `recent` ≤ 1000 lines, paged against that number, `agent_not_idle`/short read → visible fallback + `oldestAvailable` | Task 4 (`getHistory` + three tests) |
| Adaptive revision poller for watched panes only; odd revisions skipped; sequential; cancellation | Task 4 (`setWatched`, `runProbes` + three tests), Task 6 (tracker → registry → backend) |
| `agent-state` event (discriminated on `type`) → `blocked`/`prompt` rings, adoption rule | Task 4, Task 5 |
| `SessionInfo.state` mapping incl. `idle`/`done` → `finished` | Task 4 (`SESSION_STATE`), Task 5 (`stateOf`), Task 6 (agent merge) |
| Input: `send_text`, `\r`/`\n`/`\t` → `send_keys`, unmapped keys as raw bytes, never log text | Task 4 (`keys.ts`, `sendText` + test) |
| Create: `tab.create {focus:false}`, `pane.split right/down`, `BadWindow` | Task 4 (three tests) |
| `pane.focus` only from a user action; stale pane target → snapshot refresh | Task 4 (`focus`, `call`) |
| Absent Herdr → `BackendUnavailable` + hint; `doctor` passes when absent, fails when broken | Task 2, Task 6 (`checkHerdr`, four tests) |
| Per-session `absoluteLines` | **Already shipped** (`screen-tracker.ts` `processScreen` + `BackendRegistry.capabilitiesOf`, with its own describe block in `test/screen-tracker.test.ts`). No task re-implements it. |
| `hello` on backend-set change | Task 5 (`broadcastHelloIfBackendsChanged`) + Task 6 (`connected()` filter, two tests) |
| Licensing / "works with Herdr" | Global Constraints, Task 6 docs |

**Type consistency:**

- `AgentState` is declared **once**, in `apps/agent/src/backends/types.ts` (Task 2, listed in that
  task's Files), and re-exported by `herdr/types.ts` as `AgentStatus`.
  `BackendEvent["agent-state"].state`, `EventEngine`'s `agentState`, `Pane.agentStatus`,
  `SESSION_STATE` and `agentStateOf` all use that one type.
- `Screen` is the shipped one from `backends/types.ts`; `convert.ts` imports it and never redefines it.
- `Ring.kind` ⊇ ctrl `notify.kind` ⊇ `pushBody`'s parameter — a `blocked` ring typechecks end to end.
- `HerdrClient.request<T>` is the only call path; `HerdrBackend.call<T>` wraps it solely to turn
  `GONE_CODES` into `SessionGone` + a snapshot refresh. `HerdrStream`/`HerdrStreamHandlers` live in
  `client.ts` and are used by `backend.ts`.
- `setWatched` has the same signature in `TerminalBackend`, `BackendRegistry`, `HerdrBackend` and
  `FakeBackend`: `(nativeIds: string[]) => void`, always the full set.
- `connected` is an optional **readonly property** on `TerminalBackend`, a getter on `HerdrBackend`,
  and a plain field on `FakeBackend` — all satisfy the interface.
- `HerdrCheck` is structurally `doctor.ts`'s `Check` (`fix`, not `hint`), so `out.push(await checkHerdr())` typechecks.
- Fixture names are identical in Tasks 3, 4, 6, 7 (writer) and 8 (swap).
- `waitFor` is the shipped `test/fakes/wait.ts` helper — a **synchronous** predicate; no test in this
  plan passes it an `async` function.

**Placeholder scan:** none. Every file in "File structure" has complete code in a task; no step says
"similar to" or "…". The values this plan cannot know are the ones Task 7 measures; they live in
fixtures (replaceable data) and in the listed spike questions, never in a production code path
without a documented fallback (`terminal_id` → `pane_id`; unmapped key → raw bytes; missing rect →
`viewport_rows` → 80×24; `pane.scroll_changed` without a payload → rate-limited `pane.get`;
unparseable version → feature probe).

**Test coverage against spec §15 and both reviews' "missing tests" lists:** transport (one connection
per request, timeout, id mismatch, missing result, fragmented UTF-8, coalesced lines, pre-ack EOF,
post-ack overflow, version refusal, subscription refusal, ack+event in one chunk); conversion
(fixture, bottom-anchored fit, clamped cursor); backend (bootstrap order and subscription contents,
multi-workspace ordering, initial states, feature probe, malformed snapshot, screen, stale target →
refresh, three history paths incl. the emitted `scrollbackTotal` and the `agent_not_idle` fallback,
enter/tab/ctrl keys, split axes, tab creation and `BadWindow`, focus, lifecycle coalescing, add +
single resubscribe, removal reconciliation, `pane_moved` with stable terminal ids, agent status +
title, both-axis resize, scroll from event and via `pane.get`, poller adaptivity/odd revisions/
cancellation/failure, real restart with socket removal and a pane deleted during downtime); engine
(five ring rules incl. restart adoption); notifier (`blocked` + 60 s limit); registry (herdr routing,
`setWatched` fan-out, `connected()` filter); tracker (watched set — per-session `absoluteLines` is
covered by its own shipped describe block, not re-tested here);
start/doctor (register-before-connect, retry, absent = pass, old = fail, no-snapshot = fail);
agent-level integration (initial blocked visible but not rung, ring → `notify`, disconnect drops
sessions and `hello`, reconnect re-adopts silently); relay (`blocked` push body end to end); and one
env-gated live test.

---

## Known unknowns for the spike

Each one has a documented fallback in the code, so the plan is executable before the spike; Task 8
replaces the guess with the measurement.

1. **`pane.scroll_changed` payload — assume it carries NOTHING.** The research catalogue records
   this event as **`pane.scroll_changed { pane_id }`**, with no `scroll` object, so the plan treats
   the rate-limited `pane.get` refresh (at most 1/s per pane, triggered lazily by the next
   `getScreen`) as the **primary** mechanism for keeping `scrollbackTotal` fresh. Reading
   `data.scroll.{max_offset_from_bottom, viewport_rows}` straight off the payload is an
   opportunistic shortcut that costs nothing when absent. Unverified and to be measured in
   **spike item 8**: (a) whether any build sends scroll numbers on the event; (b) how often it
   fires while a pane streams output, i.e. whether the 1/s `pane.get` cap is enough.
   *Task 8 action:* if the captured event carries no `scroll`, delete the "unverified payload
   path" test in `herdr-backend.test.ts` and keep the `pane.get` one; if it does carry numbers,
   promote the shortcut and say so in the errata. Either way the production behaviour is already
   correct — only the dead branch and one test change.
2. **`layout.updated` rect fields and units.** Assumed `panes[].rect.{x,y,width,height}` in **cells**
   on both the snapshot and the event. *Fallback:* `rows` prefers the rect but falls back to
   `scroll.viewport_rows`, and a missing rect yields 80×24. If the units are pixels, `cols` needs
   another source — errata + controller (spike item 7).
3. **`pane.copy_motion` cost.** Assumed cheap enough for one connection per watched pane per tick at
   200 ms while changing. Unverified: real latency, whether it can be refused without focus, whether
   `content_revision` advances with output and holds still when idle, and how often odd values
   appear. *Fallback:* the poller is sequential, single-flight, watched-only and adaptive, and every
   threshold is a constant at the top of `backend.ts` (spike items 4 and 9).
4. **`pane.read` ANSI line splitting on wrapped lines.** One `\n`-separated row is treated as one
   `Line` and `Line.w` is never set (Herdr exposes no soft-wrap flag). *Fallback:* `fitLines` always
   produces exactly `rows` rows, bottom-anchored, so the screen is the right shape either way.
5. **Is `terminal_id` present on every pane?** The research lists it as required; the plan falls back
   to `pane_id`, which costs id stability across a restart but never hides a pane (spike item 6).
6. **Named keys.** `delete`, `home`, `end`, `page-up`, `page-down` and `ctrl-space` are absent from
   `HERDR_KEYS` and go out as raw bytes. Unverified: whether Herdr accepts them, and the exact
   spelling of `ctrl+space`/`shift+tab` (spike item 11, `HERDR_SPIKE_KEYS=1` only).
7. **CSI finals in ANSI reads.** Assumed SGR (`m`) only, which is what makes `parseSgrLine`
   sufficient. Anything else stops Task 8 for a controller decision (spike item 5).
8. **Agent-state latency and envelope.** Assumed ~0.2–0.9 s and a dotted `pane.agent_status_changed`
   name; the handler normalises dots to underscores, so either envelope works (spike item 10).
9. **Version/compatibility.** The semver floor (0.7.2) plus the `session.snapshot` probe is the gate;
   `protocol` is deliberately unused. Unverified: whether any shipped build has a version string the
   semver parser cannot read (spike item 2).
10. **Named Herdr sessions.** Discovery honours `HERDR_SESSION`, but the agent still connects to
    exactly one socket. Enumerating several is out of scope.
11. **The macOS socket directory (blocking — spike question 1).** `herdrSocketPath()` resolves
    `<config>` as `$XDG_CONFIG_HOME` else `~/.config` on **both** platforms, with no
    `~/Library/Application Support` branch. That comes from the Rust source quoted in research §1
    and is stated as fact in spec 8.13, but the research's own checklist still lists it as
    unconfirmed on a Mac — and this plan's whole automated suite talks to a fake server on a temp
    socket, so nothing here can catch it. *Fallback:* `$HERDR_SOCKET_PATH` always wins, and every
    caller degrades to "not installed (optional)" rather than failing, so a wrong default is
    invisible-but-harmless until the spike. *If the spike shows a different directory,* give
    `herdrSocketPath` a second candidate (probe both with `existsSync`, prefer the one that
    exists) and update spec 8.13's "same layout on macOS and Linux" sentence. The spike script
    prints an explicit multi-line warning when the resolved path does not exist.
12. **Deferred by the spec, not unknown:** true cursor and TUI-exact fidelity via
    `herdr terminal session observe` + a headless VT emulator (spec 8.13 "Deferred"). The faked
    cursor and the polled screen are v1.

---

## Post-spike errata

Task 8 (revised) implemented the spike's findings. Deltas, one bullet per change:

- **Assumed:** `pane.copy_motion` exists and returns a `content_revision` counter, so the backend
  polls it per watched pane with an adaptive interval (`POLL_FAST/MEDIUM/SLOW_MS`,
  `SETTLE_MEDIUM/SLOW_MS`). **Measured:** it does not exist in Herdr 0.8.2 — `invalid_request:
  unknown variant` — while `pane.updated` events carry a monotonic `pane.revision` with no polling
  needed at all (`docs/spike-herdr.md` Q9). **Changed:** the entire revision poller is deleted
  (`runProbes`, `probes`, `pollTimer`, `polling`, `intervalFor`, the `POLL_*`/`SETTLE_*` constants,
  `revisionPollMs`, `CopyMotionResult`, and `HerdrBackend.setWatched` — `TerminalBackend.setWatched?`
  stays optional and unimplemented by this backend). Change detection is now purely event-driven:
  `handleEvent`'s `pane_updated` case updates scroll/agent_status/`revision` in place for a known
  pane and emits `screen-changed` on a numeric revision change, for every pane, watched or not.
- **Assumed:** a `pane_updated` (`pane.updated`) event for an already-known pane is just another
  lifecycle hint that schedules a debounced `session.snapshot`. **Measured:** its payload is a full
  `PaneInfo` (`docs/spike-herdr.md`'s sanitized payload). **Changed:** only an *unknown* `pane_id`
  in a `pane_updated` event still schedules a snapshot (a new pane); a known pane is updated
  directly. `applySnapshot` also now stores each pane's `revision` and emits `screen-changed` for a
  retained pane whose revision moved between two snapshots (Step 2) — covering events missed while
  a debounced refresh was in flight. A pane map wiped by a real disconnect (`onStreamEnd`) still
  treats every reappearing pane as a first sighting (silent, per spec), relying on `session-added`
  instead — confirmed by a dedicated regression test.
- **Assumed (plan-only synthetic fixtures):** the herdr fixtures would model several panes across
  two windows/workspaces, mirroring the pre-spike test design. **Measured:** the human spike ran
  against one workspace with one plain shell pane (`docs/spike-herdr.md`'s method note); the
  captured `session.snapshot`/`pane.get`/`pane.read` fixtures reflect exactly that one pane.
  **Changed:** the captured pane is adopted verbatim as `term_a` in `herdr-session-snapshot.json`
  (only its `terminal_id` was renamed from the real `term_65ac0d4d5c3b51` to `term_a` for fixture
  readability — an opaque per-run token, not a measurement); the two pre-existing SYNTHETIC sibling
  panes `term_b` (idle zsh) and `term_c` (a blocked Claude Code agent in a second window) are kept
  so `herdr-backend.test.ts`/`herdr-agent.test.ts` can still exercise multi-pane bookkeeping
  (sorting, subscriptions, reconciliation, restart renumbering) that the one-pane spike never
  touched. Every assertion about `term_a` itself (title, cwd, cols/rows, screen/history content,
  initial state `"unknown"`) now reflects the real capture; `term_b`/`term_c` are unchanged from
  before the spike and are unrelated to anything it measured.
- **Assumed:** `herdr-convert.test.ts` would need only string/number tweaks against the captured
  ANSI. **Measured:** the real `pane.read visible` text is genuine `pnpm -F shellbell spike:herdr`
  terminal output (37 rows, CSI finals all `m` — confirmed programmatically, so `parseSgrLine`
  remains sufficient and no fallback path is needed), not a synthetic prompt/CJK sample, and it
  contains no wide-cell (CJK) row. **Changed:** `herdr-convert.test.ts`'s fixture-derived
  assertions (rows, one styled run, a blank interior row, the cursor position, `herdrScreen`
  padding to the real 187×51 rect) were rewritten against the real text; wide-cell `lineCells`/
  `fakeCursor` coverage is kept via a small synthetic literal `Line`, independent of the fixture,
  since the spike's one real pane never printed wide text.
- **Confirmed, no code change needed** (recorded here per Step 6/the original Task 8 table, since
  the spike validated rather than contradicted the design):
  - `ping.protocol` measured 20 vs. the pre-spike synthetic fixture's 22 (Q2) — already noted in
    `docs/spike-herdr.md`; `protocol` was already documented as Herdr's non-authoritative binary
    generation (spec 8.13), so nothing depended on the old number.
  - `pane.read` rows are trimmed, not padded, and `pane.get`/`session.snapshot` report the same
    `revision` (Q5, Q9) — `fitLines`'s bottom-padding and the shared `revision` field were already
    designed for exactly this.
  - Every pane carries `terminal_id` (Q6) — `applySnapshot`'s `info.terminal_id ?? info.pane_id`
    fallback remains defensive-only, unexercised by the real capture.
  - Layout rect fields are `x, y, width, height` in cells, `187×51` for the captured full-width
    pane (Q7) — matches `rectIndex`'s existing field reads.
  - No `pane.scroll_changed` event fired during the 30 s capture window (a non-scrolling pane, Q8)
    — the `⚠ UNVERIFIED PAYLOAD PATH` test in `herdr-backend.test.ts` stays marked unverified; the
    `pane.get` fallback remains the primary, unchanged path.
  - `HERDR_SPIKE_KEYS` was unset this run (Q11) — `HERDR_KEYS` was not probed and is unchanged.
  - `pane.send_text` with a trailing `\n` executed the line (Q11) — confirms the existing
    `input.line` → text-then-`enter` design; no change.

**Grep note:** `grep -rn copy_motion apps/agent/src apps/agent/test apps/agent/scripts` is not
literally empty — `herdr-pane-read-visible.json` and `herdr-pane-read-recent.json` contain the
string inside real captured terminal scrollback (the spike's own pane, having just reported its
`pane.copy_motion` probe failures on a prior run, echoes that text back verbatim in its next
`pane.read`). Editing that out of a captured fixture would misrepresent what was measured, so it is
left as-is; every hit in `.ts` source is a comment explaining the method's absence or the test that
asserts it, matching this task's gate as run.

Task 11 (2026-09-06) hardened the backend against the subscription replay. Deltas:

- **Assumed:** a `pane_updated` for an already-known pane applies its payload whenever the
  `revision` differs from the stored one (Task 8). **Measured:** a third spike run showed
  `events.subscribe` replaying a bounded backlog of ~25 recent events — including old
  `pane_updated` revisions 1…8 — at a 100 ms cadence right after the ack, before any live event
  (`docs/spike-herdr.md` "Third run"). Applying a replayed *older* revision emitted spurious
  `screen-changed`s and could rewind the stored revision. **Changed:** `handleEvent`'s
  `pane_updated` case now requires `info.revision` to be *strictly greater* than the stored
  `pane.revision`; an equal or older numeric revision returns immediately with no scroll, status,
  title/cwd sync, or `screen-changed` — the stored revision never moves backwards. `applySnapshot`
  is unaffected (a snapshot is authoritative and may move the revision either way).
- **Assumed:** `pane.agent_status_changed` is applied directly, latest-wins (Task 8). **Measured:**
  the same replay burst re-delivered a stale `pane.agent_status_changed` (Third run); this event
  carries no revision or sequence number at all, so a replayed stale status could flip an
  already-transitioned pane back and ring spuriously. **Changed:** the handler no longer mutates
  anything directly — it calls `scheduleSync("snapshot")` like every other hint, and no longer
  stamps `statusSeq` (that freshness stamp, review fix 4, now belongs solely to the
  revision-ordered `pane_updated` path). `applySnapshot` already emitted `agent-state` on a
  transition and `title-changed` on a title change, so nothing else moved; `blocked` rings now
  trail the transition by the debounce plus one snapshot round trip (~350 ms) instead of applying
  instantly, matching the live `pane_updated` for the same transition (measured ~0.6 s later) that
  usually applies first anyway. Spec 8.13's own "applied directly, latest-wins" sentence (just above
  the "hint, not a mutation" bullet it contradicted) is marked superseded in place rather than
  deleted, to keep the revision history honest about the walked-back design.
- Tests updated for both: `herdr-backend.test.ts` gained two bootstrap-replay tests (a stale
  `pane_updated` burst and a stale `pane.agent_status_changed` hint, both via a new
  `FakeHerdr.replay()` helper that queues events onto the existing `ackRider`), an
  equal/older-revision-ignored test, and the retained Task 8 "applies directly" test now uses
  strictly increasing revisions (2 collided with the fixture's own stored revision for term_a/
  term_b, which the new rule rejects). `herdr-agent.test.ts`'s end-to-end ring test now serves a
  dynamic `session.snapshot` tracking the "world" status a `pane.agent_status_changed` hint claims,
  since the event itself no longer carries the transition.

---

## Pre-execution corrections (2026-09-05)

Two external reviews (**G** = Gemini, `.superpowers/research/review-04b-gemini.md`; **C** = Codex,
`.superpowers/research/review-04b-codex.md`) were applied in full, under controller rulings 1–22.
The plan text above and spec §8.13 have been corrected **in place**; this list is what changed and
why. Where a review's suggestion conflicted with a ruling, the ruling won (noted inline).

**Design corrections (spec §8.13 rewritten; the plan follows it):**

- **`BackendEvent` discriminates on `type`, not `kind`** — §8.13 said `{ kind: "agent-state" }` while
  the shipped `types.ts` and every backend use `type`. Spec fixed; the event is
  `{ type: "agent-state", sessionId, state, agent?, at }`. *(G1.8, C1.2; ruling 1)*
- **Event replay by revision was impossible** — no Herdr event carries a revision or sequence
  number, so "replay buffered events with revision ≥ snapshot's" could not be implemented and the
  old plan simply replayed everything over newer snapshot state. Replaced with **snapshot-only
  membership**: subscribe → snapshot → apply → *then* process the buffer, and every lifecycle event
  is only a hint that schedules one debounced, single-flight `session.snapshot`. *(G1.1, G3.3, C1.5;
  ruling 2)*
- **The self-triggering resubscribe loop is gone** — `pane_created`/`closed`/`exited` used to call
  `scheduleResubscribe()` directly, and a replayed buffer could re-arm it forever. Only
  `applySnapshot` may ask for a stream rebuild, and only when the pane-id set actually differs from
  the subscribed set, which is false immediately afterwards. *(G3.4; ruling 2)*
- **Agent-state subscriptions survived a reconnect as an empty set** — `onStreamEnd` cleared
  `byPaneId`, so the reconnect subscribed to zero panes and `blocked` notifications died silently.
  `connect()` now takes a **discovery snapshot before subscribing**, so the first subscription
  already covers every pane; `applySnapshot` rebuilds the stream if the set ever drifts. This also
  fixes the first backend test, which asserted three pane subscriptions that the old order could
  never produce. *(G3.2, C4.1; ruling 2)*
- **Two-phase resubscribe** — `streamGen` used to be bumped *before* the new stream was acked, which
  discarded old-stream events during the handover (the exact gap it claimed to close), and a failed
  snapshot left an acked stream referenced by nobody. The new stream is opened, acked and already
  buffering before it replaces the old one; a snapshot failure closes it and hands over to the
  reconnect poll. *(C3.3; ruling 10)*
- **Disconnect is now loud** — losing the socket emits `session-removed` for every Herdr pane, clears
  the maps, and reports `isConnected: false`; reconnect re-adds them with `session-added` plus an
  initial `agent-state`. This fixes three findings at once: the tracker no longer keeps viewers for
  panes that vanished during downtime, a pane deleted while Herdr was down cannot linger, and the
  `EventEngine` forgets the session so a still-blocked agent is a **first sighting** (no adoption
  ring) instead of a `working → blocked` transition that rang the phone. *(G1.2, G3.6, C3.2, C3.7;
  ruling 3)*
- **A disconnected backend is no longer advertised** — `TerminalBackend.isConnected?` was added,
  `BackendRegistry.connected()` filters on it, and the `Agent` re-sends `hello` whenever the
  connected set changes (spec 8.12 required this and nothing implemented it). *(G1.3, C3.8; ruling 3)*
- **Cursor `x` is clamped to `cols - 1`** — a full-width row put the cursor outside the grid.
  *(G1.4; ruling 4)*
- **`layout.updated` now updates rows too**, and `rows` come from the layout rect with
  `scroll.viewport_rows` as the fallback: a vertical resize used to be invisible. *(G1.7, C3.4;
  ruling 4)*
- **`scrollbackTotal = max_offset_from_bottom`** (rows above the viewport), not `+ rows`: the phone
  seeds `historyFrom` from it, and the plan's own history test proved the mismatch (screen said 144,
  history was called with 120). History pages against the emitted number, `pane.scroll_changed` is
  subscribed per pane to keep it fresh (with a rate-limited `pane.get` fallback when the event
  carries no numbers), and a refused deep read (`agent_not_idle`) or a short read falls back to a
  visible read with `oldestAvailable` set. *(G1.5, C1.3, C2.5, C2.6; ruling 5)*
- **Idle heuristics for Herdr shells are documented as view-scoped** — with no polling for unviewed
  panes, a plain shell can only ring while a phone is watching it; agent panes are covered by
  `agent-state`, which needs no polling. §8.13 says so explicitly instead of implying both.
  *(C1.4; ruling 6)*
- **`idle` and `done` both map to `finished`**, and §8.13 now says the seen/unseen distinction is
  deliberately dropped (it depends on Herdr-UI focus, which the phone cannot observe). *(C1.6;
  ruling 6)*
- **Enter actually submits** — `\r` and `\n` map to `pane.send_keys ["enter"]` and `\t` to
  `["tab"]`; `input.line` is `send_text(body)` + `send_keys ["enter"]`, because `pane.send_text`
  writes literal bytes and never submits. The old exclusion of `\r` from the key map meant a typed
  line was never executed. *(G1.6; ruling 7)*
- **`absoluteLines` is per session** — registering Herdr (`absoluteLines: false`) used to degrade
  iTerm2's scroll detection through the registry's all-backends AND. The tracker now asks
  `registry.capabilitiesOf(sessionId)`. *(G1.9; ruling 8)*
- **Version gate is semver, not `protocol`** — `protocol: 22` is Herdr's *binary* client/server
  generation; the JSON floor is `version >= 0.7.2` plus a `session.snapshot` feature probe. An
  unparseable version is accepted and left to the probe. §8.13 also now says the facts were verified
  against `master` **after** v0.8.2. *(C2.1; ruling 12)*
- **Socket discovery honours `HERDR_SESSION`** (named-session sockets). *(C2.2; ruling 13)*
- **`tab.create` keeps `focus:false`** and **Shellbell `vertical` stays Herdr `right`**, against the
  research's own (self-contradictory) suggestion: the axis names the divider, matching iTerm2's
  `SplitPane.VERTICAL`, and creating a tab must not steal the Mac's focus. §8.13 now states the
  rationale so this is not re-litigated. *(C2.4; ruling 19)*

**Correctness and robustness corrections in the plan's code:**

- **Wire types match the research exactly** — required fields are required (`PaneInfo.terminal_id`,
  `focused`, `agent_status`, `revision`; snapshot arrays; `AgentInfo`/`agents`; layout `rect`;
  `pane_read` ids; `copy_motion.cursor`), and `AgentInfo` exists. *(G2.1, C2.3; ruling 16)*
- **Task 2's Files list now includes the `backends/types.ts` edit** (`AgentState`, the `agent-state`
  event, `setWatched?`, `isConnected?`) — it was a late note that a weaker model could skip, leaving
  `AgentState` undefined. *(G4.2, C4.2; ruling 16)*
- **Client framing** — the 1 MiB cap is counted in **bytes** and only against an *incomplete* line
  (a chunk holding many valid lines is no longer rejected); a post-ack oversized line ends the
  stream with `overflow` instead of calling a no-op; a pre-ack EOF rejects immediately instead of
  waiting out the 5 s ack timeout; an echoed id that does not match is logged, not fatal. New tests:
  fragmented UTF-8, coalesced lines, ack+event in one chunk, id mismatch, missing result, overflow,
  pre-ack close. *(G4.1, C4.3; rulings 17, 22)*
- **`fitLines` keeps the bottom rows** — truncating from the bottom threw away the prompt.
  *(G4.3; ruling 22)*
- **Poller** — adaptive interval (200 ms while changing → 500 ms after 5 s → 1000 ms cap), probes run
  **sequentially** (one connection at a time; Herdr spawns a thread per connection), odd
  `content_revision` is skipped **without** emitting and without updating the baseline (the old code
  emitted on every tick during a write), the first probe only takes a baseline, and every probe
  re-checks `closed`, watched membership, the pane generation and the pane id **after** its await.
  Tests cover adaptivity, odd revisions, missing revisions, failures, and cancellation after unwatch
  and after close. *(G3.1, G3.5, C3.5, C3.6; ruling 9)*
- **`stale_pane_target` triggers a snapshot refresh** (which is what emits `session-removed`) instead
  of a silent local drop that left the Agent with a stale session and stopped polling forever.
  *(C4.5; ruling 15)*
- **Startup order** — `startHerdrBackend` now calls `registry.add(backend)` **before**
  `backend.connect()`, so the `session-added`/`agent-state` events the first snapshot emits actually
  reach the `EventEngine`; and `Agent.refreshSessions` no longer overwrites a backend-provided state
  with the engine's `"unknown"` (the engine wins only when it knows something). A new
  `test/herdr-agent.test.ts` drives the real path — `startHerdrBackend → registry.add → connect →
  engine → notifier` — and asserts an initial `blocked` is visible but silent, that the next
  transition rings and reaches `notify`, and that a restart drops and re-adopts without ringing.
  *(C3.1; ruling 11)*
- **`doctor` treats an absent Herdr as a pass** ("not installed (optional)"), because `doctor` exits
  1 if any check fails and most users have no Herdr; only a *running* Herdr that is too old, broken
  or missing `session.snapshot` fails. *(C4.4; ruling 14)*
- **`startHerdrBackend`'s handle is wired into the CLI's shutdown**, and its timers are `unref`'d.
  *(G4.4; ruling 22)*
- **Agent naming precedence fixed** — `display_agent` before `agent` in `pane_agent_status_changed`,
  matching `titleOf`; the status event's `title` now emits `title-changed`. *(G2.2, G2.3)*
- **`workspace.updated` added to the subscription list.** *(G2.4)*
- **The fake Herdr server is no longer a rubber stamp** — it records each stream's subscriptions and
  delivers an event only to streams that asked for it (per-pane filtering included), can bind a
  chosen socket path (so a test can stop the server, delete the socket and restart it), and can fail
  a method for *some* parameters via `{ __error }`. This is what makes the restart, subscription and
  fallback tests real. *(C5, G5)*
- **Spec propagation (minimal, per ruling 21)** — §1.1 "three backends"; §4.1 the agent runs Herdr
  too; §7.3 `notify.kind`; §7.4 `SessionInfo.backend`/`state` and `event.kind`; §8.4 `AgentState`,
  `CreateWhere.backend`, the `agent-state` event, `setWatched?`/`isConnected?`; §8.12 `connected`
  filtering and per-session capabilities; §9.2 and §11.3 the `blocked` push body; §10.5 the Herdr
  badge, the dimmed cursor, and **one new rule: the app treats an unrecognised `backend`/`state`/
  `event.kind` as opaque** so an older app never rejects a newer agent. Task 1 records that shipping
  a Herdr-enabled agent to a pre-Plan-05 phone is not allowed. *(C1.1; ruling 21)*
- **Live test** — it creates its own scratch tab (`tab.create {focus:false}`), never types into
  `sessions[0]` (which is usually the operator's agent), and always closes the tab and the
  subscription in `afterAll`. *(C4.6; ruling 18)*
- **Ordering note kept:** `splitId` only routes `herdr:` ids after Task 6, and nothing registers the
  backend before then, so Tasks 4–5 are safe to land on their own. *(G4.5)*
- **One §8.12 line beyond ruling 21's list:** the "Ordering in `sessions`" bullet enumerated only
  iTerm2 and tmux, which the plan's `BACKEND_ORDER` contradicts; herdr (workspace number, tab
  number, pane rect order) and the "no de-dup needed" note were appended. Flagged here because it is
  outside the §4/§7/§10 propagation list the controller authorised.

**Deliberately not done:**

- The mobile app is untouched: making unknown enum values opaque is spec'd (§10.5) and belongs to
  Plan 05. This plan only records the constraint.
- `BackendRegistry.capabilities` keeps its all-backends AND for the facade view; only the tracker
  asks per session. Changing the facade would alter `hello` semantics for existing backends.
- The `herdr terminal session observe` path (a real cursor, exact TUI fidelity) stays deferred to
  Plan 06 per spec §8.13.

---

## Pre-flight scan corrections (2026-09-05, second pass)

A read-only pre-flight scan against the **shipped tree at `5601537`** found that the corrections
above were applied without re-reading the agent code, so several of them had drifted from what Plan
03 actually shipped in its final fix wave. Full report:
`.superpowers/sdd/2026-09-05-shellbell-04b-herdr/preflight-scan.md`. Every row below is now fixed in
the plan text above.

**Drift against shipped code (the plan had been written against the pre-`b8b8b70` `cli.ts`):**

- **Header SHA corrected to `5601537`** and a "read these shipped files first" box added, naming the
  six files whose current contents the tasks depend on. The old text claimed Plan 03 shipped at
  `6bb2a53`, which is eight commits stale and is the root cause of every row below. *(PF-1.8)*
- **Task 6's `cli.ts` edits rewritten as nine minimal, anchored insertions.** They previously
  *replaced* `buildAgent`'s return object, `start`'s destructure and the whole signal handler,
  which would have (a) failed to compile — `releaseOutput` and `stopFirstConnect` are used at
  `cli.ts:364`, `:382`, `:400–406` and `:420` — and (b) silently reverted three shipped fixes: the
  buffered `print()`/`releaseOutput()` output ordering, the double-Ctrl-C `shuttingDown` guard, and
  `shutdown`'s `exit`/`cleanup` arguments plus its `.catch`. Every shipped anchor line is now quoted
  verbatim. *(PF-1.1, 1.2, 1.3)*
- **The herdr detector is now stopped on every exit path**, not just SIGINT: `buildAgent` gains one
  `stopBackendDetectors = () => { stopFirstConnect(); herdr.stop(); }` cleanup, passed wherever
  `stopFirstConnect` was passed — the signal handler, `onSuperseded`, and `pair`'s 5-minute timer.
  *(PF-1.4)*
- **The herdr startup banner goes through `print()`, not `console.log`**, so it cannot interleave
  with spec 8.1's exact-text header block — the same defect `b8b8b70` fixed for the iTerm2 line.
  *(PF-1.7)*
- **Task 6's tracker/agent `absoluteLines` work deleted: it already shipped.**
  `ScreenTracker.processScreen` already reads
  `backend.capabilitiesOf?.(sessionId)?.absoluteLines ?? backend.capabilities.absoluteLines`, and
  `BackendRegistry.capabilitiesOf` already exists. The plan's `capabilitiesOf` tracker option,
  `absoluteLinesFor()` helper, `else if` rewrite and `agent.ts` change were duplicate logic that
  would also have orphaned the shipped `absoluteLines` const and failed `pnpm lint`
  (`noUnusedVariables`). Task 6's interface list, rulings list, file-structure entry and the
  self-review coverage table were updated to say ruling 8 is already satisfied. *(PF-1.5, 5.1)*
- **The duplicate tracker test was dropped.** `test/screen-tracker.test.ts` already ends with
  `describe("per-backend absoluteLines via BackendRegistry.capabilitiesOf …")`, which drives a real
  registry with an iTerm2 and a tmux member; the plan's replacement passed `absoluteLines: true` for
  the session under test and so asserted nothing the shipped code did not already do. *(PF-5.2)*
- **Task 5's `refreshSessions` rewrite no longer changes the `catch` body.** It had silently swapped
  the shipped `{ err: err instanceof Error ? err.name : "unknown" }` for `{ err: String(err) }`,
  widening the log to full error messages against spec 8.10. *(PF-1.6)*
- **Task 2's `TerminalBackend` diff is now the complete interface, with no `// … unchanged members
  …` ellipsis** and including the shipped `capabilitiesOf?`, which the ellipsis had hidden. This also
  removes the one real counter-example to the plan's own "Placeholder scan: none". *(PF-1.9)*

**Test defects:**

- **`FakeHerdr.stop()` now destroys every accepted socket, not just registered event streams.** The
  "rejects immediately when the socket dies before the ack" test parks a connection with
  `silence()`, which never enters `streams`; `server.close()`'s callback waits for the last
  connection to end, so `await herdr.stop()` never resolved and the test — plus its `afterEach` —
  hung. *(PF-3.3)*
- **The "ack and event in one chunk" test now really coalesces them.** It called
  `reply("events.subscribe", …)`, which is dead code (the fake handles that method before consulting
  `handlers`), and then wrote the ack and the event in two separate `socket.write` calls. The fake
  gained an `ackRider` queue that emits both in a single write. *(PF-3.4)*
- **Explicit type predicate for `agent-state` filtering.** Two assertions used
  `events.filter((e) => e.type === "agent-state").map((e) => e.sessionId)`, which only compiles
  through TypeScript's inferred type predicates (5.5+) — `sessionId`/`state` do not exist on
  `{ type: "layout-changed" }`. Replaced with one `agentStateEvents()` helper carrying an explicit
  `e is Extract<BackendEvent, { type: "agent-state" }>`. *(PF-3.9)*
- **Every poller "nothing happened" window widened from 60–80 ms to 300 ms, with an explicit
  probe-count growth assertion.** One poll interval is `POLL_FAST_MS` (200 ms), so the odd-revision
  and steady-state checks were passing vacuously — no probe ran at all inside the window, proving
  nothing about the skip rule. Applied to the odd-revision, baseline, unwatch, close and
  probe-failure windows. *(PF-3.10)*
- **Task 9's live command fixed to `pnpm -F shellbell exec vitest run …`** — `vitest` is not a script
  in `apps/agent/package.json`, so the old form could not run. The gate also matches the shipped
  `live-iterm2.test.ts` shape (`Boolean(process.env.SHELLBELL_LIVE)`). *(PF-3.22, 6.6)*
- **Task 1's new relay push test closes `agent.ws` and `p.ws`**, like every sibling test in
  `push.test.ts`. *(PF-3.1)*

**Rubric and honesty:**

- **`sendText` no longer logs the key name.** `this.log.debug("herdr key", { key: whole })` became
  `this.log.debug("herdr key")`: a key name is still a keystroke, and both spec 8.10 and this plan's
  own Global Constraints say never log keys. *(PF-5.5)*
- **The `pane.scroll_changed` payload test is relabelled as the unverified path.** The research
  records the event as `{ pane_id }` with no `scroll` object, so the rate-limited `pane.get` refresh
  is the **primary** mechanism and reading numbers off the payload is an opportunistic shortcut. The
  rules table, the handler comment, both test names and known-unknown 1 now say so, and
  known-unknown 1 carries an explicit Task 8 action (delete the shortcut test, or promote it).
  *(PF-3.11, 4.3)*
- **The macOS socket path is called out as a blocking spike answer.** `herdrSocketPath()`'s
  `~/.config` default on macOS is read from the Rust source but never observed on a Mac. Spike
  question 1 now demands the real path with a concrete `ls` command, the spike script prints a
  multi-line warning when the resolved path does not exist, and a new known-unknown (11) records the
  fallback (a second `existsSync` candidate) if it turns out to be wrong. *(PF-4.4)*
- **README/self-hosting edits are now anchored to exact shipped lines** (`README.md:5–7`, quoted
  verbatim; `docs/self-hosting.md` after step 6 on line 13, before the heading on line 22) instead
  of the prose "replace the description paragraph". *(PF-3.21)*

**Confirmed correct by the scan, left alone:** all 20 `events.subscribe` types exist in the
research's 27-variant `Subscription` oneOf; the `HERDR_KEYS` table matches Herdr's documented key
grammar and `\r`/`\n`/`\t` correctly pre-empt the `ctrl-m`/`ctrl-j`/`ctrl-i` aliases; the
`getHistory` depth/`want`/`end`/`start`/`oldestAvailable` arithmetic and the `convert.ts` cursor and
fit arithmetic re-derived by hand; `pane.split`/`tab.create`/`pane.copy_motion`/`pane.get`/
`pane.read` params and results match the research verbatim; fixture filenames are identical across
Tasks 3, 4, 7 and 8; no new runtime dependency and exactly one new script (`spike:herdr`); every test
command is `alarm`-bounded; `Agent`'s existing `hello` handshake cannot double-fire, because
`registry.add` runs before `new Agent(...)` in `agent.integration.test.ts` and the `first` guard
absorbs the initial `backendsKey`; and only Task 7 Step 3 and Task 9 Step 2 — both Human-run only —
ever touch a real Herdr socket.

## Task 8 (revised 2026-09-06 after the spike) — controller ruling R68

`docs/spike-herdr.md` now exists. The spike proved the plan's central assumption wrong:
`pane.copy_motion` is not a method in Herdr 0.8.2, while `pane.updated` events carry a monotonic
`revision`. Task 8 therefore replaces the revision poller with event-driven change detection, in
addition to adopting the fixtures. Spec §8.13 "Change detection" has been rewritten accordingly.

**Files:** modify `apps/agent/src/backends/herdr/{backend,types}.ts`, `apps/agent/scripts/spike-herdr.ts`,
`apps/agent/test/fakes/fake-herdr.ts`, `apps/agent/test/herdr-backend.test.ts`,
`apps/agent/test/herdr-agent.test.ts`, `apps/agent/test/herdr-start.test.ts` (option removal only),
fixtures under `apps/agent/test/fixtures/` (captured ones are already on disk, uncommitted); delete
`apps/agent/test/fixtures/herdr-copy-motion.json`; add `apps/agent/test/fixtures/herdr-pane-updated-event.json`
(the sanitized payload in `docs/spike-herdr.md`).

- [ ] **Step 1: event-driven revisions.** In `handleEvent`, `pane_updated` is no longer a snapshot
  hint. Read `data.pane` (`PaneInfo`). Unknown `pane_id` → `scheduleSync("snapshot")` (new pane).
  Known pane → in place: update `scrollMax`/`rows` from `scroll` (as `pane_scroll_changed` does),
  `scrollStale = false`; apply `agent_status` through the same latest-wins path as
  `pane_agent_status_changed` (stamp `statusSeq`, emit `agent-state` only on a transition; `agent`/
  `display_agent` names are absent here, so leave the title alone); if `typeof pane.revision ===
  "number"` and it differs from the stored `revision` → store it and emit `screen-changed` for
  that pane (all panes, watched or not — the tracker filters). Keep the existing
  `pane_agent_status_changed` case unchanged.
- [ ] **Step 2: snapshot re-seed.** `applySnapshot` stores each pane's `revision` from the snapshot
  and, for a pane that already existed with a different numeric revision, emits `screen-changed`
  (this covers events missed while the event stream was down). First sight of a pane stores the
  revision silently.
- [ ] **Step 3: delete the poller.** Remove `runProbes`, `probes`, `pollTimer`, `polling`,
  `intervalFor`, `POLL_*`/`SETTLE_*`, `revisionPollMs`, `CopyMotionResult`, and the `setWatched`
  method (the `TerminalBackend.setWatched?` hook stays optional in `types.ts`; nothing else
  implements it — verify with grep and leave the registry untouched). Remove `revisionPollMs` from
  every test's `backendOptions`.
- [ ] **Step 4: fake server.** `FakeHerdr` drops its `pane.copy_motion` handler and gains a helper
  `bumpRevision(paneId, n = 1)` that mutates the pane's `revision` and emits `pane_updated` with the
  full `PaneInfo` to every subscriber whose subscriptions include `pane.updated`. `pane.send_text` /
  `pane.send_keys` call it once. Rejecting `pane.copy_motion` with `invalid_request` (like the real
  server) is the new default for any unknown method if the fake does not already do that.
- [ ] **Step 5: tests** (replace the copy_motion tests in `herdr-backend.test.ts` ~640–730 and the
  `herdr-agent.test.ts` probes at ~168–220): (a) `pane_updated` with a new revision → one
  `screen-changed` for that terminal id; (b) same revision again → nothing; (c) unknown pane →
  `session.snapshot` requested; (d) a snapshot after reconnect whose revision moved → `screen-changed`,
  unchanged → nothing; (e) `agent_status` `working` → `blocked` inside `pane_updated` → exactly one
  `agent-state`; (f) `herdr.called("pane.copy_motion")` is empty across the suite; (g) the agent-level
  test asserts a phone viewing a Herdr pane receives a screen frame after `bumpRevision` (no
  poll option needed).
- [ ] **Step 6: fixtures.** Review the four rewritten fixtures for identifiers (`grep -i bilal` must
  be empty), delete `herdr-copy-motion.json`, add `herdr-pane-updated-event.json`, then follow the
  original Task 8 Step 2 table for every failing expectation (`pane.read` rows are trimmed — the
  padding rule must hold; `ping.protocol` is 20). If `parseSgrLine` meets a CSI final other than `m`
  in the captured ANSI, stop and report.
- [ ] **Step 7: spike script.** Drop the `copy_motion` sections (Q4 line, Q9) and instead report the
  `pane_updated` revisions observed for each pane during the 30 s window, plus `pane.get.revision`.
- [ ] **Step 8: errata + commit.** Append bullets to "Post-spike errata" below (assumption → measured
  → change), run `pnpm lint:fix && pnpm lint`, `pnpm typecheck`, `perl -e 'alarm 600; exec @ARGV' pnpm test`,
  and commit as `feat(agent): herdr change detection via pane_updated revisions; adopt spike fixtures`.

## Task 10 (added 2026-09-06) — hide the iTerm2 session that hosts a multiplexer client (spec 8.12)

Bilal's observation: Herdr's client runs inside iTerm2, so the iTerm2 backend already mirrors the
whole Herdr UI as one session while the Herdr backend lists its panes — duplicate content and
double rings. Spec §8.12 "Host-session de-duplication" is the authority; this task implements it.

**Files:** modify `apps/agent/src/backends/iterm2/backend.ts`, `apps/agent/src/backends/types.ts`,
`apps/agent/src/backends/registry.ts`; tests `apps/agent/test/iterm2-backend.test.ts`,
`apps/agent/test/registry.test.ts` (and `test/fakes/fake-iterm2*.ts` if the fake needs to answer
`jobName`).

- [ ] **Step 1: `jobName` in the iTerm2 backend.** Where `session.name`/`session.path` are
  subscribed (`NOTIFY_ON_VARIABLE_CHANGE`), also subscribe `jobName`; where `variable(id,
  "session.name")` is fetched on adoption, also fetch `jobName`; store it as `job?: string` on the
  native record; update it from the variable-change notification. Add `hostJob(sessionId): string |
  undefined` to the iTerm2 backend and as an optional method on `TerminalBackend` in `types.ts`
  (next to `tmuxWindowIds?`). `jobName` is the executable name only (`herdr`, `tmux`, `zsh`); do
  not log it (spec 8.10 — it can name a private tool).
- [ ] **Step 2: registry rule.** In `BackendRegistry.listSessions()`, after computing `hidden`, hide
  an iTerm2 session `s` when `iterm.hostJob?.(s.id)` is `"herdr"` and the herdr member is
  connected (`isConnected?.() !== false` and present), or `"tmux"` and the tmux member is
  connected and `s` has no `tmuxWindowId` (the iTerm2 `SessionInfo` must expose whether it is a
  `-CC` tab — add a boolean if `toInfo` does not already carry it; do not reuse `tmuxWindowIds()`
  which is keyed the other way). Wrap in the same try/warn pattern as `tmuxWindowIds`. Routing
  (`getScreen`, `sendInput`, …) is untouched: a hidden session is still addressable.
- [ ] **Step 3: tests.** iTerm2 backend: a `jobName` variable-change notification updates
  `hostJob`; adoption fetches it. Registry: (a) iTerm2 `herdr` host + herdr connected → hidden;
  (b) herdr backend absent or `isConnected() === false` → shown; (c) `tmux` host without
  `tmuxWindowId` + tmux connected → hidden; (d) `tmux` host that IS a `-CC` tab → shown (the
  `-CC` rule hides the tmux side instead); (e) `zsh` host → shown; (f) hidden session still routes
  `getScreen`. Reuse the fakes `registry.test.ts` already builds.
- [ ] **Step 4: gates + commit.** `pnpm lint:fix && pnpm lint`, `pnpm typecheck`,
  `perl -e 'alarm 600; exec @ARGV' pnpm -F shellbell test`; commit
  `feat(agent): hide the iTerm2 session hosting a herdr or tmux client`.

## Task 11 (added 2026-09-06) — survive the subscription replay (spec 8.13, ruling R71)

Third spike run (`docs/spike-herdr.md`, "Third run"): `events.subscribe` replays ~25 recent events
before going live. Today `pane_updated` applies any revision that *differs* (so a replayed 1…7 after
a stored 8 emits seven spurious `screen-changed` and rewinds the revision) and
`pane.agent_status_changed` is applied directly (a replayed stale status flips the pane and can ring).

**Files:** `apps/agent/src/backends/herdr/backend.ts`, `apps/agent/test/herdr-backend.test.ts`,
`apps/agent/test/herdr-agent.test.ts` (if it asserts direct agent-status application),
`apps/agent/test/fakes/fake-herdr.ts` (a `replay(events)` helper that pushes a burst right after the
`subscription_started` ack).

- [x] **Step 1: monotonic revisions.** In the `pane_updated` case: if `typeof info.revision ===
  "number"` and `pane.revision` is a number and `info.revision <= pane.revision`, return without
  touching anything (no scroll, no status, no title/cwd sync, no `screen-changed`). Only a strictly
  newer revision applies the payload and emits. `applySnapshot` keeps its own rule (a snapshot is
  authoritative; it may move the revision either way but emits `screen-changed` only when it moved).
- [x] **Step 2: agent_status_changed becomes a hint.** Replace the direct application with
  `scheduleSync("snapshot")`; drop the `statusSeq` stamping from that path (keep it for
  `pane_updated`, which is revision-ordered). `applySnapshot` already emits `agent-state` on a
  transition and `title-changed` on a title change — verify, and make it so if not. The comment block
  that calls the event "the one event whose whole payload is the new value" is rewritten.
- [x] **Step 3: tests.** (a) bootstrap with a fake replay burst of stale `pane_updated` (revisions
  below the snapshot's) → zero `screen-changed`, revision unchanged; (b) a replayed
  `pane.agent_status_changed` with a stale status → no `agent-state` emitted before the snapshot,
  and the snapshot (which still says the current status) emits nothing either; (c) a live
  `pane.agent_status_changed` whose snapshot answers `blocked` → exactly one `agent-state blocked`
  within the debounce; (d) a `pane_updated` with a newer revision and new `agent_status` still applies
  directly (Task 8 test retained); (e) equal revision → ignored. Update any test that asserted direct
  application (`applies agent status directly …`).
- [x] **Step 4: errata + gates + commit.** Append to "Post-spike errata"; `pnpm lint:fix && pnpm lint`,
  `pnpm typecheck`, `perl -e 'alarm 600; exec @ARGV' pnpm -F shellbell test` (twice); commit
  `fix(agent): herdr ignores replayed events — monotonic revisions, agent status via snapshot`.
