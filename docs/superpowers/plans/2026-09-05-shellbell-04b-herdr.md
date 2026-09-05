# Shellbell Plan 04b — Herdr backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panes owned by [Herdr](https://herdr.dev) — the Rust runtime that hosts coding agents (Claude Code, Codex, Cursor, OpenCode, …) — appear in the Shellbell app next to iTerm2 sessions, stream styled screens, accept input, can be created and focused from the phone, and **ring the phone the moment an agent goes `blocked`** ("An agent is waiting for you"). Herdr is the third `TerminalBackend`; it runs alongside iTerm2 and tmux with no de-duplication rule.

**Architecture:** `HerdrClient` owns the transport: newline-delimited JSON over a Unix socket with **one request per connection**, plus one long-lived `events.subscribe` connection. `convert.ts` turns a `pane.read {format:"ansi"}` snapshot into `Line[]` with `parseSgrLine`. `HerdrBackend` implements `TerminalBackend` on top of both: a `terminal_id → pane_id` map refreshed from `session.snapshot` and lifecycle events, a 200 ms `pane.copy_motion` revision poller that runs **only for panes a phone is viewing** (new `TerminalBackend.setWatched?` hook, driven by `ScreenTracker`), and a new `agent-state` backend event that `EventEngine` turns into `blocked` and `prompt` rings. Herdr has no cursor, no screen-change push and no command lifecycle, so the cursor is faked at the end of the last non-blank row, change detection is polled, and `capabilities.prompts` is `false`.

**Tech Stack:** Node 22, TypeScript 5.9, `@shellbell/protocol` (`parseSgrLine`, `stringCells`, `emptyLine`), vitest 5, `node:net` (no new runtime dependency). Herdr ≥ 0.7.2 (socket protocol ≥ 22) on the user's machine — never installed by this plan.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — **§8.13** (authority for this plan), plus §8.4 (`TerminalBackend`), §8.6 (tracker), §8.8 (events and ringing), §8.12 (registry), §7.4/§7.5 (wire protocol, named keys), §11.3 (push targeting), §15 (testing). Plan 03 is complete and shipped; Plan 04 (tmux) is **not** required. The verified Herdr research report is `.superpowers/research/herdr-socket-api.md` — every JSON shape in this plan comes from it.

## Global Constraints

- All Plan 01/03 constraints apply. **No new runtime dependency**: the Herdr transport is `node:net` + `JSON`. Nothing from Herdr is vendored — no schema file, no code (spec 8.13 "Licensing"); the wire types in `src/backends/herdr/types.ts` are hand-written from the research report. Say "works with Herdr"; never use Herdr branding in a product name.
- **Steps marked "Human-run only" are never executed by implementers.** An implementer who reaches such a step records "not run (human-run only)" and moves on.
- **Never install Herdr in an implementer step.** `curl … | sh` appears in this plan only inside user-facing hint strings and inside Task 7, which is Human-run only. Implementers never run it, never start a `herdr` server, and never touch `~/.config/herdr/`. Every automated test in this plan talks to a **fake Herdr server on a temp Unix socket**.
- Plan code blocks may exceed Biome's 100-column limit; implementers wrap lines (`pnpm lint:fix`) without changing semantics. `pnpm lint` must pass before every commit.
- Never log keys, cookies, pairing codes, terminal content, or input text. `pane.read` text, `pane.send_text` text and pane titles are terminal content: log **lengths** and ids only. The fixtures committed by Task 7 must be sanitized by the human who captures them.
- Timers in this plan: Herdr request timeout **5 s**; `events.subscribe` ack timeout **5 s**; reconnect poll after the socket dies **2 s, fixed** (spec 8.13 — *not* the iTerm2 exponential backoff); resubscribe debounce **250 ms**; revision poll **200 ms**; backend detection retry while Herdr is absent **10 s** (spec 8.12). Every one is an option with these defaults so tests can shrink it.
- Tests use a real Unix socket under `mkdtempSync(join(tmpdir(), …))` and **real** timers with short intervals plus `waitFor` from `test/fakes/wait.ts`. Do not mix `vi.useFakeTimers()` with live sockets.
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
│   ├── agent.ts            (modified) refresh `sessions` on agent-state
│   ├── cli.ts              (modified) start the herdr detector; banner line
│   ├── doctor.ts           (modified) herdr version/protocol check
│   ├── events.ts           (modified) agent-state -> blocked/prompt rings
│   ├── screen-tracker.ts   (modified) push the viewed set to backend.setWatched
│   └── backends/
│       ├── types.ts        (modified) BackendEvent += agent-state; TerminalBackend.setWatched?
│       ├── registry.ts     (modified) herdr in splitId/listSessions; setWatched pass-through
│       └── herdr/
│           ├── types.ts    hand-written Herdr wire shapes
│           ├── client.ts   HerdrClient, HerdrError, socket discovery, ping/request/subscribe
│           ├── convert.ts  ANSI read -> Screen (faked cursor)
│           ├── keys.ts     NamedKey bytes -> herdr key names
│           ├── backend.ts  HerdrBackend
│           └── start.ts    checkHerdr() + startHerdrBackend()
└── test/
    ├── fakes/fake-herdr.ts        fake Herdr server (one request per connection, NDJSON)
    ├── herdr-client.test.ts  herdr-convert.test.ts  herdr-backend.test.ts
    ├── herdr-start.test.ts   live-herdr.test.ts
    └── fixtures/herdr-ping.json  herdr-session-snapshot.json
        herdr-pane-read-visible.json  herdr-pane-read-recent.json
        herdr-agent-status-event.json  herdr-copy-motion.json

docs/
├── spike-herdr.md          Human-run spike results
├── self-hosting.md         (modified) "works with Herdr"
└── ../README.md            (modified) "works with Herdr"
```

---

### Task 1: Protocol and relay — the `herdr` backend name and the `blocked` ring (spec 8.13, 11.3)

**Files:**
- Modify: `packages/protocol/src/inner.ts`, `packages/protocol/src/ctrl.ts`, `packages/protocol/test/messages.test.ts`
- Modify: `apps/relay/src/push.ts`, `apps/relay/test/push.test.ts`

**Interfaces (after this task):**
- `BackendNameSchema = z.enum(["iterm2", "tmux", "herdr"])`
- `SessionInfoSchema.state = z.enum(["unknown", "editing", "running", "finished", "blocked"])`
- `EventKindSchema = z.enum(["prompt", "idle", "exit", "blocked"])`
- ctrl `notify.kind = z.enum(["prompt", "idle", "blocked"])`
- `pushBody("blocked") === "An agent is waiting for you"`

**Golden vectors:** `packages/protocol/test/vectors.json` encodes only crypto material plus the single plaintext `{"type":"input.line","reqId":"r1","sessionId":"iterm2:x","text":"y"}` (see `packages/protocol/scripts/gen-vectors.ts`). **No vector encodes `BackendName`, `EventKind`, `notify.kind` or `SessionInfo.state`, so no vector is regenerated by this plan.** Step 4 below proves it.

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/test/messages.test.ts`, add to the ctrl `ok` array (after the existing `notify` entry):

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

- [ ] **Step 2: Run the tests to verify they fail**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/protocol test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/relay test
```
Expected: the protocol suite fails on `backend: "herdr"` / `kind: "blocked"` / `state: "blocked"`; the relay suite fails on the `"blocked"` body.

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

`packages/protocol/src/ctrl.ts` — two lines change:

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
Expected: both suites pass; the `grep -c` prints `0`; the `git diff --stat` prints nothing (the file is untouched). If the grep is ever non-zero, run `pnpm -F @shellbell/protocol gen:vectors` and commit the regenerated file with an explanation — it is not expected here.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol apps/relay
git commit -m "feat(protocol): add the herdr backend name and the blocked event kind"
```

---

### Task 2: `HerdrClient` — NDJSON socket transport (spec 8.13 "Discovery and transport")

**Files:**
- Create: `apps/agent/src/backends/herdr/types.ts`, `apps/agent/src/backends/herdr/client.ts`
- Create: `apps/agent/test/fakes/fake-herdr.ts`, `apps/agent/test/herdr-client.test.ts`

**Interfaces:**
- `herdrSocketPath(env?, home?): string` — `$HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock`.
- `class HerdrError extends Error { readonly code: string }` — `code` is Herdr's own error code (`not_found`, `pane_not_found`, `invalid_params`, `agent_not_idle`, …) or one of ours: `timeout`, `unavailable`, `closed`, `malformed`, `overflow`, `socket`.
- `GONE_CODES: Set<string>` — codes that mean "this pane no longer exists".
- `MIN_PROTOCOL = 22`, `INSTALL_HINT`, `UPGRADE_HINT`.
- `interface HerdrStream { close(): void }`, `interface HerdrStreamHandlers { onEvent(e: HerdrEvent): void; onEnd(reason: string): void }`.
- `class HerdrClient { constructor(opts: { log: Logger; socketPath?: string; requestTimeoutMs?: number }); get socketPath: string; request<T>(method: string, params?: Record<string, unknown>): Promise<T>; subscribe(subscriptions: unknown[], handlers: HerdrStreamHandlers): Promise<HerdrStream>; ping(): Promise<Pong> }`.
  - `request` opens **one connection per call**, writes one line, reads one line, closes. There is no multiplexer and no request id map: Herdr's server reads exactly one line per connection (`src/api/server.rs::handle_connection_with_stop`), so an `id` map would be dead code.
  - `ping()` throws `BackendUnavailable` (not `HerdrError`) when the socket is missing or the protocol is below 22 — that is the error `connect()` and `doctor` want.

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

