# Shellbell brand design

Status: **approved 2026-09-19, implemented 2026-09-20.** Scope is the mark, colour and type —
everything that feeds the app icon, the splash, and the website. Light mode is explicitly **out of
scope** (see Non-goals).

This document is the authority for brand decisions the way
`2026-09-03-shellbell-design.md` is for the product. Corrections go in place with an errata
marker.

## 1. Origin

The brand is not a metaphor to be invented. It already exists in the product spec, §138, on the
name:

> BEL (`\a`, Ctrl‑G) is the terminal's own "attention" signal

Shellbell is named after the one character a terminal already uses to get a human's attention. The
mark is therefore not a picture of a bell — it is **the instruction that rings one**. `$\a` is a
literal thing you can type into a shell, and what it does is exactly what the product does.

This was chosen over a drawn bell after four drawn variations (block, flared, prompt-plus-bell,
cursor-plus-ring) were rejected: a drawn bell either reads as a generic notification icon or loses
the terminal entirely, and none survived 48px while keeping both readings.

## 2. Audience

**Developers and engineers.** Nobody installs a terminal-mirroring app who does not live in a
terminal, so an insider mark is an asset rather than a barrier — the people who recognise `\a` are
the only people who will ever see it. This is the same bet Ghostty makes with an ASCII ghost and
kitty makes with a cat on a terminal window.

This does **not** license hostility to newcomers. Earlier product decisions about reducing setup
friction stand; "approachable" and "insider" are not in tension here.

## 3. The marks

Two marks, one system.

| Mark | Form | Used for |
|---|---|---|
| **Lockup** | `$\a` | **The app icon**, splash, website, README, store listings |
| **Monogram** | `\a` | Favicon and anything at or below ~32px |

**Errata 2026-09-20 (Task 2 checkpoint).** This table originally gave the app icon to the monogram,
on the grounds that three glyphs at 46px was a legibility risk. Tested at the icon sizes that
matter, that was too strong: `$\a` at 62% tile width is about as legible at 46px as `\a` at 38%.
The prompt therefore stays in the icon, which is what the original brief asked for. The monogram
survives only for sub-32px use, where three glyphs genuinely do collapse.

The trade accepted knowingly: a wider lockup fills more of the tile, so the icon is less airy than
the monogram version. Legibility and the brief both pointed the same way, and the negative space
lost.

### Anchoring

**The mark sits at the top left, not centred** — a prompt at the start of an otherwise empty
screen. This follows the convention every serious terminal icon uses: `Terminal.app` puts `>` in
the upper left with `_` on the line below; iTerm2 does the same with `$`. Centring a terminal mark
reads as a logo in a box; anchoring it reads as a shell.

Geometry is parametric, not hand-placed:

| Parameter | Value | Meaning |
|---|---|---|
| `occupy` | **0.62** | Mark width as a fraction of the tile |
| `inset` | **0.13** | Padding above and left of the mark, in the same units |

The monogram, where used, is `occupy` 0.38 / `inset` 0.15.

Framing is computed from the **union bounding box of the actual glyph outlines**, never from font
metrics. Metrics describe a line of text and know nothing about a square tile — using them is what
made the first attempt sit visibly high.

**A cursor block on the next line was tried and rejected.** It echoed `Terminal.app`'s `_` and read
well at 150px, but the frame has to grow to fit a second line, which shrinks the glyphs by roughly
20% and costs more at 46px than the narrative is worth.

**Two-tone is the default treatment.** The leading glyph (`$`, or the `\` in the monogram) is
muted; the final `a` carries the accent. The escape recedes, the bell rings. Solid single-colour
versions exist for cases where two tones cannot survive — monochrome Android, favicons, embroidery,
single-colour print.

**Glyphs must be drawn as paths, not set in a font.** The reference studies used JetBrains Mono
Bold, which is the right skeleton, but the shipped mark must not depend on a font file being
present or on a future version of that font changing. Draw once, ship as SVG paths.

**Rejected: `❯` as the prompt.** JetBrains Mono Nerd Font renders `❯` as a thin curve that reads as
`)` at a glance. `$` is the stronger glyph and the more universal prompt. A chevron would have to
be custom-drawn, which buys nothing over `$`.

**Also considered: `^G`.** Equally valid, arguably more honest since `^G` is what a terminal
literally echoes. Rejected only because `\a` is the more graceful shape and the two-tone split
works better on it. Recorded so the option is not re-litigated from scratch.

## 4. Colour

| Role | Value | Notes |
|---|---|---|
| Brand accent | **Amber `#F59E0B`** | The mark, links, primary buttons |
| Muted glyph | `#4A4A55` | `tokens.textFaint` — the recessive half of the two-tone |
| Canvas | `#000000` | `tokens.bg`, true black |
| Tile / surface | `#0B0B0D` | `tokens.surface`, the icon's rounded-square field |
| Hairline | `#1F1F26` | `tokens.border` |

