// Generator for the logo family (brand/svg/*.svg) — the marks used by the website, the README and
// press, as distinct from the app icon set under apps/mobile/assets/brand (extract-glyphs.mjs).
//
// Same technique as apps/mobile/scripts/extract-glyphs.mjs: glyph outlines are drawn from
// JetBrains Mono Bold via opentype.js (reusing the font already committed under
// apps/mobile/assets/fonts — not duplicated here) and framed from the union bounding box of the
// real outlines, never from font metrics. Deterministic: re-running this reproduces the committed
// files byte for byte.
//
// Four variants (spec's brand family section): `mark` ($\a), `wordmark` (shellbell), `horizontal`
// (mark + wordmark on one baseline) and `stacked` (mark above wordmark, left-aligned). Each ships
// in two colourways, `-on-dark` and `-on-light`, that differ only in the muted glyph colour.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
// apps/mobile/scripts/check-brand.mjs re-runs this extraction into a scratch directory to diff
// against the committed SVGs (drift guard); SHELLBELL_BRAND_FAMILY_SVG_OUT lets it redirect the
// output without duplicating the extraction logic. Unset in normal use, so `pnpm brand:family` is
// unaffected.
const OUT = process.env.SHELLBELL_BRAND_FAMILY_SVG_OUT ?? join(here, "../brand/svg");
const AMBER = "#F59E0B";
const MUTED = { dark: "#4A4A55", light: "#3A3A44" };
const EM = 300;

const fontBuffer = readFileSync(
  join(here, "../apps/mobile/assets/fonts/JetBrainsMonoNerdFont-Bold.ttf"),
);
// `Buffer.buffer` may be a view into a larger pooled ArrayBuffer, so slice to the exact
// bytes before handing it to opentype.parse() — otherwise it can throw or misread the font.
const fontArrayBuffer = fontBuffer.buffer.slice(
  fontBuffer.byteOffset,
  fontBuffer.byteOffset + fontBuffer.byteLength,
);
const font = opentype.parse(fontArrayBuffer);

const round = (n) => Number(n.toFixed(3));

/** Lay out `text` with the pen starting at `startX`, baseline at `baselineY`. Returns each glyph's
 *  outline (already in SVG-native coordinates -- opentype's getPath needs no y-flip) plus its
 *  individual bounding box, and the pen position after the last glyph. */
function layout(text, startX, baselineY) {
  let pen = startX;
  const glyphs = [];
  for (const ch of text) {
    const path = font.getPath(ch, pen, baselineY, EM);
    glyphs.push({ ch, d: path.toPathData(3), bb: path.getBoundingBox() });
    pen += font.getAdvanceWidth(ch, EM);
  }
  return { glyphs, endX: pen };
}

/** Union bounding box of a set of laid-out glyphs. */
function unionBB(glyphs) {
  return {
    x1: Math.min(...glyphs.map((g) => g.bb.x1)),
    y1: Math.min(...glyphs.map((g) => g.bb.y1)),
    x2: Math.max(...glyphs.map((g) => g.bb.x2)),
    y2: Math.max(...glyphs.map((g) => g.bb.y2)),
  };
}

// A fixed margin (a fraction of EM, same unit the whole layout uses) around the tight ink bounding
// box on all four sides -- parametric, like the icon's own `occupy`/`inset` (spec §3), not hand-
// tuned. A hard 0-margin crop puts ink right at the SVG edge, which then antialiases into the
// literal corner pixel of a small raster; the margin gives real breathing room for a logo used on
// a page and keeps small PNGs genuinely transparent at their corners.
const MARGIN = 0.08 * EM;

/** Pad a bounding box by `MARGIN` on every side. */
const padBB = (bb) => ({
  x1: bb.x1 - MARGIN,
  y1: bb.y1 - MARGIN,
  x2: bb.x2 + MARGIN,
  y2: bb.y2 + MARGIN,
});

// `<title>` satisfies the a11y lint rule without adding a `<text>`/font dependency.
const svgDoc = (title, bb, paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(bb.x1)} ${round(bb.y1)} ${round(bb.x2 - bb.x1)} ${round(bb.y2 - bb.y1)}">\n  <title>${title}</title>\n${paths}\n</svg>\n`;