/**
 * Stand-in for the Herdr socket server. It deliberately models the two transport facts that
 * shape our client (research §1): **one request per connection** — the server reads exactly one
 * line, answers it and hangs up — and NDJSON framing. `events.subscribe` is the one exception:
 * that connection stays open, acks with `subscription_started`, and then streams bare
 * `{"event":…,"data":…}` lines that carry no `id`.
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
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly failures = new Map<string, { code: string; message: string }>();
  private readonly silenced = new Set<string>();
  private readonly streams = new Set<Socket>();
  private server: Server | null = null;

  /** `path` lets a test bind a chosen socket file (e.g. one that does not exist yet). */
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
  pushEvent(event: string, data: unknown): void {
    const line = `${JSON.stringify({ event, data })}\n`;
    for (const s of this.streams) s.write(line);
  }
  /** `herdr server stop`: every open connection dies with EOF and the socket file goes away. */
  dropStreams(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  start(): Promise<void> {
    const server = createServer((socket) => {
      this.connections++;
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
      socket.on("close", () => this.streams.delete(socket));
    });
    this.server = server;
    return new Promise((resolve) => server.listen(this.path, () => resolve()));
  }

  stop(): Promise<void> {
    this.dropStreams();
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
      this.streams.add(socket);
      socket.write(`${JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })}\n`);
      return;
    }
    const handler = this.handlers.get(method) ?? this.defaultHandler(method);
    socket.end(`${JSON.stringify({ id: msg.id, result: handler(params) })}\n`);
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
  it("prefers HERDR_SOCKET_PATH, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/tmp/x.sock" }, "/home/u")).toBe("/tmp/x.sock");
    expect(herdrSocketPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe("/cfg/herdr/herdr.sock");
    expect(herdrSocketPath({}, "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
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
  it("returns the pong and accepts protocol 22", async () => {
    const pong = await client().ping();
    expect(pong).toMatchObject({ version: "0.8.2", protocol: 22 });
  });

  it("refuses an old herdr with an upgrade hint", async () => {
    herdr.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 14 }));
    const err = await client()
      .ping()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).message).toMatch(/protocol 14/);
    expect((err as BackendUnavailable).hint).toMatch(/herdr\.dev\/install\.sh/);
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
    const stream = await client().subscribe([{ type: "pane.created" }], {
      onEvent: (e) => events.push(`${e.event}:${String(e.data.pane_id ?? "")}`),
      onEnd: (reason) => ends.push(reason),
    });
    await waitFor(() => herdr.streamCount === 1);
    expect(herdr.called("events.subscribe")[0]?.params).toEqual({
      subscriptions: [{ type: "pane.created" }],
    });
    herdr.pushEvent("pane_focused", { pane_id: "w1:p1", workspace_id: "w1" });
    herdr.pushEvent("pane.agent_status_changed", { pane_id: "w1:p1", agent_status: "blocked" });
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["pane_focused:w1:p1", "pane.agent_status_changed:w1:p1"]);

    herdr.dropStreams();
    await waitFor(() => ends.length === 1);
    expect(ends).toEqual(["eof"]);
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

  it("rejects when the subscription is refused", async () => {
    herdr.fail("events.subscribe", "invalid_params", "unknown subscription type");
    await expect(
      client().subscribe([{ type: "pane.output_changed" }], {
        onEvent: () => undefined,
        onEnd: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test` (module not found).

- [ ] **Step 4: Implement the wire types**

`apps/agent/src/backends/herdr/types.ts`:

```ts
/**
 * Herdr socket-API wire shapes, hand-written from the verified research report
 * (`.superpowers/research/herdr-socket-api.md`). Nothing is vendored from Herdr — no schema
 * file, no generated code (spec 8.13 "Licensing"). Every field is optional unless the research
 * lists it as required, and unknown fields are ignored, which is exactly what Herdr asks of
 * JSON API clients ("clients should ignore unknown fields and handle unsupported methods as
 * normal errors").
 */
import type { AgentState } from "../types.js";

/** Herdr's `AgentStatus` is byte-for-byte our `AgentState`; keep one definition. */
export type AgentStatus = AgentState;

export interface Pong {
  type: "pong";
  version?: string;
  protocol?: number;
  capabilities?: Record<string, unknown> | null;
}

export interface PaneScroll {
  offset_from_bottom?: number;
  max_offset_from_bottom?: number;
  viewport_rows?: number;
}

export interface PaneInfo {
  pane_id: string;
  /** Stable across server restarts and `pane.move`; `pane_id` is not. Optional defensively. */
  terminal_id?: string;
  workspace_id: string;
  tab_id: string;
  focused?: boolean;
  agent_status?: string;
  revision?: number;
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

export interface WorkspaceInfo {
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
}

export interface Rect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PaneLayoutSnapshot {
  workspace_id?: string;
  tab_id?: string;
  focused_pane_id?: string | null;
  panes?: { pane_id: string; focused?: boolean; rect?: Rect }[];
}

export interface SessionSnapshot {
  version?: string;
  protocol?: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces?: WorkspaceInfo[];
  tabs?: TabInfo[];
  panes?: PaneInfo[];
  layouts?: PaneLayoutSnapshot[];
}

export interface SessionSnapshotResult {
  type: "session_snapshot";
  snapshot: SessionSnapshot;
}

export interface PaneReadResult {
  type: "pane_read";
  read: {
    pane_id?: string;
    source?: string;
    format?: string;
    /** ⚠ always 0 on `pane.read` (hard-coded upstream) — never usable as a change cursor. */
    revision?: number;
    truncated?: boolean;
    text?: string;
  };
}

export interface PaneInfoResult {
  type: "pane_info";
  pane: PaneInfo;
}

export interface TabCreatedResult {
  type: "tab_created";
  tab?: TabInfo;
  root_pane: PaneInfo;
}

export interface CopyMotionResult {
  type: "pane_copy_motion";
  pane_id?: string;
  /** `runtime.content_seq()` — the terminal's real content counter. Odd = a write is in flight. */
  content_revision?: number;
}

/** A streamed event line: lifecycle events are snake_case, subscription events are dotted. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}
```

- [ ] **Step 5: Implement the client**

`apps/agent/src/backends/herdr/client.ts`:

```ts
import { connect as netConnect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../../log.js";
import { BackendUnavailable } from "../types.js";
import type { HerdrEvent, Pong } from "./types.js";

/** Herdr's bundled schema declares `"protocol": 22`; that is our floor (herdr >= 0.7.2). */
export const MIN_PROTOCOL = 22;
export const INSTALL_HINT =
  'Install Herdr: curl -fsSL https://herdr.dev/install.sh | sh, then start it with "herdr".';
export const UPGRADE_HINT =
  "Upgrade Herdr to 0.7.2 or newer: curl -fsSL https://herdr.dev/install.sh | sh, then restart it.";
/** Herdr's own per-line cap (`src/api/server.rs`): 1 MiB. Refuse anything longer. */
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

/** Herdr error codes that mean "that pane is gone" -> our `SessionGone`. */
export const GONE_CODES = new Set(["not_found", "pane_not_found", "stale_pane_target"]);

export interface HerdrStream {
  close(): void;
}

export interface HerdrStreamHandlers {
  onEvent(e: HerdrEvent): void;
  /** Called once, after the ack, when the connection dies: "eof" | "error" | "closed". */
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

/**
 * Spec 8.13: `$HERDR_SOCKET_PATH`, else `$XDG_CONFIG_HOME/herdr/herdr.sock`, else
 * `~/.config/herdr/herdr.sock`. Herdr uses the same layout on macOS and Linux — there is no
 * `~/Library/Application Support` special case (research §1 "Socket path").
 */
export function herdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.HERDR_SOCKET_PATH;
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "herdr", "herdr.sock");
  return join(home, ".config", "herdr", "herdr.sock");
}

function socketError(err: NodeJS.ErrnoException, method: string, path: string): HerdrError {
  const code = err.code ?? "";
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM")
    return new HerdrError("unavailable", `cannot reach the herdr socket at ${path} (${code})`);
  return new HerdrError("socket", `${method}: ${err.message}`);
}

/**
 * Feeds complete NDJSON lines to `onLine`. A `StringDecoder` is required, not `chunk.toString()`:
 * a styled `pane.read` carries multi-byte UTF-8 that can straddle a chunk boundary.
 */
function pipeLines(socket: Socket, onLine: (line: string) => void, onOverflow: () => void): void {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    if (buf.length > MAX_LINE_BYTES) {
      buf = "";
      onOverflow();
      return;
    }
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
      i = buf.indexOf("\n");
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
   * One request, one connection (research §1: the server reads exactly one line per connection
   * and then drops it). There is deliberately no request-id map and no pipelining.
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
          if (msg.error) {
            done(new HerdrError(msg.error.code || "error", msg.error.message || method));
            return;
          }
          if (msg.result === undefined) {
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
   * after that, every bare `{"event":…,"data":…}` line reaches `onEvent`, and the connection
   * dying reaches `onEnd` exactly once. Herdr has no "add subscription" method, so changing the
   * per-pane subscription set means opening a new stream and closing this one.
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
        if (!acked || ended) return;
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
            this.log.warn("undecodable herdr stream line", { bytes: line.length });
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
          // this runs before the caller's `await` resumes — the caller must have its buffer ready.
          if (typeof msg.event === "string") {
            const data =
              msg.data && typeof msg.data === "object" ? (msg.data as Record<string, unknown>) : {};
            handlers.onEvent({ event: msg.event, data });
          }
        },
        () => failBeforeAck(new HerdrError("overflow", "events.subscribe sent an oversized line")),
      );
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (!acked) failBeforeAck(socketError(err, "events.subscribe", path));
        else end("error");
      });
      socket.on("close", () => end("eof"));
    });
  }

  /**
   * Discovery call. Throws `BackendUnavailable` (never `HerdrError`) so `connect()` and `doctor`
   * both get an actionable hint: no socket -> install/start Herdr; protocol < 22 -> upgrade.
   */
  async ping(): Promise<Pong> {
    let pong: Pong;
    try {
      pong = await this.request<Pong>("ping", {});
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BackendUnavailable(detail, INSTALL_HINT);
    }
    const protocol = typeof pong.protocol === "number" ? pong.protocol : 0;
    if (protocol < MIN_PROTOCOL)
      throw new BackendUnavailable(
        `herdr speaks protocol ${protocol}, need ${MIN_PROTOCOL} (version ${pong.version ?? "?"})`,
        UPGRADE_HINT,
      );
    this.log.debug("herdr ping ok", { version: pong.version, protocol });
    return pong;
  }
}
```

Note: `types.ts` imports `AgentState` from `../types.js`, which Task 4 adds. Add it now, as a one-line change to `apps/agent/src/backends/types.ts`, so this task typechecks on its own:

```ts
/** Spec 8.13: the semantic state Herdr reports per pane. Shared with the `agent-state` event. */
export type AgentState = "working" | "blocked" | "idle" | "done" | "unknown";
```

- [ ] **Step 6: Run the tests**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck
pnpm lint:fix && pnpm lint
```
Expected: all green, including the previously shipped suites.

- [ ] **Step 7: Commit**

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
- `parseAnsiLines(text: string): Line[]` — split the ANSI blob on `\n` into per-row `Line`s with `parseSgrLine`. A single trailing empty element (from a trailing newline) is dropped. `parseSgrLine` already discards control bytes below 0x20, so a stray `\r` needs no special handling.
- `fitLines(lines: Line[], rows: number): Line[]` — pad with `emptyLine()` and truncate to exactly `rows`, using the same convention as the shipped iTerm2 `bufferToScreen`: pad at the end, `lines.length = rows` to truncate.
- `lineCells(line: Line): number` — cell width of a row (`r.n ?? stringCells(r.t)` summed).
- `fakeCursor(lines: Line[]): Cursor` — spec 8.13: Herdr exposes **no cursor**, so it goes at the end of the last non-blank row (`y` = that row, `x` = its cell width). All-blank screen -> `{ x: 0, y: 0 }`.
- `herdrScreen(input: { text: string; rows: number; cols: number; scrollMax: number }): Screen` — `scrollbackTotal = scrollMax + rows` (spec 8.13: `scroll.max_offset_from_bottom + viewport_rows`).

- [ ] **Step 1: Write the fixture**

`apps/agent/test/fixtures/herdr-pane-read-visible.json` — the **whole response line** as Herdr writes it, so Task 7 can overwrite it with a captured one verbatim:

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
  herdrScreen,
  lineCells,
  parseAnsiLines,
} from "../src/backends/herdr/convert.js";
import type { PaneReadResult } from "../src/backends/herdr/types.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "herdr-pane-read-visible.json"), "utf8"),
) as { result: PaneReadResult };
const TEXT = fixture.result.read.text as string;
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

describe("lineCells / fakeCursor", () => {
  it("counts wide cells and parks the cursor after the last non-blank row", () => {
    const lines = parseAnsiLines(TEXT);
    expect(lineCells(lines[3] as Line)).toBe(18); // 漢字 = 4 cells + " wide-cell row" = 14
    expect(fakeCursor(lines)).toEqual({ x: 18, y: 3 });
    expect(fakeCursor([{ r: [] }, { r: [] }])).toEqual({ x: 0, y: 0 });
    expect(fakeCursor([])).toEqual({ x: 0, y: 0 });
  });
});

