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
      <stop offset="46%" stop-color="${TILE}"/>
      <stop offset="100%" stop-color="#050507"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#tile)"/>
</svg>`;

const tileBackground = (size) =>
  sharp(Buffer.from(tileGradientSvg(size)))
    .png()
    .toBuffer();

const TRANSPARENT = "transparent";

/**
 * Composite the mark onto `bg`. `bg` is a flat colour or `"transparent"` (sharp `create`
 * background), or a pre-rendered PNG buffer the full size of the canvas (the gradient tile).
 * Flat/gradient variants flatten out so no asset ships with transparency the stores would
 * letterbox; `"transparent"` is for the Android layers the OS composites itself, where baking in
 * a background would double it up or fight themed-icon tinting (see the Android block below). The
 * source SVGs are already framed top-left with the correct padding (spec §3 "Anchoring"), so the
 * mark is rendered at its full target size and composited at 0,0 -- `pad` exists only for the
 * Android adaptive-icon safe zone, not for recentring.
 */
async function out(svg, size, bg, file, pad = 0) {
  const inner = size - pad * 2;
  const art = await sharp(svg)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const base =
    bg === TRANSPARENT
      ? sharp({
          create: {
            width: size,
            height: size,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
      : typeof bg === "string"
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
// Coupled to scripts/extract-glyphs.mjs's exact output spelling: it always writes fills as
// `fill="#RRGGBB"` (see its `paint()`), which is what this regex assumes. If that script ever
// changes how it serialises fills (e.g. shorthand hex, currentColor, a style attribute), this
// silently stops matching and the monochrome layer keeps the two-tone colours instead of flattening
// to white.
const lockWhite = Buffer.from(lock.toString().replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#FFFFFF"'));

// iOS app icon: the LOCKUP ($\a), not the monogram (spec §3 errata 2026-09-20), on the gradient
// tile. This is a single flat layer -- iOS doesn't composite icons the way Android does -- so the
// tile is baked straight in.
const iconTile = await tileBackground(1024);
await out(lock, 1024, iconTile, "icon.png");

// --- Android adaptive icon: three SEPARATE layers, composited by the OS at draw time. ---
// The gradient tile lives ONLY in the background layer. The foreground and monochrome layers
// carry ONLY the mark on a transparent canvas -- Android draws background, then foreground, then
// (on Android 13+, in a themed context) substitutes monochrome for both, tinted by the launcher.
// Baking the tile into foreground/monochrome too would leave android-icon-background.png dead
// (never visible under an opaque foreground) and would fight themed-icon tinting, which needs an
// alpha-only source. Do not "helpfully" re-flatten these -- transparency here is load-bearing.
await out(lock, 1024, TRANSPARENT, "android-icon-foreground.png", 180);
// Android themed (monochrome) icon: same LOCKUP as the rest of the icon (it's the same icon,
// themed, not a small-size context -- the monogram's remit is favicon.png and below ~32px), single
// flat colour, transparent, safe-zone padded. No two-tone: replacing both fills with #FFFFFF is
// the intent.
await out(lockWhite, 1024, TRANSPARENT, "android-icon-monochrome.png", 180);
// Android background plate: the gradient tile, full-bleed, opaque. This IS the layer the tile art
// belongs in -- Android's circular/rounded-square mask crops a 135deg diagonal gracefully.
writeFileSync(join(A, "android-icon-background.png"), iconTile);
console.log("brand: android-icon-background.png (1024px)");

// Splash uses the LOCKUP on true black -- no gradient here (spec §4). app.json sets imageWidth 200
// on a #000000 background, so it renders small -- check it on device before assuming three glyphs
// survive.
await out(lock, 1024, BLACK, "splash-icon.png");
// Favicon: the MONOGRAM (\a) -- the only surviving use, for anything at or below ~32px.
await out(mono, 196, TILE, "favicon.png");
