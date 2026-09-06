# Shellbell Plan 05 — Mobile app core (Expo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** An iOS + Android app that pairs with a Mac by scanning its QR, lists paired computers and
their sessions, renders a live styled terminal screen with scrollback, and lets the user type (line
mode, raw mode, named keys, reply chips) with at-most-once delivery — over the hosted relay,
end-to-end encrypted.

**Architecture:** Expo SDK 57 + expo-router. Pure-logic modules (`src/net`, `src/store/screen.ts`,
`src/input/differ.ts`, `src/identity/keys.ts`, `src/util/*`) have no React Native imports and are
unit-tested with vitest in Node; screens are thin. One `ComputerConnection` per paired computer,
managed by `ConnectionManager` from `AppState`. Screen state comes from `@shellbell/protocol`'s
`applySnapshot`/`applyDiff`. The phone parses inner/ctrl messages with the **loose** parsers added
in Task 0 so an older app never rejects a newer agent (spec 10.6).

**Tech Stack:** Expo 57 (versions chosen by `npx expo install`), expo-router, zustand 5, FlashList 2,
Reanimated 4 + worklets, Gesture Handler 2.32, expo-secure-store, expo-sqlite kv-store, expo-camera,
expo-haptics, expo-clipboard, expo-keep-awake, expo-glass-effect, expo-crypto, expo-dev-client,
expo-splash-screen, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 6.4 (phone side),
6.6, 6.7, 7.4, 7.6, 10, 11.3, 12, 13, 15 (mobile tests). Plans 01–04b complete (a running agent +
relay to test against; `scripts/e2e-local.sh` for local).

---

## READ THESE SHIPPED FILES FIRST (pinned to `main` @ `5ff8ead`)

Before writing a single line of any task, read these in full. They are the authority on every
symbol, signature and close code this plan uses. Do **not** infer an API from this plan's snippets
if the shipped file disagrees — the shipped file wins, and you must report the discrepancy.

| File | Why |
|---|---|
| `packages/protocol/src/inner.ts` | `InnerMessageSchema`, `SessionInfoSchema`, `BackendNameSchema` (`iterm2\|tmux\|herdr`), `state` incl. `blocked`, `CapabilitiesSchema`, `parseInner` |
| `packages/protocol/src/ctrl.ts` | `CtrlMessageSchema`, `EventKindSchema` (incl. `blocked`), `notify.kind`, `auth-ok.minFrameMs`, `AuthFailReasonSchema`, `PairingRejectReasonSchema`, `MAX_PAIRINGS` |
| `packages/protocol/src/screen.ts` | `Line`/`Run`/`ScreenState`, `applySnapshot`, `applyDiff`, `HISTORY_CAP`, `codePoints`, `lineKey`, `colorKey` |
| `packages/protocol/src/qr.ts` | `parseQr(text, { allowInsecure })`, `relayWsUrl(r, fp)` |
| `packages/protocol/src/crypto.ts` | `deriveConnKey(kPair, nPhone, nAgent, computerFp, phoneFp)`, `helloAd(from, to)`, `frameAd(from, to, connTag, seq)`, `pairingAd`, `derivePskKey`, `derivePairKey`, `identityToJson`, `authMessage` |
| `packages/protocol/src/width.ts` | `stringCells(s)` — use it, never hand-count cells |
| `apps/agent/test/fakes/fake-phone.ts` | The reference phone-side 6.6/6.7 implementation. `ComputerConnection`'s crypto must match it exactly |
| `apps/agent/test/fakes/fake-relay.ts` | The relay double the Task 4 tests run against (Task 4 extends it) |
| `apps/agent/src/relay-client.ts` | The lifecycle `ComputerConnection` mirrors: backoff, `PERMANENT_AUTH_FAIL_REASONS`, `superseded` |
| `apps/agent/src/phone-link.ts` | The peer of `ComputerConnection`: handshake, seq, ack cache, 20-failure break |
| `apps/relay/src/computer-do.ts` | Auth flow for roles `phone`/`pairing`, `presence`, push targeting, close codes `4001/4003/4004/4005/4400/4403/4408/4413/4429` |

---

## Post-execution errata (2026-09-06)

Executed on branch `sdd/plan-05-mobile` (Tasks 0–8, 3 fix rounds, 1 final fix wave; rulings R54–R61 in
the SDD ledger). Where this text still differs from the shipped code, the code is the authority:

- **Protocol (Task 0):** `packages/protocol` has a separate `tsconfig.test.json` (Node types for tests
  only; `src/` stays Node-free); a drift-guard test pins the loose schemas' non-enum fields to the
  strict ones.
- **Scaffold (Task 1):** `newArchEnabled` is not a valid SDK 57 field (dropped); `react-native-screens`
  resolved to `~4.26.2`; `typescript` excluded from `expo install --check`; the JetBrains Mono **Nerd
  Font** v3.4.0 TTFs are embedded (OFL + MIT, `assets/fonts/LICENSE.md`) via the `expo-font` config
  plugin only — no `useFonts(require(...))` JS path; iOS PostScript names are
  `JetBrainsMonoNF-{Regular,Bold,Italic,BoldItalic}`; camera plugin has `recordAudioAndroid: false`.
- **Connection (Task 4):** repeated agent `conn.hello` (same nonce) rejected; socket-identity guards;
  `close()` in any readyState; `ConnectionManager` is generation-guarded and re-runs after a
  background/foreground flap; `presence:false` during a handshake keeps the socket.
- **Pairing (Task 5):** scan guard (same-payload dedupe, 2 s cooldown, explicit "Scan again"); response
  `x25519Pub` must be 32 bytes; relay-side faults use the `relay` copy; `appVersion` from
  `expo-constants`.
- **Screens (Tasks 6–8):** `StatusOverlay` dims (never unmounts); `sessionEnded()` predicate handles a
  session removed while viewed; cursor prop memoized via `buildCursor`; raw-mode Backspace is wired
  through `onKeyPress` (an empty field emits no `onChangeText`); pinch persists on gesture end;
  `SafeAreaProvider` + insets on bars; floating promises caught (identity failure shows a storage error
  state); `InputBar` never registers a pending input while offline and always toasts on
  `DeliveryUnknownError`; `input.line` guarded at 8 KB; unpair sends the `unpair` ctrl before wiping
  `K_pair`; the notifications toggle sends `push-token {enabled}` when a token exists (token
  acquisition itself is Plan 06); SecureStore items use `WHEN_UNLOCKED_THIS_DEVICE_ONLY` with a
  one-time migration.
- **Known limitations (documented):** unknown `auth-fail`/`pairing-reject` reasons still fail strictly
  (surface as a relay error); unknown backends render but get no "New session" action; `.tsx` screens
  are verified only via `QA.md`; `docs/spike-render.md` measurements are [HUMAN] and still blank.
- **Spec drift recorded:** §10.5 fit-width padding; §10.6 raw-mode field wording; §12 `4004` overload;
  §15 mobile test list (all edited in the spec on 2026-09-06).

## Global Constraints

**Human-run rule.** Steps marked **[HUMAN]** must never be executed by an agent. They need a
physical device, a simulator, an Apple/Google account, EAS login, push credentials, or an
interactive prompt. An agent that reaches a **[HUMAN]** step stops, reports, and waits. An agent
must never fabricate a measurement, a device observation, or a screenshot for one of these steps.

**Bounded commands.** Every command an agent runs is wrapped so it cannot hang the session:

```bash
perl -e 'alarm 300; exec @ARGV' -- <command>      # 300 s default
perl -e 'alarm 600; exec @ARGV' -- <command>      # 600 s for bundling/export
```

Never run `expo start`, `expo run:ios`, `expo run:android`, `eas build`, `eas init`, `eas submit`,
or any watcher from an agent step — they never exit.

**Verify gate (every task).** A task is not done until, from the repo root:

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm lint:fix
perl -e 'alarm 300; exec @ARGV' -- pnpm lint
perl -e 'alarm 300; exec @ARGV' -- pnpm typecheck
perl -e 'alarm 300; exec @ARGV' -- pnpm test
```

all pass. `pnpm lint` is `biome check .` — it is a **format** check as well as a lint, and Biome's
React domain rules (notably `suspicious/noArrayIndexKey`) apply to `.tsx`. Run `lint:fix` first,
then `lint` to confirm nothing is left.

**Formatting.** Biome: 2-space indent, double quotes, semicolons, trailing commas, **100 columns**.
Every snippet in this plan is already wrapped to 100 columns; keep it that way.

**Workspace filter.** The mobile package is named **`@shellbell/mobile`** (Task 1 Step 2 renames it
from `create-expo-app`'s default). Every command targeting it uses
`pnpm -F @shellbell/mobile <script>`.

**Package installs.** Run every Expo package install through `npx expo install <pkg>` — never pin an
RN-native package by hand. SDK 57's `expo install` set is authoritative (`react-native` 0.86.3,
reanimated 4.5.1, worklets 0.10.1, gesture-handler ~2.32.0, flash-list 2.0.2, safe-area-context
~5.7.0, screens ~4.26.0); npm `latest` for several of these is **outside** SDK 57 and a hand
`pnpm add` will break the build. Commit `package.json` and the root lockfile after each install.
Installs need network — they are **[HUMAN]** or explicitly pre-approved.

**pnpm hoisting.** The root `.npmrc` has `node-linker=hoisted`, which Expo autolinking and the
Metro `nodeModulesPaths` in Task 1 depend on. Do not switch to the isolated linker.

**Crypto bootstrap.** `src/bootstrap/crypto.ts` is the **first import** of `app/_layout.tsx`.
Nothing from `@noble/*` or `@shellbell/protocol` may be imported before it in module order.

**Secrets.** Identity and `K_pair` live only in `expo-secure-store`. `expo-sqlite/kv-store` holds
computers and UI prefs. Command history is memory-only.

**Never log content.** No `console.log`, log line, error string, toast, or test fixture may contain
terminal output, a typed command, a key, a nonce, `K_pair`, `K_conn`, a pairing `code`/`gate`, or a
push token. Log shapes and lengths only (`{ kind: "line", len: 42 }`), exactly as
`apps/agent/src/agent.ts` does. Fixtures generate their own random keys; no secret is committed.

**Loose parsing on the phone.** After Task 0, the app uses `parseInnerLoose`/`parseCtrlLoose` and
the `*Loose` types everywhere. The agent and relay keep the strict parsers. Any `backend`, session
`state` or `event.kind` the app does not recognise renders as a generic badge showing the raw
string and is otherwise treated normally (spec 10.6).

**Other invariants.** Session ids in routes are base64url-encoded (`sidToRoute`/`sidFromRoute`). The
app never re-sends an input on its own. Terminal font: JetBrainsMono Nerd Font (OFL);
`charWidth = fontSize * 0.6`, `lineHeight = fontSize * 1.25`. Dark-only UI; tokens from spec 10.9 in
`src/theme/tokens.ts`. React keys are never array indices — use `line.key`, `computer.fp`,
`session.id`, or a content-derived key.

---

## File structure created by this plan

```
packages/protocol/
├── src/loose.ts               loose enum companions + parseInnerLoose/parseCtrlLoose (Task 0)
└── test/loose.test.ts

apps/agent/test/fakes/fake-relay.ts   extended with ctrlFromPhones (Task 4)

apps/mobile/
├── package.json  app.json  eas.json  metro.config.js  babel.config.js  tsconfig.json
├── vitest.config.ts  expo-env.d.ts  .gitignore  QA.md
├── scripts/sync-vectors.mjs   copies protocol golden vectors into src/util/ (checked in CI)
├── app/
│   ├── _layout.tsx            crypto bootstrap first; fonts; providers; ConnectionManager mount
│   ├── index.tsx              Computers
│   ├── pair.tsx               Pair (modal, camera)
│   ├── settings.tsx           App settings (+ dev self-test, render spike entry)
│   ├── dev/render-spike.tsx   render spike screen (dev builds only)
│   └── c/[fp]/_layout.tsx  c/[fp]/index.tsx  c/[fp]/settings.tsx  c/[fp]/s/[sid].tsx
├── src/
│   ├── bootstrap/crypto.ts
│   ├── identity/keys.ts       identity + pairing secrets in SecureStore
│   ├── net/connection.ts      ComputerConnection (RN-free)
│   ├── net/manager.ts         ConnectionManager (AppState)
│   ├── net/pairing.ts         runPairing (phone side of 6.4)
│   ├── store/computers.ts     persisted list + prefs (zustand + kv-store)
│   ├── store/connections.ts   in-memory per-computer state (zustand)
│   ├── store/screen.ts        applyFrame helpers with line keys (RN-free)
│   ├── input/differ.ts        raw-mode keystroke differ (RN-free)
│   ├── input/keys.ts          quick key definitions
│   ├── screen/LineView.tsx  ScreenRow.tsx  ScreenView.tsx  Cursor.tsx
│   ├── input/InputBar.tsx   QuickKeys.tsx  ReplyChips.tsx
│   ├── ui/Bar.tsx  Card.tsx  Pill.tsx  EmptyState.tsx  Toast.tsx  StatusOverlay.tsx
│   ├── theme/tokens.ts  theme/fonts.ts
│   └── util/routes.ts  util/backends.ts  util/session-state.ts  util/fixtures.ts
│       util/vectors.json (generated by scripts/sync-vectors.mjs, committed)
└── test/  connection.test.ts  differ.test.ts  screen.test.ts  routes.test.ts  backends.test.ts
```

---

### Task 0: Loose enum tolerance in `@shellbell/protocol` (spec 10.6)

Spec 10.6 requires that an unknown `SessionInfo.backend`, `SessionInfo.state` or `event.kind` is
"opaque, never fatal". The shipped `parseInner`/`parseCtrl` use strict `z.enum`s, so a single
unknown value makes the **whole frame** throw `ProtocolError("malformed")` and the app silently
drops it. That cannot be fixed in a screen. This task adds loose companions in the protocol package;
the agent and relay keep using the strict parsers unchanged.

**Files:**
- Create: `packages/protocol/src/loose.ts`, `packages/protocol/test/loose.test.ts`
- Modify: `packages/protocol/src/inner.ts` (export two schemas that are currently module-private),
  `packages/protocol/src/index.ts` (re-export `./loose.js`)

**Interfaces:**
- `BackendNameLooseSchema`, `SessionStateLooseSchema`, `EventKindLooseSchema` — a known member or
  any other non-empty string ≤ 32 chars.
- `SessionInfoLooseSchema`, `InnerMessageLoose`, `InnerMessageLooseOf<T>`, `CtrlMessageLoose`.
- `parseInnerLoose(u): InnerMessageLoose`, `parseCtrlLoose(u): CtrlMessageLoose` — identical to the
  strict parsers in every other respect (same limits, same required fields, same error type).

- [ ] **Step 1: Export the pieces `loose.ts` needs (pure refactor)**

In `packages/protocol/src/inner.ts`, promote the module-private `sid` helper and the inline session
state enum to exported schemas and use them where they were used before:

```ts
export const SidSchema = z.string().min(1).max(128);
export const SessionStateSchema = z.enum([
  "unknown",
  "editing",
  "running",
  "finished",
  "blocked",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;
```

`SessionInfoSchema.state` becomes `SessionStateSchema`; every `sid` reference becomes `SidSchema`.
Nothing about the parsed shape changes. `pnpm -F @shellbell/protocol test` must stay green with no
test edits — that is the proof this step is a refactor.

Add `export * from "./loose.js";` to `packages/protocol/src/index.ts`.

- [ ] **Step 2: Write the failing tests**

`packages/protocol/test/loose.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCtrl,
  parseCtrlLoose,
  parseInner,
  parseInnerLoose,
  runVectorChecks,
  type Vectors,
} from "../src/index.js";
import vectors from "./vectors.json" with { type: "json" };

const session = (backend: string, state: string) => ({
  id: "zsh:1",
  backend,
  title: "t",
  cols: 80,
  rows: 24,
  windowId: "w",
  windowNumber: 1,
  tabId: "t",
  tabIndex: 0,
  paneIndex: 0,
  isFocusedOnMac: false,
  state,
});

describe("loose parsing (spec 10.6)", () => {
  it("accepts an unknown backend loosely and rejects it strictly", () => {
    const msg = { type: "sessions", list: [session("zsh", "running")] };
    const loose = parseInnerLoose(msg);
    expect(loose.type).toBe("sessions");
    if (loose.type !== "sessions") throw new Error("unreachable");
    expect(loose.list[0]?.backend).toBe("zsh");
    expect(() => parseInner(msg)).toThrow(/malformed/);
  });

  it("accepts an unknown session state and an unknown event kind loosely", () => {
    const s = parseInnerLoose({ type: "sessions", list: [session("herdr", "compiling")] });
    if (s.type !== "sessions") throw new Error("unreachable");
    expect(s.list[0]?.state).toBe("compiling");
    const e = parseInnerLoose({ type: "event", sessionId: "tmux:%1", kind: "bell", at: 1 });
    if (e.type !== "event") throw new Error("unreachable");
    expect(e.kind).toBe("bell");
  });

  it("accepts an unknown backend inside hello.backends", () => {
    const caps = {
      subscribe: true,
      prompts: false,
      createSession: false,
      focus: false,
      history: false,
      absoluteLines: false,
    };
    const h = parseInnerLoose({
      type: "hello",
      agentVersion: "9",
      backends: [{ name: "kitty", capabilities: caps }],
      computerName: "MBP",
      accent: "emerald",
    });
    if (h.type !== "hello") throw new Error("unreachable");
    expect(h.backends[0]?.name).toBe("kitty");
  });

  it("still enforces every non-enum constraint", () => {
    expect(() => parseInnerLoose({ type: "sessions", list: [session("zsh", "")] })).toThrow();
    expect(() => parseInnerLoose({ type: "event", sessionId: "", kind: "bell", at: 1 })).toThrow();
    expect(() => parseInnerLoose({ type: "input.line", sessionId: "s", text: "x" })).toThrow();
    expect(() => parseInnerLoose({ type: "not-a-message" })).toThrow(/malformed/);
  });

  it("is identical to the strict parser for known values", () => {
    const msg = { type: "sessions", list: [session("tmux", "blocked")] };
    expect(parseInnerLoose(msg)).toEqual(parseInner(msg));
  });

  it("loosens notify.kind only, on the ctrl side", () => {
    const n = { type: "notify", sessionId: "tmux:%1", kind: "bell" };
    expect(parseCtrlLoose(n)).toMatchObject({ kind: "bell" });
    expect(() => parseCtrl(n)).toThrow(/malformed/);
    expect(() => parseCtrlLoose({ type: "auth-fail", reason: "brand-new" })).toThrow();
  });

  it("leaves the golden vectors byte-identical and passing", () => {
    const raw = readFileSync(new URL("./vectors.json", import.meta.url));
    // Record the hash printed by the first green run; it must never change again.
    expect(createHash("sha256").update(raw).digest("hex")).toBe("<PASTE_SHA256_ON_FIRST_RUN>");
    expect(runVectorChecks(vectors as Vectors).every((r) => r.ok)).toBe(true);
  });
});
```

- [ ] **Step 3: Implement `packages/protocol/src/loose.ts`**

```ts
import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { CtrlMessageSchema, EventKindSchema } from "./ctrl.js";
import {
  BackendNameSchema,
  CapabilitiesSchema,
  InnerMessageSchema,
  SessionInfoSchema,
  SessionStateSchema,
  SidSchema,
} from "./inner.js";

/**
 * Spec 10.6: a value a newer peer introduced must be opaque, not fatal. The union keeps the strict
 * member first so a known value still parses to its literal type; anything else falls through to a
 * bounded string. Every other constraint on the message is unchanged.
 */
