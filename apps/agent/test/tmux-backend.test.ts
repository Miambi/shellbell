import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { SessionGone } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { waitFor } from "./fakes/wait.js";

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
        [
          "%1",
          "$0",
          "main",
          "@0",
          "0",
          "zsh",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "1",
          "3",
          "0",
          "2",
          "0",
          "zsh",
        ].join("\t"),
        [
          "%2",
          "$0",
          "main",
          "@1",
          "1",
          "build",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "0",
          "0",
          "0",
          "0",
          "0",
          "make",
        ].join("\t"),
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
    if (
      line.startsWith("new-window") ||
      line.startsWith("new-session") ||
      line.startsWith("split-window")
    ) {
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
    expect(
      await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.10\n" : "$0\n")),
    ).toMatchObject({ ok: true });
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
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
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
      subscribe: true,
      prompts: false,
      createSession: true,
      focus: false,
      history: true,
      absoluteLines: false,
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

  it("M-7: getHistory with no setReported baseline returns empty rather than guessed lines", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    // setReported("%1", ...) never ran for this pane -- the tracker only calls it after actually
    // processing a screen frame for it (e.g. the phone requested history for a session it has
    // never viewed).
    const before = control.commands.length;
    const h = await b.getHistory("%1", 3, 2);
    expect(h).toEqual({ lines: [], oldestAvailable: 0 });
    // No `display-message`/`capture-pane` round trip either -- there is nothing honest to compute.
    expect(control.commands.length).toBe(before);
    await b.close();
  });

  it("reports oldestAvailable > 0 once tmux's history saturates (spec 18.12)", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
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
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
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
      log,
      hostname: "host",
      execImpl: exec,
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
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe(
      "%9",
    );
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -h");
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "horizontal" })).toBe(
      "%9",
    );
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -v");
    expect(await b.createSession({ kind: "tab", backend: "tmux", windowId: "$0" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-window -P -F '#{pane_id}' -t $0");
    expect(await b.createSession({ kind: "tab", backend: "tmux" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-session -d -P -F '#{pane_id}'");
    // An empty reply must REJECT, never resolve to "" (the registry would ack `"tmux:"`).
    const empty = new FakeControl("$0");
    empty.command = async () => [];
    const b2 = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
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
      log,
      hostname: "host",
      execImpl: exec,
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

  it("refreshPanes emits layout-changed only when the pane SET changes (review fix 1)", async () => {
    let panes = 2;
    class VariablePanesControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          const rows = [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
            [
              "%2",
              "$0",
              "main",
              "@1",
              "1",
              "build",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "0",
              "0",
              "0",
              "0",
              "0",
              "make",
            ].join("\t"),
          ];
          return rows.slice(0, panes);
        }
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    panes = 1;
    const control = new VariablePanesControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 10,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // Two consecutive refreshes with an IDENTICAL pane set: nothing to say, nothing emitted.
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([]);

    // A new pane appears: session-added for it, then exactly one layout-changed.
    panes = 2;
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["session-added", "layout-changed"]);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1", "%2"]);

    await b.close();
  });

  it("emits exactly one title-changed (and no layout-changed) when a retained pane is renamed (R52)", async () => {
    let windowName = "zsh";
    class RenameableControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          return [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              windowName,
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
          ];
        }
        if (line.startsWith("list-clients")) return ["$0\t1", "$0\t0"];
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    const control = new RenameableControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 10,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // The pane SET is unchanged -- only its window name (and therefore displayed title) moves.
    windowName = "renamed";
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["title-changed"]);
    expect(events).not.toContain("layout-changed");
    expect((await b.listSessions())[0]?.title).toBe("renamed");

    await b.close();
  });

  it("createSession validates the target against known ids before touching a command line (review fix 2)", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();

    // A phone-supplied id that is not a known pane must reject with SessionGone and never reach
    // the command line unvalidated -- an unsanitised interpolation would let `;` inject a second
    // tmux command.
    control.commands.length = 0;
    await expect(
      b.createSession({ kind: "split", sessionId: "%1 ; kill-server", direction: "vertical" }),
    ).rejects.toBeInstanceOf(SessionGone);
    expect(control.commands).toEqual([]);

    // Same for a `windowId` that is not a known tmux session id.
    await expect(
      b.createSession({ kind: "tab", backend: "tmux", windowId: "$99 ; kill-server" }),
    ).rejects.toBeInstanceOf(SessionGone);
    expect(control.commands).toEqual([]);

    // The legitimate paths still work.
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe(
      "%9",
    );
    await b.close();
  });

  it("a hung exec() times out; syncBusy releases and the next syncControls still runs (review fix 3)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const controls: FakeControl[] = [];
      const hangingExec = (args: string[]): Promise<string> => {
        calls++;
        if (args[0] === "-V") return Promise.resolve("tmux 3.4\n");
        // The THIRD call is `syncControls()`'s own `list-sessions` inside `connect()` (the first
        // two are `detect()`'s `-V` and its own server-check `list-sessions`) -- simulate a
        // wedged tmux server that never answers it.
        if (calls === 3) return new Promise<string>(() => {});
        return Promise.resolve("$0\n");
      };
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: hangingExec,
        controlFactory: factory(controls),
        watchIntervalMs: 5000,
      });
      const connectPromise = b.connect();
      // Matches the backend's internal `EXEC_TIMEOUT_MS` (not exported); advancing past it lets
      // the hung call's timeout fire.
      await vi.advanceTimersByTimeAsync(5000);
      await connectPromise;
      // The hung call rejected (timed out) rather than wedging connect(); I-1: a FAILED probe is
      // treated as transient, not "no sessions", so it leaves the (here, still-empty, since this
      // is the very first sync) client set untouched rather than actively tearing anything down.
      expect(controls.length).toBe(0);

      // Proof `syncBusy` was released: the NEXT syncControls, via the 5 s watcher, still runs.
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls.length).toBe(1);
      expect(b.isConnected).toBe(true);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("I-1: a transient list-sessions failure on a LATER tick leaves existing clients and panes intact", async () => {
    let fail = false;
    const controls: FakeControl[] = [];
    const flakyExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") {
        if (fail) throw new Error("ETIMEDOUT");
        return "$0\n";
      }
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: flakyExec,
      controlFactory: factory(controls),
      watchIntervalMs: 20,
    });
    await b.connect();
    expect(controls).toHaveLength(1);
    expect(b.isConnected).toBe(true);
    expect((await b.listSessions()).length).toBeGreaterThan(0);

    // A later watcher tick's list-sessions probe fails transiently (timeout/EAGAIN/a momentarily
    // busy server) -- this must NOT be treated as "no sessions": the already-alive control client
    // and its panes must survive untouched, and `isConnected` must not flip.
    fail = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(controls).toHaveLength(1);
    expect(controls[0]?.alive).toBe(true);
    expect(b.isConnected).toBe(true);
    expect((await b.listSessions()).length).toBeGreaterThan(0);

    await b.close();
  });

  it("a genuinely empty list-sessions (real tmux server with no sessions left) still tears everything down", async () => {
    let empty = false;
    const controls: FakeControl[] = [];
    const varExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") return empty ? "" : "$0\n";
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: varExec,
      controlFactory: factory(controls),
      watchIntervalMs: 20,
    });
    await b.connect();
    expect(controls).toHaveLength(1);
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // A genuinely SUCCESSFUL probe that returns no sessions is the real "no sessions" case (spec
    // 8.11's own %exit path arrives the same way in production) -- this one still tears down.
    empty = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(controls.every((c) => !c.alive)).toBe(true);
    expect(await b.listSessions()).toEqual([]);
    expect(events).toContain("session-removed");
    expect(events).toContain("layout-changed");
    expect(b.isConnected).toBe(false);

    await b.close();
  });

  it("M-4: close() landing during connect() must not arm a watcher afterwards", async () => {
    const resolver: { resolve: ((v: string) => void) | null } = { resolve: null };
    const gate = new Promise<string>((r) => {
      resolver.resolve = r;
    });
    let listCalls = 0;
    const controls: FakeControl[] = [];
    const slowExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") {
        listCalls++;
        // The FIRST call is `detect()`'s own server-check; let it resolve immediately so
        // `connect()` reaches `syncControls()`. The SECOND is `syncControls()`'s own probe inside
        // `connect()` -- stall it so `close()` can land while `connect()` is still in flight.
        if (listCalls === 1) return "$0\n";
        return gate;
      }
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: slowExec,
      controlFactory: factory(controls),
    });
    const connectPromise = b.connect();
    await waitFor(() => listCalls >= 2, 2000);
    await b.close();

    const realSetInterval = global.setInterval;
    let intervalCalls = 0;
    global.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      intervalCalls++;
      return realSetInterval(fn, ms, ...rest);
    }) as typeof setInterval;
    try {
      resolver.resolve?.("$0\n");
      await connectPromise;
    } finally {
      global.setInterval = realSetInterval;
    }
    // The `if (this.closed) return;` guard (M-4) must stop `connect()` from ever reaching the
    // `setInterval(...)` line once a close() has landed during its awaits.
    expect(intervalCalls).toBe(0);
    expect(b.isConnected).toBe(false);
    expect(controls).toHaveLength(0);
  });

  it("getScreen queries display-message before capture-pane (review fix 4)", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    control.commands.length = 0;
    await b.getScreen("%1");
    const order = control.commands.filter(
      (c) => c.startsWith("display-message") || c.startsWith("capture-pane"),
    );
    expect(order[0]?.startsWith("display-message")).toBe(true);
    expect(order[1]?.startsWith("capture-pane")).toBe(true);
    await b.close();
  });

  it("channel() prefers the pane's own tmux session client over an unrelated alive one (review fix 5)", async () => {
    const sessionIds = ["$0", "$1"];
    class TwoSessionControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          return [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
            [
              "%2",
              "$1",
              "side",
              "@1",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "0",
              "0",
              "0",
              "0",
              "zsh",
            ].join("\t"),
          ];
        }
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    const controls = new Map<string, TwoSessionControl>();
    const execImpl = async (args: string[]) =>
      args[0] === "-V" ? "tmux 3.4\n" : `${sessionIds.join("\n")}\n`;
    const controlFactory = (sid: string) => {
      const c = new TwoSessionControl(sid);
      controls.set(sid, c);
      return c as unknown as TmuxControl;
    };
    const b = new TmuxBackend({ log, hostname: "host", execImpl, controlFactory });
    await b.connect();

    await b.getScreen("%2");
    expect(controls.get("$1")?.commands.some((c) => c.startsWith("capture-pane"))).toBe(true);
    expect(controls.get("$0")?.commands.some((c) => c.startsWith("capture-pane"))).toBe(false);

    await b.close();
  });

  it("a layout event during an in-flight refresh triggers exactly one follow-up refresh (review fix 6)", async () => {
    let listPanesCalls = 0;
    const release: { fn: (() => void) | null } = { fn: null };
    class GatedControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        if (line.startsWith("list-panes")) {
          listPanesCalls++;
          if (listPanesCalls === 2) {
            await new Promise<void>((resolve) => {
              release.fn = () => resolve();
            });
          }
        }
        return super.command(line);
      }
    }
    const control = new GatedControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 100,
    });
    vi.useFakeTimers();
    try {
      const connectPromise = b.connect();
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;
      expect(listPanesCalls).toBe(1);

      // Trigger a debounced refresh (call #2, gated open).
      control.emit("layout");
      await vi.advanceTimersByTimeAsync(100);
      expect(listPanesCalls).toBe(2);

      // A SECOND layout event arrives while that refresh is still in flight: with the fix, this
      // sets the dirty flag directly instead of arming a separate 100 ms timer.
      control.emit("layout");
      await vi.advanceTimersByTimeAsync(0);

      // Release the gated call: the dirty-loop's own catch-up runs immediately (call #3).
      release.fn?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(listPanesCalls).toBe(3);

      // No separate timer should fire later and cause a 4th call.
      await vi.advanceTimersByTimeAsync(500);
      expect(listPanesCalls).toBe(3);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("connect() is idempotent and does not leak the watcher interval (review fix 7)", async () => {
    vi.useFakeTimers();
    try {
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(),
      });
      await b.connect();
      const afterFirst = vi.getTimerCount();
      await b.connect();
      expect(vi.getTimerCount()).toBe(afterFirst);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("multi-session lifecycle: sessions appear/vanish between watcher ticks; %exit fails over to a surviving client (coverage gap)", async () => {
    vi.useFakeTimers();
    try {
      let sessionIds = ["$0"];
      class DynamicControl extends FakeControl {
        override async command(line: string): Promise<string[]> {
          this.commands.push(line);
          if (line.startsWith("list-panes")) {
            const rows: string[] = [];
            if (sessionIds.includes("$0"))
              rows.push(
                [
                  "%1",
                  "$0",
                  "main",
                  "@0",
                  "0",
                  "zsh",
                  "0",
                  "host",
                  "/tmp",
                  "10",
                  "3",
                  "1",
                  "1",
                  "3",
                  "0",
                  "2",
                  "0",
                  "zsh",
                ].join("\t"),
              );
            if (sessionIds.includes("$1"))
              rows.push(
                [
                  "%2",
                  "$1",
                  "side",
                  "@1",
                  "0",
                  "zsh",
                  "0",
                  "host",
                  "/tmp",
                  "10",
                  "3",
                  "1",
                  "1",
                  "0",
                  "0",
                  "0",
                  "0",
                  "zsh",
                ].join("\t"),
              );
            return rows;
          }
          if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
          if (line.startsWith("capture-pane")) return this.screen;
          throw new Error(`unexpected ${line.split(" ")[0]}`);
        }
      }
      const controls = new Map<string, DynamicControl>();
      const execImpl = async (args: string[]) =>
        args[0] === "-V" ? "tmux 3.4\n" : `${sessionIds.join("\n")}\n`;
      const controlFactory = (sid: string) => {
        const c = new DynamicControl(sid);
        controls.set(sid, c);
        return c as unknown as TmuxControl;
      };
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl,
        controlFactory,
        watchIntervalMs: 5000,
      });
      const events: string[] = [];
      b.on((e) => events.push(e.type));

      await b.connect();
      expect([...controls.keys()]).toEqual(["$0"]);

      // A second tmux session appears between two watcher ticks: its control client starts,
      // and its pane joins the pane map.
      sessionIds = ["$0", "$1"];
      events.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect([...controls.keys()]).toEqual(["$0", "$1"]);
      expect(controls.get("$1")?.alive).toBe(true);
      expect(events).toContain("session-added");
      expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1", "%2"]);

      // "$0"'s control client dies (%exit): "$1"'s client survives and serves as the command
      // channel for a "$0"-owned pane -- review fix 5's fallback keeps the backend working
      // through a single client's outage instead of every command failing.
      const zero = controls.get("$0") as DynamicControl;
      zero.alive = false;
      zero.emit("exit");
      const screen = await b.getScreen("%1");
      expect(screen.rows).toBeGreaterThan(0);

      // The "$1" tmux session itself vanishes (only "$0" remains): its pane is removed and its
      // control client is stopped by the next watcher tick's `syncControls`.
      sessionIds = ["$0"];
      events.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls.get("$1")?.alive).toBe(false);
      expect(events).toContain("session-removed");
      expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1"]);

      await b.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
