import { describe, expect, it } from "vitest";
import {
  applyDiff,
  applySnapshot,
  codePoints,
  emptyLine,
  type Line,
  lineKey,
  mergeRuns,
  type ScreenState,
  stripStyles,
  trimTrailing,
} from "../src/screen.js";

const L = (t: string, extra: Partial<Line["r"][number]> = {}): Line => ({ r: [{ t, ...extra }] });

describe("runs", () => {
  it("merges adjacent runs with identical style and sums n", () => {
    expect(
      mergeRuns([
        { t: "a", fg: 1 },
        { t: "b", fg: 1 },
        { t: "c", fg: 2 },
      ]),
    ).toEqual([
      { t: "ab", fg: 1 },
      { t: "c", fg: 2 },
    ]);
    expect(
      mergeRuns([
        { t: "漢", n: 2 },
        { t: "字", n: 2 },
      ]),
    ).toEqual([{ t: "漢字", n: 4 }]);
    expect(mergeRuns([{ t: "a" }, { t: "漢", n: 2 }])).toEqual([{ t: "a漢", n: 3 }]);
  });
  it("treats rgb colors by value", () => {
    expect(
      mergeRuns([
        { t: "a", fg: [1, 2, 3] },
        { t: "b", fg: [1, 2, 3] },
      ]),
    ).toEqual([{ t: "ab", fg: [1, 2, 3] }]);
  });
  it("trims trailing space-only runs without bg", () => {
    expect(trimTrailing([{ t: "hi" }, { t: "   " }])).toEqual([{ t: "hi" }]);
    expect(trimTrailing([{ t: "hi" }, { t: "   ", bg: 4 }])).toEqual([
      { t: "hi" },
      { t: "   ", bg: 4 },
    ]);
    expect(trimTrailing([{ t: "  " }])).toEqual([]);
  });
  it("trims trailing spaces from the last run if no bg, adjusting n arithmetically", () => {
    expect(trimTrailing([{ t: "hi   " }])).toEqual([{ t: "hi" }]);
    expect(trimTrailing([{ t: "漢字  ", n: 6 }])).toEqual([{ t: "漢字", n: 4 }]);
    expect(trimTrailing([{ t: "hi   ", bg: 1 }])).toEqual([{ t: "hi   ", bg: 1 }]);
  });
  it("counts code points and strips styles", () => {
    expect(codePoints("a🚀b")).toBe(3);
    expect(
      stripStyles({
        r: [
          { t: "a", fg: 1, b: true, n: 1 },
          { t: "b", bg: 2 },
        ],
      }),
    ).toEqual({ r: [{ t: "ab" }] });
  });
});

describe("lineKey", () => {
  it("is the documented format", () => {
    expect(
      lineKey({
        r: [
          { t: "ab", fg: 1, b: true },
          { t: "c", bg: [9, 8, 7], f: true, n: 2 },
        ],
      }),
    ).toBe("ab|1||10000|\x1fc||9,8,7|00001|2");
  });
  it("differs for different styles and is stable", () => {
    expect(lineKey(L("x"))).toBe(lineKey(L("x")));
    expect(lineKey(L("x"))).not.toBe(lineKey(L("x", { b: true })));
  });
});

describe("applySnapshot / applyDiff", () => {
  const snap = {
    cols: 10,
    rows: 3,
    cursor: { x: 0, y: 2 },
    lines: [L("a"), L("b"), L("c")],
    scrollbackTotal: 100,
    gen: 1,
  };

  it("first snapshot starts with empty history", () => {
    const st = applySnapshot(undefined, snap);
    expect(st.lines.map((l) => l.r[0]?.t)).toEqual(["a", "b", "c"]);
    expect(st.history).toEqual([]);
    expect(st.historyFrom).toBe(100);
  });

  it("scroll moves rows into history and appends empties, then applies changes", () => {
    const st = applySnapshot(undefined, snap);
    const { state, gap } = applyDiff(st, {
      scroll: 1,
      changed: [{ i: 2, line: L("d") }],
      cursor: { x: 0, y: 2 },
      scrollbackTotal: 101,
      gen: 2,
    });
    expect(gap).toBe(false);
    expect(state.history.map((l) => l.r[0]?.t)).toEqual(["a"]);
    expect(state.historyFrom).toBe(100);
    expect(state.lines.map((l) => l.r[0]?.t)).toEqual(["b", "c", "d"]);
    expect(state.scrollbackTotal).toBe(101);
  });

  it("a later snapshot keeps history when scrollbackTotal is unchanged, drops it otherwise or on reset", () => {
    let st = applySnapshot(undefined, snap);
    st = applyDiff(st, {
      scroll: 1,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 101,
      gen: 2,
    }).state;
    expect(st.history.length).toBe(1);
    const keep = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3 });
    expect(keep.history.length).toBe(1);
    const drop = applySnapshot(st, { ...snap, scrollbackTotal: 105, gen: 3 });
    expect(drop.history).toEqual([]);
    const reset = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3, reset: true });
    expect(reset.history).toEqual([]);
  });

  it("detects gen gaps and leaves state untouched", () => {
    const st = applySnapshot(undefined, snap);
    const r = applyDiff(st, {
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 100,
      gen: 5,
    });
    expect(r.gap).toBe(true);
    expect(r.state).toBe(st);
  });

  it("caps history at 5000 and advances historyFrom", () => {
    let st: ScreenState = applySnapshot(undefined, { ...snap, rows: 1, lines: [L("0")] });
    for (let g = 2; g <= 5002; g++) {
      st = applyDiff(st, {
        scroll: 1,
        changed: [{ i: 0, line: L(String(g)) }],
        cursor: { x: 0, y: 0 },
        scrollbackTotal: 100 + g - 1,
        gen: g,
      }).state;
    }
    expect(st.history.length).toBe(5000);
    expect(st.historyFrom).toBe(101);
  });

  it("emptyLine has no runs", () => {
    expect(emptyLine()).toEqual({ r: [] });
  });
});
