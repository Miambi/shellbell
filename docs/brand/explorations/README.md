# Brand explorations

The visual record behind `docs/superpowers/specs/2026-09-19-shellbell-brand-design.md`.

The spec states what was rejected and why. These are the images those statements are about, so a
reader can check the reasoning instead of taking it on trust — and so nobody re-runs an exploration
that already happened. All produced 2026-09-19/20.

Nothing here is a shipped asset. The real marks live in `brand/` (website, README, press) and
`apps/mobile/assets/` (app icon set), both generated from committed SVG sources.

| File | What it settled |
|---|---|
| `01-drawn-bells.jpg`, `02-drawn-bells-lower.jpg` | Six drawn bell marks — block, clapper, flared, prompt-plus-bell, squared, cursor-plus-ring — at 132px and 48px, amber and emerald. **All rejected** (spec §1): a drawn bell either reads as a generic notification icon or loses the terminal entirely, and none survived 48px keeping both readings. |
| `03-bel-character-studies.jpg` | `\a`, `^G`, `❯\a`, `$\a`, `❯` alone, each solid / two-tone / at 46px. Settled that the mark is **the BEL escape, not a picture of a bell**, and that `❯` renders as a thin curve reading as `)` — hence `$`. `^G` was viable and lost on shape alone (spec §3). |
| `04-terminal-app-reference.png` | macOS Terminal.app's own icon, unmodified. The source of **top-left anchoring** and of putting depth in the tile rather than the glyphs (spec §3 Anchoring, §4). |
| `05-optical-checkpoint.jpg` | The first Task 2 checkpoint: monogram and lockup at 180/96/46/29px. Exposed that font metrics had placed the mark visibly high — the reason framing is computed from the glyph bounding box. |
| `06-depth-options.jpg` | Flat, block-cursor knockout, phosphor glow, three-tone. All rejected as answers to "add depth". |
| `07-gradient-options.jpg` | Five gradients across the letterforms. **Rejected** (spec §4): they desaturate the accent at small sizes. Depth belongs to the container. |
| `08-top-left-anchoring.png` | Top-left anchoring adopted, with and without a lit tile, and the lockup variant. |
| `09-cursor-proportions.png` | A cursor block on the next line, sized from real font metrics: underscore, block muted, block amber, hollow. **Rejected** (spec §3) — the frame must grow for a second line, shrinking the glyphs ~20%. |
| `10-size-position-sweep.png` | `occupy` × `inset` sweep from 0.46/0.24 to Terminal.app's own 0.28/0.16, at 150/64/46/29px. Chose **0.38/0.15**, later 0.62/0.13 once the lockup took the icon. |
| `11-monogram-vs-lockup.png` | Whether `$\a` survives icon sizes. It does at 0.52–0.62 width — which **overturned** the spec's original "three glyphs at 46px is a legibility risk" and gave the icon its prompt back (spec §3 errata). |
| `12-android-composite.png` | Background + foreground composited, proving the two-layer split works. |
| `13-android-circle-mask.png` | The same, cropped to Android's guaranteed-visible centre 72/108dp and circle-masked. Confirms the mark survives the launcher mask whole. |
| `14-splash-centring.png` | The splash on a simulated 390×844 screen with a crosshair at true centre. Shows the mark sitting ~12dp left and ~37dp high — **an open issue**, since top-left anchoring needs a visible tile and the splash has none. |
| `15-logo-family.png` | Mark, wordmark, and both lockups, on dark and light. Settled the **two-tone wordmark** — `shell` muted, `bell` amber, echoing the mark's own structure. |
| `16-dollar-wordmark.png` | `$hellbell`, testing `$` as an `s` substitute. **Rejected**: legible, but removing the `s` leaves `$hell` reading as its own unit, which the two-tone split then isolates in its own colour. |
