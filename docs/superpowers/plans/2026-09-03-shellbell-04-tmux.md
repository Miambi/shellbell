# Shellbell Plan 04 — tmux backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions running under tmux — in Ghostty, Warp, Terminal.app, Alacritty, Kitty, WezTerm, or over SSH — appear in the app next to iTerm2 sessions, stream `%output`-driven diffs, accept input, and can be created from the phone; panes that iTerm2 already shows through `tmux -CC` are not duplicated.

**Architecture:** One long-lived `tmux -C attach-session -f ignore-size` client per tmux session provides `%output`/layout events; the first one doubles as the **command channel** (all tmux commands run through it — no child process per frame). `TmuxBackend` implements `TerminalBackend` on top of that client using `list-panes`/`list-clients` parsers, `capture-pane -e -N` + `parseSgrLine`, and `send-keys`. The registry (Plan 03) already knows how to merge and de-duplicate.

**Tech Stack:** Node 22, `@shellbell/protocol` (`parseSgrLine`, `stringCells`), tmux ≥ 3.2.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 8.11, 8.11.1, 8.12, 15 (tmux tests), 18.10–18.12. Plan 03 complete. `docs/spike-tmux.md` (Plan 01 Task 3) must exist — its escaping finding sets one constant here.

## Global Constraints

- All Plan 01/03 constraints apply.
- tmux version floor **3.2**. Only the default server socket in v1.
- Never build a shell command string. Every tmux invocation is either an argv array (`execFile`) or a line written to the control channel; text arguments on the control channel are quoted with `tmuxQuote` (Task 1).
- Control-mode output escaping: set `UNESCAPE_OCTAL` (Task 1) from `docs/spike-tmux.md` — `true` if ESC arrived as the text `\033`, `false` if it arrived as a raw byte.
- Capabilities of the tmux backend are exactly `{ subscribe: true, prompts: false, createSession: true, focus: false, history: true, absoluteLines: false }`.

---

## File structure created by this plan

```
apps/agent/
├── src/backends/tmux/
│   ├── control.ts     TmuxControl: spawn, parse, command channel, events
│   ├── keys.ts        NamedKey → tmux key name
│   ├── parse.ts       list-panes / list-clients / display-message row parsers
│   └── backend.ts     TmuxBackend
├── src/cli.ts         (modified) detect tmux and add the backend
├── scripts/spike-tmux.ts (Plan 01)
└── test/
    ├── tmux-control.test.ts  tmux-parse.test.ts  tmux-backend.test.ts  live-tmux.test.ts
    └── fixtures/tmux-transcript.txt (Plan 01)
```

---

### Task 1: `TmuxControl` — control-mode client (spec 8.11 "Control-mode clients")

**Files:**
- Create: `apps/agent/src/backends/tmux/control.ts`, `apps/agent/test/tmux-control.test.ts`