const loose = <T extends z.ZodTypeAny>(strict: T) =>
  z.union([strict, z.string().min(1).max(32)]);

export const BackendNameLooseSchema = loose(BackendNameSchema);
export const SessionStateLooseSchema = loose(SessionStateSchema);
export const EventKindLooseSchema = loose(EventKindSchema);

export type BackendNameLoose = z.infer<typeof BackendNameLooseSchema>;
export type SessionStateLoose = z.infer<typeof SessionStateLooseSchema>;
export type EventKindLoose = z.infer<typeof EventKindLooseSchema>;

export const SessionInfoLooseSchema = SessionInfoSchema.extend({
  backend: BackendNameLooseSchema,
  state: SessionStateLooseSchema,
});
export type SessionInfoLoose = z.infer<typeof SessionInfoLooseSchema>;

/** The only three inner messages that carry one of the three loosened enums. */
const LOOSE_INNER = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    agentVersion: z.string().max(32),
    backends: z
      .array(z.object({ name: BackendNameLooseSchema, capabilities: CapabilitiesSchema }))
      .max(4),
    computerName: z.string().max(64),
    accent: z.string().max(32),
  }),
  z.object({ type: z.literal("sessions"), list: z.array(SessionInfoLooseSchema).max(500) }),
  z.object({
    type: z.literal("event"),
    sessionId: SidSchema,
    kind: EventKindLooseSchema,
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    command: z.string().max(512).optional(),
    at: z.number(),
  }),
]);

const LOOSE_INNER_TYPES: ReadonlySet<string> = new Set(["hello", "sessions", "event"]);

export type InnerMessageLoose =
  | Exclude<z.infer<typeof InnerMessageSchema>, { type: "hello" | "sessions" | "event" }>
  | z.infer<typeof LOOSE_INNER>;
export type InnerMessageLooseOf<T extends InnerMessageLoose["type"]> = Extract<
  InnerMessageLoose,
  { type: T }
>;

function typeOf(u: unknown): string | undefined {
  const t = (u as { type?: unknown } | null | undefined)?.type;
  return typeof t === "string" ? t : undefined;
}

export function parseInnerLoose(u: unknown): InnerMessageLoose {
  const t = typeOf(u);
  const schema = t !== undefined && LOOSE_INNER_TYPES.has(t) ? LOOSE_INNER : InnerMessageSchema;
  const r = schema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${z.prettifyError(r.error)}`);
  return r.data as InnerMessageLoose;
}

/**
 * `notify` is agent -> relay only, so the phone never sees it; the loose form exists so every
 * consumer of `EventKind` has a loose counterpart. `auth-fail.reason` and `pairing-reject.reason`
 * stay strict (R54 ruling 1 names three enums) — an unknown reason therefore still throws, and the
 * phone's handlers already fall back to a generic message. Recorded as a known limitation.
 */
const LOOSE_NOTIFY = z.object({
  type: z.literal("notify"),
  sessionId: SidSchema,
  kind: EventKindLooseSchema,
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export type CtrlMessageLoose =
  | Exclude<z.infer<typeof CtrlMessageSchema>, { type: "notify" }>
  | z.infer<typeof LOOSE_NOTIFY>;

export function parseCtrlLoose(u: unknown): CtrlMessageLoose {
  const schema = typeOf(u) === "notify" ? LOOSE_NOTIFY : CtrlMessageSchema;
  const r = schema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `ctrl: ${z.prettifyError(r.error)}`);
  return r.data as CtrlMessageLoose;
}
```

- [ ] **Step 4: Verify**

```bash
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/protocol test
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/relay test
perl -e 'alarm 600; exec @ARGV' -- pnpm -F shellbell test
```

All three must be green: the relay and agent still use `parseInner`/`parseCtrl`, so their tests are
the proof the refactor in Step 1 changed nothing. Paste the printed `vectors.json` SHA-256 into the
test, re-run, then run the root verify gate.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): loose enum parsers so an older app tolerates a newer agent"
```

---

### Task 1: Scaffold the Expo app in the monorepo (spec 10.1, 10.2, 16)

**Files:**
- Create: `apps/mobile/*` via `create-expo-app`, then edit `package.json`, `app.json`,
  `metro.config.js`, `babel.config.js`, `tsconfig.json`, `eas.json`, `vitest.config.ts`,
  `expo-env.d.ts`, `.gitignore`; create the crypto bootstrap, theme tokens, and **placeholder route
  files** for every route the root layout declares.
- Modify: `.github/workflows/ci.yml`.

- [ ] **Step 1: Create the app** — **[HUMAN]** (network + may prompt)

Run from the repo root. `apps/mobile` must not already exist.

```bash
npx create-expo-app@latest apps/mobile --template blank-typescript --no-install
cd apps/mobile
npx expo install expo-router expo-linking expo-constants expo-status-bar expo-splash-screen \
  react-native-safe-area-context react-native-screens \
  react-native-reanimated react-native-worklets react-native-gesture-handler @shopify/flash-list \
  expo-secure-store expo-sqlite expo-camera expo-notifications expo-haptics expo-clipboard \
  expo-keep-awake expo-glass-effect expo-crypto expo-dev-client expo-device expo-font
pnpm add zustand@5.0.15 @shellbell/protocol@workspace:*
pnpm add -D vitest@5.0.0 typescript@5.9.3 ws@8.21.3 @types/ws@8.18.1 @types/node@26.4.1
```

`@types/node` is required: `test/connection.test.ts` imports the agent's Node-only fakes (Task 4).
`expo-splash-screen` is required by the font-gated splash in Task 6.

- [ ] **Step 2: `package.json` — name, entry point, scripts**

Three edits that the template does not make and without which **the app does not boot**:

1. `"name": "@shellbell/mobile"` (the template names it `mobile`; CI filters on this name).
2. `"main": "expo-router/entry"` — expo-router does not mount without it.
3. Delete the template's `App.tsx` **and** `index.ts` (`git rm` them if they were committed).

Scripts:

```json
{
  "scripts": {
    "start": "expo start --dev-client",
    "test": "pnpm run sync:vectors && vitest run",
    "typecheck": "tsc --noEmit",
    "doctor": "expo-doctor",
    "sync:vectors": "node scripts/sync-vectors.mjs",
    "check:vectors": "node scripts/sync-vectors.mjs --check",
    "export:check": "expo export --platform android --output-dir .expo/export-check"
  }
}
```

Add `expo-doctor` as a devDependency (`pnpm add -D expo-doctor`) rather than shelling out to `npx`
in CI, so CI does not fetch a package on every run.

`"start"` and `"export:check"` are **never** run by an agent outside the bounded Step 6 check.

- [ ] **Step 3: Configuration files**

`apps/mobile/app.json`:

```json
{
  "expo": {
    "name": "Shellbell",
    "slug": "shellbell",
    "scheme": "shellbell",
    "version": "0.1.0",
    "orientation": "portrait",
    "userInterfaceStyle": "dark",
    "backgroundColor": "#000000",
    "newArchEnabled": true,
    "ios": {
      "bundleIdentifier": "dev.bilalahmad.shellbell",
      "supportsTablet": true,
      "infoPlist": {
        "NSCameraUsageDescription": "Scan the pairing QR shown by your computer."
      }
    },
    "android": {
      "package": "dev.bilalahmad.shellbell",
      "permissions": ["CAMERA", "VIBRATE"]
    },
    "plugins": [
      "expo-router",
      ["expo-camera", { "cameraPermission": "Scan the pairing QR shown by your computer." }],
      "expo-secure-store",
      ["expo-notifications", { "color": "#10B981" }],
      [
        "expo-font",
        {
          "fonts": [
            "./assets/fonts/JetBrainsMonoNerdFont-Regular.ttf",
            "./assets/fonts/JetBrainsMonoNerdFont-Bold.ttf",
            "./assets/fonts/JetBrainsMonoNerdFont-Italic.ttf",
            "./assets/fonts/JetBrainsMonoNerdFont-BoldItalic.ttf"
          ]
        }
      ]
    ],
    "extra": { "eas": { "projectId": "REPLACE_AFTER_eas_init" } }
  }
}
```

`extra.eas.projectId` stays a placeholder for all of Plan 05. Nothing in this plan reads it; `eas
init` is Plan 06 and is **[HUMAN]**. `eas.json` below is likewise inert until Plan 06.

`apps/mobile/metro.config.js` — the workspace wiring **and** the `@shellbell/protocol` resolution
shim. The protocol package is published as raw TypeScript (`"exports": { ".": "./src/index.ts" }`,
no build step) and every internal import is written with a `.js` suffix (`./bytes.js`,
`./crypto.js`, …) for TypeScript's NodeNext-style resolution. tsx, vitest and esbuild map those to
`.ts`; **Metro's default resolver does not**, and the failure mode is an opaque
`Unable to resolve "./bytes.js"`. This shim removes the ambiguity:

```js
const { getDefaultConfig } = require("expo/metro-config");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const protocolSrc = path.resolve(workspaceRoot, "packages/protocol/src");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const upstream = config.resolver.resolveRequest;
const fallback = (context, moduleName, platform) =>
  upstream
    ? upstream(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // The package root: pin it to the TypeScript entry so Metro never guesses.
  if (moduleName === "@shellbell/protocol") {
    return { type: "sourceFile", filePath: path.join(protocolSrc, "index.ts") };
  }
  // Relative ".js" specifiers written inside packages/protocol/src resolve to their ".ts" source.
  const origin = context.originModulePath ?? "";
  const insideProtocol = origin.startsWith(protocolSrc + path.sep);
  if (insideProtocol && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const candidate = path.resolve(path.dirname(origin), moduleName.slice(0, -3) + ".ts");
    if (fs.existsSync(candidate)) {
      return { type: "sourceFile", filePath: candidate };
    }
  }
  return fallback(context, moduleName, platform);
};

module.exports = config;
```

`apps/mobile/babel.config.js`:

```js
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"], plugins: ["react-native-worklets/plugin"] };
};
```

If `expo-doctor` or Metro reports the worklets plugin under a different name, or reports it as a
**duplicate** (SDK 57's `babel-preset-expo` may already inject it when Reanimated is installed), use
the name it prints or drop the manual entry entirely.

`apps/mobile/expo-env.d.ts` — **committed**, not generated. The Expo template gitignores this file;
without it `__DEV__` and the Expo ambient types are missing and the repo-root `pnpm typecheck`
fails on a clean checkout.

```ts
/// <reference types="expo/types" />
```

Remove `expo-env.d.ts` from `apps/mobile/.gitignore`. Keep the template's other entries
(`.expo/`, `dist/`, `node_modules/`, `ios/`, `android/`) so `expo prebuild` output never reaches
Biome or git.

`apps/mobile/tsconfig.json`:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

No `paths` alias: nothing in this plan imports through `@/`, and an alias declared here but absent
from `vitest.config.ts` silently breaks the first person who uses it. `types` is deliberately left
unset so the hoisted `@types/node`, `@types/ws` and `@types/react` are all picked up — this is what
lets `test/connection.test.ts` typecheck while importing the agent's Node-only fakes.

`apps/mobile/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 15_000 },
});
```

`apps/mobile/eas.json` (inert until Plan 06):

```json
{
  "cli": { "version": ">= 16.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": {}
  },
  "submit": { "production": {} }
}
```

- [ ] **Step 4: Golden-vector sync script**

The on-device self-test (Task 3) needs `packages/protocol/test/vectors.json` inside the Metro
bundle. The package's `exports` map exposes only `"."`, so `@shellbell/protocol/test/vectors.json`
is not importable. Copy it, commit the copy, and make CI fail if it drifts.

`apps/mobile/scripts/sync-vectors.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../../packages/protocol/test/vectors.json");
const dest = resolve(here, "../src/util/vectors.json");
const wanted = readFileSync(src, "utf8");

if (process.argv.includes("--check")) {
  const have = readFileSync(dest, "utf8");
  if (have !== wanted) {
    console.error("src/util/vectors.json is stale; run: pnpm -F @shellbell/mobile sync:vectors");
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(dest, wanted);
```

Run it once now so `src/util/vectors.json` exists and is committed. `pnpm test` runs it first (see
the `test` script), and CI runs `check:vectors`.

- [ ] **Step 5: Crypto bootstrap, tokens, fonts, and placeholder routes**

`apps/mobile/src/bootstrap/crypto.ts` (exactly spec 10.7):

```ts
import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  g.crypto.getRandomValues = getRandomValues as unknown;
}
const probe = new Uint8Array(8);
(g.crypto.getRandomValues as (a: Uint8Array) => Uint8Array)(probe);
if (probe.every((b) => b === 0)) throw new Error("secure randomness unavailable");
```

`apps/mobile/src/theme/tokens.ts`: the object from spec 10.9 exported as `tokens` (`bg`, `surface`,
`surface2`, `border`, `text`, `textMuted`, `textFaint`, `accents`, `terminal16`, `radius`, `space`),
plus:

```ts
export const FONT = {
  regular: "JetBrainsMonoNerdFont-Regular",
  bold: "JetBrainsMonoNerdFont-Bold",
  italic: "JetBrainsMonoNerdFont-Italic",
  boldItalic: "JetBrainsMonoNerdFont-BoldItalic",
} as const;
```

**[HUMAN]** Download `JetBrainsMonoNerdFont-{Regular,Bold,Italic,BoldItalic}.ttf` from a pinned Nerd
Fonts release (`JetBrainsMono.zip`) into `apps/mobile/assets/fonts/`. Record the release tag and the
SHA-256 of each TTF in `apps/mobile/assets/fonts/README.md`, and add the OFL 1.1 text as
`apps/mobile/assets/fonts/LICENSE` (spec 10.5 calls the font OFL; shipping it without the licence is
a licence violation). ~8 MB enters the repo.

`apps/mobile/app/_layout.tsx` (initial; grows in Task 6):

```tsx
import "../src/bootstrap/crypto";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { tokens } from "../src/theme/tokens";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: tokens.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: tokens.bg },
          headerTintColor: tokens.text,
          contentStyle: { backgroundColor: tokens.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Computers" }} />
        <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
```

Every route named in a `Stack.Screen` must exist from this task onward, or expo-router warns and the
Step 6 verify cannot pass. Create all three now:

- `app/index.tsx` — a centred `Text` "Shellbell" (replaced in Task 6).
- `app/pair.tsx` — a centred `Text` "Pair (Task 5)" (replaced in Task 5).
- `app/settings.tsx` — a centred `Text` "Settings (Task 8)" with a `ScrollView` wrapper; Task 3 adds
  the self-test section, Task 8 fills it in.

- [ ] **Step 6: Verify — headless, bounded, no device**

```bash
cd /Users/bilal/workspace/miambi/shellbell
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/mobile check:vectors
perl -e 'alarm 300; exec @ARGV' -- pnpm -F @shellbell/mobile doctor
perl -e 'alarm 300; exec @ARGV' -- pnpm lint:fix
perl -e 'alarm 300; exec @ARGV' -- pnpm lint
perl -e 'alarm 300; exec @ARGV' -- pnpm typecheck
```

Then prove the Metro shim actually resolves `@shellbell/protocol`, without a device or an account:

```bash
# 1. Node-side proof that the package root and its .js specifiers load at all.
cat > /tmp/protocol-smoke.mjs <<'JS'
import * as m from "@shellbell/protocol";
if (typeof m.parseInnerLoose !== "function") throw new Error("parseInnerLoose missing");
if (typeof m.deriveConnKey !== "function") throw new Error("deriveConnKey missing");
console.log("protocol ok");
JS
perl -e 'alarm 120; exec @ARGV' -- npx tsx /tmp/protocol-smoke.mjs

# 2. Metro-side proof: a full production bundle, then grep it for a protocol-only symbol.
perl -e 'alarm 600; exec @ARGV' -- pnpm -F @shellbell/mobile export:check
grep -rqs "shellbell-conn-v1" apps/mobile/.expo/export-check && echo "metro resolved protocol"
rm -rf apps/mobile/.expo/export-check
```

`expo export` bundles locally and needs **no Expo account and no EAS project**; the placeholder
`extra.eas.projectId` is not read because `updates` is not configured. It does resolve packages from
the already-installed `node_modules`, so no further network access beyond the Step 1 install. If a
future SDK makes `expo export` contact an Expo service, it fails with an explicit message — at that
point this step becomes **[HUMAN]** and the `npx tsx` check above is the agent-runnable substitute.

If the bundle fails to resolve `./bytes.js`, the shim is wrong — fix `metro.config.js`; do **not**
work around it by editing `packages/protocol`.

**[HUMAN]** Separately, on a device or simulator: `npx expo run:ios` — the app boots to the
placeholder with no red box and the console shows no "secure randomness unavailable" error. An agent
never runs this.

- [ ] **Step 7: CI**

Add to `.github/workflows/ci.yml`, after `pnpm install`:

```yaml
      - run: pnpm -F @shellbell/mobile check:vectors
      - run: pnpm -F @shellbell/mobile doctor
```

The existing root `pnpm lint` / `pnpm typecheck` / `pnpm test` steps already cover `apps/mobile`
(`pnpm -r --if-present`). All mobile tests are Node-only — no simulator is needed on `macos-15`, and
`jest-expo` is deliberately not used (spec 15: "vitest for pure logic; component tests minimal").

- [ ] **Step 8: Commit**

```bash
git add apps/mobile .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(mobile): expo scaffold with metro protocol shim, crypto bootstrap and fonts"
```

---

### Task 2: Render spike (spec 10.5, 18.3)

**Files:**
- Create: `apps/mobile/src/screen/LineView.tsx`, `apps/mobile/src/util/fixtures.ts`,
  `apps/mobile/app/dev/render-spike.tsx`, `docs/spike-render.md`
- Modify: `apps/mobile/app/settings.tsx` (dev-only link), `apps/mobile/app/_layout.tsx`
  (register `dev/render-spike`)

**Interfaces:**
- `LineView({ line, fontSize })` — memoized; nested-`Text` path when no run has `n`, fixed-width
  `View` path otherwise (spec 10.5). Run keys are content-derived cell offsets, never array indices.
- `fixtures.ts`: `htopScreen(rows?, cols?): Line[]`, `cjkLines(): Line[]`, `logLines(n): Line[]`.

- [ ] **Step 1: `LineView`**

`apps/mobile/src/screen/LineView.tsx`:

```tsx
import { codePoints, colorKey, colorToHex, type Line, type Run } from "@shellbell/protocol";
import { memo } from "react";
import { Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";

/** Flip to true only if the on-device spike (Step 3) shows the nested-Text path dropping frames. */
export const ALWAYS_FIXED_WIDTH = false;

