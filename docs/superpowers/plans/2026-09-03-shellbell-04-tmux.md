# Shellbell Plan 04 — tmux backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-09-05** after a pre-flight consistency scan against shipped code at `main` = `2c2d4f1`. This plan was originally written on 2026-09-03, before Plans 02, 03 and 04b shipped. Every interface it consumes has been re-checked against the shipped source and corrected. See **Pre-execution corrections** at the bottom for the change log.

**Goal:** Sessions running under tmux — in Ghostty, Warp, Terminal.app, Alacritty, Kitty, WezTerm, or over SSH — appear in the app next to iTerm2 sessions, stream `%output`-driven diffs, accept input, and can be created from the phone; panes that iTerm2 already shows through `tmux -CC` are not duplicated.

**Architecture:** One long-lived `tmux -C attach-session -f ignore-size` client per tmux session provides `%output`/layout events; any alive client doubles as the **command channel** (all tmux commands run through it — no child process per frame). `TmuxBackend` implements `TerminalBackend` on top of that client using `list-panes`/`list-clients` parsers, `capture-pane -e -N` + `parseSgrLine`, and `send-keys`. The registry (Plan 03) already knows how to merge and de-duplicate.

**Tech Stack:** Node 22, `@shellbell/protocol` (`parseSgrLine`, `NAMED_KEYS`, `NamedKey`), tmux ≥ 3.2. **No new dependency** — only `node:child_process`, `node:events`, `node:readline`, `node:os`, `node:util`.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 8.11, 8.11.1, 8.12, 15 (tmux tests), 18.10–18.13. Plans 01/02/03/04b complete. `docs/spike-tmux.md` (Plan 01 Task 3) records the escaping and `-f` findings that fix two constants here.

---

## READ THESE SHIPPED FILES FIRST (main @ `2c2d4f1`)

**Before writing any code, read these files in full.** This plan quotes them, and every "anchor" in Tasks 3 and 4 refers to their content at that SHA. If a quoted line is not found verbatim, **stop and report the drift** — do not guess a new insertion point.

| File | Why you need it |
|------|-----------------|
| `apps/agent/src/backends/types.ts` | `TerminalBackend`, `BackendEvent`, `Screen`, `BackendUnavailable`/`SessionGone`/`Unsupported`/`BadWindow`. Task 3 adds one optional member here. |
| `apps/agent/src/backends/registry.ts` | `BACKEND_ORDER`, id prefixing, `connected()`, the `tmuxWindowIds`/`tmuxWindowIdOf` de-dup, and the `setWatched` fan-out that Task 3's `setReported` mirrors. |
| `apps/agent/src/backends/herdr/start.ts` | **The template for Task 4's `backends/tmux/start.ts`.** Register-before-connect, cancellable retry, `onConnected`/`onUnavailable` firing exactly once, `stop()` unregistering. |
| `apps/agent/src/backends/herdr/backend.ts` | The quality bar: guarded `emit()`, `.catch` on every fire-and-forget, single-flight sync, idempotent `close()`, `isConnected`. |
| `apps/agent/src/backends/iterm2/backend.ts` | The other quality bar: `layoutBusy`/`layoutDirty` coalescing single-flight refresh, `BackendUnavailable` with a hint. |
| `apps/agent/src/cli.ts` | `buildAgent`, the buffered `print()`, `stopBackendDetectors`, and the §8.1 start banner Task 4 edits. |
| `apps/agent/src/doctor.ts` | `Check`, `RunDoctorDeps`, the **already-shipped** `tmux` check and the **already-shipped, already-tested** `parseTmuxVersion`. |
| `apps/agent/src/screen-tracker.ts` | Where `s.reported` is computed, and how `SessionGone` from `getScreen` destroys a session. Task 3 inserts one line here. |
| `apps/agent/test/fakes/fake-backend.ts` | The `watched: string[][]` recorder Task 3's `reported` recorder copies. |
| `apps/agent/test/registry.test.ts` | The shipped de-dup test that already satisfies spec §18.13 — do not duplicate it. |
| `apps/agent/test/fixtures/tmux-transcript.txt` | 610 recorded lines from the Plan 01 spike. Task 1 replays and asserts against it. |
| `packages/protocol/src/{sgr.ts,keys.ts}` | `parseSgrLine` (shipped, 8.11.1) and `NAMED_KEYS`/`NamedKey`/`NamedKeySchema`. |

---

## Global Constraints

- All Plan 01/03 constraints apply.
- tmux version floor **3.2**. Only the default server socket in v1.
- Never build a shell command string. Every tmux invocation is either an argv array (`execFile`) or a line written to the control channel; text arguments on the control channel are quoted with `tmuxQuote` (Task 1).
- Control-mode output escaping: `UNESCAPE_OCTAL = false` — the Plan 01 spike (tmux 3.7c) proved ESC arrives inside `%begin`/`%end` as a **raw 0x1B byte**, not the text `\033`. Do not re-derive this.
- Client flags are **`-f ignore-size` only**. `read-only` must NEVER appear anywhere in this plan's code: the spike proved a `read-only` client blocks `send-keys` for the **whole session**, for every client, while attached (spec §8.11, §18.10).
- Capabilities of the tmux backend are exactly `{ subscribe: true, prompts: false, createSession: true, focus: false, history: true, absoluteLines: false }`.
- **NEVER log terminal content or keystrokes** (spec 8.10). This includes command *lines* written to the control channel — `send-keys -t %1 -l -- 'hunter2'` is a keystroke. Timeout messages, `%error` echoes and stderr debug lines log the **command verb only** (`send-keys`, `capture-pane`), never the argument text. The shipped precedent is `herdr/backend.ts` (`this.log.debug("herdr key")` — records *that* a key was sent, never which).
- **`SessionGone` is reserved for a pane tmux itself reports as gone.** A missing command channel, a dead control client or a not-yet-refreshed pane is *transient* and must be a plain `Error` or `BackendUnavailable`. `ScreenTracker.tick` treats `SessionGone` as "this session is really gone" and deletes it from every viewer (`screen-tracker.ts:207-211`), so mislabelling a transient fault silently destroys the phone's session list.
- **Steps marked `Human-run only` are never executed by implementers.** They require a human at a GUI terminal and touch the operator's real tmux server. Leave the checkbox unticked and note "deferred to a human" in the task report.
- **Formatting:** Biome, `lineWidth: 100`, double quotes, semicolons, trailing commas (`biome.json`). Wrap code to 100 columns as you write it; run `pnpm lint:fix` before every commit so the diff is not one giant reformat.
- **Test/build commands:** always package-filtered — `pnpm -F shellbell test`, `pnpm -F shellbell typecheck`, `pnpm lint`. (`shellbell` is the package name of `apps/agent`; its `test` script is `buf generate && vitest run`.)
- **Bound every command that can hang.** Wrap anything touching a real tmux server or a real terminal in `perl -e 'alarm 300; exec @ARGV' -- <cmd>` so a wedged control client cannot stall the run.

---

## File structure created by this plan

```
apps/agent/
├── src/backends/tmux/
│   ├── control.ts     TmuxControl: spawn, parse, command channel, events
│   ├── keys.ts        NamedKey → tmux key name, and bytes → tmux key name
│   ├── parse.ts       list-panes / list-clients / display-message row parsers
│   ├── backend.ts     TmuxBackend
│   └── start.ts       startTmuxBackend — detect/retry/register supervisor
├── src/backends/types.ts        (modified) one optional TerminalBackend member
├── src/backends/registry.ts     (modified) setReported pass-through
├── src/screen-tracker.ts        (modified) one call site
├── src/cli.ts                   (modified) start the tmux backend, banner line
├── src/doctor.ts                (modified) RunDoctorDeps seam for `tmux -V`
├── scripts/spike-tmux.ts        (Plan 01, unchanged — input only)
└── test/
    ├── tmux-control.test.ts  tmux-parse.test.ts  tmux-backend.test.ts
    ├── tmux-start.test.ts    live-tmux.test.ts
    ├── fakes/fake-backend.ts    (modified) reported recorder
    ├── registry.test.ts         (modified) setReported routing
    ├── doctor.test.ts           (modified) tmux version rows
    └── fixtures/tmux-transcript.txt (Plan 01, unchanged)
```

---

### Task 1: `TmuxControl` — control-mode client (spec 8.11 "Control-mode clients")

**Files:**
- Create: `apps/agent/src/backends/tmux/control.ts`, `apps/agent/test/tmux-control.test.ts`

