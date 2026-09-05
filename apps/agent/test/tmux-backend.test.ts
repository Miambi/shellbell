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
});
