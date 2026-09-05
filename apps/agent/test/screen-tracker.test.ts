import type { InnerMessage } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
const text = (m: InnerMessage) =>
  (m.type === "screen.snapshot"
    ? m.lines
    : m.type === "screen.diff"
      ? m.changed.map((c) => c.line)
      : []
  ).map((l) => l.r[0]?.t ?? "");

let backend: FakeBackend;
let sent: { conn: string; msg: InnerMessage }[];
let tracker: ScreenTracker;

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  backend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
  sent = [];
  tracker = new ScreenTracker({
    backend,
    sink: (conn, msg) => sent.push({ conn, msg }),
    log,
    now: () => Date.now(),
  });
  tracker.start();
});
afterEach(() => {
  tracker.stop();
  vi.useRealTimers();
});

const flush = async () => {
  await vi.advanceTimersByTimeAsync(130);
};

describe("ScreenTracker", () => {
  it("snapshot on view; diff with scroll when tailing; nothing when no viewers", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent[0]?.msg.type).toBe("screen.snapshot");
    expect(text(sent[0]?.msg as InnerMessage)).toEqual(["a", "b", "c"]);
    backend.appendLine("S", "d");
    tracker.markDirty("S"); // idempotent: the tracker also hears screen-changed itself
    await flush();
    const diff = sent[1]?.msg;
    expect(diff?.type).toBe("screen.diff");
    if (diff?.type !== "screen.diff") throw new Error();
    expect(diff.scroll).toBe(1);
    expect(diff.changed).toEqual([{ i: 2, line: { r: [{ t: "d" }] } }]);
    expect(diff.scrollbackTotal).toBe(11);
    expect(diff.gen).toBe(2);
    tracker.setViewed("p1", null);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    expect(sent.length).toBe(2);
  });

  it("saturated history: detects scroll by overlap and keeps a monotonic scrollbackTotal", async () => {
    backend.saturated = true;
    backend.capabilities = { ...backend.capabilities, absoluteLines: false };
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    const diff = sent[1]?.msg;
    if (diff?.type !== "screen.diff") throw new Error(`expected diff, got ${diff?.type}`);
    expect(diff.scroll).toBe(1);
    expect(diff.scrollbackTotal).toBe(11);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    const msg2 = sent[2]?.msg as { scrollbackTotal: number } | undefined;
    expect(msg2?.scrollbackTotal).toBe(12);
  });

  it("clear → snapshot with reset; >60% change → snapshot", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.clear("S");
    tracker.markDirty("S");
    await flush();
    const snap = sent[1]?.msg;
    expect(snap?.type).toBe("screen.snapshot");
    expect((snap as { reset?: boolean }).reset).toBe(true);
    backend.setLines("S", ["x", "y", "z"]);
    tracker.markDirty("S");
    await flush();
    expect(sent[2]?.msg.type).toBe("screen.snapshot");
    const msg3 = sent[2]?.msg as { reset?: boolean } | undefined;
    expect(msg3?.reset).toBeUndefined();
  });

  it("a lagging viewer gets a snapshot; an up-to-date viewer gets the diff", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    tracker.setViewed("p2", "S"); // joins at gen 2 → snapshot
    await flush();
    expect(sent.filter((s) => s.conn === "p2").map((s) => s.msg.type)).toEqual(["screen.snapshot"]);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    const last = sent
      .slice(-2)
      .map((s) => [s.conn, s.msg.type].join(":"))
      .sort();
    expect(last).toEqual(["p1:screen.diff", "p2:screen.diff"]);
  });

  it("forceSnapshot sends a fresh snapshot to one viewer", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.forceSnapshot("p1", "S");
    await flush();
    expect(sent.map((s) => s.msg.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
  });

  it("does not poll unviewed sessions and coalesces bursts into one getScreen per tick", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    const before = backend.getScreenCalls;
    for (let i = 0; i < 10; i++) backend.appendLine("S", `l${i}`);
    tracker.markDirty("S");
    await flush();
    expect(backend.getScreenCalls - before).toBe(1);
  });

  it("session removal drops viewers silently", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.sessionRemoved("S");
    expect(tracker.viewedBy("S")).toEqual([]);
  });

  it("marks dirty from the backend's own screen-changed event, with no explicit markDirty", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent).toHaveLength(1);
    backend.appendLine("S", "d"); // emits screen-changed; the tracker subscribed in start()
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.msg.type).toBe("screen.diff");
  });

  it("caps TOTAL sink calls per second across all viewers and coalesces the rest", async () => {
    // Plan 02 parked item: every frame leaves through the agent's single relay socket, which the
    // relay caps at 60 msg/s (close 4429). 10 viewers at 8 fps is 80 msg/s without a GLOBAL bucket;
    // a per-viewer cap of 40 would not stop it. 7 flushes of 130 ms stay inside one 1 s window.
    for (let i = 0; i < 10; i++) tracker.setViewed(`v${i}`, "S");
    for (let t = 0; t < 7; t++) {
      backend.appendLine("S", `line${t}`);
      tracker.markDirty("S");
      await flush();
    }
    expect(sent.length).toBeGreaterThanOrEqual(10); // at least one tick was served in full
    expect(sent.length).toBeLessThanOrEqual(40); // 70 attempts, 40 tokens
  });

  it("sends a degraded, style-stripped snapshot to a viewer coalesced 3+ consecutive ticks", async () => {
    // maxFramesPerSecond 1 means exactly one frame per 1 s window; "hog" is first in the viewer map
    // and takes it every time, so "starved" accumulates coalesced ticks.
    tracker.stop();
    sent = [];
    tracker = new ScreenTracker({
      backend,
      sink: (conn, msg) => sent.push({ conn, msg }),
      log,
      maxFramesPerSecond: 1,
      now: () => Date.now(),
    });
    tracker.start();
    tracker.setViewed("hog", "S");
    tracker.setViewed("starved", "S");
    // Each pass advances past the 1 s bucket window, so exactly one token is issued per pass.
    const pass = async () => {
      backend.appendLine("S", "out");
      tracker.markDirty("S");
      await vi.advanceTimersByTimeAsync(1100);
    };
    await pass();
    await pass();
    await pass();
    expect(sent.every((x) => x.conn === "hog")).toBe(true); // starved got nothing: 3 coalesced ticks
    tracker.dropViewer("hog");
    await pass(); // now "starved" wins the token
    const starved = sent.filter((x) => x.conn === "starved");
    expect(starved).toHaveLength(1);
    const frame = starved[0]?.msg;
    if (frame?.type !== "screen.snapshot") throw new Error(`expected snapshot, got ${frame?.type}`);
    expect(frame.degraded).toBe(true);
    // stripStyles collapses every row to at most one unstyled run
    for (const line of frame.lines) {
      expect(line.r.length).toBeLessThanOrEqual(1);
      expect(line.r[0]?.fg).toBeUndefined();
    }
  });
});