export function fontFor(r: Run): string {
  if (r.b && r.i) return FONT.boldItalic;
  if (r.b) return FONT.bold;
  if (r.i) return FONT.italic;
  return FONT.regular;
}

function decoration(r: Run) {
  if (r.u && r.s) return "underline line-through" as const;
  if (r.u) return "underline" as const;
  if (r.s) return "line-through" as const;
  return "none" as const;
}

function runStyle(r: Run, fontSize: number) {
  return {
    fontFamily: fontFor(r),
    fontSize,
    color: colorToHex(r.fg, tokens.text, tokens.terminal16),
    backgroundColor:
      r.bg === undefined ? "transparent" : colorToHex(r.bg, "transparent", tokens.terminal16),
    textDecorationLine: decoration(r),
    opacity: r.f ? 0.6 : 1,
  };
}

/**
 * Keys are the run's starting cell offset plus its style signature: unique within the line, stable
 * across re-renders, and content-derived rather than an array index (Biome noArrayIndexKey).
 */
function keyedRuns(line: Line): { r: Run; key: string; cells: number }[] {
  let col = 0;
  return line.r.map((r) => {
    const cells = r.n ?? codePoints(r.t);
    const key = `${col}|${colorKey(r.fg)}|${colorKey(r.bg)}|${cells}`;
    col += cells;
    return { r, key, cells };
  });
}

export const LineView = memo(function LineView({
  line,
  fontSize,
}: {
  line: Line;
  fontSize: number;
}) {
  const lineHeight = fontSize * 1.25;
  const charWidth = fontSize * 0.6;
  if (line.r.length === 0) {
    return (
      <Text style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}> </Text>
    );
  }
  const runs = keyedRuns(line);
  const needsCells = ALWAYS_FIXED_WIDTH || line.r.some((r) => r.n !== undefined);
  if (!needsCells) {
    return (
      <Text
        numberOfLines={1}
        style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}
      >
        {runs.map(({ r, key }) => (
          <Text key={key} style={runStyle(r, fontSize)}>
            {r.t}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <View style={{ flexDirection: "row", height: lineHeight }}>
      {runs.map(({ r, key, cells }) => {
        const style = runStyle(r, fontSize);
        return (
          <View
            key={key}
            style={{
              width: cells * charWidth,
              overflow: "hidden",
              backgroundColor: style.backgroundColor,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ ...style, backgroundColor: "transparent", lineHeight }}
            >
              {r.t}
            </Text>
          </View>
        );
      })}
    </View>
  );
});
```

- [ ] **Step 2: Fixtures and spike screen**

`apps/mobile/src/util/fixtures.ts` — cell counts come from the protocol's `stringCells`, never from
hand-counting; a wrong `n` would silently invalidate the alignment measurement in Step 3.

```ts
import { type Line, type Run, stringCells } from "@shellbell/protocol";

/** Set `n` only when it differs from the code-point count, exactly as the agent does. */
function run(t: string, extra: Omit<Run, "t" | "n"> = {}): Run {
  const cells = stringCells(t);
  const points = Array.from(t).length;
  return cells === points ? { t, ...extra } : { t, ...extra, n: cells };
}

export function htopScreen(rows = 60, cols = 160): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const r: Run[] = [];
    for (let x = 0; x < cols; x += 8) {
      const v = (x * 7 + y * 13) % 100;
      r.push(
        run(`${String(v).padStart(3, " ")}% ▇▇▇`, {
          fg: v > 80 ? 1 : v > 50 ? 3 : 2,
          bg: y % 2 ? 0 : 8,
          b: v > 80,
        }),
      );
    }
    out.push({ r });
  }
  return out;
}

export function cjkLines(): Line[] {
  return [
    { r: [run("漢字とカナ mixed with ascii")] },
    { r: [run("🚀 deploy ✅ done 👨‍💻")] },
    { r: [run("café naïve résumé")] },
    { r: [run("├── src/  "), run("main.rs", { fg: 4 })] },
  ];
}

export function logLines(n: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    const err = i % 17 === 0;
    out.push({
      r: [
        run(`${String(i).padStart(5, "0")} `, { f: true }),
        run(err ? "ERROR" : "info", { fg: err ? 1 : 2, b: err }),
        run(` request ${i} handled in ${(i * 37) % 900}ms`),
      ],
    });
  }
  return out;
}
```

`apps/mobile/test/backends.test.ts` gets a fixture guard alongside the Task 6 label tests:

```ts
import { stringCells } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { cjkLines } from "../src/util/fixtures.js";

describe("cjk fixture", () => {
  it("declares cell widths that match stringCells", () => {
    for (const line of cjkLines()) {
      for (const r of line.r) {
        expect(r.n ?? Array.from(r.t).length).toBe(stringCells(r.t));
      }
    }
  });
});
```

`apps/mobile/app/dev/render-spike.tsx` — note `contentContainerStyle={{ flexGrow: 1 }}` on the
horizontal `ScrollView`: without it the `FlashList` inside has no bounded height, renders nothing,
and the whole spike measures a blank screen.

```tsx
import { FlashList } from "@shopify/flash-list";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { LineView } from "../../src/screen/LineView";
import { tokens } from "../../src/theme/tokens";
import { cjkLines, htopScreen, logLines } from "../../src/util/fixtures";

const SETS = { htop: htopScreen(), cjk: cjkLines(), log: logLines(5000) };
const FONT_SIZE = 12;
const CONTENT_WIDTH = 160 * FONT_SIZE * 0.6 + 16;

export default function RenderSpike() {
  const [which, setWhich] = useState<keyof typeof SETS>("log");
  const [tick, setTick] = useState(0);
  const { width } = useWindowDimensions();
  const data = useMemo(() => {
    if (which !== "htop") return SETS[which];
    return SETS.htop.map((l, i) =>
      i === tick % SETS.htop.length ? { r: [{ t: `tick ${tick}`, fg: 5 as const }] } : l,
    );
  }, [which, tick]);
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        {(Object.keys(SETS) as (keyof typeof SETS)[]).map((k) => (
          <Pressable
            key={k}
            onPress={() => setWhich(k)}
            style={{
              padding: 8,
              backgroundColor: which === k ? tokens.accents.emerald : tokens.surface2,
              borderRadius: tokens.radius.sm,
            }}
          >
            <Text style={{ color: tokens.text }}>{k}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setTick((t) => t + 1)}
          style={{ padding: 8, backgroundColor: tokens.surface2, borderRadius: tokens.radius.sm }}
        >
          <Text style={{ color: tokens.text }}>redraw</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        bounces={false}
        contentContainerStyle={{ flexGrow: 1, width: Math.max(width, CONTENT_WIDTH) }}
      >
        <View style={{ flex: 1, width: Math.max(width, CONTENT_WIDTH) }}>
          <FlashList
            data={data}
            keyExtractor={(item, i) => `${i}:${item.r[0]?.t ?? ""}`}
            renderItem={({ item }) => <LineView line={item} fontSize={FONT_SIZE} />}
          />
        </View>
      </ScrollView>
    </View>
  );
}
```

Register `<Stack.Screen name="dev/render-spike" options={{ title: "Render spike" }} />` in
`app/_layout.tsx`, and add a `__DEV__`-only link to it from the `app/settings.tsx` placeholder
created in Task 1.

- [ ] **Step 3: Measure on real devices and record** — **[HUMAN]**

An agent must not run this step, and must not write numbers into `docs/spike-render.md`.

On an iPhone and an Android phone (development build): fling the 5 000-line log with the
Xcode/Android Studio frame profiler or Expo's perf monitor; tap `redraw` repeatedly on `htop`;
inspect the `cjk` lines for column alignment against a ruler of ASCII text.

`docs/spike-render.md` ships as a template with the placeholders unfilled:

```markdown
# Spike: terminal rendering on device — results (YYYY-MM-DD)

- Devices: iPhone __ (iOS __), __ (Android __).
- 5 000-line log fling: iOS __ fps, Android __ fps (budget: no dropped frames).
- htop-like 60×160 redraw: __ ms per frame iOS / Android.
- CJK/emoji/combining alignment with the fixed-width View path: correct / off by __ cells.
- Decision: nested-Text path for lines without `n` (default) | fixed-width View path for all lines.
```

If the log fling drops frames, set `ALWAYS_FIXED_WIDTH = true` in `LineView.tsx` and re-measure;
record the outcome.

- [ ] **Step 4: Verify and commit**

Run the verify gate. `pnpm test` must include the new `cjk fixture` case.

```bash
git add apps/mobile docs/spike-render.md
git commit -m "feat(mobile): LineView with cell-accurate path and on-device render spike"
```

---

### Task 3: Identity, secure storage, stores, screen helpers, self-test (spec 6.2, 6.3, 10.3, 10.7)

**Files:**
- Create: `apps/mobile/src/identity/keys.ts`, `apps/mobile/src/store/computers.ts`,
  `apps/mobile/src/store/connections.ts`, `apps/mobile/src/store/screen.ts`,
  `apps/mobile/src/util/routes.ts`, `apps/mobile/test/screen.test.ts`,
  `apps/mobile/test/routes.test.ts`
- Modify: `apps/mobile/app/settings.tsx` (self-test section)

**Interfaces:**
- `identity/keys.ts`: `loadOrCreateIdentity(): Promise<{ identity: Identity; fp: string }>`,
  `savePairSecret(computerFp, PairSecret)`, `loadPairSecret(computerFp): Promise<PairSecret | null>`,
  `deletePairSecret(computerFp)`. Uses `expo-secure-store`.
- `store/computers.ts`:
  `Computer = { fp; name; accent; relayUrl; pairedAt; lastSeenAt: string | null; pushEnabled }`,
  `useComputersStore` with `computers`, `add`, `remove`, `update`, `hydrate()`; `useUiStore` with
  `fontSize` (12), `fitWidth`, `rawModeBySession`, setters.
- `store/screen.ts` (RN-free): `KeyedLine = Line & { key: string }`,
  `ViewState = { state: ScreenState; keyed: KeyedLine[] }`, `applySnapshotKeyed`, `applyDiffKeyed`,
  `prependHistoryKeyed`. Keys are `k<counter>`; unchanged lines keep their key.
- `store/connections.ts` (zustand, in-memory), per computer:
  `{ status; agentOnline; error?; hello?; sessions; view?; oldestAvailable; events; unread;
  pendingInputs; history; toast? }` with reducer-style setters used by `ComputerConnection`.
- `util/routes.ts`: `sidToRoute(sid)` (base64url of utf8), `sidFromRoute(s)`.

- [ ] **Step 1: Tests for the RN-free parts**

`apps/mobile/test/screen.test.ts`:

```ts
import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../src/store/screen.js";

const L = (t: string): Line => ({ r: [{ t }] });
const snap = (lines: Line[], scrollbackTotal: number, gen: number) => ({
  cols: 10,
  rows: lines.length,
  cursor: { x: 0, y: 0 },
  lines,
  scrollbackTotal,
  gen,
});

describe("keyed screen state", () => {
  it("keeps keys for unchanged rows and moves scrolled-out rows to history", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("a"), L("b"), L("c")], 0, 1));
    const keys1 = v1.keyed.map((k) => k.key);
    const r = applyDiffKeyed(v1, {
      scroll: 1,
      changed: [{ i: 2, line: L("d") }],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 1,
      gen: 2,
    });
    expect(r.gap).toBe(false);
    expect(r.view.keyed.map((k) => k.r[0]?.t)).toEqual(["a", "b", "c", "d"]);
    expect(r.view.keyed.slice(0, 3).map((k) => k.key)).toEqual(keys1);
    expect(r.view.keyed[3]?.key).not.toBe(keys1[2]);
  });

  it("returns the same view and gap=true when gen jumps", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("a")], 0, 1));
    const r = applyDiffKeyed(v1, {
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 0,
      gen: 9,
    });
    expect(r).toEqual({ view: v1, gap: true });
  });

  it("prepends history pages and moves historyFrom back", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 5, 1));
    const v2 = prependHistoryKeyed(v1, [L("x"), L("y")], 5);
    expect(v2.keyed.map((k) => k.r[0]?.t)).toEqual(["x", "y", "z"]);
    expect(v2.state.historyFrom).toBe(3);
  });

  it("ignores a history page whose `before` no longer matches", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 5, 1));
    expect(prependHistoryKeyed(v1, [L("x")], 4)).toBe(v1);
  });

  it("caps prepended history at HISTORY_CAP", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 6000, 1));
    const page = Array.from({ length: 200 }, (_, i) => L(`h${i}`));
    let v = v1;
    let before = 6000;
    for (let i = 0; i < 30; i++) {
      v = prependHistoryKeyed(v, page, before);
      before -= 200;
    }
    expect(v.state.history.length).toBeLessThanOrEqual(5000);
    expect(v.keyed.length).toBe(v.state.history.length + v.state.lines.length);
  });
});
```

`apps/mobile/test/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sidFromRoute, sidToRoute } from "../src/util/routes.js";

describe("routes", () => {
  it("round-trips ids with % and :", () => {
    for (const id of ["tmux:%3", "iterm2:5A7B-1234", "tmux:$0", "herdr:term_abc"]) {
      expect(sidToRoute(id)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sidFromRoute(sidToRoute(id))).toBe(id);
    }
  });
});
```

- [ ] **Step 2: Implement**

`apps/mobile/src/util/routes.ts`:

```ts
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "@shellbell/protocol";

export const sidToRoute = (sid: string): string => toBase64Url(utf8(sid));
export const sidFromRoute = (s: string): string => fromUtf8(fromBase64Url(s));
```

`apps/mobile/src/store/screen.ts`:

```ts
import {
  applyDiff,
  applySnapshot,
  HISTORY_CAP,
  type Line,
  type ScreenDiff,
  type ScreenSnapshot,
  type ScreenState,
} from "@shellbell/protocol";

export type KeyedLine = Line & { key: string };

export interface ViewState {
  state: ScreenState;
  /** history followed by screen rows — exactly the FlashList data array */
  keyed: KeyedLine[];
}

let counter = 0;
const nextKey = () => `k${++counter}`;

function withKey(line: Line, existing?: KeyedLine): KeyedLine {
  if (existing && existing.r === line.r) return existing;
  return { ...line, key: nextKey() };
}

export function applySnapshotKeyed(
  prev: ViewState | undefined,
  snap: ScreenSnapshot,
): ViewState {
  const state = applySnapshot(prev?.state, snap);
  const history = state.history.map((l, i) => withKey(l, prev?.keyed[i]));
  const screen = state.lines.map((l) => withKey(l));
  return { state, keyed: [...history, ...screen] };
}

export function applyDiffKeyed(
  prev: ViewState,
  diff: ScreenDiff,
): { view: ViewState; gap: boolean } {
  const { state, gap } = applyDiff(prev.state, diff);
  if (gap) return { view: prev, gap: true };
  const histLen = prev.state.history.length;
  const oldHist = prev.keyed.slice(0, histLen);
  const oldScreen = prev.keyed.slice(histLen);
  // Mirror applyDiff's clamp so a malformed `scroll` cannot desynchronise keys from lines.
  const scrolled = Math.min(diff.scroll, oldScreen.length);
  let newHist = [...oldHist, ...oldScreen.slice(0, scrolled)];
  const drop = newHist.length - state.history.length;
  if (drop > 0) newHist = newHist.slice(drop);
  const shifted = oldScreen.slice(scrolled);
  const changed = new Set(diff.changed.map((c) => c.i));
  const screen = state.lines.map((line, i) =>
    changed.has(i) ? withKey(line) : (shifted[i] ?? withKey(line)),
  );
  return { view: { state, keyed: [...newHist, ...screen] }, gap: false };
}

/**
 * Prepend one `history` page. Returns `prev` unchanged when the page no longer lines up with the
 * current `historyFrom` (a stale response). Caps at HISTORY_CAP from the *oldest* end, matching
 * applyDiff, so the newest context is never dropped.
 */
export function prependHistoryKeyed(
  prev: ViewState,
  lines: Line[],
  before: number,
): ViewState {
  if (before !== prev.state.historyFrom || lines.length === 0) return prev;
  const keyedNew = lines.map((l) => withKey(l));
  let history = [...lines, ...prev.state.history];
  let keyed = [...keyedNew, ...prev.keyed];
  let historyFrom = prev.state.historyFrom - lines.length;
  const overflow = history.length - HISTORY_CAP;
  if (overflow > 0) {
    history = history.slice(overflow);
    keyed = keyed.slice(overflow);
    historyFrom += overflow;
  }
  return { state: { ...prev.state, history, historyFrom }, keyed };
}
```

`apps/mobile/src/identity/keys.ts`:

```ts
import {
  fingerprint,
  fromBase64Url,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
  toBase64Url,
} from "@shellbell/protocol";
import * as SecureStore from "expo-secure-store";

const ID_KEY = "shellbell.identity.v1";
const pairKey = (fp: string) => `shellbell.pair.${fp}`;

