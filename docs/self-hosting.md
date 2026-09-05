# Self-hosting the relay

The relay is a single Cloudflare Worker with one Durable Object class. It fits the free plan.

1. `git clone https://github.com/Miambi/shellbell && cd shellbell && pnpm install` (or clone your fork)
2. `cd apps/relay && pnpm wrangler login`
3. `pnpm wrangler deploy` → note the `https://shellbell-relay.<account>.workers.dev` URL.
4. (Optional) `pnpm wrangler secret put EXPO_ACCESS_TOKEN` with an Expo access token. Not required:
   the official Shellbell app's Expo project keeps "enhanced push security" off, so your relay can
   send pushes to it without a token.
5. (Recommended) In the Cloudflare dashboard, add a rate-limiting rule for your Worker:
   path starts with `/ws/`, 30 requests per minute per IP.
6. On each Mac: `shellbell config set relay wss://shellbell-relay.<account>.workers.dev`, then
   `shellbell pair`. The QR carries the relay URL, so phones need no configuration.

Load shedding: set the `MIN_FRAME_MS` var (default 125) to 250 or 500 to reduce request usage.

The relay never sees terminal content: everything between phone and Mac is end-to-end encrypted.
It stores: computer name, paired phone public keys and names, Expo push tokens, leases, and
rate-limit counters. Storage for a computer is deleted 90 days after its agent last connected.

## Multiple Cloudflare accounts

Wrangler supports named profiles to manage multiple Cloudflare accounts. When you run `wrangler login` from a directory bound to a profile, it authenticates with that account. Use `wrangler whoami` to confirm which account is active; it prints `Active profile: <name>` or the default if none is set. This is useful if you manage the relay under a dedicated account or need to test deploys against different environments.