describe("herdrScreen", () => {
  it("pads to rows, keeps cols from the layout rect, and derives scrollbackTotal", () => {
    const screen = herdrScreen({ text: TEXT, rows: 6, cols: 80, scrollMax: 120 });
    expect(screen.rows).toBe(6);
    expect(screen.cols).toBe(80);
    expect(screen.lines).toHaveLength(6);
    expect(screen.lines[4]).toEqual({ r: [] });
    expect(screen.lines[5]).toEqual({ r: [] });
    // spec 8.13: scroll.max_offset_from_bottom + viewport_rows
    expect(screen.scrollbackTotal).toBe(126);
    expect(screen.cursor).toEqual({ x: 18, y: 3 });
  });

  it("truncates a read that is longer than the viewport", () => {
    const screen = herdrScreen({ text: "a\nb\nc\nd\n", rows: 2, cols: 10, scrollMax: 0 });
    expect(screen.lines.map(flat)).toEqual(["a", "b"]);
    expect(screen.scrollbackTotal).toBe(2);
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
  /** The pane's viewport height (`scroll.viewport_rows`, else the layout rect height). */
  rows: number;
  /** The pane's layout rect width. */
  cols: number;
  /** `scroll.max_offset_from_bottom` — rows of scrollback above the viewport. */
  scrollMax: number;
}

/**
 * One row per line. Herdr's ANSI reads go through Ghostty's VT selection formatter with
 * `trim: true`, so rows carry real SGR sequences but no CUP/erase sequences, no padding to
 * `cols`, and no trailing blanks — exactly what `parseSgrLine` expects. Control bytes below
 * 0x20 (a stray CR included) are dropped by `parseSgrLine` itself.
 */
export function parseAnsiLines(text: string): Line[] {
  if (text === "") return [];
  const rows = text.split("\n");
  // A trailing newline yields one empty tail element that is not a row.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows.map(parseSgrLine);
}

/** Pad/truncate to exactly `rows`, matching the shipped iTerm2 `bufferToScreen` convention. */
export function fitLines(lines: Line[], rows: number): Line[] {
  const out = lines.slice();
  while (out.length < rows) out.push(emptyLine());
  if (out.length > rows) out.length = rows;
  return out;
}

export function lineCells(line: Line): number {
  return line.r.reduce((n, r) => n + (r.n ?? stringCells(r.t)), 0);
}

/**
 * Spec 8.13: Herdr exposes no cursor anywhere in its API, so we place one at the end of the last
 * non-blank visible row and the app dims it for `herdr` sessions. A screen with no content puts
 * it at the origin.
 */
export function fakeCursor(lines: Line[]): Cursor {
  for (let y = lines.length - 1; y >= 0; y--) {
    const line = lines[y] as Line;
    if (line.r.some((r) => r.t.trim().length > 0)) return { x: lineCells(line), y };
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
    cursor: fakeCursor(lines),
    lines,
    // spec 8.13: the closest analogue Herdr has to an absolute line count. It is not stable
    // enough to be an absolute line number, hence `capabilities.absoluteLines = false`.
    scrollbackTotal: Math.max(0, input.scrollMax) + rows,
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

### Task 4: `HerdrBackend` (spec 8.13 "Sessions", "Screen", "Input", "Create / focus", 8.4)

**Files:**
- Create: `apps/agent/src/backends/herdr/keys.ts`, `apps/agent/src/backends/herdr/backend.ts`
- Create: `apps/agent/test/herdr-backend.test.ts`
- Create fixtures: `apps/agent/test/fixtures/herdr-ping.json`, `herdr-session-snapshot.json`, `herdr-pane-read-recent.json`, `herdr-agent-status-event.json`, `herdr-copy-motion.json`
- Modify: `apps/agent/src/backends/types.ts` (`BackendEvent` += `agent-state`, `TerminalBackend.setWatched?`)

**Interfaces:**
- `apps/agent/src/backends/types.ts` gains exactly two things (plus `AgentState`, already added in Task 2):

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

```ts
export interface TerminalBackend {
  // … unchanged members …
  tmuxWindowIds?(): Set<string>;
  tmuxWindowIdOf?(nativeId: string): string | undefined;
  /**
   * Spec 8.13: the complete set of native session ids at least one phone is currently viewing.
   * A backend with no screen-change push (herdr) polls only these. `ScreenTracker` calls it
   * through the registry on every viewer change, always with the full set (never a delta), and
   * with `[]` when nothing is viewed. Backends that push screen changes ignore it.
   */
  setWatched?(nativeIds: string[]): void;
}
```

- `herdr/keys.ts`: `HERDR_KEYS: Partial<Record<NamedKey, string>>`, `herdrKeyForBytes(text: string): string | undefined`.
- `herdr/backend.ts`: `herdrSubscriptions(paneIds: string[]): Record<string, unknown>[]`, `interface HerdrBackendOptions { client: HerdrClient; log: Logger; reconnectMs?: number; revisionPollMs?: number; resubscribeMs?: number }`, `class HerdrBackend implements TerminalBackend` with `readonly name = "herdr"` and capabilities `{ subscribe: true, prompts: false, createSession: true, focus: true, history: true, absoluteLines: false }`.

**Design decisions this task pins (all from spec 8.13 + research):**

| Decision | Why |
|---|---|
| Native id = `terminal_id` | `pane_id` (`w1:p1`) is positional and is reassigned on server restart and `pane.move`. |
| Bootstrap = subscribe → buffer → `session.snapshot` → replay | Lifecycle subscriptions do not replay history, so a snapshot taken before the ack would have a gap. |
| Pane set changes ⇒ full re-bootstrap (debounced 250 ms) | `pane.agent_status_changed` is a **per-pane** subscription and Herdr has no "add subscription" call; the new stream is acked **before** the old one is closed, so no event window is lost. |
| `screen-changed` only from the revision poller | Herdr has no screen-change push at all: `pane.output_changed` is not a subscription variant and `events.wait` rejects it. |
| Poll only watched panes, 200 ms, via `pane.copy_motion` | `pane.copy_motion` is side-effect free (no focus, no copy mode) and returns the real `content_seq()`; a full styled `pane.read` per pane per tick is not affordable. |
| Never call `pane.focus` outside an explicit user action | Focusing a `done` agent marks it seen and flips it to `idle`. |
| `isFocusedOnMac` = `PaneInfo.focused` | Herdr has no "is my window frontmost" signal. |

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

`apps/agent/test/fixtures/herdr-session-snapshot.json` (one workspace, two tabs, three panes; the
first tab's layout deliberately lists `w1:p2` **before** `w1:p1` so the rect-order rule is tested):

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
        {
          "workspace_id": "w1",
          "number": 1,
          "label": "shellbell",
          "focused": true,
          "pane_count": 3,
          "tab_count": 2,
          "agent_status": "blocked"
        }
      ],
      "tabs": [
        {
          "tab_id": "w1:t1",
          "workspace_id": "w1",
          "number": 1,
          "label": "agents",
          "focused": true,
          "pane_count": 2,
          "agent_status": "blocked"
        },
        {
          "tab_id": "w1:t2",
          "workspace_id": "w1",
          "number": 2,
          "label": "logs",
          "focused": false,
          "pane_count": 1,
          "agent_status": "working"
        }
      ],
      "panes": [
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
        },
        {
          "pane_id": "w1:p3",
          "terminal_id": "term_c",
          "workspace_id": "w1",
          "tab_id": "w1:t2",
          "focused": false,
          "agent_status": "working",
          "revision": 1,
          "terminal_title_stripped": "pnpm test",
          "cwd": "/Users/dev/code/shellbell",
          "scroll": { "offset_from_bottom": 0, "max_offset_from_bottom": 40, "viewport_rows": 40 }
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
          "workspace_id": "w1",
          "tab_id": "w1:t2",
          "zoomed": false,
          "area": { "x": 0, "y": 0, "width": 160, "height": 40 },
          "focused_pane_id": "w1:p3",
          "panes": [
            { "pane_id": "w1:p3", "focused": false, "rect": { "x": 0, "y": 0, "width": 160, "height": 40 } }
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

`apps/agent/test/fixtures/herdr-pane-read-recent.json` (50 numbered rows — the fake server serves
the **last** N of these, which is what `source:"recent"` means):

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

`apps/agent/test/fixtures/herdr-agent-status-event.json` (a streamed event line — note the
**dotted** event name: subscription-driven events keep the dotted form while lifecycle events are
snake_case, and there is no `id`):

```json
{
  "event": "pane.agent_status_changed",
  "data": {
    "pane_id": "w1:p1",
    "workspace_id": "w1",
    "agent_status": "idle",
    "agent": "claude-code",
    "display_agent": "Claude Code",
    "title": "claude",
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

- [ ] **Step 2: Write the failing backend tests**

`apps/agent/test/herdr-backend.test.ts`:

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
const fixture = (name: string): { result: { [k: string]: unknown } } =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const SNAPSHOT = fixture("herdr-session-snapshot.json");
const VISIBLE = fixture("herdr-pane-read-visible.json");
const RECENT = fixture("herdr-pane-read-recent.json");
const AGENT_EVENT = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "herdr-agent-status-event.json"), "utf8"),
) as { event: string; data: Record<string, unknown> };

const recentRows = (
  (RECENT.result as { read: { text: string } }).read.text.split("\n").filter(Boolean)
);

let herdr: FakeHerdr;
let backend: HerdrBackend | null = null;
let events: BackendEvent[] = [];

async function connect(overrides: Record<string, number> = {}): Promise<HerdrBackend> {
  const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 500 });
  const b = new HerdrBackend({
    client,
    log,
    reconnectMs: 30,
    revisionPollMs: 20,
    resubscribeMs: 20,
    ...overrides,
  });
  backend = b;
  events = [];
  b.on((e) => events.push(e));
  await b.connect();
  return b;
}

const types = () => events.map((e) => e.type);
const sessionIdsOf = (type: BackendEvent["type"]) =>
  events.filter((e) => e.type === type).map((e) => ("sessionId" in e ? e.sessionId : ""));

beforeEach(async () => {
  herdr = new FakeHerdr();
  herdr.reply("session.snapshot", () => SNAPSHOT.result);
  herdr.reply("pane.read", (p) => {
    if (p.source === "recent") {
      const n = Math.min(Number(p.lines ?? 80), recentRows.length);
      return {
        type: "pane_read",
        read: { pane_id: p.pane_id, source: "recent", format: "ansi", text: `${recentRows.slice(-n).join("\n")}\n` },
      };
    }
    return VISIBLE.result;
  });
  await herdr.start();
});

afterEach(async () => {
  await backend?.close();
  backend = null;
  await herdr.stop();
});

describe("HerdrBackend.connect", () => {
  it("pings, subscribes, snapshots — in that order — and never re-uses a connection", async () => {
    await connect();
    expect(herdr.requests.map((r) => r.method)).toEqual([
      "ping",
      "events.subscribe",
      "session.snapshot",
    ]);
    expect(herdr.ignoredLines).toEqual([]);
    const subs = herdr.called("events.subscribe")[0]?.params.subscriptions as {
      type: string;
      pane_id?: string;
    }[];
    expect(subs).toContainEqual({ type: "layout.updated" });
    expect(subs.filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id)).toEqual(
      ["w1:p1", "w1:p2", "w1:p3"],
    );
  });

  it("maps panes onto SessionInfo, ordered by window, tab and rect", async () => {
    const b = await connect();
    const list = await b.listSessions();
    expect(
      list.map((s) => [s.id, s.title, s.cols, s.rows, s.tabId, s.paneIndex, s.state]),
    ).toEqual([
      ["term_a", "Claude Code", 80, 24, "w1:t1", 0, "blocked"],
      ["term_b", "zsh", 79, 24, "w1:t1", 1, "unknown"],
      ["term_c", "pnpm test", 160, 40, "w1:t2", 0, "running"],
    ]);
    expect(list[0]).toMatchObject({
      backend: "herdr",
      windowId: "w1",
      windowNumber: 1,
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
  });

  it("seeds agent-state for every pane the snapshot reports", async () => {
    await connect();
    expect(
      events
        .filter((e) => e.type === "agent-state")
        .map((e) => [e.sessionId, e.type === "agent-state" ? e.state : ""]),
    ).toEqual([
      ["term_a", "blocked"],
      ["term_b", "unknown"],
      ["term_c", "working"],
    ]);
  });

  it("refuses to connect when herdr is not running", async () => {
    await herdr.stop();
    const client = new HerdrClient({ log, socketPath: herdr.path, requestTimeoutMs: 200 });
    const b = new HerdrBackend({ client, log, reconnectMs: 10_000 });
    await expect(b.connect()).rejects.toMatchObject({
      name: "BackendUnavailable",
      hint: expect.stringContaining("herdr.dev/install.sh"),
    });
    await b.close();
  });
});

describe("HerdrBackend.getScreen / getHistory", () => {
  it("reads the visible ANSI screen through the pane id and fakes a cursor", async () => {
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
    expect(screen.scrollbackTotal).toBe(144); // 120 + 24
    expect(screen.cursor).toEqual({ x: 18, y: 3 });
    await expect(b.getScreen("nope")).rejects.toBeInstanceOf(SessionGone);
  });

  it("turns a pane_not_found read into SessionGone and forgets the pane", async () => {
    const b = await connect();
    herdr.fail("pane.read", "pane_not_found", "pane not found");
    await expect(b.getScreen("term_a")).rejects.toBeInstanceOf(SessionGone);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_b", "term_c"]);
  });

  it("pages history out of a bounded `recent` read", async () => {
    const b = await connect();
    const page1 = await b.getHistory("term_a", 120, 10);
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

    // Deeper than herdr's buffer: fewer rows come back, so the page is short and we report the
    // oldest line we could serve (spec 8.13: best-effort, `absoluteLines: false`).
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
    const b = await connect({ resubscribeMs: 5000 });
    await b.getHistory("term_a", 120, 200); // depth 0 + 200 + 24
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(224);
    await b.getHistory("term_a", 0, 200); // depth 120 + 200 + 24
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(344);
    // A pane with a very deep scrollback: the request is clamped to herdr's own 1000-line cap.
    herdr.pushEvent("pane_updated", {
      pane: {
        pane_id: "w1:p1",
        terminal_id: "term_a",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "blocked",
        display_agent: "Claude Code",
        scroll: { offset_from_bottom: 0, max_offset_from_bottom: 5000, viewport_rows: 24 },
      },
    });
    await new Promise((r) => setTimeout(r, 30)); // let the event land
    await b.getHistory("term_a", 0, 200);
    expect(herdr.called("pane.read").at(-1)?.params.lines).toBe(1000);
  });
});

describe("HerdrBackend input, create and focus", () => {
  it("sends text literally, maps known named keys, and falls back for unmapped ones", async () => {
    const b = await connect();
    await b.sendText("term_a", "ls -la\r");
    expect(herdr.called("pane.send_text").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      text: "ls -la\r",
    });
    await b.sendText("term_a", "\x03");
    expect(herdr.called("pane.send_keys").at(-1)?.params).toEqual({
      pane_id: "w1:p1",
      keys: ["ctrl+c"],
    });
    await b.sendText("term_a", "\x1b[Z");
    expect(herdr.called("pane.send_keys").at(-1)?.params.keys).toEqual(["shift+tab"]);
    // `delete` has no verified herdr key name: raw bytes through send_text instead.
    await b.sendText("term_a", "\x1b[3~");
    expect(herdr.called("pane.send_text").at(-1)?.params.text).toBe("\x1b[3~");
    await expect(b.sendText("nope", "x")).rejects.toBeInstanceOf(SessionGone);
  });

  it("splits right for vertical and down for horizontal", async () => {
    const b = await connect();
    herdr.reply("pane.split", (p) => ({
      type: "pane_info",
      pane: {
        pane_id: "w1:p4",
        terminal_id: "term_d",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "unknown",
        direction_echo: p.direction,
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

  it("creates a tab in a known workspace and rejects an unknown one", async () => {
    const b = await connect();
    herdr.reply("tab.create", () => ({
      type: "tab_created",
      tab: { tab_id: "w1:t3", workspace_id: "w1", number: 3 },
      root_pane: {
        pane_id: "w1:p5",
        terminal_id: "term_e",
        workspace_id: "w1",
        tab_id: "w1:t3",
        agent_status: "unknown",
      },
    }));
    expect(await b.createSession({ kind: "tab", backend: "herdr", windowId: "w1" })).toBe("term_e");
    expect(herdr.called("tab.create").at(-1)?.params).toEqual({ workspace_id: "w1", focus: false });
    // No windowId: the focused workspace from the snapshot.
    await b.createSession({ kind: "tab", backend: "herdr" });
    expect(herdr.called("tab.create").at(-1)?.params.workspace_id).toBe("w1");
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

describe("HerdrBackend event mapping", () => {
  it("maps every herdr event we subscribe to onto a BackendEvent", async () => {
    // `resubscribeMs` is parked far in the future here: a re-bootstrap would re-install the
    // 3-pane fixture snapshot and undo the pane this test creates. The debounce itself is
    // covered by the next test.
    const b = await connect({ resubscribeMs: 5000 });
    const pane = (id: string, terminal: string) => ({
      pane_id: id,
      terminal_id: terminal,
      workspace_id: "w1",
      tab_id: "w1:t1",
      agent_status: "unknown",
      title: "new pane",
    });

    events.length = 0;
    herdr.pushEvent("pane_created", { pane: pane("w1:p4", "term_d") });
    await waitFor(() => sessionIdsOf("session-added").includes("term_d"));
    expect((await b.listSessions()).map((s) => s.id)).toContain("term_d");

    events.length = 0;
    herdr.pushEvent("pane_updated", {
      pane: { ...pane("w1:p4", "term_d"), title: "renamed pane" },
    });
    await waitFor(() => sessionIdsOf("title-changed").includes("term_d"));

    events.length = 0;
    herdr.pushEvent("pane_focused", { pane_id: "w1:p2", workspace_id: "w1" });
    await waitFor(() => types().includes("focus-changed"));

    events.length = 0;
    herdr.pushEvent("tab_focused", { tab_id: "w1:t2", workspace_id: "w1" });
    await waitFor(() => types().includes("focus-changed"));

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
    expect([resized?.cols, resized?.rows]).toEqual([100, 24]); // rows stay viewport_rows

    events.length = 0;
    herdr.pushEvent(AGENT_EVENT.event, AGENT_EVENT.data);
    await waitFor(() => types().includes("agent-state"));
    expect(events.find((e) => e.type === "agent-state")).toMatchObject({
      sessionId: "term_a",
      state: "idle",
      agent: "claude-code",
    });

    events.length = 0;
    herdr.pushEvent("pane_closed", { pane_id: "w1:p4", workspace_id: "w1" });
    await waitFor(() => sessionIdsOf("session-removed").includes("term_d"));
    expect((await b.listSessions()).map((s) => s.id)).not.toContain("term_d");

    events.length = 0;
    herdr.pushEvent("nonsense_event", {});
    herdr.pushEvent("pane_exited", { pane_id: "w9:p9", workspace_id: "w9" });
    await new Promise((r) => setTimeout(r, 30));
    expect(types()).not.toContain("session-removed");
  });

  it("re-subscribes with the new pane set after the pane set changes", async () => {
    await connect();
    const before = herdr.called("events.subscribe").length;
    herdr.pushEvent("pane_created", {
      pane: {
        pane_id: "w1:p4",
        terminal_id: "term_d",
        workspace_id: "w1",
        tab_id: "w1:t1",
        agent_status: "unknown",
      },
    });
    await waitFor(() => herdr.called("events.subscribe").length === before + 1);
    const subs = herdr.called("events.subscribe").at(-1)?.params.subscriptions as {
      type: string;
      pane_id?: string;
    }[];
    expect(subs.filter((s) => s.type === "pane.agent_status_changed").map((s) => s.pane_id)).toEqual(
      ["w1:p1", "w1:p2", "w1:p3", "w1:p4"],
    );
    // Exactly one stream stays open: the old connection is closed only after the new one is acked.
    await waitFor(() => herdr.streamCount === 1);
  });
});

describe("HerdrBackend revision poller (spec 8.13 change detection)", () => {
  it("polls only watched panes and emits screen-changed when the revision moves", async () => {
    const b = await connect();
    expect(herdr.called("pane.copy_motion")).toHaveLength(0);

    b.setWatched(["term_a"]);
    await waitFor(() => herdr.called("pane.copy_motion").length >= 1);
    expect(herdr.called("pane.copy_motion")[0]?.params).toEqual({
      pane_id: "w1:p1",
      cursor: { row: 0, col: 0 },
      motion: "line_end",
    });

    events.length = 0;
    herdr.revision = 8;
    await waitFor(() => sessionIdsOf("screen-changed").includes("term_a"));

    // Steady state: no further screen-changed while the revision holds.
    events.length = 0;
    await new Promise((r) => setTimeout(r, 60));
    expect(types()).not.toContain("screen-changed");

    b.setWatched([]);
    const after = herdr.called("pane.copy_motion").length;
    await new Promise((r) => setTimeout(r, 60));
    expect(herdr.called("pane.copy_motion").length).toBe(after);
  });
});

describe("HerdrBackend reconnect (spec 8.13 socket-gone)", () => {
  it("clears sessions on EOF and re-subscribes + re-snapshots on the 2 s poll", async () => {
    const b = await connect();
    events.length = 0;
    herdr.dropStreams();
    await waitFor(() => types().includes("layout-changed"));
    expect(await b.listSessions()).toEqual([]);
    // `waitFor` takes a synchronous predicate (`test/fakes/wait.ts`), so watch the request log,
    // which is synchronous, and then assert the sessions once it has moved.
    await waitFor(() => herdr.called("session.snapshot").length >= 2, 3000);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["term_a", "term_b", "term_c"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.

- [ ] **Step 4: Implement the key table**

`apps/agent/src/backends/herdr/keys.ts`:

```ts
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

/**
 * Spec 8.13 "Input": Herdr validates every key name **before** writing any bytes, so a single
 * unknown name fails the whole `pane.send_keys` call. This table therefore contains only names
 * the research verified against Herdr's documented grammar. `delete`, `home`, `end`, `page-up`,
 * `page-down` and `ctrl-space` are deliberately absent — they are not in the documented grammar,
 * so they go out as their raw bytes through `pane.send_text`, which needs no key parsing at all.
 * Task 7's spike round-trips every name and Task 8 records the deltas here.
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
 * Reverse map: the exact byte string the agent hands `sendText` -> a Herdr key name. `\r` and
 * `\t` are excluded on purpose — they are literal PTY bytes that `pane.send_text` delivers
 * correctly, and mapping them would also collide with `ctrl-m`/`ctrl-i`, which share those bytes.
 */
const BYTES_TO_HERDR = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    if (bytes === "\r" || bytes === "\t") continue;
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
  INSTALL_HINT,
  type HerdrStream,
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
  SessionSnapshot,
  SessionSnapshotResult,
  TabCreatedResult,
} from "./types.js";

/** Herdr caps a single `pane.read` at 1000 lines (`line_limit = lines.min(1000)`). */
const MAX_READ_LINES = 1000;
/** Cap on events buffered during bootstrap, so a storm cannot grow without bound. */
const MAX_BUFFERED_EVENTS = 1000;

/**
 * The lifecycle subscriptions we always want, plus one `pane.agent_status_changed` entry per
 * known pane — that subscription is per-pane and Herdr has no incremental "add subscription"
 * method, so the pane set changing means opening a new stream (see `scheduleResubscribe`).
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
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.reordered" },
    { type: "layout.updated" },
  ];
  for (const paneId of paneIds) subs.push({ type: "pane.agent_status_changed", pane_id: paneId });
  return subs;
}

const AGENT_STATES = new Set<string>(["working", "blocked", "idle", "done", "unknown"]);

function agentStateOf(v: unknown): AgentState {
  return typeof v === "string" && AGENT_STATES.has(v) ? (v as AgentState) : "unknown";
}

/** Spec 8.13: `working` -> running, `idle`/`done` -> finished, `blocked` -> the new state. */
const SESSION_STATE: Record<AgentState, SessionInfo["state"]> = {
  working: "running",
  blocked: "blocked",
  idle: "finished",
  done: "finished",
  unknown: "unknown",
};

/**
 * `terminal_id` is the restart-stable handle; `pane_id` is positional and is reassigned by a
 * server restart or `pane.move`. Falling back to `pane_id` keeps a pane usable if `terminal_id`
 * is ever missing (see "Known unknowns for the spike").
 */
function nativeIdOf(pane: PaneInfo): string {
  return pane.terminal_id ?? pane.pane_id;
}

/** Spec 8.13: agent name, else pane title, else cwd basename, else "Pane". */
function titleOf(pane: PaneInfo): string {
  const cwd = pane.foreground_cwd ?? pane.cwd;
  const base = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  return (
    pane.display_agent ||
    pane.agent ||
    pane.title ||
    pane.terminal_title_stripped ||
    base ||
    "Pane"
  );
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function paneOf(v: unknown): PaneInfo | null {
  if (!v || typeof v !== "object") return null;
  const pane = v as PaneInfo;
  return typeof pane.pane_id === "string" ? pane : null;
}

interface Pane {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  title: string;
  cwd?: string;
  /** Layout rect width (cells). */
  cols: number;
  /** `scroll.viewport_rows`, else the layout rect height. This is what `getScreen` pads to. */
  rows: number;
  windowNumber: number;
  tabIndex: number;
  paneIndex: number;
  focused: boolean;
  agentStatus: AgentState;
  /** `scroll.max_offset_from_bottom` — rows of scrollback above the viewport. */
  scrollMax: number;
}

export interface HerdrBackendOptions {
  client: HerdrClient;
  log: Logger;
  /** Spec 8.13: poll for the socket every 2 s after the server goes away. */
  reconnectMs?: number;
  /** Spec 8.13: revision probe interval for watched panes. */
  revisionPollMs?: number;
  /** Debounce before rebuilding the stream after the pane set changes. */
  resubscribeMs?: number;
}

export class HerdrBackend implements TerminalBackend {
  readonly name = "herdr" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    // Herdr has no prompt/command lifecycle and no exit codes at all: the idle heuristic (8.8)
    // and `agent-state` carry the whole notification story.
    prompts: false,
    createSession: true,
    focus: true,
    history: true,
    // `pane.read` has no absolute line numbering, so the tracker must use `lineKey` overlap.
    absoluteLines: false,
  };

  private panes = new Map<string, Pane>();
  private byPaneId = new Map<string, string>();
  private order: string[] = [];
  private workspaces = new Set<string>();
  private focusedWorkspace: string | null = null;

  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly log: Logger;
  private readonly client: HerdrClient;

  private stream: HerdrStream | null = null;
  /** Bumped for every stream generation; late callbacks from an old stream are ignored. */
  private streamGen = 0;
  /** Non-null while bootstrapping: events land here and are replayed after the snapshot. */
  private buffer: HerdrEvent[] | null = null;
  private bootBusy = false;
  private bootDirty = false;
  private bootPromise: Promise<void> = Promise.resolve();

  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private resubTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  private watched = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private readonly probing = new Set<string>();

  constructor(private readonly opts: HerdrBackendOptions) {
    this.client = opts.client;
    this.log = opts.log.child({ backend: "herdr" });
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    this.closed = false;
    await this.client.ping(); // throws BackendUnavailable with an install/upgrade hint
    try {
      await this.bootstrap();
    } catch (err) {
      if (err instanceof BackendUnavailable) throw err;
      throw new BackendUnavailable(String(err), INSTALL_HINT);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.resubTimer) clearTimeout(this.resubTimer);
    this.resubTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.streamGen++;
    this.stream?.close();
    this.stream = null;
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.watched.clear();
    this.revisions.clear();
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
    const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
      pane_id: pane.paneId,
      source: "visible",
      format: "ansi",
    });
    return herdrScreen({
      text: res.read.text ?? "",
      rows: pane.rows,
      cols: pane.cols,
      scrollMax: pane.scrollMax,
    });
  }

  /**
   * Spec 8.13: best-effort, styled, bounded. `source:"recent"` returns the **last** N lines of
   * the buffer (screen included), N <= 1000. `before` is the phone's index of its top row, and
   * `scrollMax` is ours, so `depth` is how far above our own screen top the requested page ends.
   * There is no absolute line numbering here (`absoluteLines: false`), so a short page is how
   * the phone learns it has reached the top.
   */
  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const pane = this.pane(sessionId);
    const depth = Math.max(0, pane.scrollMax - before);
    const want = Math.min(MAX_READ_LINES, depth + count + pane.rows);
    let res: PaneReadResult;
    try {
      res = await this.call<PaneReadResult>(sessionId, "pane.read", {
        pane_id: pane.paneId,
        source: "recent",
        format: "ansi",
        lines: want,
      });
    } catch (err) {
      // A deep read of a busy recognised agent can be refused; that is not a session error.
      if (err instanceof HerdrError && err.code === "agent_not_idle") {
        this.log.debug("herdr refused a deep read while the agent is busy", { want });
        return { lines: [], oldestAvailable: 0 };
      }
      throw err;
    }
    const all = parseAnsiLines(res.read.text ?? "");
    const end = Math.max(0, all.length - depth - pane.rows);
    const start = Math.max(0, end - count);
    const lines = all.slice(start, end);
    const exhausted = all.length < want;
    const oldestAvailable = exhausted && start === 0 ? Math.max(0, before - lines.length) : 0;
    return { lines, oldestAvailable };
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const pane = this.pane(sessionId);
    const key = herdrKeyForBytes(text);
    if (key) {
      this.log.debug("herdr key", { key });
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: [key] });
      return;
    }
    // Never log the text itself (spec 8.10) — only its length.
    this.log.debug("herdr text", { len: text.length });
    await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text });
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const pane = this.pane(where.sessionId);
      // Shellbell "vertical" is a vertical divider -> the new pane sits to the right; Herdr's
      // "down" is a horizontal divider. Herdr has no left/up split.
      const res = await this.client.request<PaneInfoResult>("pane.split", {
        target_pane_id: pane.paneId,
        direction: where.direction === "vertical" ? "right" : "down",
        focus: false,
      });
      const created = paneOf(res.pane);
      if (!created) throw new Error("herdr pane.split returned no pane");
      const id = this.upsertPane(created);
      this.scheduleResubscribe();
      return id;
    }
    if (where.windowId !== undefined && !this.workspaces.has(where.windowId))
      throw new BadWindow(where.windowId);
    const workspaceId =
      where.windowId ?? this.focusedWorkspace ?? [...this.workspaces][0] ?? undefined;
    if (!workspaceId) throw new Error("herdr has no workspace to create a tab in");
    const res = await this.client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    const root = paneOf(res.root_pane);
    if (!root) throw new Error("herdr tab.create returned no root pane");
    const id = this.upsertPane(root);
    this.scheduleResubscribe();
    return id;
  }

  /** Spec 8.13: only ever from an explicit user action — this marks a `done` agent as seen. */
  async focus(sessionId: string): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.focus", { pane_id: pane.paneId });
  }

  /**
   * Spec 8.13: Herdr pushes nothing when a screen changes, so we probe `pane.copy_motion` — the
   * one side-effect-free call that returns the terminal's real content counter — but only for
   * panes a phone is actually viewing. `setWatched([])` stops the timer entirely.
   */
  setWatched(nativeIds: string[]): void {
    this.watched = new Set(nativeIds);
    for (const id of [...this.revisions.keys()]) if (!this.watched.has(id)) this.revisions.delete(id);
    if (this.watched.size === 0 || this.closed) {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      return;
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.pollRevisions(), this.opts.revisionPollMs ?? 200);
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

  private async call<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      if (err instanceof HerdrError && GONE_CODES.has(err.code)) {
        this.dropPane(sessionId);
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
      // The Agent overwrites this with `EventEngine.stateOf`, which the `agent-state` events
      // seeded at bootstrap keep in agreement with this value.
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

  private dropPane(sessionId: string): void {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    this.panes.delete(sessionId);
    this.byPaneId.delete(pane.paneId);
    this.order = this.order.filter((id) => id !== sessionId);
    this.watched.delete(sessionId);
    this.revisions.delete(sessionId);
  }

  // ---- bootstrap ----

  /** Coalescing single-flight wrapper: a request that arrives mid-run causes exactly one rerun. */
  private bootstrap(): Promise<void> {
    this.bootDirty = true;
    if (this.bootBusy) return this.bootPromise;
    this.bootBusy = true;
    this.bootPromise = this.drainBootstrap();
    return this.bootPromise;
  }

  private async drainBootstrap(): Promise<void> {
    try {
      while (this.bootDirty && !this.closed) {
        this.bootDirty = false;
        await this.runBootstrap();
      }
    } finally {
      // Never leave the lock held: a throw here would wedge every later refresh and reconnect.
      this.bootBusy = false;
    }
  }

  /**
   * Spec 8.13: subscribe -> buffer -> `session.snapshot` -> replay. The new stream is acked
   * before the previous one is closed, so a resubscribe never opens an event gap. The ack and
   * the first events can arrive in one chunk, which is why `buffer` is armed before subscribing.
   */
  private async runBootstrap(): Promise<void> {
    const gen = ++this.streamGen;
    this.buffer = [];
    const paneIds = [...this.byPaneId.keys()];
    const stream = await this.client.subscribe(herdrSubscriptions(paneIds), {
      onEvent: (e) => {
        if (gen === this.streamGen) this.onEvent(e);
      },
      onEnd: (reason) => {
        if (gen === this.streamGen) this.onStreamEnd(reason);
      },
    });
    if (this.closed) {
      stream.close();
      this.buffer = null;
      return;
    }
    const previous = this.stream;
    this.stream = stream;
    previous?.close();
    try {
      const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
      this.applySnapshot(res.snapshot ?? {});
    } catch (err) {
      this.buffer = null;
      throw err;
    }
    const buffered = this.buffer ?? [];
    this.buffer = null;
    for (const e of buffered) this.onEvent(e);
    this.emit({ type: "layout-changed" });
  }

  private scheduleResubscribe(): void {
    if (this.closed || this.resubTimer) return;
    this.resubTimer = setTimeout(() => {
      this.resubTimer = null;
      void this.bootstrap().catch((err) => {
        this.log.warn("herdr resubscribe failed", { error: errName(err) });
        this.onStreamEnd("resubscribe-failed");
      });
    }, this.opts.resubscribeMs ?? 250);
    this.resubTimer.unref?.();
  }

  /** Spec 8.13: the server exiting removes the socket file; poll for it every 2 s. */
  private onStreamEnd(reason: string): void {
    if (this.closed) return;
    this.log.info("herdr stream ended", { reason });
    this.streamGen++;
    this.stream = null;
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.revisions.clear();
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

  // ---- snapshot / events ----

  private applySnapshot(snap: SessionSnapshot): void {
    const workspaceNumbers = new Map<string, number>();
    this.workspaces = new Set<string>();
    for (const w of snap.workspaces ?? []) {
      this.workspaces.add(w.workspace_id);
      workspaceNumbers.set(w.workspace_id, w.number ?? 0);
    }
    this.focusedWorkspace = snap.focused_workspace_id ?? null;
    const tabNumbers = new Map<string, number>();
    for (const t of snap.tabs ?? []) tabNumbers.set(t.tab_id, t.number ?? 0);
    const rects = this.rectIndex(snap.layouts ?? []);

    const prev = this.panes;
    const next = new Map<string, Pane>();
    const byPaneId = new Map<string, string>();
    const changed: { id: string; state: AgentState }[] = [];
    for (const info of snap.panes ?? []) {
      const id = nativeIdOf(info);
      const rect = rects.get(info.pane_id);
      const state = agentStateOf(info.agent_status);
      next.set(id, {
        terminalId: id,
        paneId: info.pane_id,
        workspaceId: info.workspace_id,
        tabId: info.tab_id,
        title: titleOf(info),
        cwd: info.foreground_cwd ?? info.cwd,
        cols: rect?.cols ?? 80,
        rows: Math.max(1, info.scroll?.viewport_rows ?? rect?.rows ?? 24),
        windowNumber: workspaceNumbers.get(info.workspace_id) ?? 0,
        tabIndex: tabNumbers.get(info.tab_id) ?? 0,
        paneIndex: rect?.order ?? 0,
        focused: info.focused === true || info.pane_id === snap.focused_pane_id,
        agentStatus: state,
        scrollMax: info.scroll?.max_offset_from_bottom ?? 0,
      });
      byPaneId.set(info.pane_id, id);
      this.workspaces.add(info.workspace_id);
      if (prev.get(id)?.agentStatus !== state) changed.push({ id, state });
    }
    this.panes = next;
    this.byPaneId = byPaneId;
    this.sortOrder();
    for (const id of [...this.revisions.keys()]) if (!next.has(id)) this.revisions.delete(id);
    const at = Date.now();
    // Seeds the EventEngine. A pane seen for the first time has no previous state there, so a
    // pane that is already `blocked` at bootstrap sets the state without ringing (Task 5).
    for (const c of changed)
      this.emit({ type: "agent-state", sessionId: c.id, state: c.state, at });
  }

  private rectIndex(
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

  private upsertPane(info: PaneInfo): string {
    const id = nativeIdOf(info);
    const prev = this.panes.get(id);
    this.panes.set(id, {
      terminalId: id,
      paneId: info.pane_id,
      workspaceId: info.workspace_id,
      tabId: info.tab_id,
      title: titleOf(info),
      cwd: info.foreground_cwd ?? info.cwd ?? prev?.cwd,
      cols: prev?.cols ?? 80,
      rows: Math.max(1, info.scroll?.viewport_rows ?? prev?.rows ?? 24),
      windowNumber: prev?.windowNumber ?? 0,
      tabIndex: prev?.tabIndex ?? 0,
      paneIndex: prev?.paneIndex ?? 0,
      focused: info.focused === true,
      agentStatus: agentStateOf(info.agent_status),
      scrollMax: info.scroll?.max_offset_from_bottom ?? prev?.scrollMax ?? 0,
    });
    this.byPaneId.set(info.pane_id, id);
    this.workspaces.add(info.workspace_id);
    this.sortOrder();
    return id;
  }

  private onEvent(e: HerdrEvent): void {
    if (this.buffer) {
      if (this.buffer.length < MAX_BUFFERED_EVENTS) this.buffer.push(e);
      return;
    }
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
      case "pane_created": {
        const pane = paneOf(data.pane);
        if (!pane) return;
        const id = this.upsertPane(pane);
        this.emit({ type: "session-added", sessionId: id });
        this.emit({ type: "layout-changed" });
        this.scheduleResubscribe();
        return;
      }
      case "pane_closed":
      case "pane_exited": {
        const paneId = str(data.pane_id);
        const id = paneId ? this.byPaneId.get(paneId) : undefined;
        if (!id) return;
        this.dropPane(id);
        this.emit({ type: "session-removed", sessionId: id });
        this.emit({ type: "layout-changed" });
        this.scheduleResubscribe();
        return;
      }
      case "pane_updated": {
        const pane = paneOf(data.pane);
        if (!pane) return;
        const id = nativeIdOf(pane);
        const before = this.panes.get(id)?.title;
        this.upsertPane(pane);
        if (this.panes.get(id)?.title !== before) this.emit({ type: "title-changed", sessionId: id });
        return;
      }
      case "pane_agent_detected": {
        const paneId = str(data.pane_id);
        const id = paneId ? this.byPaneId.get(paneId) : undefined;
        const pane = id ? this.panes.get(id) : undefined;
        const agent = str(data.agent);
        if (!id || !pane || !agent) return;
        pane.title = agent;
        this.emit({ type: "title-changed", sessionId: id });
        return;
      }
      case "pane_agent_status_changed": {
        const paneId = str(data.pane_id);
        const id = paneId ? this.byPaneId.get(paneId) : undefined;
        const pane = id ? this.panes.get(id) : undefined;
        if (!id || !pane) return;
        const state = agentStateOf(data.agent_status);
        if (pane.agentStatus === state) return;
        pane.agentStatus = state;
        this.emit({
          type: "agent-state",
          sessionId: id,
          state,
          agent: str(data.agent) ?? str(data.display_agent),
          at: Date.now(),
        });
        return;
      }
      case "pane_moved": {
        // Pane ids are reassigned here; the debounced re-bootstrap re-snapshots the truth.
        const previous = str(data.previous_pane_id);
        if (previous) this.byPaneId.delete(previous);
        const pane = paneOf(data.pane);
        if (pane) this.upsertPane(pane);
        this.emit({ type: "layout-changed" });
        this.scheduleResubscribe();
        return;
      }
      case "pane_focused": {
        const paneId = str(data.pane_id);
        const id = paneId ? this.byPaneId.get(paneId) : undefined;
        for (const p of this.panes.values()) p.focused = p.terminalId === id;
        this.emit({ type: "focus-changed" });
        return;
      }
      case "tab_focused":
      case "workspace_focused":
        this.emit({ type: "focus-changed" });
        return;
      case "layout_updated": {
        const layout = data.layout as PaneLayoutSnapshot | undefined;
        if (layout) {
          for (const [paneId, rect] of this.rectIndex([layout])) {
            const id = this.byPaneId.get(paneId);
            const pane = id ? this.panes.get(id) : undefined;
            if (!pane) continue;
            pane.cols = rect.cols;
            pane.paneIndex = rect.order;
          }
          this.sortOrder();
        }
        this.emit({ type: "layout-changed" });
        return;
      }
      case "tab_created":
      case "tab_closed":
      case "tab_renamed":
      case "tab_moved":
      case "workspace_created":
      case "workspace_closed":
      case "workspace_renamed":
      case "workspace_moved":
      case "workspace_reordered":
        this.emit({ type: "layout-changed" });
        return;
      default:
        this.log.debug("unhandled herdr event", { event: e.event });
        return;
    }
  }

  // ---- revision poller ----

  private pollRevisions(): void {
    for (const id of this.watched) {
      if (this.probing.has(id)) continue;
      const pane = this.panes.get(id);
      if (!pane) continue;
      this.probing.add(id);
      void this.client
        .request<CopyMotionResult>("pane.copy_motion", {
          pane_id: pane.paneId,
          cursor: { row: 0, col: 0 },
          motion: "line_end",
        })
        .then((res) => {
          const rev = typeof res.content_revision === "number" ? res.content_revision : 0;
          if (this.revisions.get(id) === rev) return;
          // An odd revision means a write is in flight; emit, but do not record it, so the
          // settled even value still counts as a change on the next probe.
          if (rev % 2 === 0) this.revisions.set(id, rev);
          this.emit({ type: "screen-changed", sessionId: id });
        })
        .catch((err) => {
          this.log.debug("herdr revision probe failed", { error: errName(err) });
        })
        .finally(() => {
          this.probing.delete(id);
        });
    }
  }
}
```

- [ ] **Step 6: Run the tests**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck
pnpm lint:fix && pnpm lint
```
Expected: green. If the reconnect test flakes, raise its `waitFor` budget — never raise
`reconnectMs`, which is the behaviour under test.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): HerdrBackend — sessions, screens, input, events, revision poller"
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
| `* → blocked` when this session was never seen before (`prev === null`) | `kind: "blocked"` | **no** — a pane already blocked when the agent starts, or when the herdr socket reconnects, must not ring for history |
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
          // `prev === null` means we have never seen this session before (agent start, or a herdr
          // reconnect that rebuilt the pane map). Adopt the state, but do not ring for history.
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

- [ ] **Step 4: Implement the `Agent` hook**

`apps/agent/src/agent.ts`, in `onBackendEvent`'s switch, add `agent-state` to the group that
re-broadcasts `sessions`:

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

- [ ] **Step 5: Run the tests** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`, then
`perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell typecheck`, then `pnpm lint:fix && pnpm lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): ring on herdr agent state (blocked and prompt)"
```

---

### Task 6: Wire it up — registry, tracker, detection and doctor (spec 8.12, 8.13, 8.6)

**Files:**
- Modify: `apps/agent/src/backends/registry.ts`, `apps/agent/src/screen-tracker.ts`
- Modify: `apps/agent/test/fakes/fake-backend.ts`, `apps/agent/test/registry.test.ts`, `apps/agent/test/screen-tracker.test.ts`
- Create: `apps/agent/src/backends/herdr/start.ts`, `apps/agent/test/herdr-start.test.ts`
- Modify: `apps/agent/src/cli.ts`, `apps/agent/src/doctor.ts` (see the note below)
- Modify: `README.md`, `docs/self-hosting.md`

**Note on `cli.ts` / `doctor.ts`:** Plan 03 Task 11 landed while this plan was being written
(commit `6bb2a53`, "feat(agent): control socket, CLI, LaunchAgent, doctor, tsdown build"), so both
files now exist and Step 6 wires into them with real code. The detection loop and the doctor check
still live in a **self-contained, tested module** (`backends/herdr/start.ts`) that does not import
the CLI, so Task 6 is testable on its own and Step 6 is a two-line integration. `checkHerdr` returns
the same shape as `doctor.ts`'s `Check` (`{ name, ok, detail, fix? }`) so it can be pushed straight
into that list. **If `cli.ts` or `doctor.ts` has moved on since `6bb2a53`, adapt the call sites in
Step 6 rather than reverting anything — the two calls are what matters, not their exact lines.**

**Interfaces:**
- `registry.ts`: `splitId` accepts any `BackendName` (via the schema, not a hard-coded pair);
  `listSessions` iterates `BACKEND_ORDER = ["iterm2", "tmux", "herdr"]`; new
  `BackendRegistry.setWatched(ids: string[]): void`.
- `screen-tracker.ts`: pushes the watched set through `backend.setWatched?.()` on every viewer
  change (and `[]` on `stop()`), de-duplicated so an unchanged set is never re-sent.
- `start.ts`: `interface HerdrCheck { name: string; ok: boolean; detail: string; fix?: string }`
  (structurally identical to `doctor.ts`'s `Check`), `checkHerdr(opts?): Promise<HerdrCheck>`,
  `startHerdrBackend(opts): { stop(): void }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent/test/fakes/fake-backend.ts` — a field next to `sentText`:

```ts
  /** Every `setWatched` call the tracker or registry made, in order (spec 8.13). */
  watched: string[][] = [];
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

    reg.setWatched(["herdr:term_a", "iterm2:A", "bogus"]);
    expect(herdr.watched.at(-1)).toEqual(["term_a"]);
    expect(iterm.watched.at(-1)).toEqual(["A"]);
    // A backend with no watchers still gets a call -- that is how it learns to stop polling.
    reg.setWatched([]);
    expect(herdr.watched.at(-1)).toEqual([]);
    expect(iterm.watched.at(-1)).toEqual([]);
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
  snapshot: { workspaces: [], tabs: [], panes: [], layouts: [] },
});