export async function loadOrCreateIdentity(): Promise<{ identity: Identity; fp: string }> {
  const raw = await SecureStore.getItemAsync(ID_KEY);
  let identity: Identity;
  if (raw) {
    identity = identityFromJson(JSON.parse(raw));
  } else {
    identity = generateIdentity();
    await SecureStore.setItemAsync(ID_KEY, JSON.stringify(identityToJson(identity)));
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}

export interface PairSecret {
  kPair: Uint8Array;
  computerEd25519Pub: Uint8Array;
  computerX25519Pub: Uint8Array;
}

export async function savePairSecret(computerFp: string, s: PairSecret): Promise<void> {
  const json = JSON.stringify({
    kPair: toBase64Url(s.kPair),
    e: toBase64Url(s.computerEd25519Pub),
    x: toBase64Url(s.computerX25519Pub),
  });
  await SecureStore.setItemAsync(pairKey(computerFp), json);
}

export async function loadPairSecret(computerFp: string): Promise<PairSecret | null> {
  const raw = await SecureStore.getItemAsync(pairKey(computerFp));
  if (!raw) return null;
  const j = JSON.parse(raw) as { kPair: string; e: string; x: string };
  return {
    kPair: fromBase64Url(j.kPair),
    computerEd25519Pub: fromBase64Url(j.e),
    computerX25519Pub: fromBase64Url(j.x),
  };
}

export async function deletePairSecret(computerFp: string): Promise<void> {
  await SecureStore.deleteItemAsync(pairKey(computerFp));
}
```

`apps/mobile/src/store/computers.ts`:

```ts
import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";

export interface Computer {
  fp: string;
  name: string;
  accent: string;
  relayUrl: string;
  pairedAt: string;
  lastSeenAt: string | null;
  pushEnabled: boolean;
}

const KEY = "shellbell.computers.v1";
const UI_KEY = "shellbell.ui.v1";

interface ComputersState {
  computers: Computer[];
  hydrated: boolean;
  hydrate: () => void;
  add: (c: Computer) => void;
  remove: (fp: string) => void;
  update: (fp: string, patch: Partial<Computer>) => void;
}

function persist(list: Computer[]) {
  Storage.setItemSync(KEY, JSON.stringify(list));
}

export const useComputersStore = create<ComputersState>((set, get) => ({
  computers: [],
  hydrated: false,
  hydrate: () => {
    const raw = Storage.getItemSync(KEY);
    set({ computers: raw ? (JSON.parse(raw) as Computer[]) : [], hydrated: true });
  },
  add: (c) => {
    const list = [...get().computers.filter((x) => x.fp !== c.fp), c];
    persist(list);
    set({ computers: list });
  },
  remove: (fp) => {
    const list = get().computers.filter((x) => x.fp !== fp);
    persist(list);
    set({ computers: list });
  },
  update: (fp, patch) => {
    const list = get().computers.map((x) => (x.fp === fp ? { ...x, ...patch } : x));
    persist(list);
    set({ computers: list });
  },
}));

interface UiState {
  fontSize: number;
  fitWidth: boolean;
  rawModeBySession: Record<string, boolean>;
  setFontSize: (n: number) => void;
  setFitWidth: (b: boolean) => void;
  setRawMode: (sid: string, b: boolean) => void;
}

const uiRaw = Storage.getItemSync(UI_KEY);
const uiInit = uiRaw ? (JSON.parse(uiRaw) as Partial<UiState>) : {};

function persistUi(s: UiState) {
  Storage.setItemSync(
    UI_KEY,
    JSON.stringify({
      fontSize: s.fontSize,
      fitWidth: s.fitWidth,
      rawModeBySession: s.rawModeBySession,
    }),
  );
}

export const useUiStore = create<UiState>((set, get) => ({
  fontSize: uiInit.fontSize ?? 12,
  fitWidth: uiInit.fitWidth ?? false,
  rawModeBySession: uiInit.rawModeBySession ?? {},
  setFontSize: (n) => {
    set({ fontSize: Math.max(5, Math.min(24, n)) });
    persistUi(get());
  },
  setFitWidth: (b) => {
    set({ fitWidth: b });
    persistUi(get());
  },
  setRawMode: (sid, b) => {
    set({ rawModeBySession: { ...get().rawModeBySession, [sid]: b } });
    persistUi(get());
  },
}));
```

`apps/mobile/src/store/connections.ts` — **must stay free of any `expo-*`/`react-native` import**:
`src/net/connection.ts` imports `Status` from here and is unit-tested in Node.

```ts
import type { InnerMessageLooseOf, SessionInfoLoose } from "@shellbell/protocol";
import { create } from "zustand";
import type { ViewState } from "./screen";

export type Status =
  | "idle"
  | "connecting"
  | "auth"
  | "handshake"
  | "online"
  | "offline"
  | "error";

/** Terminal error states: no reconnect will help until the user acts. */
export type ErrorKind = "unpaired" | "re-pair" | "superseded" | "rejected" | "relay";

export type SessionEvent = InnerMessageLooseOf<"event">;

export interface ComputerConn {
  status: Status;
  agentOnline: boolean;
  error?: ErrorKind;
  hello?: InnerMessageLooseOf<"hello">;
  sessions: SessionInfoLoose[];
  view?: { sessionId: string; view: ViewState };
  /** Oldest absolute line the agent still has, per session (from `history.oldestAvailable`). */
  oldestAvailable: Record<string, number>;
  events: Record<string, SessionEvent[]>;
  unread: Record<string, number>;
  pendingInputs: Record<string, { at: number; sessionId: string }>;
  history: string[];
  toast?: string;
}

const empty = (): ComputerConn => ({
  status: "idle",
  agentOnline: false,
  sessions: [],
  oldestAvailable: {},
  events: {},
  unread: {},
  pendingInputs: {},
  history: [],
});

interface ConnectionsState {
  byComputer: Record<string, ComputerConn>;
  read: (fp: string) => ComputerConn;
  patch: (fp: string, fn: (c: ComputerConn) => Partial<ComputerConn>) => void;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  byComputer: {},
  read: (fp) => get().byComputer[fp] ?? empty(),
  patch: (fp, fn) => {
    const cur = get().byComputer[fp] ?? empty();
    set({ byComputer: { ...get().byComputer, [fp]: { ...cur, ...fn(cur) } } });
  },
}));
```

(`read` rather than `get`: a store field literally named `get` shadows zustand's own `get` at a
glance and is a trap for the next reader.)

- [ ] **Step 3: On-device crypto self-test**

Extend the `app/settings.tsx` placeholder with a "Run crypto self-test" button that imports the
committed copy of the vectors and the root export of the checker:

```tsx
import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import vectors from "../src/util/vectors.json";

const results = runVectorChecks(vectors as Vectors);
```

Render one ✓/✗ row per result. `src/util/vectors.json` is produced and kept fresh by
`scripts/sync-vectors.mjs` (Task 1 Step 4); `pnpm test` regenerates it and CI's `check:vectors`
fails on drift. This is the Hermes proof of cross-runtime crypto.

- [ ] **Step 4: Verify and commit**

Run the verify gate.

```bash
git add apps/mobile
git commit -m "feat(mobile): identity storage, stores, keyed screen state, route ids"
```

---

### Task 4: `ComputerConnection` and `ConnectionManager` (spec 6.5, 6.6, 6.7, 10.4, 11.3, 12)

The lifecycle mirrors `apps/agent/src/relay-client.ts`. Read that file before writing this one.

**Files:**
- Create: `apps/mobile/src/net/connection.ts`, `apps/mobile/src/net/manager.ts`,
  `apps/mobile/test/connection.test.ts`
- Modify: `apps/agent/test/fakes/fake-relay.ts` (record phone ctrl so `lease` is observable)

**Interfaces:**
- `ConnectionOptions { computerFp; relayUrl; identity; phoneFp; phoneName; appVersion; kPair;
  pushToken?; onCtrl?; onInner: (m: InnerMessageLoose) => void; onStatus: (s, extra?) => void;
  WebSocketImpl?; backoffMinMs?; backoffMaxMs?; helloTimeoutMs? }`
- `class ComputerConnection`: `connect()`, `close(reason?: "background" | "user")` (sends `lease 0`
  first), `send(msg): boolean`, `request(msg & { reqId }): Promise<InnerMessageLooseOf<"ack">>`
  (rejects with `DeliveryUnknownError` on close), `subscribe(sessionId | null)`, `status`, `online`,
  `pendingReqIds()`, `newReqId()`.
- `ConnectionManager`: one `ComputerConnection` per computer, single-flight per fp; `start()`
  subscribes to `AppState`; `active` → connect all; `inactive`/`background` → close all with
  `"background"`; `get(fp)`; wires `onInner` into `useConnectionsStore`.

**Lifecycle rules (spec 12 + `relay-client.ts`):**

| Event | Action |
|---|---|
| `auth-fail` `bad-sig` / `fp-mismatch` | permanent: stop, `error: "rejected"` |
| `auth-fail` `not-paired` | permanent: stop, `error: "unpaired"` |
| `auth-fail` other (`no-agent`, `no-window`, `timeout`) | transient: normal backoff |
| close `4004` | permanent: stop, `error: "unpaired"` — the UI offers Remove / Re-pair |
| close `4005` | permanent: stop, `error: "superseded"` — another socket won; never race it |
| close `4400` / `4403` | permanent: stop, `error: "relay"` |
| close `4413` / `4429` | transient, but **do not reset the backoff** — reconnecting fast is what got us rate-limited |
| `K_pair` mismatch on `conn.hello` | permanent: stop, `error: "re-pair"` |
| any close with un-acked inputs | fail them with `DeliveryUnknownError`; the manager raises the "may not have been delivered" toast |

- [ ] **Step 1: Make `lease` observable in `FakeRelay`**

`apps/agent/test/fakes/fake-relay.ts` records only `ctrlFromAgent`; a phone's `lease`/`push-token`
ctrl is parsed and dropped, so "sends lease 0" is unassertable. Add a sibling array next to
`ctrlFromAgent` (additive; no existing agent test changes):

```ts
  /** Ctrl messages received from `role: "phone"` sockets, in arrival order. */
  ctrlFromPhones: { fp: string; msg: CtrlMessage }[] = [];
```

and, in the ctrl branch of the message handler, alongside the existing agent case:

```ts
          } else if (peer.role === "phone") {
            this.ctrlFromPhones.push({ fp: peer.fp, msg });
          } else if (peer.role === "pairing" && msg.type === "pairing-request" && this.agent) {
```

Run `pnpm -F shellbell test` — the agent suite must stay green.

- [ ] **Step 2: Write the failing tests**

`apps/mobile/test/connection.test.ts`. The shared setup is a helper, not three copy-pasted literals.

```ts
import {
  fingerprint,
  generateIdentity,
  type Identity,
  type InnerMessageLoose,
  randomBytes,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../../agent/src/log.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { ComputerConnection, type ConnectionOptions } from "../src/net/connection.js";
import type { Status } from "../src/store/connections.js";

const waitFor = (fn: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });

/** Minimal "agent" on the fake relay: authenticates, answers conn.hello, acks every reqId. */
async function fakeAgent(relay: FakeRelay, mac: Identity, kPair: Uint8Array, phoneFp: string) {
  const fp = fingerprint(mac.ed25519.pub);
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity: mac,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  let link: PhoneLink | null = null;
  const received: InnerMessageLoose[] = [];
  rc.on("ctrl", (m) => {
    if (m.type !== "phone-connected") return;
    link = new PhoneLink({
      phoneFp,
      connId: m.connId,
      name: m.name,
      kPair,
      computerFp: fp,
      send: (e) => {
        rc.sendEnvelope(e);
      },
      log,
    });
  });
  rc.on("e2e", (env) => {
    const current = link;
    if (!current) return;
    const was = current.handshaken;
    const msg = current.handleEnvelope(env);
    if (!was && current.handshaken) {
      current.send({
        type: "hello",
        agentVersion: "t",
        backends: [],
        computerName: "MBP",
        accent: "emerald",
      });
    }
    if (!msg) return;
    received.push(msg as InnerMessageLoose);
    if ("reqId" in msg) current.send({ type: "ack", reqId: msg.reqId, ok: true });
  });
  rc.start();
  await waitFor(() => rc.online);
  return { rc, received };
}

let relay: FakeRelay;
const mac = generateIdentity();
const phone = generateIdentity();
const macFp = fingerprint(mac.ed25519.pub);
const phoneFp = fingerprint(phone.ed25519.pub);
const kPair = randomBytes(32);

function makeConn(over: Partial<ConnectionOptions> = {}) {
  const inner: InnerMessageLoose[] = [];
  const statuses: Status[] = [];
  const c = new ComputerConnection({
    computerFp: macFp,
    relayUrl: relay.url,
    identity: phone,
    phoneFp,
    phoneName: "iPhone",
    appVersion: "t",
    kPair,
    onInner: (m) => inner.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: WebSocket as never,
    backoffMinMs: 50,
    backoffMaxMs: 100,
    ...over,
  });
  return { c, inner, statuses };
}

const leases = () =>
  relay.ctrlFromPhones.filter((r) => r.fp === phoneFp && r.msg.type === "lease");

beforeEach(async () => {
  relay = new FakeRelay(macFp);
  await relay.start();
});
afterEach(async () => {
  await relay.stop();
});

describe("ComputerConnection", () => {
  it("authenticates, leases, handshakes, receives hello, sends inputs with acks", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner, statuses } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    expect(statuses).toEqual(["connecting", "auth", "handshake", "online"]);
    await waitFor(() => leases().length > 0);
    expect(leases()[0]?.msg).toMatchObject({ type: "lease", ttlMs: 60_000 });
    const ack = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "y",
    });
    expect(ack.ok).toBe(true);
    expect(agent.received[0]).toMatchObject({ type: "input.line", text: "y" });
    c.close("user");
    agent.rc.stop();
  });

  it("close('background') sends lease 0 and fails pending requests", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // Stop the agent so nothing can ack; the phone socket stays up.
    agent.rc.stop();
    await waitFor(() => relay.agent === null);
    const before = leases().length;
    const p = c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "x",
    });
    expect(c.pendingReqIds()).toHaveLength(1);
    c.close("background");
    await expect(p).rejects.toThrow(/delivery unknown/i);
    expect(c.pendingReqIds()).toHaveLength(0);
    expect(c.status).toBe("idle");
    await waitFor(() => leases().length > before);
    expect(leases().at(-1)?.msg).toMatchObject({ type: "lease", ttlMs: 0 });
  });

  it("reconnects after the relay drops the socket", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    relay.phones.get(phoneFp)?.ws.terminate();
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
    c.close("user");
    agent.rc.stop();
  });

  it("stops permanently on 4005 (superseded) instead of racing the winner", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const first = makeConn();
    first.c.connect();
    await waitFor(() => first.inner.some((m) => m.type === "hello"));
    const connections = relay.connections;
    const second = makeConn();
    second.c.connect();
    await waitFor(() => first.c.status === "error");
    expect(first.statuses.at(-1)).toBe("error");
    await new Promise((r) => setTimeout(r, 300));
    // No third socket: the loser must not reconnect.
    expect(relay.connections).toBe(connections + 1);
    second.c.close("user");
    agent.rc.stop();
  });

  it("stops permanently when the relay rejects the identity", async () => {
    const { c, statuses } = makeConn({ identity: generateIdentity() });
    c.connect();
    await waitFor(() => c.status === "error");
    const connections = relay.connections;
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.connections).toBe(connections);
    expect(statuses.at(-1)).toBe("error");
  });
});
```

The last test relies on `FakeRelay`'s real signature check: a mismatched identity yields
`fingerprint(ed25519Pub) !== fp` → `auth-fail { reason: "bad-sig" }` → close `4001`, which is a
permanent reason and must not reconnect.

- [ ] **Step 3: Implement `connection.ts`** (RN-free; uses the global `WebSocket` unless injected)

```ts
import {
  authMessage,
  type CtrlMessageLoose,
  decodeCbor,
  decodeEnvelope,
  deriveConnKey,
  E2EBodySchema,
  encodeCbor,
  encodeEnvelope,
  type Envelope,
  frameAd,
  helloAd,
  type Identity,
  type InnerMessageLoose,
  type InnerMessageLooseOf,
  open,
  parseCtrlLoose,
  parseInnerLoose,
  randomBytes,
  relayWsUrl,
  seal,
  sign,
  toBase64Url,
} from "@shellbell/protocol";
import type { ErrorKind, Status } from "../store/connections";

export class DeliveryUnknownError extends Error {
  constructor() {
    super("delivery unknown: the connection closed before an ack arrived");
    this.name = "DeliveryUnknownError";
  }
}

