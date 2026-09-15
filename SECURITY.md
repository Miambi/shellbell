# Security policy

## Reporting a vulnerability

Email **security@shellbell.dev** with details. Please do not open a public GitHub issue for a
suspected vulnerability.

We aim to acknowledge reports within a few days and follow **90-day coordinated disclosure**: we
ask for 90 days from acknowledgment to ship a fix before any public write-up, and we'll credit
you (unless you'd rather stay anonymous) when it goes out.

## Scope

**In scope:**

- The relay (`apps/relay`) — the Cloudflare Worker and Durable Object that route encrypted frames
  and gate pairing.
- The agent (`apps/agent`) — the `shellbell` CLI that runs on the Mac.
- The mobile app (`apps/mobile`).
- The protocol (`packages/protocol`) — cryptography, message schemas, and the wire format.

**Out of scope:**

- Vulnerabilities that require a compromised Mac user account or an unlocked, physically
  accessible phone — those are accepted trust boundaries (see the threat model below).
- Denial of service against a self-hosted relay you run yourself.
- Social engineering of the pairing confirmation prompt.
- Findings in third-party dependencies without a demonstrated, Shellbell-specific impact — please
  report those upstream instead.

## Threat model

For what Shellbell defends against (and explicitly doesn't) — network and relay adversaries,
malicious relay operators, physical device access, and more — see the design spec's Security and
threat model section:
[`docs/superpowers/specs/2026-09-03-shellbell-design.md`](docs/superpowers/specs/2026-09-03-shellbell-design.md#13-security-and-threat-model).

For what the relay stores and what a push notification carries, see [`PRIVACY.md`](PRIVACY.md).