describe("checkHerdr", () => {
  it("reports the version and protocol when herdr answers", async () => {
    server = new FakeHerdr();
    await server.start();
    expect(await checkHerdr({ log, socketPath: server.path })).toEqual({
      name: "herdr",
      ok: true,
      detail: "v0.8.2 protocol 22",
    });
  });

  it("reports the install fix when the socket is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-doctor-"));
    const check = await checkHerdr({ log, socketPath: join(dir, "herdr.sock") });
    expect(check.ok).toBe(false);
    expect(check.fix).toMatch(/curl -fsSL https:\/\/herdr\.dev\/install\.sh/);
  });
});

describe("startHerdrBackend", () => {
  it("keeps retrying while herdr is absent, then registers the backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-herdr-start-"));
    const socketPath = join(dir, "herdr.sock");
    const registry = new BackendRegistry(log);
    handle = startHerdrBackend({
      registry,
      log,
      socketPath,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, revisionPollMs: 60_000, resubscribeMs: 60_000 },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.connected()).toEqual([]);

    server = new FakeHerdr(socketPath);
    server.reply("session.snapshot", emptySnapshot);
    await server.start();
    await waitFor(() => registry.connected().some((b) => b.name === "herdr"), 3000);
    expect(registry.connected().find((b) => b.name === "herdr")?.capabilities.prompts).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail** — `perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test`.

- [ ] **Step 3: Implement the registry changes**

`apps/agent/src/backends/registry.ts` — import the schema (it is a value, not just a type) and
replace `splitId`:

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

Replace `listSessions` with an order-driven version (the tmux de-dup rule is unchanged and still
applies only to tmux; spec 8.13 says herdr needs no de-dup):

```ts
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
   * Every member is called on every change, including with an empty array -- that is how a
   * backend learns that its last viewer went away and it can stop polling.
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

- [ ] **Step 4: Implement the tracker change**

`apps/agent/src/screen-tracker.ts` — add a field next to `stopped`:

```ts
  /** Last watched set pushed to the backend, joined; guards against re-sending an equal set. */
  private watchedKey = "";
```

rewrite `setViewed` so both branches end in one push:

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

plus the new private method, next to `state`:

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

- [ ] **Step 5: Implement detection and the doctor check**

`apps/agent/src/backends/herdr/start.ts`:

```ts
import { createLogger, type Logger } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
import { BackendUnavailable } from "../types.js";
import { HerdrBackend, type HerdrBackendOptions } from "./backend.js";
import { HerdrClient, INSTALL_HINT } from "./client.js";

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
 * Spec 8.13: `doctor` reports Herdr's version and protocol, or the install/upgrade hint. The
 * caller prints it as `herdr: v0.8.2 protocol 22`.
 */
export async function checkHerdr(opts: CheckHerdrOptions = {}): Promise<HerdrCheck> {
  const log = opts.log ?? createLogger({ stdout: false });
  const client =
    opts.client ?? new HerdrClient({ log, socketPath: opts.socketPath, requestTimeoutMs: 3000 });
  try {
    const pong = await client.ping();
    return {
      name: "herdr",
      ok: true,
      detail: `v${pong.version ?? "?"} protocol ${pong.protocol ?? "?"}`,
    };
  } catch (err) {
    if (err instanceof BackendUnavailable)
      return { name: "herdr", ok: false, detail: err.message, fix: err.hint };
    return { name: "herdr", ok: false, detail: String(err), fix: INSTALL_HINT };
  }
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
 * Spec 8.12/8.13: try Herdr at startup and every 10 s while it is not running, and register the
 * backend with the registry once it connects. Herdr not being installed is a perfectly normal
 * state, so failures are logged at debug, never as errors, and never block the agent.
 */
export function startHerdrBackend(opts: StartHerdrOptions): { stop(): void } {
  const log = opts.log.child({ unit: "herdr-start" });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let current: HerdrBackend | null = null;

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? 10_000);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    const client = opts.client ?? new HerdrClient({ log: opts.log, socketPath: opts.socketPath });
    const backend = new HerdrBackend({ client, log: opts.log, ...opts.backendOptions });
    try {
      await backend.connect();
    } catch (err) {
      await backend.close();
      log.debug("herdr not available", {
        error: err instanceof Error ? err.message : String(err),
      });
      schedule();
      return;
    }
    if (stopped) {
      await backend.close();
      return;
    }
    current = backend;
    opts.registry.add(backend);
    log.info("herdr connected");
    if (opts.onConnected) {
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
      const backend = current;
      current = null;
      void backend?.close();
    },
  };
}
```

- [ ] **Step 6: Wire into the CLI and the doctor**

First run `ls apps/agent/src/cli.ts apps/agent/src/doctor.ts`. Both exist as of commit `6bb2a53`.
(If one is missing, record "absent — `startHerdrBackend`/`checkHerdr` shipped standalone" and go to
Step 7; everything in Task 6 still works, the agent just never starts the backend.)

`apps/agent/src/cli.ts` — add the import next to the iTerm2 ones:

```ts
import { startHerdrBackend } from "./backends/herdr/start.js";
```

and, in `buildAgent`, immediately after the `void firstConnect();` line:

```ts
  // spec 8.12/8.13: herdr is optional and usually absent, so this never blocks startup and never
  // prints an error -- it retries every 10 s and announces itself if and when it connects. Its
  // timers are unref'd, so an un-stopped detector can never hold the process open.
  startHerdrBackend({
    registry,
    log,
    onConnected: (n) =>
      console.log(`  herdr      connected · ${n} pane${n === 1 ? "" : "s"}`),
  });