**The icon tile carries a diagonal sheen** (added 2026-09-20): a linear gradient at 135°, from
`#1B1B24` at 0%, through `#0B0B0D` at 46%, to `#050507` at 100%. Lighter at the top left, darker at
the bottom right.

**Depth belongs to the container, not the glyph.** Gradients across the letterforms were tried —
amber-to-orange, diagonal, and with a gloss highlight — and all were rejected: they desaturate the
accent at small sizes and read as decoration. `Terminal.app` does exactly this, flat white glyphs
on a softly lit tile, and it is right. This also keeps the glyph fills to the two approved colours,
so the source SVGs stay two-tone and the colour test in `apps/mobile/test/brand-sources.test.ts`
keeps its teeth.

The gradient is applied when rasterising, not stored in the mark's SVG source, so the same source
serves the lit icon, the true-black splash, and the flat single-colour Android monochrome variant.

**Amber over emerald, deliberately.** Amber is authentic phosphor heritage, it is *unclaimed* in
this space (Ghostty owns violet, Herdr lavender, iTerm2 green), and it means attention — it is the
colour of an alert. For a product whose entire premise is a bell, that is an argument rather than a
preference. Emerald would have made Shellbell the second green terminal icon.

**The brand accent does not change the app's accents.** The product keeps its eight per-computer
accents with emerald (`#10B981`) as default, including `app.json`'s notification colour. The brand
says "attention" once, at the front door; inside, the colour belongs to the user's computers. These
two systems are intentionally separate and must not be unified.

## 5. Typography

**JetBrains Mono, everywhere, including display sizes.** No secondary grotesk.

The font is already embedded in the app, so the product and the website share one typeface at no
additional cost. Mono set large with tight tracking reads deliberate rather than retro, and it
avoids the "heavy sans headline with one accent word" pattern that is now the default look of every
developer-tool landing page.

Conventions: lowercase or sentence case, never all-caps headlines. Small labels may be uppercase
with wide letterspacing (~0.2em) as a texture, matching the existing UI.

## 6. Assets to produce

Every file below is currently an **unmodified Expo template placeholder** — `icon.png` still has
its construction guides baked in (concentric circles, dashed axes, centre crosshair) and
`splash-icon.png` is blank graph paper. Both are light-themed, contradicting the OLED-black
identity. These were never tracked as placeholders in `before-first-release.md`.

| File | Content |
|---|---|
| `apps/mobile/assets/icon.png` | `\a` monogram, two-tone amber on `#0B0B0D` |
| `apps/mobile/assets/android-icon-foreground.png` | `\a`, safe-zone aware |
| `apps/mobile/assets/android-icon-background.png` | Flat `#0B0B0D` |
| `apps/mobile/assets/android-icon-monochrome.png` | `\a`, single colour, for themed icons |
| `apps/mobile/assets/splash-icon.png` | `$\a` lockup on true black |
| `apps/mobile/assets/favicon.png` | `\a` monogram |
| Website | `$\a` lockup, plus an SVG source of record |

Source SVGs live in the repo so the raster assets can be regenerated rather than hand-edited.

## 7. Non-goals

- **Light mode.** Deferred by decision on 2026-09-19. Spec §71 states OLED-black as a product
  principle and §1694 derives the shadow-less card design from it; reversing that needs its own
  errata, doubles every future UI change, and would require a second visual QA pass on hardware
  that is not currently available (there is no iPhone; see `before-first-release.md`).
- **A drawn bell.** Tried and rejected; see §1.
- **Unifying brand accent with in-app accents.** See §4.

## 8. Open

- ~~Optical spacing~~ — **closed 2026-09-20.** Superseded by parametric anchoring (§3): the mark is
  framed from its glyph bounding box at a fixed `occupy`/`inset`, so there is nothing to hand-tune
  and nothing to be overwritten by regenerating.
- **The splash shows the lockup alone, no "shellbell" wordmark** — closed 2026-09-20.
- Whether the website's `$\a` is static or animates the `a` on load, once, as a ring. Still open;
  there is no website spec yet.
