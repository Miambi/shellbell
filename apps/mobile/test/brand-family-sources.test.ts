import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The logo family lives at the repo root (brand/), separate from the app icon set under
// apps/mobile/assets/brand -- it's for the website, README and press, not the app.
const FAMILY_DIR = join(__dirname, "../../../brand/svg");

const VARIANTS = ["mark", "wordmark", "horizontal", "stacked"];
const COLOURWAYS = ["on-dark", "on-light"];
const FILES = VARIANTS.flatMap((v) => COLOURWAYS.map((c) => `${v}-${c}.svg`));

const read = (n: string) => readFileSync(join(FAMILY_DIR, n), "utf8");

describe("brand family SVG sources", () => {
  it("has exactly the 8 expected files", () => {
    const actual = readdirSync(FAMILY_DIR)
      .filter((f) => f.endsWith(".svg"))
      .sort();
    expect(actual).toEqual([...FILES].sort());
  });

  it.each(FILES)("%s carries outlines, not a font", (name) => {
    const svg = read(name);
    // Spec: the shipped mark must not depend on a font file being present.
    expect(svg).not.toMatch(/<text[\s>]/);
    expect(svg).not.toMatch(/font-family/);
    expect(svg).toMatch(/<path[\s>]/);
    expect(svg).toMatch(/<title>/);
  });

  it.each(FILES)("%s uses only the four approved fills", (name) => {
    // Non-null: the capture group always matches when the regex matches at all (mobile's
    // tsconfig sets noUncheckedIndexedAccess, which types `m[1]` as possibly undefined).
    const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) =>
      m[1]!.toUpperCase(),
    );
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(["#F59E0B", "#4A4A55", "#3A3A44"]).toContain(f);
  });

  it.each(FILES.filter((f) => f.endsWith("-on-dark.svg")))(
    "%s's muted fill is the on-dark value #4A4A55, never the on-light #3A3A44",
    (name) => {
      const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) =>
        m[1]!.toUpperCase(),
      );
      expect(fills).toContain("#4A4A55");
      expect(fills).not.toContain("#3A3A44");
    },
  );

  it.each(FILES.filter((f) => f.endsWith("-on-light.svg")))(
    "%s's muted fill is the on-light value #3A3A44, never the on-dark #4A4A55",
    (name) => {
      const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) =>
        m[1]!.toUpperCase(),
      );
      expect(fills).toContain("#3A3A44");
      expect(fills).not.toContain("#4A4A55");
    },
  );

  it("mark is 3 glyphs, wordmark is 9, horizontal and stacked are both 12 (mark + wordmark)", () => {
    expect([...read("mark-on-dark.svg").matchAll(/<path[\s>]/g)]).toHaveLength(3);
    expect([...read("wordmark-on-dark.svg").matchAll(/<path[\s>]/g)]).toHaveLength(9);
    expect([...read("horizontal-on-dark.svg").matchAll(/<path[\s>]/g)]).toHaveLength(12);
    expect([...read("stacked-on-dark.svg").matchAll(/<path[\s>]/g)]).toHaveLength(12);
  });

  it("horizontal and stacked carry BOTH accents independently: the mark's own `a` and the wordmark's own `bell`", () => {
    // 12 paths: $ \ a (mark) then s h e l l b e l l (wordmark). The mark's two-tone split (only
    // its final glyph, `a`, index 2) must survive combination -- it must NOT be swallowed into one
    // accent run that starts only at the wordmark's `bell` (index 8).
    const expectedAccent = [
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ];
    for (const name of ["horizontal-on-dark.svg", "stacked-on-dark.svg"]) {
      const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) =>
        m[1]!.toUpperCase(),
      );
      const accent = fills.map((f) => f === "#F59E0B");
      expect(accent).toEqual(expectedAccent);
    }
  });
});