**Interfaces:**
- `tmuxQuote(s: string): string` — single-quote for tmux's parser: `'` + `s.replace(/'/g, "'\\''")` + `'`.
- `unescapeOctal(s: string): string` — replaces `\ooo` (three octal digits) with the byte, and `\\` with `\`.
- `UNESCAPE_OCTAL: boolean` — **`false`**, from the spike.
- `verbOf(line: string): string` — the first whitespace-delimited token of a control-channel command line. **The only part of a command line that may ever be logged.**
- `interface TmuxControlOptions { sessionId: string; socketName?: string; log: Logger; spawnImpl?: typeof spawn; commandTimeoutMs?: number; readyTimeoutMs?: number }`
- `class TmuxControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }>`: `start(): Promise<void>` (resolves after the first `%begin`/`%end` block or `readyTimeoutMs`, default 2 s), `command(line: string): Promise<string[]>` (rejects on `%error`, exit, or a 5 s timeout), `stop(): void` (idempotent), `readonly alive: boolean`.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/tmux-control.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TmuxControl, tmuxQuote, unescapeOctal, verbOf } from "../src/backends/tmux/control.js";
import { createLogger } from "../src/log.js";

/** Lets the PassThrough streams below deliver their queued `data`/`line` events. */
const flush = () => new Promise((r) => setImmediate(r));

function fakeSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(String(d)));
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 1,
    kill: () => stdout.end(),
    on(event: string, fn: (...a: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return child;
    },
  } as unknown as import("node:child_process").ChildProcess & {
    emitFake(event: string, ...args: unknown[]): void;
  };
  (child as unknown as { emitFake: (e: string, ...a: unknown[]) => void }).emitFake = (e, ...a) => {
    for (const fn of listeners.get(e) ?? []) fn(...a);
  };
  const spawnImpl = (() => child) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, stdout, stderr, written, child };
}

const log = createLogger({ stdout: false });

describe("tmuxQuote / unescapeOctal / verbOf", () => {
  it("quotes for tmux and unescapes control-mode octal", () => {
    expect(tmuxQuote("a b")).toBe("'a b'");
    expect(tmuxQuote("it's")).toBe("'it'\\''s'");
    expect(unescapeOctal("\\033[31mred\\033[0m \\\\ x")).toBe("\x1b[31mred\x1b[0m \\ x");
  });

  it("verbOf keeps only the command name, never the arguments (spec 8.10)", () => {
    expect(verbOf("send-keys -t %1 -l -- 'hunter2'")).toBe("send-keys");
    expect(verbOf("capture-pane -p -e -N -t %1")).toBe("capture-pane");
    expect(verbOf("")).toBe("?");
  });
});

describe("TmuxControl", () => {
  it("parses %begin/%end replies in order, emits %output and layout events, handles %error", async () => {
    const { spawnImpl, stdout, written } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p1 = c.command("list-panes -a");
    const p2 = c.command("display-message -p x");
    // PassThrough delivers `data` asynchronously: without this the array is still empty.
    await flush();
    expect(written.join("")).toBe("list-panes -a\ndisplay-message -p x\n");

    stdout.write(
      "%output %3 hello\n%begin 2 1 0\n%3\tmain\n%end 2 1 0\n%layout-change @1 xyz\n%begin 3 2 0\n%error 3 2 0\n",
    );
    expect(await p1).toEqual(["%3\tmain"]);
    await expect(p2).rejects.toThrow(/tmux error/);
    expect(outputs).toEqual(["%3"]);
    expect(layouts).toBe(1);
    c.stop();
  });

  it("never puts a command's arguments into a rejection message (spec 8.10)", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, commandTimeoutMs: 20 });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    const p = c.command("send-keys -t %1 -l -- 'hunter2'");
    await expect(p).rejects.toThrow(/tmux command timeout: send-keys/);
    await expect(p).rejects.not.toThrow(/hunter2/);
    c.stop();
  });

  it("rejects pending commands and emits exit when the process ends", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    let exited = 0;
    c.on("exit", () => exited++);
    const p = c.command("list-panes -a");
    stdout.write("%exit\n");
    stdout.end();
    await expect(p).rejects.toThrow(/exited/);
    await flush();
    expect(exited).toBe(1);
    expect(c.alive).toBe(false);
    // Idempotent: a second stop must not emit a second `exit`.
    c.stop();
    expect(exited).toBe(1);
  });

  it("survives a spawn error instead of throwing an uncaught 'error' event", async () => {
    const { spawnImpl, child } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, readyTimeoutMs: 20 });
    let exited = 0;
    c.on("exit", () => exited++);
    const started = c.start();
    (child as unknown as { emitFake: (e: string, ...a: unknown[]) => void }).emitFake(
      "error",
      Object.assign(new Error("spawn tmux ENOENT"), { name: "Error" }),
    );
    await started;
    expect(c.alive).toBe(false);
    expect(exited).toBe(1);
    await expect(c.command("list-panes -a")).rejects.toThrow(/exited/);
  });

  it("replays the recorded spike transcript and reports what it parsed", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    let exits = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    c.on("exit", () => exits++);
    const started = c.start();
    const text = readFileSync(
      new URL("./fixtures/tmux-transcript.txt", import.meta.url),
      "utf8",
    );
    stdout.write(text);
    await started;
    await flush();

    // spec 15: the parser is proven against the RECORDED transcript, not just synthetic lines.
    const beginCount = text.split("\n").filter((l) => l.startsWith("%begin")).length;
    const endCount = text.split("\n").filter((l) => l.startsWith("%end")).length;
    expect(beginCount).toBe(29);
    expect(endCount).toBe(29); // balanced: every reply block closed
    expect(text).not.toMatch(/^%error/m); // the recorded run had zero errors
    expect(outputs.length).toBeGreaterThan(0);
    expect(new Set(outputs)).toEqual(new Set(["%0"])); // the spike had exactly one pane
    expect(layouts).toBeGreaterThan(0);
    // The transcript ends with %exit; the client must have torn itself down.
    expect(exits).toBe(1);
    expect(c.alive).toBe(false);
    // UNESCAPE_OCTAL=false is load-bearing: capture-pane replies carry a RAW 0x1B.
    expect(text).toContain("\x1b[");
    c.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm -F shellbell test`.

- [ ] **Step 3: Implement `control.ts`**

`apps/agent/src/backends/tmux/control.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Logger } from "../../log.js";

/**
 * From `docs/spike-tmux.md` (tmux 3.7c): ESC arrives as a literal 0x1B byte inside `%begin`/`%end`,
 * so reply lines need no unescaping. Only `%output` payloads are octal-escaped, and we ignore their
 * data entirely (they are a "screen changed" signal, nothing more).
 */
export const UNESCAPE_OCTAL = false;

export function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function unescapeOctal(s: string): string {
  return s.replace(/\\(\\|[0-7]{3})/g, (_m, g: string) =>
    g === "\\" ? "\\" : String.fromCharCode(Number.parseInt(g, 8)),
  );
}

/**
 * Spec 8.10: a control-channel command line can contain the user's keystrokes
 * (`send-keys -t %1 -l -- 'hunter2'`). Only the verb may ever reach a log or an Error message.
 */
export function verbOf(line: string): string {
  return line.trim().split(/\s+/, 1)[0] || "?";
}

export interface TmuxControlOptions {
  sessionId: string;
  socketName?: string;
  log: Logger;
  spawnImpl?: typeof spawn;
  commandTimeoutMs?: number;
  readyTimeoutMs?: number;
}

interface Pending {
  resolve: (lines: string[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  verb: string;
}

export class TmuxControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  private child: ChildProcess | null = null;
  private queue: Pending[] = [];
  private current: { lines: string[] } | null = null;
  private currentPending: Pending | null = null;
  private started = false;
  private readyTimer: NodeJS.Timeout | null = null;
  alive = false;
  private readonly log: Logger;

  constructor(private readonly opts: TmuxControlOptions) {
    super();
    this.log = opts.log.child({ backend: "tmux", session: opts.sessionId });
  }

  start(): Promise<void> {
    const args = [
      ...(this.opts.socketName ? ["-L", this.opts.socketName] : []),
      "-C",
      "attach-session",
      "-t",
      this.opts.sessionId,
      "-f",
      "ignore-size",
    ];
    const child = (this.opts.spawnImpl ?? spawn)("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    let firstBlock: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      firstBlock = resolve;
      // Bounded: a server that never answers must not wedge `connect()` forever.
      this.readyTimer = setTimeout(resolve, this.opts.readyTimeoutMs ?? 2000);
      this.readyTimer.unref?.();
    });
    const settleReady = () => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      firstBlock?.();
    };
    rl.on("line", (line) => {
      if (line.startsWith("%begin")) {
        this.current = { lines: [] };
        this.currentPending = this.started ? (this.queue.shift() ?? null) : null;
        return;
      }
      if (line.startsWith("%end") || line.startsWith("%error")) {
        const block = this.current;
        const pending = this.currentPending;
        this.current = null;
        this.currentPending = null;
        if (!this.started) {
          this.started = true;
          settleReady();
          return;
        }
        if (pending) {
          clearTimeout(pending.timer);
          if (line.startsWith("%error")) {
            // spec 8.10: the %error body echoes the command, which can carry keystrokes.
            pending.reject(new Error(`tmux error: ${pending.verb}`));
          } else {
            pending.resolve(
              (block?.lines ?? []).map((l) => (UNESCAPE_OCTAL ? unescapeOctal(l) : l)),
            );
          }
        }
        return;
      }
      // NB: tmux never interleaves notifications inside a %begin/%end block, so collecting every
      // non-terminator line into the open block is safe and is what keeps replies correlated.
      if (this.current) {
        this.current.lines.push(line);
        return;
      }
      if (line.startsWith("%output ")) {
        const pane = line.slice(8).split(" ")[0];
        if (pane) this.emit("output", pane);
        return;
      }
      if (
        /^%(layout-change|window-add|window-close|window-renamed|unlinked-window-|session-changed|session-renamed|sessions-changed)/.test(
          line,
        )
      ) {
        this.emit("layout");
        return;
      }
      if (line.startsWith("%exit")) this.onExit();
    });
    rl.on("close", () => this.onExit());
    child.on("exit", () => this.onExit());
    // Without this, `spawn("tmux")` on a machine with no tmux emits an 'error' event with no
    // listener, which Node throws as an UNCAUGHT exception and kills the agent.
    child.on("error", (err) => {
      this.log.warn("tmux control spawn failed", { error: err.name });
      settleReady();
      this.onExit();
    });
    // EPIPE on a dead child's stdin must not surface as an unhandled stream error either.
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", () => {
      // spec 8.10: tmux's stderr can echo the command line we wrote, keystrokes included.
      // Record only that there WAS stderr, never its text.
      this.log.debug("tmux stderr");
    });
    return ready;
  }

  command(line: string): Promise<string[]> {
    const verb = verbOf(line);
    if (!this.alive || !this.child?.stdin) {
      return Promise.reject(new Error("tmux control exited"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error(`tmux command timeout: ${verb}`));
      }, this.opts.commandTimeoutMs ?? 5000);
      const pending: Pending = { resolve, reject, timer, verb };
      this.queue.push(pending);
      try {
        this.child?.stdin?.write(`${line}\n`);
      } catch {
        clearTimeout(timer);
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error("tmux control exited"));
      }
    });
  }

  /** Idempotent: safe to call from `close()`, from `onExit`, and again by a caller. */
  stop(): void {
    if (this.child) {
      try {
        this.child.stdin?.write("detach-client\n");
      } catch {
        // the child is already gone; nothing to detach
      }
      this.child.kill();
    }
    this.onExit();
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    for (const p of [this.currentPending, ...this.queue]) {
      if (!p) continue;
      clearTimeout(p.timer);
      p.reject(new Error("tmux control exited"));
    }
    this.queue = [];
    this.currentPending = null;
    this.emit("exit");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm -F shellbell test`. If the transcript replay fails, adjust the **assertions** to the recorded reality and report it; never flip `UNESCAPE_OCTAL`, which the spike settled.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): tmux control-mode client with command channel"
