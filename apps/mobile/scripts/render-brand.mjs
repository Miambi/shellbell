// apps/mobile/scripts/render-brand.mjs
// Renders the committed SVG sources to the exact PNGs app.json references. Rasters are committed,
// so nothing in the build depends on this script -- it exists so the assets can be regenerated
// instead of hand-edited.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const A = join(here, "../assets");
const src = (n) => readFileSync(join(A, "brand", n));
const TILE = "#0B0B0D";
const BLACK = "#000000";

// The icon tile carries a diagonal sheen (spec §4, added 2026-09-20): a linear gradient at 135deg,
// #1B1B24 at 0%, #0B0B0D at 46%, #050507 at 100%. sharp's `create` background can't paint a
// gradient, so render it as an SVG rect and rasterise that instead. For a *square* box, a 135deg
// CSS-style linear gradient runs exactly corner to corner, which an SVG gradient from (0%,0%) to
// (100%,100%) reproduces directly -- no angle math needed.
const tileGradientSvg = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="tile" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1B1B24"/>
      <stop offset="46%" stop-color="#0B0B0D"/>
      <stop offset="100%" stop-color="#050507"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#tile)"/>
</svg>`;

const tileBackground = (size) =>
  sharp(Buffer.from(tileGradientSvg(size)))
    .png()
    .toBuffer();

/**
 * Flatten onto `bg` so no asset ships with transparency the stores would letterbox. `bg` is
 * either a flat colour (sharp `create` background) or a pre-rendered PNG buffer the full size of
 * the canvas (the gradient tile). The source SVGs are already framed top-left with the correct
 * padding (spec §3 "Anchoring"), so the mark is rendered at its full target size and composited at
 * 0,0 -- `pad` exists only for the Android adaptive-icon safe zone, not for recentring.
 */
async function out(svg, size, bg, file, pad = 0) {
  const inner = size - pad * 2;
  const art = await sharp(svg)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const base =
    typeof bg === "string"
      ? sharp({ create: { width: size, height: size, channels: 4, background: bg } })
      : sharp(bg);
  const buf = await base
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toBuffer();
  writeFileSync(join(A, file), buf);
  console.log(`brand: ${file} (${size}px)`);
}

const mono = src("monogram.svg");
const lock = src("lockup.svg");

// App icon: the LOCKUP ($\a), not the monogram (spec §3 errata 2026-09-20), on the gradient tile.
const iconTile = await tileBackground(1024);
await out(lock, 1024, iconTile, "icon.png");
// Android adaptive icon foreground: same lockup and tile, kept inside the 66% safe zone so no
// launcher mask shape crops the mark.
await out(lock, 1024, iconTile, "android-icon-foreground.png", 180);
// Splash uses the LOCKUP on true black -- no gradient here (spec §4). app.json sets imageWidth 200
// on a #000000 background, so it renders small -- check it on device before assuming three glyphs
// survive.
await out(lock, 1024, BLACK, "splash-icon.png");
// Favicon: the MONOGRAM (\a) -- the only surviving use, for anything at or below ~32px.
await out(mono, 196, TILE, "favicon.png");

// Flat background plate. Stays flat, not the gradient: Android composites this under a circular
// (or other launcher-defined) mask, so a gradient here would crop unpredictably depending on
// device.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: TILE } })
  .png()
  .toFile(join(A, "android-icon-background.png"));
// Android themed (monochrome) icon: single flat colour on black, no gradient, no two-tone --
// replacing both fills with #FFFFFF is the intent.
await out(
  Buffer.from(mono.toString().replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#FFFFFF"')),
  1024,
  BLACK,
  "android-icon-monochrome.png",
  180,
);
