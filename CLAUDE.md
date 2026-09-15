# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

**Read [`AGENTS.md`](AGENTS.md).** It holds the commands, architecture and conventions, and is kept
tool-neutral so Claude Code and Codex work from the same instructions. This file exists only to
point there — put new guidance in `AGENTS.md`, not here, so the two cannot drift.

Two things worth repeating because they are expensive to get wrong:

- **`docs/before-first-release.md` is the live release checklist.** Read it before touching
  anything release-related. Nothing is published yet, and PR #9 "Version Packages" must not be
  merged — merging it publishes to npm irreversibly.
- **The spec wins.** `docs/superpowers/specs/2026-09-03-shellbell-design.md` is the authority over
  the plans in `docs/superpowers/plans/`. Corrections go in place with an errata marker.