```

---

### Task 2: Row parsers and key tables (spec 8.11 "Listing", "Input")

**Files:**
- Create: `apps/agent/src/backends/tmux/parse.ts`, `apps/agent/src/backends/tmux/keys.ts`, `apps/agent/test/tmux-parse.test.ts`

**Interfaces:**
- `LIST_PANES_FORMAT: string` — the exact 18-field `-F` string from spec 8.11.
- `LIST_CLIENTS_FORMAT: string` — `'#{client_session}\t#{client_control_mode}'`.
- `DISPLAY_FORMAT: string` — `'#{cursor_x}\t#{cursor_y}\t#{history_size}\t#{pane_width}\t#{pane_height}'`.
- `Q_PANES`, `Q_CLIENTS`, `Q_DISPLAY: string` — each format with its literal `\t` turned into a real TAB and then `tmuxQuote`d, computed **once** at module load. Task 3 uses only these (no per-call `.replace()`).
- `parsePaneRow(row: string): PaneRow` where `PaneRow = { paneId; sessionId; sessionName; windowId; windowIndex; windowName; paneIndex; paneTitle; cwd; width; height; paneActive; windowActive; historySize; cursorX; cursorY; dead; currentCommand }`.
- `parseClientRow(row: string): { sessionId: string; controlMode: boolean }`.
- `parseDisplay(row: string): { cursorX; cursorY; historySize; width; height }`.
- `titleFor(p: PaneRow, hostname: string): string`.
- `tmuxKeyName(k: NamedKey): string` — the forward `NamedKey` → tmux key-name table.
- `tmuxKeyForBytes(text: string): string | undefined` — the reverse byte-string → tmux key-name lookup, mirroring the shipped `herdrKeyForBytes` in `backends/herdr/keys.ts`.

> **Why an explicit reverse table.** `agent.ts` converts `input.key` to raw bytes before the backend ever sees it (`case "input.key": await reg.sendText(msg.sessionId, bytesForKey(msg.key));`), so the backend only ever receives byte strings. A map built naively from `Object.entries(NAMED_KEYS)` **collides**: `ctrl-m === "\r"`, `ctrl-j === "\n"`, `ctrl-i === "\t"`, and the later entry wins — a phone's Enter would go out as `C-m`. The three ambiguous byte strings are therefore inserted **first**, exactly as `herdr/keys.ts:41-52` does, so no alias can claim them.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/tmux-parse.test.ts`:
```ts
import { NAMED_KEYS, NamedKeySchema } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { tmuxKeyForBytes, tmuxKeyName } from "../src/backends/tmux/keys.js";
import {
  DISPLAY_FORMAT,
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
  Q_DISPLAY,
  Q_PANES,
  parseClientRow,
  parseDisplay,
  parsePaneRow,
  titleFor,
} from "../src/backends/tmux/parse.js";

const row = [
  "%3", "$1", "work", "@2", "1", "zsh", "0", "mbp.local", "/Users/me/proj",
  "120", "40", "1", "1", "512", "3", "39", "0", "zsh",
].join("\t");

describe("tmux parsers", () => {
  it("parses a list-panes row", () => {
    const p = parsePaneRow(row);
    expect(p).toMatchObject({
      paneId: "%3", sessionId: "$1", sessionName: "work", windowId: "@2", windowIndex: 1,
      windowName: "zsh", paneIndex: 0, cwd: "/Users/me/proj", width: 120, height: 40,
      paneActive: true, windowActive: true, historySize: 512, cursorX: 3, cursorY: 39,
      dead: false, currentCommand: "zsh",
    });
    expect(LIST_PANES_FORMAT.split("\\t")).toHaveLength(18);
    expect(LIST_CLIENTS_FORMAT.split("\\t")).toHaveLength(2);
    expect(DISPLAY_FORMAT.split("\\t")).toHaveLength(5);
  });

  it("pre-quotes each format exactly once, with real TABs inside", () => {
    // Task 3 must never re-derive these per call.
    expect(Q_PANES.startsWith("'")).toBe(true);
    expect(Q_PANES).toContain("\t");
    expect(Q_PANES).not.toContain("\\t");
    expect(Q_DISPLAY.split("\t")).toHaveLength(5);
  });

  it("derives titles: window name when custom, else pane title unless hostname, else s:w.p", () => {
    const p = parsePaneRow(row);
    expect(titleFor(p, "mbp.local")).toBe("work:1.0");
    expect(titleFor({ ...p, windowName: "build" }, "mbp.local")).toBe("build");
    expect(titleFor({ ...p, paneTitle: "vim main.rs" }, "mbp.local")).toBe("vim main.rs");
  });

  it("parses clients and display-message", () => {
    expect(parseClientRow("$1\t1")).toEqual({ sessionId: "$1", controlMode: true });
    expect(parseClientRow("$1\t0")).toEqual({ sessionId: "$1", controlMode: false });
    expect(parseDisplay("3\t39\t512\t120\t40")).toEqual({
      cursorX: 3, cursorY: 39, historySize: 512, width: 120, height: 40,
    });
  });

  it("maps every named key to a tmux key name", () => {
    for (const k of NamedKeySchema.options) expect(tmuxKeyName(k).length).toBeGreaterThan(0);
    expect(tmuxKeyName("enter")).toBe("Enter");
    expect(tmuxKeyName("tab")).toBe("Tab");
    expect(tmuxKeyName("shift-tab")).toBe("BTab");
    expect(tmuxKeyName("esc")).toBe("Escape");
    expect(tmuxKeyName("backspace")).toBe("BSpace");
    expect(tmuxKeyName("delete")).toBe("DC");
    expect(tmuxKeyName("up")).toBe("Up");
    expect(tmuxKeyName("left")).toBe("Left");
    expect(tmuxKeyName("home")).toBe("Home");
    expect(tmuxKeyName("end")).toBe("End");
    expect(tmuxKeyName("page-up")).toBe("PPage");
    expect(tmuxKeyName("page-down")).toBe("NPage");
    expect(tmuxKeyName("ctrl-c")).toBe("C-c");
    expect(tmuxKeyName("ctrl-space")).toBe("C-Space");
    expect(tmuxKeyName("f1")).toBe("F1");
    expect(tmuxKeyName("f12")).toBe("F12");
  });

  it("resolves the three colliding byte strings deliberately, not by map order", () => {
    // NAMED_KEYS aliases these bytes (ctrl-m/ctrl-j/ctrl-i); Enter/Tab must always win.
    expect(NAMED_KEYS["ctrl-m"]).toBe("\r");
    expect(NAMED_KEYS["ctrl-j"]).toBe("\n");
    expect(NAMED_KEYS["ctrl-i"]).toBe("\t");
    expect(tmuxKeyForBytes("\r")).toBe("Enter");
    expect(tmuxKeyForBytes("\n")).toBe("Enter");
    expect(tmuxKeyForBytes("\t")).toBe("Tab");
    expect(tmuxKeyForBytes("\x03")).toBe("C-c");
    expect(tmuxKeyForBytes("\x1b[A")).toBe("Up");
    expect(tmuxKeyForBytes("\x1b[3~")).toBe("DC");
    expect(tmuxKeyForBytes("ls -la")).toBeUndefined();
    expect(tmuxKeyForBytes("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm -F shellbell test`.

- [ ] **Step 3: Implement**

`apps/agent/src/backends/tmux/parse.ts`:
```ts
import { tmuxQuote } from "./control.js";

export const LIST_PANES_FORMAT =
  "#{pane_id}\\t#{session_id}\\t#{session_name}\\t#{window_id}\\t#{window_index}\\t#{window_name}\\t#{pane_index}\\t#{pane_title}\\t#{pane_current_path}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{window_active}\\t#{history_size}\\t#{cursor_x}\\t#{cursor_y}\\t#{pane_dead}\\t#{pane_current_command}";
export const LIST_CLIENTS_FORMAT = "#{client_session}\\t#{client_control_mode}";
export const DISPLAY_FORMAT =
  "#{cursor_x}\\t#{cursor_y}\\t#{history_size}\\t#{pane_width}\\t#{pane_height}";

/** Each format, real-TABbed and tmux-quoted, computed once instead of at every call site. */
const quoted = (fmt: string) => tmuxQuote(fmt.replace(/\\t/g, "\t"));
export const Q_PANES = quoted(LIST_PANES_FORMAT);
export const Q_CLIENTS = quoted(LIST_CLIENTS_FORMAT);
export const Q_DISPLAY = quoted(DISPLAY_FORMAT);

export interface PaneRow {
  paneId: string;
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneTitle: string;
  cwd: string;
  width: number;
  height: number;
  paneActive: boolean;
  windowActive: boolean;
  historySize: number;
  cursorX: number;
  cursorY: number;
  dead: boolean;
  currentCommand: string;
}

const n = (s: string | undefined) => Number.parseInt(s ?? "0", 10) || 0;

export function parsePaneRow(row: string): PaneRow {
  const f = row.split("\t");
  return {
    paneId: f[0] ?? "",
    sessionId: f[1] ?? "",
    sessionName: f[2] ?? "",
    windowId: f[3] ?? "",
    windowIndex: n(f[4]),
    windowName: f[5] ?? "",
    paneIndex: n(f[6]),
    paneTitle: f[7] ?? "",
    cwd: f[8] ?? "",
    width: n(f[9]),
    height: n(f[10]),
    paneActive: f[11] === "1",
    windowActive: f[12] === "1",
    historySize: n(f[13]),
    cursorX: n(f[14]),
    cursorY: n(f[15]),
    dead: f[16] === "1",
    currentCommand: f[17] ?? "",
  };
}

export function parseClientRow(row: string): { sessionId: string; controlMode: boolean } {
  const f = row.split("\t");
  return { sessionId: f[0] ?? "", controlMode: f[1] === "1" };
}

export function parseDisplay(row: string): {
  cursorX: number;
  cursorY: number;
  historySize: number;
  width: number;
  height: number;
} {
  const f = row.split("\t");
  return { cursorX: n(f[0]), cursorY: n(f[1]), historySize: n(f[2]), width: n(f[3]), height: n(f[4]) };
}

export function titleFor(p: PaneRow, hostname: string): string {
  if (p.windowName && p.windowName !== p.currentCommand) return p.windowName;
  if (p.paneTitle && p.paneTitle !== hostname) return p.paneTitle;
  return `${p.sessionName}:${p.windowIndex}.${p.paneIndex}`;
}
```

`apps/agent/src/backends/tmux/keys.ts`:
```ts
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

const FIXED: Partial<Record<NamedKey, string>> = {
  enter: "Enter",
  tab: "Tab",
  "shift-tab": "BTab",
  esc: "Escape",
  backspace: "BSpace",
  delete: "DC",
  up: "Up",
  down: "Down",
  right: "Right",
  left: "Left",
  home: "Home",
  end: "End",
  "page-up": "PPage",
  "page-down": "NPage",
  "ctrl-space": "C-Space",
};

/** spec 8.11 "Input": the tmux key names accepted by `send-keys -t %N <Name>`. */
export function tmuxKeyName(k: NamedKey): string {
  const fixed = FIXED[k];
  if (fixed) return fixed;
  if (k.startsWith("ctrl-")) return `C-${k.slice(5)}`;
  if (/^f([1-9]|1[0-2])$/.test(k)) return k.toUpperCase();
  throw new Error(`no tmux key for ${k}`);
}

/**
 * Reverse map: the exact byte string `agent.ts` hands `sendText` -> a tmux key name.
 * `\r`, `\n` and `\t` are inserted FIRST on purpose: `NAMED_KEYS` aliases those exact bytes as
 * `ctrl-m`/`ctrl-j`/`ctrl-i`, and a map built by iteration order alone would let the alias win --
 * a phone's Enter would go out as `C-m`. Same construction as `herdr/keys.ts`'s `BYTES_TO_HERDR`.
 */
const BYTES_TO_TMUX = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>([
    ["\r", "Enter"],
    ["\n", "Enter"],
    ["\t", "Tab"],
  ]);
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    if (!out.has(bytes)) out.set(bytes, tmuxKeyName(name));
  }
  return out;
}

export function tmuxKeyForBytes(text: string): string | undefined {
  return text ? BYTES_TO_TMUX.get(text) : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm -F shellbell test`.

- [ ] **Step 5: Commit** — `git add apps/agent && git commit -m "feat(agent): tmux row parsers and key tables"`.

---

### Task 3: `TmuxBackend` and the `setReported` interface (spec 8.11, 8.12)

