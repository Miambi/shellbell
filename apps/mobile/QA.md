# Manual QA — run on iOS and Android before every TestFlight/internal build

- [ ] Fresh install → Computers empty state → Pair → camera permission → scan → **confirmation
      sheet names the computer and shows the fp prefix** → confirm on Mac → sessions list.
- [ ] Cancel the confirmation sheet: nothing is sent, the scanner re-arms.
- [ ] Session: live tail follows; scroll up stops following; "Jump to live" returns; pull-to-top
      loads history and **stops** at the oldest available line.
- [ ] Cursor stays on its row while scrolling; a herdr session's cursor is visibly dimmed.
- [ ] Input: line mode send + history ↑; raw mode typing into `vim` and Claude Code, including
      **backspacing several characters in a row**; Esc/^C/arrows; paste; reply chips appear while a
      command runs **and while a Herdr session is `blocked`**.
- [ ] Sessions list shows the right badge for iTerm2 / tmux / Herdr; a `blocked` session is
      distinct from `running`.
- [ ] Background the app → relay treats phone as away (verify with a ring in Plan 06).
- [ ] Kill the agent → the last screen dims with "offline" (it does not disappear); restart →
      reconnects and re-subscribes.
- [ ] Unpair on the Mac (`shellbell unpair`) → app shows the unpaired state with Re-pair.
- [ ] Force-close the socket mid-command → "Some input may not have been delivered" toast appears
      exactly once and nothing is re-sent.
- [ ] Settings: accent changes propagate; font size persists; self-test all ✓.
- [ ] Second computer pairs and both appear; switching between them works.
- [ ] Header `⋯` on a session: "Bring to front on Mac" only for iTerm2/Herdr; "New … tab" /
      "Split vertical" / "Split horizontal" only for a backend that supports `createSession`; a
      tmux session (no `focus`) never shows "Bring to front".
- [ ] End a session on the Mac while its screen is open on the phone → it shows "Session ended."
      with a Back action instead of the stale frozen screen, and the input bar disappears.
- [ ] Computer settings (`⋯` on the sessions list): accent picker, backends badges, notifications
      switch, and Unpair (with confirmation) all work; Unpair returns to the Computers list.
- [ ] App settings: this phone's name/fingerprint show; font-size stepper and Fit width persist
      across app restarts; the CJK IME note is visible; About links (repo, Buy Me a Coffee) open.
