# Shellbell brand assets implementation plan

> **Plan 07 errata, 2026-09-20 — source: Bilal's approved terminal-attention identity and glossy/platform icon request.** This is the historical execution record for the superseded escape-sequence brand. Its mark, color split, anchoring, size, and asset-count instructions are no longer current. The revised [brand design specification](../specs/2026-09-19-shellbell-brand-design.md) and [brand guide](../../../brand/README.md) govern future work. The new pipeline uses a custom four-part prompt/cursor/rays symbol, high-contrast wordmark, glossy app/service icons, and flat menu-bar/tray templates. Do not re-execute the old design instructions below.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six Expo template placeholder assets with the approved `$\a` / `\a` brand
marks, generated reproducibly from committed SVG sources.

**Architecture:** Glyph outlines are extracted once from the repo's JetBrains Mono Bold TTF and
frozen into hand-tunable SVG sources under `apps/mobile/assets/brand/`. A Node script renders those
sources to the exact PNG files `app.json` already references. Rasters are committed so no build
step depends on the renderer; the script exists so assets can be regenerated rather than
hand-edited.

**Tech Stack:** Node 22, `opentype.js` (glyph extraction, dev-only), `sharp` (SVG→PNG, dev-only),
vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-shellbell-brand-design.md` — read it before starting;
this plan argues from it and does not restate its reasoning.

## Global Constraints

- Brand accent amber **`#F59E0B`**; muted glyph **`#4A4A55`**; tile **`#0B0B0D`**; canvas
  **`#000000`**. Exact values, copied from spec §4.
- The lockup is **`$\a`**; the monogram is **`\a`**. Monogram for anything under ~64px.
- Shipped SVGs must contain **no `<text>` element and no font reference** (spec §3). Outlines only.
- The brand accent must **not** change the app's eight per-computer accents or `app.json`'s
  `expo-notifications` colour `#10B981` (spec §4).
- New dependencies are **devDependencies of `@shellbell/mobile` only**. Nothing here ships in the
  app bundle.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass at every commit.

---

### Task 1: Extract glyph outlines into SVG sources

**Files:**
- Create: `apps/mobile/scripts/extract-glyphs.mjs`
- Create: `apps/mobile/assets/brand/monogram.svg`, `apps/mobile/assets/brand/lockup.svg`
- Modify: `apps/mobile/package.json` (devDependency `opentype.js`, script `brand:extract`)
- Test: `apps/mobile/test/brand-sources.test.ts`

**Interfaces:**
- Produces: `apps/mobile/assets/brand/{monogram,lockup}.svg`, each a `viewBox="0 0 512 512"` SVG
  whose glyphs are `<path>` elements with `fill` set to one of the two approved colours. Task 3
  consumes these paths.

- [ ] **Step 1: Write failing test**

```ts
// apps/mobile/test/brand-sources.test.ts
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
    const fills = [...read(name).matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(["#F59E0B", "#4A4A55"]).toContain(f.toUpperCase());
  });

  it("the monogram is two glyphs and the lockup is three", () => {
    expect([...read("monogram.svg").matchAll(/<path[\s>]/g)]).toHaveLength(2);
    expect([...read("lockup.svg").matchAll(/<path[\s>]/g)]).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @shellbell/mobile exec vitest run test/brand-sources.test.ts`
Expected: FAIL — `ENOENT` on `assets/brand/monogram.svg`.

- [ ] **Step 3: Add the dependency**

```bash
pnpm -F @shellbell/mobile add -D opentype.js
```

Add to `apps/mobile/package.json` scripts: `"brand:extract": "node scripts/extract-glyphs.mjs"`.

- [ ] **Step 4: Write the extraction script**

```js
// apps/mobile/scripts/extract-glyphs.mjs
// One-shot generator. Reads the repo's JetBrains Mono Bold and freezes the glyphs the brand uses
// into SVG paths, so the shipped mark carries no font dependency (spec 3). Re-run only to change
// the skeleton; optical spacing is hand-tuned in the SVGs afterwards and is NOT reproduced here.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../assets/brand");
const AMBER = "#F59E0B", MUTED = "#4A4A55";
const font = opentype.parse(
  readFileSync(join(here, "../assets/fonts/JetBrainsMonoNerdFont-Bold.ttf")).buffer,
);

/** Glyph outline as an SVG path string, drawn at `size` with its origin at (x, y). */
const glyph = (ch, x, y, size) => font.getPath(ch, x, y, size).toPathData(3);

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n${body}\n</svg>\n`;