**Files:**
- Create: `apps/agent/src/backends/tmux/backend.ts`, `apps/agent/test/tmux-backend.test.ts`
- Modify: `apps/agent/src/backends/types.ts`, `apps/agent/src/backends/registry.ts`, `apps/agent/src/screen-tracker.ts`, `apps/agent/test/fakes/fake-backend.ts`, `apps/agent/test/registry.test.ts`

**Interfaces:**
- `TmuxBackendOptions { log: Logger; socketName?: string; hostname?: string; controlFactory?: (sessionId: string) => TmuxControl; execImpl?: (args: string[]) => Promise<string>; watchIntervalMs?: number; refreshDebounceMs?: number }`
- `class TmuxBackend implements TerminalBackend` with `get isConnected(): boolean`, `tmuxWindowIdOf(nativeId)`, `setReported(paneId, reported)`, and `static async detect(execImpl?): Promise<{ ok: boolean; version: string; reason?: string }>`.

#### Step 0 — the interface additions (do these first; everything else depends on them)

- [ ] **Step 0a: add `setReported` to `TerminalBackend`.** Shipped `apps/agent/src/backends/types.ts:69-108` ends with `setWatched?` and `isConnected?`. Replace the **whole** interface with this (the only change is the new `setReported?` member and its doc comment — every other line is byte-identical to what ships):

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
   * Spec 8.11 (tmux history): the tracker's monotonic `scrollbackTotal` for one session. A backend
   * whose native scrollback counter is NOT monotonic (tmux's `history_size` saturates at
   * `history-limit` and can shrink) needs this value to turn the phone's absolute `before` into a
   * `capture-pane -S/-E` range. `ScreenTracker.processScreen` pushes it once per processed frame,
   * through the registry, which strips the id prefix. Backends with absolute line numbers ignore it.
   */
  setReported?(nativeId: string, reported: number): void;
  /**
   * Spec 8.12/8.13: `false` while the backend's transport is down. The registry keeps such a
   * member registered (it reconnects itself) but leaves it out of `hello.backends`. A backend
   * that omits this property is always considered connected. Named `isConnected` (not
   * `connected`) because `BackendRegistry.connected()` is a pre-existing, unrelated aggregate
   * method (returns the list of connected member backends) and the two must not collide.
   */
  readonly isConnected?: boolean;
}
```

- [ ] **Step 0b: registry pass-through.** In `apps/agent/src/backends/registry.ts`, insert `setReported` immediately **after** the shipped `setWatched` method (which ends at line 249 with `}` followed by `on(handler: …)`). It mirrors `setWatched`'s prefix handling and its `try/catch`:

```ts
  /**
   * Spec 8.11: route the tracker's monotonic `scrollbackTotal` to the owning member, stripping the
   * `"<name>:"` prefix on the way -- the same contract as `setWatched` above, but per-session
   * rather than fanned out. An unknown prefix, or a member that does not implement it, is a no-op.
   */
  setReported(id: string, reported: number): void {
    const p = splitId(id);
    if (!p) return;
    try {
      this.members.get(p.name)?.setReported?.(p.native, reported);
    } catch (err) {
      this.log.warn("setReported failed for backend", {
        backend: p.name,
        err: err instanceof Error ? err.name : String(err),
      });
    }
  }
```

- [ ] **Step 0c: tracker call site.** In `apps/agent/src/screen-tracker.ts`, `s.reported` is written in four branches inside `processScreen`; it becomes final exactly at the shipped line 290. Shipped context:

```ts
      } else if (!absoluteLines && !forceSnapshotAll) {
        const changedRowForRow = countChanged(keys, s.lastKeys, 0);
        if (changedRowForRow > SNAPSHOT_RATIO * rows) {
          const k = detectOverlap(keys, s.lastKeys, rows);
          if (k > 0) {
            delta = k;
            s.reported += k;
          }
        }
      }
    }
    s.lastBackendScrollback = screen.scrollbackTotal;

    const changed: { i: number; line: Line }[] = [];
```

Insert **one** call directly after `s.lastBackendScrollback = screen.scrollbackTotal;` — this is the single point where `s.reported` is settled for the tick, so there is exactly one call site:

```ts
    s.lastBackendScrollback = screen.scrollbackTotal;
    // Spec 8.11: tmux's `history_size` saturates, so its `getHistory` cannot derive absolute line
    // numbers on its own -- hand it the monotonic value we just computed. Optional on the
    // interface; iTerm2 (absoluteLines: true) does not implement it.
    this.opts.backend.setReported?.(sessionId, s.reported);
```

No cast is needed: `setReported?` is now a declared optional member of `TerminalBackend` (Step 0a), and `this.opts.backend` is the registry facade, which strips the prefix (Step 0b).

- [ ] **Step 0d: `FakeBackend` recorder.** In `apps/agent/test/fakes/fake-backend.ts`, next to the shipped `watched` recorder:

```ts
  /** Every `setWatched` call the tracker or registry made, in order (spec 8.13). */
  watched: string[][] = [];
  /** Every `setReported` call routed to this backend, in order (spec 8.11). */
  reported: [string, number][] = [];
```

and next to the shipped `setWatched` method:

```ts
  setReported(id: string, value: number): void {
    this.reported.push([id, value]);
  }
```

- [ ] **Step 0e: registry routing test.** Add to `apps/agent/test/registry.test.ts`:

```ts
  it("routes setReported to the owning member with the prefix stripped (spec 8.11)", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    const tmux = new FakeBackend("tmux");
    reg.add(iterm);
    reg.add(tmux);
    reg.setReported("tmux:%2", 7);
    expect(tmux.reported).toEqual([["%2", 7]]);
    expect(iterm.reported).toEqual([]);
    // Unknown prefix and unknown backend are no-ops, never throws.
    expect(() => reg.setReported("kitty:1", 3)).not.toThrow();
    expect(() => reg.setReported("nocolon", 3)).not.toThrow();
  });
```

- [ ] **Step 0f: end-to-end tracker test.** Add to `apps/agent/test/screen-tracker.test.ts` (follow the file's existing setup helpers):

```ts
  it("pushes the monotonic reported value down to the backend each frame (spec 8.11)", async () => {
    // Uses whatever FakeBackend/tracker harness this file already builds; the assertion is that
    // the tracker's own `reported` (not the backend's raw scrollbackTotal) is what arrives.
    const backend = new FakeBackend("tmux");
    backend.addSession("%1", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 0 });
    // ... start the tracker, attach one viewer, append lines so scrollback advances, tick ...
    expect(backend.reported.at(-1)?.[0]).toBe("%1");
    expect(backend.reported.at(-1)?.[1]).toBeGreaterThan(0);
    // Monotonic: never decreases across frames, even when the backend's own counter does.
    const values = backend.reported.map(([, v]) => v);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
```

#### Step 1 — the backend tests

- [ ] **Step 1: Write the failing tests** (fake `TmuxControl` scripted by command prefix)

`apps/agent/test/tmux-backend.test.ts`:
```ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { SessionGone } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

class FakeControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  alive = true;
  commands: string[] = [];
  screen = ["\x1b[1mhello\x1b[0m", "world", ""];
  history = ["h1", "h2", "h3"];
  historySize = 3;
  constructor(readonly sessionId: string) {
    super();
  }
  async start(): Promise<void> {}
  stop(): void {
    this.alive = false;
  }
  async command(line: string): Promise<string[]> {
    this.commands.push(line);
    if (line.startsWith("list-panes")) {
      return [
        ["%1", "$0", "main", "@0", "0", "zsh", "0", "host", "/tmp", "10", "3", "1", "1", "3", "0", "2", "0", "zsh"].join("\t"),
        ["%2", "$0", "main", "@1", "1", "build", "0", "host", "/tmp", "10", "3", "1", "0", "0", "0", "0", "0", "make"].join("\t"),
      ];
    }
    if (line.startsWith("list-clients")) return ["$0\t1", "$0\t0"];
    if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
    if (line.startsWith("capture-pane") && line.includes("-S")) {
      const m = /-S (-?\d+) -E (-?\d+)/.exec(line) as RegExpExecArray;
      const s = Number(m[1]);
      const e = Number(m[2]);
      return this.history.slice(this.history.length + s, this.history.length + e + 1);
    }
    if (line.startsWith("capture-pane")) return this.screen;
    if (line.startsWith("send-keys")) return [];
    if (line.startsWith("new-window") || line.startsWith("new-session") || line.startsWith("split-window")) {
      return ["%9"];
    }
    throw new Error(`unexpected ${line.split(" ")[0]}`);
  }
}

const log = createLogger({ stdout: false });
const exec = async (args: string[]) => (args[0] === "-V" ? "tmux 3.4\n" : "$0\n");
const factory = (sink?: FakeControl[]) => (sid: string) => {
  const c = new FakeControl(sid);
  sink?.push(c);
  return c as unknown as TmuxControl;
};

