# Self-hosting the relay

The relay is a single Cloudflare Worker with one Durable Object class. It fits the free plan.

1. `git clone https://github.com/Miambi/shellbell && cd shellbell && pnpm install` (or clone your fork)
2. `cd apps/relay && pnpm wrangler login`
3. `pnpm wrangler deploy` → note the `https://shellbell-relay.<account>.workers.dev` URL.
   Ignore `wrangler.hosted.jsonc`; it binds the author's `relay.shellbell.dev` domain and is used only by CI.
4. (Optional) `pnpm wrangler secret put EXPO_ACCESS_TOKEN` with an Expo access token. Not required:
   the official Shellbell app's Expo project keeps "enhanced push security" off, so your relay can
   send pushes to it without a token.
5. (Recommended) In the Cloudflare dashboard, add a rate-limiting rule for your Worker:
   path starts with `/ws/`, 30 requests per minute per IP.
6. On each Mac: `shellbell config set relay wss://shellbell-relay.<account>.workers.dev`, then
   `shellbell pair`. The QR carries the relay URL, so phones need no configuration.

Load shedding: set the `MIN_FRAME_MS` var (default 125) to 250 or 500 to reduce request usage.

Shellbell also works with [Herdr](https://herdr.dev) 0.7.2 or newer: if a Herdr server is running
for your user, the agent finds its socket (`$HERDR_SOCKET_PATH`, else `$HERDR_SESSION`'s socket,
else `$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`) and mirrors its panes
automatically, ringing you when an agent is blocked. Nothing to configure, and no Herdr code is
bundled — Shellbell just speaks its local socket API.

See [`PRIVACY.md`](../PRIVACY.md) for exactly what the relay stores and sees — self-hosting your
own relay doesn't change any of it, since the guarantee is end-to-end encryption between phone
and Mac, not who runs the relay in between.

## Multiple Cloudflare accounts

Wrangler 4.1xx has experimental named auth profiles. Create one per account with
`wrangler auth create <name>` (it opens the normal login flow), bind it to a directory with
`wrangler auth activate <name> <dir>`, and every wrangler command run under that directory uses
that account. `wrangler whoami` prints `Active profile: <name>` so you can confirm which account a
deploy will hit; `wrangler auth list` shows all profiles, and `--profile <name>` selects one for a
single command. Without profiles, `wrangler login` keeps one global session, or set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment (that is what the deploy
workflow does).