```

In the `start` command's banner, add a herdr line next to the tmux one:

```ts
    console.log("  tmux       not running"); // Plan 04 adds the tmux backend.
    console.log("  herdr      detecting…"); // replaced in place by startHerdrBackend's onConnected
```

`apps/agent/src/doctor.ts` — add the import:

```ts
import { checkHerdr } from "./backends/herdr/start.js";
```

and push the check in `runDoctor`, right after the tmux `try/catch` block:

```ts
  // spec 8.13: report herdr's version and protocol, or the install/upgrade hint. `checkHerdr`
  // already returns this module's `Check` shape.
  out.push(await checkHerdr());
```

`doctor` then prints a `herdr` line — `v0.8.2 protocol 22`, or the failure with its fix. Herdr being
absent is a normal, non-fatal check result, exactly like the tmux one.

- [ ] **Step 7: Documentation**

`README.md` — replace the description paragraph with:

```md
Shellbell mirrors your Mac's terminal sessions (iTerm2 natively, everything else via tmux, and
coding-agent panes via [Herdr](https://herdr.dev)) to your phone, pings you when a command
finishes, when a program goes quiet, or when an agent is blocked waiting on you, and lets you
reply — from anywhere, end-to-end encrypted, no accounts.
```

`docs/self-hosting.md` — add one paragraph after the numbered list:

```md
Shellbell also works with [Herdr](https://herdr.dev) 0.7.2 or newer: if a Herdr server is running
for your user, the agent finds its socket (`$HERDR_SOCKET_PATH`, else
`$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`) and mirrors its panes
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
Expected: green everywhere, including the shipped iTerm2, tracker, registry and relay suites.

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

**This task is where the plan meets a real Herdr install. Steps 1–2 are implementer steps (write
the script, typecheck it). Step 3 is Human-run only and is the only place Herdr is ever installed
or started.**

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
 * Read-only by default. Set HERDR_SPIKE_KEYS=1 to also probe `pane.send_keys` — that TYPES INTO
 * A REAL PANE, so only do it against a scratch pane you created for the spike.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";
import { HerdrClient, herdrSocketPath } from "../src/backends/herdr/client.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: true, verbose: true });
const client = new HerdrClient({ log, requestTimeoutMs: 5000 });
const outDir = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(outDir, { recursive: true });

/** Replace this machine's identity before anything is written to disk. */
function sanitize<T>(value: T): T {
  const home = homedir();
  const user = userInfo().username;
  const text = JSON.stringify(value)
    .split(home)
    .join("/Users/dev")
    .split(user)
    .join("dev");
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
  console.log(`${label}: p50 ${p50.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms (n=${n})`);
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
  console.log("socket:", path);

  const pong = await timed("ping", 5, () => client.request("ping", {}));
  save("herdr-ping.json", { id: "sb1", result: pong });

  const snapshot = await timed("session.snapshot", 5, () =>
    client.request<{ snapshot: Record<string, unknown> }>("session.snapshot", {}),
  );
  save("herdr-session-snapshot.json", { id: "sb2", result: snapshot });

  const panes = (snapshot.snapshot.panes ?? []) as { pane_id: string; terminal_id?: string }[];
  console.log("panes:", panes.map((p) => `${p.pane_id}/${p.terminal_id ?? "NO terminal_id"}`));
  const paneId = panes[0]?.pane_id;
  if (!paneId) throw new Error("no panes: open one in herdr first");

  const visible = await timed("pane.read visible ansi", 20, () =>
    client.request("pane.read", { pane_id: paneId, source: "visible", format: "ansi" }),
  );
  save("herdr-pane-read-visible.json", { id: "sb7", result: visible });
  const text = (visible as { read: { text?: string } }).read.text ?? "";
  const escapes = [...text.matchAll(/\[[0-9;?]*([A-Za-z])/g)].map((m) => m[1]);
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

  const two = await twoRequestsOnOneConnection(path);
  console.log("responses to two pipelined requests (expect 1):", two.length);

  if (process.env.HERDR_SPIKE_KEYS === "1") {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
      const herdrName = name
        .replace(/^ctrl-/, "ctrl+")
        .replace(/^shift-tab$/, "shift+tab")
        .replace(/^page-/, "page")
        .replace(/^ctrl\+space$/, "ctrl+space");
      try {
        await client.request("pane.send_keys", { pane_id: paneId, keys: [herdrName] });
        accepted.push(`${name} -> ${herdrName}`);
      } catch (err) {
        rejected.push(`${name} -> ${herdrName}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log("keys accepted:\n  " + accepted.join("\n  "));
    console.log("keys rejected:\n  " + rejected.join("\n  "));
  }

  console.log("subscribing for 30 s — go make an agent ask you something…");
  const seen: unknown[] = [];
  const stream = await client.subscribe(
    [
      { type: "pane.created" },
      { type: "pane.closed" },
      { type: "pane.updated" },
      { type: "pane.focused" },
      { type: "layout.updated" },
      ...panes.map((p) => ({ type: "pane.agent_status_changed", pane_id: p.pane_id })),
    ],
    {
      onEvent: (e) => {
        console.log("EVENT", e.event, JSON.stringify(e.data).slice(0, 160));
        seen.push(e);
        if (e.event.includes("agent_status_changed"))
          save("herdr-agent-status-event.json", { event: e.event, data: e.data });
      },
      onEnd: (reason) => console.log("stream ended:", reason),
    },
  );
  await new Promise((r) => setTimeout(r, 30_000));
  stream.close();
  console.log(`captured ${seen.length} events`);
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
curl -fsSL https://herdr.dev/install.sh | sh     # or: brew install herdr, if that is how they ship
herdr --version && herdr status
herdr                                            # start it, open two panes, run a coding agent in one
pnpm -F shellbell spike:herdr                    # read-only capture, ~40 s
# optional, in a throwaway pane only:
HERDR_SPIKE_KEYS=1 pnpm -F shellbell spike:herdr
```

While the 30 s subscription window is open, make the agent ask a question (so it goes `blocked`)
and then answer it (so it goes `idle`/`done`), and drag a pane divider (so `layout.updated` fires).

Then write `docs/spike-herdr.md` in the style of `docs/spike-tmux.md`, answering, with evidence:

1. Socket path actually used, its mode (`stat -f '%Sp' …`), and whether a `-client.sock` sibling exists.
2. `ping`: version, protocol, capabilities. Is protocol ≥ 22?
3. One request per connection: how many responses came back for two pipelined requests?
4. Latencies: `ping`, `session.snapshot`, `pane.read visible ansi` (80×24 and a large pane),
   `pane.read recent 200`, `pane.copy_motion` — p50 and max. **Is `copy_motion` cheap enough for a
   200 ms poll on 1, 5 and 20 panes?**
5. `pane.read {source:"visible",format:"ansi"}`: which CSI finals appear (must be only `m` for
   `parseSgrLine` to be sufficient)? Are rows padded to `cols` or trimmed? Does the row count equal
   `viewport_rows`? How are 256-colour and truecolor encoded? What do CJK/emoji do to the cell count?
6. Does every pane in `session.snapshot` carry a `terminal_id`?
7. `layout.updated`: exact field names of the rect (`panes[].rect.{x,y,width,height}`?), whether
   they are **cells**, and whether dragging a divider fires it (compare against `stty size` inside
   the pane).
8. `content_revision` from `pane.copy_motion`: does it advance with output and hold still when
   idle? Does it work without focus? Are odd values observed mid-write?
9. Agent state: measured latency from the agent visibly blocking to the event line landing, and for
   working→idle. Which envelope did it use — dotted or snake_case? Did it carry `agent`?
10. Keys (only if `HERDR_SPIKE_KEYS=1` was run): the accepted/rejected list, verbatim.
11. Server restart: with a subscription open, run `herdr server stop`. Does the socket file
    disappear? Does the connection EOF? Do `pane_id`s change but `terminal_id`s survive?
12. Sanitization: confirm every captured fixture was reviewed for home paths, usernames, hostnames,
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
  `backend.ts` the captured data proves wrong
- Modify: this plan file (append a "Post-spike errata" section)

- [ ] **Step 1: Swap the fixtures in, keeping every filename**

The spike script already wrote them to `apps/agent/test/fixtures/` with exactly the names the tests
import, so this is usually just `git status` plus a review that each file is sanitized.

- [ ] **Step 2: Re-run the tests and fix the expectations, not the production code, where the
      difference is only data**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell test
```

Expected failures and what each one means:

| Failing assertion | Meaning | Fix |
|---|---|---|
| `herdr-convert` line text/run expectations | The real screen has different content | Update the expected strings; keep at least one styled run, one wide-cell row and one padded row |
| `fakeCursor` x/y | Real trailing content differs | Update the numbers; if the last non-blank row is *not* what a user would call the cursor row, note it as a spec question, do not change the rule |
| `getScreen` `rows`/`cols` | The rect is not in cells, or `viewport_rows` disagrees with the rect height | Fix `applySnapshot`, and record it as errata — this is spike item 7 |
| `listSessions` ids | Some pane had no `terminal_id` | Keep the `pane_id` fallback and record it as errata — this is spike item 6 |
| `pane_agent_status_changed` not handled | The event envelope differs from the research | Fix the `handleEvent` case and record it |
| A key was rejected by the real server | `HERDR_KEYS` is wrong | Remove that entry (it falls back to `pane.send_text` raw bytes) or correct the spelling, and update the keys test |

If the CSI finals in the captured ANSI include anything other than `m`, **stop**: `parseSgrLine` is
not sufficient and the plan needs a controller decision (the fallback is spec 8.13's deferred
`herdr terminal session observe` path, which is out of scope here).

- [ ] **Step 3: Append the errata to this plan**

Add a `## Post-spike errata (<date>)` section at the end of this file, in the style of Plan 03's
"Pre-execution corrections": one bullet per delta, each saying what the plan assumed, what the
spike measured, and what changed in the code or the tests. If nothing changed, say so explicitly
and list the assumptions the spike confirmed.

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

`apps/agent/test/live-herdr.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import type { BackendEvent } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

describe.skipIf(!process.env.SHELLBELL_LIVE)("live herdr", () => {
  it("lists panes, reads a styled screen, sends text and sees the change", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const client = new HerdrClient({ log });
    const b = new HerdrBackend({ client, log });
    await b.connect();

    const sessions = await b.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const s = sessions[0] as (typeof sessions)[number];
    expect(s.backend).toBe("herdr");

    const before = await b.getScreen(s.id);
    expect(before.rows).toBe(s.rows);
    expect(before.lines).toHaveLength(s.rows);

    const events: BackendEvent[] = [];
    b.on((e) => events.push(e));
    // The revision poller only runs for watched panes (spec 8.13), so ask for this one.
    b.setWatched([s.id]);
    await b.sendText(s.id, "echo shellbell-herdr-live-ok\r");
    await new Promise((r) => setTimeout(r, 2000));

    expect(
      events.some((e) => e.type === "screen-changed" && e.sessionId === s.id),
    ).toBe(true);
    const after = await b.getScreen(s.id);
    const text = after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text).toContain("shellbell-herdr-live-ok");

    await b.close();
  }, 30_000);
});
```

- [ ] **Step 2: Run it once for real — Human-run only**

**Implementers skip this step and report it as "not run (human-run only)".** The test needs a real
Herdr server (which this plan never installs) and it **types into the operator's first live Herdr
pane**, which may be a running coding agent rather than a shell.

A human runs, with a scratch pane focused first in Herdr:

```bash
SHELLBELL_LIVE=1 perl -e 'alarm 300; exec @ARGV' -- pnpm -F shellbell vitest run test/live-herdr.test.ts
```
Expected: PASS, and `shellbell-herdr-live-ok` visible in that pane. Without `SHELLBELL_LIVE` the
suite is skipped, so `pnpm test` in CI is unaffected.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/test/live-herdr.test.ts
git commit -m "test(agent): env-gated live herdr integration"
```

---

## Plan self-review

**Spec coverage (§8.13 sentence by sentence):**

| Spec 8.13 requirement | Where |
|---|---|
| `BackendName` gains `"herdr"` | Task 1 |
| Socket discovery `$HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME` → `~/.config` | Task 2 (`herdrSocketPath` + test) |
| NDJSON, one request per connection, 5 s timeout | Task 2 (`HerdrClient.request`; the fake server enforces it and `ignoredLines` proves it) |
| Long-lived `events.subscribe` with `subscription_started` ack, bare event lines, no replay | Task 2 (`subscribe`) |
| `ping`, protocol ≥ 22, `BackendUnavailable` + hint | Task 2 (`ping`), Task 6 (`checkHerdr`) |
| Server restart ⇒ EOF ⇒ poll every 2 s, re-subscribe, re-snapshot | Task 4 (`onStreamEnd`/`scheduleReconnect` + reconnect test) |
| One pane = one session; native id = `terminal_id`; `terminal_id ↔ pane_id` map | Task 4 (`applySnapshot`, `byPaneId`, `nativeIdOf`) |
| Title = agent, else title, else cwd basename, else "Pane"; cwd; no `tmuxWindowId` | Task 4 (`titleOf`, `toInfo`) |
| Bootstrap = subscribe → buffer → snapshot → replay | Task 4 (`runBootstrap`) |
| `getScreen` = `pane.read visible ansi` → `parseSgrLine`; rows = `viewport_rows`; cols = rect width; pad/truncate | Task 3 (`herdrScreen`) + Task 4 |
| No cursor ⇒ end of last non-blank line | Task 3 (`fakeCursor`) |
| `scrollbackTotal = max_offset_from_bottom + viewport_rows`; `absoluteLines: false` | Task 3, Task 4 (capabilities) |
| `history` = `pane.read recent`, ≤ 1000 lines, styled, best-effort | Task 4 (`getHistory` + the two paging tests) |
| Revision poller: only viewed panes, 200 ms, `pane.copy_motion`, emit `screen-changed` | Task 4 (`setWatched`, `pollRevisions`), Task 6 (tracker → registry → backend) |
| `agent-state` backend event from `pane.agent_status_changed` | Task 4 |
| `blocked` → immediate ring, once per transition, 60 s limit | Task 5 (+ the shipped `Notifier` limit) |
| working → idle\|done ≥ `notifyMinCommandMs` → `prompt` ring with `durationMs`, no `exitCode` | Task 5 |
| `SessionInfo.state` mapping incl. new `blocked` | Task 1 (schema), Task 4 (`SESSION_STATE`), Task 5 (`stateOf`) |
| `EventKind` += `blocked`; `notify.kind` += `blocked`; push body "An agent is waiting for you" | Task 1 |
| `capabilities.prompts = false`; idle heuristic still applies | Task 4 (capabilities), Task 5 (unchanged 8.8 path) |
| `pane.focus` marks a `done` agent seen — accepted, never called from mirroring | Task 4 (`focus` only, documented) |
| Input: `pane.send_text`, named keys via `pane.send_keys`, unmapped keys as raw bytes, never log text | Task 4 (`keys.ts`, `sendText`) |
| Create: `tab.create {workspace_id, focus:false}`; `pane.split {right\|down}`; left/up unsupported | Task 4 (`createSession` + split-direction test) |
| Not running/not installed → `BackendUnavailable` + install hint; `doctor` reports version+protocol | Task 2, Task 6 |
| Herdr + iTerm2 coexist, no de-dup | Task 6 (`BACKEND_ORDER`, de-dup still tmux-only) |
| Licensing: nothing vendored, "works with Herdr" | Global Constraints, Task 6 docs |
| Deferred: `terminal session observe` + VT emulator | Explicitly out of scope (Known unknowns, item 9) |

**Type consistency:**

- `AgentState` is declared **once**, in `apps/agent/src/backends/types.ts` (Task 2), and re-exported
  by `herdr/types.ts` as `AgentStatus`. `BackendEvent["agent-state"].state`, `EventEngine`'s
  `agentState`, `Pane.agentStatus`, `SESSION_STATE` and `agentStateOf` all use that one type.
- `Screen` is the shipped one from `backends/types.ts`; `convert.ts` imports it and never redefines
  it (same rule Plan 03 fixed for iTerm2).
- `Ring.kind` (`events.ts`) ⊇ ctrl `notify.kind` (Task 1) ⊇ `pushBody`'s parameter — a `blocked`
  ring typechecks end to end without a cast.
- `HerdrClient.request<T>` is the only call path; `HerdrBackend.call<T>` wraps it solely to map
  `GONE_CODES` onto `SessionGone`. `HerdrStream`/`HerdrStreamHandlers` are declared once in
  `client.ts` and used by `backend.ts`.
- `setWatched` has the same signature in `TerminalBackend`, `BackendRegistry`, `HerdrBackend` and
  `FakeBackend`: `(nativeIds: string[]) => void`, always the full set.
- Fixture names are identical in Task 3, Task 4, Task 7 (writer) and Task 8 (swap).
- `waitFor` is the shipped `test/fakes/wait.ts` helper — a synchronous predicate; no test in this
  plan passes it an `async` function.

**Placeholder scan:** none. Every file listed in "File structure" has complete code in a task; no
step says "similar to" or "…". The only values this plan cannot know are the ones Task 7 measures,
and they live in fixtures (replaceable data) plus the explicitly-listed spike questions — never in
the production code paths, which have documented fallbacks (`terminal_id` → `pane_id`, unmapped key
→ raw bytes, missing rect → `viewport_rows` → 80×24).

**Test coverage against spec §15:** transport (one connection per request, timeout, EOF, version
refusal), conversion against a committed fixture, backend mapping table (every subscribed event),
history range arithmetic, key table, the revision poller starting and stopping with viewers,
reconnect, registry id routing and `setWatched` fan-out, tracker → backend watched set, the ring
rules with a fake clock, relay push copy, and one env-gated live test.

---

## Known unknowns for the spike

These are the questions the research could **not** settle from source and docs alone. Each one has a
documented fallback in the code, so the plan is executable before the spike; Task 8 replaces the
guess with the measurement.

1. **`layout.updated` rect fields and units.** The research reads `PaneLayoutSnapshot.panes[].rect`
   as `{x, y, width, height}` in **cells**, and this plan uses `width` as `cols` and sorts panes by
   `y` then `x`. Unverified: the exact field names on the *event* payload (vs the snapshot), whether
   the units are cells or pixels, and whether dragging a divider emits the event at all. *Fallback:*
   `rows` prefers `scroll.viewport_rows` (which is definitely rows), and a missing rect yields
   80×24. *If it is pixels,* `cols` must come from somewhere else entirely — record it as errata and
   ask the controller.
2. **`pane.copy_motion` cost.** Assumed cheap enough to poll at 200 ms per watched pane. Unverified:
   its actual latency, whether it can be refused without focus, whether `content_revision` really
   advances with output and holds still when idle, and how often odd (mid-write) values appear.
   *Fallback:* the poller is single-flight per pane, only runs for watched panes, and its interval is
   an option; if it is expensive, raise `revisionPollMs` or fall back to diffing `pane.read` text.
3. **`pane.read` ANSI line splitting on wrapped lines.** This plan treats one `\n`-separated row as
   one `Line` and never sets `Line.w`, because Herdr exposes no per-row soft-wrap flag. Unverified:
   whether a soft-wrapped terminal row arrives as one long line or as two, and whether the row count
   equals `viewport_rows`. *Fallback:* `fitLines` pads/truncates to `rows`, so the screen is always
   the right shape even if the split disagrees; the visible symptom would be a wrapped line
   appearing on one row.
4. **Is `terminal_id` present on every pane in `session.snapshot`?** The schema lists it as required
   on `PaneInfo`, but nothing in the plan can prove it for a pane with no agent. *Fallback:*
   `nativeIdOf` falls back to `pane_id`, which costs id stability across a server restart but never
   hides a pane. Spike item 6.
5. **Named keys.** `delete`, `home`, `end`, `page-up`, `page-down` and `ctrl-space` are **not** in
   Herdr's documented grammar, so `HERDR_KEYS` omits them and they go out as raw bytes. Unverified:
   whether Herdr accepts them anyway, and whether `ctrl+space` and `shift+tab` are spelled that way.
   Spike item 10 (only under `HERDR_SPIKE_KEYS=1`, in a scratch pane).
6. **CSI finals in ANSI reads.** Assumed to be SGR (`m`) only, which is what makes `parseSgrLine`
   sufficient. If CUP/erase sequences appear, this backend needs a VT emulator and the plan needs a
   controller decision (Task 8 Step 2 says stop).
7. **Agent-state latency and envelope.** Assumed ~0.2–0.9 s (3 confirmations at 100 ms, capped at
   700 ms, plus the 100 ms subscription poll) and a dotted `pane.agent_status_changed` event name.
   The handler normalises dots to underscores, so either envelope works; the latency only matters
   for how fast the phone rings.
8. **Named Herdr sessions.** `HERDR_SESSION` / `--session` produce independent sockets under
   `~/.config/herdr/sessions/<name>/`. This plan connects to exactly one socket (the default, or
   whatever `HERDR_SOCKET_PATH` points at). Enumerating several is out of scope.
9. **Deferred by the spec, not unknown:** true cursor and TUI-exact fidelity via
   `herdr terminal session observe` + a headless VT emulator (spec 8.13 "Deferred"). Not in this
   plan; the faked cursor and the polled screen are v1.