describe("TmuxBackend", () => {
  it("detects version and server, and orders versions like doctor's parseTmuxVersion", async () => {
    expect(await TmuxBackend.detect(exec)).toMatchObject({ ok: true, version: "3.4" });
    const old = await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.1\n" : "$0\n"));
    expect(old).toMatchObject({ ok: false });
    expect(old.reason).toMatch(/3\.2\+ required/);
    // Regression: parseFloat("3.10") === 3.1 would wrongly reject a NEWER tmux.
    expect(await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.10\n" : "$0\n")))
      .toMatchObject({ ok: true });
    expect(
      await TmuxBackend.detect(async (a) => {
        if (a[0] === "-V") return "tmux 3.4\n";
        throw new Error("no server");
      }),
    ).toMatchObject({ ok: false, reason: "no tmux server running" });
    expect(
      await TmuxBackend.detect(async () => {
        throw new Error("ENOENT");
      }),
    ).toMatchObject({ ok: false, reason: "tmux not found" });
  });

  it("lists panes with titles, focus from non-control clients, window ids for de-dup", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory(controls) });
    await b.connect();
    expect(b.isConnected).toBe(true);
    const list = await b.listSessions();
    expect(list.map((s) => [s.id, s.title, s.cwd, s.isFocusedOnMac, s.windowId, s.tabId])).toEqual([
      ["%1", "main:0.0", "/tmp", true, "$0", "@0"],
      ["%2", "build", "/tmp", false, "$0", "@1"],
    ]);
    expect(list.every((s) => s.state === "unknown")).toBe(true);
    // spec 8.12 de-dup hook: the registry calls this with the NATIVE id and compares to `@N`.
    expect(b.tmuxWindowIdOf("%2")).toBe("@1");
    expect(b.tmuxWindowIdOf("%nope")).toBeUndefined();
    expect(b.capabilities).toEqual({
      subscribe: true, prompts: false, createSession: true, focus: false,
      history: true, absoluteLines: false,
    });
    await b.close();
    expect(b.isConnected).toBe(false);
    // close() is idempotent and stops every control client.
    await b.close();
    expect(controls.every((c) => !c.alive)).toBe(true);
  });

  it("getScreen parses SGR rows over the command channel and reports history_size", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    const s = await b.getScreen("%1");
    expect(s.lines[0]).toEqual({ r: [{ t: "hello", b: true }] });
    expect(s.lines[1]).toEqual({ r: [{ t: "world" }] });
    expect(s.rows).toBe(3);
    expect(s.cols).toBe(10);
    expect(s.cursor).toEqual({ x: 4, y: 1 });
    expect(s.scrollbackTotal).toBe(3);
    await b.close();
  });

  it("history range arithmetic uses the tracker's reported value", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    b.setReported("%1", 3);
    const h = await b.getHistory("%1", 3, 2);
    expect(h.lines.map((l) => l.r[0]?.t)).toEqual(["h2", "h3"]);
    expect(h.oldestAvailable).toBe(0);
    await b.close();
  });

  it("reports oldestAvailable > 0 once tmux's history saturates (spec 18.12)", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory(controls) });
    await b.connect();
    // The pane has scrolled 50 lines but `history-limit` caps the buffer at 3: tmux's own
    // history_size stopped growing while the tracker's monotonic value kept going.
    b.setReported("%1", 50);
    const h = await b.getHistory("%1", 50, 2);
    expect(h.oldestAvailable).toBe(47);
    expect(h.lines.map((l) => l.r[0]?.t)).toEqual(["h2", "h3"]);
    // Asking below the retained window returns nothing rather than a wrong range.
    expect((await b.getHistory("%1", 10, 2)).lines).toEqual([]);
    await b.close();
  });

  it("a missing command channel is transient, never SessionGone", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory(controls) });
    await b.connect();
    for (const c of controls) c.alive = false;
    // If this were SessionGone, ScreenTracker would delete the session from every viewer.
    await expect(b.getScreen("%1")).rejects.not.toBeInstanceOf(SessionGone);
    await expect(b.getScreen("%1")).rejects.toThrow(/command channel/);
    // A pane tmux genuinely does not have IS SessionGone.
    await expect(b.getScreen("%404")).rejects.toBeInstanceOf(SessionGone);
    await b.close();
  });

  it("sendText: keys by name, text literally, CR/LF split into Enter", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log, hostname: "host", execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => {
      events.push(e.type);
    });

    const keys = () => control.commands.filter((c) => c.startsWith("send-keys"));
    await b.sendText("%1", "ls -la\r");
    expect(keys()).toEqual(["send-keys -t %1 -l -- 'ls -la'", "send-keys -t %1 Enter"]);
    await b.sendText("%1", "\x03");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 C-c");
    await b.sendText("%1", "\r");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 Enter");
    await b.sendText("%1", "\t");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 Tab");
    // An embedded newline (a pasted two-line snippet) becomes literal + Enter + literal.
    control.commands.length = 0;
    await b.sendText("%1", "echo a\necho b");
    expect(keys()).toEqual([
      "send-keys -t %1 -l -- 'echo a'",
      "send-keys -t %1 Enter",
      "send-keys -t %1 -l -- 'echo b'",
    ]);
    // A quote in the payload survives tmuxQuote.
    control.commands.length = 0;
    await b.sendText("%1", "echo it's");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 -l -- 'echo it'\\''s'");

    control.emit("output", "%1");
    expect(events).toEqual(["screen-changed"]);
    await b.close();
  });

  it("createSession returns the new pane id and rejects when tmux returns none", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log, hostname: "host", execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -h");
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "horizontal" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -v");
    expect(await b.createSession({ kind: "tab", backend: "tmux", windowId: "$0" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-window -P -F '#{pane_id}' -t $0");
    expect(await b.createSession({ kind: "tab", backend: "tmux" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-session -d -P -F '#{pane_id}'");
    // An empty reply must REJECT, never resolve to "" (the registry would ack `"tmux:"`).
    const empty = new FakeControl("$0");
    empty.command = async () => [];
    const b2 = new TmuxBackend({
      log, hostname: "host", execImpl: exec,
      controlFactory: () => empty as unknown as TmuxControl,
    });
    await b2.connect();
    await expect(b2.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(/no pane id/);
    await b.close();
    await b2.close();
  });

  it("focus is unsupported, and a throwing subscriber cannot break emit()", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log, hostname: "host", execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    await expect(b.focus("%1")).rejects.toThrow(/unsupported/);
    const seen: string[] = [];
    b.on(() => {
      throw new Error("subscriber blew up");
    });
    b.on((e) => {
      seen.push(e.type);
    });
    expect(() => control.emit("output", "%1")).not.toThrow();
    expect(seen).toEqual(["screen-changed"]);
    await b.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm -F shellbell test`.

- [ ] **Step 3: Implement `backend.ts`**

`apps/agent/src/backends/tmux/backend.ts`:
```ts
import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import {
  type Capabilities,
  type CreateWhere,
  type Line,
  parseSgrLine,
  type SessionInfo,
} from "@shellbell/protocol";
// `parseTmuxVersion` is the SHIPPED, unit-tested version comparator (`doctor.test.ts` asserts
// 3.2 <= 3.10). Never re-derive it with parseFloat: parseFloat("3.10") === 3.1 < 3.2.
// No cycle: doctor.ts imports herdr/start.ts and iterm2/*, never the tmux tree.
import { parseTmuxVersion } from "../../doctor.js";
import type { Logger } from "../../log.js";
import {
  type BackendEvent,
  BackendUnavailable,
  type Screen,
  SessionGone,
  type TerminalBackend,
  Unsupported,
} from "../types.js";
import { TmuxControl, tmuxQuote } from "./control.js";
import { tmuxKeyForBytes } from "./keys.js";
import {
  type PaneRow,
  Q_CLIENTS,
  Q_DISPLAY,
  Q_PANES,
  parseClientRow,
  parseDisplay,
  parsePaneRow,
  titleFor,
} from "./parse.js";

const run = promisify(execFile);
/** tmux 3.2, in `parseTmuxVersion`'s major + minor/100 space. */
const MIN_VERSION = 3.02;
export const TMUX_INSTALL_HINT = "brew install tmux (3.2+), then start a tmux session";

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

export interface TmuxBackendOptions {
  log: Logger;
  socketName?: string;
  hostname?: string;
  controlFactory?: (sessionId: string) => TmuxControl;
  execImpl?: (args: string[]) => Promise<string>;
  watchIntervalMs?: number;
  refreshDebounceMs?: number;
}

export class TmuxBackend implements TerminalBackend {
  readonly name = "tmux" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    prompts: false,
    createSession: true,
    focus: false,
    history: true,
    absoluteLines: false,
  };

  private controls = new Map<string, TmuxControl>();
  private panes = new Map<string, PaneRow>();
  private reported = new Map<string, number>();
  private sessionIndex = new Map<string, number>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private watcher: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBusy = false;
  private refreshDirty = false;
  private syncBusy = false;
  private closed = true;
  private readonly log: Logger;
  private readonly exec: (args: string[]) => Promise<string>;

  constructor(private readonly opts: TmuxBackendOptions) {
    this.log = opts.log.child({ backend: "tmux" });
    this.exec =
      opts.execImpl ??
      (async (args) =>
        (await run("tmux", [...(opts.socketName ? ["-L", opts.socketName] : []), ...args])).stdout);
  }

  /** Spec 8.12: false once every control client is gone, so the registry drops us from `hello`. */
  get isConnected(): boolean {
    return !this.closed && [...this.controls.values()].some((c) => c.alive);
  }

  static async detect(
    execImpl?: (args: string[]) => Promise<string>,
  ): Promise<{ ok: boolean; version: string; reason?: string }> {
    const exec = execImpl ?? (async (args) => (await run("tmux", args)).stdout);
    let raw: string;
    try {
      raw = await exec(["-V"]);
    } catch {
      return { ok: false, version: "", reason: "tmux not found" };
    }
    const version = /(\d+\.\d+)/.exec(raw)?.[1] ?? "";
    const parsed = parseTmuxVersion(raw);
    if (parsed === null || parsed < MIN_VERSION) {
      return {
        ok: false,
        version,
        reason: `tmux 3.2+ required for Shellbell (found ${version || raw.trim()})`,
      };
    }
    try {
      await exec(["list-sessions", "-F", "#{session_id}"]);
    } catch {
      return { ok: false, version, reason: "no tmux server running" };
    }
    return { ok: true, version };
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    const d = await TmuxBackend.detect(this.exec);
    if (!d.ok) throw new BackendUnavailable(d.reason ?? "tmux unavailable", TMUX_INSTALL_HINT);
    this.closed = false;
    await this.syncControls();
    await this.refreshPanes();
    this.watcher = setInterval(() => {
      void this.syncControls()
        .then(() => this.refreshPanes())
        .catch((err) => this.log.warn("tmux watcher failed", { error: errName(err) }));
    }, this.opts.watchIntervalMs ?? 5000);
    this.watcher.unref?.();
  }

  /** Idempotent (spec: `close()` may be called from `stop()` and again by the host). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshDirty = false;
    for (const c of this.controls.values()) c.stop();
    this.controls.clear();
    this.panes.clear();
    this.reported.clear();
    this.sessionIndex.clear();
    this.handlers.clear();
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  // ---- control clients ----

  /**
   * Spec 8.11: the first control client is also the command channel; when it exits, another is
   * promoted. Realised as "any alive client, chosen per command", which is the same guarantee
   * without a promotion step that could race the watcher.
   *
   * NOT `SessionGone`: no channel is a TRANSIENT fault (the watcher re-attaches within 5 s), and
   * `ScreenTracker.tick` deletes a session from every viewer when it sees `SessionGone`.
   */
  private channel(): TmuxControl {
    const c = [...this.controls.values()].find((x) => x.alive);
    if (!c) throw new Error("tmux command channel unavailable");
    return c;
  }

  private async syncControls(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      let ids: string[];
      try {
        ids = (await this.exec(["list-sessions", "-F", "#{session_id}"]))
          .split("\n")
          .filter(Boolean);
      } catch {
        ids = [];
      }
      // spec 8.11: `windowNumber` is the session's index in `list-sessions`, captured here.
      this.sessionIndex = new Map(ids.map((id, i) => [id, i]));
      for (const [id, c] of this.controls) {
        if (!ids.includes(id) || !c.alive) {
          c.stop();
          this.controls.delete(id);
        }
      }
      for (const id of ids) {
        if (this.closed || this.controls.has(id)) continue;
        const c = (this.opts.controlFactory ??
          ((sid: string) =>
            new TmuxControl({
              sessionId: sid,
              socketName: this.opts.socketName,
              log: this.opts.log,
            })))(id);
        c.on("output", (pane) => {
          // A pane we have not listed yet (created between two refreshes) would make `getScreen`
          // throw SessionGone and destroy the phone's session; refresh instead of emitting.
          if (!this.panes.has(pane)) this.scheduleRefresh();
          else this.emit({ type: "screen-changed", sessionId: pane });
        });
        c.on("layout", () => this.scheduleRefresh());
        c.on("exit", () => {
          this.controls.delete(id);
          this.scheduleRefresh();
        });
        // Registered before `await`, so a concurrent tick cannot spawn a second client for `id`.
        this.controls.set(id, c);
        await c.start();
      }
    } finally {
      this.syncBusy = false;
    }
  }

  // ---- pane map ----

  /** Spec 8.11: layout notifications are debounced 100 ms into one refresh. */
  private scheduleRefresh(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshPanes().catch((err) =>
        this.log.warn("tmux refresh failed", { error: errName(err) }),
      );
    }, this.opts.refreshDebounceMs ?? 100);
    this.refreshTimer.unref?.();
  }

  /**
   * Coalescing single-flight, like `ITerm2Backend.applyLayout`: at most one refresh runs, and a
   * request that arrives while one is in flight is collapsed into exactly one more afterwards.
   */
  private async refreshPanes(): Promise<void> {
    if (this.closed) return;
    if (this.refreshBusy) {
      this.refreshDirty = true;
      return;
    }
    this.refreshBusy = true;
    try {
      do {
        this.refreshDirty = false;
        await this.runRefresh();
      } while (this.refreshDirty && !this.closed);
    } finally {
      // Never leave the lock held: a throw here would wedge every later refresh.
      this.refreshBusy = false;
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.controls.size === 0) {
      const had = [...this.panes.keys()];
      this.panes.clear();
      for (const id of had) this.emit({ type: "session-removed", sessionId: id });
      if (had.length > 0) this.emit({ type: "layout-changed" });
      return;
    }
    let rows: PaneRow[];
    try {
      rows = (await this.channel().command(`list-panes -a -F ${Q_PANES}`)).map(parsePaneRow);
    } catch (err) {
      this.log.warn("list-panes failed", { error: errName(err) });
      return;
    }
    const next = new Map(rows.filter((r) => !r.dead).map((r) => [r.paneId, r]));
    const removed = [...this.panes.keys()].filter((id) => !next.has(id));
    this.panes = next;
    for (const id of removed) {
      this.reported.delete(id);
      this.emit({ type: "session-removed", sessionId: id });
    }
    this.emit({ type: "layout-changed" });
  }

  private pane(paneId: string): PaneRow {
    const p = this.panes.get(paneId);
    // The one place `SessionGone` is correct: tmux itself does not have this pane.
    if (!p) throw new SessionGone(paneId);
    return p;
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionInfo[]> {
    let attached = new Set<string>();
    try {
      const rows = (await this.channel().command(`list-clients -F ${Q_CLIENTS}`)).map(parseClientRow);
      // spec 8.11: our own control clients (`client_control_mode == 1`) never count as focus.
      attached = new Set(rows.filter((r) => !r.controlMode).map((r) => r.sessionId));
    } catch (err) {
      this.log.debug("list-clients failed; no pane reported focused", { error: errName(err) });
    }
    const host = this.opts.hostname ?? osHostname();
    const indexOf = (sid: string) => this.sessionIndex.get(sid) ?? Number.MAX_SAFE_INTEGER;
    return [...this.panes.values()]
      .sort(
        (a, b) =>
          indexOf(a.sessionId) - indexOf(b.sessionId) ||
          a.windowIndex - b.windowIndex ||
          a.paneIndex - b.paneIndex,
      )
      .map((p) => ({
        id: p.paneId,
        backend: "tmux" as const,
        title: titleFor(p, host),
        cwd: p.cwd || undefined,
        cols: Math.max(1, p.width),
        rows: Math.max(1, p.height),
        windowId: p.sessionId,
        windowNumber: this.sessionIndex.get(p.sessionId) ?? 0,
        tabId: p.windowId,
        tabIndex: p.windowIndex,
        paneIndex: p.paneIndex,
        isFocusedOnMac: p.paneActive && p.windowActive && attached.has(p.sessionId),
        state: "unknown" as const,
      }));
  }

  /** Spec 8.12: the registry hides any tmux pane whose tmux window id iTerm2 already shows. */
  tmuxWindowIdOf(nativeId: string): string | undefined {
    return this.panes.get(nativeId)?.windowId;
  }

  /** Spec 8.11: the tracker's monotonic `scrollbackTotal`; needed for history offsets. */
  setReported(paneId: string, reported: number): void {
    this.reported.set(paneId, reported);
  }

  // ---- screen / history ----

  async getScreen(paneId: string): Promise<Screen> {
    this.pane(paneId);
    const ch = this.channel();
    const [rows, disp] = await Promise.all([
      ch.command(`capture-pane -p -e -N -t ${paneId}`),
      ch.command(`display-message -p -t ${paneId} ${Q_DISPLAY}`),
    ]);
    const d = parseDisplay(disp[0] ?? "");
    const height = Math.max(1, d.height);
    const lines: Line[] = rows.map(parseSgrLine);
    while (lines.length < height) lines.push({ r: [] });
    if (lines.length > height) lines.length = height;
    return {
      cols: Math.max(1, d.width),
      rows: height,
      cursor: { x: d.cursorX, y: d.cursorY },
      lines,
      scrollbackTotal: d.historySize,
    };
  }

  /**
   * Spec 8.11: with `H = history_size` and the tracker's `reported`, the oldest retrievable
   * absolute line is `reported - H`, so `s = before - count - reported`, `e = before - 1 - reported`
   * (both <= -1, clamp `s >= -H`). tmux's `history_size` SATURATES at `history-limit` while
   * `reported` keeps climbing, which is exactly what makes `oldestAvailable` non-zero (spec 18.12).
   */
  async getHistory(
    paneId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    this.pane(paneId);
    const ch = this.channel();
    const d = parseDisplay((await ch.command(`display-message -p -t ${paneId} ${Q_DISPLAY}`))[0] ?? "");
    const reported = this.reported.get(paneId) ?? d.historySize;
    const oldestAvailable = Math.max(0, reported - d.historySize);
    const e = before - 1 - reported;
    const s = Math.max(before - count - reported, -d.historySize);
    if (e < s || e > -1) return { lines: [], oldestAvailable };
    const rows = await ch.command(`capture-pane -p -e -N -t ${paneId} -S ${s} -E ${e}`);
    return { lines: rows.map(parseSgrLine), oldestAvailable };
  }

  // ---- input ----

  /**
   * Spec 8.11 "Input". `agent.ts` turns `input.key` into raw bytes before we see it, so a payload
   * that is exactly one key's byte string goes out as a tmux key NAME; anything else is literal
   * text via `-l`, with every CR/LF becoming a real `Enter` (`-l` writes bytes and never submits).
   */
  async sendText(paneId: string, text: string): Promise<void> {
    this.pane(paneId);
    const ch = this.channel();
    const key = tmuxKeyForBytes(text);
    if (key) {
      // spec 8.10: NEVER log which key. Record only that one was sent.
      this.log.debug("tmux key");
      await ch.command(`send-keys -t ${paneId} ${key}`);
      return;
    }
    // Never log the text itself (spec 8.10) -- only its length.
    this.log.debug("tmux text", { len: text.length });
    const parts = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i++) {
      const body = parts[i] as string;
      if (body) await ch.command(`send-keys -t ${paneId} -l -- ${tmuxQuote(body)}`);
      if (i < parts.length - 1) await ch.command(`send-keys -t ${paneId} Enter`);
    }
  }

  // ---- create / focus ----

  async createSession(where: CreateWhere): Promise<string> {
    const ch = this.channel();
    const line =
      where.kind === "split"
        ? `split-window -P -F '#{pane_id}' -t ${where.sessionId} ${
            where.direction === "vertical" ? "-h" : "-v"
          }`
        : where.windowId
          ? `new-window -P -F '#{pane_id}' -t ${where.windowId}`
          : "new-session -d -P -F '#{pane_id}'";
    const out = await ch.command(line);
    const id = out[0]?.trim();
    // Never resolve "" -- the registry would prefix it to `"tmux:"` and ack it as a real session.
    if (!id) throw new Error(`tmux ${line.split(" ")[0]} returned no pane id`);
    this.scheduleRefresh();
    return id;
  }

  async focus(_paneId: string): Promise<void> {
    throw new Unsupported("focus");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm -F shellbell test`, then `pnpm -F shellbell typecheck` and `pnpm lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): tmux backend over the control channel; setReported plumbing"
```

---

### Task 4: Supervisor, CLI and doctor wiring; live test (spec 8.11, 8.12 detection, 15, 18.12)

**Files:**
- Create: `apps/agent/src/backends/tmux/start.ts`, `apps/agent/test/tmux-start.test.ts`, `apps/agent/test/live-tmux.test.ts`
- Modify: `apps/agent/src/cli.ts`, `apps/agent/src/doctor.ts`, `apps/agent/test/doctor.test.ts`

- [ ] **Step 1: `startTmuxBackend` — the supervisor**

Mirrors the shipped `backends/herdr/start.ts` exactly: register-before-connect, a cancellable `unref`'d retry, `onConnected`/`onUnavailable` firing at most once, everything after `connect()` in its own `try/catch` logging `err.name`, and `stop()` unregistering the member. It additionally satisfies spec 8.11's *"if the tmux server dies, the backend reports no sessions and retries detection every 10 s"*: the supervisor keeps ticking and re-`connect()`s whenever `backend.isConnected` goes false.

`apps/agent/src/backends/tmux/start.ts`:
```ts
import type { Logger } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
import { BackendUnavailable } from "../types.js";
import { TmuxBackend, type TmuxBackendOptions } from "./backend.js";

export interface StartTmuxOptions {
  registry: BackendRegistry;
  log: Logger;
  /** Spec 8.12: retry every 10 s while the backend is absent. */
  retryMs?: number;
  /** Called once, with the pane count, when the backend connects — for the CLI's start banner. */
  onConnected?: (panes: number) => void;
  /** Called once, after the very first failed attempt, so the CLI's banner line resolves instead
   * of hanging. The retry loop keeps going regardless — this fires exactly once. */
  onUnavailable?: () => void;
  backendOptions?: Omit<Partial<TmuxBackendOptions>, "log">;
}

/**
 * Spec 8.11/8.12: try tmux at startup, every 10 s while it is not running, and again whenever a
 * connected server dies (`isConnected` goes false when the last control client exits).
 *
 * The backend is registered with the registry BEFORE `connect()` (ruling 11, same as herdr):
 * `connect()` emits `layout-changed` for the panes it discovers, and that must reach the Agent,
 * which only subscribes through the registry. A registered-but-disconnected member reports
 * `isConnected: false`, so it is not advertised in `hello.backends` until it is real. tmux not
 * running is a perfectly normal state, so failures log at debug, never as errors.
 */
export function startTmuxBackend(opts: StartTmuxOptions): { stop(): void } {
  const log = opts.log.child({ unit: "tmux-start" });
  const backend = new TmuxBackend({ log: opts.log, ...opts.backendOptions });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;
  let announcedUnavailable = false;

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
    if (stopped) return;
    if (backend.isConnected) {
      // Already up: keep supervising so a dead server is noticed and re-detected.
      schedule();
      return;
    }
    try {
      await backend.connect();
    } catch (err) {
      // Log the error NAME only: `BackendUnavailable`'s message can embed tmux's own text.
      log.debug("tmux not available", { error: err instanceof Error ? err.name : "unknown" });
      if (opts.onUnavailable && !announcedUnavailable && err instanceof BackendUnavailable) {
        announcedUnavailable = true;
        opts.onUnavailable();
      }
      schedule();
      return;
    }
    // A separate try/catch so a throw from `onConnected` (the CLI's buffered `print` closure)
    // cannot become an unhandled rejection, and so a failure here does not re-schedule a retry
    // as if the connect itself had failed.
    try {
      if (stopped) return;
      log.info("tmux connected");
      if (opts.onConnected && !announced) {
        announced = true;
        const panes = await backend.listSessions().catch(() => []);
        opts.onConnected(panes.length);
      }
    } catch (err) {
      log.debug("tmux post-connect setup failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    schedule();
  };

  void attempt();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
      // A long-lived host must not keep a dead member registered forever.
      opts.registry.remove("tmux");
    },
  };
}
```

`apps/agent/test/tmux-start.test.ts` — bounded, no real tmux (inject `execImpl`/`controlFactory` via `backendOptions`, and a small `retryMs`):
```ts
// Assert, with fake exec/control implementations only:
//  - registers the member with the registry BEFORE connect resolves
//  - onUnavailable fires exactly once when tmux is absent, and the retry keeps ticking
//  - onConnected fires exactly once, with the pane count, when tmux appears on a later retry
//  - stop() cancels the timer and removes "tmux" from the registry
//  - a connected backend whose controls all die is re-connected by the supervisor
```

- [ ] **Step 2: CLI wiring — minimal anchored insertions into `apps/agent/src/cli.ts`**

**Anchor 1 (imports, shipped line 18).** After:
```ts
import { startHerdrBackend } from "./backends/herdr/start.js";
```
add:
```ts
import { startTmuxBackend } from "./backends/tmux/start.js";
```
(Static, like every other backend import — no `await import()`.)

**Anchor 2 (`buildAgent`, shipped lines 298-305).** The herdr block reads:
```ts
  const herdr = startHerdrBackend({
    registry,
    log,
    onConnected: (n) => print(`  herdr      connected · ${n} pane${n === 1 ? "" : "s"}`),
    // Resolves the `detecting…` banner line below when Herdr just isn't running -- the (silent)
    // 10 s retry loop keeps going regardless, so a later `onConnected` still fires normally.
    onUnavailable: () => print("  herdr      not running (optional)"),
  });
```
Insert immediately **before** it (so tmux keeps its spec-8.12 position ahead of herdr):
```ts
  // spec 8.11/8.12: tmux is optional and often absent, so this never blocks startup. It registers
  // the backend, retries every 10 s while the server is down, and announces itself if and when it
  // connects. Buffered through `print` like the iTerm2 and herdr lines, for the same reason.
  const tmux = startTmuxBackend({
    registry,
    log,
    onConnected: (n) => print(`  tmux       connected · ${n} pane${n === 1 ? "" : "s"}`),
    onUnavailable: () => print("  tmux       not running"),
  });
```

**Anchor 3 (`stopBackendDetectors`, shipped lines 313-318).** The shipped body:
```ts
  const stopBackendDetectors = () => {
    stopFirstConnect();
    herdr.stop();
  };
```
becomes:
```ts
  const stopBackendDetectors = () => {
    stopFirstConnect();
    tmux.stop();
    herdr.stop();
  };
```

**Anchor 4 (start banner, shipped line 389).** Delete the placeholder:
```ts
    console.log("  tmux       not running"); // Plan 04 adds the tmux backend.
```
and replace it with the same shape the herdr line uses on the next shipped line:
```ts
    console.log("  tmux       detecting…"); // followed up by startTmuxBackend's onConnected line
```
`releaseOutput()` (shipped line 393) then flushes whichever of `tmux       connected · N panes` / `tmux       not running` the supervisor produced. **No other change to `start` is needed** — the buffered `print` ordering already handles interleaving.

- [ ] **Step 3: doctor wiring — `RunDoctorDeps` seam for the tmux version**

`doctor.ts` already ships a `tmux` `Check` and the `parseTmuxVersion` helper Task 3 reuses; the only change is to make the `tmux -V` call injectable, so `doctor.test.ts` can drive the version rows without a real tmux.

**Anchor 5 (`RunDoctorDeps`, shipped lines 37-46).** Add a third seam after `requestCookieAndKey?`:
```ts
  /** Test seam: `tmux -V`'s stdout. Defaults to the real binary; inject a string so the version
   * rows (absent / too old / ok) can be asserted on a machine with any tmux, or none. */
  tmuxVersion?: () => Promise<string>;
```

**Anchor 6 (`runDoctor` body, shipped lines 53-54).** After:
```ts
  const requestCookieAndKeyImpl = deps.requestCookieAndKey ?? requestCookieAndKey;
```
add:
```ts
  const tmuxVersionImpl = deps.tmuxVersion ?? (async () => (await run("tmux", ["-V"])).stdout);
```

**Anchor 7 (the tmux check, shipped lines 83-91).** Replace only the first line of the `try`:
```ts
    const { stdout } = await run("tmux", ["-V"]);
```
with:
```ts
    const stdout = await tmuxVersionImpl();
```
The rest of the block (`parseTmuxVersion`, `v >= 3.02`, the `brew install tmux (3.2+)` fix) is unchanged and already correct.

Add to `apps/agent/test/doctor.test.ts`, following the shipped injection pattern (which must also pass `requestCookieAndKey: noRealITerm2Cookie` and a `checkHerdr` thunk):
```ts
  it("tmux rows: ok at 3.2 and 3.10, fail below 3.2, fail when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
    const rowFor = async (tmuxVersion: () => Promise<string>) =>
      (
        await runDoctor(fakePaths(dir), fakeConfig(), {
          requestCookieAndKey: noRealITerm2Cookie,
          checkHerdr: () => checkHerdr({ log, socketPath: join(dir, "herdr.sock") }),
          tmuxVersion,
        })
      ).find((c) => c.name === "tmux");
    expect((await rowFor(async () => "tmux 3.2\n"))?.ok).toBe(true);
    // Regression against a parseFloat comparison: 3.10 is NEWER than 3.2.
    expect((await rowFor(async () => "tmux 3.10\n"))?.ok).toBe(true);
    expect((await rowFor(async () => "tmux 3.1a\n"))?.ok).toBe(false);
    const missing = await rowFor(async () => {
      throw new Error("ENOENT");
    });
    expect(missing?.ok).toBe(false);
    expect(missing?.detail).toBe("not found (optional)");
  });
```

- [ ] **Step 4: Live test**

`apps/agent/test/live-tmux.test.ts` — spec §15's names (`SHELLBELL_TMUX_E2E=1`, throwaway socket `shellbell-test`), every read bounded, and **all cleanup in `afterAll`** so a failed assertion still kills the server and the backend's timers:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const live = process.env.SHELLBELL_TMUX_E2E === "1";
/** A throwaway server on its own socket — NEVER the operator's default tmux server. */
const SOCK = "shellbell-test";
const tmux = (...args: string[]) => run("tmux", ["-L", SOCK, ...args]);

describe.skipIf(!live)("live tmux", () => {
  let backend: TmuxBackend | null = null;

  beforeAll(async () => {
    // spec 18.12: a tiny history-limit makes `history_size` saturate, which is the only way to
    // observe `oldestAvailable > 0` against a real server.
    await tmux("new-session", "-d", "-s", "t", "-x", "60", "-y", "10");
    await tmux("set-option", "-g", "history-limit", "50");
    await tmux("send-keys", "-t", "t", "printf '\\e[31mred\\e[0m plain\\n'", "Enter");
    await new Promise((r) => setTimeout(r, 300));
  }, 20_000);

  afterAll(async () => {
    // Always, even after a failed assertion: the backend's control children and its 5 s watcher
    // must not outlive the suite, or vitest never exits.
    try {
      await backend?.close();
    } finally {
      await tmux("kill-server").catch(() => undefined);
    }
  }, 20_000);

  it("streams %output, captures styled rows, sends keys, reads history", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const b = new TmuxBackend({ log, socketName: SOCK });
    backend = b;
    await b.connect();
    expect(b.isConnected).toBe(true);

    const changed: string[] = [];
    b.on((e) => {
      if (e.type === "screen-changed") changed.push(e.sessionId);
    });

    const [s] = await b.listSessions();
    if (!s) throw new Error("no pane");

    const screen = await b.getScreen(s.id);
    const text = (ls: typeof screen.lines) =>
      ls.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text(screen.lines)).toContain("red plain");
    expect(screen.lines.some((l) => l.r.some((r) => r.fg === 1 && r.t.includes("red")))).toBe(true);

    await b.sendText(s.id, "echo shellbell-tmux-ok\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(changed.length).toBeGreaterThan(0);
    const after = await b.getScreen(s.id);
    expect(text(after.lines)).toContain("shellbell-tmux-ok");

    // A quote must survive tmuxQuote against the real tmux parser.
    await b.sendText(s.id, "echo it's-ok\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(text(await b.getScreen(s.id))).toContain("it's-ok");
  }, 20_000);

  it("reports oldestAvailable > 0 once history-limit 50 saturates (spec 18.12)", async () => {
    const b = backend as TmuxBackend;
    const [s] = await b.listSessions();
    if (!s) throw new Error("no pane");
    await b.sendText(s.id, "for i in $(seq 1 200); do echo line-$i; done\r");
    await new Promise((r) => setTimeout(r, 2000));
    const screen = await b.getScreen(s.id);
    // tmux's own counter has stopped at the limit while the tracker's would keep climbing.
    expect(screen.scrollbackTotal).toBeLessThanOrEqual(50);
    b.setReported(s.id, 200);
    const h = await b.getHistory(s.id, 200, 10);
    expect(h.oldestAvailable).toBeGreaterThan(0);
    expect(h.lines.length).toBeGreaterThan(0);
  }, 30_000);
});
```

- [ ] **Step 5: Run the live suite** — local only, bounded:
```bash
perl -e 'alarm 300; exec @ARGV' -- env SHELLBELL_TMUX_E2E=1 pnpm -F shellbell test -- test/live-tmux.test.ts
```
Expect both tests green. This spawns its own `tmux -L shellbell-test` server and kills it in `afterAll`; it never touches the default socket.

- [ ] **Step 6: `Human-run only` — end-to-end against a real GUI tmux session**

> **Human-run only. Implementers must NOT execute this step.** It starts the real agent, which attaches a `tmux -C attach-session` control client to **every session on the operator's default tmux server** and is able to `send-keys` into them, and it needs a human at a GUI terminal. Leave the checkbox unticked and record "deferred to a human" in the task report.

For the human: with a GUI terminal (Ghostty/Warp/Terminal.app) attached to a tmux session, run `pnpm -F shellbell dev`. The §8.1 banner must settle to:
```
  tmux       connected · N panes
```
(replacing the transient `tmux       detecting…`), and `shellbell status --json` must include those panes with `tmux:%N` ids. If no server is running, the banner must instead read `tmux       not running` and the agent must keep working.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): tmux supervisor, CLI and doctor wiring, live tmux test"
```

---

## Plan self-review

- **Spec coverage:** control-mode clients + command channel + escaping rule → Task 1; listing/title/focus rules, both key tables → Task 2; screen/history/input/create/focus-unsupported, `isConnected`, and the `reported` plumbing for history offsets → Task 3; detection/supervision, CLI banner, doctor seam, live + saturation tests → Task 4. De-dup with iTerm2 `-CC` is already covered by the **shipped** `registry.test.ts` (spec 18.13) and needs no new test; Task 3 only supplies `tmuxWindowIdOf`.
- **Type consistency:** `TmuxControl`'s event names (`output`, `layout`, `exit`) match `FakeControl`; `PaneRow` matches the 18-column format; `setReported` is a declared optional member of `TerminalBackend`, so the tracker needs no cast; the capabilities literal matches the spec exactly.
- **Quality bar (shipped iTerm2/Herdr):** guarded `emit()`; `.catch` on every `void`-ed promise; `unref()` on every timer; coalescing single-flight `refreshPanes` with `try/finally`; single-flight `syncControls`; idempotent `close()` that clears timers, panes, `reported` and handlers; `createSession` rejects rather than resolving `""`.
- **Safety:** `read-only` appears nowhere. No command-line arguments, key names or terminal content reach any log or Error message. `SessionGone` is thrown only from `pane()`, for a pane tmux does not have.
- **Placeholders:** none. `UNESCAPE_OCTAL` is a decision recorded in `docs/spike-tmux.md`.
- **Dependencies:** none added.

---

## Pre-execution corrections (2026-09-05)

Applied under ruling **R49** after a pre-flight scan against `main` @ `2c2d4f1`. Row ids match
`.superpowers/sdd/2026-09-03-shellbell-04-tmux/preflight-scan.md`.

**Blockers**
- **[S1]** T1 test: added a `flush()` (`setImmediate`) before asserting on `written` — `PassThrough` delivers `data` asynchronously, so the original assertion could never pass.
- **[S4]** T1 `start()`: added `child.on("error", …)` → `settleReady()` + `onExit()`. `spawn("tmux")` with no tmux emitted an unhandled `error` event, which Node throws as an uncaught exception. New test covers it.
- **[S7 / R3]** Keystroke leak closed: added `verbOf()`; `command()` timeouts and `%error` rejections now carry the **verb only**; the stderr debug line no longer logs `text`. New test asserts a `send-keys … 'hunter2'` timeout never contains `hunter2`.
- **[S15 / S16]** `channel()` now throws a plain `Error("tmux command channel unavailable")`, and an unseen `%output` pane schedules a refresh instead of emitting. `SessionGone` is now thrown only from `pane()`. Added the Global Constraint explaining why (`screen-tracker.ts:207-211`) and a test asserting the transient error is **not** `SessionGone`.
- **[S23]** Live test: `b.close()` and `kill-server` moved into `afterAll`; the backend is hoisted to describe scope.
- **[P16 / T2]** `detect()` now uses the shipped, already-tested `parseTmuxVersion` from `doctor.ts` against `MIN_VERSION = 3.02` instead of `parseFloat(...) < 3.2`, which wrongly rejected tmux 3.10+. Regression tests added in both `tmux-backend.test.ts` and `doctor.test.ts`.

**Interface additions (ruling 2)**
- **[P6]** `setReported?(nativeId, reported)` declared on `TerminalBackend`; the full interface is reproduced in Task 3 Step 0a with no ellipsis. The tracker's cast is gone.
- **[P6]** `BackendRegistry.setReported(id, reported)` pass-through added, mirroring the shipped `setWatched` fan-out (prefix strip + `try/catch`).
- **[S22]** The tracker call site is pinned to the one line where `s.reported` is final — immediately after the shipped `s.lastBackendScrollback = screen.scrollbackTotal;` — with the shipped lines quoted.
- **[P7]** `FakeBackend` gains a `reported: [string, number][]` recorder and `setReported`, next to the shipped `watched` recorder.
- **[P3]** `TmuxBackend.isConnected` getter added (`!closed && some(control.alive)`); asserted in tests.

**Supervisor / CLI / doctor (ruling 3)**
- **[P12 / P14 / S27 / V9]** New `backends/tmux/start.ts`, modelled on the shipped `herdr/start.ts`: register-before-connect, `unref`'d cancellable retry, `onConnected`/`onUnavailable` once, post-connect work in its own `try/catch` logging `err.name`, `stop()` → `registry.remove("tmux")`, and re-detection whenever `isConnected` goes false (spec 8.11's missing 10 s re-detect). New `tmux-start.test.ts`.
- **[P11 / P13 / X6]** Task 4's `cli.ts` edits rewritten as four minimal anchored insertions quoting the shipped lines: static import, the tmux block placed before the herdr block, `tmux.stop()` in `stopBackendDetectors`, and the shipped `console.log("  tmux       not running"); // Plan 04 adds the tmux backend.` (line 389) replaced by `detecting…` with the real state coming from `print()`.
- **[P15]** Task 4's doctor work is now real: `RunDoctorDeps.tmuxVersion` seam added with three anchored edits and a `doctor.test.ts` case, instead of a title that promised doctor work with no step.

**Quality bar (ruling 4)**
- **[S11]** `emit()` guarded with `try/catch` + `log.warn`, matching all three shipped emitters; test asserts a throwing subscriber cannot break delivery.
- **[S12]** Every fire-and-forget has `.catch`; watcher and debounce timers are `unref`'d.
- **[S13]** `refreshPanes` is a coalescing single-flight (`refreshBusy`/`refreshDirty`, `try/finally`), and `syncControls` has its own `syncBusy` guard.
- **[S14]** `close()` clears the watcher, the debounce timer, all controls, `panes`, `reported`, `sessionIndex` and `handlers`, and is idempotent; tested.
- **[S17]** `createSession` rejects with `no pane id` instead of resolving `""`; tested for all four command shapes.
- **[S18]** Both `createSession` branches now `scheduleRefresh()`.
- **[S19]** `Q_PANES`/`Q_CLIENTS`/`Q_DISPLAY` are computed once in `parse.ts`; the four duplicated `tmuxQuote(FMT.replace(...))` expressions are gone.
- **[S21 / V11]** `windowNumber` now comes from a `sessionIndex` map captured from `list-sessions` (spec 8.11), and the O(n²) `indexOf` in the sort comparator is gone.
- **[S5 / S6]** stdin writes are guarded (`stdin.on("error")` + `try/catch`); the 2 s ready timer is cleared and `unref`'d; `stop()` is idempotent.

**Keys (ruling 5)**
- **[S20]** The `BYTES_TO_KEY` map derived from `Object.entries(NAMED_KEYS)` is **deleted**. `keys.ts` now exports `tmuxKeyName` (forward table) and `tmuxKeyForBytes` (reverse map built like the shipped `herdrKeyForBytes`, with `\r`/`\n`→`Enter` and `\t`→`Tab` inserted first so the `ctrl-m`/`ctrl-j`/`ctrl-i` aliases cannot claim those bytes). `sendText` splits on `\r\n|\r|\n` so an embedded newline becomes literal + `Enter` + literal. Tests cover the table, all three collisions, and the embedded-newline split.

**Tests (ruling 6)**
- **[S2 / V13]** The transcript-replay test now asserts parsed event types and counts (29 balanced `%begin`/`%end`, zero `%error`, `%output` panes `{"%0"}`, ≥1 layout event, exactly one `exit`, raw `\x1b` present) — spec §15's recorded-transcript requirement is genuinely met.
- **[S3]** The `existsSync` escape hatch is gone; the committed fixture is read unconditionally.
- **[V14]** Spec 18.12 saturation is covered twice: a unit test (`reported` 50 vs `history_size` 3 → `oldestAvailable === 47`) and a live test against a real `history-limit 50` server.
- **[X4]** `setReported` end-to-end test added in `screen-tracker.test.ts`, plus the registry routing test.
- **[X2]** `LIST_CLIENTS_FORMAT`, `DISPLAY_FORMAT` and the new `Q_*` constants added to Task 2's Interfaces bullet and asserted.
- **[S24]** The live test's event handler uses a block body instead of returning a boolean from a `void` handler.
- **[S25]** The live styled-row assertion is backed by a `toContain("red plain")` text check so a failure is diagnosable.
- **[S10]** Task 2 now has an explicit "run tests to verify they fail" step.
- **[V16 / S26]** `SHELLBELL_TMUX_E2E` and `tmux -L shellbell-test` kept verbatim — these are spec §15's own names, not drift from `SHELLBELL_LIVE`.

**Human-run only + Global Constraints (ruling 7)**
- **[E1 / E2]** The real-tmux end-to-end check is now Task 4 Step 6, marked **Human-run only**, with the exact expected banner line (`tmux       connected · N panes`) named.
- **[E3]** The Architecture/constraints now state the blast radius (one control client per user session on the default socket) and why `-f ignore-size` makes it safe.
- Added to Global Constraints: the `Human-run only` rule, the Biome `lineWidth: 100` note, `pnpm -F shellbell` for every command, `perl -e 'alarm 300; exec @ARGV'` bounding, the `SessionGone` rule, the never-log-command-text rule, and the `read-only`-never rule.
- Added the **READ THESE SHIPPED FILES FIRST** box pinned to `2c2d4f1`.

**Minor / documentation**
- **[P21]** `stringCells` removed from the Tech Stack line (never used); `NAMED_KEYS`/`NamedKey` added.
- **[P18]** All test invocations are `pnpm -F shellbell test` (which runs `buf generate`), not bare `pnpm vitest run`.
- **[S8]** A comment records the invariant that tmux never interleaves notifications inside a `%begin`/`%end` block.
- **[S9]** `%session-changed` (present at line 3 of the recorded transcript) added to the layout-notification regex.
- **[V10]** The "first client is the command channel / promote another" rule is documented as realised by "any alive client, chosen per command".
- **[X5]** Noted that `TmuxBackend` deliberately emits no `session-added` (the Agent refreshes on `layout-changed`; `events.ts` has no `session-added` case) so nobody "fixes" it into a double broadcast.
- **[V15]** Spec 18.13 de-dup is explicitly delegated to the shipped `registry.test.ts` rather than duplicated.

**Not applied**
- **[V12]** Spec §8.11.2's "The exact range table is in Plan 04" was **stale spec text, not a plan defect** — `packages/protocol/src/width.ts` (`cellWidth`/`stringCells`) already shipped in Plan 01. Fixing it meant editing the spec, outside this plan's one-file authorisation, so it was left to a separate erratum; that erratum has since landed in the working tree (`§8.11.2` now points at the shipped `width.ts` and states "Plan 04 adds none"). **This plan correctly adds no width task** — do not create one.
