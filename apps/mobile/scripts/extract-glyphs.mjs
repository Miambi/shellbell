// One-shot generator. Reads the repo's JetBrains Mono Bold and freezes the glyphs the brand uses
// into SVG paths, so the shipped mark carries no font dependency (spec 3). Re-run only to change
// the skeleton; optical spacing is hand-tuned in the SVGs afterwards and is NOT reproduced here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../assets/brand");
const AMBER = "#F59E0B";
const MUTED = "#4A4A55";
const fontBuffer = readFileSync(join(here, "../assets/fonts/JetBrainsMonoNerdFont-Bold.ttf"));
// `Buffer.buffer` may be a view into a larger pooled ArrayBuffer, so slice to the exact
// bytes before handing it to opentype.parse() — otherwise it can throw or misread the font.
const fontArrayBuffer = fontBuffer.buffer.slice(
  fontBuffer.byteOffset,
  fontBuffer.byteOffset + fontBuffer.byteLength,
);
const font = opentype.parse(fontArrayBuffer);

/** Glyph outline as an SVG path string, drawn at `size` with its origin at (x, y). */
const glyph = (ch, x, y, size) => font.getPath(ch, x, y, size).toPathData(3);

// `<title>` satisfies the a11y lint rule without adding a `<text>`/font dependency (spec 3).
const svg = (title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n  <title>${title}</title>\n${body}\n</svg>\n`;

// Monogram: "\a". Baseline and advances chosen so the pair sits optically centred in 512.
const monogram = svg(
  "Shellbell monogram",
  [
    `  <path d="${glyph("\\", 96, 336, 320)}" fill="${MUTED}"/>`,
    `  <path d="${glyph("a", 268, 336, 320)}" fill="${AMBER}"/>`,
  ].join("\n"),
);

// Lockup: "$\a". Three glyphs, so the size drops and the whole group shifts left.
const lockup = svg(
  "Shellbell lockup",
  [
    `  <path d="${glyph("$", 40, 330, 250)}" fill="${MUTED}"/>`,
    `  <path d="${glyph("\\", 178, 330, 250)}" fill="${MUTED}"/>`,
    `  <path d="${glyph("a", 312, 330, 250)}" fill="${AMBER}"/>`,
  ].join("\n"),
);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "monogram.svg"), monogram);
writeFileSync(join(OUT, "lockup.svg"), lockup);
console.log("brand: wrote monogram.svg, lockup.svg");
