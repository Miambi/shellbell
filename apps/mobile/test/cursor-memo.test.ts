import { describe, expect, it } from "vitest";
import { buildCursor } from "../src/screen/cursorMemo.js";

describe("buildCursor", () => {
  it("returns the same reference across calls when every primitive is unchanged", () => {
    const a = buildCursor(null, { x: 1, y: 2, accent: "#fff", blinking: true, inferred: false });
    const b = buildCursor(a, { x: 1, y: 2, accent: "#fff", blinking: true, inferred: false });
    expect(b).toBe(a);
    expect(b).toEqual({ x: 1, y: 2, accent: "#fff", blinking: true, inferred: false });
  });

  it("builds a new object when any primitive changes", () => {
    const a = buildCursor(null, { x: 1, y: 2, accent: "#fff", blinking: true, inferred: false });
    const b = buildCursor(a, { x: 1, y: 3, accent: "#fff", blinking: true, inferred: false });
    expect(b).not.toBe(a);
    expect(b).toEqual({ x: 1, y: 3, accent: "#fff", blinking: true, inferred: false });

    const c = buildCursor(b, { x: 1, y: 3, accent: "#000", blinking: true, inferred: false });
    expect(c).not.toBe(b);
    const d = buildCursor(c, { x: 1, y: 3, accent: "#000", blinking: false, inferred: false });
    expect(d).not.toBe(c);
    const e = buildCursor(d, { x: 1, y: 3, accent: "#000", blinking: false, inferred: true });
    expect(e).not.toBe(d);
  });

  it("returns null when there is no cursor to draw", () => {
    expect(buildCursor(null, null)).toBeNull();
    const prev = buildCursor(null, {
      x: 0,
      y: 0,
      accent: "#fff",
      blinking: false,
      inferred: false,
    });
    expect(buildCursor(prev, null)).toBeNull();
  });
});
