// Drift guard between the SVG sources of record (assets/brand/*.svg) and what scripts/extract-
// glyphs.mjs would produce from the font today. Mirrors scripts/sync-vectors.mjs --check.
//
// Re-runs the extraction into a scratch directory (via SHELLBELL_BRAND_OUT, see
// extract-glyphs.mjs) and byte-compares the result against the committed SVGs -- extraction is
// deterministic, so any difference means the font or the framing geometry changed without
// regenerating and committing the output.
//
// Deliberately SVG-only: the PNGs are NOT byte-compared here. Raster output depends on the
// installed libvips version, so comparing rendered PNGs across machines/CI images would flake.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const committed = join(here, "../assets/brand");
const FILES = ["monogram.svg", "lockup.svg"];

const scratch = mkdtempSync(join(tmpdir(), "shellbell-brand-check-"));
try {
  execFileSync(process.execPath, [join(here, "extract-glyphs.mjs")], {
    env: { ...process.env, SHELLBELL_BRAND_OUT: scratch },
    stdio: "inherit",
  });

  const stale = FILES.filter(
    (f) => !readFileSync(join(committed, f)).equals(readFileSync(join(scratch, f))),
  );

  if (stale.length > 0) {
    console.error(`brand: stale SVG source(s): ${stale.join(", ")}`);
    console.error("brand: run `pnpm -F @shellbell/mobile run brand:extract` and commit the result");
    process.exit(1);
  }
  console.log("brand: SVG sources match the font (no drift)");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
