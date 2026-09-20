import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

// Same root as brand-family-sources.test.ts -- the logo family's rasters, not the app icon set.
const FAMILY_PNG_DIR = join(__dirname, "../../../brand/png");

const VARIANTS = ["mark", "wordmark", "horizontal", "stacked"];
const COLOURWAYS = ["on-dark", "on-light"];
const NAMES = VARIANTS.flatMap((v) => COLOURWAYS.map((c) => `${v}-${c}`));
const SCALES: ReadonlyArray<readonly [string, number]> = [
  ["1x", 128],
  ["2x", 256],
];
const FILES: ReadonlyArray<readonly [string, number]> = NAMES.flatMap((n) =>
  SCALES.map(([suffix, height]) => [`${n}@${suffix}.png`, height] as const),
);

/** Alpha of the pixel `off` pixels in from each corner, sampled away from the very edge to avoid
 *  antialiasing artefacts at the corner pixel itself. Mirrors brand-assets.test.ts's helper. */
async function cornerAlphas(file: string, off = 2) {
  const { data, info } = await sharp(join(FAMILY_PNG_DIR, file)).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { width, height, channels } = info;
  const at = (x: number, y: number) => data[(y * width + x) * channels + 3]!;
  return {
    topLeft: at(off, off),
    topRight: at(width - 1 - off, off),
    bottomLeft: at(off, height - 1 - off),
    bottomRight: at(width - 1 - off, height - 1 - off),
  };
}

describe("brand family PNG assets", () => {
  it("has all 16 expected files (8 SVGs x @1x/@2x)", async () => {
    for (const [file] of FILES) {
      await expect(sharp(join(FAMILY_PNG_DIR, file)).metadata()).resolves.toBeDefined();
    }
  });

  it.each(FILES)("%s is transparent at all four corners", async (file) => {
    const corners = await cornerAlphas(file);
    for (const alpha of Object.values(corners)) expect(alpha).toBe(0);
  });

  it.each(FILES)("%s has the expected height", async (file, height) => {
    const m = await sharp(join(FAMILY_PNG_DIR, file)).metadata();
    expect(m.height).toBe(height);
  });

  it("every @2x is exactly double its @1x height, aspect ratio preserved", async () => {
    for (const n of NAMES) {
      const m1 = await sharp(join(FAMILY_PNG_DIR, `${n}@1x.png`)).metadata();
      const m2 = await sharp(join(FAMILY_PNG_DIR, `${n}@2x.png`)).metadata();
      expect(m1.height).toBe(128);
      expect(m2.height).toBe(256);
      const ratio1 = (m1.width ?? 0) / (m1.height ?? 1);
      const ratio2 = (m2.width ?? 0) / (m2.height ?? 1);
      expect(ratio2).toBeCloseTo(ratio1, 1);
    }
  });
});