// Monogram: "\a". Baseline and advances chosen so the pair sits optically centred in 512.
const monogram = svg(
  [
    `  <path d="${glyph("\\", 96, 336, 320)}" fill="${MUTED}"/>`,
    `  <path d="${glyph("a", 268, 336, 320)}" fill="${AMBER}"/>`,
  ].join("\n"),
);

// Lockup: "$\a". Three glyphs, so the size drops and the whole group shifts left.
const lockup = svg(
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
```

- [ ] **Step 5: Generate and run the test**

Run: `pnpm -F @shellbell/mobile run brand:extract && pnpm -F @shellbell/mobile exec vitest run test/brand-sources.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/scripts/extract-glyphs.mjs apps/mobile/assets/brand apps/mobile/test/brand-sources.test.ts apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(brand): freeze the mark's glyphs as SVG outlines"
```

---

### Task 2: Optical review checkpoint (human)

**Files:**
- Modify: `apps/mobile/assets/brand/monogram.svg`, `apps/mobile/assets/brand/lockup.svg`

Spec §8 leaves optical spacing open, and it cannot be derived from font metrics — mono advances are
uniform by definition, so `$\a` set at its natural widths will look wrong. This task is judgement,
not arithmetic; there is no test that can replace it.

- [ ] **Step 1: Render a review sheet at final sizes**

```bash
cd apps/mobile/assets/brand && python3 -m http.server 8732
```

Open `monogram.svg` and `lockup.svg`, and view the monogram at **46px** against `#0B0B0D`. The
46px view decides this — a mark that only works at 512 is not a mark.

- [ ] **Step 2: Hand-tune the `x` offsets in the SVG paths**

Adjust the translate/x values directly in the two SVG files until the glyph gaps look even. Do not
re-run `brand:extract` afterwards — it will overwrite the tuning. The script's header says so.

- [ ] **Step 3: Confirm the source tests still pass**

Run: `pnpm -F @shellbell/mobile exec vitest run test/brand-sources.test.ts`
Expected: PASS — tuning changes coordinates, not colours or path counts.

- [ ] **Step 4: Get explicit sign-off before rasterising**

Show the 46px and 512px renders. **Stop here until approved.** Task 3 bakes these into six files.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/assets/brand
git commit -m "feat(brand): optical spacing for the monogram and lockup"
```

---

### Task 3: Render the six raster assets

**Files:**
- Create: `apps/mobile/scripts/render-brand.mjs`
- Modify: `apps/mobile/package.json` (devDependency `sharp`, script `brand:render`)
- Replace: `apps/mobile/assets/{icon,splash-icon,favicon}.png`,
  `apps/mobile/assets/android-icon-{foreground,background,monochrome}.png`

**Interfaces:**
- Consumes: `assets/brand/{monogram,lockup}.svg` from Task 1.
- Produces: the six PNGs at the paths `app.json` already references. No `app.json` change is needed
  — filenames are unchanged.

- [ ] **Step 1: Add the dependency**

`sharp` is currently present only transitively and does not load reliably. Declare it:

```bash
pnpm -F @shellbell/mobile add -D sharp
```

Add script: `"brand:render": "node scripts/render-brand.mjs"`.

- [ ] **Step 2: Write the render script**

```js
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
const TILE = "#0B0B0D", BLACK = "#000000";

/** Flatten onto `bg` so no asset ships with transparency the stores would letterbox. */
async function out(svg, size, bg, file, pad = 0) {
  const inner = size - pad * 2;
  const art = await sharp(svg).resize(inner, inner, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  const buf = await sharp({
    create: { width: size, height: size, channels: 4, background: bg },
  })
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toBuffer();
  writeFileSync(join(A, file), buf);
  console.log(`brand: ${file} (${size}px)`);
}

const mono = src("monogram.svg");
const lock = src("lockup.svg");

// Android adaptive icons crop to a circle; keep art inside the 66% safe zone via padding.
await out(mono, 1024, TILE, "icon.png");
await out(mono, 1024, TILE, "android-icon-foreground.png", 180);
// Splash uses the LOCKUP, not the monogram: it is the one full-screen moment with room for the
// prompt. app.json sets imageWidth 200 on a #000000 background, so it renders small -- check it
// on device before assuming three glyphs survive.
await out(lock, 1024, BLACK, "splash-icon.png");
await out(mono, 196, TILE, "favicon.png");

// Flat background plate, and a single-colour variant for Android themed icons.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: TILE } })
  .png().toFile(join(A, "android-icon-background.png"));
await out(
  Buffer.from(src("monogram.svg").toString().replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#FFFFFF"')),
  1024, "#000000", "android-icon-monochrome.png", 180,
);
```

- [ ] **Step 3: Render**

Run: `pnpm -F @shellbell/mobile run brand:render`
Expected: six lines of output, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/scripts/render-brand.mjs apps/mobile/assets/*.png apps/mobile/package.json pnpm-lock.yaml
git commit -m "feat(brand): render the icon, splash and favicon from the SVG sources"
```

---

### Task 4: Regression test that the placeholders cannot come back

**Files:**
- Test: `apps/mobile/test/brand-assets.test.ts`
- Modify: `docs/before-first-release.md`, `docs/superpowers/specs/2026-09-19-shellbell-brand-design.md`

**Interfaces:**
- Consumes: the six PNGs from Task 3.

- [ ] **Step 1: Write failing test**

```ts
// apps/mobile/test/brand-assets.test.ts
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const A = join(__dirname, "../assets");

/** The template placeholders were light (white / #E8E8ED-ish graph paper); the brand is near-black.
 *  Mean luminance is a blunt but honest guard: it fails loudly if a template is ever restored. */
async function meanLuma(file: string) {
  const { data, info } = await sharp(join(A, file))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels)
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return sum / (data.length / info.channels);
}

const dark = ["icon.png", "splash-icon.png", "favicon.png", "android-icon-background.png"];

describe("brand raster assets", () => {
  it.each(dark)("%s is dark, not an Expo template", async (f) => {
    expect(await meanLuma(f)).toBeLessThan(40);
  });

  it("the icon actually carries the amber accent", async () => {
    const { data, info } = await sharp(join(A, "icon.png"))
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let amber = 0;
    for (let i = 0; i < data.length; i += info.channels)
      if (data[i] > 200 && data[i + 1] > 120 && data[i + 1] < 190 && data[i + 2] < 80) amber++;
    expect(amber).toBeGreaterThan(1000);
  });

  it.each(["icon.png", "android-icon-foreground.png", "android-icon-monochrome.png"])(
    "%s is 1024x1024",
    async (f) => {
      const m = await sharp(join(A, f)).metadata();
      expect([m.width, m.height]).toEqual([1024, 1024]);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails against the old assets**

Before Task 3 lands this fails on luminance. If Task 3 is already committed, verify the guard works
by temporarily restoring a placeholder — do not skip this; an assertion never seen red proves
nothing.

Run: `pnpm -F @shellbell/mobile exec vitest run test/brand-assets.test.ts`

- [ ] **Step 3: Run the full suite and CI gates**

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm -F @shellbell/mobile check:vectors && pnpm -F @shellbell/mobile doctor
```

Expected: all pass; mobile test count rises by the new cases.

- [ ] **Step 4: Update the docs**

In `docs/before-first-release.md`, strike the placeholder row added on 2026-09-19 and record the
date. In the brand spec, change the status line from "approved … not yet implemented" and close two
of the three §8 open items with what was actually chosen: the optical spacing from Task 2, and
**the splash carries the lockup alone, with no "shellbell" wordmark** — decided here by Task 3, so
record it rather than leaving it looking unresolved. The website animation question stays open;
there is no website spec yet.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/test/brand-assets.test.ts docs/
git commit -m "test(brand): guard against the template placeholders returning"
```

---

## Notes

**Font licensing.** The glyph skeletons come from JetBrains Mono via Nerd Fonts, SIL OFL (see
`apps/mobile/assets/fonts/LICENSE.md`). The OFL places no restriction on artwork produced with a
font, so a trademarked logo built from its outlines is fine — and `TRADEMARK.md` already reserves
the Shellbell name and logo from the MIT grant. The font itself is not redistributed by these
assets; only outlines are.

**Not in scope:** the website lockup (no website spec exists yet), light-mode variants (spec §7),
and the `docs/demo.gif` recording, which remains its own `[HUMAN]` item.
