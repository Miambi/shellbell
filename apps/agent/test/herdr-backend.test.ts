import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import { type BackendEvent, BadWindow, SessionGone } from "../src/backends/types.js";
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
    expect(
      list.map((s) => [s.id, s.title, s.cols, s.rows, s.windowNumber, s.paneIndex, s.state]),
    ).toEqual([
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
    expect(
      await b.createSession({ kind: "split", sessionId: "term_a", direction: "vertical" }),
    ).toBe("term_d");
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
        snapshot: {
          panes: { pane_id: string; terminal_id: string; workspace_id: string; tab_id: string }[];
          layouts: { tab_id: string; panes: { pane_id: string }[] }[];
        };
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

  it("keeps a fresher event-applied agent status over a snapshot requested before it (fix 4)", async () => {
    const b = await connect({ syncDebounceMs: 20 });
    events.length = 0;
    const release = herdr.gate("session.snapshot");
    // A lifecycle hint schedules a snapshot refresh; its RPC is now gated (in flight, unanswered).
    herdr.pushEvent("pane_updated", { pane: { pane_id: "w1:p1" } });
    await waitFor(() => herdr.called("session.snapshot").length === 3);

    // While that snapshot is still pending, a FRESHER status event lands for the same pane.
    herdr.pushEvent("pane.agent_status_changed", {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "idle",
    });
    await waitFor(() => types().includes("agent-state"));
    expect(agentStateEvents().map((e) => [e.sessionId, e.state])).toEqual([["term_a", "idle"]]);
    events.length = 0;

    // The snapshot's answer (still "blocked" -- it reflects the world as of BEFORE the event)
    // must not revert the pane's status, and must not re-emit a stale `agent-state` for it.
    release();
    await new Promise((r) => setTimeout(r, 60));
    expect((await b.listSessions()).find((s) => s.id === "term_a")).toMatchObject({
      state: "finished", // idle -> finished, not "blocked"
    });
    expect(types()).not.toContain("agent-state");
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
    const dir = dirname(path);
    events.length = 0;
    // Fix 3 regression guard: a restart must not leak the temp dir the original FakeHerdr's
    // socket lives in. Checking this ONE known directory (rather than counting `sb-herdr-*`
    // globally) keeps the assertion immune to `herdr-client.test.ts`'s own FakeHerdr instances
    // running concurrently in another file under vitest's default file parallelism.
    expect(existsSync(dir)).toBe(true);

    // A real restart: the server exits, the socket file goes away, every connection EOFs.
    await herdr.stop();
    await waitFor(() => idsOf("session-removed").length === 3, 3000);
    expect(idsOf("session-removed").sort()).toEqual(["term_a", "term_b", "term_c"]);
    expect(b.isConnected).toBe(false);
    expect(await b.listSessions()).toEqual([]);
    // The original's directory is gone with it (stop() already ran its cleanup).
    expect(existsSync(dir)).toBe(false);

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

    // Fix 3: the restarted FakeHerdr reused the ORIGINAL directory (recreated by `start()`), not
    // a fresh throwaway one it would then abandon -- so cleaning it up now removes THAT directory
    // (not a second, leaked one sitting on top of it).
    expect(herdr.dir).toBe(dir);
    await herdr.stop();
    expect(existsSync(dir)).toBe(false);
  });

  it("re-seeds the revision poller for a watched pane across a restart", async () => {
    // Fix 1: `onStreamEnd` clears `probes` on every disconnect but leaves `watched` alone (the
    // terminal_id survives a pane_id renumbering), so a pane the phone is still watching must
    // resume polling under its NEW pane id once the reconnect snapshot lands, without the phone
    // ever calling `setWatched` again.
    const b = await connect();
    const path = herdr.path;
    b.setWatched(["term_a"]);
    await waitFor(() => herdr.called("pane.copy_motion").some((r) => r.params.pane_id === "w1:p1"));
    events.length = 0;

    await herdr.stop();
    await waitFor(() => idsOf("session-removed").length === 3, 3000);

    herdr = new FakeHerdr(path);
    installDefaults(herdr, () => {
      const snap = snapshotResult() as {
        snapshot: {
          panes: { pane_id: string }[];
          layouts: { panes: { pane_id: string }[] }[];
        };
      };
      for (const p of snap.snapshot.panes) p.pane_id = p.pane_id.replace(":p", ":q");
      for (const l of snap.snapshot.layouts)
        for (const p of l.panes) p.pane_id = p.pane_id.replace(":p", ":q");
      return snap;
    });
    events.length = 0;
    await herdr.start();

    await waitFor(() => idsOf("session-added").includes("term_a"), 5000);
    // The poller resumes against the NEW pane id...
    await waitFor(
      () => herdr.called("pane.copy_motion").some((r) => r.params.pane_id === "w1:q1"),
      3000,
    );
    // ...and its first post-reconnect probe is treated as a change (an unknown baseline, not a
    // silent one), so a viewer whose screen went stale while the socket was down gets refreshed.
    await waitFor(() => idsOf("screen-changed").includes("term_a"), 3000);
  });
});
