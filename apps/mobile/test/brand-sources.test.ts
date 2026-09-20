import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (n: string) => readFileSync(join(__dirname, "../assets/brand", n), "utf8");

describe("brand SVG sources", () => {
  it.each(["monogram.svg", "lockup.svg"])("%s carries outlines, not a font", (name) => {
    const svg = read(name);
    // Spec 3: the shipped mark must not depend on a font file being present.
    expect(svg).not.toMatch(/<text[\s>]/);
    expect(svg).not.toMatch(/font-family/);
    expect(svg).toMatch(/<path[\s>]/);
  });

  it.each(["monogram.svg", "lockup.svg"])("%s uses only the approved colours", (name) => {
    // Non-null: the capture group always matches when the regex matches at all (mobile's
    // tsconfig sets noUncheckedIndexedAccess, which types `m[1]` as possibly undefined).
    const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(["#F59E0B", "#4A4A55"]).toContain(f.toUpperCase());
  });

  it("the monogram is two glyphs and the lockup is three", () => {
    expect([...read("monogram.svg").matchAll(/<path[\s>]/g)]).toHaveLength(2);
    expect([...read("lockup.svg").matchAll(/<path[\s>]/g)]).toHaveLength(3);
  });
});
