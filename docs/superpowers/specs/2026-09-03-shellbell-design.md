# Shellbell — Design Specification

**Status:** Draft v1 for review · **Date:** 2026-09-03 · **Author:** Bilal Ahmad (with Claude)
**Tagline:** *Your terminal rings. You answer.*

Shellbell lets you see your Mac's terminal sessions on your phone, get pinged when a
command finishes or a program is waiting for input, and reply — from anywhere. It is free,
open source (MIT), end-to-end encrypted, and runs on a self-hostable relay that fits in
Cloudflare's free tier.

This document is written so that an implementer with **no prior context and modest
judgement** can build the system without guessing. Where a choice was made, the choice
is stated, not the alternatives. Where a value matters, the value is given.

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
14. [Performance budgets](#14-performance-budgets)
15. [Testing strategy](#15-testing-strategy)
16. [Tooling, CI, release and distribution](#16-tooling-ci-release-and-distribution)
17. [Milestones and scope](#17-milestones-and-scope)
18. [Risks and spikes](#18-risks-and-spikes)
19. [Appendix A — iTerm2 API facts (verified 2026-09-03)](#appendix-a--iterm2-api-facts-verified-2026-09-03)
20. [Appendix B — Lessons from `remote-iterm`](#appendix-b--lessons-from-remote-iterm)
21. [Appendix C — Pinned versions](#appendix-c--pinned-versions)

---

## 1. Goals and non-goals

### 1.1 Goals (v1)

- **See** every terminal session on a paired Mac from an iOS or Android phone, with real
  colors and styles (what the terminal rendered, not a guess), including TUI programs such
  as Claude Code, `vim`, `htop`.
- **Two backends in v1**: **iTerm2** (native API) and **tmux** (control mode). tmux is
  how Shellbell reaches users of Ghostty, Warp, Terminal.app, Alacritty, Kitty, WezTerm —
  none of which the competitor supports — and remote Linux machines over SSH.
- **Respond**: send a line, send raw keystrokes, send named keys (Ctrl‑C, Esc, arrows…),
  paste; one-tap replies for the "agent is asking y/n" case.
- **Get rung**: a push notification when a long command finishes (with exit code) or a
  running program goes quiet after producing output (it is probably waiting for you).
- **Multiple computers** on one phone; **multiple phones** on one computer.
- **Open a new session** (new tab, or split of an existing session) from the phone.
- **Anywhere**: works on cellular; the Mac never opens an inbound port.
- **End-to-end encrypted**: the relay forwards ciphertext it cannot read.
- **No accounts**: identity is a keypair per device; pairing is scanning a QR code.
- **Free to run**: Cloudflare free tier for the relay; `npx shellbell` on the Mac.
- **Open source**: MIT, self-hostable relay, public monorepo.
- **Beautiful**: OLED-black, monospace-first, one accent color per computer, native
  materials (Liquid Glass on iOS 26), haptics.

### 1.2 Non-goals (v1)

- Not a terminal emulator. The phone paints styled text runs that the agent produces.
  It never parses escape sequences.
- No phone-sized sessions (sessions have the terminal's width). Creating phone-sized
  tmux sessions from the app is v1.1.
- No direct Kitty / WezTerm backends in v1 (v1.1 — they reuse the tmux backend's SGR
  parser and are ~150 lines each). No Ghostty/Warp direct backends ever until those apps
  ship a remote-control API; their users go through tmux.
- No Live Activities / Dynamic Island / Watch app (v2, needs a native-module spike).
- No user accounts, sync between phones, or billing. Free with a Buy Me a Coffee link.
- No file transfer, no images (iTerm2 inline images are rendered as blank cells).
- No Windows/Linux agent (tmux backend on Linux is v2).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Computer** | A Mac running the agent. Identified by its **fingerprint**. |
| **Phone** | A device running the mobile app. Also identified by a fingerprint. |
| **Device** | A computer or a phone. Every device has an identity keypair. |
| **Agent** | The Node CLI on the Mac (`apps/agent`). Talks to iTerm2, encrypts, connects to the relay. |
| **Relay** | The Cloudflare Worker + Durable Objects (`apps/relay`). Routes ciphertext, sends pushes. |
| **Backend** | An implementation of `TerminalBackend` (v1: iTerm2 and tmux, both active at once). |
| **Session** | One terminal (an iTerm2 pane, or a tmux pane). Has an id, a title, a screen, and a backend. |
| **Screen** | The visible rows of a session (`rows × cols` cells) plus cursor position. |
| **Scrollback / history** | Lines above the screen. Fetched on demand. |
| **Line** | An ordered list of **runs**. |
| **Run** | A string plus style (fg, bg, bold, italic, underline, strike, faint). |
| **Fingerprint (fp)** | Stable public identifier of a device, derived from its Ed25519 public key. |
| **Pairing** | The act of linking a phone to a computer by scanning a QR. Produces a shared key `K_pair`. |
| **Envelope** | The outer, relay-visible message. Either `ctrl` (plaintext) or `e2e` (ciphertext). |
| **Inner message** | The decrypted content of an `e2e` envelope. |
| **Ring / event** | Something the agent decided is worth your attention (`prompt`, `idle`, `bell`, `exit`). |

---

## 3. Decision log

These were decided in conversation and are not open.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Primary use | Read output **and** respond (both, glance-and-reply is the 80% case) | Needs real styled rendering plus a good input surface |
| 2 | Where used | **Anywhere** (relay), not LAN-only | "Walk away" includes leaving the building; enables push |
| 3 | Trust model | **End-to-end encrypted**; relay is a dumb pipe | Terminal output is sensitive; relay is shared infra for a product |
| 4 | Platforms | **iOS + Android from day one** via Expo | One codebase; Expo push abstracts APNs/FCM |
| 5 | What a session is | **Mirror iTerm2** (same sessions, same width) | Literally "see the sessions I already have" |
| 6 | Who it's for | **A product** — free, open source, coffee link, no billing | |
| 7 | Identity | **Device keypairs, no accounts** | Honest match for E2E; removes auth UI, deletion flows, support |
| 8 | Agent language | **Node/TypeScript** with a `TerminalBackend` interface | One language across agent/relay/app; terminals are plugins |
| 8b | v1 backends | **iTerm2 + tmux**, both shipped and run simultaneously | tmux covers every terminal without an API (Ghostty, Warp, Terminal.app, Alacritty) and Linux — the competitor is iTerm2-only |
| 9 | Name | **Shellbell** (`shellbell.app` / `shellbell.dev` available as of 2026-09-02) | BEL (`\a`, Ctrl‑G) is the terminal's own "attention" signal |
| 10 | Budget | Domain ≤ ~$15/yr, Cloudflare free tier. **Apple Developer Program $99/yr is unavoidable** for App Store/TestFlight; Google Play $25 once | Stated and accepted |
| 11 | License | **MIT** code + `TRADEMARK.md` reserving name/logo | Forks welcome, can't ship as "Shellbell" on stores |

---

## 4. Architecture

### 4.1 Components

```
┌─────────────── Mac ───────────────┐      ┌──── Cloudflare (free) ────┐      ┌──── Phone ────┐
│ iTerm2 ◀──unix socket WS──▶ agent │──WS──▶ Worker ─▶ ComputerDO(fp) ◀──WS──│ Shellbell app │
│           (protobuf API)          │      │   • auth by signature      │      │  (Expo)       │
│  ~/.shellbell/{identity,pairings} │      │   • routes ciphertext      │      │ SecureStore   │
└───────────────────────────────────┘      │   • sends Expo push ───────┼──▶ APNs/FCM ──▶ phone │
                                            └────────────────────────────┘      └───────────────┘
```

- **Agent** (`apps/agent`): the only component that talks to terminals. Runs every
  backend that is available on the Mac (iTerm2 if its API socket exists, tmux if a tmux
  server is running) and presents their sessions as one list. Holds one outbound WebSocket
  to the relay. Encrypts each inner message for a specific phone with that phone's
  `K_pair`. Decides when to ring. Owns pairing.
- **Relay** (`apps/relay`): a Worker that upgrades WebSockets and hands them to one
  **Durable Object per computer** (`ComputerDO`, id derived from the computer's
  fingerprint). The DO authenticates devices by signed challenge, keeps the pairing list
  and push tokens, forwards envelopes, and calls Expo's push API. It never sees plaintext
  terminal data.
- **Mobile** (`apps/mobile`): Expo app. One WebSocket per paired computer while in the
  foreground. Decrypts, renders runs, sends input, shows notifications, manages pairings.
- **Protocol** (`packages/protocol`): shared TypeScript — message schemas (zod), CBOR codec,
  crypto helpers, named-key table, color helpers. Imported by all three.

### 4.2 Data flow — viewing a session

1. Phone opens session `S` → sends inner `subscribe { sessionIds: [S] }` (encrypted).
2. Agent adds `S` to that phone's subscription set, fetches the screen from iTerm2, sends
   `screen.snapshot`.
3. iTerm2 emits `NOTIFY_ON_SCREEN_UPDATE` for `S` → agent marks `S` dirty.
4. Every 125 ms, for each dirty subscribed session, agent fetches the screen, computes a
   line diff against the last sent frame, sends `screen.diff` (or a new snapshot if more
   than 60 % of lines changed).
5. Phone applies the diff to its local screen model and re-renders changed lines only.

### 4.3 Data flow — replying

1. Phone sends inner `input.line { sessionId: S, text: "y" }`.
2. Agent calls iTerm2 `SendTextRequest { session: S, text: "y\r" }`.
3. Screen updates flow back as above.

### 4.4 Data flow — ringing

1. iTerm2 emits `PromptNotification.command_end` for `S` (shell integration), or the
   agent's idle heuristic fires.
2. Agent emits an inner `event` to subscribed phones **and** a plaintext ctrl `notify`
   to the relay (session title + event kind only; no content).
3. Relay sends an Expo push to every paired phone that is **not currently connected**,
   rate-limited per session.
4. User taps notification → app opens that session.

### 4.5 Why a DO per computer

There are no users. The computer is the natural unit: it is what you pair with, what you
get notified about, what goes offline. All state for a computer (pairings, push tokens,
presence, rate limits) lives in its DO. A phone with three computers holds three
WebSockets; that is fine (phones are in the foreground only when viewing).

---

## 5. Repository layout

Monorepo, pnpm workspaces. All paths below are exact.

```
shellbell/
├── package.json                  # workspaces, root scripts
├── pnpm-workspace.yaml
├── biome.json                    # lint + format for the whole repo
├── tsconfig.base.json
├── LICENSE                       # MIT
├── TRADEMARK.md
├── README.md
├── .github/
│   ├── FUNDING.yml               # buy_me_a_coffee: <handle>
│   └── workflows/
│       ├── ci.yml                # lint, typecheck, test on push/PR
│       ├── release-agent.yml     # changesets → npm publish
│       └── deploy-relay.yml      # wrangler deploy on tag relay-v*
├── docs/
│   └── superpowers/specs/2026-09-03-shellbell-design.md   # this file
├── packages/
│   └── protocol/
│       ├── package.json          # name: @shellbell/protocol
│       ├── src/
│       │   ├── index.ts
│       │   ├── envelope.ts       # Envelope schema, AD construction
│       │   ├── ctrl.ts           # ctrl message schemas
│       │   ├── inner.ts          # inner message schemas
│       │   ├── screen.ts         # Line, Run, Color, Screen types + helpers
│       │   ├── codec.ts          # CBOR encode/decode with zod validation
│       │   ├── crypto.ts         # keys, fingerprint, seal/open, KDFs, sign/verify
│       │   ├── keys.ts           # NamedKey enum → bytes
│       │   ├── qr.ts             # QR payload schema + encode/decode
│       │   ├── sgr.ts            # ANSI SGR text → Line (used by tmux; later Kitty/WezTerm)
│       │   └── colors.ts         # ANSI 256 palette + default theme
│       └── test/                 # vitest
├── apps/
│   ├── agent/
│   │   ├── package.json          # name: shellbell (published to npm), bin: shellbell
│   │   ├── proto/iterm2.proto    # OUR subset of the iTerm2 API (see 8.5.2)
│   │   ├── buf.gen.yaml
│   │   ├── src/
│   │   │   ├── cli.ts            # commander entry
│   │   │   ├── agent.ts          # orchestrator
│   │   │   ├── config.ts         # ~/.shellbell paths + JSON files
│   │   │   ├── identity.ts
│   │   │   ├── pairing.ts
│   │   │   ├── relay-client.ts
│   │   │   ├── screen-tracker.ts
│   │   │   ├── events.ts
│   │   │   ├── notifier.ts
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
│   │   │       └── tmux/
│   │   │           ├── control.ts    # control-mode client (tmux -C), %output events
│   │   │           ├── cli.ts        # one-shot tmux commands (list-panes, capture-pane, send-keys…)
│   │   │           ├── keys.ts       # NamedKey → tmux key names
│   │   │           └── backend.ts    # TerminalBackend impl
│   │   └── test/
│   ├── relay/
│   │   ├── package.json
│   │   ├── wrangler.jsonc
│   │   ├── src/
│   │   │   ├── index.ts          # Worker: routing, upgrade
│   │   │   ├── computer-do.ts    # ComputerDO
│   │   │   ├── auth.ts           # challenge/verify
│   │   │   ├── push.ts           # Expo push client
│   │   │   └── schema.sql        # DO SQLite schema (as a TS string)
│   │   └── test/                 # vitest + @cloudflare/vitest-pool-workers
│   └── mobile/
│       ├── package.json
│       ├── app.json              # expo config
│       ├── eas.json
│       ├── app/                  # expo-router routes (see 10.2)
│       ├── src/
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
    └── fetch-iterm2-proto.sh     # dev-only: downloads upstream api.proto for reference (not committed)
```

---

## 6. Identity, pairing and cryptography

### 6.1 Primitives

All from the `@noble` family (pure JS, audited, identical behaviour in Node, Workers, and
React Native):

| Purpose | Algorithm | Library call |
|---|---|---|
| Identity / signatures | Ed25519 | `@noble/curves/ed25519` |
| Key agreement | X25519 | `@noble/curves/ed25519` (`x25519`) |
| AEAD | XChaCha20-Poly1305, 24-byte nonce | `@noble/ciphers/chacha` (`xchacha20poly1305`) |
| KDF | HKDF-SHA256 | `@noble/hashes/hkdf` + `sha256` |
| Hash | SHA-256 | `@noble/hashes/sha2` |
| Randomness | `crypto.getRandomValues` (Node, Workers) / `expo-crypto` polyfill (RN) | `@noble/hashes/utils.randomBytes` |

React Native has no `crypto.getRandomValues` by default. `apps/mobile` must import
`expo-crypto`'s polyfill **before** any `@noble` import (see 10.7).

### 6.2 Device identity

Each device generates, on first run, and stores forever:

```ts
type Identity = {
  v: 1;
  ed25519: { pub: Uint8Array /*32*/; priv: Uint8Array /*32 seed*/ };
  x25519:  { pub: Uint8Array /*32*/; priv: Uint8Array /*32*/ };
  createdAt: string; // ISO 8601
};
```

**Fingerprint** = `base32lower(sha256(ed25519.pub))` truncated to **26 characters**
(130 bits), no padding, using the RFC 4648 alphabet lowercased. Example:
`k7q3m2xw9pdd4vzeb8jh5t6nra`. Display form groups it as `k7q3-m2xw-…` and the UI
usually shows the first 8 characters next to the device name.

The fingerprint is the DO name for computers and the identity string for phones on the
wire. It is derived, never chosen, so the relay can verify a claimed `fp` against a
presented public key with one hash.

### 6.3 Storage of secrets

| Device | Where | Format |
|---|---|---|
| Mac | `~/.shellbell/identity.json`, mode `0600`, directory mode `0700` | JSON, byte fields base64url |
| Mac | `~/.shellbell/pairings.json`, mode `0600` | JSON (see 8.3) |
| Phone | `expo-secure-store`, key `shellbell.identity.v1` | JSON, byte fields base64url |
| Phone | `expo-secure-store`, key `shellbell.pair.<computerFp>` | JSON `{ kPair, computerEd25519Pub, computerX25519Pub }` base64url |

Keychain on macOS is a v2 improvement; the file-with-0600 approach is what `ssh` does and
is acceptable for v1.

### 6.4 Pairing protocol

**Goal:** the phone and computer end up with the same 32-byte `K_pair`, the relay learns
that this phone may connect to this computer, and the relay learns nothing that lets it
impersonate either side or read traffic.

**Notation:** `fp_c`, `fp_p` computer/phone fingerprints; `E_pk`, `X_pk` Ed25519/X25519
public keys; `code` 16 random bytes; `‖` concatenation; `HKDF(ikm, salt, info, len)`.

**Step 0 — agent opens a pairing window.**
`shellbell pair` (or first run with no pairings) generates `code = randomBytes(16)`,
records `pairingWindowUntil = now + 5 min`, and prints a QR encoding the JSON:

```json
{ "v": 1, "r": "wss://relay.shellbell.app", "c": "<fp_c>", "e": "<base64url E_pk_c>",
  "n": "Bilal's MBP", "p": "<base64url code>" }
```

Field meanings: `r` relay WebSocket base URL, `c` computer fp, `e` computer Ed25519 pub,
`n` display name, `p` pairing code. Total ≈ 190 chars, comfortably a medium QR.

**Step 1 — phone scans and connects.** The phone verifies `sha256(e)` → `c` (abort if
mismatch), then opens `wss://<r>/ws/<fp_c>` and performs the auth handshake (7.3) with
`role: "pairing"`. The DO accepts a `pairing` socket only while an agent is connected to
that DO, for at most 60 seconds, and forwards exactly one `pairing-request` then waits
for the agent's answer.

**Step 2 — phone sends the request.** The phone derives
`K_psk = HKDF(code, "shellbell-pairing-v1", fp_c, 32)` and sends ctrl:

```
pairing-request {
  phoneFp: fp_p,
  box: seal(K_psk, nonce, plaintext = CBOR{ ed25519Pub: E_pk_p, x25519Pub: X_pk_p, name: "Bilal's iPhone", platform: "ios" }, ad = "pairing-request|" + fp_c + "|" + fp_p)
}
```

**Step 3 — agent validates.** The agent checks `now < pairingWindowUntil`, computes
`K_psk` from its own `code`, opens the box (a failure means wrong code or tampering →
respond `pairing-reject { phoneFp, reason: "bad-code" }` and count a failure; after 3
failures close the window). On success it verifies `sha256(ed25519Pub)` → `fp_p`.

**Step 4 — key derivation.** Both sides compute:

```
shared = X25519(X_priv_self, X_pub_other)                         // 32 bytes
K_pair = HKDF(ikm = shared ‖ code, salt = "shellbell-pair-v1", info = fp_c + "|" + fp_p, len = 32)
```

Mixing `code` into the KDF means a relay that forwarded (or replaced) the X25519 keys
still cannot derive `K_pair`, because it never saw `code`.

**Step 5 — agent responds and registers.** Agent sends:

- ctrl `pairing-add { phoneFp: fp_p, ed25519Pub: E_pk_p, name }` — to the relay, on its
  authenticated agent socket. The DO inserts the pairing row.
- ctrl `pairing-response { phoneFp: fp_p, box: seal(K_psk, nonce, CBOR{ x25519Pub: X_pk_c, computerName, accent }, ad = "pairing-response|" + fp_c + "|" + fp_p) }` — forwarded to the pairing socket.

Agent persists the pairing (8.3), then discards `code` and closes the window.

**Step 6 — phone finishes.** Phone opens the box, derives `K_pair`, stores it (6.3),
adds the computer to its list, closes the pairing socket, and reconnects with
`role: "phone"`. The DO now finds `fp_p` in its pairing table and admits it.

**Second computer:** repeat from step 0 on that computer. **Second phone:** repeat from
step 0 on the same computer; the agent's pairing list grows.

### 6.5 Authentication to the relay

Every WebSocket connection to a `ComputerDO` begins:

1. DO → client: ctrl `challenge { nonce: bytes(32), connId: string }` (`connId` is 16
   random bytes base64url; unique per socket).
2. Client → DO: ctrl `auth { role: "agent"|"phone"|"pairing", fp, ed25519Pub: bytes(32), sig: bytes(64), name: string, appVersion: string }` where
   `sig = Ed25519.sign(priv, "shellbell-auth-v1|" + connId + "|" + role + "|" + fp + "|" + base64url(nonce))`.
3. DO verifies: `sha256(ed25519Pub)` → `fp`; signature valid; and
   - `agent`: `fp == DO name`. First-ever agent connect stores `ed25519Pub` in the
     `computer` row; later connects must match it.
   - `phone`: `fp` present in `pairings`, and `ed25519Pub` equals the stored one.
   - `pairing`: an agent is currently connected; no fp check.
4. DO → client: ctrl `auth-ok { role, agentOnline: boolean, computerName: string|null, serverTime: number }` or ctrl `auth-fail { reason }` followed by close code 4001.

Unauthenticated sockets are closed after **10 seconds**.

### 6.6 Frame encryption (`e2e` envelopes)

```
nonce = randomBytes(24)
ad    = utf8( "1|" + from + "|" + to + "|" + conn + "|" + seq )      // v=1
ct    = XChaCha20Poly1305(K_pair).seal(nonce, CBOR(innerMessage), ad)
```

- `conn` is the **sender's** `connId` (from its own challenge). The relay stamps the
  sender's `connId` into the envelope it forwards; the receiver uses the stamped value in
  `ad`. A relay that alters `conn`, `from`, `to`, or `seq` causes AEAD failure and the
  frame is dropped. Replay across connections is impossible (`conn` differs); replay
  within a connection is rejected by the `seq` rule below.
- `seq` starts at `0` on each new connection and increments by 1 per e2e frame sent to
  that peer. Receivers keep `lastSeq[from][conn]` and drop any frame with `seq <= lastSeq`.
- Decryption failure → drop frame, log at `warn`, increment a counter; after **20
  consecutive** failures from the same peer the receiver closes and reconnects (this is
  the signal that `K_pair` is out of sync, e.g. the computer was unpaired and re-paired).

---

## 7. Wire protocol

### 7.1 Encoding

All WebSocket frames are **binary** and contain one CBOR-encoded envelope, except the
literal text frames `"ping"` and `"pong"` used for keepalive. Encoding uses `cbor-x`
with `{ useRecords: false, mapsAsObjects: true }` so maps decode to plain objects and byte
strings decode to `Uint8Array`. Every decoded object is validated with zod before use;
invalid frames are dropped and logged.

### 7.2 Envelope

```ts
import { z } from "zod";
const bytes = (n?: number) => z.instanceof(Uint8Array).refine(b => n === undefined || b.length === n);

export const Envelope = z.object({
  v: z.literal(1),
  t: z.enum(["ctrl", "e2e"]),
  from: z.string().length(26),          // sender fp ("relay" for relay-originated ctrl)
  to: z.string().length(26).optional(), // required for e2e; omitted for most ctrl
  conn: z.string().optional(),          // stamped by relay on forwarded frames
  seq: z.number().int().nonnegative(),  // e2e only; ctrl uses 0
  body: z.unknown(),                    // ctrl: CtrlMessage; e2e: { n: bytes(24), c: bytes }
});
```

The relay validates `Envelope`, then for `e2e` frames only: sets `conn` to the sender's
`connId`, checks `from` equals the authenticated fp, and forwards to `to` if connected
(else drops silently — the sender will learn via `presence`). It does not inspect `body`.

### 7.3 Ctrl messages (plaintext; `body.type` discriminates)

| Type | Direction | Fields | Notes |
|---|---|---|---|
| `challenge` | relay → device | `nonce: bytes(32)`, `connId: string` | First frame on every socket |
| `auth` | device → relay | `role`, `fp`, `ed25519Pub`, `sig`, `name`, `appVersion` | See 6.5 |
| `auth-ok` | relay → device | `role`, `agentOnline`, `computerName`, `serverTime` | |
| `auth-fail` | relay → device | `reason: "bad-sig"|"not-paired"|"fp-mismatch"|"no-agent"|"timeout"` | Then close 4001 |
| `presence` | relay → phones | `agentOnline: boolean`, `computerName` | On agent connect/disconnect and after `auth-ok` |
| `pairing-request` | phone → relay → agent | `phoneFp`, `box` | Only from a `pairing` socket |
| `pairing-response` | agent → relay → phone | `phoneFp`, `box` | Relay routes to the pairing socket with that `phoneFp` |
| `pairing-reject` | agent → relay → phone | `phoneFp`, `reason` | Relay forwards then closes the pairing socket (4003) |
| `pairing-add` | agent → relay | `phoneFp`, `ed25519Pub`, `name` | DO upserts pairing |
| `unpair` | agent → relay, or phone → relay | `phoneFp` | Agent may unpair any; a phone may only unpair itself. DO deletes the row and closes that phone's sockets (4004). Relay forwards to the agent when it came from a phone. |
| `push-token` | phone → relay | `token: string`, `platform: "ios"|"android"` | Stored on the pairing row |
| `notify` | agent → relay | `sessionId`, `title`, `kind`, `exitCode?`, `durationMs?` | Triggers push per 11.3 |
| `phones` | relay → agent | `connected: { phoneFp, connId, name }[]` | Sent right after the agent's `auth-ok` |
| `phone-connected` | relay → agent | `phoneFp`, `connId`, `name` | When a paired phone authenticates |
| `phone-disconnected` | relay → agent | `phoneFp`, `connId` | When its socket closes |
| `error` | relay → device | `code`, `message` | Informational |

The DO rejects any ctrl type not listed for that socket's role.

### 7.4 Inner messages (encrypted; `type` discriminates)

Shared types:

```ts
export const Color = z.union([
  z.number().int().min(0).max(255),                       // xterm-256 palette index
  z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]), // RGB
]);
export const Run = z.object({
  t: z.string(),                 // text (may be empty only for a placeholder run)
  fg: Color.optional(), bg: Color.optional(),
  b: z.boolean().optional(),     // bold
  i: z.boolean().optional(),     // italic
  u: z.boolean().optional(),     // underline
  s: z.boolean().optional(),     // strikethrough
  f: z.boolean().optional(),     // faint
});
export const Line = z.object({ r: z.array(Run), w: z.boolean().optional() /* soft-wrapped into next line */ });
export const Cursor = z.object({ x: z.number().int(), y: z.number().int() /* row on screen, 0-based; -1 if hidden/unknown */ });
export const SessionInfo = z.object({
  id: z.string(),                        // globally unique within a computer: "<backend>:<native id>", e.g. "iterm2:5A7B…" or "tmux:%3"
  backend: z.enum(["iterm2", "tmux"]),
  title: z.string(), cwd: z.string().optional(),
  cols: z.number().int(), rows: z.number().int(),
  windowId: z.string(), windowNumber: z.number().int(), tabId: z.string(), tabIndex: z.number().int(), paneIndex: z.number().int(),
  isFocusedOnMac: z.boolean(),
  state: z.enum(["unknown", "editing", "running", "finished"]), // from prompt monitor when available
});
```

**Agent → phone**

| Type | Fields | When |
|---|---|---|
| `hello` | `agentVersion`, `backends: { name: "iterm2"\|"tmux", capabilities: { subscribe, prompts, createSession, focus, rename, close, history } }[]`, `computerName`, `accent` | Immediately after the phone's socket is authenticated (agent learns via `phone-connected` — see 8.7). `backends` lists only the ones currently connected. |
| `sessions` | `list: SessionInfo[]` | On hello, and on every layout/title/focus change (debounced 100 ms) |
| `screen.snapshot` | `sessionId`, `cols`, `rows`, `cursor`, `lines: Line[]` (length = rows), `scrollbackTotal: number`, `gen: number` | On subscribe, on resize, when a diff would exceed 60 % of rows |
| `screen.diff` | `sessionId`, `changed: { i: number, line: Line }[]`, `cursor`, `scrollbackTotal`, `gen` | Otherwise; `gen` increments per frame per session so the phone can detect gaps and request a snapshot |
| `history` | `sessionId`, `before: number`, `lines: Line[]` | Response to `history.get`; `lines[k]` is absolute line `before - lines.length + k` |
| `event` | `sessionId`, `kind: "prompt"|"idle"|"bell"|"exit"`, `exitCode?`, `durationMs?`, `command?`, `at: number` | See 8.8 |
| `ack` | `reqId`, `ok: boolean`, `error?: string`, `sessionId?` | Response to any phone message carrying `reqId` (create/close/rename/focus) |

**Phone → agent**

| Type | Fields | Effect |
|---|---|---|
| `subscribe` | `sessionIds: string[]` | Replaces this phone's subscription set. Agent sends a snapshot for each newly subscribed id. |
| `input.line` | `sessionId`, `text` | `sendText(text + "\r")` |
| `input.text` | `sessionId`, `text` | `sendText(text)` verbatim |
| `input.key` | `sessionId`, `key: NamedKey` | `sendText(bytesFor(key))` |
| `history.get` | `sessionId`, `before: number`, `count: number (1..500)` | Agent fetches lines `[before-count, before)` |
| `session.create` | `reqId`, `in: { kind: "tab", backend: "iterm2"|"tmux", windowId?: string } | { kind: "split", sessionId: string, direction: "vertical"|"horizontal" }` | New tab/window in the named backend (iTerm2: new tab, or new window if `windowId` omitted; tmux: `new-window` in the session that owns `windowId`, or a new tmux session if omitted) or split pane of an existing session (its backend is implied by the id); `ack.sessionId` is the new id |
| `session.focus` | `reqId`, `sessionId` | Bring that session forward **on the Mac** (explicit; never implied by viewing) |
| `session.close` | `reqId`, `sessionId` | Close the pane (iTerm2 may prompt on the Mac; `ack.ok=false, error:"user-declined"`) |
| `session.rename` | `reqId`, `sessionId`, `title` | Sets the session name |
| `session.mute` | `sessionId`, `muted: boolean` | Agent stops sending `notify` for that session (persisted in agent config, per phone) |
| `snapshot.get` | `sessionId` | Force a snapshot (used after a `gen` gap) |

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

The phone never sends escape bytes; it sends the enum value. The agent maps. This is
the injection-proof replacement for the reference project's string interpolation.

### 7.6 QR payload

Schema in `packages/protocol/src/qr.ts`: `{ v: 1, r: url, c: fp, e: base64url(32), n: string(1..40), p: base64url(16) }`.
The app rejects any QR whose `r` is not `wss://` (or `ws://` only when the app is a dev
build), whose `c` ≠ fingerprint of `e`, or whose `v` ≠ 1.

---

## 8. The agent (`apps/agent`)

### 8.1 CLI

Published to npm as `shellbell`. `npx shellbell` runs `start`.

| Command | Behaviour |
|---|---|
| `shellbell` / `shellbell start` | Foreground. Ensures identity, connects to iTerm2 and relay, prints status. If there are **no pairings**, automatically opens a pairing window and prints the QR. `Ctrl-C` stops. |
| `shellbell pair` | Opens a 5-minute pairing window and prints the QR (agent must be running: this command talks to the running agent over a local Unix socket `~/.shellbell/agent.sock`; if not running, it starts one in the foreground). |
| `shellbell status` | Prints: identity fp, relay URL, relay connection state, iTerm2 connection state, backend, number of sessions, paired phones (name, fp prefix, last seen). |
| `shellbell devices` | Lists paired phones. |
| `shellbell unpair <fp-prefix\|name>` | Removes the pairing locally and tells the relay. |
| `shellbell service install` | Writes `~/Library/LaunchAgents/dev.bilalahmad.shellbell.plist` (RunAtLoad, KeepAlive, logs to `~/.shellbell/agent.log`) and loads it. `uninstall` reverses. |
| `shellbell logs [-f]` | Tails `~/.shellbell/agent.log`. |
| `shellbell config set relay <url>` / `name <name>` / `accent <color>` | Edits `config.json`. |
| `shellbell doctor` | Checks: iTerm2 running; API socket exists; cookie obtainable; relay reachable; identity readable; prints fixes. |

Global flags: `--relay <url>` (overrides config), `--json` (machine output for `status`/`devices`), `--verbose`.

**First-run UX (exact text):**

```
  Shellbell agent v0.1.0
  Computer   Bilal's MBP  (k7q3-m2xw)
  Relay      wss://relay.shellbell.app   connected
  iTerm2     connected · 7 sessions

  No phones paired yet. Scan this with the Shellbell app:

  █▀▀▀▀▀█ ▄▀ ▀▄ █▀▀▀▀▀█
  ...QR...

  Pairing window closes in 4:59
```

If iTerm2's API is disabled, `start` prints:

```
  iTerm2's Python API is off. Turn it on:
  iTerm2 → Settings → General → Magic → ✓ Enable Python API
  then run `shellbell` again.
```

If the AppleScript cookie request is denied by the user, print the denial reason and exit 2.

### 8.2 Files in `~/.shellbell/`

| File | Mode | Content |
|---|---|---|
| `identity.json` | 0600 | `Identity` (6.2), bytes base64url |
| `pairings.json` | 0600 | `{ v:1, phones: Pairing[] }` (8.3) |
| `config.json` | 0600 | `{ v:1, relayUrl, computerName, accent, notifyMinCommandMs: 10000, idleQuietMs: 4000, idleMinActiveMs: 1500, muted: Record<phoneFp, string[]> }` |
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

### 8.4 `TerminalBackend` interface (`src/backends/types.ts`)

```ts
export type Capabilities = {
  subscribe: boolean;      // pushes screen-changed events (else agent polls)
  prompts: boolean;        // emits prompt/command events
  createSession: boolean; focus: boolean; rename: boolean; close: boolean; history: boolean;
};
export type Screen = { cols: number; rows: number; cursor: Cursor; lines: Line[]; scrollbackTotal: number };
export type CreateWhere = { kind: "tab"; windowId?: string } | { kind: "split"; sessionId: string; direction: "vertical" | "horizontal" };
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
  listSessions(): Promise<SessionInfo[]>;
  getScreen(sessionId: string): Promise<Screen>;
  getHistory(sessionId: string, before: number, count: number): Promise<Line[]>;
  sendText(sessionId: string, text: string): Promise<void>;
  createSession(where: CreateWhere): Promise<string>;
  focus(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  watch(sessionId: string): Promise<void>;      // start emitting screen-changed for this id
  unwatch(sessionId: string): Promise<void>;
  on(handler: (e: BackendEvent) => void): () => void;
}
```

The agent core never imports backend-specific types. Session ids given to a backend are
the **native** ids (the registry strips the `"<backend>:"` prefix, see 8.12). Backends
must be safe to call concurrently (the tracker may call `getScreen` for several sessions
in the same tick).

### 8.5 iTerm2 backend

#### 8.5.1 Connecting (`src/backends/iterm2/client.ts`, `auth.ts`)

1. **Cookie & key.** Run
   `osascript -e 'tell application "iTerm2" to request cookie and key for app named "Shellbell"'`.
   Output is `"<cookie> <key>"` (single space). AppleScript error `-2740`/`-2741` → iTerm2
   too old (need 3.3+); other error → user denied or API disabled (print hint in 8.1).
   iTerm2 shows a one-time consent dialog naming "Shellbell" unless the user has
   enabled "Allow all apps to connect". Cookies are single-use per process; request a new
   one on every (re)connect.
2. **Socket.** Connect with the `ws` package to the Unix domain socket
   `~/Library/Application Support/iTerm2/private/socket` using
   `new WebSocket("ws+unix://" + encodeURI(socketPath) + ":/", ["api.iterm2.com"], { headers })`.
   If `ws+unix` proves unreliable with the space in the path, use
   `new WebSocket("ws://localhost/", ["api.iterm2.com"], { socketPath, headers })`
   (`ws` forwards options to `http.request`). The spike (18.1) settles which; the code
   keeps one.
   Headers:
   ```
   origin: ws://localhost/
   x-iterm2-library-version: shellbell 0.1.0
   x-iterm2-disable-auth-ui: true
   x-iterm2-advisory-name: Shellbell
   x-iterm2-cookie: <cookie>
   x-iterm2-key: <key>
   ```
   Fallback if the socket file does not exist: `ws://localhost:1912` (legacy TCP).
3. **Framing.** Each binary WS frame is one `ClientOriginatedMessage` (to iTerm2) or
   `ServerOriginatedMessage` (from iTerm2). Requests carry `id` (incrementing int64);
   responses echo it. `Notification` messages arrive with no `id`. The client keeps a
   `Map<id, {resolve, reject, timer}>` with a **5 s** timeout per request.
4. **Reconnect.** If the socket closes, retry with backoff 1 s → 2 s → 4 s → … → 30 s
   (cap), requesting a fresh cookie each time. While disconnected the agent reports
   `sessions: []` to phones and `presence` stays true (the relay connection is separate).

#### 8.5.2 Our proto subset (`apps/agent/proto/iterm2.proto`)

We do **not** vendor iTerm2's GPL `api.proto`. We write our own `proto2` file containing
only the messages we use, with identical names, field names and **field numbers** (these
are protocol facts). Generated with `@bufbuild/buf` + `@bufbuild/protoc-gen-es` into
`src/backends/iterm2/gen/` (gitignored; generated in `prebuild`). The subset:

- Envelopes: `ClientOriginatedMessage { id=1; oneof: get_buffer_request=100, get_prompt_request=101, notification_request=103, list_sessions_request=106, send_text_request=107, create_tab_request=108, split_pane_request=109, set_property_request=111, activate_request=114, variable_request=115, focus_request=117, close_request=131 }` and `ServerOriginatedMessage { id=1; error=2; matching *_response=100…131; notification=1000 }`.
- `GetBufferRequest { session=1; line_range=2; include_styles=3 }`, `LineRange { screen_contents_only=1; trailing_lines=2; windowed_coord_range=3 }`, `GetBufferResponse { status=1; contents=3; cursor=4; windowed_coord_range=6 }`, `LineContents { text=1; code_points_per_cell=2; continuation=3; style=4 }`, `CodePointsPerCell { num_code_points=1; repeats=2 }`, `CellStyle { fgStandard=1; fgAlternate=2; fgRgb=3; bgStandard=5; bgAlternate=6; bgRgb=7; bold=9; faint=10; italic=11; blink=12; underline=13; strikethrough=14; invisible=15; inverse=16; repeats=22 }`, `RGBColor { red=1; green=2; blue=3 }`, `enum AlternateColor { DEFAULT=0; REVERSED_DEFAULT=3; SYSTEM_MESSAGE=4 }`, `Coord { x=1; y=2 }`, `CoordRange { start=1; end=2 }`, `Range { location=1; length=2 }`, `WindowedCoordRange { coord_range=1; columns=2 }`.
- `ListSessionsRequest {}`, `ListSessionsResponse { windows=1 }`, nested `Window { tabs=1; window_id=2; frame=3; number=4 }`, `Tab { root=3; tab_id=2 }`, `SplitTreeNode { vertical=1; links=2 }`, `SplitTreeLink { oneof child: session=1, node=2 }`, `SessionSummary { unique_identifier=1; frame=2; grid_size=3; title=4 }`, `Frame { origin=1; size=2 }`, `Point { x=1; y=2 }`, `Size { width=1; height=2 }`.
- `SendTextRequest { session=1; text=2; suppress_broadcast=3 }`, `SendTextResponse { status=1 }`.
- `NotificationRequest { session=1; subscribe=2; notification_type=3; prompt_monitor_request=9 }`, `PromptMonitorRequest { modes=1 }`, `enum PromptMonitorMode { PROMPT=1; COMMAND_START=2; COMMAND_END=3 }`, `enum NotificationType { NOTIFY_ON_SCREEN_UPDATE=2; NOTIFY_ON_PROMPT=3; NOTIFY_ON_NEW_SESSION=6; NOTIFY_ON_TERMINATE_SESSION=7; NOTIFY_ON_LAYOUT_CHANGE=8; NOTIFY_ON_FOCUS_CHANGE=9; NOTIFY_ON_VARIABLE_CHANGE=12 }`, `NotificationResponse { status=1 }`.
- `Notification { screen_update_notification=2; prompt_notification=3; new_session_notification=6; terminate_session_notification=7; layout_changed_notification=8; focus_changed_notification=9; variable_changed_notification=12 }` and each of those message types with the fields listed in Appendix A.
- `GetPromptRequest { session=1; unique_prompt_id=2 }`, `GetPromptResponse { status=1; working_directory=5; command=6; prompt_state=7; exit_status=9; unique_prompt_id=10 }`.
- `CreateTabRequest { profile_name=1; window_id=2; tab_index=3; select_tab=6 }`, `CreateTabResponse { status=1; window_id=2; tab_id=3; session_id=4 }`, `SplitPaneRequest { session=1; split_direction=2; before=3 }`, `SplitPaneResponse { status=1; session_id=2 }`.
- `ActivateRequest { window_id=1; tab_id=2; session_id=3; order_window_front=4; select_tab=5; select_session=6 }`, `ActivateResponse { status=1 }`.
- `CloseRequest { sessions=2 (CloseSessions { session_ids=1 }); force=4 }`, `CloseResponse { statuses=1 }`.
- `VariableRequest { session_id=1; set=2 (Set { name=1; value=2 }); get=3 }`, `VariableResponse { status=1; values=2 }` — used to read `session.name`, `session.path` and to set `user.shellbellTitle` if needed.
- `FocusRequest {}`, `FocusResponse { notifications=1 }`.

Unknown fields are ignored by protobuf, so omitting fields we don't use is safe.

#### 8.5.3 Sessions and layout

`listSessions()`:

1. `ListSessionsRequest` → for each `window` (ordered by `number`), each `tab` (in
   order, `tabIndex` = position), walk `root` depth-first; each `SessionSummary` leaf gets
   `paneIndex` = visit order within the tab.
2. For each session, one `VariableRequest { session_id, get: ["session.name", "session.path"] }`
   → `title` (fallback `SessionSummary.title`, fallback `"Session"`), `cwd`. Batch these
   with `Promise.all`; cache titles and refresh them on `variable_changed_notification`
   for `session.name` / `session.path` (subscribe with `VariableMonitorRequest` for those
   names at session scope, identifier `"all"`).
3. `cols/rows` from `grid_size`. `isFocusedOnMac` from the last `FocusChangedNotification`
   (`session` field) seeded by a `FocusRequest` at connect.
4. `state` from the prompt tracker (8.8): `editing`/`running`/`finished`/`unknown`.

Subscriptions made once at connect: `NOTIFY_ON_LAYOUT_CHANGE`, `NOTIFY_ON_NEW_SESSION`,
`NOTIFY_ON_TERMINATE_SESSION`, `NOTIFY_ON_FOCUS_CHANGE` (session `"all"` / ignored), and
per session: `NOTIFY_ON_PROMPT` with modes `[PROMPT, COMMAND_START, COMMAND_END]` and
`NOTIFY_ON_SCREEN_UPDATE` (always, for every session — it carries no payload and drives
the idle heuristic for unsubscribed sessions too). On `new_session_notification`, add the
per-session subscriptions; on `terminate_session_notification`, drop state.

`layout_changed_notification` includes a full `ListSessionsResponse`; use it instead of
re-requesting.

#### 8.5.4 Screen (`getScreen`)

`GetBufferRequest { session, line_range: { screen_contents_only: true }, include_styles: true }`.

- `lines` = `contents` converted per 8.5.5, padded/truncated to exactly `rows` entries
  (iTerm2 omits trailing uninitialized lines; pad with `{ r: [] }`).
- `scrollbackTotal` = `windowed_coord_range.coord_range.start.y` (absolute index of the
  first screen row; equals the number of lines above the screen).
- `cursor.y` = `response.cursor.y - scrollbackTotal` (clamped to `[-1, rows-1]`),
  `cursor.x` = `response.cursor.x`.
- `cols/rows` from the cached `grid_size` for that session.

`getHistory(sessionId, before, count)`:
`GetBufferRequest { session, line_range: { windowed_coord_range: { coord_range: { start: { x: 0, y: max(0, before - count) }, end: { x: 0, y: before } } } }, include_styles: true }`
→ convert; return in ascending order.

#### 8.5.5 Cell conversion (`convert.ts`) — exact algorithm

Input: `LineContents { text, code_points_per_cell[], style[], continuation }`.
Output: `Line`.

```
1. Expand code_points_per_cell into an array cellCp[] where cellCp[k] = number of code points in cell k.
   (repeat each entry `repeats` times; default num_code_points = 1). If the array is empty, treat every
   code point of `text` as one cell.
2. Expand style[] the same way into cellStyle[] (repeat each CellStyle `repeats` times; default 1).
   If include_styles produced no styles, cellStyle[] is empty and every cell is unstyled.
3. Walk cells: textIndex = 0; for k in 0..cellCp.length-1:
     cpCount = cellCp[k]
     cellText = cpCount == 0 ? " " : next cpCount code points from `text` starting at textIndex
     textIndex += cpCount   (code points, not UTF-16 units — iterate with Array.from(text) once)
     st = cellStyle[k] ?? {}
     run style = normalize(st)
     if previous run has identical style → append cellText to it, else start a new run.
4. normalize(st):
     fg = st.fgRgb ? [r,g,b] : st.fgStandard != null ? st.fgStandard : undefined   (fgAlternate → undefined)
     bg = likewise from bgRgb / bgStandard
     if st.inverse: first substitute defaults — fg ??= 15 (bright white), bg ??= 0 (black) — then swap fg and bg.
        (So "default on default, inverse" becomes black text on bright-white, which is what iTerm2 shows.)
     b = bold, i = italic, u = underline, s = strikethrough, f = faint; invisible → text replaced by spaces.
     blink is ignored. Image cells are omitted by iTerm2 already.
5. Trim trailing runs that are only spaces with no bg (keeps payloads small; the phone pads visually).
6. w = (continuation == CONTINUATION_SOFT_EOL).
```

A unit test fixture set is captured from a real `GetBufferResponse` (via the spike) and
committed under `apps/agent/test/fixtures/` as JSON.

#### 8.5.6 Input

- `sendText(sessionId, text)` → `SendTextRequest { session: sessionId, text, suppress_broadcast: true }`.
  `SESSION_NOT_FOUND` → throw `SessionGone`.
- `createSession({kind:"tab", windowId})` → `CreateTabRequest { window_id: windowId, select_tab: false }` → `session_id`.
  `createSession({kind:"split", sessionId, direction})` → `SplitPaneRequest { session: sessionId, split_direction: direction=="vertical"?VERTICAL:HORIZONTAL }` → `session_id[0]`.
- `focus(sessionId)` → `ActivateRequest { session_id: sessionId, order_window_front: true, select_tab: true, select_session: true, activate_app: { raise_all_windows: false, ignoring_other_apps: false } }`.
- `closeSession(sessionId)` → `CloseRequest { sessions: { session_ids: [sessionId] }, force: false }`; status `USER_DECLINED` → throw `UserDeclined`.
- `rename(sessionId, title)` → `VariableRequest { session_id, set: [{ name: "session.name", value: JSON.stringify(title) }] }`.
  If iTerm2 rejects (`INVALID_NAME`), fall back to `SendTextRequest` with the OSC title
  sequence `"\x1b]1;" + title + "\x07"` **only if** `title` contains no `\x1b` or `\x07`
  (strip those characters first).

### 8.6 Screen tracker (`screen-tracker.ts`) — exact algorithm

State per session `S`:

```ts
{ subscribers: Set<phoneFp>, dirty: boolean, lastLines: string[] /* per-row hash */, lastCols, lastRows,
  lastScrollbackTotal, gen: number, inflight: boolean }
```

- `subscribe(phoneFp, ids)`: compute added/removed vs the phone's previous set; for
  removed ids drop the phone; for added ids add and enqueue `snapshot(S, phoneFp)`.
  `backend.watch(S)` is a no-op for iTerm2 (we subscribe to all screen updates anyway).
- On `screen-changed(S)`: `dirty = true`; also feed the idle heuristic (8.8).
- **Flush loop**: `setInterval(125 ms)`. For each `S` with `dirty && subscribers.size > 0 && !inflight`:
  1. `inflight = true; dirty = false`; `screen = await backend.getScreen(S)`.
  2. Hash each line: `hash = fnv1a32(JSON.stringify(line))` (deterministic key order:
     build the string manually as `t|fg|bg|b|i|u|s|f` per run joined by `\x1f`).
  3. If `cols/rows` changed, or `lastLines` empty, or changed rows > `0.6 * rows` →
     **snapshot**; else **diff** with `changed = [{ i, line }]` for rows whose hash
     differs.
  4. `gen++`; send the frame to every subscriber (one encryption per phone).
  5. `lastLines = hashes; inflight = false`. If `dirty` became true during the await,
     the next tick handles it.
- **Global cap**: at most **40 frames per second per phone** across all sessions; if the
  cap is hit, skip lower-priority sessions this tick (priority = most recently
  subscribed first).
- Errors from `getScreen` (session gone) → remove the session and emit `sessions`.

Line hashes are 32-bit; collisions cost a missed update, which the next change repairs.

### 8.7 Agent ↔ relay (`relay-client.ts`)

- One WebSocket to `wss://<relay>/ws/<fp_c>`; handshake per 6.5 with `role: "agent"`.
- Keepalive: send text `"ping"` every **30 s**; expect `"pong"` within 10 s or reconnect.
  (The relay's hibernation auto-response answers without waking the DO.)
- Backoff on failure: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s cap, ±20 % jitter; reset on
  successful `auth-ok`.
- The agent learns which phones are connected from the relay's `phones` (after
  `auth-ok`), `phone-connected` and `phone-disconnected` ctrl messages (7.3). On
  `phone-connected` the agent sends `hello` then `sessions` to that phone and resets
  `lastSeq` for that phone's `connId`.
- Outbound e2e frames to a phone are dropped locally if the phone is not connected
  (avoids useless encryption work).

### 8.8 Events and ringing (`events.ts`, `notifier.ts`)

Per session state: `{ promptState, commandStartedAt, command, lastChangeAt, activeSince, lastRingAt }`.

**Prompt events** (iTerm2 shell integration installed in the user's shell):
- `command-start` → `promptState = "running"`, record `commandStartedAt`, `command`.
- `command-end { exitCode }` → `promptState = "finished"`; `durationMs = now - commandStartedAt`;
  emit `event { kind: "prompt", exitCode, durationMs, command }` to subscribers; if
  `durationMs >= config.notifyMinCommandMs` (default **10 000**) → `ring`.
- `prompt` → `promptState = "editing"`.

**Idle heuristic** (works without shell integration and for TUIs like Claude Code that
are one long "running" command):
- On `screen-changed`: `lastChangeAt = now; activeSince ??= now`.
- Every **1 s**: for each session where `activeSince != null && now - lastChangeAt >= config.idleQuietMs (4000) && lastChangeAt - activeSince >= config.idleMinActiveMs (1500)`:
  emit `event { kind: "idle", durationMs: lastChangeAt - activeSince }`; `activeSince = null`;
  `ring` **unless** a `prompt` event fired for this session in the last 5 s (dedupe) or
  `promptState == "editing"` (the shell is at a prompt; nothing is waiting).

**`ring(S, kind, extra)`**: if `S` is muted for a phone, skip that phone; rate-limit
per session **1 ring / 60 s** (`lastRingAt`); send ctrl `notify { sessionId, title, kind, exitCode?, durationMs? }`.
The relay decides who actually gets a push (11.3).

**`exit`** event: emitted on `session-removed` (no ring).

**`bell`**: not available from the iTerm2 API. For tmux, v1.1 adds a global
`alert-bell` hook; v1 emits no `bell`. The enum value stays so the phone/relay already
handle it.

**Per-backend note:** the prompt path only exists for iTerm2 sessions with shell
integration; tmux sessions rely entirely on the idle heuristic. The heuristic's inputs
(`screen-changed`) come from `%output` events for tmux, which are precise.

### 8.11 tmux backend (`src/backends/tmux/`)

**Requirements:** `tmux` ≥ 3.2 on `PATH` (for client flags `-f read-only,ignore-size`) and a
running server on the default socket. `doctor` reports the version; older tmux → backend
disabled with the message "tmux 3.2+ required for Shellbell (found 3.1)". Only the
default server is supported in v1 (`-L`/`-S` are v1.1 via `config set tmux.socket`).

**Native ids:** tmux pane ids (`%N`). Windows are `@N`, sessions `$N`. Our `SessionInfo`
maps: `windowId` = tmux session id (`$N`), `windowNumber` = tmux session index (order
of `list-sessions`), `tabId` = tmux window id (`@N`), `tabIndex` = `#{window_index}`,
`paneIndex` = `#{pane_index}`.

**Listing** (`cli.ts`): one process call

```
tmux list-panes -a -F '#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_title}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{window_active}\t#{history_size}\t#{cursor_x}\t#{cursor_y}\t#{pane_dead}'
```

Fields are tab-separated; titles may not contain tabs (tmux escapes them). `title` =
`window_name` if it is not the default shell name, else `pane_title`, else
`"<session_name>:<window_index>.<pane_index>"`. `isFocusedOnMac` =
`pane_active && window_active && session is attached` (`#{session_attached}` > 0).
`state` is always `"unknown"` (no prompt support in v1).

**Screen** (`getScreen`): two calls, run in parallel:
- `tmux capture-pane -p -e -t %N` → visible rows with SGR escapes (no `-J`, so one output
  line per screen row; tmux pads to `pane_height` rows — if fewer lines come back, pad).
- `tmux display-message -p -t %N '#{cursor_x}\t#{cursor_y}\t#{history_size}\t#{pane_width}\t#{pane_height}'`.
Each row goes through `sgr.parse(row)` (8.11.1). `scrollbackTotal` = `history_size`.

**History** (`getHistory(id, before, count)`): `tmux capture-pane -p -e -t %N -S <s> -E <e>`
where lines above the screen are negative: `s = before - count - history_size`,
`e = before - 1 - history_size` (both ≤ −1). Clamp `s` to `-history_size`.

**Input:**
- `sendText(id, text)`: `tmux send-keys -t %N -l -- <text>`; if `text` ends with `"\r"`
  (from `input.line`), strip it and append a separate `Enter` key argument
  (`send-keys -t %N -l -- <text> \; send-keys -t %N Enter`) because literal CR is not
  reliably interpreted as Enter by all programs under tmux.
- Named keys (`keys.ts`): `enter→Enter`, `tab→Tab`, `shift-tab→BTab`, `esc→Escape`,
  `backspace→BSpace`, `delete→DC`, `up/down/left/right→Up/Down/Left/Right`, `home→Home`,
  `end→End`, `page-up→PPage`, `page-down→NPage`, `ctrl-a…ctrl-z→C-a…C-z`,
  `ctrl-space→C-Space`, `f1…f12→F1…F12`. Sent as `tmux send-keys -t %N <Name>`.
  Text is passed as a separate argv element, never through a shell.

**Events** (`control.ts`): for each tmux session, keep one long-lived control-mode client:
`tmux -C attach-session -t $N -f read-only,ignore-size` (spawned with stdio pipes).
Parse stdout line by line:
- `%output %N <data>` → emit `screen-changed` for `%N` (data is ignored; we re-capture).
- `%layout-change`, `%window-add`, `%window-close`, `%window-renamed`, `%unlinked-window-*`,
  `%session-renamed`, `%sessions-changed` → emit `layout-changed` (debounced 100 ms;
  the registry re-lists).
- `%exit` → that session is gone; emit `layout-changed`; drop the client.
- Blocks between `%begin`/`%end`/`%error` are command replies; ignore.
A watcher poll every **5 s** (`list-sessions -F '#{session_id}'`) discovers new sessions
and starts clients for them; sessions that vanish get their client killed. If the tmux
server dies, all clients exit; the backend reports no sessions and retries detection
every 10 s.

**Create / focus / close / rename:**
- `createSession({kind:"tab", windowId})` → `tmux new-window -P -F '#{pane_id}' -t $N`
  (if `windowId` omitted: `tmux new-session -d -P -F '#{pane_id}'`).
- `createSession({kind:"split"...})` → `tmux split-window -P -F '#{pane_id}' -t %N -h|-v`
  (`vertical` → `-h`, matching iTerm2's meaning of a vertical divider).
- `focus(id)` → `tmux select-window -t @W \; select-pane -t %N` (does not raise the GUI
  terminal; that is inherent).
- `closeSession(id)` → `tmux kill-pane -t %N`.
- `rename(id, title)` → `tmux rename-window -t @W -- <title>`.

**Capabilities:** `{ subscribe: true, prompts: false, createSession: true, focus: true, rename: true, close: true, history: true }`.

#### 8.11.1 SGR parser (`packages/protocol/src/sgr.ts`)

`parse(text: string): Line` — converts one row of text containing only SGR escape
sequences (what `capture-pane -e` emits) into runs. Exact behaviour:

- Scan for `ESC [` … `m`. Parameters are separated by `;` (and sub-parameters by `:`,
  which must also be accepted for `38:2::r:g:b` / `38:5:n` forms). Empty parameter = 0.
- Maintain a current style `{ fg, bg, b, i, u, s, f, inverse }`, initially all unset.
- Codes: `0` reset all · `1` b · `2` f · `3` i · `4` u · `7` inverse · `9` s · `22` clear b and f ·
  `23` clear i · `24` clear u · `27` clear inverse · `29` clear s · `30–37` fg = n−30 ·
  `38;5;n` fg = n · `38;2;r;g;b` fg = [r,g,b] · `39` fg unset · `40–47` bg = n−40 ·
  `48;5;n` / `48;2;r;g;b` bg · `49` bg unset · `90–97` fg = n−90+8 · `100–107` bg = n−100+8.
  Unknown codes are ignored. Malformed sequences (no terminating `m` within 32 bytes)
  are emitted as literal text.
- Any other `ESC` sequence (`ESC ] … BEL`, `ESC ( B`, etc.) is stripped. Control
  characters < 0x20 other than TAB are stripped; TAB becomes spaces to the next multiple
  of 8 columns.
- Text between sequences becomes a run with the current style; adjacent runs with equal
  style merge. `inverse` is resolved at emit time exactly as in 8.5.5 step 4 (swap, with
  15/0 substitution). Trailing all-space runs without `bg` are trimmed.
- Wide characters count as their visual width for the TAB rule only; the phone renders
  glyphs as-is.

Tests: a table of ≥ 40 input/expected pairs including nested resets, 256-color, truecolor
with colon syntax, bright colors, inverse of defaults, OSC stripping, and tab expansion.

### 8.12 Backend registry (`src/backends/registry.ts`)

- **Detection at start and every 10 s while a backend is absent:** iTerm2 if
  `~/Library/Application Support/iTerm2/private/socket` exists (or TCP 1912 answers);
  tmux if `tmux -V` succeeds with version ≥ 3.2 and `tmux list-sessions` exits 0.
- Each detected backend is `connect()`ed independently; a failure in one never affects
  the other. `hello.backends` lists the connected ones; changes trigger a new `hello`.
- **Ids:** the registry exposes a single `TerminalBackend`-shaped facade to the agent
  core. It prefixes every native id with `"<name>:"` on the way out and strips it on the
  way in, and routes calls to the owning backend. Unknown prefix → `SessionGone`.
- **De-duplication with iTerm2's tmux integration:** when iTerm2 attaches to tmux with
  `tmux -CC`, the same panes exist in both backends. iTerm2's `ListSessionsResponse.Tab`
  carries `tmux_window_id` for such tabs. Rule: hide any tmux-backend session whose tmux
  `window_id` (`@N`) equals a `tmux_window_id` reported by iTerm2. iTerm2 wins because it
  provides native styles and prompt events.
- **Ordering in `sessions`:** iTerm2 sessions first (window number, tab index, pane
  index), then tmux (session index, window index, pane index).
- The events stream is the merge of both backends' streams with ids prefixed.

### 8.13 Local control socket

`shellbell pair|status|devices|unpair` connect to `~/.shellbell/agent.sock` (newline-
delimited JSON: `{ cmd, args }` → `{ ok, data|error }`). If the socket is absent, `pair`
starts a foreground agent; the others print "agent not running".

### 8.14 Logging

`log.ts` writes JSON lines `{ t, level, msg, ...fields }` to `agent.log` and pretty
lines to stdout when attached to a TTY. Never log: keys, cookies, pairing codes,
terminal content, or input text. Log input **lengths** only.

---

## 9. The relay (`apps/relay`)

### 9.1 Worker (`src/index.ts`)

Routes:

| Method + path | Behaviour |
|---|---|
| `GET /` | `200` JSON `{ name: "shellbell-relay", version, docs: "https://github.com/…" }` |
| `GET /healthz` | `200 ok` |
| `GET /ws/:fp` | Validates `fp` (`^[a-z2-7]{26}$`), requires `Upgrade: websocket`, forwards the request to `env.COMPUTER.get(env.COMPUTER.idFromName(fp)).fetch(request)` |
| anything else | `404` |

No CORS (WebSocket only). No request bodies.

### 9.2 `ComputerDO` (`src/computer-do.ts`)

**Storage** (SQLite-backed DO; created on first use):

```sql
CREATE TABLE IF NOT EXISTS computer (
  fp TEXT PRIMARY KEY, ed25519_pub BLOB NOT NULL, name TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS pairings (
  phone_fp TEXT PRIMARY KEY, ed25519_pub BLOB NOT NULL, name TEXT NOT NULL,
  push_token TEXT, push_platform TEXT, paired_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS ring_limits (
  session_id TEXT PRIMARY KEY, last_ring_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_limits (
  phone_fp TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
```

**WebSockets** use the Hibernation API:

- `fetch()` → `new WebSocketPair()`; `this.ctx.acceptWebSocket(server, ["unauth"])`;
  send `challenge`; `ws.serializeAttachment({ state: "unauth", connId, nonce, since })`;
  `this.ctx.storage.setAlarm(now + 10_000)` if no alarm pending (the alarm sweeps
  unauthenticated sockets older than 10 s and stale pairing sockets older than 60 s).
- `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` in the constructor.
- `webSocketMessage(ws, msg)`: if `typeof msg === "string"` ignore (only ping/pong are
  text and those are auto-handled). Decode CBOR → `Envelope`; on failure close `4400`.
  Dispatch by attachment state:
  - `unauth`: only `auth` accepted → verify per 6.5 → on success re-serialize attachment
    `{ state: "agent"|"phone"|"pairing", fp, connId, name }`, and **re-tag** by closing
    and… (tags are immutable after accept) → instead, keep tags `["unauth"]` and rely on
    the attachment for role; use `this.ctx.getWebSockets()` + attachment filtering for
    fan-out. (Fan-out sizes are tiny: one agent, a handful of phones.)
  - `agent`: accepts ctrl `pairing-add`, `pairing-response`, `pairing-reject`, `unpair`,
    `notify`; e2e frames with `to` = a connected phone.
  - `phone`: accepts ctrl `push-token`, `unpair` (self only); e2e frames with `to = computer fp`.
  - `pairing`: accepts exactly one `pairing-request`, forwarded to the agent socket;
    anything else → close `4403`.
- On forwarding an e2e frame: set `envelope.conn = sender.connId`, re-encode, send.
- `webSocketClose/Error`: if agent → broadcast `presence { agentOnline: false }` to phones
  and send nothing else; if phone → send `phone-disconnected` to the agent.
- Agent connect: if another agent socket is already open for this DO, close the **old**
  one with `4005` ("superseded") — the newest process wins (handles restarts).

**Push** (`src/push.ts`): on ctrl `notify` from the agent:

1. Rate-limit: `ring_limits[sessionId].last_ring_at` within 60 s → drop.
2. Recipients: pairings with a `push_token` whose `phone_fp` has **no open authenticated
   socket** right now.
3. Per-phone cap: **20 pushes per rolling hour** (`push_limits`); beyond that, drop.
4. `POST https://exp.host/--/api/v2/push/send` with body
   `[{ to: token, title: computerName, body: <text>, data: { computerFp, sessionId, kind }, sound: "default", priority: "high", channelId: "rings", categoryId: "ring" }]`.
   `body` text by kind: `prompt` → `"<title> finished (exit <code>) after <duration>"`;
   `idle` → `"<title> went quiet — waiting for you?"`; `bell` → `"<title> rang the bell"`.
   `<title>` is the session title from the agent, truncated to 40 chars.
5. Response handling: a ticket with `details.error == "DeviceNotRegistered"` → clear that
   phone's token. Other errors → log; no retry (a missed ring is acceptable; a retry storm
   is not).

Optionally set `EXPO_ACCESS_TOKEN` as a Worker secret and send it as
`Authorization: Bearer` — recommended for the hosted relay; not required for self-hosters.

### 9.3 Configuration (`wrangler.jsonc`)

```jsonc
{
  "name": "shellbell-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": { "bindings": [{ "name": "COMPUTER", "class_name": "ComputerDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ComputerDO"] }],
  "observability": { "enabled": true },
  "routes": [{ "pattern": "relay.shellbell.app", "custom_domain": true }]
}
```

Self-hosters delete `routes` and use the `*.workers.dev` URL in their QR
(`shellbell config set relay wss://shellbell-relay.<account>.workers.dev`).

### 9.4 Free-tier fit

- Idle computers cost nothing: hibernated sockets, ping/pong auto-response.
- Active viewing: ≤ 8 frames/s per viewed session, ≤ 40/s per phone. DO incoming
  WebSocket messages are billed at 20:1 against requests, so one phone actively viewing
  one busy session ≈ 0.4 req/s ≈ 1 440 req/hour. The free daily allowance supports on
  the order of 70 phone-hours of *continuous busy viewing* per day per account; typical
  use is a few minutes at a time.
- No KV, no queues, no cron. One Worker, one DO class.

---

## 10. The mobile app (`apps/mobile`)

### 10.1 Stack

Expo SDK 57 (React Native 0.87, New Architecture), TypeScript, expo-router, zustand,
FlashList v2, Reanimated 4, Gesture Handler 3, expo-secure-store, expo-sqlite (`kv-store`)
for non-secret persistence, expo-camera (barcode), expo-notifications, expo-haptics,
expo-clipboard, expo-keep-awake, expo-glass-effect, expo-crypto, expo-dev-client.

### 10.2 Routes (`app/`)

| File | Screen |
|---|---|
| `_layout.tsx` | Root: fonts, theme, gesture root, notification handlers, deep links, connection manager mount |
| `index.tsx` | **Computers** — list of paired computers |
| `pair.tsx` | **Pair** — camera scanner (presented as modal) |
| `c/[fp]/_layout.tsx` | Computer stack |
| `c/[fp]/index.tsx` | **Sessions** — list for one computer, grouped by window → tab |
| `c/[fp]/s/[sid].tsx` | **Session** — the terminal view |
| `c/[fp]/settings.tsx` | Computer settings: name, accent, mute all, unpair |
| `settings.tsx` | App settings: this phone's name & fp, font size, theme, notifications, about, license, Buy Me a Coffee |

Deep link scheme `shellbell://c/<fp>/s/<sid>` (used by notification taps). Universal
links are v2.

### 10.3 State (`src/store/`)

```ts
// persisted (kv-store): list of computers and UI prefs
useComputersStore: { computers: { fp, name, accent, relayUrl, pairedAt, lastSeenAt }[], add, remove, update }
useUiStore: { fontSize: number /* default 12 */, fitWidth: boolean, rawModeBySession: Record<string, boolean>, historyByComputer: Record<fp, string[]> }

// in-memory
useConnectionStore: {
  byComputer: Record<fp, {
    status: "idle"|"connecting"|"auth"|"online"|"offline"|"error", agentOnline: boolean, error?: string,
    hello?: Hello, sessions: SessionInfo[],
    screens: Record<sid, { cols, rows, cursor, lines: Line[], scrollbackTotal, gen, history: Line[], historyFrom: number }>,
    events: Record<sid, Event[]>, unread: Record<sid, number>,
  }>
}
```

Screen updates mutate `lines` in place via the diff and bump a per-line `key` so FlashList
re-renders only changed rows.

### 10.4 Connection manager (`src/net/`)

`ComputerConnection` (one per computer):

- `connect()`: open `wss://<relayUrl>/ws/<fp>`; on `challenge` respond `auth` with
  `role: "phone"`; on `auth-ok` set status `online`, send `push-token` (if permission
  granted), then wait for `hello`.
- Sends/receives e2e using `K_pair` from SecureStore; keeps `seq` and `lastSeq`.
- `"ping"` every 30 s while foregrounded.
- Backoff same as the agent (1→30 s). `presence.agentOnline=false` sets `agentOnline`
  false but keeps the socket (the phone is still authenticated; the agent may come back).
- `ConnectionManager` connects all computers when `AppState` becomes `active`, and closes
  all sockets **5 s** after it becomes `background` (iOS would kill them anyway; closing
  cleanly makes the relay's "not connected → push" rule accurate).
- On regaining foreground, each open session view re-sends `subscribe` and, if its
  `gen` is stale, `snapshot.get`.

### 10.5 Session screen — rendering (`src/screen/`)

- Font: **JetBrainsMono Nerd Font** (OFL), Regular/Bold/Italic/BoldItalic, bundled.
  Advance width is exactly `0.6 × fontSize` → `charWidth = fontSize * 0.6`,
  `lineHeight = fontSize * 1.25`.
- Layout: a horizontal `ScrollView` (`bounces=false`, `showsHorizontalScrollIndicator=false`)
  whose content width is `max(viewportWidth, cols * charWidth + padding)`, containing a
  vertical `FlashList` of lines. Vertical list = `[...history, ...screenLines]`;
  `estimatedItemSize = lineHeight`. Nested opposite-axis scrolling is supported by RN.
- `LineView` (memo, keyed by row hash): one `<Text numberOfLines={1}>` containing nested
  `<Text>` per run with `color`, `backgroundColor`, `fontFamily` (bold/italic variant),
  `textDecorationLine`, `opacity: 0.6` for faint. Empty line renders a single space to
  keep height.
- Cursor: an absolutely-positioned 1-char block at `(cursor.x * charWidth, cursor.y * lineHeight)`
  over the screen region, accent-colored at 70 % opacity, blinking via Reanimated only
  when the session is `running`/`editing`.
- **Fit width** toggle: sets an override font size `viewportWidth / cols / 0.6` (min 5).
  **Pinch** (Gesture Handler) adjusts font size 5–24; persists to `useUiStore`.
- **Follow tail**: auto-scroll to the bottom on every frame unless the user has scrolled
  up; a "↓ Jump to live" pill appears when not following.
- **History**: when the list is scrolled to within 20 rows of the top and
  `historyFrom > 0`, send `history.get { before: historyFrom, count: 200 }` and prepend.
  `history` is cleared when `scrollbackTotal` shrinks (session cleared).
- Colors: `packages/protocol/src/colors.ts` provides the 256-color palette; indices 0–15
  come from the theme (10.9), 16–231 the standard 6×6×6 cube, 232–255 the gray ramp.
  Default fg = theme `text`, default bg = transparent (black).

### 10.6 Session screen — input (`src/input/`)

Bottom bar (glass on iOS), three rows:

1. **Reply chips** (only shown when the latest event for this session is `idle` or the
   session is `running`): `y ⏎`, `n ⏎`, `⏎`, `Esc`. Tap sends `input.line "y"` etc.
2. **Quick keys** (horizontal scroll): `Esc` `Tab` `^C` `^D` `^Z` `^L` `^U` `↑` `↓` `←` `→` `⏎` `Paste` `^R` `^A` `^E`.
3. **Text field**:
   - **Line mode** (default): single-line `TextInput`, `returnKeyType="send"`, autocorrect
     off, autocapitalize none; Send → `input.line`; history per computer (last 100,
     persisted), long-press the field's `↑` button to browse.
   - **Raw mode** (toggle `⌨︎`; remembered per session): every character typed is sent
     immediately as `input.text`; Backspace → `input.key backspace`; Return →
     `input.key enter`; the field stays empty. Implemented by diffing `onChangeText`
     against the previous value (RN has no reliable per-key event for soft keyboards)
     and by `onKeyPress` for `Backspace`/`Enter`.
   - Paste → `input.text` with clipboard content (no trailing newline).
- Haptics: `impactAsync(Light)` on every send; `notificationAsync(Success)` on pair;
  `notificationAsync(Warning)` when an `event` arrives for the session you are viewing.
- Header: session title (tap to rename), computer accent dot, backend badge (`iTerm2` /
  `tmux`, tiny, muted), state badge, `⋯` menu: Focus on Mac · New tab · Split vertical ·
  Split horizontal · Mute · Close session. Menu items are hidden when the session's
  backend lacks the capability.
- Sessions list groups by backend, then window/tab; the "＋" button offers "New iTerm2
  tab" / "New tmux window" according to `hello.backends`.
- `expo-keep-awake` active while this screen is mounted.

### 10.7 Identity and pairing (`src/identity/`, `app/pair.tsx`)

- `import "expo-crypto"` polyfill first in `app/_layout.tsx` (before `@noble`).
- First launch: generate identity, store in SecureStore, pick a default phone name
  (`Device.deviceName ?? "My phone"`).
- **Pair screen**: `expo-camera` `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ["qr"] }}`.
  On scan: validate per 7.6 → show a sheet "Pair with *Bilal's MBP*?" with the fp prefix
  → run the pairing flow (6.4) with a 20-second overall timeout → success haptic →
  navigate to that computer's sessions. Errors map to copy: `bad-code` → "That code
  expired — run `shellbell pair` again"; `no-agent` → "The computer isn't online";
  timeout → "Couldn't reach the relay".
- If the phone already has this computer, pairing **replaces** the stored `K_pair`.

### 10.8 Notifications (`src/notifications/`)

- Ask permission after the **first successful pairing** (not on launch), with a one-line
  explanation.
- Token: `Notifications.getExpoPushTokenAsync({ projectId })` where `projectId` comes from
  `Constants.expoConfig.extra.eas.projectId`. Sent as `push-token` on every `auth-ok`.
- Android channel `rings` (importance high, vibration) created at startup.
- Foreground handler: show nothing system-level; the app shows an in-app toast + haptic
  and increments `unread[sid]`.
- Tap: `Notifications.addNotificationResponseReceivedListener` → `router.push("/c/<fp>/s/<sid>")`.
- iOS category `ring` with actions `Reply y`, `Reply n`, `Open` (v2 — requires
  background socket work; listed in 17.3).

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

- UI font: system (SF Pro / Roboto). Terminal font: JetBrainsMono NF.
- Top and bottom bars use `GlassView` (`expo-glass-effect`) on iOS 26+, a translucent
  `surface` with 1-px `border` elsewhere. Same component, platform-checked inside.
- Each computer's accent tints: its card, the session header dot, the cursor, the send
  button, and the connection indicator.
- Lists use FlashList; cards have `radius.lg`, no shadows (OLED), 1-px borders.
- Motion: Reanimated layout transitions for list changes; 150 ms ease-out; no bounces
  except native scroll.
- Empty states are single sentences with one action (e.g. "No computers yet — *Pair one*").
- Accessibility: all quick keys have `accessibilityLabel`; text scales with the system
  setting for UI text (not the terminal font).

A dedicated design pass is a plan task (17.2 M6) and should use the frontend-design
skill; this section fixes tokens and structure so that pass is about polish, not
architecture.

---

## 11. Notifications end to end

### 11.1 What is sent through Apple/Google

Only: computer name (title), session title + event kind (body), and `{ computerFp,
sessionId, kind }` (data). Never terminal content, never commands, never input.

### 11.2 Who decides what

| Decision | Where | Rule |
|---|---|---|
| "Something happened worth ringing" | Agent | 8.8 |
| "Which phones, and not too often" | Relay | 9.2 Push |
| "Show it, and where to go" | App | 10.8 |

### 11.3 Push targeting rule

Push goes to paired phones **with a token and no authenticated socket open** at that
moment. A phone with the app in the foreground is connected and gets the `event` inline
instead. Because the app closes sockets 5 s after backgrounding, "backgrounded" ≈
"not connected" ≈ "gets a push", which is the intended behaviour.

---

## 12. Connection lifecycle and error handling

| Situation | Agent | Relay | App |
|---|---|---|---|
| iTerm2 not running / API off | `doctor`-style hint, retry every 10 s; relay socket stays up; sessions `[]` | — | Shows "iTerm2 not running on *MBP*" from `hello.capabilities`/empty sessions |
| Relay unreachable | Backoff reconnect; keeps serving nothing | — | Status `offline`; "Reconnecting…" pill; no overlay blocking the last screen |
| Agent offline | — | `presence false` to phones | Shows last screen dimmed + "Computer offline since 12:04" |
| Phone unpaired on Mac | Removes pairing | Closes phone sockets `4004` | On `4004`: marks computer "unpaired", offers Remove/Re-pair |
| `K_pair` mismatch | 20 decrypt failures → close | — | Same → "Re-pair this computer" |
| Duplicate agent process | New wins; old exits with a message | Closes old `4005` | — |
| Session closed on Mac | `sessions` update; `event exit` | — | Session screen shows "Session ended" with a Back button |
| Frame gap (`gen` jump) | — | — | Sends `snapshot.get` |
| Oversized frame (> 512 KB) | Never produced: snapshots are ≤ rows × cols cells; history capped at 500 lines | Drops > 1 MB frames, closes `4413` | — |

WebSocket close codes used: `4001` auth failed · `4003` bad pairing message · `4004`
unpaired · `4005` superseded · `4400` malformed · `4403` forbidden for role · `4413`
too large · `4408` unauth timeout.

---

## 13. Security and threat model

**Assets:** terminal content and input (highest), the ability to type into a shell
(highest), pairing list, push tokens.

**Adversaries and mitigations:**

| Adversary | Can they… | Mitigation |
|---|---|---|
| Passive network / relay operator | read terminal data? | No — E2E with per-pair keys; relay sees only lengths and timing |
| Malicious relay | inject input, impersonate a computer, add a phone? | No — inputs are AEAD-bound to `K_pair`; pairing requires `code` the relay never sees; `pairing-add` is only accepted on the agent's signed socket |
| Malicious relay | deny service, replay frames, reorder? | DoS yes (accepted). Replay/reorder no — `conn`+`seq` in AD |
| Someone who photographs your QR | pair their phone? | Only during the 5-minute window and only if the agent accepts; the QR is shown in your terminal on your screen. Mitigation for shared screens: `shellbell pair --confirm` (v1.1) requires pressing Enter on the Mac for each pairing |
| Someone with your unlocked phone | type into your shell? | Yes (same as any app). v1.1: optional Face ID gate on app open via `expo-local-authentication` |
| Someone with your Mac user account | read keys? | Yes; same trust level as `~/.ssh`. Keychain in v2 |
| Rogue local process | connect to iTerm2 API as us? | iTerm2 issues per-process cookies; ours are never written to disk |
| Malformed frames from a paired peer | crash the agent? | zod validation at every boundary; sizes capped; exceptions caught per message |
| A paired phone that turned malicious | run commands? | Yes, by design — that's what pairing grants. `shellbell unpair` revokes instantly |

**Explicit non-mitigations in v1:** no forward secrecy (a stolen `K_pair` decrypts past
captured traffic); no certificate pinning (TLS via Cloudflare); no protection if the
Mac itself is compromised.

**Privacy:** the hosted relay logs connection metadata (fp, timestamps, byte counts) for
abuse handling, retained 7 days; documented in `PRIVACY.md`.

---

## 14. Performance budgets

| Metric | Budget |
|---|---|
| Screen change → visible on phone (same city, Wi‑Fi) | ≤ 300 ms p50 (125 ms coalesce + GetBuffer + network + render) |
| Agent CPU while idle (no subscribers) | ≤ 0.5 % of one core |
| Agent CPU with one subscriber viewing a busy session | ≤ 8 % of one core |
| Snapshot size, 200×60 screen, styled | ≤ 60 KB before encryption (typical ≤ 15 KB) |
| Diff size per frame, typical build log | ≤ 4 KB |
| App: scroll 5 000-line history at 60 fps on iPhone 13 / Pixel 6 | no dropped frames on fling |
| App: memory for one open session with 2 000 history lines | ≤ 60 MB above baseline |
| Pairing end-to-end | ≤ 3 s after scan |
| Cold start to computers list | ≤ 1.5 s |

The spike (18.1) measures `GetBuffer` latency for a 200×60 styled screen; if it exceeds
40 ms, reduce coalescing to 200 ms rather than change the design.

---

## 15. Testing strategy

**`packages/protocol`** (vitest, node):
- Codec round-trips for every message schema (property-style tests with fast-check are
  optional; at least one fixture per message type).
- Crypto: seal/open symmetry; wrong key/nonce/AD fails; pairing derivation yields the
  same `K_pair` on both sides; fingerprint is stable and 26 chars; signature verify.
- Keys: every `NamedKey` maps to a non-empty byte string; table snapshot.
- QR encode/decode and rejection cases.

**`apps/agent`** (vitest, node):
- `convert.ts` against committed real fixtures (see 8.5.5) — exact expected `Line[]`.
- Screen tracker with a fake backend and fake timers: snapshot on subscribe; diff on
  small change; snapshot when > 60 % changed; no frames when no subscribers; 40 fps cap.
- Events: prompt path (start/end → `prompt`, ring threshold), idle path (timing table),
  dedupe, mute, per-session rate limit.
- Pairing: full agent-side flow against an in-memory "relay" double; bad code → reject;
  3 failures → window closes.
- Relay client: reconnect/backoff with fake timers; seq/replay rejection.
- `sgr.ts` table tests (8.11.1) live in `packages/protocol`.
- tmux backend: `keys.ts` table snapshot; control-mode line parser against a recorded
  transcript fixture (`%begin/%end`, `%output`, `%layout-change`, `%exit`); `list-panes`
  row parser; capture/history range arithmetic.
- Registry: id prefixing/stripping; routing; de-dup with `tmux_window_id`; one backend
  failing does not affect the other.
- **Live integration** (opt-in, `SHELLBELL_ITERM_E2E=1`): connects to the real iTerm2,
  lists sessions, fetches a screen, sends `echo shellbell-test` and sees it appear.
- **Live tmux integration** (opt-in, `SHELLBELL_TMUX_E2E=1`): starts a throwaway
  `tmux -L shellbell-test` server, creates a session, verifies `%output` arrives after
  `send-keys`, captures a styled screen (`printf '\e[31mred\e[0m'`) and checks the runs.

**`apps/relay`** (vitest with `@cloudflare/vitest-pool-workers`):
- Challenge/auth for each role including every failure reason.
- Pairing socket: only one message, 60-s expiry, needs agent online.
- Routing: agent→phone and phone→agent e2e, `conn` stamping, `from` spoof rejected.
- `unpair` closes sockets; `notify` → push only to disconnected phones; rate limits;
  `DeviceNotRegistered` clears token (mock `fetch`).
- Duplicate agent supersedes.

**`apps/mobile`** (vitest with `react-native` preset for pure logic; component tests kept
minimal):
- Store diff application; `gen` gap → `snapshot.get`.
- `ComputerConnection` against a fake WebSocket: handshake, seq, backoff, foreground /
  background behaviour.
- Raw-mode input differ: typed "ab", backspace, "c" → expected messages.
- Manual QA checklist in `apps/mobile/QA.md` (pairing, both platforms, notifications,
  deep link, dark/light OS setting has no effect — app is always dark).

**Cross-cutting:** a `scripts/e2e-local.sh` that runs the relay with `wrangler dev`, the
agent with `--relay ws://localhost:8787`, and prints a QR for a dev build of the app.

---

## 16. Tooling, CI, release and distribution

- **Package manager:** pnpm 11 workspaces. Root scripts: `lint` (biome check), `typecheck`
  (tsc -b), `test` (vitest across packages), `build`.
- **Biome** for lint + format (2-space, double quotes, semicolons, 100 cols).
- **TypeScript** strict, `moduleResolution: bundler`, ESM everywhere.
- **Agent build:** `tsdown` → single ESM file `dist/cli.js` with a `#!/usr/bin/env node`
  banner; `package.json` `bin: { shellbell: "dist/cli.js" }`, `engines.node >= 20`,
  `os: ["darwin"]`. Published to npm on release via Changesets.
- **Relay deploy:** `wrangler deploy` from CI on tag `relay-v*`; secrets set once with
  `wrangler secret put EXPO_ACCESS_TOKEN`.
- **Mobile:** EAS Build (`development`, `preview`, `production` profiles), EAS Update for
  JS-only releases, EAS Submit for stores. Bundle ids `dev.bilalahmad.shellbell` (iOS) /
  `dev.bilalahmad.shellbell` (Android package).
- **CI (`ci.yml`):** on push/PR — install, lint, typecheck, test (all three apps +
  protocol). Relay tests run under the workers pool. Mobile tests run pure-logic only.
- **Docs:** `README.md` (what/why/install/60-second demo GIF), `docs/self-hosting.md`,
  `docs/protocol.md` (generated from this spec's section 7), `PRIVACY.md`, `SECURITY.md`
  (disclosure email), `CONTRIBUTING.md`.
- **Costs:** Cloudflare $0; Expo $0 (free tier builds); domain `shellbell.app` ≈ $14/yr;
  Apple $99/yr; Google $25 once.

---

## 17. Milestones and scope

### 17.1 v1 (ship to TestFlight / internal track)

| Milestone | Deliverable | Done when |
|---|---|---|
| **M0 Spike** | Node connects to iTerm2 API, lists sessions, gets a styled screen, sends text | Script prints runs for the current session; latency numbers recorded in `docs/spike-iterm2.md`; fixtures captured |
| **M1 Protocol** | `@shellbell/protocol` complete with tests | `pnpm -F @shellbell/protocol test` green; 100 % of schemas covered |
| **M2 Relay** | Worker + DO with auth, pairing gating, routing, push | Tests green; `wrangler dev` accepts a scripted agent + phone double |
| **M3 Agent** | CLI, identity, relay client, iTerm2 backend, tracker, events, pairing, launchd | `npx shellbell` prints QR; a scripted "phone" in tests receives snapshots and can type |
| **M3b tmux** | SGR parser, tmux control-mode client, tmux backend, registry with de-dup | With Ghostty (or Terminal.app) running `tmux`, the scripted phone sees and types into the tmux pane; iTerm2 `-CC` panes are not duplicated |
| **M4 App core** | Pairing, computers, sessions, session view, input (line/raw/keys) | Pair a real phone, view and type into a real iTerm2 session over the hosted relay |
| **M5 Rings** | Prompt + idle events, push, deep link | Background the app, run `sleep 15; echo done`, get a push, tap, land on the session |
| **M6 Polish & release** | Design pass, empty/error states, settings, docs, CI, store listings, TestFlight | Two people other than the author pair and use it from written docs alone |

### 17.2 v1.1 (fast follow)

Kitty and WezTerm direct backends (reuse `sgr.ts`; `kitty @ ls/get-text --ansi/send-text`,
`wezterm cli list/get-text --escapes/send-text`), tmux `alert-bell` hook → `bell`,
non-default tmux sockets, "new phone-sized tmux session" from the app, `session.create`
profile picker, `shellbell pair --confirm`, Face ID gate, notification actions (Reply
y/n from the notification — requires a short-lived background socket), history search,
"share screen as text".

### 17.3 v2

Linux agent (tmux backend only), Live Activities, Watch app, Skia grid renderer, macOS
Keychain, forward secrecy (ratchet), universal links, Mac color-scheme import.

---

## 18. Risks and spikes

| # | Risk | Spike / mitigation |
|---|---|---|
| 18.1 | `ws` cannot speak to the iTerm2 Unix socket with the required headers/subprotocol | **M0 spike.** Fallback: TCP `ws://localhost:1912` (requires enabling it in iTerm2), or a 40-line Python shim as last resort (rejected unless both fail) |
| 18.2 | `GetBuffer` with styles is slow for large screens at 8 fps | Measure in M0; adjust coalescing; never poll unsubscribed sessions |
| 18.3 | Nested `Text` runs in FlashList too slow on busy TUIs | Measure with an `htop` session in M4; fallback: limit runs per line by merging near-identical styles; v2: Skia |
| 18.4 | DO free-tier request quota with several users | Coalescing + caps in 14; monitor via Workers analytics; if needed, raise coalescing to 200 ms globally via a relay-advertised `minFrameMs` in `auth-ok` |
| 18.5 | Expo push requires an EAS project id (Expo account) | Free; documented in self-hosting; self-hosters may leave push unconfigured (relay skips push if no token) |
| 18.6 | `expo-glass-effect` behaviour on older iOS / Android | Component falls back to translucent surface; verified in M6 |
| 18.7 | iTerm2 consent dialog confuses users | `doctor` + first-run copy explain it; screenshot in README |
| 18.8 | Session ids change when iTerm2 restarts | Ids are per-session UUIDs; the app treats unknown ids as gone and refreshes from `sessions` |
| 18.9 | Shell integration not installed → no prompt events | Idle heuristic covers it; `doctor` suggests installing shell integration for exit codes |
| 18.10 | tmux control-mode client with `-f read-only,ignore-size` still affects window size or blocks on `%pause` | **M3b spike (first task):** verify on tmux 3.2+ that a `-C` client does not resize a GUI-attached session and that `%output` flows; if `ignore-size` is insufficient, set `window-size latest` advice in `doctor` and document. Fallback: poll `capture-pane` every 250 ms for subscribed panes plus `alert-activity` hooks |
| 18.11 | tmux not installed on the user's Mac | Backend simply absent; `doctor` prints `brew install tmux` when it detects Ghostty/Warp/Alacritty/Terminal.app running without tmux (nice-to-have) |
| 18.12 | Same pane visible twice via iTerm2 `-CC` | De-dup rule in 8.12; tested |

---

## Appendix A — iTerm2 API facts (verified 2026-09-03)

Source: `gnachman/iTerm2` `master` — `proto/api.proto`, `api/library/python/iterm2/iterm2/connection.py`, `auth.py`.

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
- `proto2` syntax; package `iterm2`; request/response ids are `int64`; notifications
  arrive as `ServerOriginatedMessage.notification` (field 1000) with no id.
- Session id strings: a unique id from `ListSessionsResponse`, or `"all"` / `"active"`
  where documented.
- `GetBufferResponse.cursor.y` is **absolute** (includes lines above the screen);
  `windowed_coord_range.coord_range.start.y` gives the screen's first absolute line.
- `LineContents.style` is run-length encoded via `CellStyle.repeats`;
  `code_points_per_cell` maps code points to cells (see 8.5.5).
- `CellStyle` colors: `fgStandard`/`bgStandard` (xterm index), `fgRgb`/`bgRgb`
  (`RGBColor` 0–255 each), `fgAlternate`/`bgAlternate` (`DEFAULT`, `REVERSED_DEFAULT`, `SYSTEM_MESSAGE`).
- `PromptNotification` has `oneof event { prompt, command_start { command }, command_end { status } }`;
  requested with `NotificationRequest.prompt_monitor_request.modes`.
- `LayoutChangedNotification` carries a full `ListSessionsResponse`.
- `CreateTabRequest.select_tab=false` creates in the background; `CreateTabResponse.session_id`.
- `SplitPaneRequest.split_direction` `VERTICAL=0`, `HORIZONTAL=1`; response has `repeated session_id`.
- `CloseRequest` can target sessions; `USER_DECLINED` status exists.
- `VariableRequest` gets JSON-encoded values 1:1 with `get`; sets require `user.` prefix
  for custom names (built-ins like `session.name` are settable per the Python library's
  `async_set_name`).
- `api.proto` and the Python library are **GPLv2**; we author our own subset (8.5.2).

## Appendix B — Lessons from `remote-iterm`

Studied: `mammadovziya/remote-iterm` v1.0.1 (server 247+329 LOC, client 1 234 LOC).

**Keep:** QR-on-launch onboarding · per-session content cache for instant tab switches ·
"output was changing, then quiet → alert" heuristic (now a push) · the exact quick-key
set (ESC, ^C, ^D, ^Z, ^L, arrows, TAB, ⏎, paste, copy, ^U) · a virtual keyboard symbol row
tuned for shells (`- / . _ ~ * $ | > <`) · spatial window map from real window bounds ·
persisted command history · following the Mac's focus by default.

**Change, and why:** AppleScript polling → API subscriptions (no process spawns, real
styles, TUIs work) · plain text + regex colors → styled runs · inbound `0.0.0.0` with no
auth → outbound E2E relay · one global `activeSessionId` → per-phone subscription sets ·
full-buffer resend → line diffs · Vite dev server in production → built artifacts ·
string-interpolated AppleScript (`sendKeys` had no escaping at all) → typed messages and
a named-key table · viewing a tab also focusing it on the Mac → explicit `session.focus`.

**Why they did it their way (fair):** AppleScript needs no setup and no second runtime;
there was no Node client for the iTerm2 API; `contents of session` is a one-liner that
nails the "deploy log" demo; polling was the only option once AppleScript was chosen.

## Appendix C — Pinned versions

Looked up on npm 2026-09-03; pin these (or newer patch) at project creation.

| Package | Version | | Package | Version |
|---|---|---|---|---|
| expo | 57.0.19 | | @bufbuild/protobuf | 2.14.1 |
| expo-router | 57.0.18 | | @bufbuild/protoc-gen-es | 2.14.1 |
| react-native | 0.87.1 | | @bufbuild/buf | 1.72.0 |
| @shopify/flash-list | 2.3.2 | | cbor-x | 1.6.6 |
| react-native-reanimated | 4.6.0 | | @noble/curves | 2.4.0 |
| react-native-gesture-handler | 3.2.1 | | @noble/ciphers | 2.4.0 |
| expo-secure-store | 57.0.3 | | @noble/hashes | 2.4.0 |
| expo-camera | 57.0.4 | | zod | 4.5.4 |
| expo-notifications | 57.0.16 | | ws | 8.21.3 |
| expo-haptics | 57.0.2 | | commander | 15.0.0 |
| expo-glass-effect | 57.0.1 | | qrcode-terminal | 0.12.0 |
| expo-crypto | 57.0.2 | | wrangler | 4.129.0 |
| expo-clipboard | 57.0.1 | | @cloudflare/workers-types | 5.20260903.1 |
| expo-keep-awake | 57.0.1 | | @cloudflare/vitest-pool-workers | 0.22.0 |
| expo-sqlite | 57.0.2 | | vitest | 5.0.0 |
| expo-dev-client | 57.0.18 | | @biomejs/biome | 2.5.12 |
| zustand | 5.0.15 | | tsdown | 0.23.0 |
| react-native-safe-area-context | 5.9.1 | | @changesets/cli | 3.0.1 |
| react-native-screens | 4.27.0 | | pnpm | 11.12.0 (local) |

Local toolchain on the author's Mac: Node 22.23.1, pnpm 11.12.0, Xcode CLT 2416,
iTerm2 with API server enabled. Not installed: tmux (`brew install tmux` is the first
step of M3b), expo/eas CLIs (use `npx`).