type WsLike = {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface StatusExtra {
  agentOnline?: boolean;
  error?: ErrorKind;
  closeCode?: number;
  /** reqIds that were in flight when the connection went down (spec 12 toast) */
  lostReqIds?: string[];
}

export interface PushTokenInfo {
  token: string;
  platform: "ios" | "android";
  enabled: boolean;
}

export interface ConnectionOptions {
  computerFp: string;
  relayUrl: string;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  kPair: Uint8Array;
  pushToken?: () => Promise<PushTokenInfo | null>;
  onCtrl?: (m: CtrlMessageLoose) => void;
  onInner: (m: InnerMessageLoose) => void;
  onStatus: (s: Status, extra?: StatusExtra) => void;
  WebSocketImpl?: new (url: string) => WsLike;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
}

const LEASE_MS = 60_000;
const KEEPALIVE_MS = 30_000;
const MAX_DECRYPT_FAILURES = 20;

/** Mirrors apps/agent/src/relay-client.ts: these mean the config will never work. */
const PERMANENT_AUTH_FAIL: Record<string, ErrorKind | undefined> = {
  "bad-sig": "rejected",
  "fp-mismatch": "rejected",
  "not-paired": "unpaired",
};

/** Close codes that must never be retried. */
const PERMANENT_CLOSE: Record<number, ErrorKind> = {
  4004: "unpaired",
  4005: "superseded",
  4400: "relay",
  4403: "relay",
};

/** Transient, but reconnecting fast is what caused them: keep the backoff where it is. */
const KEEP_BACKOFF_CLOSE = new Set([4413, 4429]);

export class ComputerConnection {
  status: Status = "idle";
  private ws: WsLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private agentOnline = false;
  private nPhone: Uint8Array | null = null;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seqOut = 0;
  private seqIn = 0;
  private failures = 0;
  private minFrameMs = 125;
  private readonly pending = new Map<
    string,
    { resolve: (a: InnerMessageLooseOf<"ack">) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly o: ConnectionOptions) {}

  get online(): boolean {
    return this.status === "online";
  }

  /** The relay's advertised minimum frame interval; surfaced for Plan 06 perf work. */
  get frameIntervalMs(): number {
    return this.minFrameMs;
  }

  newReqId(): string {
    return toBase64Url(randomBytes(8));
  }

  pendingReqIds(): string[] {
    return [...this.pending.keys()];
  }

  connect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  close(reason: "background" | "user" = "user"): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws && this.ws.readyState === 1) {
      // Spec 10.4/11.3: the relay must treat this phone as push-eligible immediately.
      if (reason === "background") this.sendCtrl({ type: "lease", ttlMs: 0 });
      this.ws.close(1000, reason);
    }
    this.ws = null;
    this.failPending();
    this.resetSession();
    this.setStatus("idle");
  }

  subscribe(sessionId: string | null): boolean {
    return this.send({ type: "subscribe", sessionId });
  }

  send(msg: InnerMessageLoose): boolean {
    if (!this.kConn || this.status !== "online" || !this.ws) return false;
    this.seqOut += 1;
    const ad = frameAd(this.o.phoneFp, this.o.computerFp, this.connTag, this.seqOut);
    const box = seal(this.kConn, encodeCbor(msg), ad);
    this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: this.seqOut,
      body: box,
    });
    return true;
  }

  request(msg: InnerMessageLoose & { reqId: string }): Promise<InnerMessageLooseOf<"ack">> {
    return new Promise((resolve, reject) => {
      if (!this.send(msg)) return reject(new DeliveryUnknownError());
      this.pending.set(msg.reqId, { resolve, reject });
    });
  }

  // ---- internals ----

  private setStatus(s: Status, extra?: StatusExtra): void {
    this.status = s;
    this.o.onStatus(s, extra);
  }

  private stopWith(error: ErrorKind, closeCode?: number): void {
    this.stopped = true;
    this.clearTimers();
    this.setStatus("error", { error, closeCode, lostReqIds: this.pendingReqIds() });
    this.failPending();
  }

  private open(): void {
    if (this.stopped) return;
    const Ws =
      this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const ws = new Ws(relayWsUrl(this.o.relayUrl, this.o.computerFp));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => this.setStatus("auth");
    ws.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === "string") return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      let env: Envelope;
      try {
        env = decodeEnvelope(bytes);
      } catch {
        return;
      }
      if (env.t === "ctrl") {
        let m: CtrlMessageLoose;
        try {
          m = parseCtrlLoose(env.body);
        } catch {
          return;
        }
        this.onCtrl(m);
      } else {
        this.onE2E(env);
      }
    };
    ws.onclose = (ev) => this.onDown(ev.code);
    ws.onerror = () => {
      /* onclose always follows */
    };
  }

  private sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState === 1) this.ws.send(encodeEnvelope(env));
  }

  private sendCtrl(body: CtrlMessageLoose): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.o.phoneFp, seq: 0, body } as Envelope);
  }

  private onCtrl(m: CtrlMessageLoose): void {
    this.o.onCtrl?.(m);
    switch (m.type) {
      case "challenge": {
        const msg = authMessage(m.connId, "phone", this.o.phoneFp, m.nonce);
        this.sendCtrl({
          type: "auth",
          role: "phone",
          fp: this.o.phoneFp,
          ed25519Pub: this.o.identity.ed25519.pub,
          sig: sign(this.o.identity.ed25519.priv, msg),
          name: this.o.phoneName,
          appVersion: this.o.appVersion,
        });
        return;
      }
      case "auth-ok": {
        this.attempt = 0;
        this.agentOnline = m.agentOnline;
        this.minFrameMs = m.minFrameMs;
        this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        void this.o.pushToken?.().then((t) => {
          if (!t) return;
          this.sendCtrl({
            type: "push-token",
            token: t.token,
            platform: t.platform,
            enabled: t.enabled,
          });
        });
        this.keepalive = setInterval(() => {
          this.ws?.send("ping");
          this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        }, KEEPALIVE_MS);
        if (m.agentOnline) this.startHandshake();
        else this.setStatus("offline", { agentOnline: false });
        return;
      }
      case "auth-fail": {
        const permanent = PERMANENT_AUTH_FAIL[m.reason];
        if (permanent) {
          this.stopWith(permanent);
          this.ws?.close(1000, m.reason);
        } else {
          this.setStatus("offline", { agentOnline: false });
        }
        return;
      }
      case "presence": {
        this.agentOnline = m.agentOnline;
        if (m.agentOnline && !this.kConn) {
          this.startHandshake();
          return;
        }
        if (!m.agentOnline) {
          const lost = this.pendingReqIds();
          this.resetSession();
          this.failPending();
          this.setStatus("offline", { agentOnline: false, lostReqIds: lost });
        }
        return;
      }
      default:
        return;
    }
  }

  private startHandshake(): void {
    this.resetSession();
    this.setStatus("handshake");
    this.nPhone = randomBytes(16);
    const box = seal(
      this.o.kPair,
      encodeCbor({ type: "conn.hello", n: this.nPhone }),
      helloAd(this.o.phoneFp, this.o.computerFp),
    );
    this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: 0,
      body: box,
    });
    this.helloTimer = setTimeout(() => {
      if (!this.kConn) this.ws?.close(4000, "hello timeout");
    }, this.o.helloTimeoutMs ?? 10_000);
  }

  private onE2E(env: Envelope): void {
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return;
    if (env.seq === 0) {
      if (!this.nPhone) return;
      try {
        const ad = helloAd(this.o.computerFp, this.o.phoneFp);
        const inner = parseInnerLoose(decodeCbor(open(this.o.kPair, body.data, ad)));
        if (inner.type !== "conn.hello") return;
        const d = deriveConnKey(
          this.o.kPair,
          this.nPhone,
          inner.n,
          this.o.computerFp,
          this.o.phoneFp,
        );
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        this.failures = 0;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.setStatus("online", { agentOnline: true });
      } catch {
        this.stopWith("re-pair");
        this.ws?.close(1000, "kpair mismatch");
      }
      return;
    }
    if (!this.kConn || env.seq <= this.seqIn) return;
    let inner: InnerMessageLoose;
    try {
      const ad = frameAd(this.o.computerFp, this.o.phoneFp, this.connTag, env.seq);
      inner = parseInnerLoose(decodeCbor(open(this.kConn, body.data, ad)));
    } catch {
      this.failures += 1;
      if (this.failures >= MAX_DECRYPT_FAILURES) this.ws?.close(4000, "decrypt failures");
      return;
    }
    this.failures = 0;
    this.seqIn = env.seq;
    if (inner.type === "ack") {
      const p = this.pending.get(inner.reqId);
      if (p) {
        this.pending.delete(inner.reqId);
        p.resolve(inner);
      }
    }
    this.o.onInner(inner);
  }

  private onDown(code: number): void {
    this.clearTimers();
    this.ws = null;
    const lost = this.pendingReqIds();
    this.resetSession();
    const permanent = PERMANENT_CLOSE[code];
    if (permanent) {
      this.stopped = true;
      this.setStatus("error", { error: permanent, closeCode: code, lostReqIds: lost });
      this.failPending();
      return;
    }
    this.failPending();
    if (this.stopped) return;
    this.setStatus("offline", { closeCode: code, lostReqIds: lost });
    const min = this.o.backoffMinMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    // 4413/4429 mean we were too loud: advance the attempt counter but never reset it elsewhere.
    if (!KEEP_BACKOFF_CLOSE.has(code) || this.attempt === 0) {
      this.attempt = Math.min(this.attempt + 1, 10);
    }
    const wait = KEEP_BACKOFF_CLOSE.has(code) ? max : base + base * 0.2 * (Math.random() * 2 - 1);
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private resetSession(): void {
    this.kConn = null;
    this.nPhone = null;
    this.connTag = "";
    this.seqOut = 0;
    this.seqIn = 0;
    this.failures = 0;
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new DeliveryUnknownError());
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.reconnectTimer = null;
    this.keepalive = null;
    this.helloTimer = null;
  }
}
```

- [ ] **Step 4: Implement `manager.ts`**

Two rules this file must not break: `connectAll()` is **single-flight per computer** (the `has`
check happens before an `await`, so an unguarded version creates two sockets for one fp and the
relay closes one with `4005`), and no zustand updater performs a side effect — `snapshot.get` is
sent by the controller after the patch, never from inside the reducer.

```ts
import type { Identity, InnerMessageLoose } from "@shellbell/protocol";
import { AppState, type AppStateStatus } from "react-native";
import { loadPairSecret } from "../identity/keys";
import { useComputersStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../store/screen";
import { ComputerConnection, type PushTokenInfo } from "./connection";

const LOST_INPUT_TOAST = "Some input may not have been delivered";

export interface ManagerDeps {
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  pushToken: (computerFp: string) => Promise<PushTokenInfo | null>;
}

class Manager {
  private conns = new Map<string, ComputerConnection>();
  private starting = new Set<string>();
  private deps: ManagerDeps | null = null;
  private sub: { remove: () => void } | null = null;
  private unsubscribeComputers: (() => void) | null = null;

  start(deps: ManagerDeps): void {
    this.deps = deps;
    this.sub = AppState.addEventListener("change", (s) => this.onAppState(s));
    this.unsubscribeComputers = useComputersStore.subscribe((s, prev) => {
      if (s.computers !== prev.computers && AppState.currentState === "active") {
        void this.connectAll();
      }
    });
    if (AppState.currentState === "active") void this.connectAll();
  }

  stop(): void {
    this.sub?.remove();
    this.unsubscribeComputers?.();
    this.sub = null;
    this.unsubscribeComputers = null;
    this.closeAll("user");
  }

  get(fp: string): ComputerConnection | undefined {
    return this.conns.get(fp);
  }

  private onAppState(s: AppStateStatus): void {
    if (s === "active") void this.connectAll();
    else this.closeAll("background");
  }

  private async connectAll(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    for (const c of useComputersStore.getState().computers) {
      // Single-flight: `starting` is set synchronously, before the first await.
      if (this.conns.has(c.fp) || this.starting.has(c.fp)) continue;
      this.starting.add(c.fp);
      try {
        const secret = await loadPairSecret(c.fp);
        if (!secret) continue;
        if (this.conns.has(c.fp)) continue;
        const conn = new ComputerConnection({
          computerFp: c.fp,
          relayUrl: c.relayUrl,
          identity: deps.identity,
          phoneFp: deps.phoneFp,
          phoneName: deps.phoneName,
          appVersion: deps.appVersion,
          kPair: secret.kPair,
          pushToken: () => deps.pushToken(c.fp),
          onStatus: (status, extra) => this.onStatus(c.fp, status, extra),
          onInner: (m) => this.onInner(c.fp, m),
        });
        this.conns.set(c.fp, conn);
        conn.connect();
      } finally {
        this.starting.delete(c.fp);
      }
    }
    for (const [fp, conn] of this.conns) {
      if (!useComputersStore.getState().computers.some((c) => c.fp === fp)) {
        conn.close("user");
        this.conns.delete(fp);
      }
    }
  }

  private closeAll(reason: "background" | "user"): void {
    for (const [fp, conn] of this.conns) {
      const lost = conn.pendingReqIds();
      conn.close(reason);
      if (lost.length > 0) this.noteLostInputs(fp, lost);
    }
    this.conns.clear();
  }

  /** Spec 12: any close with un-acked input raises the toast — not only a deliberate background. */
  private noteLostInputs(fp: string, lost: string[]): void {
    if (lost.length === 0) return;
    useConnectionsStore.getState().patch(fp, (c) => {
      const rest = { ...c.pendingInputs };
      for (const id of lost) delete rest[id];
      return { pendingInputs: rest, toast: LOST_INPUT_TOAST };
    });
  }

  private onStatus(fp: string, status: Status, extra?: StatusExtra): void {
    useConnectionsStore.getState().patch(fp, () => ({
      status,
      agentOnline: extra?.agentOnline ?? status === "online",
      error: extra?.error,
    }));
    // Spec 12: any close with un-acked input raises the toast, not only a deliberate background.
    if (extra?.lostReqIds?.length) this.noteLostInputs(fp, extra.lostReqIds);
    if (extra?.error === "unpaired") {
      useComputersStore.getState().update(fp, { lastSeenAt: new Date().toISOString() });
    }
  }

  private onInner(fp: string, m: InnerMessageLoose): void {
    const store = useConnectionsStore.getState();
    switch (m.type) {
      case "hello":
        store.patch(fp, () => ({ hello: m }));
        useComputersStore.getState().update(fp, {
          name: m.computerName,
          accent: m.accent,
          lastSeenAt: new Date().toISOString(),
        });
        return;
      case "sessions":
        store.patch(fp, () => ({ sessions: m.list }));
        return;
      case "screen.snapshot":
        store.patch(fp, (c) => ({
          view: {
            sessionId: m.sessionId,
            view: applySnapshotKeyed(
              c.view?.sessionId === m.sessionId ? c.view.view : undefined,
              m,
            ),
          },
        }));
        return;
      case "screen.diff": {
        // Compute first, patch second, send third: no side effects inside the reducer.
        const cur = store.read(fp);
        if (cur.view?.sessionId !== m.sessionId) return;
        const { view, gap } = applyDiffKeyed(cur.view.view, m);
        if (gap) {
          const conn = this.conns.get(fp);
          if (conn) {
            conn.send({
              type: "snapshot.get",
              reqId: conn.newReqId(),
              sessionId: m.sessionId,
            });
          }
          return;
        }
        store.patch(fp, () => ({ view: { sessionId: m.sessionId, view } }));
        return;
      }
      case "history":
        store.patch(fp, (c) => ({
          oldestAvailable: { ...c.oldestAvailable, [m.sessionId]: m.oldestAvailable },
          view:
            c.view?.sessionId === m.sessionId
              ? {
                  sessionId: m.sessionId,
                  view: prependHistoryKeyed(c.view.view, m.lines, m.before),
                }
              : c.view,
        }));
        return;
      case "event":
        store.patch(fp, (c) => ({
          events: {
            ...c.events,
            [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m],
          },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        return;
      case "ack":
        store.patch(fp, (c) => {
          const rest = { ...c.pendingInputs };
          delete rest[m.reqId];
          return { pendingInputs: rest };
        });
        return;
      default:
        return;
    }
  }
}

export const connectionManager = new Manager();
```

Add the two type-only imports the file needs: `import type { Status } from "../store/connections";`
and `import type { PushTokenInfo, StatusExtra } from "./connection";`.

- [ ] **Step 5: Verify and commit**

Run the verify gate plus `pnpm -F shellbell test` (the `FakeRelay` change).

```bash
git add apps/mobile apps/agent/test/fakes/fake-relay.ts
git commit -m "feat(mobile): computer connection with handshake, leases, acks; app-state manager"
```

---

### Task 5: Pairing flow and screen (spec 6.4 phone side, 7.6, 10.7)

**Files:**
- Create: `apps/mobile/src/net/pairing.ts`
- Modify: `apps/mobile/app/pair.tsx` (replaces the Task 1 placeholder)

**Interfaces:**
- `parsePairingQr(text): { qr: QrPayload; displayName: string; fpPrefix: string }` — validates
  before anything is sent, so the confirmation sheet can name the computer.
- `runPairing(opts): Promise<PairingResult>` — rejects with
  `PairingError(code: "bad-qr" | "bad-code" | "declined" | "no-window" | "no-agent" | "too-many" |
  "timeout" | "relay")`.

- [ ] **Step 1: Implement `pairing.ts`**

Three properties this file must have: **every** message handler is inside a `try`/`catch` so a
malformed frame rejects the promise instead of throwing into the socket callback; **every** exit
path calls `finish` exactly once; and the promise is bounded by a timeout that always fires.

```ts
import {
  authMessage,
  type CtrlMessageLoose,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeEnvelope,
  fromBase64Url,
  type Identity,
  open,
  pairingAd,
  parseCtrlLoose,
  parseQr,
  type QrPayload,
  relayWsUrl,
  seal,
  sign,
} from "@shellbell/protocol";
import { z } from "zod";
import type { PairSecret } from "../identity/keys";

export type PairingCode =
  | "bad-qr"
  | "bad-code"
  | "declined"
  | "no-window"
  | "no-agent"
  | "too-many"
  | "timeout"
  | "relay";

export class PairingError extends Error {
  constructor(public readonly code: PairingCode) {
    super(code);
    this.name = "PairingError";
  }
}

export interface PairingResult {
  computerFp: string;
  computerName: string;
  accent: string;
  relayUrl: string;
  secret: PairSecret;
}

const ResponseBody = z.object({
  x25519Pub: z.instanceof(Uint8Array),
  computerName: z.string().min(1).max(64),
  accent: z.string().min(1).max(32),
});

/** Spec 10.7: validate the QR *before* any socket opens so the sheet can name the computer. */
export function parsePairingQr(
  text: string,
  opts: { allowInsecure?: boolean } = {},
): { qr: QrPayload; displayName: string; fpPrefix: string } {
  let qr: QrPayload;
  try {
    qr = parseQr(text, opts);
  } catch {
    throw new PairingError("bad-qr");
  }
  return { qr, displayName: qr.n, fpPrefix: `${qr.c.slice(0, 4)}-${qr.c.slice(4, 8)}` };
}

const REJECT_TO_CODE: Record<string, PairingCode> = {
  declined: "declined",
  "bad-code": "bad-code",
  "no-agent": "no-agent",
  "too-many": "too-many",
  "window-closed": "no-window",
};

const AUTH_FAIL_TO_CODE: Record<string, PairingCode> = {
  "no-agent": "no-agent",
  "no-window": "no-window",
  timeout: "timeout",
};

/** Spec 12 close codes seen by a pairing socket. */
const CLOSE_TO_CODE: Record<number, PairingCode> = {
  4001: "no-window",
  4003: "declined",
  4408: "timeout",
  4413: "relay",
  4429: "relay",
};

export function runPairing(o: {
  qr: QrPayload;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  platform: "ios" | "android";
  appVersion: string;
  WebSocketImpl?: new (url: string) => WebSocket;
  timeoutMs?: number;
}): Promise<PairingResult> {
  return new Promise<PairingResult>((resolve, reject) => {
    const { qr } = o;
    const code = fromBase64Url(qr.p);
    const gate = fromBase64Url(qr.g);
    const kPsk = derivePskKey(code, qr.c);
    const Ws = o.WebSocketImpl ?? WebSocket;
    const ws = new Ws(relayWsUrl(qr.r, qr.c));
    ws.binaryType = "arraybuffer";

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Declared before every handler that can call it.
    const finish = (err: PairingError | null, value?: PairingResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      if (err) reject(err);
      else if (value) resolve(value);
      else reject(new PairingError("relay"));
    };

    // The relay closes a pairing socket at 90 s; stay just inside that so our copy wins the race.
    timer = setTimeout(() => finish(new PairingError("timeout")), o.timeoutMs ?? 88_000);

    const sendCtrl = (body: CtrlMessageLoose) => {
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: o.phoneFp, seq: 0, body } as never));
    };

    ws.onerror = () => finish(new PairingError("relay"));
    ws.onclose = (ev) => finish(new PairingError(CLOSE_TO_CODE[ev.code] ?? "relay"));

    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") return;
        const env = decodeEnvelope(new Uint8Array(ev.data as ArrayBuffer));
        if (env.t !== "ctrl") return;
        const m = parseCtrlLoose(env.body);
        switch (m.type) {
          case "challenge": {
            const msg = authMessage(m.connId, "pairing", o.phoneFp, m.nonce);
            sendCtrl({
              type: "auth",
              role: "pairing",
              fp: o.phoneFp,
              ed25519Pub: o.identity.ed25519.pub,
              sig: sign(o.identity.ed25519.priv, msg),
              name: o.phoneName,
              appVersion: o.appVersion,
              gate,
            });
            return;
          }
          case "auth-ok": {
            const box = seal(
              kPsk,
              encodeCbor({
                ed25519Pub: o.identity.ed25519.pub,
                x25519Pub: o.identity.x25519.pub,
                name: o.phoneName,
                platform: o.platform,
              }),
              pairingAd("request", qr.c, o.phoneFp),
            );
            sendCtrl({ type: "pairing-request", phoneFp: o.phoneFp, box });
            return;
          }
          case "auth-fail":
            finish(new PairingError(AUTH_FAIL_TO_CODE[m.reason] ?? "relay"));
            return;
          case "pairing-reject":
            finish(new PairingError(REJECT_TO_CODE[m.reason] ?? "no-window"));
            return;
          case "pairing-response": {
            const ad = pairingAd("response", qr.c, o.phoneFp);
            const body = ResponseBody.parse(decodeCbor(open(kPsk, m.box, ad)));
            const kPair = derivePairKey(
              o.identity.x25519.priv,
              body.x25519Pub,
              code,
              qr.c,
              o.phoneFp,
            );
            finish(null, {
              computerFp: qr.c,
              computerName: body.computerName,
              accent: body.accent,
              relayUrl: qr.r,
              secret: {
                kPair,
                computerEd25519Pub: fromBase64Url(qr.e),
                computerX25519Pub: body.x25519Pub,
              },
            });
            return;
          }
          default:
            return;
        }
      } catch {
        // A malformed frame, a bad box, or a low-order X25519 point: never throw into the socket.
        finish(new PairingError("bad-code"));
      }
    };
  });
}
```

Known limitation (R54 ruling 1 scopes loose parsing to the three session enums): a
`pairing-reject`/`auth-fail` `reason` a newer relay introduces makes `parseCtrlLoose` throw, and the
`catch` above surfaces it as `bad-code`. Recorded in the plan self-review.

- [ ] **Step 2: Pair screen with a confirmation sheet**

`apps/mobile/app/pair.tsx`. Spec 10.7 requires the sheet **before** the handshake starts: a scanned
QR must never begin a pairing exchange without the user seeing which computer it names.

```tsx
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import {
  type PairingCode,
  PairingError,
  parsePairingQr,
  runPairing,
} from "../src/net/pairing";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

