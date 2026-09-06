# Privacy

This is the single source of truth for what Shellbell's relay stores and sees. Other docs
(`docs/self-hosting.md`, store listings) link here instead of restating it — if you find a
contradiction elsewhere, this file wins.

## End-to-end encryption

Everything sent between your phone and your Mac — screen contents, history, typed input, session
titles, commands — is end-to-end encrypted with a per-connection key the relay never has. The
relay forwards opaque bytes between the two devices; it cannot decrypt or inspect them. See the
design spec's Wire protocol (§7) and Security and threat model (§13) sections for the full
cryptographic argument.

## What the relay stores

The relay (whether the author's hosted instance or one you run yourself) stores only:

- Your computer's name and fingerprint.
- Paired phones' public keys and names.
- Expo push tokens, for phones that opted into notifications.
- Active pairing/session leases.
- Rate-limit counters, to stop abuse.

It never stores, and never sees, terminal content, session titles, commands, or anything you or
an agent type. Not encrypted-and-discarded — never received in the first place: those bytes are
sealed with a key only your phone and Mac hold.

## Logs

The relay's own code logs only a handful of generic error strings when something goes wrong — for
example `"do error"` or `"expo push failed"` paired with the error's name (never its message,
never a fingerprint, session id, or byte count) — to help debug outages. It never logs message
contents, fingerprints, or byte counts.

Separately, the hosted relay has Cloudflare Workers Logs enabled (`observability` in
`wrangler.jsonc`), which is Cloudflare's own platform logging: request metadata such as method,
status code and duration, automatically — not something this codebase controls or adds fields to.
Cloudflare retains Workers logs for a limited period (7 days on the free plan at the time of
writing); see Cloudflare's own documentation for the current retention on whichever plan the
hosted relay runs on.

## What a push notification carries

A push notification carries only:

- Your computer's name, as the notification title.
- A generic body chosen by event kind (a command finishing, a session going quiet, or an agent
  waiting on you) — never the session title, the command, or its output.
- A small data payload used only for routing: your computer's fingerprint, an opaque session id,
  and the event kind.

Apple and Google see that payload in order to deliver the push; they see nothing else about your
sessions.

## Deletion

- Unpair a phone at any time (from the phone or from the Mac) to remove its pairing, push token,
  and any leases immediately.
- If a computer's agent hasn't connected to the relay in 90 days, the relay deletes every row it
  holds for that computer automatically.

## Self-hosting

If you run your own relay, none of your data ever reaches the author's infrastructure — see
`docs/self-hosting.md`. This document still describes exactly what your own relay stores about
your devices.