**Interfaces:**
- `tmuxQuote(s: string): string` — single-quote for tmux's parser: `'` + `s.replace(/'/g, "'\\''")` + `'`.
- `unescapeOctal(s: string): string` — replaces `\ooo` (three octal digits) with the byte, and `\\` with `\`.
- `UNESCAPE_OCTAL: boolean` (from the spike).
- `interface TmuxControlOptions { sessionId: string; socketName?: string; log; spawnImpl?: typeof spawn }`
- `class TmuxControl extends EventEmitter<{ output: [paneId: string]; layout: []; exit: []; }>`: `start(): Promise<void>` (resolves after the first `%begin/%end` block or 2 s), `command(line: string): Promise<string[]>` (rejects on `%error` or exit; 5 s timeout), `stop()`, `readonly alive: boolean`.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/tmux-control.test.ts`:
```ts
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TmuxControl, tmuxQuote, unescapeOctal } from "../src/backends/tmux/control.js";
import { createLogger } from "../src/log.js";

function fakeSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(String(d)));
  const child = { stdin, stdout, stderr: new PassThrough(), kill: () => stdout.end(), on: () => child, pid: 1 } as unknown as import("node:child_process").ChildProcess;
  const spawnImpl = (() => child) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, stdout, written };
}

describe("tmuxQuote / unescapeOctal", () => {
  it("quotes for tmux and unescapes control-mode octal", () => {
    expect(tmuxQuote("a b")).toBe("'a b'");
    expect(tmuxQuote("it's")).toBe("'it'\\''s'");
    expect(unescapeOctal("\\033[31mred\\033[0m \\\\ x")).toBe("\x1b[31mred\x1b[0m \\ x");
  });
});

describe("TmuxControl", () => {
  it("parses %begin/%end replies in order, emits %output and layout events, handles %error", async () => {
    const { spawnImpl, stdout, written } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log: createLogger({ stdout: false }), spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    const p1 = c.command("list-panes -a");
    const p2 = c.command("display-message -p x");
    expect(written.join("")).toBe("list-panes -a\ndisplay-message -p x\n");
    stdout.write("%output %3 hello\n%begin 2 1 0\n%3\tmain\n%end 2 1 0\n%layout-change @1 xyz\n%begin 3 2 0\n%error 3 2 0\n");
    expect(await p1).toEqual(["%3\tmain"]);
    await expect(p2).rejects.toThrow(/tmux error/);
    expect(outputs).toEqual(["%3"]);
    expect(layouts).toBe(1);
    c.stop();
  });

  it("rejects pending commands and emits exit when the process ends", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log: createLogger({ stdout: false }), spawnImpl });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    let exited = 0;
    c.on("exit", () => exited++);
    const p = c.command("list-panes -a");
    stdout.write("%exit\n");
    stdout.end();
    await expect(p).rejects.toThrow(/exited/);
    await new Promise((r) => setTimeout(r, 10));
    expect(exited).toBe(1);
    expect(c.alive).toBe(false);
  });

  it("replays the recorded spike transcript without throwing", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const file = new URL("./fixtures/tmux-transcript.txt", import.meta.url);
    if (!existsSync(file)) return;
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log: createLogger({ stdout: false }), spawnImpl });
    const started = c.start();
    stdout.write(readFileSync(file, "utf8"));
    await started;
    c.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd apps/agent && pnpm test`.

- [ ] **Step 3: Implement `control.ts`**

`apps/agent/src/backends/tmux/control.ts`:
```ts
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Logger } from "../../log.js";

/** From docs/spike-tmux.md (tmux 3.7c): ESC arrives as a literal 0x1B byte inside %begin/%end, so no unescaping. */
export const UNESCAPE_OCTAL = false;

export function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function unescapeOctal(s: string): string {
  return s.replace(/\\(\\|[0-7]{3})/g, (_m, g: string) => (g === "\\" ? "\\" : String.fromCharCode(Number.parseInt(g, 8))));
}

export interface TmuxControlOptions {
  sessionId: string;
  socketName?: string;
  log: Logger;
  spawnImpl?: typeof spawn;
  commandTimeoutMs?: number;
}

interface Pending {
  resolve: (lines: string[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class TmuxControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  private child: ChildProcess | null = null;
  private queue: Pending[] = [];
  private current: { lines: string[] } | null = null;
  private currentPending: Pending | null = null;
  private started = false;
  alive = false;
  private readonly log: Logger;

  constructor(private readonly opts: TmuxControlOptions) {
    super();
    this.log = opts.log.child({ backend: "tmux", session: opts.sessionId });
  }

  start(): Promise<void> {
    const args = [...(this.opts.socketName ? ["-L", this.opts.socketName] : []), "-C", "attach-session", "-t", this.opts.sessionId, "-f", "ignore-size"];
    const child = (this.opts.spawnImpl ?? spawn)("tmux", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.alive = true;
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    let firstBlock: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      firstBlock = resolve;
      setTimeout(resolve, 2000);
    });
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
          firstBlock?.();
          return;
        }
        if (pending) {
          clearTimeout(pending.timer);
          if (line.startsWith("%error")) pending.reject(new Error(`tmux error: ${(block?.lines ?? []).join(" ")}`));
          else pending.resolve((block?.lines ?? []).map((l) => (UNESCAPE_OCTAL ? unescapeOctal(l) : l)));
        }
        return;
      }
      if (this.current) {
        this.current.lines.push(line);
        return;
      }
      if (line.startsWith("%output ")) {
        const pane = line.slice(8).split(" ")[0];
        if (pane) this.emit("output", pane);
        return;
      }
      if (/^%(layout-change|window-add|window-close|window-renamed|unlinked-window-|session-renamed|sessions-changed)/.test(line)) {
        this.emit("layout");
        return;
      }
      if (line.startsWith("%exit")) this.onExit();
    });
    rl.on("close", () => this.onExit());
    child.on("exit", () => this.onExit());
    child.stderr?.on("data", (d) => this.log.debug("tmux stderr", { text: String(d).slice(0, 200) }));
    return ready;
  }

  command(line: string): Promise<string[]> {
    if (!this.alive || !this.child?.stdin) return Promise.reject(new Error("tmux control exited"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error(`tmux command timeout: ${line.slice(0, 40)}`));
      }, this.opts.commandTimeoutMs ?? 5000);
      const pending: Pending = { resolve, reject, timer };
      this.queue.push(pending);
      this.child?.stdin?.write(`${line}\n`);
    });
  }

  stop(): void {
    this.child?.stdin?.write("detach-client\n");
    this.child?.kill();
    this.onExit();
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
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

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. If the transcript replay throws, adjust `UNESCAPE_OCTAL` per the spike, not the parser.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): tmux control-mode client with command channel"
```

---

### Task 2: Row parsers and key table (spec 8.11 "Listing", "Input")

**Files:**
- Create: `apps/agent/src/backends/tmux/parse.ts`, `apps/agent/src/backends/tmux/keys.ts`, `apps/agent/test/tmux-parse.test.ts`

**Interfaces:**
- `LIST_PANES_FORMAT: string` (the exact `-F` string from spec 8.11), `parsePaneRow(row: string): PaneRow` where `PaneRow = { paneId; sessionId; sessionName; windowId; windowIndex; windowName; paneIndex; paneTitle; cwd; width; height; paneActive; windowActive; historySize; cursorX; cursorY; dead; currentCommand }`, `parseClientRow(row): { sessionId: string; controlMode: boolean }`, `parseDisplay(row): { cursorX; cursorY; historySize; width; height }`, `titleFor(p: PaneRow, hostname: string): string`.
- `tmuxKeyName(k: NamedKey): string`.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/tmux-parse.test.ts`:
```ts
import { NamedKeySchema } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { tmuxKeyName } from "../src/backends/tmux/keys.js";
import { LIST_PANES_FORMAT, parseClientRow, parseDisplay, parsePaneRow, titleFor } from "../src/backends/tmux/parse.js";

const row = ["%3", "$1", "work", "@2", "1", "zsh", "0", "mbp.local", "/Users/me/proj", "120", "40", "1", "1", "512", "3", "39", "0", "zsh"].join("\t");

describe("tmux parsers", () => {
  it("parses a list-panes row", () => {
    const p = parsePaneRow(row);
    expect(p).toMatchObject({ paneId: "%3", sessionId: "$1", sessionName: "work", windowId: "@2", windowIndex: 1, windowName: "zsh", paneIndex: 0, cwd: "/Users/me/proj", width: 120, height: 40, paneActive: true, windowActive: true, historySize: 512, cursorX: 3, cursorY: 39, dead: false, currentCommand: "zsh" });
    expect(LIST_PANES_FORMAT.split("\\t")).toHaveLength(18);
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
    expect(parseDisplay("3\t39\t512\t120\t40")).toEqual({ cursorX: 3, cursorY: 39, historySize: 512, width: 120, height: 40 });
  });
  it("maps every named key to a tmux key name", () => {
    for (const k of NamedKeySchema.options) expect(tmuxKeyName(k).length).toBeGreaterThan(0);
    expect(tmuxKeyName("enter")).toBe("Enter");
    expect(tmuxKeyName("shift-tab")).toBe("BTab");
    expect(tmuxKeyName("ctrl-c")).toBe("C-c");
    expect(tmuxKeyName("ctrl-space")).toBe("C-Space");
    expect(tmuxKeyName("page-down")).toBe("NPage");
    expect(tmuxKeyName("f12")).toBe("F12");
    expect(tmuxKeyName("delete")).toBe("DC");
  });
});
```

- [ ] **Step 2: Implement**

`apps/agent/src/backends/tmux/parse.ts`:
```ts
export const LIST_PANES_FORMAT =
  "#{pane_id}\\t#{session_id}\\t#{session_name}\\t#{window_id}\\t#{window_index}\\t#{window_name}\\t#{pane_index}\\t#{pane_title}\\t#{pane_current_path}\\t#{pane_width}\\t#{pane_height}\\t#{pane_active}\\t#{window_active}\\t#{history_size}\\t#{cursor_x}\\t#{cursor_y}\\t#{pane_dead}\\t#{pane_current_command}";
export const LIST_CLIENTS_FORMAT = "#{client_session}\\t#{client_control_mode}";
export const DISPLAY_FORMAT = "#{cursor_x}\\t#{cursor_y}\\t#{history_size}\\t#{pane_width}\\t#{pane_height}";

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

export function parseDisplay(row: string): { cursorX: number; cursorY: number; historySize: number; width: number; height: number } {
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
import type { NamedKey } from "@shellbell/protocol";

const FIXED: Record<string, string> = {
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

export function tmuxKeyName(k: NamedKey): string {
  const fixed = FIXED[k];
  if (fixed) return fixed;
  if (k.startsWith("ctrl-")) return `C-${k.slice(5)}`;
  if (/^f\d+$/.test(k)) return k.toUpperCase();
  throw new Error(`no tmux key for ${k}`);
}
```

- [ ] **Step 3: Run tests** — `pnpm test` → PASS. **Commit:** `git add apps/agent && git commit -m "feat(agent): tmux row parsers and key table"`.

---

### Task 3: `TmuxBackend` (spec 8.11 Listing/Screen/History/Input/Create, 8.12 hooks)

**Files:**
- Create: `apps/agent/src/backends/tmux/backend.ts`, `apps/agent/test/tmux-backend.test.ts`

**Interfaces:**
- `TmuxBackendOptions { log; socketName?: string; hostname?: string; controlFactory?: (sessionId: string) => TmuxControl; execImpl?: (args: string[]) => Promise<string> /* for list-sessions and version */; watchIntervalMs?: 5000 }`
- `class TmuxBackend implements TerminalBackend` with `tmuxWindowIdOf(nativeId)`; `static async detect(execImpl?): Promise<{ ok: boolean; version: string; reason?: string }>` (version ≥ 3.2 and `list-sessions` exits 0).

- [ ] **Step 1: Write the failing tests** (fake `TmuxControl` scripted by command prefix)

`apps/agent/test/tmux-backend.test.ts`:
```ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { createLogger } from "../src/log.js";

class FakeControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  alive = true;
  commands: string[] = [];
  screen = ["\x1b[1mhello\x1b[0m", "world", ""];
  history = ["h1", "h2", "h3"];
  constructor(readonly sessionId: string) {
    super();
  }
  async start() {}
  stop() {
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
    if (line.startsWith("display-message")) return ["4\t1\t3\t10\t3"];
    if (line.startsWith("capture-pane") && line.includes("-S")) {
      const m = /-S (-?\d+) -E (-?\d+)/.exec(line) as RegExpExecArray;
      const s = Number(m[1]);
      const e = Number(m[2]);
      return this.history.slice(this.history.length + s, this.history.length + e + 1);
    }
    if (line.startsWith("capture-pane")) return this.screen;
    if (line.startsWith("send-keys")) return [];
    if (line.startsWith("new-window") || line.startsWith("new-session") || line.startsWith("split-window")) return ["%9"];
    throw new Error(`unexpected ${line}`);
  }
}

const log = createLogger({ stdout: false });
const exec = async (args: string[]) => (args[0] === "-V" ? "tmux 3.4\n" : "$0\n");

describe("TmuxBackend", () => {
  it("detects version and server", async () => {
    expect(await TmuxBackend.detect(exec)).toMatchObject({ ok: true, version: "3.4" });
    expect(await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.1\n" : "$0\n"))).toMatchObject({ ok: false });
    expect(await TmuxBackend.detect(async (a) => { if (a[0] === "-V") return "tmux 3.4\n"; throw new Error("no server"); })).toMatchObject({ ok: false });
  });

  it("lists panes with titles, focus from non-control clients, window ids for de-dup", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: (sid) => { const c = new FakeControl(sid); controls.push(c); return c as unknown as TmuxControl; } });
    await b.connect();
    const list = await b.listSessions();
    expect(list.map((s) => [s.id, s.title, s.cwd, s.isFocusedOnMac, s.windowId, s.tabId])).toEqual([
      ["%1", "main:0.0", "/tmp", true, "$0", "@0"],
      ["%2", "build", "/tmp", false, "$0", "@1"],
    ]);
    expect(b.tmuxWindowIdOf("%2")).toBe("@1");
    expect(b.capabilities.absoluteLines).toBe(false);
  });

  it("getScreen parses SGR rows over the command channel and reports history_size", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: (sid) => new FakeControl(sid) as unknown as TmuxControl });
    await b.connect();
    const s = await b.getScreen("%1");
    expect(s.lines[0]).toEqual({ r: [{ t: "hello", b: true }] });
    expect(s.lines[1]).toEqual({ r: [{ t: "world" }] });
    expect(s.rows).toBe(3);
    expect(s.cursor).toEqual({ x: 4, y: 1 });
    expect(s.scrollbackTotal).toBe(3);
  });

  it("history range arithmetic uses the tracker's reported value", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: (sid) => new FakeControl(sid) as unknown as TmuxControl });
    await b.connect();
    b.setReported("%1", 3);
    const h = await b.getHistory("%1", 3, 2);
    expect(h.lines.map((l) => l.r[0]?.t)).toEqual(["h2", "h3"]);
    expect(h.oldestAvailable).toBe(0);
  });

  it("sendText strips trailing CR into Enter; named keys map; %output becomes screen-changed", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: () => control as unknown as TmuxControl });
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type));
    await b.sendText("%1", "ls -la\r");
    expect(control.commands.filter((c) => c.startsWith("send-keys"))).toEqual(["send-keys -t %1 -l -- 'ls -la'", "send-keys -t %1 Enter"]);
    await b.sendText("%1", "\x03");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 C-c");
    control.emit("output", "%1");
    expect(events).toEqual(["screen-changed"]);
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -h");
    await expect(b.focus("%1")).rejects.toThrow(/unsupported/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `backend.ts`**

`apps/agent/src/backends/tmux/backend.ts`:
```ts
import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import { NAMED_KEYS, parseSgrLine, type Capabilities, type CreateWhere, type Line, type SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import { BackendUnavailable, SessionGone, Unsupported, type BackendEvent, type Screen, type TerminalBackend } from "../types.js";
import { TmuxControl, tmuxQuote } from "./control.js";
import { tmuxKeyName } from "./keys.js";
import { DISPLAY_FORMAT, LIST_CLIENTS_FORMAT, LIST_PANES_FORMAT, parseClientRow, parseDisplay, parsePaneRow, titleFor, type PaneRow } from "./parse.js";

const run = promisify(execFile);
const BYTES_TO_KEY = new Map(Object.entries(NAMED_KEYS).map(([k, v]) => [v, k]));

export interface TmuxBackendOptions {
  log: Logger;
  socketName?: string;
  hostname?: string;
  controlFactory?: (sessionId: string) => TmuxControl;
  execImpl?: (args: string[]) => Promise<string>;
  watchIntervalMs?: number;
}

export class TmuxBackend implements TerminalBackend {
  readonly name = "tmux" as const;
  readonly capabilities: Capabilities = { subscribe: true, prompts: false, createSession: true, focus: false, history: true, absoluteLines: false };
  private controls = new Map<string, TmuxControl>();
  private panes = new Map<string, PaneRow>();
  private reported = new Map<string, number>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private watcher: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly exec: (args: string[]) => Promise<string>;

  constructor(private readonly opts: TmuxBackendOptions) {
    this.log = opts.log.child({ backend: "tmux" });
    this.exec = opts.execImpl ?? (async (args) => (await run("tmux", [...(opts.socketName ? ["-L", opts.socketName] : []), ...args])).stdout);
  }

  static async detect(execImpl?: (args: string[]) => Promise<string>): Promise<{ ok: boolean; version: string; reason?: string }> {
    const exec = execImpl ?? (async (args) => (await run("tmux", args)).stdout);
    let version = "";
    try {
      version = (await exec(["-V"])).replace(/[^0-9.]/g, "").trim();
    } catch {
      return { ok: false, version: "", reason: "tmux not found" };
    }
    if (Number.parseFloat(version) < 3.2) return { ok: false, version, reason: `tmux 3.2+ required for Shellbell (found ${version})` };
    try {
      await exec(["list-sessions", "-F", "#{session_id}"]);
    } catch {
      return { ok: false, version, reason: "no tmux server running" };
    }
    return { ok: true, version };
  }

  async connect(): Promise<void> {
    const d = await TmuxBackend.detect(this.exec);
    if (!d.ok) throw new BackendUnavailable(d.reason ?? "tmux unavailable", "brew install tmux (3.2+) and start a session");
    await this.syncControls();
    await this.refreshPanes();
    this.watcher = setInterval(() => void this.syncControls().then(() => this.refreshPanes()), this.opts.watchIntervalMs ?? 5000);
  }

  async close(): Promise<void> {
    if (this.watcher) clearInterval(this.watcher);
    for (const c of this.controls.values()) c.stop();
    this.controls.clear();
  }

  private channel(): TmuxControl {
    const c = [...this.controls.values()].find((x) => x.alive);
    if (!c) throw new SessionGone("tmux command channel");
    return c;
  }

  private async syncControls(): Promise<void> {
    let ids: string[];
    try {
      ids = (await this.exec(["list-sessions", "-F", "#{session_id}"])).split("\n").filter(Boolean);
    } catch {
      ids = [];
    }
    for (const [id, c] of this.controls) {
      if (!ids.includes(id) || !c.alive) {
        c.stop();
        this.controls.delete(id);
      }
    }
    for (const id of ids) {
      if (this.controls.has(id)) continue;
      const c = (this.opts.controlFactory ?? ((sid) => new TmuxControl({ sessionId: sid, socketName: this.opts.socketName, log: this.opts.log })))(id);
      c.on("output", (pane) => this.emit({ type: "screen-changed", sessionId: pane }));
      c.on("layout", () => this.scheduleRefresh());
      c.on("exit", () => {
        this.controls.delete(id);
        this.scheduleRefresh();
      });
      this.controls.set(id, c);
      await c.start();
    }
  }

  private refreshTimer: NodeJS.Timeout | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshPanes();
    }, 100);
  }

  private async refreshPanes(): Promise<void> {
    if (this.controls.size === 0) {
      const had = this.panes.size;
      this.panes.clear();
      if (had) this.emit({ type: "layout-changed" });
      return;
    }
    try {
      const rows = (await this.channel().command(`list-panes -a -F ${tmuxQuote(LIST_PANES_FORMAT.replace(/\\t/g, "\t"))}`)).map(parsePaneRow);
      const next = new Map(rows.filter((r) => !r.dead).map((r) => [r.paneId, r]));
      for (const id of this.panes.keys()) if (!next.has(id)) this.emit({ type: "session-removed", sessionId: id });
      this.panes = next;
      this.emit({ type: "layout-changed" });
    } catch (err) {
      this.log.warn("list-panes failed", { err: String(err) });
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    let attached = new Set<string>();
    try {
      const rows = (await this.channel().command(`list-clients -F ${tmuxQuote(LIST_CLIENTS_FORMAT.replace(/\\t/g, "\t"))}`)).map(parseClientRow);
      attached = new Set(rows.filter((r) => !r.controlMode).map((r) => r.sessionId));
    } catch {
      attached = new Set();
    }
    const host = this.opts.hostname ?? osHostname();
    const sessionOrder = [...new Set([...this.panes.values()].map((p) => p.sessionId))];
    return [...this.panes.values()]
      .sort((a, b) => sessionOrder.indexOf(a.sessionId) - sessionOrder.indexOf(b.sessionId) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex)
      .map((p) => ({
        id: p.paneId,
        backend: "tmux",
        title: titleFor(p, host),
        cwd: p.cwd || undefined,
        cols: p.width,
        rows: p.height,
        windowId: p.sessionId,
        windowNumber: sessionOrder.indexOf(p.sessionId),
        tabId: p.windowId,
        tabIndex: p.windowIndex,
        paneIndex: p.paneIndex,
        isFocusedOnMac: p.paneActive && p.windowActive && attached.has(p.sessionId),
        state: "unknown",
      }));
  }

  tmuxWindowIdOf(nativeId: string): string | undefined {
    return this.panes.get(nativeId)?.windowId;
  }

  /** The tracker's monotonic scrollbackTotal for this pane; needed for history offsets. */
  setReported(paneId: string, value: number): void {
    this.reported.set(paneId, value);
  }

  async getScreen(paneId: string): Promise<Screen> {
    if (!this.panes.has(paneId)) throw new SessionGone(paneId);
    const ch = this.channel();
    const [rows, disp] = await Promise.all([ch.command(`capture-pane -p -e -N -t ${paneId}`), ch.command(`display-message -p -t ${paneId} ${tmuxQuote(DISPLAY_FORMAT.replace(/\\t/g, "\t"))}`)]);
    const d = parseDisplay(disp[0] ?? "");
    const lines: Line[] = rows.map(parseSgrLine);
    while (lines.length < d.height) lines.push({ r: [] });
    if (lines.length > d.height) lines.length = d.height;
    return { cols: d.width, rows: d.height, cursor: { x: d.cursorX, y: d.cursorY }, lines, scrollbackTotal: d.historySize };
  }

  async getHistory(paneId: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }> {
    if (!this.panes.has(paneId)) throw new SessionGone(paneId);
    const ch = this.channel();
    const d = parseDisplay((await ch.command(`display-message -p -t ${paneId} ${tmuxQuote(DISPLAY_FORMAT.replace(/\\t/g, "\t"))}`))[0] ?? "");
    const reported = this.reported.get(paneId) ?? d.historySize;
    const oldestAvailable = Math.max(0, reported - d.historySize);
    const e = before - 1 - reported;
    const s = Math.max(before - count - reported, -d.historySize);
    if (e < s || e > -1) return { lines: [], oldestAvailable };
    const rows = await ch.command(`capture-pane -p -e -N -t ${paneId} -S ${s} -E ${e}`);
    return { lines: rows.map(parseSgrLine), oldestAvailable };
  }

  async sendText(paneId: string, text: string): Promise<void> {
    if (!this.panes.has(paneId)) throw new SessionGone(paneId);
    const ch = this.channel();
    const key = BYTES_TO_KEY.get(text);
    if (key && text !== "\r" && text !== "\t") {
      await ch.command(`send-keys -t ${paneId} ${tmuxKeyName(key as never)}`);
      return;
    }
    const enter = text.endsWith("\r");
    const body = enter ? text.slice(0, -1) : text;
    if (body) await ch.command(`send-keys -t ${paneId} -l -- ${tmuxQuote(body)}`);
    if (enter) await ch.command(`send-keys -t ${paneId} Enter`);
  }

  async createSession(where: CreateWhere): Promise<string> {
    const ch = this.channel();
    if (where.kind === "split") {
      const out = await ch.command(`split-window -P -F '#{pane_id}' -t ${where.sessionId} ${where.direction === "vertical" ? "-h" : "-v"}`);
      return out[0] ?? "";
    }
    const out = where.windowId ? await ch.command(`new-window -P -F '#{pane_id}' -t ${where.windowId}`) : await ch.command("new-session -d -P -F '#{pane_id}'");
    this.scheduleRefresh();
    return out[0] ?? "";
  }

  async focus(_paneId: string): Promise<void> {
    throw new Unsupported("focus");
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }
}
```

Note on `sendText`: a single named-key byte sequence (from `input.key`) is recognised by reverse lookup and sent as a tmux key name; `\r` alone becomes `Enter`; `\t` is sent literally via `-l`.

- [ ] **Step 4: Wire `reported` from the tracker** — in `apps/agent/src/screen-tracker.ts`, after `s.reported` changes in `processScreen`, call `(this.opts.backend as { setReported?: (id: string, v: number) => void }).setReported?.(sessionId, s.reported)`. The registry forwards it: add to `BackendRegistry` a `setReported(id, v)` that strips the prefix and calls the member's `setReported` if present. Add a unit test in `registry.test.ts`: `reg.setReported("tmux:%2", 7)` reaches the tmux fake.

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): tmux backend over the control channel"
```

---

### Task 4: Wire tmux into the CLI and doctor; live test (spec 8.12 detection, 15)

**Files:**
- Modify: `apps/agent/src/cli.ts` — in `buildAgent`, after the iTerm2 setup: detect tmux every 10 s while absent; when `TmuxBackend.detect()` is ok, create `new TmuxBackend({ log })`, `connect()`, `registry.add(tmux)`; on `BackendUnavailable` retry in 10 s; if the backend later reports no controls (server died), `registry.remove("tmux")` and go back to detecting.
- Create: `apps/agent/test/live-tmux.test.ts`

- [ ] **Step 1: CLI wiring** — add to `buildAgent`:
```ts
  const { TmuxBackend } = await import("./backends/tmux/backend.js");
  const tryTmux = async () => {
    const d = await TmuxBackend.detect();
    if (!d.ok) {
      log.debug("tmux not available", { reason: d.reason });
      setTimeout(tryTmux, 10_000);
      return;
    }
    const tmux = new TmuxBackend({ log });
    try {
      await tmux.connect();
      registry.add(tmux);
      log.info("tmux connected", { version: d.version });
    } catch (err) {
      log.warn("tmux connect failed", { err: String(err) });
      setTimeout(tryTmux, 10_000);
    }
  };
  void tryTmux();
