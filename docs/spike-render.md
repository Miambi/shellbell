# Spike: terminal rendering on device — results (YYYY-MM-DD)

- Devices: iPhone __ (iOS __), __ (Android __).
- 5 000-line log fling: iOS __ fps, Android __ fps (budget: no dropped frames).
- htop-like 60×160 redraw: __ ms per frame iOS / Android.
- CJK/emoji/combining alignment with the fixed-width View path: correct / off by __ cells.
- Decision: nested-Text path for lines without `n` (default) | fixed-width View path for all lines.
