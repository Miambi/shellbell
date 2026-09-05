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