const COPY: Record<PairingCode, string> = {
  "bad-qr": "That isn't a Shellbell pairing code.",
  "bad-code": "That code expired — run `shellbell pair` again.",
  declined: "The computer declined.",
  "no-window": "No pairing window is open on that computer.",
  "no-agent": "The computer isn't online.",
  "too-many": "That computer already has the maximum number of paired phones.",
  timeout: "Pairing timed out. Run `shellbell pair` again and rescan.",
  relay: "Couldn't reach the relay.",
};

export default function PairScreen() {
  const [perm, requestPerm] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanned = useRef(false);
  const router = useRouter();
  const add = useComputersStore((s) => s.add);

  if (!perm?.granted) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          backgroundColor: tokens.bg,
        }}
      >
        <Text style={{ color: tokens.text, textAlign: "center" }}>
          Shellbell needs the camera to scan the pairing code your computer shows.
        </Text>
        <Pressable
          onPress={() => void requestPerm()}
          style={{
            backgroundColor: tokens.accents.emerald,
            padding: 12,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text style={{ color: "#000", fontWeight: "600" }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const confirm = (name: string, fpPrefix: string) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(`Pair with "${name}"?`, `Fingerprint ${fpPrefix}`, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Pair", onPress: () => resolve(true) },
      ]);
    });

  const onScan = async (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    setError(null);
    try {
      const { qr, displayName, fpPrefix } = parsePairingQr(data, { allowInsecure: __DEV__ });
      if (!(await confirm(displayName, fpPrefix))) {
        scanned.current = false;
        return;
      }
      setBusy("Pairing… confirm on your computer");
      const { identity, fp } = await loadOrCreateIdentity();
      const r = await runPairing({
        qr,
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: "0.1.0",
      });
      await savePairSecret(r.computerFp, r.secret);
      add({
        fp: r.computerFp,
        name: r.computerName,
        accent: r.accent,
        relayUrl: r.relayUrl,
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pushEnabled: true,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/c/${r.computerFp}`);
    } catch (e) {
      setError(e instanceof PairingError ? COPY[e.code] : COPY.relay);
      scanned.current = false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(r) => void onScan(r.data)}
      />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
          {busy ?? "Run `npx shellbell` on your Mac and scan the code."}
        </Text>
        {error ? (
          <Text style={{ color: tokens.accents.rose, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
```

The catch-all uses `COPY.relay`, never `String(e)`: an arbitrary error message must not be able to
put QR bytes or key material on screen.

- [ ] **Step 3: Verify** — agent verify gate, then **[HUMAN]** end-to-end

An agent runs the verify gate only. A human then runs `scripts/e2e-local.sh`,
`shellbell start --relay ws://<LAN-IP>:8787`, scans from a dev build, presses `y` on the Mac, and
lands on the computer route (empty until Task 6).

```bash
git add apps/mobile
git commit -m "feat(mobile): pairing flow with confirmation sheet and guarded socket handlers"
```

---

### Task 6: Backend/state vocabulary, Computers and Sessions screens, root wiring (spec 10.2, 10.6, 10.9)

**Files:**
- Create: `apps/mobile/src/util/backends.ts`, `apps/mobile/src/util/session-state.ts`,
  `apps/mobile/src/ui/Bar.tsx`, `Card.tsx`, `Pill.tsx`, `EmptyState.tsx`, `Toast.tsx`,
  `StatusOverlay.tsx`, `apps/mobile/app/c/[fp]/_layout.tsx`, `apps/mobile/app/c/[fp]/index.tsx`
- Modify: `apps/mobile/app/index.tsx`, `apps/mobile/app/_layout.tsx`,
  `apps/mobile/test/backends.test.ts`

- [ ] **Step 1: The label and state vocabulary (no ternaries anywhere else)**

Every backend name and session state the app renders goes through these two modules. There must be
no `backend === "iterm2" ? … : "tmux"` expression anywhere in the codebase — a Herdr session would
be mislabelled "tmux", and an unknown backend from a newer agent would be too (spec 10.6).

`apps/mobile/src/util/backends.ts`:

```ts
import { BackendNameSchema, type BackendName } from "@shellbell/protocol";

const LABELS: Record<string, string> = {
  iterm2: "iTerm2",
  tmux: "tmux",
  herdr: "Herdr",
};

const NEW_SESSION_LABELS: Record<string, string> = {
  iterm2: "New iTerm2 tab",
  tmux: "New tmux window",
  herdr: "New Herdr tab",
};

/** Known backend -> its display name; anything else -> the raw string (spec 10.6). */
export function backendLabel(name: string): string {
  return LABELS[name] ?? name;
}

export function newSessionLabel(name: string): string {
  return NEW_SESSION_LABELS[name] ?? `New ${backendLabel(name)} session`;
}

/**
 * `session.create` and `session.focus` travel to the agent's *strict* parser, so only a backend the
 * shipped enum knows may be offered as an action. Unknown backends still render (label + badge);
 * they just get no "New …" entry.
 */
export function asBackendName(name: string): BackendName | null {
  const r = BackendNameSchema.safeParse(name);
  return r.success ? r.data : null;
}

/** Spec 8.13: a Herdr cursor is inferred from the agent's output, not a real terminal cursor. */
export function cursorIsInferred(backend: string): boolean {
  return backend === "herdr";
}

/** Session ids are "<backend>:<native id>"; the list groups by backend before window. */
export function backendOf(sessionId: string): string {
  const i = sessionId.indexOf(":");
  return i === -1 ? sessionId : sessionId.slice(0, i);
}
```

`apps/mobile/src/util/session-state.ts`:

```ts
export type StateTone = "muted" | "active" | "alert";

export interface StatePill {
  label: string;
  tone: StateTone;
}

const KNOWN: Record<string, StatePill | null> = {
  unknown: null,
  editing: { label: "editing", tone: "muted" },
  running: { label: "running", tone: "active" },
  finished: { label: "finished", tone: "muted" },
  // spec 8.13/10.6: an agent is waiting for a human. First-class, not a flavour of `running`.
  blocked: { label: "blocked", tone: "alert" },
};

/** `null` means "render no pill". An unrecognised state renders its raw string, muted. */
export function statePill(state: string): StatePill | null {
  if (state in KNOWN) return KNOWN[state] ?? null;
  return { label: state, tone: "muted" };
}

/** The cursor blinks only while the session is doing something (spec 10.5). */
export function cursorBlinks(state: string): boolean {
  return state === "running" || state === "editing" || state === "blocked";
}

/** Reply chips are for "the terminal is waiting on you" (spec 10.6). */
export function wantsReply(state: string, lastEventKind: string | undefined): boolean {
  return state === "running" || state === "blocked" || lastEventKind === "idle" ||
    lastEventKind === "blocked";
}
```

Extend `apps/mobile/test/backends.test.ts` (created in Task 2 for the fixture guard):

```ts
import { describe, expect, it } from "vitest";
import { asBackendName, backendLabel, cursorIsInferred, newSessionLabel } from
  "../src/util/backends.js";
import { cursorBlinks, statePill, wantsReply } from "../src/util/session-state.js";

describe("backend vocabulary", () => {
  it("labels every shipped backend and passes unknown ones through", () => {
    expect(backendLabel("iterm2")).toBe("iTerm2");
    expect(backendLabel("tmux")).toBe("tmux");
    expect(backendLabel("herdr")).toBe("Herdr");
    expect(backendLabel("kitty")).toBe("kitty");
    expect(newSessionLabel("herdr")).toBe("New Herdr tab");
    expect(newSessionLabel("kitty")).toBe("New kitty session");
  });

  it("only offers create/focus actions for strictly-known backends", () => {
    expect(asBackendName("herdr")).toBe("herdr");
    expect(asBackendName("kitty")).toBeNull();
  });

  it("dims the cursor only for herdr", () => {
    expect(cursorIsInferred("herdr")).toBe(true);
    expect(cursorIsInferred("tmux")).toBe(false);
  });
});

describe("session state vocabulary", () => {
  it("gives blocked its own alert pill", () => {
    expect(statePill("blocked")).toEqual({ label: "blocked", tone: "alert" });
    expect(statePill("running")?.tone).toBe("active");
    expect(statePill("unknown")).toBeNull();
    expect(statePill("compiling")).toEqual({ label: "compiling", tone: "muted" });
  });

  it("shows reply chips while running, blocked, or after an idle/blocked event", () => {
    expect(wantsReply("running", undefined)).toBe(true);
    expect(wantsReply("blocked", undefined)).toBe(true);
    expect(wantsReply("finished", "idle")).toBe(true);
    expect(wantsReply("finished", "blocked")).toBe(true);
    expect(wantsReply("finished", "exit")).toBe(false);
  });

  it("blinks the cursor only while the session is doing something", () => {
    expect(cursorBlinks("running")).toBe(true);
    expect(cursorBlinks("blocked")).toBe(true);
    expect(cursorBlinks("finished")).toBe(false);
  });
});
```

- [ ] **Step 2: UI primitives**

`src/ui/Bar.tsx`:

```tsx
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { tokens } from "../theme/tokens";

const glass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

export function Bar({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  if (glass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        style={[{ paddingHorizontal: 12, paddingVertical: 8 }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        {
          backgroundColor: "rgba(11,11,13,0.92)",
          borderColor: tokens.border,
          borderWidth: 1,
          paddingHorizontal: 12,
          paddingVertical: 8,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
```

Pass only props `expo-glass-effect` documents for the installed version; if `glassEffectStyle` or
any other prop is rejected, drop it rather than inventing one.

Remaining primitives, all small and presentational:

- `Card({ accent, children })` — `surface`, `radius.lg`, 1-px border, accent stripe.
- `Pill({ tone | color, text })` — rounded label; `tone` maps `muted → textFaint`,
  `active → accents.amber`, `alert → accents.rose`.
- `EmptyState({ text, action?: { label; onPress } })` — one sentence, one action.
- `Toast({ text, onDone })` — auto-hides after 3 s via `useEffect`; calls `onDone` so the caller
  clears `conn.toast`.
- `StatusOverlay({ text, tone })` — an absolutely-positioned scrim (`rgba(0,0,0,0.55)`) plus a
  centred pill. **Spec 12: it dims the last screen; it never replaces it.**

- [ ] **Step 3: Root layout wiring**

Extend `app/_layout.tsx`: keep the crypto bootstrap as the first import; call
`useComputersStore.getState().hydrate()` on mount; load the four terminal fonts with `useFonts` from
`expo-font` and hold `expo-splash-screen` until they resolve; then `loadOrCreateIdentity()` and
`connectionManager.start({ identity, phoneFp: fp, phoneName: Device.deviceName ?? "My phone",
appVersion: "0.1.0", pushToken: async () => null })` — the push-token provider is filled in Plan 06.
Register the `c/[fp]` stack and `dev/render-spike`. Deep-link handling
(`shellbell://c/<fp>/s/<sid>`) and notification handlers are **Plan 06**; the `scheme` is already in
`app.json` so links resolve to routes by default.

- [ ] **Step 4: Computers screen**

`app/index.tsx`:

```tsx
import { FlashList } from "@shopify/flash-list";
import { Link, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";
import { tokens } from "../src/theme/tokens";
import { Card } from "../src/ui/Card";
import { EmptyState } from "../src/ui/EmptyState";
import { Pill } from "../src/ui/Pill";

const STATUS_TEXT: Record<string, string> = {
  idle: "idle",
  connecting: "connecting…",
  auth: "connecting…",
  handshake: "connecting…",
  online: "online",
  offline: "reconnecting…",
  error: "needs attention",
};

const ERROR_TEXT: Record<string, string> = {
  unpaired: "unpaired",
  "re-pair": "re-pair needed",
  superseded: "open on another device",
  rejected: "rejected by relay",
  relay: "relay error",
};

export default function Computers() {
  const computers = useComputersStore((s) => s.computers);
  const conns = useConnectionsStore((s) => s.byComputer);
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      {computers.length === 0 ? (
        <EmptyState
          text="No computers yet."
          action={{ label: "Pair one", onPress: () => router.push("/pair") }}
        />
      ) : (
        <FlashList
          data={computers}
          keyExtractor={(c) => c.fp}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            const c = conns[item.fp];
            const accentKey = item.accent as keyof typeof tokens.accents;
            const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
            const offline = c?.status === "offline" && !c.agentOnline;
            const label = c?.error
              ? (ERROR_TEXT[c.error] ?? "needs attention")
              : offline
                ? "computer offline"
                : (STATUS_TEXT[c?.status ?? "idle"] ?? "idle");
            return (
              <Pressable onPress={() => router.push(`/c/${item.fp}`)}>
                <Card accent={accent}>
                  <Text style={{ color: tokens.text, fontSize: 17, fontWeight: "600" }}>
                    {item.name}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 8,
                      marginTop: 6,
                      alignItems: "center",
                    }}
                  >
                    <Pill color={c?.status === "online" ? accent : tokens.textFaint} text={label} />
                    <Text style={{ color: tokens.textMuted }}>
                      {c?.sessions.length ?? 0} sessions
                    </Text>
                  </View>
                </Card>
              </Pressable>
            );
          }}
        />
      )}
      <Link href="/pair" asChild>
        <Pressable
          style={{
            position: "absolute",
            right: 20,
            bottom: 32,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: tokens.accents.emerald,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#000", fontSize: 28, lineHeight: 30 }}>+</Text>
        </Pressable>
      </Link>
      <Link
        href="/settings"
        style={{ position: "absolute", left: 20, bottom: 44, color: tokens.textMuted }}
      >
        Settings
      </Link>
    </View>
  );
}
```

- [ ] **Step 5: Sessions screen**

`app/c/[fp]/_layout.tsx`: a `Stack` whose title is the computer's name, with a header button to
`settings`.

`app/c/[fp]/index.tsx`. Two spec 12 rules govern the non-online states: an **error** state replaces
the list (there is nothing to show and an action is required), while **offline/reconnecting** keeps
whatever the list last held and dims it with `StatusOverlay`.

```tsx
import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { connectionManager } from "../../../src/net/manager";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { tokens } from "../../../src/theme/tokens";
import { EmptyState } from "../../../src/ui/EmptyState";
import { Pill } from "../../../src/ui/Pill";
import { StatusOverlay } from "../../../src/ui/StatusOverlay";
import { asBackendName, backendLabel, newSessionLabel } from "../../../src/util/backends";
import { sidToRoute } from "../../../src/util/routes";
import { statePill } from "../../../src/util/session-state";

const ERROR_COPY: Record<string, { text: string; action: string }> = {
  unpaired: { text: "This phone was unpaired on the computer.", action: "Re-pair" },
  "re-pair": { text: "Keys are out of sync. Re-pair this computer.", action: "Re-pair" },
  superseded: { text: "This computer is open in another Shellbell session.", action: "Retry" },
  rejected: { text: "The relay rejected this phone's identity.", action: "Re-pair" },
  relay: { text: "The relay refused the connection.", action: "Retry" },
};

export default function Sessions() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;

  const rows = useMemo(() => {
    const list = conn?.sessions ?? [];
    type Row =
      | { kind: "header"; key: string; text: string }
      | { kind: "session"; key: string; s: (typeof list)[number] };
    const out: Row[] = [];
    let lastGroup = "";
    for (const s of list) {
      const group = `${s.backend}:${s.windowId}`;
      if (group !== lastGroup) {
        out.push({
          kind: "header",
          key: `h:${group}`,
          text: `${backendLabel(s.backend)} · window ${s.windowNumber}`,
        });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions]);

  const newSession = () => {
    const creatable = (conn?.hello?.backends ?? [])
      .filter((b) => b.capabilities.createSession)
      .map((b) => asBackendName(b.name))
      .filter((n): n is NonNullable<typeof n> => n !== null);
    if (creatable.length === 0) return;
    const go = (backend: (typeof creatable)[number]) => {
      const c = connectionManager.get(fp ?? "");
      if (!c) return;
      void c
        .request({ type: "session.create", reqId: c.newReqId(), in: { kind: "tab", backend } })
        .then((ack) => {
          if (ack.sessionId) router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`);
        })
        .catch(() => undefined);
    };
    if (creatable.length === 1) {
      const only = creatable[0];
      if (only) go(only);
      return;
    }
    Alert.alert("New session", undefined, [
      ...creatable.map((b) => ({ text: newSessionLabel(b), onPress: () => go(b) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  const errored = conn?.status === "error" && conn.error;
  if (errored) {
    const copy = ERROR_COPY[conn.error ?? "relay"] ?? ERROR_COPY.relay;
    return (
      <EmptyState
        text={copy?.text ?? "The connection failed."}
        action={{ label: copy?.action ?? "Retry", onPress: () => router.push("/pair") }}
      />
    );
  }
  if (rows.length === 0 && conn?.status === "online") {
    return (
      <EmptyState
        text="No terminal sessions. Open iTerm2 or start tmux on the Mac."
        action={{ label: "New session", onPress: newSession }}
      />
    );
  }
  if (rows.length === 0) return <EmptyState text="Connecting…" />;

  const dimmed = conn?.status !== "online";
  const overlay = !conn?.agentOnline
    ? `${computer?.name ?? "Computer"} is offline`
    : "Reconnecting…";

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return (
              <Text
                style={{
                  color: tokens.textMuted,
                  fontSize: 12,
                  letterSpacing: 1,
                  marginTop: 12,
                  marginBottom: 6,
                }}
              >
                {item.text.toUpperCase()}
              </Text>
            );
          }
          const pill = statePill(item.s.state);
          return (
            <Pressable
              onPress={() => router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`)}
              style={{
                paddingVertical: 10,
                borderBottomColor: tokens.border,
                borderBottomWidth: 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: item.s.isFocusedOnMac ? accent : tokens.textFaint,
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.text, fontSize: 15 }} numberOfLines={1}>
                  {item.s.title}
                </Text>
                {item.s.cwd ? (
                  <Text style={{ color: tokens.textMuted, fontSize: 12 }} numberOfLines={1}>
                    {item.s.cwd}
                  </Text>
                ) : null}
              </View>
              <Pill tone="muted" text={backendLabel(item.s.backend)} />
              {pill ? <Pill tone={pill.tone} text={pill.label} /> : null}
              {(conn?.unread[item.s.id] ?? 0) > 0 ? (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.accents.rose,
                  }}
                />
              ) : null}
            </Pressable>
          );
        }}
      />
      {dimmed ? <StatusOverlay text={overlay} tone="muted" /> : null}
      <Pressable
        onPress={newSession}
        style={{
          position: "absolute",
          right: 20,
          bottom: 32,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: "#000", fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
    </View>
  );
}
```

Session rows are inert until Task 7 creates `app/c/[fp]/s/[sid].tsx`; that is expected and is the
only known gap at the end of this task.

- [ ] **Step 6: Verify** — agent verify gate, then **[HUMAN]** on device

**[HUMAN]:** computers list shows the paired Mac online; sessions list shows iTerm2 (and tmux, and
Herdr if configured) grouped, with backend badges and the focused dot; a `blocked` Herdr session
shows the alert pill; "+" creates a tab on the Mac.

```bash
git add apps/mobile
git commit -m "feat(mobile): backend/state vocabulary, computers and sessions screens, root wiring"
```

---

### Task 7: Session screen — rendering (spec 10.5)

**Files:**
- Create: `apps/mobile/src/screen/Cursor.tsx`, `apps/mobile/src/screen/ScreenRow.tsx`,
  `apps/mobile/src/screen/ScreenView.tsx`, `apps/mobile/app/c/[fp]/s/[sid].tsx`
  (rendering half; input in Task 8)

- [ ] **Step 1: `Cursor` and `ScreenRow`**

The cursor is rendered **inside the row cell it belongs to**, so it scrolls with the virtualised
list. An absolutely-positioned sibling of the `FlashList` would sit at
`history.length * lineHeight` — up to 50 000 px down a scroll container it does not move with, i.e.
never visible.

`src/screen/Cursor.tsx`:

```tsx
import { useEffect } from "react";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const SOLID = 0.7;
/** spec 8.13/10.6: a herdr cursor is inferred from output, so it is drawn faintly. */
const INFERRED = 0.25;

export function Cursor({
  left,
  width,
  height,
  accent,
  blinking,
  inferred,
}: {
  left: number;
  width: number;
  height: number;
  accent: string;
  blinking: boolean;
  inferred: boolean;
}) {
  const base = inferred ? INFERRED : SOLID;
  const opacity = useSharedValue(base);
  useEffect(() => {
    opacity.value = blinking
      ? withRepeat(withTiming(0, { duration: 500 }), -1, true)
      : withTiming(base, { duration: 120 });
  }, [blinking, base, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", left, top: 0, width, height, backgroundColor: accent },
        style,
      ]}
    />
  );
}
```

`src/screen/ScreenRow.tsx`:

```tsx
import { memo } from "react";
import { View } from "react-native";
import type { KeyedLine } from "../store/screen";
import { Cursor } from "./Cursor";
import { LineView } from "./LineView";

export interface RowCursor {
  x: number;
  y: number;
  accent: string;
  blinking: boolean;
  inferred: boolean;
}

/**
 * One list cell. `screenIndex` is the row's position on the live screen (negative for history
 * rows), so the cursor is drawn by the cell that owns it and scrolls with the list.
 */
export const ScreenRow = memo(function ScreenRow({
  line,
  fontSize,
  screenIndex,
  cursor,
}: {
  line: KeyedLine;
  fontSize: number;
  screenIndex: number;
  cursor: RowCursor | null;
}) {
  const lineHeight = fontSize * 1.25;
  const charWidth = fontSize * 0.6;
  const showCursor = cursor !== null && cursor.y === screenIndex;
  return (
    <View style={{ height: lineHeight }}>
      <LineView line={line} fontSize={fontSize} />
      {showCursor ? (
        <Cursor
          left={cursor.x * charWidth}
          width={charWidth}
          height={lineHeight}
          accent={cursor.accent}
          blinking={cursor.blinking}
          inferred={cursor.inferred}
        />
      ) : null}
    </View>
  );
});
```

- [ ] **Step 2: `ScreenView`**

`contentContainerStyle={{ flexGrow: 1, width: contentWidth }}` on the horizontal `ScrollView` is
load-bearing: without `flexGrow` the inner `flex: 1` view collapses and the list has zero height.

```tsx
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useUiStore } from "../store/computers";
import type { KeyedLine, ViewState } from "../store/screen";
import { tokens } from "../theme/tokens";
import { type RowCursor, ScreenRow } from "./ScreenRow";

export function ScreenView({
  view,
  accent,
  blinking,
  inferredCursor,
  onLoadOlder,
}: {
  view: ViewState;
  accent: string;
  blinking: boolean;
  inferredCursor: boolean;
  onLoadOlder: () => void;
}) {
  const { width } = useWindowDimensions();
  const fontSizeSetting = useUiStore((s) => s.fontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fontSize = fitWidth
    ? Math.max(5, (width - 16) / view.state.cols / 0.6)
    : fontSizeSetting;
  const charWidth = fontSize * 0.6;
  const lineHeight = fontSize * 1.25;
  const contentWidth = Math.max(width, view.state.cols * charWidth + 16);
  const list = useRef<FlashListRef<KeyedLine>>(null);
  const [following, setFollowing] = useState(true);
  const startScale = useRef(fontSizeSetting);
  const histLen = view.state.history.length;

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.current = fontSizeSetting;
    })
    .onUpdate((e) => setFontSize(Math.round(startScale.current * e.scale)))
    .runOnJS(true);

  useEffect(() => {
    if (following) list.current?.scrollToEnd({ animated: false });
  }, [following]);

  const cursor: RowCursor | null =
    view.state.cursor.y >= 0
      ? {
          x: view.state.cursor.x,
          y: view.state.cursor.y,
          accent,
          blinking,
          inferred: inferredCursor,
        }
      : null;

  const renderItem = useCallback(
    ({ item, index }: { item: KeyedLine; index: number }) => (
      <ScreenRow
        line={item}
        fontSize={fontSize}
        screenIndex={index - histLen}
        cursor={cursor}
      />
    ),
    [fontSize, histLen, cursor],
  );

  return (
    <GestureDetector gesture={pinch}>
      <View style={{ flex: 1 }}>
        <ScrollView
          horizontal
          bounces={false}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ flexGrow: 1, width: contentWidth }}
        >
          <View style={{ flex: 1, width: contentWidth }}>
            <FlashList
              ref={list}
              data={view.keyed}
              keyExtractor={(l) => l.key}
              renderItem={renderItem}
              maintainVisibleContentPosition={{
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 0.1,
              }}
              onStartReached={onLoadOlder}
              onStartReachedThreshold={0.2}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const atEnd =
                  contentOffset.y + layoutMeasurement.height >= contentSize.height - lineHeight * 2;
                setFollowing(atEnd);
              }}
              scrollEventThrottle={100}
              contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
            />
          </View>
        </ScrollView>
        {following ? null : (
          <Pressable
            onPress={() => {
              setFollowing(true);
              list.current?.scrollToEnd({ animated: true });
            }}
            style={{
              position: "absolute",
              alignSelf: "center",
              bottom: 12,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: tokens.radius.lg,
              backgroundColor: tokens.surface2,
              borderWidth: 1,
              borderColor: tokens.border,
            }}
          >
            <Text style={{ color: tokens.text }}>↓ Jump to live</Text>
          </Pressable>
        )}
      </View>
    </GestureDetector>
  );
}
```

If FlashList v2 rejects any prop above (for example `style`, deliberately omitted here), use only
what the installed version documents.

- [ ] **Step 3: Session route (rendering half)**

`app/c/[fp]/s/[sid].tsx`. History fetching honours `oldestAvailable` (spec 10.5): without it the
list re-requests forever once it reaches the top of a short scrollback.

```tsx
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { connectionManager } from "../../../../src/net/manager";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { useConnectionsStore } from "../../../../src/store/connections";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { StatusOverlay } from "../../../../src/ui/StatusOverlay";
import { backendLabel, cursorIsInferred } from "../../../../src/util/backends";
import { sidFromRoute } from "../../../../src/util/routes";
import { cursorBlinks, statePill } from "../../../../src/util/session-state";

export default function Session() {
  useKeepAwake();
  const { fp, sid } = useLocalSearchParams<{ fp: string; sid: string }>();
  const router = useRouter();
  const sessionId = sidFromRoute(sid ?? "");
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const session = conn?.sessions.find((s) => s.id === sessionId);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
  const inFlight = useRef(false);

  useEffect(() => {
    const c = connectionManager.get(fp ?? "");
    c?.subscribe(sessionId);
    useConnectionsStore.getState().patch(fp ?? "", (x) => ({
      unread: { ...x.unread, [sessionId]: 0 },
    }));
    return () => {
      c?.subscribe(null);
    };
  }, [fp, sessionId, conn?.status]);

  const view = conn?.view?.sessionId === sessionId ? conn.view.view : undefined;
  const oldest = conn?.oldestAvailable[sessionId];

  const loadOlder = useCallback(() => {
    const c = connectionManager.get(fp ?? "");
    if (!c || !view || inFlight.current) return;
    const from = view.state.historyFrom;
    // Spec 10.5: stop at the top, and stop once the agent says there is nothing older.
    if (from <= 0) return;
    if (oldest !== undefined && from <= oldest) return;
    inFlight.current = true;
    void c
      .request({
        type: "history.get",
        reqId: c.newReqId(),
        sessionId,
        before: from,
        count: 200,
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
      });
  }, [fp, sessionId, view, oldest]);

  const pill = session ? statePill(session.state) : null;
  const title = session
    ? `${session.title}${pill ? ` · ${pill.label}` : ""}`
    : "Session";
  const dimmed = conn?.status !== "online";
  const overlay = !conn?.agentOnline
    ? `${computer?.name ?? "Computer"} is offline`
    : "Reconnecting…";

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen
        options={{ title, headerBackTitle: session ? backendLabel(session.backend) : undefined }}
      />
      {!session && !view ? (
        <EmptyState
          text="Session ended."
          action={{ label: "Back", onPress: () => router.back() }}
        />
      ) : !view ? (
        <EmptyState text="Waiting for output…" />
      ) : (
        <ScreenView
          view={view}
          accent={accent}
          blinking={cursorBlinks(session?.state ?? "unknown")}
          inferredCursor={cursorIsInferred(session?.backend ?? "")}
          onLoadOlder={loadOlder}
        />
      )}
      {/* Spec 12: dim the last screen; never unmount it. */}
      {dimmed && view ? <StatusOverlay text={overlay} tone="muted" /> : null}
      {/* InputBar is added in Task 8 */}
    </View>
  );
}
```

- [ ] **Step 4: Verify** — agent verify gate, then **[HUMAN]** on device

**[HUMAN]:** open a session; the screen appears; `for i in $(seq 100); do echo $i; sleep 0.2; done`
tails live; scrolling up stops following and "Jump to live" returns; pull-to-top loads history and
stops at the top; pinch changes font size; `htop` renders; a `herdr` session's cursor is visibly
dimmer than an iTerm2 one.

```bash
git add apps/mobile
git commit -m "feat(mobile): session rendering with in-cell cursor, bounded history, fit width"
```

---

### Task 8: Session screen — input (spec 7.4, 10.6), settings screens

**Files:**
- Create: `apps/mobile/src/input/differ.ts`, `src/input/keys.ts`, `src/input/InputBar.tsx`,
  `src/input/QuickKeys.tsx`, `src/input/ReplyChips.tsx`, `apps/mobile/test/differ.test.ts`,
  `apps/mobile/app/c/[fp]/settings.tsx`, `apps/mobile/QA.md`
- Modify: `app/c/[fp]/s/[sid].tsx` (mount `InputBar`, render `conn.toast`),
  `app/c/[fp]/_layout.tsx` (header `⋯` menu), `app/settings.tsx` (full build-out)

**Interfaces:**
- `differ.ts`: `KeyAction = { kind: "text"; text: string } | { kind: "backspace"; count: number }`,
  `diffTyped(prev, next): KeyAction[]`.
- `keys.ts`: `QUICK_KEYS: { label: string; key: NamedKey }[]` = Esc, Tab, ^C, ^D, ^Z, ^L, ^U, ↑, ↓,
  ←, →, ⏎, ^R, ^A, ^E (Paste is a separate button).

- [ ] **Step 1: Differ test and implementation**

`test/differ.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffTyped } from "../src/input/differ.js";

describe("diffTyped", () => {
  it("appends, deletes, replaces", () => {
    expect(diffTyped("", "ab")).toEqual([{ kind: "text", text: "ab" }]);
    expect(diffTyped("ab", "a")).toEqual([{ kind: "backspace", count: 1 }]);
    expect(diffTyped("abc", "abd")).toEqual([
      { kind: "backspace", count: 1 },
      { kind: "text", text: "d" },
    ]);
    expect(diffTyped("abc", "abc")).toEqual([]);
    expect(diffTyped("a", "🚀")).toEqual([
      { kind: "backspace", count: 1 },
      { kind: "text", text: "🚀" },
    ]);
  });

  it("handles a middle replacement and a full clear", () => {
    expect(diffTyped("git push", "git pull")).toEqual([
      { kind: "backspace", count: 2 },
      { kind: "text", text: "ll" },
    ]);
    expect(diffTyped("abc", "")).toEqual([{ kind: "backspace", count: 3 }]);
  });
});
```

`src/input/differ.ts`:

```ts
export type KeyAction =
  | { kind: "text"; text: string }
  | { kind: "backspace"; count: number };

/** Code-point aware so a surrogate pair counts as one keystroke. */
export function diffTyped(prev: string, next: string): KeyAction[] {
  const a = Array.from(prev);
  const b = Array.from(next);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const out: KeyAction[] = [];
  const removed = a.length - common;
  if (removed > 0) out.push({ kind: "backspace", count: removed });
  const added = b.slice(common).join("");
  if (added) out.push({ kind: "text", text: added });
  return out;
}
```

- [ ] **Step 2: Input components**

`src/input/InputBar.tsx`. The raw-mode field **keeps its previous value** between keystrokes: it is
the differ, not `onKeyPress`, that produces deletions (spec 10.6 — "shortened by `k` → `k ×`
backspace; replaced middle → backspaces then the new suffix"). Clearing the value on every change
would make the differ's backspace path dead code and leave Android deletion broken.

```tsx
import type { NamedKey } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { connectionManager } from "../net/manager";
import { useUiStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { Bar } from "../ui/Bar";
import { diffTyped } from "./differ";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";

export function InputBar({
  fp,
  sessionId,
  accent,
  showChips,
}: {
  fp: string;
  sessionId: string;
  accent: string;
  showChips: boolean;
}) {
  const raw = useUiStore((s) => s.rawModeBySession[sessionId] ?? false);
  const setRaw = useUiStore((s) => s.setRawMode);
  const [text, setText] = useState("");
  const [rawText, setRawText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const rawPrev = useRef("");

  const conn = () => connectionManager.get(fp);
  const track = (reqId: string) =>
    useConnectionsStore.getState().patch(fp, (c) => ({
      pendingInputs: { ...c.pendingInputs, [reqId]: { at: Date.now(), sessionId } },
    }));

  type Req = Parameters<NonNullable<ReturnType<typeof conn>>["request"]>[0];
  const fire = (msg: Req) => {
    const c = conn();
    if (!c) return;
    track(msg.reqId);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void c.request(msg).catch(() => undefined);
  };

  const sendLine = (line: string) => {
    const c = conn();
    if (!c) return;
    fire({ type: "input.line", reqId: c.newReqId(), sessionId, text: line });
    useConnectionsStore.getState().patch(fp, (x) => ({
      history: [...x.history.filter((h) => h !== line), line].slice(-100),
    }));
  };
  const sendKey = (key: NamedKey) => {
    const c = conn();
    if (c) fire({ type: "input.key", reqId: c.newReqId(), sessionId, key });
  };
  const sendText = (t: string) => {
    const c = conn();
    if (c && t) fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: t });
  };
  const paste = async () => sendText(await Clipboard.getStringAsync());

  const browseHistory = () => {
    const h = useConnectionsStore.getState().read(fp).history;
    if (h.length === 0) return;
    const idx = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
    setHistIdx(idx);
    setText(h[idx] ?? "");
  };

  /** Raw mode: diff against the previous value, then keep it as the new baseline. */
  const onRawChange = (next: string) => {
    for (const a of diffTyped(rawPrev.current, next)) {
      if (a.kind === "text") sendText(a.text);
      else for (let i = 0; i < a.count; i++) sendKey("backspace");
    }
    rawPrev.current = next;
    setRawText(next);
  };

  const submitRaw = () => {
    sendKey("enter");
    rawPrev.current = "";
    setRawText("");
  };

  const submitLine = () => {
    if (!text.trim()) return;
    sendLine(text);
    setText("");
    setHistIdx(-1);
  };

  return (
    <Bar style={{ gap: 6 }}>
      {showChips ? <ReplyChips onLine={sendLine} onKey={sendKey} accent={accent} /> : null}
      <QuickKeys onKey={sendKey} onPaste={() => void paste()} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityLabel={raw ? "Switch to line mode" : "Switch to raw mode"}
          onPress={() => setRaw(sessionId, !raw)}
          style={{
            width: 40,
            height: 40,
            borderRadius: tokens.radius.md,
            borderWidth: 1,
            borderColor: raw ? accent : tokens.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: raw ? accent : tokens.textMuted }}>⌨︎</Text>
        </Pressable>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: tokens.surface2,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: tokens.border,
            paddingLeft: 12,
          }}
        >
          <Text style={{ color: accent, fontWeight: "700" }}>{raw ? "»" : "$"}</Text>
          <TextInput
            value={raw ? rawText : text}
            onChangeText={
              raw
                ? onRawChange
                : (t) => {
                    setText(t);
                    setHistIdx(-1);
                  }
            }
            onSubmitEditing={raw ? submitRaw : submitLine}
            blurOnSubmit={false}
            placeholder={raw ? "raw keystrokes (no CJK IME)" : "command…"}
            placeholderTextColor={tokens.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            textContentType="none"
            keyboardType={
              raw ? (Platform.OS === "ios" ? "ascii-capable" : "visible-password") : "default"
            }
            returnKeyType="send"
            style={{
              flex: 1,
              color: tokens.text,
              paddingVertical: 10,
              paddingHorizontal: 8,
              fontSize: 15,
            }}
          />
          {raw ? null : (
            <Pressable accessibilityLabel="Previous command" onPress={browseHistory}
              style={{ padding: 8 }}>
              <Text style={{ color: tokens.textMuted }}>↑</Text>
            </Pressable>
          )}
        </View>
        {raw ? null : (
          <Pressable
            accessibilityLabel="Send"
            onPress={submitLine}
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.md,
              backgroundColor: text.trim() ? accent : tokens.surface2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: text.trim() ? "#000" : tokens.textFaint, fontWeight: "700" }}>
              ↩
            </Text>
          </Pressable>
        )}
      </View>
    </Bar>
  );
}
```

`src/input/QuickKeys.tsx`: a horizontal `ScrollView` of `Pressable`s built from `QUICK_KEYS`, each
with `accessibilityLabel` set to its label (spec 10.9 accessibility), plus a "Paste" button. React
keys come from `key.key` (a `NamedKey`, unique), never the index.

`src/input/ReplyChips.tsx`: four chips — `y ⏎` → `onLine("y")`, `n ⏎` → `onLine("n")`, `⏎` →
`onKey("enter")`, `Esc` → `onKey("esc")` — tinted with `accent`.

- [ ] **Step 3: Mount input, toast, and the header menu**

In `app/c/[fp]/s/[sid].tsx`, below `ScreenView`:

```tsx
        <InputBar
          fp={fp ?? ""}
          sessionId={sessionId}
          accent={accent}
          showChips={wantsReply(
            session?.state ?? "unknown",
            conn?.events[sessionId]?.at(-1)?.kind,
          )}
        />
        {conn?.toast ? (
          <Toast
            text={conn.toast}
            onDone={() =>
              useConnectionsStore.getState().patch(fp ?? "", () => ({ toast: undefined }))
            }
          />
        ) : null}
```

`wantsReply` (Task 6) is what makes a `blocked` session offer y/n — that is exactly the case the
chips exist for. Wrap the screen in `KeyboardAvoidingView` (`behavior="padding"` on iOS).

Header `⋯` menu in `app/c/[fp]/_layout.tsx`: an `Alert.alert` whose actions are filtered by the
capabilities reported for **this session's** backend in `hello.backends` —

```tsx
const backend = backendOf(sessionId);
const caps = conn?.hello?.backends.find((b) => b.name === backend)?.capabilities;
const strict = asBackendName(backend);
```

- "Bring to front on Mac" — only when `caps?.focus` (true for iTerm2 and Herdr, false for tmux).
- `newSessionLabel(backend)`, "Split vertical", "Split horizontal" — only when
  `caps?.createSession` **and** `strict !== null`, since `session.create` reaches the agent's strict
  parser.
- "Cancel".

- [ ] **Step 4: Settings screens**

`app/c/[fp]/settings.tsx`: computer name (read-only, from `hello`), backend badges from
`hello.backends` via `backendLabel`, accent picker (8 colours → `update(fp, { accent })`),
"Notifications for this computer" switch → `update(fp, { pushEnabled })` (read by Plan 06's
push-token provider), "Unpair" → confirm → `connectionManager.get(fp)?.close("user")`,
`deletePairSecret(fp)`, `remove(fp)`, navigate home. Sending the `unpair` ctrl to the relay is Plan
06 (`unpairSelf(fp)`); until then the computer keeps the pairing until the user runs
`shellbell unpair`, and this screen says so in one line.

`app/settings.tsx` (replacing the Task 1 placeholder, keeping the Task 3 self-test): this phone's
name and fingerprint from `loadOrCreateIdentity()`, font-size stepper (5–24) and "Fit width" switch
from `useUiStore`, "Crypto self-test" (Task 3 Step 3), a `__DEV__`-only link to `/dev/render-spike`,
a one-line note that raw mode does not support CJK IME composition (spec 10.6), About (version, MIT,
repo link) and the Buy Me a Coffee link.

- [ ] **Step 5: QA checklist**

`apps/mobile/QA.md` — every line is **[HUMAN]**:

```markdown
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
```

- [ ] **Step 6: Verify and commit**

Agent runs the verify gate. **[HUMAN]** runs the QA list on a device.

```bash
git add apps/mobile
git commit -m "feat(mobile): input bar (line/raw/keys/chips), settings screens, QA checklist"
```

---

## Plan self-review

- **Spec coverage:** 10.6 unknown-enum tolerance → **Task 0** (protocol, not a screen hack);
  10.1/10.2 scaffold, routes, base64url ids → Tasks 1, 3; 10.5 rendering + spike + FlashList v2
  props + fixed-width path + in-cell cursor + dimmed Herdr cursor → Tasks 2, 6, 7; 6.2/6.3/10.7
  identity, SecureStore, bootstrap, self-test → Tasks 1, 3; 10.3 stores incl. memory-only history
  and `oldestAvailable` → Tasks 3, 4; 6.5–6.7/10.4/11.3/12 connection, handshake, leases, permanent
  vs transient failures, immediate background close, pending-input toast on any drop, dim-not-
  unmount → Task 4; 6.4 phone side + 10.7 confirmation sheet and copy → Task 5; 10.9 tokens, `Bar`
  with `isGlassEffectAPIAvailable`, computers/sessions screens, backend labels, `blocked` pill,
  `session.create` → Task 6; 10.6 input incl. raw-mode keyboard settings, persistent differ
  baseline, capability-filtered header menu, settings → Task 8; 15 mobile tests + QA → Tasks 3, 4,
  6, 8.
- **Deferred to Plan 06 (explicitly, not by omission):** 10.8 notifications end to end; the deep
  link handler for `shellbell://c/<fp>/s/<sid>` (the `scheme` is registered here so routes already
  resolve); `eas init` and the real `extra.eas.projectId`; `unpairSelf(fp)`; the `frontend-design`
  polish pass; `notificationAsync(Warning)` haptic when an event arrives for the viewed session.
- **Known limitations, recorded not hidden:** (a) `auth-fail.reason` and `pairing-reject.reason`
  stay strict enums, so a reason introduced by a newer relay surfaces as a generic pairing error —
  R54 ruling 1 scopes loose parsing to the three session enums; (b) `expo export` in Task 1 Step 6
  is the headless Metro check — if a future SDK makes it contact an Expo service it becomes
  **[HUMAN]** and the `npx tsx` import check is the agent-runnable substitute; (c) unknown backends
  render and can be viewed but get no "New …" action, because `session.create` reaches the agent's
  strict parser.
- **Type consistency:** `Status`/`ErrorKind` are defined once in `store/connections.ts` and used by
  `connection.ts` and every screen; `StatusExtra` lives with the connection that raises it;
  `ViewState`/`KeyedLine` are produced by `store/screen.ts` and consumed by `manager.ts`,
  `ScreenView` and `ScreenRow`; `ComputerConnection.request` takes a message with `reqId` and
  `InputBar.fire` passes exactly that type; `asBackendName` is the only bridge from the loose
  `SessionInfoLoose.backend` to the strict `BackendName` the wire requires; `Computer.pushEnabled`
  exists now so Plan 06 can read it.
- **Placeholders:** `REPLACE_AFTER_eas_init` in `app.json` (filled by Plan 06);
  `<PASTE_SHA256_ON_FIRST_RUN>` in `test/loose.test.ts` (filled in Task 0 Step 4); the `__` device
  measurements in `docs/spike-render.md` (filled by a human in Task 2 Step 3). Nothing else.

---

## Pre-execution corrections (2026-09-05)

Applied from the pre-flight consistency scan
(`.superpowers/sdd/2026-09-03-shellbell-05-mobile/preflight-scan.md`, 72 rows) under coordinator
rulings R54. Row ids in brackets.

**Protocol / shipped-code drift (§1)**
- [1.1] Backend labels now go through `backendLabel()` in `src/util/backends.ts`; the
  `iterm2 ? … : "tmux"` ternary that mislabelled every Herdr session is gone from the sessions list,
  the session header and the header menu (Tasks 6, 7, 8).
- [1.2] `newSession` builds its actions from `hello.backends` and narrows through `asBackendName()`;
  the hard `TS2345` from assigning `BackendName` to `"iterm2" | "tmux"` is removed (Task 6).
- [1.3] `blocked` gets its own alert pill via `statePill()`, distinct from `running` (Task 6).
- [1.4] Reply chips now trigger on `state === "blocked"` and `event.kind === "blocked"` through
  `wantsReply()` (Tasks 6, 8).
- [1.5] `Cursor` takes an `inferred` prop; `cursorIsInferred("herdr")` dims it to 0.25 (Task 7).
- [1.6] Unknown-enum tolerance became **Task 0**: `BackendNameLooseSchema`,
  `SessionStateLooseSchema`, `EventKindLooseSchema`, `SessionInfoLooseSchema`, `parseInnerLoose`,
  `parseCtrlLoose` in `packages/protocol`, with tests proving an unknown `backend: "zsh"` parses
  loosely and fails strictly, and that the golden vectors are byte-identical. The agent and relay
  keep the strict parsers; the phone uses the loose ones everywhere.
- [1.7] `PERMANENT_AUTH_FAIL` mirrors `relay-client.ts`: `bad-sig`/`fp-mismatch` → `rejected`,
  `not-paired` → `unpaired`, both permanent (Task 4).
- [1.8] `PERMANENT_CLOSE` (`4004`, `4005`, `4400`, `4403`) stops the connection;
  `KEEP_BACKOFF_CLOSE` (`4413`, `4429`) reconnects at the maximum interval without resetting the
  attempt counter (Task 4).
- [1.9] `auth-ok.minFrameMs` is stored and exposed as `frameIntervalMs` instead of being discarded
  (Task 4).
- [1.10] `pairing-reject` `too-many` and `window-closed` map to their own copy; `too-many` gets a
  new user-facing string (Task 5).
- [1.11] A `gen` gap now sends `snapshot.get` from the controller and leaves the stale view in place
  until the snapshot lands; documented as the deliberate reading of spec 10.3 (Task 4).
- [1.12] `history.oldestAvailable` is persisted per session in `ComputerConn.oldestAvailable`
  (Tasks 3, 4) and gates `loadOlder` (Task 7).

**Task pairs (§2)**
- [2.1, 2.2, 2.3] Task 1 now creates placeholder `app/pair.tsx` and `app/settings.tsx` alongside
  `app/index.tsx`, so every `Stack.Screen` names a route that exists and Tasks 2/3 have a file to
  extend.
- [2.4] Task 6 Step 5 states that session rows are inert until Task 7.
- [2.5] `src/store/connections.ts` carries an explicit "must stay RN-import-free" note.
- [2.6] The lost-input toast moved into `noteLostInputs`, called from `onStatus` on **any** drop as
  well as from `closeAll` (spec 12).
- [2.7, 2.8] No change needed; recorded.

**Per-task self-consistency (§3)**
- [3.1] Task 1 Step 2 sets `"main": "expo-router/entry"` and deletes the template `App.tsx` and
  `index.ts`.
- [3.2] `expo-env.d.ts` is committed (and un-ignored) so `__DEV__` and the Expo ambient types exist
  for a clean-checkout `pnpm typecheck`.
- [3.3] `@types/node@26.4.1` added to `apps/mobile` devDependencies; `tsconfig.json` deliberately
  leaves `types` unset so the hoisted `@types/*` are found; the reliance is documented.
- [3.4, 5.1] `FakeRelay` gains `ctrlFromPhones`; the vacuous
  `expect(relay.received.length).toBeGreaterThanOrEqual(0)` is replaced with real assertions that
  `lease { ttlMs: 60000 }` is sent on `auth-ok` and `lease { ttlMs: 0 }` on `close("background")`.
- [3.5] The background test now asserts on `pendingReqIds()` before and after `close`, so it no
  longer depends on `FakeRelay` omitting `presence`.
- [3.6] `snapshot.get` is sent after the patch, never inside a zustand updater.
- [3.7] `connectAll()` is single-flight per fp via a `starting` set entered before the first
  `await`.
- [3.8] The cursor moved inside the list cell (`ScreenRow`), so it scrolls with the content instead
  of sitting at `history.length * lineHeight` in a non-scrolling sibling.
- [3.9] Both horizontal `ScrollView`s get `contentContainerStyle={{ flexGrow: 1, width }}` so the
  `FlashList` has a bounded height.
- [3.10] Raw mode keeps `rawPrev.current = next` and renders `rawText`, so the differ's backspace
  and mid-string replacement paths are live and the differ test gates real behaviour.
- [3.11] `pairing.ts`'s `onmessage` body is wrapped in `try`/`catch`; every path settles the promise
  exactly once through a single `finish`.
- [3.12] `onclose` maps every close code through `CLOSE_TO_CODE` and falls back to `relay`, so the
  promise can never hang until the timeout on an unexpected close.
- [3.13] `finish` is declared before the timeout that calls it.
- [3.14] `fixtures.ts` computes `n` with `stringCells()`; a vitest case asserts every fixture run's
  declared width matches, replacing the hand-counted (and wrong) `n: 26`.

**Plan vs spec §10 (§4)**
- [4.1] `parsePairingQr` + an `Alert` confirmation sheet naming the computer and its fp prefix run
  **before** any socket opens.
- [4.2] The session header shows the backend label and the state pill, including `blocked`.
- [4.3] The "＋" action list is generated from `hello.backends` with `newSessionLabel`, so
  "New Herdr tab" appears when Herdr is connected.
- [4.4] `StatusOverlay` dims the last screen for offline/reconnecting instead of unmounting it; only
  a terminal `error` replaces the view.
- [4.5] `loadOlder` stops at `historyFrom <= oldestAvailable` and guards against overlapping
  requests with an `inFlight` ref.
- [4.6] `prependHistoryKeyed` caps at `HISTORY_CAP` from the oldest end.
- [4.7] Deep links are explicitly assigned to Plan 06 in the self-review.
- [4.8] "Session ended." now carries a Back action.
- [4.9] `too-many` copy added (see 1.10).
- [4.10] The event haptic is explicitly deferred to Plan 06.
- [4.11] The raw-mode field's placeholder and the settings screen state the CJK IME limitation.

**Rubric (§5)**
- [5.1] See 3.4.
- [5.2] The three-times-duplicated `new ComputerConnection({...})` literal became `makeConn()`.
- [5.3] No React key is an array index: `LineView` derives run keys from the run's starting cell
  offset and style signature, `QuickKeys` keys on the `NamedKey`, lists key on `line.key` /
  `computer.fp` / `session.id`.
- [5.4] Every task's verify step runs `pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test`;
  all snippets are wrapped to Biome's 100 columns and the stray space before a comma in `logLines`
  is gone.
- [5.5, 5.6] No secrets in fixtures and no terminal content in logs — now stated as an explicit
  Global Constraint, and `pair.tsx`'s catch-all uses fixed copy instead of `String(e)`.

**Pins and tooling (§6)**
- [6.1] `metro.config.js` gains a `resolveRequest` shim mapping `@shellbell/protocol` to
  `src/index.ts` and every relative `.js` specifier inside `packages/protocol/src` to its `.ts`
  source, plus `watchFolders` and hoisted `nodeModulesPaths`; Task 1 Step 6 verifies it headlessly
  with a bounded `expo export` plus a grep for a protocol-only symbol, and with an `npx tsx` import
  check as the offline fallback.
- [6.2] The `@noble/*` subpath exports were verified present for 2.4.0; recorded so it is not
  re-litigated.
- [6.3] The on-device vector self-test imports `runVectorChecks` from the package root and its data
  from a committed `src/util/vectors.json` produced by `scripts/sync-vectors.mjs`, which `pnpm test`
  runs and CI checks with `check:vectors`. The non-functional `prebuild` hook is gone.
- [6.4] `expo-splash-screen` added to the install list.
- [6.5] The package is renamed `@shellbell/mobile` and CI filters on that name — no placeholder.
- [6.6] `expo-doctor` is a devDependency and is invoked directly, not through `npx`.
- [6.7] The `node-linker=hoisted` requirement is stated in Global Constraints.
- [6.8] The unused `@/*` `paths` alias is removed.
- [6.9] No change; recorded.
- [6.10] Task 1 keeps the template `.gitignore` (minus `expo-env.d.ts`) so `ios/`/`android/` never
  reach Biome or git.
- [6.11] Recorded: all mobile tests are Node-only, no simulator is needed on `macos-15`, and
  `jest-expo` is deliberately unused.
- [6.12] The worklets-plugin hedge now also covers the duplicate case.
- [6.13] Fonts are pinned by release tag and SHA-256 in `assets/fonts/README.md`, with the OFL 1.1
  text committed as `assets/fonts/LICENSE`.

**Environment hazards (§7)**
- [7.1–7.8] Every device, simulator, network-install, font-download, fps-measurement and
  end-to-end step is tagged **[HUMAN]**; the Global Constraints block states the human-run rule, the
  `perl -e 'alarm N; exec @ARGV'` bounding wrapper, and the ban on `expo start` / `expo run:*` /
  `eas *` from an agent step. `eas.json` is documented as inert until Plan 06.