```
Also print a `tmux` line in the `start` banner (`connected · N sessions` / `not running`).

- [ ] **Step 2: Live test**

`apps/agent/test/live-tmux.test.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const live = process.env.SHELLBELL_TMUX_E2E === "1";
const SOCK = "shellbell-test";

describe.skipIf(!live)("live tmux", () => {
  beforeAll(async () => {
    await run("tmux", ["-L", SOCK, "new-session", "-d", "-s", "t", "-x", "60", "-y", "10"]);
    await run("tmux", ["-L", SOCK, "send-keys", "-t", "t", "printf '\\e[31mred\\e[0m plain\\n'", "Enter"]);
    await new Promise((r) => setTimeout(r, 300));
  });
  afterAll(async () => {
    await run("tmux", ["-L", SOCK, "kill-server"]).catch(() => undefined);
  });

  it("streams %output, captures styled rows, sends keys, reads history", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const b = new TmuxBackend({ log, socketName: SOCK });
    await b.connect();
    const changed: string[] = [];
    b.on((e) => e.type === "screen-changed" && changed.push(e.sessionId));
    const [s] = await b.listSessions();
    if (!s) throw new Error("no pane");
    const screen = await b.getScreen(s.id);
    const styled = screen.lines.find((l) => l.r.some((r) => r.fg === 1 && r.t === "red"));
    expect(styled).toBeTruthy();
    await b.sendText(s.id, "echo shellbell-tmux-ok\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(changed.length).toBeGreaterThan(0);
    const after = await b.getScreen(s.id);
    expect(after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n")).toContain("shellbell-tmux-ok");
    await b.close();
  }, 20_000);
});
```

- [ ] **Step 3: Run it for real** — `SHELLBELL_TMUX_E2E=1 pnpm vitest run test/live-tmux.test.ts` → PASS. Then run the full agent with a GUI terminal attached to a tmux session and confirm via `shellbell status --json` that tmux sessions are listed.

- [ ] **Step 4: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): detect and attach the tmux backend; live tmux test"
```

---

## Plan self-review

- **Spec coverage:** control-mode clients + command channel + octal unescape → Task 1; listing/title/focus rules and key names → Task 2; screen/history/input/create/focus-unsupported, `reported` plumbing for history offsets → Task 3; detection and CLI wiring, live test → Task 4; de-dup with iTerm2 `-CC` is exercised by Plan 03's registry test with `tmuxWindowIdOf` (Task 3 implements it).
- **Type consistency:** `TmuxControl`'s event names (`output`, `layout`, `exit`) match `FakeControl`; `PaneRow` fields match the 18-column format; `TmuxBackend.setReported` is called through the registry by the tracker (Task 3 Step 4); capabilities literal matches the spec.
- **Placeholders:** none. `UNESCAPE_OCTAL` is a decision recorded in `docs/spike-tmux.md`.
