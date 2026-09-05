# Shellbell — Design Specification

**Status:** v2 (post external review) · **Date:** 2026-09-03 · **Author:** Bilal Ahmad (with Claude)
**Tagline:** *Your terminal rings. You answer.*

Shellbell lets you see your Mac's terminal sessions on your phone, get pinged when a
command finishes or a program is waiting for input, and reply — from anywhere. It is free,
open source (MIT), end-to-end encrypted, works with iTerm2 natively and with every other
terminal through tmux, and runs on a self-hostable relay that fits Cloudflare's free tier.

This document is written so that an implementer with **no prior context and modest
judgement** can build the system without guessing. Where a choice was made, the choice
is stated, not the alternatives. Where a value matters, the value is given. The zod
schemas in `packages/protocol` are **normative**; the tables in this document describe
them and must be regenerated from them if they ever disagree.

---

## Table of contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Glossary](#2-glossary)
3. [Decision log](#3-decision-log)
4. [Architecture](#4-architecture)
5. [Repository layout](#5-repository-layout)
6. [Identity, pairing and cryptography](#6-identity-pairing-and-cryptography)
7. [Wire protocol](#7-wire-protocol)
8. [The agent (`apps/agent`)](#8-the-agent-appsagent)
9. [The relay (`apps/relay`)](#9-the-relay-appsrelay)
10. [The mobile app (`apps/mobile`)](#10-the-mobile-app-appsmobile)
11. [Notifications end to end](#11-notifications-end-to-end)
12. [Connection lifecycle and error handling](#12-connection-lifecycle-and-error-handling)
13. [Security and threat model](#13-security-and-threat-model)
14. [Performance budgets and capacity](#14-performance-budgets-and-capacity)
15. [Testing strategy](#15-testing-strategy)
16. [Tooling, CI, release and distribution](#16-tooling-ci-release-and-distribution)
17. [Milestones and scope](#17-milestones-and-scope)
18. [Risks and spikes](#18-risks-and-spikes)
19. [External review log](#19-external-review-log)
20. [Appendix A — iTerm2 API facts (verified 2026-09-03)](#appendix-a--iterm2-api-facts-verified-2026-09-03)
21. [Appendix B — Lessons from `remote-iterm`](#appendix-b--lessons-from-remote-iterm)
22. [Appendix C — Pinned versions](#appendix-c--pinned-versions)

---

## 1. Goals and non-goals

### 1.1 Goals (v1)

- **See** every terminal session on a paired Mac from an iOS or Android phone, with the
  styles the terminal rendered (bold, colors, italics), including TUI programs such as
  Claude Code, `vim`, `htop`.
- **Two backends in v1**: **iTerm2** (native API) and **tmux** (control mode). tmux is
  how Shellbell reaches users of Ghostty, Warp, Terminal.app, Alacritty, Kitty, WezTerm —
  none of which the competitor supports — and remote Linux machines over SSH.
- **Respond**: send a line, send raw keystrokes, send named keys (Ctrl‑C, Esc, arrows…),
  paste; one-tap replies for the "agent is asking y/n" case.
- **Get rung**: a push notification when a long command finishes (with exit code) or a
  running program goes quiet after producing output (it is probably waiting for you).
- **Multiple computers** on one phone; **multiple phones** on one computer.
- **Open a new session** (new tab/window, or split of an existing session) from the phone,
  and **bring an iTerm2 session to the front** on the Mac.
- **Anywhere**: works on cellular; the Mac never opens an inbound port.
- **End-to-end encrypted**: the relay forwards ciphertext it cannot read; pairing
  requires a human at the Mac to confirm.
- **No accounts**: identity is a keypair per device; pairing is scanning a QR code.
- **Free to run**: Cloudflare free tier for the relay; `npx shellbell` on the Mac.
- **Open source**: MIT, self-hostable relay, public monorepo.
- **Beautiful**: OLED-black, monospace-first, one accent color per computer, native
  materials (Liquid Glass on iOS 26 where available), haptics.

### 1.2 Non-goals (v1)

- Not a terminal emulator. The phone paints styled text runs the agent produces; it
  never parses escape sequences.
- Colors use Shellbell's palette, not the terminal profile's. iTerm2 ANSI indices and
  default fg/bg are mapped to the theme in 10.9. Importing the Mac's actual palette is
  v1.1. ("The styles the terminal rendered" means bold/italic/underline/colour *indices*
  are faithful; the *hues* are Shellbell's.)
- No phone-sized sessions (sessions have the terminal's width). "New phone-sized tmux
  session" is v1.1.
- No direct Kitty / WezTerm backends in v1 (v1.1 — they reuse the tmux backend's SGR
  parser). No Ghostty/Warp direct backends until those apps ship a remote-control API;
  their users go through tmux.
- No rename / close / per-session mute from the phone in v1 (v1.1). No hidden sessions:
  iTerm2 *buried* and *minimized* sessions are not listed.
- No Live Activities / Dynamic Island / Watch app (v2, needs a native-module spike).
- No user accounts, sync between phones, or billing. Free with a Buy Me a Coffee link.
- No file transfer, no images (iTerm2 inline images render as blank cells).
- No Windows/Linux agent (tmux backend on Linux is v2).
- No persistent command history on the phone (memory-only in v1; persistent + encrypted
  history is v1.1).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Computer** | A Mac running the agent. Identified by its **fingerprint**. |
| **Phone** | A device running the mobile app. Also identified by a fingerprint. |
| **Device** | A computer or a phone. Every device has an identity keypair. |
| **Agent** | The Node CLI on the Mac (`apps/agent`). Talks to terminals, encrypts, connects to the relay. |
| **Relay** | The Cloudflare Worker + Durable Objects (`apps/relay`). Routes ciphertext, sends pushes. |
| **Backend** | An implementation of `TerminalBackend` (v1: iTerm2 and tmux, both active at once). |
| **Session** | One terminal (an iTerm2 pane, or a tmux pane). Has an id, a title, a screen, and a backend. |
| **Screen** | The visible rows of a session (`rows × cols` cells) plus cursor position. |
| **Scrollback / history** | Lines above the screen. Fetched on demand. |
| **Line** | An ordered list of **runs**. |
| **Run** | A string plus style (fg, bg, bold, italic, underline, strike, faint) and, when it differs from the code-point count, its cell count. |
| **Fingerprint (fp)** | Stable public identifier of a device, derived from its Ed25519 public key. |
| **Pairing** | The act of linking a phone to a computer by scanning a QR and confirming on the Mac. Produces a shared key `K_pair`. |
| **Connection key `K_conn`** | Per-connection key derived from `K_pair` and two fresh nonces. All frames use it. |
| **Envelope** | The outer, relay-visible message. Either `ctrl` (plaintext) or `e2e` (ciphertext). |
| **Inner message** | The decrypted content of an `e2e` envelope. |
| **Ring / event** | Something the agent decided is worth your attention (`prompt`, `idle`, `exit`). |
| **Lease** | A phone's declaration that it is in the foreground; the relay pushes only to phones without a live lease. |

---

## 3. Decision log

These were decided in conversation and are not open.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Primary use | Read output **and** respond (both, glance-and-reply is the 80% case) | Needs real styled rendering plus a good input surface |
| 2 | Where used | **Anywhere** (relay), not LAN-only | "Walk away" includes leaving the building; enables push |
| 3 | Trust model | **End-to-end encrypted**; relay is a dumb pipe | Terminal output is sensitive; relay is shared infra for a product |
| 4 | Platforms | **iOS + Android from day one** via Expo | One codebase; Expo push abstracts APNs/FCM |
| 5 | What a session is | **Mirror the terminal** (same sessions, same width) | Literally "see the sessions I already have" |
| 6 | Who it's for | **A product** — free, open source, coffee link, no billing | |
| 7 | Identity | **Device keypairs, no accounts** | Honest match for E2E; removes auth UI, deletion flows, support |
| 8 | Agent language | **Node/TypeScript** with a `TerminalBackend` interface | One language across agent/relay/app; terminals are plugins |
| 8b | v1 backends | **iTerm2 + tmux**, both shipped and run simultaneously | tmux covers every terminal without an API and Linux — the competitor is iTerm2-only |
| 9 | Name | **Shellbell** (`shellbell.app` / `shellbell.dev` available as of 2026-09-02) | BEL (`\a`, Ctrl‑G) is the terminal's own "attention" signal |
| 10 | Budget | Domain ≤ ~$15/yr, Cloudflare free tier. **Apple Developer Program $99/yr is unavoidable** for App Store/TestFlight; Google Play $25 once | Stated and accepted |
| 11 | License | **MIT** code + `TRADEMARK.md` reserving name/logo | Forks welcome, can't ship as "Shellbell" on stores |
| 12 | Pairing confirmation | **A human presses Enter on the Mac** for every pairing (v1) | A photographed QR must not grant shell access (review finding) |

---

## 4. Architecture

### 4.1 Components

```
┌─────────────── Mac ───────────────┐      ┌──── Cloudflare (free) ────┐      ┌──── Phone ────┐
│ iTerm2 ◀──unix socket WS──▶ agent │──WS──▶ Worker ─▶ ComputerDO(fp) ◀──WS──│ Shellbell app │
│ tmux   ◀──control mode ───▶       │      │   • auth by signature      │      │  (Expo)       │
│  ~/.shellbell/{identity,pairings} │      │   • routes ciphertext      │      │ SecureStore   │
└───────────────────────────────────┘      │   • sends Expo push ───────┼──▶ APNs/FCM ──▶ phone │
                                            └────────────────────────────┘      └───────────────┘
```

- **Agent** (`apps/agent`): the only component that talks to terminals. Runs every
  backend that is available on the Mac (iTerm2 if its API socket exists, tmux if a tmux
  server is running) and presents their sessions as one list. Holds one outbound WebSocket
  to the relay. Encrypts each inner message for a specific phone connection with that
  connection's `K_conn`. Decides when to ring. Owns pairing and is the **authority** on
  which phones are paired.
- **Relay** (`apps/relay`): a Worker that upgrades WebSockets and hands them to one
  **Durable Object per computer** (`ComputerDO`, id derived from the computer's
  fingerprint). The DO authenticates devices by signed challenge, mirrors the pairing list
  the agent gives it, keeps push tokens and leases, forwards envelopes, and calls Expo's
  push API. It never sees plaintext terminal data. Its pairing table is **metadata**, not
  authority: a phone the agent does not know cannot decrypt anything.
- **Mobile** (`apps/mobile`): Expo app. One WebSocket per paired computer while in the
  foreground. Decrypts, renders runs, sends input, shows notifications, manages pairings.
- **Protocol** (`packages/protocol`): shared TypeScript — message schemas (zod), CBOR codec,
  crypto helpers, named-key table, colour helpers, SGR parser, cell-width table, screen
  diff logic. Imported by all three.

### 4.2 Data flow — viewing a session

1. Phone opens session `S` → sends inner `subscribe { sessionId: S }` (encrypted).
2. Agent records `S` as that phone connection's viewed session, fetches the screen, sends
   `screen.snapshot`.
3. The backend reports a screen change for `S` → agent marks `S` dirty.
4. Every 125 ms (or the relay-advertised `minFrameMs`), for each dirty viewed session,
   the agent fetches the screen, computes a scroll-aligned line diff against the last
   frame, and sends `screen.diff` to each viewer that is up to date, or a fresh
   `screen.snapshot` to a viewer that missed a frame.
5. Phone applies the diff to its local screen model and re-renders changed lines only.

### 4.3 Data flow — replying

1. Phone sends inner `input.line { reqId, sessionId: S, text: "y" }`.
2. Agent calls the backend's `sendText(S, "y\r")` and replies `ack { reqId, ok: true }`.
3. Screen updates flow back as above. The app never re-sends an input on its own.

### 4.4 Data flow — ringing

1. The backend emits `command-end` for `S` (iTerm2 shell integration), or the agent's
   idle heuristic fires.
2. Agent sends an inner `event` to **every connected phone** (not just viewers) **and** a
   plaintext ctrl `notify` to the relay (event kind, exit code, duration, session id —
   never a title or content).
3. Relay sends an Expo push to every paired phone that has push enabled and **no live
   foreground lease**, rate-limited per session and per phone.
4. User taps the notification → app opens that computer, then that session once it is
   confirmed to exist.

### 4.5 Why a DO per computer

There are no users. The computer is the natural unit: it is what you pair with, what you
get notified about, what goes offline. All state for a computer (pairing mirror, push
tokens, leases, rate limits, pairing window) lives in its DO. A phone with three
computers holds three WebSockets; that is fine (phones are in the foreground only when
viewing).

---

## 5. Repository layout

Monorepo, pnpm workspaces. All paths below are exact.

```
shellbell/
├── package.json                  # workspaces, root scripts
├── pnpm-workspace.yaml
├── .npmrc                        # node-linker=hoisted (Metro-friendly)
├── biome.json                    # lint + format for the whole repo
├── tsconfig.base.json
├── LICENSE                       # MIT
├── TRADEMARK.md
├── PRIVACY.md  SECURITY.md  CONTRIBUTING.md
├── README.md
├── .github/
│   ├── FUNDING.yml               # buy_me_a_coffee: <handle>
│   └── workflows/
│       ├── ci.yml                # lint, typecheck, test, expo-doctor on push/PR
│       ├── release-agent.yml     # changesets → npm publish
│       └── deploy-relay.yml      # wrangler deploy on tag relay-v*
├── docs/
│   ├── superpowers/specs/2026-09-03-shellbell-design.md   # this file
│   ├── superpowers/plans/*.md
│   ├── spike-iterm2.md  spike-tmux.md  spike-render.md
│   ├── self-hosting.md  protocol.md
├── packages/
│   └── protocol/
│       ├── package.json          # name: @shellbell/protocol
│       ├── src/
│       │   ├── index.ts
│       │   ├── bytes.ts          # base64url, base32, utf8, concat, equal
│       │   ├── envelope.ts       # Envelope schema, byte-limit constants
│       │   ├── ctrl.ts           # ctrl message schemas
│       │   ├── inner.ts          # inner message schemas, SessionInfo
│       │   ├── screen.ts         # Line, Run, Color, Screen types, lineKey, applyDiff/applySnapshot
│       │   ├── codec.ts          # CBOR encode/decode (cborg), ProtocolError
│       │   ├── crypto.ts         # keys, fingerprint, seal/open, KDFs, sign/verify, AD builders
│       │   ├── keys.ts           # NamedKey enum → bytes
│       │   ├── qr.ts             # QR payload schema + encode/parse
│       │   ├── sgr.ts            # ANSI SGR text → Line (tmux; later Kitty/WezTerm)
│       │   ├── width.ts          # cellWidth(codePoint): 0 | 1 | 2
│       │   └── colors.ts         # ANSI 256 palette + default theme
│       └── test/                 # vitest; includes vectors.json golden vectors
├── apps/
│   ├── agent/
│   │   ├── package.json          # name: shellbell (published to npm), bin: shellbell
│   │   ├── proto/iterm2.proto    # OUR subset of the iTerm2 API (8.5.2)
│   │   ├── buf.gen.yaml
│   │   ├── scripts/spike-iterm2.ts  scripts/spike-tmux.ts
│   │   ├── src/
│   │   │   ├── cli.ts            # commander entry
│   │   │   ├── agent.ts          # orchestrator
│   │   │   ├── config.ts         # ~/.shellbell paths + JSON files
│   │   │   ├── identity.ts
│   │   │   ├── pairing.ts
│   │   │   ├── relay-client.ts
│   │   │   ├── phone-link.ts     # per-connection K_conn state, seq, dedupe
│   │   │   ├── screen-tracker.ts
│   │   │   ├── events.ts
│   │   │   ├── notifier.ts
│   │   │   ├── control.ts        # local unix socket for `pair`/`status`
│   │   │   ├── launchd.ts
│   │   │   ├── log.ts
│   │   │   └── backends/
│   │   │       ├── types.ts      # TerminalBackend interface
│   │   │       ├── registry.ts   # detects + composes available backends (8.12)
│   │   │       ├── iterm2/
│   │   │       │   ├── client.ts     # raw API client (WS + protobuf)
│   │   │       │   ├── auth.ts       # cookie/key via osascript
│   │   │       │   ├── convert.ts    # LineContents/CellStyle → Line
│   │   │       │   ├── backend.ts    # TerminalBackend impl
│   │   │       │   └── gen/          # generated by buf (gitignored)
│   │   │       ├── tmux/
│   │   │       └── herdr/                 # Herdr socket-API backend (8.13)
│   │   │           ├── client.ts     # NDJSON one-request-per-connection client
│   │   │           ├── convert.ts    # ansi lines → Line, faked cursor
│   │   │           └── backend.ts    # TerminalBackend + revision poller
│   │   │           ├── control.ts    # control-mode client: events + command channel
│   │   │           ├── keys.ts       # NamedKey → tmux key names
│   │   │           └── backend.ts    # TerminalBackend impl
│   │   └── test/                 # fixtures/ holds captured GetBuffer responses
│   ├── relay/
│   │   ├── package.json
│   │   ├── wrangler.jsonc
│   │   ├── src/
│   │   │   ├── index.ts          # Worker: routing, upgrade
│   │   │   ├── computer-do.ts    # ComputerDO
│   │   │   ├── auth.ts           # challenge/verify
│   │   │   ├── push.ts           # Expo push client
│   │   │   ├── limits.ts         # token bucket, byte caps
│   │   │   └── schema.ts         # DO SQLite schema (as a TS string)
│   │   └── test/                 # vitest + @cloudflare/vitest-pool-workers
│   └── mobile/
│       ├── package.json
│       ├── app.json              # expo config
│       ├── eas.json
│       ├── app/                  # expo-router routes (10.2)
│       ├── src/
│       │   ├── bootstrap/crypto.ts   # installs getRandomValues before anything else
│       │   ├── identity/
│       │   ├── net/
│       │   ├── store/
│       │   ├── screen/
│       │   ├── input/
│       │   ├── notifications/
│       │   ├── ui/               # design system
│       │   └── theme/
│       ├── assets/fonts/         # JetBrainsMonoNerdFont-{Regular,Bold,Italic,BoldItalic}.ttf
│       └── test/
└── scripts/
    └── e2e-local.sh              # runs the relay locally
```

---

## 6. Identity, pairing and cryptography

### 6.1 Primitives

All from the `@noble` family v2 (pure JS, audited, identical behaviour in Node, Workers and
React Native). Subpath imports **must** carry the `.js` suffix.

| Purpose | Algorithm | Import and call |
|---|---|---|
| Identity / signatures | Ed25519 | `import { ed25519 } from "@noble/curves/ed25519.js"` — `ed25519.keygen()`, `ed25519.sign(msg, secretKey)`, `ed25519.verify(sig, msg, publicKey)` |
| Key agreement | X25519 | `import { x25519 } from "@noble/curves/ed25519.js"` — `x25519.keygen()`, `x25519.getSharedSecret(secretKey, publicKey)` (rejects low-order points) |
| AEAD | XChaCha20-Poly1305, 24-byte nonce | `import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"` — `xchacha20poly1305(key, nonce, aad).encrypt(pt)` / `.decrypt(ct)` |
| KDF | HKDF-SHA256 | `import { hkdf } from "@noble/hashes/hkdf.js"`, `import { sha256 } from "@noble/hashes/sha2.js"` — `hkdf(sha256, ikm, salt, info, 32)` |
| Randomness | `crypto.getRandomValues` | `import { randomBytes } from "@noble/hashes/utils.js"` |

React Native has no `crypto.getRandomValues` by default and `import "expo-crypto"` does
**not** install one. `apps/mobile/src/bootstrap/crypto.ts` (10.7) assigns
`globalThis.crypto.getRandomValues` from `expo-crypto`'s `getRandomValues` and must be the
first import of the app.

String → bytes is always UTF-8 (`TextEncoder`). Concatenation (`‖`) is byte
concatenation. "base64url" is RFC 4648 §5 **without padding**. "base32" is RFC 4648 §6
lowercase without padding. Golden vectors for every derivation live in
`packages/protocol/test/vectors.json` (15).

### 6.2 Device identity

Each device generates, on first run, and stores forever:

```ts
type Identity = {
  ed25519: { pub: Uint8Array /*32*/; priv: Uint8Array /*32 seed*/ };
  x25519:  { pub: Uint8Array /*32*/; priv: Uint8Array /*32*/ };
  createdAt: string; // ISO 8601
};
```

**Fingerprint** = `base32lower(sha256(ed25519.pub))` truncated to **26 characters**
(130 bits). Alphabet `a-z2-7`. Example: `k7q3m2xwtpdd4vzebcjh5t6nra`. Display form groups
it as `k7q3-m2xw-…`; the UI usually shows the first 8 characters next to the device name.

The fingerprint is the DO name for computers and the identity string for phones on the
wire. It is derived, never chosen, so the relay can verify a claimed `fp` against a
presented public key with one hash.

### 6.3 Storage of secrets

| Device | Where | Format |
|---|---|---|
| Mac | `~/.shellbell/identity.json`, mode `0600`, directory mode `0700` | JSON, byte fields base64url |
| Mac | `~/.shellbell/pairings.json`, mode `0600` | JSON (8.3) |
| Phone | `expo-secure-store`, key `shellbell.identity.v1` | JSON, byte fields base64url |
| Phone | `expo-secure-store`, key `shellbell.pair.<computerFp>` | JSON `{ kPair, computerEd25519Pub, computerX25519Pub }` base64url |

Keychain on macOS is a v2 improvement; the file-with-0600 approach is what `ssh` does and
is acceptable for v1.

### 6.4 Pairing protocol

**Goal:** the phone and computer end up with the same 32-byte `K_pair`, a human at the Mac
has approved it, the relay learns that this phone may connect to this computer, and the
relay learns nothing that lets it impersonate either side or read traffic.

**Notation:** `fp_c`, `fp_p` computer/phone fingerprints; `E_pk`, `X_pk` Ed25519/X25519
public keys; `code`, `gate` 16 random bytes each; `‖` concatenation.

**Step 0 — agent opens a pairing window.** `shellbell pair` (or first run with no
pairings) generates `code = randomBytes(16)` and `gate = randomBytes(16)`, sends ctrl
`pairing-open { gateHash: sha256(gate), expiresAt: now + 5 min }` to the relay, and prints a
QR encoding the JSON:

```json
{ "v": 1, "r": "wss://relay.shellbell.app", "c": "<fp_c>", "e": "<base64url E_pk_c>",
  "n": "Bilal's MBP", "p": "<base64url code>", "g": "<base64url gate>" }
```

`r` relay WebSocket base URL, `c` computer fp, `e` computer Ed25519 pub, `n` display
name, `p` pairing code (never leaves the two devices), `g` gate preimage (shown to the
relay). ≈ 220 chars, a medium QR.

**Step 1 — phone scans and connects.** The phone verifies `sha256(e)` → `c` (abort if
mismatch), opens `<r>/ws/<fp_c>` (`r` already contains the scheme and host), and performs
the auth handshake (6.5) with `role: "pairing"` and `gate`. The DO admits a pairing socket
only while a window is open **and** `sha256(gate)` equals the window's `gateHash` **and**
fewer than 5 pairing sockets have been admitted for this window; otherwise
`auth-fail { reason: "no-window" }`. A pairing socket lives at most 90 s and may send
exactly one `pairing-request`.

**Step 2 — phone sends the request.** The phone derives
`K_psk = HKDF(code, "shellbell-pairing-v1", fp_c, 32)` and sends ctrl:

```
pairing-request {
  phoneFp: fp_p,
  box: seal(K_psk, CBOR{ ed25519Pub: E_pk_p, x25519Pub: X_pk_p, name: "Bilal's iPhone", platform: "ios" },
            ad = "pairing-request|" + fp_c + "|" + fp_p)
}
```

**Step 3 — agent validates and a human confirms.** The agent checks the window is open,
opens the box with its own `K_psk` (failure → `pairing-reject { reason: "bad-code" }`;
after 3 failures the window closes), verifies `sha256(ed25519Pub)` → `fp_p`, then prints:

```
  Pair "Bilal's iPhone" (fp 7h3k-d9xq)?  [y/N]  (60 s)
```

in the terminal running `shellbell pair` (8.1). Anything but `y` within 60 s →
`pairing-reject { reason: "declined" }`. `shellbell pair --yes` skips the prompt and is
documented as unsafe on shared screens.

**Step 4 — key derivation.** Both sides compute:

```
shared = X25519(X_priv_self, X_pub_other)          // abort if all zero
K_pair = HKDF(ikm = shared ‖ code, salt = "shellbell-pair-v1", info = fp_c + "|" + fp_p, len = 32)
```

Mixing `code` into the KDF means a relay that forwarded (or replaced) the X25519 keys
still cannot derive `K_pair`, because it never saw `code`.

**Step 5 — agent responds and registers.** Agent persists the pairing (8.3), then sends:

- ctrl `pairing-add { phoneFp: fp_p, ed25519Pub: E_pk_p, name }` — the DO inserts the
  pairing row (max 10 pairings per computer; beyond that the agent refuses first).
- ctrl `pairing-response { phoneFp: fp_p, box: seal(K_psk, CBOR{ x25519Pub: X_pk_c, computerName, accent }, ad = "pairing-response|" + fp_c + "|" + fp_p) }` — forwarded to the pairing socket.
- ctrl `pairing-close` — the window is single-use; the relay marks it closed.

`code` and `gate` are discarded.

**Step 6 — phone finishes.** Phone opens the box, derives `K_pair`, stores it (6.3),
adds the computer to its list, closes the pairing socket, and reconnects with
`role: "phone"`.

**Second computer:** repeat from step 0 on that computer. **Second phone:** repeat from
step 0 on the same computer; the agent's pairing list grows.

### 6.5 Authentication to the relay

Every WebSocket connection to a `ComputerDO` begins:

1. DO → client: ctrl `challenge { nonce: bytes(32), connId: string }` (`connId` is 16
   random bytes base64url; unique per socket; used for routing and bookkeeping only).
2. Client → DO: ctrl `auth { role: "agent"|"phone"|"pairing", fp, ed25519Pub: bytes(32), sig: bytes(64), name: string, appVersion: string, gate?: bytes(16) }` where
   `sig = Ed25519.sign(priv, utf8("shellbell-auth-v1|" + connId + "|" + role + "|" + fp + "|" + base64url(nonce)))`.
3. DO verifies: `sha256(ed25519Pub)` → `fp`; signature valid; and
   - `agent`: `fp == DO name`. First-ever agent connect stores `ed25519Pub` in the
     `computer` row; later connects must match it (enforced by construction: `fp = base32(sha256(pub))[0..26]` is checked against `pub` on every auth, so a matching fp implies the same key). An existing agent socket is closed
     with `4005` ("superseded") — the newest process wins.
   - `phone`: `fp` present in `pairings`, and `ed25519Pub` equals the stored one. An
     existing socket for the same `fp` is closed with `4005` — **one live socket per
     phone per computer**.
   - `pairing`: window open, `sha256(gate)` matches, admission count < 5; no fp check.
4. DO → client: ctrl `auth-ok { role, agentOnline, computerName, serverTime, minFrameMs }`
   or ctrl `auth-fail { reason }` followed by close code `4001`.

Unauthenticated sockets are closed after **10 seconds** (`4408`).

### 6.6 Per-connection key handshake (replay protection)

`K_pair` is long-lived, so frames are never encrypted directly under it except the two
handshake messages. Every time a phone and the agent are both connected, they run a
two-message handshake **inside** e2e envelopes and derive a fresh `K_conn`. The relay's
`connId` has **no security role**.

1. Phone (after `auth-ok` with `agentOnline: true`) → agent: e2e envelope with `seq: 0`,
   body sealed under `K_pair`, `ad = "1|" + fp_p + "|" + fp_c + "|hello|0"`, inner
   `conn.hello { n: randomBytes(16) }`.
2. Agent → phone: same shape, `ad = "1|" + fp_c + "|" + fp_p + "|hello|0"`, inner
   `conn.hello { n: randomBytes(16) }` with its **own fresh** random `n_a`. The agent keys
   this state by the phone's relay `connId` (learned from `phone-connected`), so a
   stale socket's frames can never be confused with the live one.
3. Both compute:
   ```
   salt    = n_p ‖ n_a                                  // 32 bytes
   connTag = base64url( sha256(salt) ).slice(0, 22)     // exactly 22 characters
   K_conn  = HKDF( ikm = K_pair, salt, info = utf8("shellbell-conn-v1|" + fp_c + "|" + fp_p), len = 32 )
   ```
4. From here on, every frame between the two uses `K_conn` (6.7). The agent sends
   `hello` / `sessions` only after step 2; the phone sends nothing but `conn.hello`
   until it receives the agent's `conn.hello`.

Why this is replay-safe: a captured frame was sealed under a `K_conn` that depends on
the agent's random `n_a` for that connection. Replaying the phone's `conn.hello` makes
the agent pick a new `n_a`, so no previously captured frame decrypts. Under `K_pair`
only `conn.hello` is ever accepted. If either side does not receive the peer's
`conn.hello` within **10 s** it closes and reconnects. This is not forward secrecy (a
stolen `K_pair` plus a captured transcript still decrypts); see 13.

### 6.7 Frame encryption (`e2e` envelopes)

```
nonce = randomBytes(24)
ad    = utf8( "1|" + from + "|" + to + "|" + connTag + "|" + seq )
body  = { n: nonce, c: XChaCha20Poly1305(K_conn).seal(nonce, CBOR(innerMessage), ad) }
```

- `connTag` is not transmitted; both sides know it. A relay that alters `from`, `to`, or
  `seq` causes AEAD failure and the frame is dropped.
- `seq` starts at `1` after the handshake (the `conn.hello` frames use `0`) and
  increments by 1 per frame per direction. Receivers keep `lastSeq` per peer connection
  and drop any frame with `seq <= lastSeq`.
- Decryption failure → drop frame, log at `warn`, increment a counter; after **20
  consecutive** failures from the same peer the receiver closes and reconnects. If the
  failure is on `conn.hello` itself (wrong `K_pair`, e.g. the computer was unpaired and
  re-paired), the phone shows "Re-pair this computer".

---

## 7. Wire protocol

### 7.1 Encoding and limits

All WebSocket frames are **binary** and contain one CBOR-encoded envelope, except:
protocol-level ping/pong control frames (agent keepalive) and the literal text frames
`"ping"` / `"pong"` (phone keepalive while foregrounded). Encoding uses `cborg` with
`{ ignoreUndefinedProperties: true }` (`packages/protocol/src/codec.ts` is the only place
`cborg` is called), so optional fields never appear on the wire. Every decoded object is
validated with zod before use; invalid frames are dropped (agent/app) or close the
socket with `4400` (relay).

**Byte limits (enforced before decoding):**

| Socket state | Max frame |
|---|---|
| unauthenticated | 4 KB |
| any `ctrl` frame | 16 KB |
| `e2e` from phone | 64 KB |
| `e2e` from agent | 1 MB |

Exceeding a limit closes the socket with `4413`. Per socket, a token bucket of **60
messages/s, burst 200** applies to every application message (ctrl and e2e envelopes alike) — only WebSocket protocol-level ping/pong frames are exempt, and those never reach the DO; exceeding it closes
with `4429`.

### 7.2 Envelope

```ts
export const EnvelopeSchema = z.object({
  v: z.literal(1),
  t: z.enum(["ctrl", "e2e"]),
  from: z.union([FpSchema, z.literal("relay")]),  // FpSchema = /^[a-z2-7]{26}$/
  to: FpSchema.optional(),                        // required for e2e
  seq: z.number().int().nonnegative(),            // e2e only; ctrl uses 0
  body: z.unknown(),                              // ctrl: CtrlMessage; e2e: { n: bytes(24), c: bytes }
});
```

The relay validates `Envelope`, then for `e2e` frames: checks `from` equals the
authenticated fp and forwards the **original bytes** to `to` if that peer is connected
(else drops silently — the sender learns via `presence`/`phone-disconnected`). It does not
inspect `body`.

### 7.3 Ctrl messages (plaintext; `body.type` discriminates)

Normative schema: `packages/protocol/src/ctrl.ts`. All strings are bounded there (names
≤ 64, tokens ≤ 256, arrays ≤ 32 unless stated).

| Type | Direction | Fields | Notes |
|---|---|---|---|
| `challenge` | relay → device | `nonce: bytes(32)`, `connId` | First frame on every socket |
| `auth` | device → relay | `role`, `fp`, `ed25519Pub`, `sig`, `name`, `appVersion`, `gate?: bytes(16)` | 6.5; `gate` only for `pairing` |
| `auth-ok` | relay → device | `role`, `agentOnline`, `computerName`, `serverTime`, `minFrameMs` | `minFrameMs` default 125; relay may raise it (14) |
| `auth-fail` | relay → device | `reason: "bad-sig"\|"not-paired"\|"fp-mismatch"\|"no-agent"\|"no-window"\|"timeout"` | Then close `4001` |
| `presence` | relay → phones | `agentOnline`, `computerName` | On agent connect/disconnect and after `auth-ok` |
| `unpaired` | relay → agent | `phoneFps: fp[]` | Always sent right after the agent's `auth-ok` (may be empty): phones that unpaired themselves while the agent was offline |
| `phones` | relay → agent | `connected: { phoneFp, connId, name }[]` | Sent after `unpaired` |
| `pairings-sync` | agent → relay | `phones: { phoneFp, ed25519Pub, name }[]` (≤ 10) | Agent sends after `unpaired`; the DO **replaces** its table (keeping push settings for retained fps) and closes sockets of removed phones (`4004`) |
| `pairing-open` | agent → relay | `gateHash: bytes(32)`, `expiresAt` | Opens the single pairing window |
| `pairing-close` | agent → relay | — | Closes it; also closed on agent disconnect and on expiry |
| `pairing-request` | phone → relay → agent | `phoneFp`, `box` | Only from a `pairing` socket, once |
| `pairing-response` | agent → relay → phone | `phoneFp`, `box` | Routed to the pairing socket with that `phoneFp` |
| `pairing-reject` | agent → relay → phone | `phoneFp`, `reason: "bad-code"\|"declined"\|"window-closed"\|"no-agent"\|"too-many"` | Relay forwards then closes the pairing socket (`4003`) |
| `pairing-add` | agent → relay | `phoneFp`, `ed25519Pub`, `name` | DO upserts pairing |
| `unpair` | agent → relay, or phone → relay | `phoneFp` | Agent may unpair any; a phone only itself. DO deletes the row and closes that phone's socket (`4004`). From a phone: forwarded to the agent if online, else recorded in `pending_unpairs` for the next `unpaired` |
| `push-token` | phone → relay | `token`, `platform: "ios"\|"android"`, `enabled: boolean` | Stored on the pairing row; `enabled:false` = never push this phone for this computer |
| `lease` | phone → relay | `ttlMs: 0..120000` | Foreground lease (11.3). Sent after `auth-ok`, every 30 s (ttl 60 000), and with `0` when backgrounding |
| `notify` | agent → relay | `sessionId`, `kind: "prompt"\|"idle"`, `exitCode?`, `durationMs?` | Triggers push per 11.3. **No title, no content.** |
| `phone-connected` | relay → agent | `phoneFp`, `connId`, `name` | When a paired phone authenticates |
| `phone-disconnected` | relay → agent | `phoneFp`, `connId` | When its socket closes; the agent ignores unknown `connId`s |
| `error` | relay → device | `code`, `message` | Informational |
| `ping` / `pong` | text frames | — | Phone keepalive while foregrounded; the relay auto-answers without waking the DO |

The DO closes (`4403`) a socket that sends a ctrl type not allowed for its role.

### 7.4 Inner messages (encrypted; `type` discriminates)

Normative schema: `packages/protocol/src/inner.ts`. Shared types:

```ts
Color   = palette index 0..255 | [r, g, b]
Run     = { t: string, fg?: Color, bg?: Color, b?, i?, u?, s?, f?: boolean, n?: number }
          // n = number of terminal cells this run occupies; present only when it differs
          // from the number of code points in t (wide CJK/emoji, combining marks)
Line    = { r: Run[], w?: boolean }                 // w = soft-wrapped into the next row
Cursor  = { x: number, y: number }                  // y = row on screen, 0-based; -1 if hidden
SessionInfo = { id, backend: "iterm2"|"tmux", title, cwd?, cols, rows,
                windowId, windowNumber, tabId, tabIndex, paneIndex,
                isFocusedOnMac: boolean, state: "unknown"|"editing"|"running"|"finished" }
          // id is "<backend>:<native id>", e.g. "iterm2:5A7B…" or "tmux:%3"
```

**Both directions**

| Type | Fields | When |
|---|---|---|
| `conn.hello` | `n: bytes(16)` | The only message sealed under `K_pair`; see 6.6 |

**Agent → phone**

| Type | Fields | When |
|---|---|---|
| `hello` | `agentVersion`, `backends: { name, capabilities }[]`, `computerName`, `accent` | After the handshake. `backends` lists only the ones currently connected |
| `sessions` | `list: SessionInfo[]` | On hello and on every layout/title/focus change (debounced 100 ms) |
| `screen.snapshot` | `sessionId`, `cols`, `rows`, `cursor`, `lines: Line[]` (length = rows), `scrollbackTotal`, `gen`, `reset?: boolean`, `degraded?: boolean` | On subscribe, on resize, when a viewer missed a frame, when a diff would exceed 60 % of rows. `reset` = the buffer was cleared (phone drops history). `degraded` = styles stripped to fit 256 KB |
| `screen.diff` | `sessionId`, `scroll` (≥ 0), `changed: { i, line }[]`, `cursor`, `scrollbackTotal`, `gen` | Otherwise. `scroll` = rows that left the top of the screen since the last frame. Apply order: shift, then `changed`. `gen` increments per frame per session |
| `history` | `sessionId`, `before`, `lines: Line[]`, `oldestAvailable` | Response to `history.get`; `lines[k]` is absolute line `before - lines.length + k`; the app stops asking when `historyFrom <= oldestAvailable` |
| `event` | `sessionId`, `kind: "prompt"\|"idle"\|"exit"`, `exitCode?`, `durationMs?`, `command?`, `at` | Sent to **every** connected phone, regardless of subscription (8.8) |
| `ack` | `reqId`, `ok`, `error?`, `sessionId?` | Response to every phone message that carries `reqId` |

**Phone → agent**

| Type | Fields | Effect |
|---|---|---|
| `subscribe` | `sessionId: string \| null` | Sets this connection's single viewed session (or none). A snapshot follows |
| `input.line` | `reqId`, `sessionId`, `text` (≤ 8 KB) | `sendText(text + "\r")`; `ack` |
| `input.text` | `reqId`, `sessionId`, `text` (≤ 64 KB) | `sendText(text)` verbatim; `ack` |
| `input.key` | `reqId`, `sessionId`, `key: NamedKey` | `sendText(bytesFor(key))`; `ack` |
| `history.get` | `reqId`, `sessionId`, `before`, `count` (1..200) | Agent fetches lines `[before-count, before)`; replies `history` then `ack` |
| `session.create` | `reqId`, `in: { kind: "tab", backend, windowId? } \| { kind: "split", sessionId, direction }` | New tab/window in the named backend, or split of an existing session; `ack.sessionId` is the new id |
| `session.focus` | `reqId`, `sessionId` | Bring that session forward **on the Mac** (iTerm2 only in v1; `ack.ok=false, error:"unsupported"` for tmux). Never implied by viewing |
| `snapshot.get` | `reqId`, `sessionId` | Force a snapshot (after a `gen` gap) |

**Delivery semantics.** Every phone → agent message carries a client-generated `reqId`
(base64url of 8 random bytes). The agent keeps the last 256 `reqId`s per phone
connection and answers a duplicate with the cached `ack` without re-executing. Inputs are
**at most once**: the app never re-sends automatically; if a socket closes with inputs
still un-acked, the app shows "Some input may not have been delivered" and clears them.

### 7.5 Named keys

`packages/protocol/src/keys.ts` is the single source of truth. Strings are what
`sendText` receives.

| NamedKey | Bytes | | NamedKey | Bytes |
|---|---|---|---|---|
| `enter` | `\r` | | `up` | `\x1b[A` |
| `tab` | `\t` | | `down` | `\x1b[B` |
| `shift-tab` | `\x1b[Z` | | `right` | `\x1b[C` |
| `esc` | `\x1b` | | `left` | `\x1b[D` |
| `backspace` | `\x7f` | | `home` | `\x1b[H` |
| `delete` | `\x1b[3~` | | `end` | `\x1b[F` |
| `ctrl-a` … `ctrl-z` | `\x01` … `\x1a` | | `page-up` | `\x1b[5~` |
| `ctrl-space` | `\x00` | | `page-down` | `\x1b[6~` |
| `f1`–`f4` | `\x1bOP` `\x1bOQ` `\x1bOR` `\x1bOS` | | `f5`–`f12` | `\x1b[15~` `\x1b[17~` `\x1b[18~` `\x1b[19~` `\x1b[20~` `\x1b[21~` `\x1b[23~` `\x1b[24~` |

The phone never sends escape bytes; it sends the enum value. The agent maps (tmux maps to
tmux key names, 8.11). Known limitation: iTerm2's `SendText` injects bytes, not key
events, so arrow/Home/End sequences are the *normal-mode* ones; programs that switch to
application-cursor mode (some `vim` configs) may ignore them. Documented in-app; v1.1
adds an "application mode" toggle.

### 7.6 QR payload

Schema in `packages/protocol/src/qr.ts`: `{ v: 1, r: url, c: fp, e: base64url(32), n: string(1..40), p: base64url(16), g: base64url(16) }`.
The app rejects any QR whose `r` is not `wss://` (or `ws://` only in a dev build), whose
`c` ≠ fingerprint of `e`, or whose `v` ≠ 1. The socket URL is `${r}/ws/${c}` — `r` has no
trailing slash.

---

## 8. The agent (`apps/agent`)

### 8.1 CLI

Published to npm as `shellbell`. `npx shellbell` runs `start`.

| Command | Behaviour |
|---|---|
| `shellbell` / `shellbell start` | Foreground. Ensures identity, connects to backends and relay, prints status. If there are **no pairings**, automatically opens a pairing window, prints the QR, and prompts for confirmation when a request arrives. `Ctrl-C` stops. |
| `shellbell pair [--yes]` | Opens a 5-minute pairing window and prints the QR. Talks to a running agent over `~/.shellbell/agent.sock`; if none is running, starts one in the foreground for the duration. Confirmation prompts appear here. `--yes` auto-accepts (unsafe on shared screens; the help text says so). |
| `shellbell status` | Identity fp, relay URL + state, each backend's state, session count, paired phones (name, fp prefix, last seen). |
| `shellbell devices` | Lists paired phones. |
| `shellbell unpair <fp-prefix\|name>` | Removes the pairing locally and tells the relay. |
| `shellbell service install` | Requires a global install (`npm i -g shellbell`; refuses under `npx`). Writes `~/Library/LaunchAgents/dev.bilalahmad.shellbell.plist` with `ProgramArguments: [<absolute node path>, <absolute cli path>, "start", "--service"]`, `EnvironmentVariables.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`, `RunAtLoad`, `KeepAlive`, logs to `~/.shellbell/agent.log`, then `launchctl bootstrap gui/$UID <plist>`. `uninstall` does `bootout` and deletes the plist. Re-running `install` after an upgrade rewrites the paths. |
| `shellbell logs [-f]` | Tails `~/.shellbell/agent.log`. |
| `shellbell config set relay <url>` / `name <name>` / `accent <color>` | Edits `config.json`. |
| `shellbell doctor` | Checks: iTerm2 running; API socket exists; cookie obtainable; tmux present and ≥ 3.2; relay reachable; identity readable; launchd paths valid; prints fixes. |

Global flags: `--relay <url>`, `--json` (for `status`/`devices`), `--verbose`.

**First-run UX (exact text):**

```
  Shellbell agent v0.1.0
  Computer   Bilal's MBP  (k7q3-m2xw)
  Relay      wss://relay.shellbell.app   connected
  iTerm2     connected · 7 sessions
  tmux       not running

  No phones paired yet. Scan this with the Shellbell app:

  █▀▀▀▀▀█ ▄▀ ▀▄ █▀▀▀▀▀█
  ...QR...

  Pairing window closes in 4:59
```

When a request arrives: `Pair "Bilal's iPhone" (fp 7h3k-d9xq)?  [y/N]  (60 s)`.

If iTerm2's API is disabled, `start` prints:

```
  iTerm2's Python API is off. Turn it on:
  iTerm2 → Settings → General → Magic → ✓ Enable Python API
  then run `shellbell` again.
```

### 8.2 Files in `~/.shellbell/`

| File | Mode | Content |
|---|---|---|
| `identity.json` | 0600 | `Identity` (6.2), bytes base64url |
| `pairings.json` | 0600 | `{ v:1, phones: Pairing[] }` (8.3) |
| `config.json` | 0600 | `{ v:1, relayUrl, computerName, accent, notifyMinCommandMs: 10000, idleQuietMs: 4000, idleMinActiveMs: 1500 }` |
| `agent.log` | 0600 | Rotating log (5 × 1 MB) |
| `agent.sock` | 0600 | Unix socket for `pair`/`status` when a daemon is running |
| `agent.pid` | 0600 | PID of the running agent |

Defaults: `relayUrl = "wss://relay.shellbell.app"`, `computerName = os.hostname()` with
`.local` stripped, `accent` = first unused entry in the 8-color palette (10.9).

### 8.3 `Pairing` record

```ts
type Pairing = {
  phoneFp: string; name: string; platform: "ios" | "android";
  ed25519Pub: string /*b64url*/; x25519Pub: string /*b64url*/;
  kPair: string /*b64url 32 bytes*/;
  pairedAt: string; lastSeenAt: string | null;
};
```

The agent is the authority. On every relay connect it applies the relay's `unpaired`
tombstones (deleting those pairings) and then sends `pairings-sync` with the full list.

### 8.4 `TerminalBackend` interface (`src/backends/types.ts`)

```ts
export type Capabilities = {
  subscribe: boolean;      // pushes screen-changed events (else agent polls at 250 ms)
  prompts: boolean;        // emits command-start/end/prompt events
  createSession: boolean; focus: boolean; history: boolean;
  absoluteLines: boolean;  // scrollbackTotal from the backend is a stable absolute line number
};
export type Screen = { cols: number; rows: number; cursor: Cursor; lines: Line[]; scrollbackTotal: number };
export type CreateWhere =
  | { kind: "tab"; backend: "iterm2" | "tmux"; windowId?: string }
  | { kind: "split"; sessionId: string; direction: "vertical" | "horizontal" };
export type BackendEvent =
  | { type: "screen-changed"; sessionId: string }
  | { type: "layout-changed" }
  | { type: "session-added"; sessionId: string }
  | { type: "session-removed"; sessionId: string }
  | { type: "focus-changed" }
  | { type: "title-changed"; sessionId: string }
  | { type: "command-start"; sessionId: string; command: string; at: number }
  | { type: "command-end"; sessionId: string; exitCode: number; at: number }
  | { type: "prompt"; sessionId: string; at: number };

export interface TerminalBackend {
  readonly name: "iterm2" | "tmux";
  readonly capabilities: Capabilities;
  connect(): Promise<void>;                     // throws BackendUnavailable with a user-facing hint
  close(): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;       // native ids; registry prefixes them
  getScreen(sessionId: string): Promise<Screen>;
  getHistory(sessionId: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }>;
  sendText(sessionId: string, text: string): Promise<void>;
  createSession(where: CreateWhere): Promise<string>;
  focus(sessionId: string): Promise<void>;      // may throw Unsupported
  on(handler: (e: BackendEvent) => void): () => void;
}
```

The agent core never imports backend-specific types. Backends must be safe to call
concurrently (the tracker may call `getScreen` for several sessions in one tick), but
`getScreen` for the **same** session is serialized by the tracker.

### 8.5 iTerm2 backend

#### 8.5.1 Connecting (`src/backends/iterm2/client.ts`, `auth.ts`)

1. **Cookie & key.** Run
   `osascript -e 'tell application "iTerm2" to request cookie and key for app named "Shellbell"'`.
   Output is `"<cookie> <key>"`. AppleScript error `-2740`/`-2741` → iTerm2 too old (need
   3.3+); other error → user denied or API disabled (print hint in 8.1). iTerm2 shows a
   one-time consent dialog naming "Shellbell" unless the user enabled "Allow all apps to
   connect". Cookies are single-use per process; request a new one on every (re)connect.
2. **Socket.** Connect with the `ws` package to the Unix domain socket
   `~/Library/Application Support/iTerm2/private/socket`:
   `new WebSocket("ws+unix://" + encodeURI(socketPath) + ":/", ["api.iterm2.com"], { headers })`,
   or, if that fails with the space in the path,
   `new WebSocket("ws://localhost/", ["api.iterm2.com"], { socketPath, headers })`.
   The spike (18.1) settles which; the code keeps one. Headers:
   ```
   origin: ws://localhost/
   x-iterm2-library-version: shellbell 0.1.0
   x-iterm2-disable-auth-ui: true
   x-iterm2-advisory-name: Shellbell
   x-iterm2-cookie: <cookie>
   x-iterm2-key: <key>
   ```
   Fallback if the socket file does not exist: `ws://localhost:1912`.
3. **Framing.** Each binary WS frame is one `ClientOriginatedMessage` / `ServerOriginatedMessage`.
   Requests carry `id` (incrementing int64); responses echo it. `Notification` messages
   arrive with no `id`. Requests time out after **5 s**.
4. **Reconnect.** Backoff 1 s → 2 s → … → 30 s (cap), fresh cookie each time. While
   disconnected the backend reports no sessions.

#### 8.5.2 Our proto subset (`apps/agent/proto/iterm2.proto`)

We do **not** vendor iTerm2's GPL `api.proto`. We write our own `proto2` file containing
only the messages we use, with identical names, field names and **field numbers** (these
are protocol facts). Generated with `@bufbuild/buf` + `@bufbuild/protoc-gen-es` into
`src/backends/iterm2/gen/` (gitignored). The complete file is in Plan 01, Task 2; it
includes `ListSessionsResponse.Tab.tmux_window_id = 4` (needed by 8.12) and
`ActivateRequest.App` / `activate_app = 7` (needed by 8.5.6). Unknown fields are ignored
by protobuf, so omitting messages/fields we don't use is safe; every field we *do* use
must be present in our file.

#### 8.5.3 Sessions and layout

`listSessions()`:

1. `ListSessionsRequest` → for each `window` (ordered by `number`), each `tab` (in
   order, `tabIndex` = position), walk `root` depth-first; each `SessionSummary` leaf gets
   `paneIndex` = visit order within the tab. `Tab.minimized_sessions` and top-level
   `buried_sessions` are **ignored** in v1.
2. For each session, two `VariableRequest { session_id, get: ["<name>"] }` calls — one for
   `session.name`, one for `session.path` (`VariableResponse.Status` has
   `MULTI_GET_DISALLOWED`; the Python library fetches one name per request) → `title`
   (fallback `SessionSummary.title`, fallback `"Session"`), `cwd`. Cache and refresh on
   `variable_changed_notification`, subscribed per session per name with
   `NotificationRequest { subscribe: true, notification_type: NOTIFY_ON_VARIABLE_CHANGE, variable_monitor_request: { name, scope: SESSION, identifier: <sessionId> } }`.
3. `cols/rows` from `grid_size`. `isFocusedOnMac` from the last `FocusChangedNotification`
   (`session` field) seeded by a `FocusRequest` at connect.
4. `state` from the prompt tracker (8.8).

Subscriptions made once at connect: `NOTIFY_ON_LAYOUT_CHANGE`, `NOTIFY_ON_NEW_SESSION`,
`NOTIFY_ON_TERMINATE_SESSION`, `NOTIFY_ON_FOCUS_CHANGE`, and per session:
`NOTIFY_ON_PROMPT` with modes `[PROMPT, COMMAND_START, COMMAND_END]`,
`NOTIFY_ON_SCREEN_UPDATE` (for every session — it carries no payload and drives the idle
heuristic), and the two variable monitors. On `new_session_notification`, add the
per-session subscriptions; on `terminate_session_notification`, drop state.
`layout_changed_notification` includes a full `ListSessionsResponse`; use it instead of
re-requesting.

#### 8.5.4 Screen (`getScreen`)

`GetBufferRequest { session, line_range: { screen_contents_only: true }, include_styles: true }`.

- `lines` = `contents` converted per 8.5.5, padded/truncated to exactly `rows` entries
  (iTerm2 omits trailing uninitialized lines; pad with `{ r: [] }`).
- `scrollbackTotal` = `windowed_coord_range.coord_range.start.y` (absolute index of the
  first screen row; iTerm2 numbering is stable even after history eviction, so
  `capabilities.absoluteLines = true`).
- `cursor.y` = `response.cursor.y - scrollbackTotal` clamped to `[-1, rows-1]`;
  `cursor.x` = `response.cursor.x`.

`getHistory(sessionId, before, count)`:
`GetBufferRequest { session, line_range: { windowed_coord_range: { coord_range: { start: { x: 0, y: max(0, before - count) }, end: { x: 0, y: before } } } }, include_styles: true }`
→ convert; return ascending. `oldestAvailable` = `before - lines.length` when fewer than
`count` lines came back (history evicted), else `0` (unknown; the app keeps paging until a
short page).

#### 8.5.5 Cell conversion (`convert.ts`) — exact algorithm

Input: `LineContents { text, code_points_per_cell[], style[], continuation }`. Output: `Line`.

```
1. Expand code_points_per_cell into cellCp[] (repeat each entry `repeats` times; default
   num_code_points = 1). If empty, every code point of `text` is one cell.
2. Expand style[] into cellStyle[] (repeat each CellStyle `repeats` times; default 1).
   If empty, every cell is unstyled.
3. Walk cells with textIndex over Array.from(text) (code points, not UTF-16 units):
     cpCount = cellCp[k]
     cellText = cpCount == 0 ? " " : next cpCount code points
     st = normalize(cellStyle[k] ?? {})
     append to the current run if its style equals st, else start a new run;
     track per run: cells += 1, codePoints += max(cpCount, 1) (a 0-cp cell contributes 1 space)
4. normalize(st):
     fg = st.fgRgb ? [r,g,b] : st.fgStandard != null ? st.fgStandard : undefined   (fgAlternate → undefined)
     bg = likewise from bgRgb / bgStandard
     if st.inverse: fg ??= 15; bg ??= 0; then swap fg and bg
     b = bold, i = italic, u = underline, s = strikethrough, f = faint
     invisible → text replaced by spaces; blink ignored.
5. For each run, set n = cells only if cells != codePoints.
6. Trim trailing runs that are only spaces with no bg. w = (continuation == CONTINUATION_SOFT_EOL).
```

Real `GetBufferResponse` fixtures from the spike are committed under
`apps/agent/test/fixtures/` and used in tests (invariants: concatenated run text equals
the cell text; `Σ n-or-length` equals the cell count).

#### 8.5.6 Input, create, focus

- `sendText(sessionId, text)` → `SendTextRequest { session: sessionId, text, suppress_broadcast: true }`.
  `SESSION_NOT_FOUND` → throw `SessionGone`.
- `createSession({kind:"tab", windowId})` → `CreateTabRequest { window_id: windowId, select_tab: false }` → `session_id`.
  `createSession({kind:"split", sessionId, direction})` → `SplitPaneRequest { session: sessionId, split_direction: direction=="vertical"?VERTICAL:HORIZONTAL }` → `session_id[0]`.
- `focus(sessionId)` → `ActivateRequest { session_id, order_window_front: true, select_tab: true, select_session: true, activate_app: { raise_all_windows: false, ignoring_other_apps: false } }`.
- (v1.1, not built in v1) close → `CloseRequest`; rename → `InvokeFunctionRequest { method: { receiver: sessionId }, invocation: 'iterm2.set_name(name: <json string>)' }`.

### 8.6 Screen tracker (`screen-tracker.ts`) — exact algorithm

State per session `S`:

```ts
{ viewers: Map<connId, { lastSentGen: number }>, dirty: boolean, inflight: boolean,
  lastKeys: string[] /* lineKey per row */, lastCols, lastRows, lastBackendScrollback, reported: number, gen: number }
```

- `setViewed(connId, sessionId | null)`: moves the connection's single subscription; a
  newly viewed session gets a **snapshot** immediately (`lastSentGen = gen`).
- On `screen-changed(S)`: `dirty = true`; also feed the idle heuristic (8.8). For backends
  with `subscribe: false`, a 250 ms poll marks every viewed session dirty.
- **Flush loop** every `max(125, minFrameMs)` ms. For each `S` with `dirty && viewers.size > 0 && !inflight`:
  1. `inflight = true; dirty = false`; `screen = await backend.getScreen(S)`.
  2. `keys[i] = lineKey(lines[i])` (`packages/protocol/src/screen.ts`; the canonical
     string form; compared **by string equality** — no hashing).
  3. **Scroll detection.**
     - If `capabilities.absoluteLines`: `delta = screen.scrollbackTotal - lastBackendScrollback`.
     - Else: `delta = screen.scrollbackTotal - lastBackendScrollback` if that is `> 0`
       (history still growing); if it is `0` and more than 60 % of rows differ
       row-for-row, try `k = 1..min(rows - 1, 16)`: count `i` in `[0, rows - k)` with
       `keys[i] === lastKeys[i + k]`; the first `k` with matches ≥ 80 % of `rows - k` is
       the scroll amount (history saturated). Otherwise `delta = 0`.
     - `delta < 0` (buffer cleared) → snapshot with `reset: true`; `delta >= rows` → snapshot.
     - `reported += delta` (the `scrollbackTotal` sent to phones is `reported`, a
       monotonic counter the agent owns; for `absoluteLines` backends it equals the
       backend's value).
  4. Compare new row `i` with old row `i + delta` (rows `≥ rows - delta` count as
     changed). If `cols/rows` changed, `lastKeys` empty, or changed > 60 % of rows →
     **snapshot**; else **diff** `{ scroll: delta, changed }`.
  5. `gen++`. For each viewer: if `lastSentGen === gen - 1` send the frame (diff or
     snapshot); else send a **snapshot** (the viewer missed a frame). Set
     `lastSentGen = gen`. Encoded size > 256 KB → re-encode with styles stripped and
     `degraded: true`.
  6. `lastKeys = keys; lastBackendScrollback = screen.scrollbackTotal; inflight = false`.
- **Per-phone cap**: at most **40 frames/s per connection**; a viewer that would exceed
  it is skipped this tick (and therefore gets a snapshot next tick via the rule above).
- Errors from `getScreen` (session gone) → remove the session and emit `sessions`.

Tailing a log costs one new line per frame. Alternate-screen programs (`vim`, `htop`)
never change `scrollbackTotal`, so they diff row-for-row.

### 8.7 Agent ↔ relay (`relay-client.ts`, `phone-link.ts`)

- One WebSocket to `${relayUrl}/ws/${fp_c}`; handshake per 6.5 with `role: "agent"`.
- Keepalive: a **protocol-level ping frame** (`ws.ping()`) every 45 s; expect a pong
  within 10 s or reconnect. The Cloudflare edge answers ping frames without waking the DO
  and they are not application messages (14).
- Backoff on failure: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s cap, ±20 % jitter; reset on
  `auth-ok`.
- After `auth-ok`, the agent waits for `unpaired` (applies tombstones), sends
  `pairings-sync`, then handles `phones`. Each `phone-connected { connId }` creates a
  `PhoneLink` keyed by `connId` that owns: the `conn.hello` handshake, `K_conn`,
  `seq`/`lastSeq`, the last-256 `reqId` cache, and the viewed session. `phone-disconnected`
  for an unknown `connId` is ignored. Outbound frames to a connection are dropped if it is
  not handshaken.

### 8.8 Events and ringing (`events.ts`, `notifier.ts`)

Per session state: `{ promptState, commandStartedAt, command, lastChangeAt, activeSince, lastRingAt }`.

**Prompt events** (iTerm2 shell integration installed in the user's shell):
- `command-start` → `promptState = "running"`, record `commandStartedAt`, `command`.
- `command-end { exitCode }` → `promptState = "finished"`; `durationMs = now - commandStartedAt`;
  emit `event { kind: "prompt", exitCode, durationMs, command }` to **all connected phones**;
  if `durationMs >= config.notifyMinCommandMs` (default **10 000**) → `ring`.
- `prompt` → `promptState = "editing"`.

**Idle heuristic** (works without shell integration and for TUIs like Claude Code that
are one long "running" command):
- On `screen-changed`: `lastChangeAt = now; activeSince ??= now`.
- Every **1 s**: for each session where `activeSince != null && now - lastChangeAt >= config.idleQuietMs (4000) && lastChangeAt - activeSince >= config.idleMinActiveMs (1500)`:
  emit `event { kind: "idle", durationMs: lastChangeAt - activeSince }`; `activeSince = null`;
  `ring` **unless** a `prompt` event fired for this session in the last 5 s (dedupe) or
  `promptState == "editing"` (the shell is at a prompt; nothing is waiting).

**`ring(S, kind, extra)`**: rate-limit per session **1 ring / 60 s** (`lastRingAt`);
send ctrl `notify { sessionId, kind, exitCode?, durationMs? }`. The relay decides who
actually gets a push (11.3).

**`exit`** event: emitted on `session-removed` (no ring).

Per-backend note: the prompt path only exists for iTerm2 sessions with shell integration;
tmux sessions rely on the idle heuristic, fed by precise `%output` events.

### 8.9 Local control socket (`control.ts`)

`shellbell pair|status|devices|unpair` connect to `~/.shellbell/agent.sock` (newline-
delimited JSON: `{ cmd, args }` → `{ ok, data|error }`; `pair` streams
`{ event: "request", phoneFp, name }` and accepts `{ cmd: "confirm", phoneFp, accept }`).
If the socket is absent, `pair` starts a foreground agent; the others print "agent not
running".

### 8.10 Logging

`log.ts` writes JSON lines `{ t, level, msg, ...fields }` to `agent.log` and pretty
lines to stdout when attached to a TTY. Never log: keys, cookies, pairing codes,
terminal content, or input text. Log input **lengths** only.

### 8.11 tmux backend (`src/backends/tmux/`)

**Requirements:** `tmux` ≥ 3.2 on `PATH` (client flags `-f ignore-size`) and a
running server on the default socket. `doctor` reports the version; older tmux → backend
disabled with "tmux 3.2+ required for Shellbell (found 3.1)". Only the default server is
supported in v1.

**Native ids:** pane ids (`%N`). `windowId` = tmux session id (`$N`), `windowNumber` =
session index in `list-sessions`, `tabId` = window id (`@N`), `tabIndex` = `#{window_index}`,
`paneIndex` = `#{pane_index}`.

**Control-mode clients (`control.ts`).** For each tmux session the agent keeps one
long-lived `tmux -C attach-session -t $N -f ignore-size` (stdio pipes). Not
`read-only`: the M0b spike showed that a `read-only` client blocks `send-keys` for the
**whole session** while attached, so the write-safety comes from protocol discipline
(every command line is built from typed messages and `tmuxQuote`), not from the flag. The
**first** such client is also the **command channel**: every tmux command the backend runs
(`list-panes`, `capture-pane`, `display-message`, `send-keys`, `new-window`,
`split-window`, `list-clients`) is written to its stdin and its reply is read between
`%begin` / `%end` (or `%error`) lines, correlated in order. No child process is spawned
per frame. Escaping (measured in M0b, tmux 3.7c): reply lines inside `%begin`/`%end`
carry ESC as a **raw 0x1B byte** — no unescaping (`UNESCAPE_OCTAL = false`); only
`%output` payloads are octal-escaped (`\033`), and the agent ignores their data (it only
uses `%output` as a "screen changed" signal). Parsing stdout:
- `%output %N <data>` → emit `screen-changed` for `%N` (data ignored).
- `%layout-change`, `%window-add`, `%window-close`, `%window-renamed`, `%unlinked-window-*`,
  `%session-renamed`, `%sessions-changed` → emit `layout-changed` (debounced 100 ms).
- `%exit` → that client is gone; if it was the command channel, promote another.
A watcher every **5 s** (`list-sessions -F '#{session_id}'`) starts clients for new
sessions and kills clients of vanished ones. If the tmux server dies, the backend reports
no sessions and retries detection every 10 s.

**Listing:**
```
list-panes -a -F '#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_title}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{window_active}\t#{history_size}\t#{cursor_x}\t#{cursor_y}\t#{pane_dead}\t#{pane_current_command}'
list-clients -F '#{client_session}\t#{client_control_mode}'
```
Split on `\t`. `title` = `window_name` if it differs from `pane_current_command` (tmux's
automatic name is the running command), else `pane_title` if non-empty and not the
hostname, else `"<session_name>:<window_index>.<pane_index>"`. `isFocusedOnMac` =
`pane_active && window_active && session has ≥ 1 client with client_control_mode == 0`
(our own control clients do not count). `state` is always `"unknown"`.

**Screen** (`getScreen`): over the command channel, `capture-pane -p -e -N -t %N` (`-e`
escapes, `-N` preserve trailing spaces, no `-J`; pad to `pane_height` rows) and
`display-message -p -t %N '#{cursor_x}\t#{cursor_y}\t#{history_size}\t#{pane_width}\t#{pane_height}'`.
Each row → `parseSgrLine` (8.11.1). `scrollbackTotal` = `history_size` (the tracker
converts it to a monotonic `reported` value; `capabilities.absoluteLines = false`).

**History** (`getHistory(id, before, count)`): with `H = history_size` and the tracker's
`reported` (so the oldest retrievable absolute line is `reported - H`):
`s = before - count - reported`, `e = before - 1 - reported` (both ≤ −1, clamp `s ≥ -H`);
`capture-pane -p -e -N -t %N -S s -E e`. `oldestAvailable = reported - H`.

**Input:** `send-keys -t %N -l -- <text>` for text (argv element, never a shell). A trailing
`"\r"` (from `input.line`) is stripped and sent as a separate `Enter` key. Named keys →
tmux names (`Enter`, `Tab`, `BTab`, `Escape`, `BSpace`, `DC`, `Up/Down/Left/Right`, `Home`,
`End`, `PPage`, `NPage`, `C-a…C-z`, `C-Space`, `F1…F12`) via `send-keys -t %N <Name>`.

**Create:** `new-window -P -F '#{pane_id}' -t $N` (or `new-session -d -P -F '#{pane_id}'`
when `windowId` is omitted); `split-window -P -F '#{pane_id}' -t %N -h|-v` (`vertical` →
`-h`). **Focus:** unsupported in v1 (`capabilities.focus = false`).

**Capabilities:** `{ subscribe: true, prompts: false, createSession: true, focus: false, history: true, absoluteLines: false }`.

#### 8.11.1 SGR parser (`packages/protocol/src/sgr.ts`)

`parseSgrLine(text: string): Line` — converts one row of text containing only SGR escape
sequences (what `capture-pane -e` emits) into runs. Exact behaviour:

- Scan for `ESC [` … `m`. Parameters are separated by `;` (sub-parameters by `:`, which
  must also be accepted for `38:2::r:g:b` / `38:5:n`). Empty parameter = 0.
- Maintain a current style `{ fg, bg, b, i, u, s, f, inverse }`, initially unset.
- Codes: `0` reset all · `1` b · `2` f · `3` i · `4` u · `7` inverse · `9` s · `22` clear b and f ·
  `23` clear i · `24` clear u · `27` clear inverse · `29` clear s · `30–37` fg = n−30 ·
  `38;5;n` fg = n · `38;2;r;g;b` fg = [r,g,b] · `39` fg unset · `40–47` bg = n−40 ·
  `48;5;n` / `48;2;r;g;b` bg · `49` bg unset · `90–97` fg = n−90+8 · `100–107` bg = n−100+8.
  Unknown codes are ignored. Malformed sequences (no final byte within 32 chars) are
  emitted as literal text.
- Any other `ESC` sequence (`ESC ] … BEL`/`ESC \`, `ESC ( B`, etc.) is stripped. Control
  characters < 0x20 other than TAB are stripped; TAB becomes spaces to the next multiple
  of 8 cells.
- Text between sequences becomes a run with the current style; adjacent runs with equal
  style merge. `inverse` is resolved at emit time exactly as in 8.5.5 step 4. Trailing
  all-space runs without `bg` are trimmed.
- Cell counting uses `cellWidth` (8.11.2); a run gets `n` when its cell count differs
  from its code-point count.

#### 8.11.2 Cell widths (`packages/protocol/src/width.ts`)

`cellWidth(cp: number): 0 | 1 | 2` after Markus Kuhn's `wcwidth`: 0 for combining marks
(Mn/Me), zero-width joiner/space and variation selectors; 2 for East Asian Wide/Fullwidth
ranges and emoji presentation ranges; 1 otherwise. The exact range table is in Plan 04.
`stringCells(s)` sums it over code points (a ZWJ sequence counts its widest element).

### 8.12 Backend registry (`src/backends/registry.ts`)

- **Detection at start and every 10 s while a backend is absent:** iTerm2 if
  `~/Library/Application Support/iTerm2/private/socket` exists (or TCP 1912 answers);
  tmux if `tmux -V` succeeds with version ≥ 3.2 and `tmux list-sessions` exits 0.
- Each detected backend is `connect()`ed independently; a failure in one never affects
  the other. `hello.backends` lists the connected ones; changes trigger a new `hello`.
- **Ids:** the registry exposes a `TerminalBackend`-shaped facade to the agent core. It
  prefixes every native id with `"<name>:"` on the way out and strips it on the way in,
  and routes calls to the owning backend. Unknown prefix → `SessionGone`.
  `createSession` routes by `where.backend` for `kind: "tab"` and by the prefix of
  `where.sessionId` for `kind: "split"`; `windowId` is prefixed too (`"iterm2:w1"`,
  `"tmux:$0"`) and must match `where.backend`, else `ack.ok=false, error:"bad-window"`.
- **De-duplication with iTerm2's tmux integration:** when iTerm2 attaches with
  `tmux -CC`, the same panes exist in both backends. iTerm2's `Tab.tmux_window_id` names
  such tabs. Rule: hide any tmux-backend session whose tmux `window_id` (`@N`) equals a
  `tmux_window_id` reported by iTerm2. iTerm2 wins (native styles, prompt events).
- **Ordering in `sessions`:** iTerm2 sessions first (window number, tab index, pane
  index), then tmux (session index, window index, pane index).

---

### 8.13 Herdr backend (`src/backends/herdr/`) — added 2026-09-05

[Herdr](https://herdr.dev) is an Apache-2.0 Rust runtime that owns the PTYs coding agents run in
(Claude Code, Codex, Cursor, OpenCode, …), with a local socket API and a semantic
`working | blocked | idle | done` state per pane. It is the third `TerminalBackend`
(`BackendName` gains `"herdr"`), prioritised because it reaches the coding-agent audience and
because `blocked` is exactly Shellbell's "needs you" signal. Facts below were verified against
herdr v0.8.2 source and docs (research report kept out of the repo; key facts restated here).

**Discovery and transport.** Socket at `$HERDR_SOCKET_PATH`, else `$XDG_CONFIG_HOME/herdr/herdr.sock`,
else `~/.config/herdr/herdr.sock` (mode 0600, no auth). Newline-delimited JSON, **one request per
connection**: open, write one line `{"id","method","params"}`, read one response line, close. Long-lived
methods (`events.subscribe`, `events.wait`, `agent.wait`) keep their connection open and push bare
`{"event","data"}` lines after a `subscription_started` ack (server polls state every 100 ms; no replay).
`ping` returns `{version, protocol, capabilities}`; we require `protocol >= 22` (herdr ≥ 0.7.2) and refuse
older with `BackendUnavailable` (hint: upgrade). Server restart = EOF on every connection and the socket
file disappears: the backend polls for the socket every 2 s, then re-subscribes and re-snapshots.

**Sessions.** One Herdr *pane* is one Shellbell session. Native id = the pane's stable `terminal_id`
(pane ids `w1:p1` are reassigned across restarts); the backend keeps a `terminal_id → pane_id` map
refreshed from `session.snapshot` and from `pane.created/closed/exited/moved/focused/updated` and
`layout.updated` events. Title = agent name when an agent is attached, else pane title, else `cwd`
basename, else `"Pane"`; `cwd` from pane info; `tmuxWindowId` never set. Bootstrap = subscribe → buffer
events → `session.snapshot` → replay buffered events with `revision` ≥ snapshot's.

**Screen.** `getScreen` = `pane.read {pane_id, source:"visible", format:"ansi"}` → one string per line
→ `parseSgrLine` (7.x / Plan 01 `sgr.ts`) → `Line`; rows = `scroll.viewport_rows` from the snapshot,
cols = the pane's layout rect width; pad/truncate to `rows`. Herdr exposes **no cursor**: cursor is
placed at the end of the last non-blank visible line (`x` = its cell width, `y` = its row) and the
mobile app dims a cursor for `herdr` sessions (10.x). `scrollbackTotal` = `scroll.max_offset_from_bottom
+ viewport_rows`; `absoluteLines: false`, so the tracker uses `lineKey` overlap only. `history` =
`pane.read {source:"recent", lines ≤ 1000, format:"ansi"}`, styled, best-effort (TUI apps have no real
scrollback). **Change detection:** Herdr has no screen-change push, so a *revision poller* runs only
for panes that at least one phone is viewing: every 200 ms call `pane.copy_motion` (side-effect free)
and compare `content_revision`; on change emit `screen-changed`. Non-viewed panes are never polled.

**Agent state → rings.** Subscribe to `pane.agent_status_changed`; emit a new backend event
`{ kind: "agent-state", sessionId, state: "working"|"blocked"|"idle"|"done"|"unknown", agent }`.
`EventEngine` maps it: `blocked` → ring `kind:"blocked"` immediately (once per transition, 60 s limit);
`working → idle|done` after ≥ `notifyMinCommandMs` of `working` → ring `kind:"prompt"` with `durationMs`
and no `exitCode`; `unknown` → nothing. `SessionInfo.state` shows `running` for `working`, `prompt` for
`idle|done`, and a new `blocked`. Protocol changes: `EventKindSchema` += `"blocked"`; `notify.kind`
+= `"blocked"` with push body **"An agent is waiting for you"** (11.3); `SessionInfo.state` += `"blocked"`.
Herdr has no prompt/command lifecycle for plain shells, so `capabilities.prompts` is `false` and idle
heuristics (8.8) apply to shells as with tmux. Caveat: `pane.focus` marks a `done` agent as seen
(Herdr flips it to `idle`); we accept that.

**Input.** `sendText` → `pane.send_text {pane_id, text}`; named keys → `pane.send_keys {pane_id,
keys:[…]}` with a fixed `NamedKey → herdr key` table (`enter`, `tab`, `esc`, `up/down/left/right`,
`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `shift+tab`, `f1…f12`, `minus`); keys without a Herdr name go
through `pane.send_text` as raw bytes (`bytesForKey`). Never log the text; log lengths.

**Create / focus.** `session.create` with `where.kind = "tab"` → `tab.create {workspace_id, focus:false}`
(workspace of the reference pane, else the focused one); `where.kind = "split"` → `pane.split
{target_pane_id, direction: "right"|"down"}`; `left/up` are `unsupported`. `focus` → `pane.focus`.
Capabilities: `{ subscribe: true, prompts: false, createSession: true, focus: true, history: true,
absoluteLines: true → false }`.

**Not running / not installed.** No socket → `BackendUnavailable` with hint
`Install: curl -fsSL https://herdr.dev/install.sh | sh, then start herdr`. `doctor` reports version and
protocol. Herdr and iTerm2 can run together; no de-dup rule is needed (Herdr panes are not iTerm2 sessions).

**Deferred (Plan 06+).** True cursor and TUI-exact fidelity via `herdr terminal session observe`
(base64 `terminal.frame` bytes into a headless VT emulator). Not needed for v1.

**Licensing.** Socket-only interop; no Herdr code or schema is vendored (types are hand-written from the
verified messages). Say "works with Herdr"; no Herdr trademark use in the product name.

## 9. The relay (`apps/relay`)

### 9.1 Worker (`src/index.ts`)

| Method + path | Behaviour |
|---|---|
| `GET /` | `200` JSON `{ name: "shellbell-relay", version, docs }` |
| `GET /healthz` | `200 ok` |
| `GET /ws/:fp` | Validates `fp` (`^[a-z2-7]{26}$`), requires `Upgrade: websocket`, forwards to `env.COMPUTER.get(env.COMPUTER.idFromName(fp)).fetch(request)` |
| anything else | `404` |

No CORS. No request bodies. A Cloudflare **rate-limiting rule** on `/ws/*` (free plan
includes one rule) caps upgrades per IP at 30/minute — configured in the dashboard and
documented in `docs/self-hosting.md`.

### 9.2 `ComputerDO` (`src/computer-do.ts`)

**Storage** (SQLite-backed DO):

```sql
CREATE TABLE IF NOT EXISTS computer (fp TEXT PRIMARY KEY, ed25519_pub BLOB NOT NULL, name TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairings (phone_fp TEXT PRIMARY KEY, ed25519_pub BLOB NOT NULL, name TEXT NOT NULL,
  push_token TEXT, push_platform TEXT, push_enabled INTEGER NOT NULL DEFAULT 1, paired_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS pending_unpairs (phone_fp TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_window (id INTEGER PRIMARY KEY CHECK (id = 1), gate_hash BLOB NOT NULL, expires_at INTEGER NOT NULL, admitted INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ring_limits (session_id TEXT PRIMARY KEY, last_ring_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_limits (phone_fp TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
```

Row caps: `pairings` ≤ 10 (`pairing-add` beyond that is ignored with an `error` ctrl);
`ring_limits` pruned to the 200 most recent on insert; `pending_unpairs` ≤ 10.

**WebSockets** use the Hibernation API:

- `fetch()` → `new WebSocketPair()`; `this.ctx.acceptWebSocket(server)`; send `challenge`;
  `ws.serializeAttachment({ state: "unauth", connId, nonce, since, fp: null, name: null, leaseUntil: 0 })`
  (attachments are ≤ 2 KiB — the runtime limit; ours is ~200 bytes — and may be re-serialized at any time). Then schedule the alarm
  (below).
- `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` in the
  constructor. Protocol-level ping frames are answered by the runtime and never reach
  `webSocketMessage`.
- `webSocketMessage(ws, msg)`: text → ignore. Enforce the byte limit for the socket's
  state (7.1) and the token bucket (`src/limits.ts`) **before** decoding. Decode CBOR →
  `Envelope`; on failure close `4400`. Dispatch by attachment state (tags are immutable
  after accept, so role lookups iterate `this.ctx.getWebSockets()` filtering by
  `deserializeAttachment().state`; fan-out sizes are tiny):
  - `unauth`: only `auth` → 6.5.
  - `agent`: `pairings-sync`, `pairing-open`, `pairing-close`, `pairing-add`,
    `pairing-response`, `pairing-reject`, `unpair`, `notify`; e2e frames with `to` = a
    connected phone.
  - `phone`: `push-token`, `lease`, `unpair` (self only); e2e frames with `to = computer fp`.
  - `pairing`: exactly one `pairing-request`, forwarded to the agent; anything else → `4403`.
- e2e forwarding: verify `from` matches the socket's fp, then forward the original bytes.
- `webSocketClose/Error`: agent → close the pairing window, broadcast `presence false`;
  phone → `phone-disconnected` to the agent (with `connId`).
- **Alarm scheduling:** after every accept and at the end of every sweep, compute the
  earliest pending deadline among unauth sockets (`since + 10 s`), pairing sockets
  (`since + 90 s`), the pairing window (`expires_at`), and the storage-GC deadline
  (`computer.last_seen + 90 days`), and `setAlarm(max(now + 1 s, earliest deadline))` if any exist — never a short polling clamp (a 5 s clamp would wake every DO 17 280×/day). The GC deadline is only considered while no agent socket is open; the last agent's disconnect refreshes `last_seen` and re-arms the alarm. A DO whose fingerprint never authenticated an agent (no `computer` row) is deleted by the alarm 60 s after its last socket closes, so unauthenticated hits cannot accumulate storage.
  The sweep closes expired sockets (`4408`), closes an expired window, and deletes all
  storage of a computer whose agent has not connected for 90 days.
- **Pairing window:** `pairing-open` upserts `pairing_window`; `pairing-close`, agent
  disconnect, expiry, or `admitted >= 5` closes it (row deleted). A `pairing` auth checks
  `sha256(gate) == gate_hash && now < expires_at`, then increments `admitted`.
- **Pairings sync:** on `pairings-sync`, delete rows whose fp is not in the list (closing
  their sockets `4004`), upsert the rest (keeping `push_token/push_platform/push_enabled`
  for retained fps), then clear `pending_unpairs`. `unpaired` is sent to the agent right
  after `auth-ok` from `pending_unpairs`.
- **Leases:** `lease { ttlMs }` sets `leaseUntil = now + ttlMs` in the phone socket's
  attachment. A phone is *attentive* if it has an open socket with `leaseUntil > now`.

**Push** (`src/push.ts`), on ctrl `notify` from the agent:

1. `ring_limits[sessionId]` within 60 s → drop.
2. Recipients: pairings with `push_enabled = 1` and a `push_token`, whose phone is **not
   attentive** (11.3).
3. Per-phone cap: **20 pushes per rolling hour** (`push_limits`); beyond that, drop.
4. `POST https://exp.host/--/api/v2/push/send` with
   `[{ to, title: computerName, body, data: { computerFp, sessionId, kind }, sound: "default", priority: "high", channelId: "rings", categoryId: "ring" }]`.
   `body` by kind: `prompt` → `"A command finished — exit <code> after <duration>"`;
   `idle` → `"A session went quiet — waiting for you?"`; `<duration>` as `43s` / `4m 12s`
   / `1h 03m`. The app shows the real session title once opened.
5. A ticket with `details.error == "DeviceNotRegistered"` clears that phone's token. Push
   *receipts* (delayed failures) are **not** fetched in v1; stale tokens that fail only at
   receipt time keep receiving attempts until the phone re-registers (v1.1: receipt
   polling via alarm).

`EXPO_ACCESS_TOKEN` (Worker secret) is sent as `Authorization: Bearer` when set. The
official Expo project keeps "enhanced push security" **off** so self-hosted relays can
push to the official app without the author's token.

### 9.3 Configuration (`wrangler.jsonc`)

```jsonc
{
  "name": "shellbell-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": { "bindings": [{ "name": "COMPUTER", "class_name": "ComputerDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ComputerDO"] }],
  "observability": { "enabled": true },
  "vars": { "MIN_FRAME_MS": "125" },
  "routes": [{ "pattern": "relay.shellbell.app", "custom_domain": true }]
}
```

Self-hosters delete `routes` and use the `*.workers.dev` URL in their QR
(`shellbell config set relay wss://shellbell-relay.<account>.workers.dev`).

### 9.4 Free-tier fit and abuse controls

Verified against Cloudflare's Durable Objects pricing page (2026-09-03): the Workers
**Free** plan includes SQLite-backed DOs with 100 000 requests/day, 13 000 GB-s/day,
5 GB storage; "a 20:1 ratio is applied to incoming WebSocket messages"; hibernated
objects are not billed for duration; the runtime answers ping frames without waking the
object. Capacity model in 14. Abuse controls: per-IP upgrade limit (9.1), per-socket byte
caps and token bucket (7.1), row caps and 90-day GC (9.2), one socket per identity (6.5),
pairing window admission ≤ 5 (6.4). Self-registration of new computer fingerprints is
open in v1; a Turnstile-minted registration capability is v1.1 if abuse appears. If the
hosted relay approaches quota, the operator raises `MIN_FRAME_MS` (advertised in
`auth-ok`) or moves to the $5/month paid plan; users can always self-host.

---

## 10. The mobile app (`apps/mobile`)

### 10.1 Stack

Expo SDK 57 with **exactly the versions `npx expo install` chooses** (SDK 57 bundles React
Native 0.86.3, React 19.2, Reanimated 4.5 + `react-native-worklets` 0.10, Gesture Handler
2.32, FlashList 2.0, safe-area-context 5.7, screens 4.26 — Appendix C). New Architecture,
TypeScript 5.9, expo-router, zustand, expo-secure-store, expo-sqlite (`kv-store`) for
non-secret persistence, expo-camera (barcode), expo-notifications, expo-haptics,
expo-clipboard, expo-keep-awake, expo-glass-effect, expo-crypto, expo-dev-client.
`npx expo-doctor` runs in CI.

### 10.2 Routes (`app/`)

| File | Screen |
|---|---|
| `_layout.tsx` | Root: crypto bootstrap import first, fonts, theme, gesture root, notification handlers, deep links, connection manager |
| `index.tsx` | **Computers** — list of paired computers |
| `pair.tsx` | **Pair** — camera scanner (modal) |
| `c/[fp]/_layout.tsx` | Computer stack |
| `c/[fp]/index.tsx` | **Sessions** — list for one computer, grouped by backend → window → tab |
| `c/[fp]/s/[sid].tsx` | **Session** — the terminal view. `sid` is the **base64url of the session id** (native ids contain `%` and `:`) |
| `c/[fp]/settings.tsx` | Computer settings: name, accent, notifications on/off, unpair |
| `settings.tsx` | App settings: phone name & fp, font size, about, license, Buy Me a Coffee, dev self-test |

Deep link scheme `shellbell://c/<fp>/s/<sid-b64u>`. Universal links are v2.

### 10.3 State (`src/store/`)

```ts
// persisted (kv-store): computers and UI prefs — never secrets, never commands
useComputersStore: { computers: { fp, name, accent, relayUrl, pairedAt, lastSeenAt, pushEnabled }[], add, remove, update }
useUiStore: { fontSize /* default 12 */, fitWidth, rawModeBySession: Record<string, boolean> }

// in-memory only
useConnectionStore: {
  byComputer: Record<fp, {
    status: "idle"|"connecting"|"auth"|"handshake"|"online"|"offline"|"error", agentOnline, error?,
    hello?, sessions: SessionInfo[],
    screen?: { sessionId, state: ScreenState },          // the single viewed session
    events: Record<sid, Event[]>, unread: Record<sid, number>,
    pendingInputs: Map<reqId, { at, sessionId }>,
    history: string[],                                   // command history, memory-only, last 100
  }>
}
```

`ScreenState` and `applyDiff` / `applySnapshot` come from `@shellbell/protocol` so the app
and the agent share one implementation. Applying a `screen.diff`: (1) if `scroll > 0`,
move the first `scroll` lines of `lines` to the end of `history` (setting
`historyFrom = previous scrollbackTotal` when `history` was empty) and append `scroll`
empty lines; (2) replace `lines[i]` for each `changed`; (3) set `cursor`,
`scrollbackTotal`, `gen`. If `gen !== previousGen + 1`: discard `history`, send
`snapshot.get`, ignore frames until a snapshot arrives. A snapshot with `reset` clears
`history`. `history` is capped at 5 000 lines. Each line carries a stable `key` (counter
assigned when the line object is created) so FlashList re-renders only changed rows.

### 10.4 Connection manager (`src/net/`)

`ComputerConnection` (one per computer):

- `connect()`: open `${relayUrl}/ws/${fp}`; answer `challenge` with `auth { role: "phone" }`;
  on `auth-ok` set `online`, send `push-token` (if permission granted; `enabled` from the
  computer's setting) and `lease { ttlMs: 60000 }`; if `agentOnline`, run the `conn.hello`
  handshake (10 s timeout → reconnect) and wait for `hello`; else wait for `presence`.
- Keepalive while foregrounded: text `"ping"` and `lease { ttlMs: 60000 }` every 30 s.
- Backoff as the agent (1 → 30 s). `presence.agentOnline=false` keeps the socket.
- `ConnectionManager`: on `AppState` → `active`, connect all computers. On `inactive` or
  `background`: **immediately** send `lease { ttlMs: 0 }` on every open socket, then close
  them. No delay. (The relay therefore treats the phone as push-eligible the instant it
  leaves the foreground, and the lease expiry covers the case where the OS suspends JS
  before the close is sent.)
- On regaining foreground, the open session view re-sends `subscribe`; the store's
  `gen` check requests a snapshot if needed.
- Every phone → agent message gets a `reqId`; `pendingInputs` tracks inputs until `ack`;
  on socket close with pending inputs, show the "may not have been delivered" toast
  (7.4) and clear.

### 10.5 Session screen — rendering (`src/screen/`)

- Font: **JetBrainsMono Nerd Font** (OFL), Regular/Bold/Italic/BoldItalic, bundled.
  `charWidth = fontSize * 0.6`, `lineHeight = fontSize * 1.25`.
- Layout: a horizontal `ScrollView` (`bounces={false}`) whose content width is
  `max(viewportWidth, cols * charWidth + padding)`, containing a vertical **FlashList v2**
  of lines (data = `[...history, ...screenLines]`, `keyExtractor = line.key`). No
  `estimatedItemSize` (v2 ignores it). `maintainVisibleContentPosition` is on by default
  in v2; set `{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.1 }` so the
  list follows the tail while the user is at the bottom and stays put otherwise.
  `onStartReached` (threshold 0.2) loads older history.
- `LineView` (memo by `key`): if no run in the line has `n`, one `<Text numberOfLines={1}>`
  with nested `<Text>` per run (color, backgroundColor, fontFamily variant,
  textDecorationLine, `opacity: 0.6` for faint). If any run has `n` (wide/combining
  characters), render the line as a horizontal `View` of per-run `View`s with
  `width: (run.n ?? codePoints(run.t)) * charWidth`, `overflow: "hidden"`, each holding
  its `Text` — this pins runs to terminal cells so cursor and backgrounds stay aligned.
  Empty line renders a single space to keep height.
- Cursor: absolutely-positioned block at `(cursor.x * charWidth, cursor.y * lineHeight)`
  over the screen region, accent at 70 % opacity, blinking via Reanimated only when the
  session is `running`/`editing`.
- **Fit width**: override font size `viewportWidth / cols / 0.6` (min 5). **Pinch**
  adjusts font size 5–24; persisted.
- "↓ Jump to live" pill when not following the tail.
- **History**: `onStartReached` → if `historyFrom > oldestAvailable` (or unknown), send
  `history.get { before: historyFrom, count: 200 }` and prepend. Stop when a short page
  arrives.
- Colors: `packages/protocol/src/colors.ts` provides the 256-color palette; indices 0–15
  from the theme (10.9), 16–231 the 6×6×6 cube, 232–255 the gray ramp. Default fg =
  theme `text`, default bg = transparent.
- A **render spike** (`docs/spike-render.md`, Plan 05 Task 1) runs a captured `htop`
  screen, a CJK/emoji line, and a 5 000-line log on a real iPhone and Android device
  before the session screen is built; if nested `Text` cannot hold 60 fps on the log
  fling, the fixed-width `View` path becomes the default for every line.

### 10.6 Session screen — input (`src/input/`)

Bottom bar (glass on iOS where available), three rows:

1. **Reply chips** (shown when the latest event for this session is `idle` or the session
   is `running`): `y ⏎`, `n ⏎`, `⏎`, `Esc`.
2. **Quick keys** (horizontal scroll): `Esc` `Tab` `^C` `^D` `^Z` `^L` `^U` `↑` `↓` `←` `→` `⏎` `Paste` `^R` `^A` `^E`.
3. **Text field**:
   - **Line mode** (default): single-line `TextInput`, `returnKeyType="send"`, autocorrect
     off, autocapitalize none; Send → `input.line`. History: the last 100 lines sent in
     this app process, per computer, in memory only; `↑` button browses it.
   - **Raw mode** (toggle `⌨︎`; remembered per session): every character typed is sent
     immediately as `input.text`; Backspace → `input.key backspace`; Return →
     `input.key enter`; the field stays empty. The raw-mode `TextInput` **must** set
     `autoCorrect={false}`, `autoCapitalize="none"`, `spellCheck={false}`,
     `autoComplete="off"`, `textContentType="none"`,
     `keyboardType={Platform.OS === "ios" ? "ascii-capable" : "visible-password"}`
     (disables suggestions/composition). Keystrokes are derived by diffing `onChangeText`
     against the previous value — appended suffix → `input.text`; shortened by `k` →
     `k × backspace`; replaced middle → backspaces then the new suffix — plus `onKeyPress`
     for `Backspace`/`Enter`. IME composition (CJK) is not supported in raw mode
     (documented in-app; use line mode).
   - Paste → `input.text` with clipboard content (no trailing newline).
- Haptics: `impactAsync(Light)` on every send; `notificationAsync(Success)` on pair;
  `notificationAsync(Warning)` when an `event` arrives for the session you are viewing.
- Header: session title, computer accent dot, backend badge (`iTerm2` / `tmux`), state
  badge, `⋯` menu: Bring to front on Mac (iTerm2 only) · New tab · Split vertical · Split
  horizontal. Items are hidden when the backend lacks the capability.
- Sessions list groups by backend, then window/tab; "＋" offers "New iTerm2 tab" / "New
  tmux window" according to `hello.backends`.
- `expo-keep-awake` active while this screen is mounted.

### 10.7 Bootstrap, identity and pairing (`src/bootstrap/crypto.ts`, `src/identity/`, `app/pair.tsx`)

- `src/bootstrap/crypto.ts` is the **first import** in `app/_layout.tsx`:
  ```ts
  import { getRandomValues } from "expo-crypto";
  const g = globalThis as { crypto?: { getRandomValues?: unknown } };
  if (!g.crypto) g.crypto = {};
  if (typeof g.crypto.getRandomValues !== "function") g.crypto.getRandomValues = getRandomValues;
  const probe = new Uint8Array(8); (g.crypto.getRandomValues as (a: Uint8Array) => Uint8Array)(probe);
  if (probe.every((b) => b === 0)) throw new Error("secure randomness unavailable");
  ```
  The dev "self-test" screen (10.2) runs `packages/protocol/test/vectors.json` on the
  device (Hermes) and shows pass/fail, so cross-runtime crypto is verified on real
  hardware, not only in Node.
- First launch: generate identity, store in SecureStore, default phone name
  (`Device.deviceName ?? "My phone"`).
- **Pair screen**: `expo-camera` `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`.
  On scan: validate per 7.6 → sheet "Pair with *Bilal's MBP*?" with the fp prefix → run
  6.4 with a 90-second overall timeout (the Mac needs time for the human) → success
  haptic → navigate to that computer's sessions. Copy: `bad-code` → "That code expired —
  run `shellbell pair` again"; `declined` → "The computer declined"; `no-window` → "No
  pairing window is open on that computer"; `no-agent` → "The computer isn't online";
  timeout → "Couldn't reach the relay".
- If the phone already has this computer, pairing **replaces** the stored `K_pair`.

### 10.8 Notifications (`src/notifications/`)

- Ask permission after the **first successful pairing**, with a one-line explanation.
- Token: `Notifications.getExpoPushTokenAsync({ projectId })` where `projectId` comes from
  `Constants.expoConfig.extra.eas.projectId`. Sent as `push-token` on every `auth-ok`.
- Android channel `rings` (importance high, vibration) created at startup.
- Foreground: the app shows an in-app toast + haptic and increments `unread[sid]`.
- Tap: `addNotificationResponseReceivedListener` → **validate** `data.computerFp` is a
  paired computer (else ignore) → `router.push("/c/<fp>")` → once `sessions` arrives and
  contains `data.sessionId`, push the session route; otherwise stay on the list. A push
  is a hint; nothing in it is trusted beyond routing.
- iOS notification actions (Reply y/n) are v1.1.

### 10.9 Design system (`src/ui/`, `src/theme/`)

Tokens:

```ts
bg: "#000000", surface: "#0B0B0D", surface2: "#131317", border: "#1F1F26",
text: "#E8E8ED", textMuted: "#7C7C89", textFaint: "#4A4A55",
accents: { emerald: "#10B981", blue: "#3B82F6", amber: "#F59E0B", violet: "#A855F7",
           rose: "#F43F5E", cyan: "#06B6D4", lime: "#84CC16", orange: "#F97316" },
terminal16: ["#1C1C1E","#F87171","#4ADE80","#FBBF24","#60A5FA","#C084FC","#22D3EE","#D4D4D8",
             "#52525B","#FCA5A5","#86EFAC","#FDE68A","#93C5FD","#D8B4FE","#67E8F9","#FFFFFF"],
radius: { sm: 8, md: 12, lg: 18 }, space: [0, 4, 8, 12, 16, 24, 32],
```

- UI font: system. Terminal font: JetBrainsMono NF.
- Top and bottom bars use `GlassView` from `expo-glass-effect` **only when
  `isGlassEffectAPIAvailable()` returns true**; otherwise a translucent `surface` with a
  1-px `border`. One `Bar` component makes that decision.
- Each computer's accent tints its card, the session header dot, the cursor, the send
  button, and the connection indicator.
- Lists use FlashList; cards have `radius.lg`, no shadows (OLED), 1-px borders.
- Motion: Reanimated layout transitions; 150 ms ease-out.
- Empty states are single sentences with one action.
- Accessibility: quick keys have `accessibilityLabel`; UI text scales with the system
  setting (not the terminal font).

A dedicated design pass is a plan task (Plan 06) using the frontend-design skill; this
section fixes tokens and structure so that pass is about polish, not architecture.

---

## 11. Notifications end to end

### 11.1 What is sent through Apple/Google (and seen by the relay)

Only: computer name (title), a **generic** body by event kind with exit code and
duration, and `{ computerFp, sessionId, kind }` (data; `sessionId` is an opaque id).
Never the session title, terminal content, commands, or input. Exit code and duration
are accepted as low-sensitivity. Richer notifications need on-device decryption (an iOS
Notification Service Extension) — v2.

### 11.2 Who decides what

| Decision | Where | Rule |
|---|---|---|
| "Something happened worth ringing" | Agent | 8.8 |
| "Which phones, and not too often" | Relay | 9.2 Push |
| "Show it, and where to go" | App | 10.8 |

### 11.3 Push targeting rule

Push goes to paired phones with push enabled and a token that are **not attentive**: no
open socket with an unexpired lease. A foregrounded phone renews its lease every 30 s
(ttl 60 s) and receives `event`s inline (for every session, not just the viewed one); a
phone that backgrounds sends `lease 0` and closes; a phone whose JS was suspended before
it could say so becomes push-eligible when its lease expires (≤ 60 s).

---

## 12. Connection lifecycle and error handling

| Situation | Agent | Relay | App |
|---|---|---|---|
| iTerm2 not running / API off | Hint, retry every 10 s; relay socket stays up; that backend absent from `hello` | — | Shows "iTerm2 not running on *MBP*" when no backends are connected |
| Relay unreachable | Backoff reconnect | — | Status `offline`; "Reconnecting…" pill; last screen stays visible |
| Agent offline | — | `presence false` to phones; pairing window closed | Last screen dimmed + "Computer offline since 12:04" |
| Phone unpaired on Mac | Removes pairing, sends `unpair` | Closes phone socket `4004` | On `4004`: marks computer "unpaired", offers Remove / Re-pair |
| Phone unpairs while agent offline | Applies `unpaired` on next connect | Deletes row, records tombstone | — |
| `K_pair` mismatch | 20 decrypt failures → close | — | Same → "Re-pair this computer" |
| Duplicate agent process | New wins; old exits with a message | Closes old `4005` | — |
| Duplicate phone socket | Keys links by `connId`; old link dropped | Closes old `4005` | Newest connection wins silently |
| Session closed on Mac | `sessions` update; `event exit` | — | "Session ended" with a Back button |
| Frame gap (`gen` jump) | Sends snapshot to that viewer next tick | — | Sends `snapshot.get`, drops history |
| Socket closes with un-acked input | — | — | Toast "Some input may not have been delivered"; never re-sent |
| Oversized / too-fast frames | Never produced | Closes `4413` / `4429` | — |

WebSocket close codes: `4001` auth failed · `4003` bad pairing message · `4004`
unpaired · `4005` superseded · `4400` malformed · `4403` forbidden for role · `4408`
unauth/pairing timeout · `4413` too large · `4429` rate limited.

---

## 13. Security and threat model

**Assets:** terminal content and input (highest), the ability to type into a shell
(highest), pairing list, push tokens.

**Authority:** the agent's local `pairings.json` is the authority on who may control the
computer — only phones in it have a `K_pair`. The relay's pairing table is metadata that
gates connections and pushes; a relay could add rows to it, but a phone not known to the
agent cannot complete `conn.hello` and gets nothing.

| Adversary | Can they… | Mitigation |
|---|---|---|
| Passive network / relay operator | read terminal data? | No — E2E with per-connection keys; relay sees lengths and timing |
| Malicious relay | inject input, impersonate a computer, make the agent accept a phone? | No — inputs are AEAD-bound to `K_conn`; pairing requires `code` the relay never sees; the agent only derives `K_pair` for a request a human confirmed |
| Malicious relay | deny service, replay frames, reorder? | DoS yes (accepted). Replay no — `K_conn` from mutual random nonces (6.6); reorder no — `seq` in AD |
| Malicious relay | learn what you are working on from pushes? | Only that *a* session on *a* computer finished/went quiet, plus exit code and duration (11.1) |
| Malicious relay | forge a push? | It could show a notification; the app validates routing data and trusts nothing else in it (10.8) |
| Someone who photographs your QR | pair their phone? | Only within the 5-minute window **and** only if the human at the Mac presses `y` for a phone name and fingerprint they recognise (6.4 step 3). `--yes` is opt-in and labelled unsafe |
| Anyone who knows a computer fingerprint | exhaust the pairing window or the relay? | Pairing sockets need the `gate` from the QR; ≤ 5 admissions per window; per-IP upgrade limit; per-socket byte and rate caps (7.1, 9.1) |
| Anyone | flood the hosted relay with fake computers? | Partially mitigated (caps, GC). Open registration is a v1 trade-off; Turnstile-minted registration is v1.1 if needed; self-hosting is always available |
| Someone with your unlocked phone | type into your shell? | Yes (same as any app). v1.1: optional Face ID gate |
| Someone with your Mac user account | read keys? | Yes; same trust level as `~/.ssh`. Keychain in v2 |
| Rogue local process | connect to iTerm2 API as us? | iTerm2 issues per-process cookies; ours are never written to disk |
| Malformed frames from a paired peer | crash the agent or relay? | zod bounds on every field; byte caps before decode; per-message exception handling |
| A paired phone that turned malicious | run commands? | Yes, by design. `shellbell unpair` revokes instantly |

**Explicit non-mitigations in v1:** no forward secrecy (a stolen `K_pair` decrypts
captured traffic); no certificate pinning (TLS via Cloudflare); no protection if the Mac
itself is compromised.

**Privacy:** the hosted relay logs connection metadata (fp prefix, timestamps, byte
counts) for abuse handling, retained 7 days; `PRIVACY.md`.

---

## 14. Performance budgets and capacity

| Metric | Budget |
|---|---|
| Screen change → visible on phone (same city, Wi‑Fi) | ≤ 300 ms p50 |
| Agent CPU while idle (no viewers) | ≤ 0.5 % of one core |
| Agent CPU with one viewer on a busy session | ≤ 8 % of one core (iTerm2 and tmux alike — no per-frame child processes) |
| Encoded snapshot, 200×60 styled screen | ≤ 256 KB (beyond → `degraded`); typical ≤ 15 KB |
| Encoded diff per frame, typical build log | ≤ 4 KB |
| Encoded history page (≤ 200 lines) | ≤ 128 KB (agent trims the page if larger) |
| App: fling 5 000-line history at 60 fps on iPhone 13 / Pixel 6 | no dropped frames |
| App: memory for one open session with 2 000 history lines | ≤ 60 MB above baseline |
| Pairing end-to-end (excluding the human) | ≤ 3 s |
| Cold start to computers list | ≤ 1.5 s |

**Capacity model (hosted relay, free plan, 100 000 requests/day, incoming WebSocket
messages at 20:1):**

| Source | Billed request-equivalents |
|---|---|
| Idle agent (protocol ping frames only) | 0 / day |
| Agent connect/auth/sync | ~1 per (re)connect |
| Foregrounded phone (text ping + lease every 30 s) | 0.1 / minute |
| One phone viewing one busy session (≤ 8 frames/s in, acks out) | ~24 / minute |
| One ring | 1 (+ the Expo `fetch`, which is a subrequest, not a request) |

100 000/day ≈ 69 hours/day of *continuous busy viewing* across all users, or thousands
of idle computers. Load shedding: `MIN_FRAME_MS` (default 125) can be raised to 250 or
500 without a release. Beyond that: paid plan ($5/month, 1 M requests + usage) or
self-host.

---

## 15. Testing strategy

**`packages/protocol`** (vitest, node):
- Codec round-trips for every message schema; `ignoreUndefinedProperties` verified.
- Crypto: seal/open symmetry; wrong key/nonce/AD fails; `K_pair` symmetric; `K_conn` and
  `connTag` symmetric; a frame sealed under one connection fails under another (replay);
  fingerprint stable and 26 chars; signature verify.
- **Golden vectors** `test/vectors.json`: fixed identities (seeds), fixed `code`, fixed
  nonces → expected `fp`, `K_psk`, `K_pair`, `connTag`, `K_conn`, and one sealed frame with
  a fixed nonce. Generated once by `scripts/gen-vectors.ts`, committed, and asserted in
  Node (vitest), Workers (relay test) and on-device (app self-test screen).
- `lineKey` deterministic; `applyDiff`/`applySnapshot` behaviour table (scroll, reset,
  gap, cap).
- Keys: every `NamedKey` maps to a non-empty string; table snapshot.
- QR encode/decode and rejection cases (fp mismatch, non-wss, version).
- `sgr.ts` table (≥ 40 cases) and `width.ts` table (ASCII 1, CJK 2, emoji 2, combining 0, ZWJ sequence).

**`apps/agent`** (vitest, node):
- `convert.ts` against committed real fixtures (invariants) plus hand-written exact cases.
- Screen tracker with a fake backend and fake timers: snapshot on view; diff on small
  change; **scroll by 1 while tailing → `scroll: 1` and one changed row**; saturated
  history (no `scrollbackTotal` growth) still detects scroll by overlap; negative delta →
  `reset` snapshot; > 60 % changed → snapshot; lagging viewer gets a snapshot; nothing
  sent with no viewers; 40 fps cap; `degraded` when > 256 KB.
- Events: prompt path (start/end → `prompt`, ring threshold), idle path timing table,
  dedupe, per-session rate limit, events go to all links.
- Pairing: full agent-side flow against an in-memory relay double, including confirm
  prompt (stubbed), decline, bad code → reject, 3 failures → window closes.
- Relay client + phone link: reconnect/backoff (fake timers), `unpaired` → sync order,
  `conn.hello` handshake, seq/replay rejection, `reqId` dedupe returns cached `ack`.
- tmux: control-mode line parser against a recorded transcript (`%begin/%end`, `%output`,
  `%layout-change`, `%exit`, octal unescape); `list-panes`/`list-clients` row parsers;
  history range arithmetic; key table.
- Registry: id prefixing/stripping; routing; `tmux_window_id` de-dup; one backend failing
  does not affect the other.
- **Live integration** (opt-in): `SHELLBELL_ITERM_E2E=1` against real iTerm2;
  `SHELLBELL_TMUX_E2E=1` against a throwaway `tmux -L shellbell-test` server (styled
  capture, `%output` after `send-keys`, command channel replies).

**`apps/relay`** (vitest with `@cloudflare/vitest-pool-workers`):
- Challenge/auth for each role and every failure reason; one socket per phone (4005).
- Pairing window: open/close/expiry; gate check; admission cap; one request per socket.
- `unpaired` → `pairings-sync` replaces table, closes removed phones, keeps push settings.
- Routing: forwarded byte-for-byte; `from` spoof rejected; dropped when peer absent.
- Leases: attentive phone gets no push; expired lease does; `enabled:false` never pushed.
- `notify` rate limits; `DeviceNotRegistered` clears token (mock fetch).
- Byte caps and token bucket close with `4413`/`4429`. Alarm sweep closes stale sockets.
- Golden vectors decode in the Workers runtime.

**`apps/mobile`** (vitest for pure logic; component tests minimal):
- Store diff application via the shared `applyDiff`; `gen` gap → `snapshot.get`.
- `ComputerConnection` against a fake WebSocket: handshake, seq, backoff, lease on
  foreground/background, pending-input toast on close.
- Raw-mode input differ: typed "ab", backspace, "c" → expected messages.
- Manual QA checklist in `apps/mobile/QA.md`; on-device self-test screen for vectors.

**Cross-cutting:** `scripts/e2e-local.sh` runs the relay with `wrangler dev`; the agent
runs with `--relay ws://localhost:8787`; a dev build of the app scans the printed QR.

---

## 16. Tooling, CI, release and distribution

- **Package manager:** pnpm 11 workspaces, `node-linker=hoisted`. Root scripts: `lint`
  (biome check), `typecheck`, `test`, `build`.
- **Biome** for lint + format (2-space, double quotes, semicolons, 100 cols).
- **TypeScript 5.9** strict, `moduleResolution: bundler`, ESM everywhere.
- **Agent build:** `tsdown` → single ESM file `dist/cli.js` with a `#!/usr/bin/env node`
  banner; `@shellbell/protocol` bundled in; `ws`, `@bufbuild/protobuf`, `commander`,
  `qrcode-terminal` as runtime deps; `engines.node >= 22`, `os: ["darwin"]`. Published to
  npm on release via Changesets.
- **Relay deploy:** `wrangler deploy` from CI on tag `relay-v*`; secrets set once with
  `wrangler secret put EXPO_ACCESS_TOKEN`.
- **Mobile:** EAS Build (`development`, `preview`, `production`), EAS Update for JS-only
  releases, EAS Submit. Bundle id / package `dev.bilalahmad.shellbell`.
- **CI (`ci.yml`):** install, lint, typecheck, test (all packages), `npx expo-doctor` in
  `apps/mobile`. Relay tests run under the workers pool.
- **Docs:** `README.md`, `docs/self-hosting.md`, `docs/protocol.md` (generated from the
  zod schemas), `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`.
- **Costs:** Cloudflare $0; Expo $0; domain `shellbell.app` ≈ $14/yr; Apple $99/yr;
  Google $25 once.

---

## 17. Milestones and scope

### 17.1 v1 (ship to TestFlight / internal track)

| Milestone | Deliverable | Done when |
|---|---|---|
| **M0 Spikes** | (a) Node ↔ iTerm2 API: sessions, styled screen, send text; (b) tmux control mode: `%output` flow, command channel replies, `-f ignore-size` does not resize a GUI-attached session | `docs/spike-iterm2.md` and `docs/spike-tmux.md` with measured numbers; fixtures captured |
| **M1 Protocol** | `@shellbell/protocol` complete with tests and golden vectors | `pnpm -F @shellbell/protocol test` green |
| **M2 Relay** | Worker + DO with auth, window-gated pairing, sync, leases, routing, limits, push | Tests green; `wrangler dev` accepts a scripted agent + phone double |
| **M3 Agent** | CLI, identity, relay client, phone links, iTerm2 backend, tracker, events, pairing with confirmation, control socket, launchd | `npx shellbell` prints QR; a scripted "phone" in tests pairs (with a stubbed `y`), receives snapshots and types |
| **M3b tmux** | SGR parser, width table, control-mode client, tmux backend, registry de-dup | With Ghostty (or Terminal.app) running `tmux`, the scripted phone sees and types into the tmux pane; iTerm2 `-CC` panes are not duplicated |
| **M4 App core** | Render spike, pairing, computers, sessions, session view, input (line/raw/keys) | Pair a real phone, view and type into real iTerm2 and tmux sessions over the hosted relay |
| **M5 Rings** | Prompt + idle events, leases, push, deep link | Background the app, run `sleep 15; echo done`, get a push, tap, land on the session |
| **M6 Polish & release** | Design pass, empty/error states, settings, docs, CI, store listings, TestFlight | Two people other than the author pair and use it from written docs alone |

### 17.2 v1.1 (fast follow)

Rename / close / per-session mute; persistent encrypted command history; Kitty and
WezTerm direct backends; tmux `alert-bell` → a `bell` event kind; non-default tmux
sockets; "new phone-sized tmux session"; iTerm2 profile palette import; application-
cursor-mode key toggle; `shellbell pair` Touch ID confirmation; Face ID gate in the app;
notification actions (Reply y/n); Expo push receipt polling; Turnstile-gated computer
registration on the hosted relay; history search.

### 17.3 v2

Linux agent (tmux backend only), Live Activities, Watch app, Skia grid renderer, macOS
Keychain, forward secrecy (ratchet), universal links, Notification Service Extension for
rich notifications.

---

## 18. Risks and spikes

| # | Risk | Spike / mitigation |
|---|---|---|
| 18.1 | `ws` cannot speak to the iTerm2 Unix socket with the required headers/subprotocol | **M0a.** Fallback: TCP `ws://localhost:1912`; last resort a 40-line Python shim (rejected unless both fail) |
| 18.2 | `GetBuffer` with styles is slow for large screens at 8 fps | Measure in M0a; if p50 > 40 ms use `MIN_FRAME_MS = 200` |
| 18.3 | Nested `Text` runs too slow on busy TUIs, or cell geometry drifts | **Render spike** (10.5) on real devices before the session screen is built; fixed-width `View` path exists for both problems; v2: Skia |
| 18.4 | Free-tier request quota with several users | Capacity model (14); `MIN_FRAME_MS`; paid plan / self-host escape hatch |
| 18.5 | Expo push requires an EAS project id | Free; documented; self-hosted relays can push to the official app (9.2) |
| 18.6 | `expo-glass-effect` unavailable on some iOS 26 builds | `isGlassEffectAPIAvailable()` gate with a plain fallback |
| 18.7 | iTerm2 consent dialog confuses users | `doctor` + first-run copy; screenshot in README |
| 18.8 | Session ids change when a terminal restarts | The app treats unknown ids as gone and refreshes from `sessions` |
| 18.9 | Shell integration not installed → no prompt events | Idle heuristic covers it; `doctor` suggests installing shell integration |
| 18.10 | tmux control-mode client resizes a GUI-attached session or `%output` does not flow | **Resolved by M0b (2026-09-04, tmux 3.7c):** `-f ignore-size` does not resize; `%output` flows. `read-only` must **not** be used — it blocks `send-keys` for the whole session while attached. Fallback (unused): poll `capture-pane` every 250 ms |
| 18.11 | Control-mode reply escaping differs from expectation | M0b records exact `%begin/%end` output for `capture-pane -e` and the octal unescape rule is adjusted from evidence |
| 18.12 | tmux history saturation hides scrolling | Overlap detection in 8.6; tested with a `history-limit 50` server |
| 18.13 | Same pane visible twice via iTerm2 `-CC` | De-dup rule in 8.12; tested |
| 18.14 | Hosted relay abuse (fake computers) | Caps + GC in v1; Turnstile registration v1.1 |
| 18.15 | LaunchAgent cannot find `node`/`tmux` after reboot | Absolute paths captured at `service install`; fixed `PATH` in the plist; `doctor` checks them |

---

## 19. External review log

The draft was reviewed by two other models before being finalized. Dispositions:

### 19.1 Gemini 3.1 Pro (via `agy`), 2026-09-03

| Finding | Disposition |
|---|---|
| Relay-chosen `connId` in the AEAD AD lets a malicious relay replay captured frames (RCE) | **Accepted — high.** Mutual-nonce `conn.hello` handshake and per-connection `K_conn` (6.6, 6.7) |
| Row-index diffing degenerates to full snapshots whenever the screen scrolls | **Accepted — high.** Scroll-aligned diff (7.4, 8.6) and phone-side history accumulation (10.3) |
| Session title in plaintext `notify`/push leaks paths, hosts, commands | **Accepted — medium.** Removed; generic bodies (7.3, 9.2, 11.1) |
| `CreateWhere` lacked `backend` | **Accepted.** (8.4, 8.12) |
| Line-hash description ambiguous | **Accepted, then superseded** by Codex's simplification: compare canonical `lineKey` strings, no hash (8.6) |
| Prepending history jumps the viewport | **Accepted.** FlashList v2's default position maintenance (10.5) |
| Raw mode via `onChangeText` breaks under soft-keyboard composition | **Accepted — medium.** Keyboard settings and diff rules; IME limitation documented (10.6) |
| Cut scrollback history from v1 | **Rejected.** Reading the output that scrolled past is the stated core use |
| Durable Objects are not on the free plan | **Rejected — stale.** Verified against Cloudflare's pricing page (9.4) |
| `expo-glass-effect` does not exist; "iOS 26" is wrong | **Rejected — stale.** `expo-glass-effect@57.0.1` is bundled with SDK 57 |

### 19.2 Codex CLI (GPT‑5 class), 2026-09-03

| Finding | Disposition |
|---|---|
| Example fingerprint not valid base32 | **Accepted.** 6.2 |
| Expo SDK 57 pins wrong (RN 0.87, Reanimated 4.6, GH 3.x); worklets missing | **Accepted — high.** Use `expo install` versions; Appendix C corrected; `expo-doctor` in CI |
| `import "expo-crypto"` is not a polyfill | **Accepted — high.** Explicit bootstrap module with a probe (10.7) |
| Noble imports/API must be exact | **Accepted.** 6.1 lists exact imports and calls |
| FlashList v2 has no `estimatedItemSize`; `maintainVisibleContentPosition` shape differs; use `onStartReached` | **Accepted.** 10.5 |
| `GlassView` needs `isGlassEffectAPIAvailable()` | **Accepted.** 10.9 |
| Proto subset text omitted `tmux_window_id` and `ActivateRequest.App` | **Accepted.** 8.5.2 (Plan 01's proto already had them) |
| tmux `session_attached` counts our own control clients | **Accepted.** `list-clients` with `client_control_mode == 0` (8.11) |
| Application-level "ping" every 30 s is billed; idle is not free | **Accepted.** Agent uses protocol ping frames (8.7); phone pings only while foregrounded; capacity model (14) |
| Expo receipts not handled; token cleanup only half | **Accepted (scoped).** v1 handles ticket-level `DeviceNotRegistered` only and says so (9.2); receipts v1.1 |
| "What the terminal rendered" overstates colour fidelity | **Accepted.** Non-goal 1.2 states palette mapping; profile import v1.1 |
| Photographed QR → unattended pairing | **Accepted — high.** Human confirmation on the Mac is v1 (6.4 step 3, decision 12) |
| Relay does not know whether a pairing window exists | **Accepted.** `pairing-open`/`gate` (6.4, 7.3, 9.2) |
| Anonymous registration → quota exhaustion | **Accepted (scoped).** Caps, buckets, GC, per-IP limit in v1 (7.1, 9.1, 9.2); Turnstile v1.1 |
| Command history persisted as non-secret data | **Accepted.** Memory-only (10.3, 10.6) |
| Multiple sockets per phone break `K_conn` isolation | **Accepted.** One socket per phone (6.5); agent keys by `connId` (8.7) |
| Pushes not private/authenticated | **Accepted (partially).** App validates routing data and treats pushes as hints (10.8); kind/exit/duration kept as low-sensitivity (11.1) |
| Schemas lack bounds | **Accepted.** Byte caps before decode, bounded zod fields, token bucket (7.1) |
| Threat-model wording about relay `pairing-add` | **Accepted.** Authority paragraph in 13 |
| `notify` contradiction (title in 4.4; `mutedFor` missing from 7.3) | **Accepted.** 4.4 and 7.3 rewritten; `mutedFor` removed in favour of `push-token.enabled` |
| Two authorities for pairings, no reconciliation | **Accepted.** Agent authoritative; `unpaired` tombstones + `pairings-sync` (7.3, 8.3, 9.2) |
| No interoperability vectors; `connTag` length ambiguous | **Accepted.** Golden vectors in three runtimes (15); `slice(0, 22)` (6.6) |
| Per-session diff baseline vs per-phone delivery | **Accepted.** Per-viewer `lastSentGen`; laggards get snapshots; single viewed session per phone (8.6) |
| Alarm not scheduled for all deadlines | **Accepted.** Earliest-deadline scheduling (9.2) |
| Inputs lack delivery semantics | **Accepted.** `reqId` on every phone message, `ack`, dedupe, at-most-once, no auto-retry (7.4, 10.4) |
| URL construction and route encoding unsafe | **Accepted.** `${r}/ws/${c}`; base64url session ids in routes (7.6, 10.2) |
| History coordinate model incomplete | **Accepted.** `oldestAvailable`, `reset`, agent-owned monotonic `reported` counter (7.4, 8.6, 8.11) |
| Self-hosted push credentials unspecified | **Accepted.** Enhanced push security off; documented (9.2) |
| LaunchAgent `PATH`/`npx` fragility | **Accepted.** Absolute paths; global install required for `service install` (8.1) |
| Hidden iTerm2 sessions undefined | **Accepted.** Excluded in v1 (1.2, 8.5.3) |
| Free-tier math single-user only | **Accepted.** Capacity model + load shedding (14) |
| Connected-but-unsubscribed phone misses rings | **Accepted — high.** Events go to all connected phones (7.4, 8.8) |
| 5-second background delay creates a blind spot | **Accepted — high.** Leases; immediate `lease 0` + close on background (10.4, 11.3) |
| RN text renderer does not preserve cell geometry | **Accepted.** `Run.n` cell counts; fixed-width `View` path; render spike (7.4, 10.5) |
| tmux history saturation hides scrolling | **Accepted — high.** Overlap detection; agent-owned `reported` counter (8.6) |
| tmux per-frame child processes blow the CPU budget | **Accepted — high.** Commands run over the control channel (8.11) |
| Payload caps do not follow from row caps | **Accepted.** Encoded-size caps with `degraded` snapshots and trimmed history pages (8.6, 14) |
| Key sequences vs application-cursor mode | **Accepted (documented).** 7.5; toggle v1.1 |
| One viewed session per phone | **Accepted.** `subscribe { sessionId \| null }` (7.4) |
| Cut focus/rename/close | **Partially accepted.** Rename/close/mute cut; `session.focus` kept for iTerm2 (cheap, matches "bring it up on my Mac") |
| Replace per-session mute with per-pairing push flag | **Accepted.** `push-token.enabled` (7.3) |
| Remove the 32-bit row hash | **Accepted.** String comparison of `lineKey` (8.6) |
| Remove unused protocol surface (`bell`, receipts, Kitty details) | **Accepted.** `bell` removed from v1 enums; Kitty/WezTerm only in 17.2 |
| Run tmux/rendering spikes before protocol work | **Accepted.** M0b tmux spike; render spike is the first task of the mobile plan and `Run.n` is already in the protocol |

## Appendix A — iTerm2 API facts (verified 2026-09-03)

Source: `gnachman/iTerm2` `master` — `proto/api.proto`, `api/library/python/iterm2/iterm2/{connection,auth,session,rpc}.py`.

- Transport: WebSocket, subprotocol `api.iterm2.com`, over Unix socket
  `~/Library/Application Support/iTerm2/private/socket` (present on the author's Mac);
  legacy TCP `ws://localhost:1912`.
- Headers: `origin: ws://localhost/`, `x-iterm2-library-version`, `x-iterm2-disable-auth-ui: true`,
  `x-iterm2-advisory-name`, `x-iterm2-cookie`, `x-iterm2-key`. Response header
  `X-iTerm2-Protocol-Version: major.minor`.
- Cookie: AppleScript `tell application "iTerm2" to request cookie and key for app named "<name>"`
  returns `"<cookie> <key>"`. Errors `-2740`/`-2741` mean iTerm2 too old.
- Env vars `ITERM2_COOKIE` / `ITERM2_KEY` are set when a script is launched by iTerm2 itself.
- The author's iTerm2 has `EnableAPIServer=1`.
- `proto2`; package `iterm2`; request/response ids are `int64`; notifications arrive as
  `ServerOriginatedMessage.notification` (field 1000) with no id.
- Session id strings: a unique id from `ListSessionsResponse`, or `"all"` / `"active"`
  where documented.
- `GetBufferResponse.cursor.y` is **absolute**; `windowed_coord_range.coord_range.start.y`
  gives the screen's first absolute line; numbering is stable after history loss.
- `LineContents.style` is run-length encoded via `CellStyle.repeats`; `code_points_per_cell`
  maps code points to cells.
- `CellStyle` colors: `fgStandard`/`bgStandard` (xterm index), `fgRgb`/`bgRgb`
  (`RGBColor` 0–255 each), `fgAlternate`/`bgAlternate` (`DEFAULT`, `REVERSED_DEFAULT`, `SYSTEM_MESSAGE`).
- `PromptNotification` has `oneof event { prompt, command_start { command }, command_end { status } }`;
  requested with `NotificationRequest.prompt_monitor_request.modes`.
- `LayoutChangedNotification` carries a full `ListSessionsResponse`; `Tab.tmux_window_id`
  marks tmux-integration tabs; `Tab.minimized_sessions` and `buried_sessions` exist.
- `CreateTabRequest.select_tab=false` creates in the background; `CreateTabResponse.session_id`.
- `SplitPaneRequest.split_direction` `VERTICAL=0`, `HORIZONTAL=1`; response has `repeated session_id`.
- `ActivateRequest` has `activate_app: App { raise_all_windows, ignoring_other_apps }`.
- `VariableRequest` gets JSON-encoded values 1:1 with `get`; `MULTI_GET_DISALLOWED` exists;
  fetch one name per request.
- Renaming a session is `InvokeFunctionRequest` with `method.receiver = sessionId` and
  `invocation = 'iterm2.set_name(name: "<json>")'` (what `Session.async_set_name` does).
- `api.proto` and the Python library are **GPLv2**; we author our own subset (8.5.2).

## Appendix B — Lessons from `remote-iterm`

Studied: `mammadovziya/remote-iterm` v1.0.1 (server 247+329 LOC, client 1 234 LOC).

**Keep:** QR-on-launch onboarding · per-session content cache for instant tab switches ·
"output was changing, then quiet → alert" heuristic (now a push) · the exact quick-key
set (ESC, ^C, ^D, ^Z, ^L, arrows, TAB, ⏎, paste, copy, ^U) · a virtual keyboard symbol row
tuned for shells (`- / . _ ~ * $ | > <`) · spatial window map from real window bounds ·
following the Mac's focus by default.

**Change, and why:** AppleScript polling → API subscriptions (no process spawns, real
styles, TUIs work) · plain text + regex colors → styled runs · inbound `0.0.0.0` with no
auth → outbound E2E relay with human-confirmed pairing · one global `activeSessionId` →
per-connection viewed session · full-buffer resend → scroll-aligned line diffs · Vite dev
server in production → built artifacts · string-interpolated AppleScript (`sendKeys` had
no escaping at all) → typed messages and a named-key table · viewing a tab also focusing
it on the Mac → explicit `session.focus`.

**Why they did it their way (fair):** AppleScript needs no setup and no second runtime;
there was no Node client for the iTerm2 API; `contents of session` is a one-liner that
nails the "deploy log" demo; polling was the only option once AppleScript was chosen.

## Appendix C — Pinned versions

Looked up 2026-09-03. Non-Expo packages: pin these (or newer patch). Expo-managed
packages: use whatever `npx expo install <pkg>` selects for SDK 57 (values shown are SDK
57's bundled versions).

| Package | Version | | Package | Version |
|---|---|---|---|---|
| expo | 57.0.19 | | @bufbuild/protobuf | 2.14.1 |
| react-native (via expo) | 0.86.3 | | @bufbuild/protoc-gen-es | 2.14.1 |
| react (via expo) | 19.2.3 | | @bufbuild/buf | 1.72.0 |
| expo-router | ~57.0.18 | | cborg | 6.1.2 |
| @shopify/flash-list | 2.0.2 | | @noble/curves | 2.4.0 |
| react-native-reanimated | 4.5.1 | | @noble/ciphers | 2.4.0 |
| react-native-worklets | 0.10.1 | | @noble/hashes | 2.4.0 |
| react-native-gesture-handler | ~2.32.0 | | zod | 4.5.4 |
| react-native-safe-area-context | ~5.7.0 | | ws | 8.21.3 |
| react-native-screens | ~4.26.0 | | commander | 15.0.0 |
| expo-secure-store | ~57.0.3 | | qrcode-terminal | 0.12.0 |
| expo-camera | ~57.0.4 | | wrangler | 4.129.0 |
| expo-notifications | ~57.0.16 | | @cloudflare/workers-types | 5.20260903.1 |
| expo-haptics | ~57.0.2 | | @cloudflare/vitest-pool-workers | 0.22.0 |
| expo-glass-effect | ~57.0.1 | | vitest | 5.0.0 |
| expo-crypto | ~57.0.2 | | @biomejs/biome | 2.5.12 |
| expo-clipboard | ~57.0.1 | | tsdown | 0.23.0 |
| expo-keep-awake | ~57.0.1 | | tsx | 4.23.13 |
| expo-sqlite | ~57.0.2 | | @types/node | 26.4.1 |
| expo-dev-client | ~57.0.17 | | @types/ws | 8.18.1 |
| zustand | 5.0.15 | | @changesets/cli | 3.0.1 |
| typescript | **5.9.3** (not 7.x — RN/Expo toolchains target 5.x) | | pnpm | 11.12.0 (local) |

Local toolchain on the author's Mac: Node 22.23.1, pnpm 11.12.0, Xcode CLT 2416,
iTerm2 with API server enabled. Not installed: tmux (`brew install tmux` is the first
step of M0b), expo/eas CLIs (use `npx`).
