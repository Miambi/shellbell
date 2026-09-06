# Contributing

## Workflow

- **Package manager:** pnpm 11 workspaces (`node-linker=hoisted`). Run `pnpm install` at the repo
  root.
- **Style:** Biome (2-space indent, double quotes, semicolons, 100 columns). Run `pnpm lint:fix`
  before you check anything in, then confirm with `pnpm lint`.
- **Types:** TypeScript, strict, `noUncheckedIndexedAccess` on in the mobile package. Run
  `pnpm typecheck`.
- **Tests:** Vitest. Run `pnpm test`, or scope it to one package (below) while iterating.

Before opening a PR, the full gate must pass:

```
pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test
```

## Package filters

The repo root is `shellbell-monorepo`. Four packages:

- `shellbell` — the agent (`apps/agent`). This is the published npm package name, not
  `@shellbell/agent`.
- `@shellbell/mobile` — the phone app (`apps/mobile`).
- `@shellbell/relay` — the Cloudflare Worker (`apps/relay`).
- `@shellbell/protocol` — shared wire-protocol schemas and crypto (`packages/protocol`).

Use `pnpm -F <package>` to scope a command, e.g. `pnpm -F shellbell build` or
`pnpm -F @shellbell/protocol test`.

## Running the relay locally

```
pnpm -F @shellbell/relay dev
```

This starts `wrangler dev`, which serves the relay at `ws://127.0.0.1:8787` by default. Point a
local agent at it instead of the hosted relay:

```
shellbell config set relay ws://127.0.0.1:8787
```

A plain `ws://` relay is only accepted with `--insecure` or `SHELLBELL_ALLOW_INSECURE_RELAY=1` —
that's expected for local dev, never for anything reachable over the internet.

## Building the app

The mobile app uses native modules (push notifications, secure storage) that Expo Go can't run, so
day-to-day development needs a development build installed on a device or simulator first (see
`docs/before-first-release.md` for how those are produced). Once you have one:

```
pnpm -F @shellbell/mobile start
```

For a source-only change, the fast loop is
`pnpm -F @shellbell/mobile typecheck && pnpm -F @shellbell/mobile test` — but the full root gate
above must still pass before a PR merges.

## Adding a terminal backend

1. Implement the `TerminalBackend` interface (`apps/agent/src/backends/types.ts`).
2. Register it in `apps/agent/src/backends/registry.ts`.
3. Add a live test alongside the existing ones — see `apps/agent/test/live-tmux.test.ts` and
   `apps/agent/test/live-herdr.test.ts` for the pattern: gated behind an environment variable so
   it's skipped by default and only runs against a real backend on request.

## Publishing plumbing

`apps/agent/dist` is a bundled build (`tsdown`), not source — don't hand-edit it. Every change
that touches the agent's packaging should pass:

```
pnpm -F shellbell check:bundle
```

That check gates the publish (`prepublishOnly`) and catches an unbundled dependency or a broken
`bin` entry before it ships.
