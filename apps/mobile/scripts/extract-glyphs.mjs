// Generator. Reads the repo's JetBrains Mono Bold and freezes the glyphs the brand uses into SVG
// paths, so the shipped mark carries no font dependency (spec §3).
//
// Framing is parametric and deterministic — `occupy` and `inset` from spec §3 — so re-running this
// reproduces the committed files byte for byte. Nothing here is hand-tuned, and nothing should be:
// the viewBox is computed from the union bounding box of the real outlines, never from font
// metrics, which describe a line of text and know nothing about a square tile.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/check-brand.mjs re-runs this extraction into a scratch directory to diff against the
// committed SVGs (drift guard); SHELLBELL_BRAND_OUT lets it redirect the output without duplicating
// the extraction logic. Unset in normal use, so `pnpm brand:extract` is unaffected.
const OUT = process.env.SHELLBELL_BRAND_OUT ?? join(here, "../assets/brand");
const AMBER = "#F59E0B";
const MUTED = "#4A4A55";
const EM = 300;

const fontBuffer = readFileSync(join(here, "../assets/fonts/JetBrainsMonoNerdFont-Bold.ttf"));
// `Buffer.buffer` may be a view into a larger pooled ArrayBuffer, so slice to the exact
// bytes before handing it to opentype.parse() — otherwise it can throw or misread the font.
const fontArrayBuffer = fontBuffer.buffer.slice(
  fontBuffer.byteOffset,
  fontBuffer.byteOffset + fontBuffer.byteLength,
);
const font = opentype.parse(fontArrayBuffer);

/** Lay out a string at EM, returning each glyph's outline plus the union bounding box. */
function layout(text) {
  let pen = 0;
  const glyphs = [];
  for (const ch of text) {
    const path = font.getPath(ch, pen, 0, EM);
    glyphs.push({ ch, d: path.toPathData(3), bb: path.getBoundingBox() });
    pen += font.getAdvanceWidth(ch, EM);
  }
  const bb = {
    x1: Math.min(...glyphs.map((g) => g.bb.x1)),
    y1: Math.min(...glyphs.map((g) => g.bb.y1)),
    x2: Math.max(...glyphs.map((g) => g.bb.x2)),
    y2: Math.max(...glyphs.map((g) => g.bb.y2)),
  };
  return { glyphs, bb, width: bb.x2 - bb.x1 };
}

/**
 * Frame a laid-out mark top-left in a square viewBox (spec §3 "Anchoring"): the mark takes
 * `occupy` of the square's width, with `inset` of padding above and to its left. The rest of the
 * square is deliberately empty — it reads as the screen the prompt sits on.
 */
function frame(mark, occupy, inset) {
  const side = mark.width / occupy;
  const x = mark.bb.x1 - side * inset;
  const y = mark.bb.y1 - side * inset;
  return `${round(x)} ${round(y)} ${round(side)} ${round(side)}`;
}

const round = (n) => Number(n.toFixed(3));

// `<title>` satisfies the a11y lint rule without adding a `<text>`/font dependency (spec §3).
const svg = (title, viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n  <title>${title}</title>\n${body}\n</svg>\n`;

/** The final `a` is the bell and carries the accent; everything before it recedes (spec §3). */
const paint = (mark) =>
  mark.glyphs
    .map((g, i) => {
      const fill = i === mark.glyphs.length - 1 ? AMBER : MUTED;
      return `  <path d="${g.d}" fill="${fill}"/>`;
    })
    .join("\n");

// Lockup "$\a" — the app icon, splash, website (spec §3: occupy 0.62, inset 0.13).
const lock = layout("$\\a");
const lockup = svg("Shellbell lockup", frame(lock, 0.62, 0.13), paint(lock));

// Monogram "\a" — favicon and anything at or below ~32px (spec §3: occupy 0.38, inset 0.15).
const mono = layout("\\a");
const monogram = svg("Shellbell monogram", frame(mono, 0.38, 0.15), paint(mono));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "monogram.svg"), monogram);
writeFileSync(join(OUT, "lockup.svg"), lockup);
console.log("brand: wrote monogram.svg, lockup.svg");