/** The two-tone rule (spec §3): `$` and `\` (or `shell`) recede, muted; the final `a` (or `bell`)
 *  carries the accent. `isAccent` is a per-glyph boolean, computed independently for the mark and
 *  the wordmark so that combining them (horizontal/stacked) keeps *both* accents -- the mark's own
 *  `a` and the wordmark's own `bell` -- rather than one accent run covering the whole composition. */
const paint = (glyphs, isAccent, mutedHex) =>
  glyphs.map((g, i) => `  <path d="${g.d}" fill="${isAccent[i] ? AMBER : mutedHex}"/>`).join("\n");

/** Build both colourways of one variant from its geometry (glyphs + per-glyph accent flags +
 *  bounding box). */
function variant(title, glyphs, isAccent, bb) {
  return {
    dark: svgDoc(title, bb, paint(glyphs, isAccent, MUTED.dark)),
    light: svgDoc(title, bb, paint(glyphs, isAccent, MUTED.light)),
  };
}

/** The mark's own two-tone split: only the last glyph (`a`) is the accent. */
const markAccent = (glyphs) => glyphs.map((_, i) => i === glyphs.length - 1);
/** The wordmark's own two-tone split: everything from the 6th character (`bell`) on is the
 *  accent -- the split is after the 5th character ("shell"). */
const wordAccent = (glyphs) => glyphs.map((_, i) => i >= 5);

// --- mark: "$\a" alone, same three glyphs as the app icon's lockup, tightly cropped (plus the
// fixed MARGIN -- see padBB). ---
const markRun = layout("$\\a", 0, 0);
const markBB = unionBB(markRun.glyphs);
const mark = variant("Shellbell mark", markRun.glyphs, markAccent(markRun.glyphs), padBB(markBB));

// --- wordmark: "shellbell" alone. Split after the 5th character: "shell" muted, "bell" accent. ---
const wordRun = layout("shellbell", 0, 0);
const wordBB = unionBB(wordRun.glyphs);
const wordmark = variant(
  "Shellbell wordmark",
  wordRun.glyphs,
  wordAccent(wordRun.glyphs),
  padBB(wordBB),
);

// --- horizontal: mark then wordmark on one baseline, gap 0.55em measured ink edge to ink edge
// (not advance width -- metrics describe a line of text, not this composition; see extract-
// glyphs.mjs's framing note). ---
const hGap = 0.55 * EM;
const wordAtOrigin = layout("shellbell", 0, 0);
const wordAtOriginBB = unionBB(wordAtOrigin.glyphs);
const hWordStartX = markBB.x2 + hGap - wordAtOriginBB.x1;
const hWordRun = layout("shellbell", hWordStartX, 0);
const hGlyphs = [...markRun.glyphs, ...hWordRun.glyphs];
const hAccent = [...markAccent(markRun.glyphs), ...wordAccent(hWordRun.glyphs)];
const hBB = unionBB(hGlyphs);
const horizontal = variant("Shellbell horizontal lockup", hGlyphs, hAccent, padBB(hBB));

// --- stacked: mark above wordmark, both starting at pen x=0 (left-aligned), vertical gap 0.42em
// between the mark's bottom ink edge and the wordmark's top ink edge. ---
const vGap = 0.42 * EM;
const vBaselineY = markBB.y2 + vGap - wordAtOriginBB.y1;
const vWordRun = layout("shellbell", 0, vBaselineY);
const vGlyphs = [...markRun.glyphs, ...vWordRun.glyphs];
const vAccent = [...markAccent(markRun.glyphs), ...wordAccent(vWordRun.glyphs)];
const vBB = unionBB(vGlyphs);
const stacked = variant("Shellbell stacked lockup", vGlyphs, vAccent, padBB(vBB));

mkdirSync(OUT, { recursive: true });
for (const [name, { dark, light }] of Object.entries({ mark, wordmark, horizontal, stacked })) {
  writeFileSync(join(OUT, `${name}-on-dark.svg`), dark);
  writeFileSync(join(OUT, `${name}-on-light.svg`), light);
}
console.log("brand: wrote mark/wordmark/horizontal/stacked, each -on-dark.svg and -on-light.svg");
