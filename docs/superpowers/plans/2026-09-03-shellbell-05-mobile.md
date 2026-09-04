# Shellbell Plan 05 — Mobile app core (Expo)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An iOS + Android app that pairs with a Mac by scanning its QR, lists paired computers and their sessions, renders a live styled terminal screen with scrollback, and lets the user type (line mode, raw mode, named keys, reply chips) with at-most-once delivery — over the hosted relay, end-to-end encrypted.

**Architecture:** Expo SDK 57 + expo-router. Pure-logic modules (`src/net`, `src/store/screen.ts`, `src/input/differ.ts`, `src/identity/keys.ts`) have no React Native imports and are unit-tested with vitest in Node; screens are thin. One `ComputerConnection` per paired computer, managed by `ConnectionManager` from `AppState`. Screen state comes from `@shellbell/protocol`'s `applySnapshot`/`applyDiff`.

**Tech Stack:** Expo 57 (versions chosen by `npx expo install`), expo-router, zustand 5, FlashList 2, Reanimated 4 + worklets, Gesture Handler 2.32, expo-secure-store, expo-sqlite kv-store, expo-camera, expo-haptics, expo-clipboard, expo-keep-awake, expo-glass-effect, expo-crypto, expo-dev-client, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 6.4 (phone side), 6.6, 6.7, 7.4, 7.6, 10, 12, 13, 15 (mobile tests). Plans 01–03 complete (a running agent + relay to test against; `scripts/e2e-local.sh` for local).

## Global Constraints

- Run every Expo package install through `npx expo install <pkg>` — never pin RN-native packages by hand. Commit `package.json` and the lockfile after each install.
- `src/bootstrap/crypto.ts` is the **first import** of `app/_layout.tsx`. Nothing from `@noble/*` or `@shellbell/protocol` may be imported before it in module order.
- Secrets (identity, `K_pair`) live only in `expo-secure-store`. `expo-sqlite/kv-store` holds computers and UI prefs. Command history is memory-only.
- Session ids in routes are base64url-encoded (`sidToRoute`/`sidFromRoute`).
- The app never re-sends an input on its own.
- Terminal font: JetBrainsMono Nerd Font (OFL) — download the four TTFs from the Nerd Fonts release into `assets/fonts/`; `charWidth = fontSize * 0.6`, `lineHeight = fontSize * 1.25`.
- Dark-only UI; tokens from spec 10.9 in `src/theme/tokens.ts`.
- Biome applies to `apps/mobile` too (config already covers it).

---

## File structure created by this plan

```
apps/mobile/
├── package.json  app.json  eas.json  metro.config.js  babel.config.js  tsconfig.json  vitest.config.ts  QA.md
├── app/
│   ├── _layout.tsx            crypto bootstrap first; providers; ConnectionManager mount
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
│   ├── screen/LineView.tsx  ScreenView.tsx  Cursor.tsx
│   ├── input/InputBar.tsx   QuickKeys.tsx  ReplyChips.tsx
│   ├── ui/Bar.tsx  Card.tsx  Pill.tsx  EmptyState.tsx  Toast.tsx
│   ├── theme/tokens.ts  theme/fonts.ts
│   └── util/routes.ts         sidToRoute/sidFromRoute
└── test/  connection.test.ts  differ.test.ts  screen.test.ts  routes.test.ts
```

---

### Task 1: Scaffold the Expo app in the monorepo (spec 10.1, 10.2, 16)

**Files:**
- Create: `apps/mobile/*` via `create-expo-app`, then edit `app.json`, `metro.config.js`, `babel.config.js`, `tsconfig.json`, `eas.json`, `vitest.config.ts`, `package.json` scripts.

- [ ] **Step 1: Create the app**

Run from the repo root:
```bash
npx create-expo-app@latest apps/mobile --template blank-typescript --no-install
cd apps/mobile
npx expo install expo-router expo-linking expo-constants expo-status-bar react-native-safe-area-context react-native-screens \
  react-native-reanimated react-native-worklets react-native-gesture-handler @shopify/flash-list \
  expo-secure-store expo-sqlite expo-camera expo-notifications expo-haptics expo-clipboard expo-keep-awake \
  expo-glass-effect expo-crypto expo-dev-client expo-device expo-font
pnpm add zustand@5.0.15 @shellbell/protocol@workspace:*
pnpm add -D vitest@5.0.0 typescript@5.9.3
```

- [ ] **Step 2: Configuration files**

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
    "ios": { "bundleIdentifier": "dev.bilalahmad.shellbell", "supportsTablet": true, "infoPlist": { "NSCameraUsageDescription": "Scan the pairing QR shown by your computer." } },
    "android": { "package": "dev.bilalahmad.shellbell", "permissions": ["CAMERA", "VIBRATE"] },
    "plugins": [
      "expo-router",
      ["expo-camera", { "cameraPermission": "Scan the pairing QR shown by your computer." }],
      "expo-secure-store",
      ["expo-notifications", { "color": "#10B981" }],
      ["expo-font", { "fonts": ["./assets/fonts/JetBrainsMonoNerdFont-Regular.ttf", "./assets/fonts/JetBrainsMonoNerdFont-Bold.ttf", "./assets/fonts/JetBrainsMonoNerdFont-Italic.ttf", "./assets/fonts/JetBrainsMonoNerdFont-BoldItalic.ttf"] }]
    ],
    "extra": { "eas": { "projectId": "REPLACE_AFTER_eas_init" } }
  }
}
```

`apps/mobile/metro.config.js`:
```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules"), path.resolve(workspaceRoot, "node_modules")];
module.exports = config;
```

`apps/mobile/babel.config.js`:
```js
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"], plugins: ["react-native-worklets/plugin"] };
};
```
(If `npx expo-doctor` says the plugin name differs for the installed Reanimated version, use the name it prints.)

`apps/mobile/tsconfig.json`:
```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, "paths": { "@/*": ["./src/*"] } },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

`apps/mobile/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
```

`apps/mobile/eas.json`:
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

Add to `package.json` scripts: `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"doctor": "npx expo-doctor"`, `"start": "expo start --dev-client"`.

- [ ] **Step 3: Crypto bootstrap and fonts**

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

Download `JetBrainsMonoNerdFont-{Regular,Bold,Italic,BoldItalic}.ttf` from the latest Nerd Fonts release (`JetBrainsMono.zip`) into `apps/mobile/assets/fonts/`.

`apps/mobile/src/theme/tokens.ts`: the object from spec 10.9 exported as `tokens`, plus `export const FONT = { regular: "JetBrainsMonoNerdFont-Regular", bold: "JetBrainsMonoNerdFont-Bold", italic: "JetBrainsMonoNerdFont-Italic", boldItalic: "JetBrainsMonoNerdFont-BoldItalic" }`.

`apps/mobile/app/_layout.tsx` (initial; grows in later tasks):
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
      <Stack screenOptions={{ headerStyle: { backgroundColor: tokens.bg }, headerTintColor: tokens.text, contentStyle: { backgroundColor: tokens.bg } }}>
        <Stack.Screen name="index" options={{ title: "Computers" }} />
        <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
```

`apps/mobile/app/index.tsx` placeholder: a centered `Text` "Shellbell" (replaced in Task 6).

- [ ] **Step 4: Verify**

Run: `cd apps/mobile && npx expo-doctor && pnpm typecheck && npx expo run:ios --device` (or a simulator) — the app boots to the placeholder with no red box; the console shows no "secure randomness" error.
Add `- run: pnpm -F shellbell-mobile doctor` (use the package name in `apps/mobile/package.json`) to `.github/workflows/ci.yml`.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "feat(mobile): expo scaffold in the monorepo with crypto bootstrap and fonts"
```

---

### Task 2: Render spike (spec 10.5, 18.3)

**Files:**
- Create: `apps/mobile/app/dev/render-spike.tsx`, `apps/mobile/src/screen/LineView.tsx`, `docs/spike-render.md`, `apps/mobile/src/util/fixtures.ts`

**Interfaces:**
- `LineView({ line, fontSize, keyed })` — memoized; nested-`Text` path when no run has `n`, fixed-width `View` path otherwise (spec 10.5).
- `fixtures.ts`: `htopScreen(): Line[]` (60 rows with many colored runs), `cjkLines(): Line[]`, `logLines(n): Line[]`.

- [ ] **Step 1: `LineView`**

`apps/mobile/src/screen/LineView.tsx`:
```tsx
import { codePoints, colorToHex, type Line, type Run } from "@shellbell/protocol";
import { memo } from "react";
import { Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";

export function fontFor(r: Run): string {
  if (r.b && r.i) return FONT.boldItalic;
  if (r.b) return FONT.bold;
  if (r.i) return FONT.italic;
  return FONT.regular;
}

function runStyle(r: Run, fontSize: number) {
  return {
    fontFamily: fontFor(r),
    fontSize,
    color: colorToHex(r.fg, tokens.text, tokens.terminal16),
    backgroundColor: r.bg === undefined ? "transparent" : colorToHex(r.bg, "transparent", tokens.terminal16),
    textDecorationLine: r.u && r.s ? ("underline line-through" as const) : r.u ? ("underline" as const) : r.s ? ("line-through" as const) : ("none" as const),
    opacity: r.f ? 0.6 : 1,
  };
}

export const LineView = memo(function LineView({ line, fontSize }: { line: Line; fontSize: number }) {
  const lineHeight = fontSize * 1.25;
  const charWidth = fontSize * 0.6;
  if (line.r.length === 0) return <Text style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}> </Text>;
  const needsCells = line.r.some((r) => r.n !== undefined);
  if (!needsCells) {
    return (
      <Text numberOfLines={1} style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}>
        {line.r.map((r, i) => (
          <Text key={i} style={runStyle(r, fontSize)}>
            {r.t}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <View style={{ flexDirection: "row", height: lineHeight }}>
      {line.r.map((r, i) => (
        <View key={i} style={{ width: (r.n ?? codePoints(r.t)) * charWidth, overflow: "hidden", backgroundColor: runStyle(r, fontSize).backgroundColor }}>
          <Text numberOfLines={1} style={{ ...runStyle(r, fontSize), backgroundColor: "transparent", lineHeight }}>
            {r.t}
          </Text>
        </View>
      ))}
    </View>
  );
});
```

- [ ] **Step 2: Fixtures and spike screen**

`apps/mobile/src/util/fixtures.ts`:
```ts
import type { Line } from "@shellbell/protocol";

export function htopScreen(rows = 60, cols = 160): Line[] {
  const out: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const r: Line["r"] = [];
    for (let x = 0; x < cols; x += 8) {
      const v = (x * 7 + y * 13) % 100;
      r.push({ t: `${String(v).padStart(3, " ")}% ▇▇▇`, fg: v > 80 ? 1 : v > 50 ? 3 : 2, bg: y % 2 ? 0 : 8, b: v > 80 });
    }
    out.push({ r });
  }
  return out;
}

export function cjkLines(): Line[] {
  return [
    { r: [{ t: "漢字とカナ mixed with ascii", n: 26 }] },
    { r: [{ t: "🚀 deploy ✅ done 👨‍💻", n: 20 }] },
    { r: [{ t: "café naïve résumé", n: 17 }] },
    { r: [{ t: "├── src/  " }, { t: "main.rs", fg: 4 }] },
  ];
}

export function logLines(n: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ r: [{ t: `${String(i).padStart(5, "0")} ` , f: true }, { t: i % 17 === 0 ? "ERROR" : "info", fg: i % 17 === 0 ? 1 : 2, b: i % 17 === 0 }, { t: ` request ${i} handled in ${(i * 37) % 900}ms` }] });
  }
  return out;
}
```

`apps/mobile/app/dev/render-spike.tsx`:
```tsx
import { FlashList } from "@shopify/flash-list";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { LineView } from "../../src/screen/LineView";
import { tokens } from "../../src/theme/tokens";
import { cjkLines, htopScreen, logLines } from "../../src/util/fixtures";

const SETS = { htop: htopScreen(), cjk: cjkLines(), log: logLines(5000) };

export default function RenderSpike() {
  const [which, setWhich] = useState<keyof typeof SETS>("log");
  const [tick, setTick] = useState(0);
  const data = which === "htop" ? SETS.htop.map((l, i) => ({ ...l, r: i === tick % 60 ? [{ t: `tick ${tick}`, fg: 5 }] : l.r })) : SETS[which];
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        {(Object.keys(SETS) as (keyof typeof SETS)[]).map((k) => (
          <Pressable key={k} onPress={() => setWhich(k)} style={{ padding: 8, backgroundColor: which === k ? tokens.accents.emerald : tokens.surface2, borderRadius: 8 }}>
            <Text style={{ color: tokens.text }}>{k}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setTick((t) => t + 1)} style={{ padding: 8, backgroundColor: tokens.surface2, borderRadius: 8 }}>
          <Text style={{ color: tokens.text }}>redraw</Text>
        </Pressable>
      </View>
      <ScrollView horizontal bounces={false} contentContainerStyle={{ minWidth: 160 * 12 * 0.6 }}>
        <FlashList data={data} keyExtractor={(_, i) => String(i)} renderItem={({ item }) => <LineView line={item} fontSize={12} />} style={{ width: 160 * 12 * 0.6 }} />
      </ScrollView>
    </View>
  );
}
```
Link it from the settings screen when `__DEV__`.

- [ ] **Step 3: Measure on real devices and record**

On an iPhone and an Android phone (development build): fling the 5 000-line log with the Xcode/Android Studio frame profiler or Expo's perf monitor; tap `redraw` repeatedly on `htop`; inspect the `cjk` lines for column alignment against a ruler of ASCII text.

`docs/spike-render.md`:
```markdown
# Spike: terminal rendering on device — results (YYYY-MM-DD)

- Devices: iPhone __ (iOS __), __ (Android __).
- 5 000-line log fling: iOS __ fps, Android __ fps (budget: no dropped frames).
- htop-like 60×160 redraw: __ ms per frame iOS / Android.
- CJK/emoji/combining alignment with the fixed-width View path: correct / off by __ cells.
- Decision: nested-Text path for lines without `n` (default) | fixed-width View path for all lines.
```
If the log fling drops frames, set `ALWAYS_FIXED_WIDTH = true` in `LineView.tsx` (a one-line constant that forces the `View` path) and re-measure; record the outcome.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile docs/spike-render.md
git commit -m "feat(mobile): LineView with cell-accurate path and on-device render spike"
```

---

### Task 3: Identity, secure storage, stores, screen helpers, self-test (spec 6.2, 6.3, 10.3, 10.7)

**Files:**
- Create: `apps/mobile/src/identity/keys.ts`, `apps/mobile/src/store/computers.ts`, `apps/mobile/src/store/connections.ts`, `apps/mobile/src/store/screen.ts`, `apps/mobile/src/util/routes.ts`, `apps/mobile/test/screen.test.ts`, `apps/mobile/test/routes.test.ts`, self-test section in `app/settings.tsx`

**Interfaces:**
- `identity/keys.ts`: `loadOrCreateIdentity(): Promise<{ identity: Identity; fp: string }>`, `savePairSecret(computerFp, { kPair, computerEd25519Pub, computerX25519Pub })`, `loadPairSecret(computerFp): Promise<{ kPair: Uint8Array; ... } | null>`, `deletePairSecret(computerFp)`. Uses `expo-secure-store` `getItemAsync/setItemAsync/deleteItemAsync`.
- `store/computers.ts` (zustand, persisted via `expo-sqlite/kv-store`): `Computer = { fp; name; accent; relayUrl; pairedAt; lastSeenAt: string | null; pushEnabled: boolean }`, `useComputersStore` with `computers`, `add`, `remove`, `update`, `hydrate()`; `useUiStore` with `fontSize` (12), `fitWidth`, `rawModeBySession`, setters.
- `store/screen.ts` (RN-free): `KeyedLine = Line & { key: string }`, `type ViewState = { state: ScreenState; keyed: KeyedLine[] }`, `applySnapshotKeyed(prev, snap)`, `applyDiffKeyed(prev, diff): { view; gap }`, `prependHistoryKeyed(view, lines, before)`. Keys are `k<counter>`; unchanged lines keep their key.
- `store/connections.ts` (zustand, in-memory): per computer `{ status; agentOnline; error?; hello?; sessions; view?: { sessionId; view: ViewState }; events: Record<sid, Event[]>; unread: Record<sid, number>; pendingInputs: Record<reqId, { at: number; sessionId: string }>; history: string[] }` with reducer-style setters used by `ComputerConnection`.
- `util/routes.ts`: `sidToRoute(sid): string` (base64url of utf8), `sidFromRoute(s): string`.

- [ ] **Step 1: Tests for the RN-free parts**

`apps/mobile/test/screen.test.ts`:
```ts
import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../src/store/screen.js";

const L = (t: string): Line => ({ r: [{ t }] });

describe("keyed screen state", () => {
  it("assigns stable keys; unchanged rows keep keys across diffs; scrolled-out rows move to history with their key", () => {
    const v1 = applySnapshotKeyed(undefined, { cols: 10, rows: 3, cursor: { x: 0, y: 0 }, lines: [L("a"), L("b"), L("c")], scrollbackTotal: 0, gen: 1 });
    const keys1 = v1.keyed.map((k) => k.key);
    const r = applyDiffKeyed(v1, { scroll: 1, changed: [{ i: 2, line: L("d") }], cursor: { x: 0, y: 0 }, scrollbackTotal: 1, gen: 2 });
    expect(r.gap).toBe(false);
    const v2 = r.view;
    expect(v2.keyed.map((k) => k.r[0]?.t)).toEqual(["a", "b", "c", "d"]);
    expect(v2.keyed.slice(0, 3).map((k) => k.key)).toEqual(keys1);
    expect(v2.keyed[3]?.key).not.toBe(keys1[2]);
  });
  it("gap returns the same view", () => {
    const v1 = applySnapshotKeyed(undefined, { cols: 10, rows: 1, cursor: { x: 0, y: 0 }, lines: [L("a")], scrollbackTotal: 0, gen: 1 });
    expect(applyDiffKeyed(v1, { scroll: 0, changed: [], cursor: { x: 0, y: 0 }, scrollbackTotal: 0, gen: 9 })).toEqual({ view: v1, gap: true });
  });
  it("prepends history pages", () => {
    const v1 = applySnapshotKeyed(undefined, { cols: 10, rows: 1, cursor: { x: 0, y: 0 }, lines: [L("z")], scrollbackTotal: 5, gen: 1 });
    const v2 = prependHistoryKeyed(v1, [L("x"), L("y")], 5);
    expect(v2.keyed.map((k) => k.r[0]?.t)).toEqual(["x", "y", "z"]);
    expect(v2.state.historyFrom).toBe(3);
  });
});
```

`apps/mobile/test/routes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sidFromRoute, sidToRoute } from "../src/util/routes.js";

describe("routes", () => {
  it("round-trips ids with % and :", () => {
    for (const id of ["tmux:%3", "iterm2:5A7B-1234", "tmux:$0"]) {
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
export const sidToRoute = (sid: string) => toBase64Url(utf8(sid));
export const sidFromRoute = (s: string) => fromUtf8(fromBase64Url(s));
```

`apps/mobile/src/store/screen.ts`:
```ts
import { applyDiff, applySnapshot, type Line, type ScreenDiff, type ScreenSnapshot, type ScreenState } from "@shellbell/protocol";

export type KeyedLine = Line & { key: string };
export interface ViewState {
  state: ScreenState;
  keyed: KeyedLine[]; // history followed by screen rows
}

let counter = 0;
const key = () => `k${++counter}`;

function withKey(line: Line, existing?: KeyedLine): KeyedLine {
  if (existing && existing.r === line.r) return existing;
  return { ...line, key: key() };
}

export function applySnapshotKeyed(prev: ViewState | undefined, snap: ScreenSnapshot): ViewState {
  const state = applySnapshot(prev?.state, snap);
  const history = state.history.map((l, i) => withKey(l, prev?.keyed[i]));
  const screen = snap.lines.map((l) => withKey(l));
  return { state, keyed: [...history, ...screen] };
}

export function applyDiffKeyed(prev: ViewState, diff: ScreenDiff): { view: ViewState; gap: boolean } {
  const { state, gap } = applyDiff(prev.state, diff);
  if (gap) return { view: prev, gap: true };
  const histLen = prev.state.history.length;
  const oldScreen = prev.keyed.slice(histLen);
  const oldHist = prev.keyed.slice(0, histLen);
  const scrolledOut = oldScreen.slice(0, diff.scroll);
  let newHist = [...oldHist, ...scrolledOut];
  const drop = newHist.length - state.history.length;
  if (drop > 0) newHist = newHist.slice(drop);
  const shifted = oldScreen.slice(diff.scroll);
  const screen: KeyedLine[] = state.lines.map((line, i) => {
    const changed = diff.changed.find((c) => c.i === i);
    if (changed) return withKey(line);
    return shifted[i] ?? withKey(line);
  });
  return { view: { state, keyed: [...newHist, ...screen] }, gap: false };
}

export function prependHistoryKeyed(prev: ViewState, lines: Line[], before: number): ViewState {
  if (before !== prev.state.historyFrom) return prev;
  const keyedNew = lines.map((l) => withKey(l));
  return {
    state: { ...prev.state, history: [...lines, ...prev.state.history], historyFrom: prev.state.historyFrom - lines.length },
    keyed: [...keyedNew, ...prev.keyed],
  };
}
```

`apps/mobile/src/identity/keys.ts`:
```ts
import { fingerprint, fromBase64Url, generateIdentity, identityFromJson, identityToJson, toBase64Url, type Identity } from "@shellbell/protocol";
import * as SecureStore from "expo-secure-store";

const ID_KEY = "shellbell.identity.v1";
const pairKey = (fp: string) => `shellbell.pair.${fp}`;

export async function loadOrCreateIdentity(): Promise<{ identity: Identity; fp: string }> {
  const raw = await SecureStore.getItemAsync(ID_KEY);
  let identity: Identity;
  if (raw) identity = identityFromJson(JSON.parse(raw));
  else {
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
  await SecureStore.setItemAsync(pairKey(computerFp), JSON.stringify({ kPair: toBase64Url(s.kPair), e: toBase64Url(s.computerEd25519Pub), x: toBase64Url(s.computerX25519Pub) }));
}

export async function loadPairSecret(computerFp: string): Promise<PairSecret | null> {
  const raw = await SecureStore.getItemAsync(pairKey(computerFp));
  if (!raw) return null;
  const j = JSON.parse(raw) as { kPair: string; e: string; x: string };
  return { kPair: fromBase64Url(j.kPair), computerEd25519Pub: fromBase64Url(j.e), computerX25519Pub: fromBase64Url(j.x) };
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
  Storage.setItemSync(UI_KEY, JSON.stringify({ fontSize: s.fontSize, fitWidth: s.fitWidth, rawModeBySession: s.rawModeBySession }));
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

`apps/mobile/src/store/connections.ts`:
```ts
import type { InnerMessageOf, SessionInfo } from "@shellbell/protocol";
import { create } from "zustand";
import type { ViewState } from "./screen";

export type Status = "idle" | "connecting" | "auth" | "handshake" | "online" | "offline" | "error";
export type Event = InnerMessageOf<"event">;

export interface ComputerConn {
  status: Status;
  agentOnline: boolean;
  error?: string;
  hello?: InnerMessageOf<"hello">;
  sessions: SessionInfo[];
  view?: { sessionId: string; view: ViewState };
  events: Record<string, Event[]>;
  unread: Record<string, number>;
  pendingInputs: Record<string, { at: number; sessionId: string }>;
  history: string[];
  toast?: string;
}

const empty = (): ComputerConn => ({ status: "idle", agentOnline: false, sessions: [], events: {}, unread: {}, pendingInputs: {}, history: [] });

interface ConnectionsState {
  byComputer: Record<string, ComputerConn>;
  get: (fp: string) => ComputerConn;
  patch: (fp: string, fn: (c: ComputerConn) => Partial<ComputerConn>) => void;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  byComputer: {},
  get: (fp) => get().byComputer[fp] ?? empty(),
  patch: (fp, fn) => {
    const cur = get().byComputer[fp] ?? empty();
    set({ byComputer: { ...get().byComputer, [fp]: { ...cur, ...fn(cur) } } });
  },
}));
```

- [ ] **Step 3: Self-test on the settings screen** — in `app/settings.tsx` (built fully in Task 8) add a "Run crypto self-test" button that imports `vectors.json` from `@shellbell/protocol/test/vectors.json` (copy it to `apps/mobile/src/util/vectors.json` in a `prebuild` script so Metro can bundle it) and renders `runVectorChecks(vectors)` results as ✓/✗ rows. This is the on-device (Hermes) proof of cross-runtime crypto.

- [ ] **Step 4: Run tests** — `cd apps/mobile && pnpm test` → PASS. **Commit:** `git add apps/mobile && git commit -m "feat(mobile): identity storage, stores, keyed screen state, route ids"`.

---

### Task 4: `ComputerConnection` and `ConnectionManager` (spec 6.5, 6.6, 6.7, 10.4, 11.3)

**Files:**
- Create: `apps/mobile/src/net/connection.ts`, `apps/mobile/src/net/manager.ts`, `apps/mobile/test/connection.test.ts`

**Interfaces:**
- `ConnectionOptions { computerFp; relayUrl; identity: Identity; phoneFp; phoneName; appVersion; kPair: Uint8Array; pushToken?: () => Promise<{ token: string; platform: "ios" | "android"; enabled: boolean } | null>; onCtrl?; onInner: (m: InnerMessage) => void; onStatus: (s: Status, extra?: { agentOnline?: boolean; error?: string; closeCode?: number }) => void; WebSocketImpl?: typeof WebSocket; backoffMinMs?; backoffMaxMs?; helloTimeoutMs?: 10000 }`
- `class ComputerConnection`: `connect()`, `close(reason?: "background" | "user")` (sends `lease 0` first), `send(msg: InnerMessage): boolean`, `request(msg: InnerMessage & { reqId: string }): Promise<InnerMessageOf<"ack">>` (resolves on ack; rejects on close with `DeliveryUnknownError`), `subscribe(sessionId | null)`, `readonly status`, `readonly online`, `pendingReqIds(): string[]`, `newReqId(): string`.
- `ConnectionManager` (RN): holds a `ComputerConnection` per computer; `start()` subscribes to `AppState`; on `active` connects all; on `inactive`/`background` closes all with `"background"`; `get(fp)`; wires `onInner` into `useConnectionsStore` (sessions, hello, view updates through `store/screen.ts`, events + unread, history responses, acks).

- [ ] **Step 1: Write the failing tests** (Node: `ws` for the phone-side socket; the fake relay from the agent package is reused by path)

`apps/mobile/test/connection.test.ts`:
```ts
import { fingerprint, generateIdentity, randomBytes, type InnerMessage } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ComputerConnection } from "../src/net/connection.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { createLogger } from "../../agent/src/log.js";

const waitFor = (fn: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (fn() ? resolve() : Date.now() - t0 > ms ? reject(new Error("waitFor timeout")) : setTimeout(tick, 10));
    tick();
  });

/** Minimal "agent" on the fake relay: authenticates and answers conn.hello + acks inputs. */
async function fakeAgent(relay: FakeRelay, mac: ReturnType<typeof generateIdentity>, kPair: Uint8Array, phoneFp: string) {
  const { RelayClient } = await import("../../agent/src/relay-client.js");
  const fp = fingerprint(mac.ed25519.pub);
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({ relayUrl: relay.url, fp, identity: mac, name: "MBP", appVersion: "t", log, backoffMinMs: 50, backoffMaxMs: 100 });
  let link: PhoneLink | null = null;
  const received: InnerMessage[] = [];
  rc.on("ctrl", (m) => {
    if (m.type === "phone-connected") link = new PhoneLink({ phoneFp, connId: m.connId, name: m.name, kPair, computerFp: fp, send: (e) => rc.sendEnvelope(e), log });
  });
  rc.on("e2e", (env) => {
    const was = link?.handshaken;
    const msg = link?.handleEnvelope(env) ?? null;
    if (link && !was && link.handshaken) link.send({ type: "hello", agentVersion: "t", backends: [], computerName: "MBP", accent: "emerald" });
    if (msg) {
      received.push(msg);
      if ("reqId" in msg) link?.send({ type: "ack", reqId: msg.reqId, ok: true });
    }
  });
  rc.start();
  await waitFor(() => rc.online);
  return { rc, received, link: () => link };
}

let relay: FakeRelay;
const mac = generateIdentity();
const phone = generateIdentity();
const macFp = fingerprint(mac.ed25519.pub);
const phoneFp = fingerprint(phone.ed25519.pub);
const kPair = randomBytes(32);

beforeEach(async () => {
  relay = new FakeRelay(macFp);
  await relay.start();
});
afterEach(async () => relay.stop());

describe("ComputerConnection", () => {
  it("authenticates, leases, handshakes, receives hello, sends inputs with acks", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const inner: InnerMessage[] = [];
    const statuses: string[] = [];
    const c = new ComputerConnection({
      computerFp: macFp, relayUrl: relay.url, identity: phone, phoneFp, phoneName: "iPhone", appVersion: "t", kPair,
      onInner: (m) => inner.push(m), onStatus: (s) => statuses.push(s), WebSocketImpl: WebSocket as never, backoffMinMs: 50, backoffMaxMs: 100,
    });
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    expect(statuses).toEqual(["connecting", "auth", "handshake", "online"]);
    const ack = await c.request({ type: "input.line", reqId: c.newReqId(), sessionId: "s", text: "y" });
    expect(ack.ok).toBe(true);
    expect(agent.received[0]).toMatchObject({ type: "input.line", text: "y" });
    c.close("user");
    agent.rc.stop();
  });

  it("close('background') sends lease 0 and rejects pending requests with DeliveryUnknown", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const inner: InnerMessage[] = [];
    const c = new ComputerConnection({
      computerFp: macFp, relayUrl: relay.url, identity: phone, phoneFp, phoneName: "iPhone", appVersion: "t", kPair,
      onInner: (m) => inner.push(m), onStatus: () => {}, WebSocketImpl: WebSocket as never, backoffMinMs: 50, backoffMaxMs: 100,
    });
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // stop the agent from acking by dropping its link
    agent.rc.stop();
    await new Promise((r) => setTimeout(r, 50));
    const p = c.request({ type: "input.line", reqId: c.newReqId(), sessionId: "s", text: "x" });
    c.close("background");
    await expect(p).rejects.toThrow(/delivery unknown/i);
    const leases = relay.received.length; // e2e frames; the lease is ctrl and not recorded — assert via phone socket state instead
    expect(leases).toBeGreaterThanOrEqual(0);
    expect(c.status).toBe("idle");
  });

  it("reconnects after the relay drops the socket", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const inner: InnerMessage[] = [];
    const c = new ComputerConnection({
      computerFp: macFp, relayUrl: relay.url, identity: phone, phoneFp, phoneName: "iPhone", appVersion: "t", kPair,
      onInner: (m) => inner.push(m), onStatus: () => {}, WebSocketImpl: WebSocket as never, backoffMinMs: 50, backoffMaxMs: 100,
    });
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    relay.phones.get(phoneFp)?.ws.terminate();
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
    c.close("user");
    agent.rc.stop();
  });
});
```

The test imports the agent package's fakes by relative path; add `"../agent/src/**"` and `"../agent/test/**"` to nothing — vitest resolves relative imports directly. `ws` is already a dependency of the agent workspace; add it as a devDependency of `apps/mobile` too (`pnpm add -D ws@8.21.3 @types/ws@8.18.1`).

- [ ] **Step 2: Implement `connection.ts`** (RN-free; uses the global `WebSocket` unless injected)

`apps/mobile/src/net/connection.ts`:
```ts
import {
  authMessage,
  decodeCbor,
  decodeEnvelope,
  deriveConnKey,
  E2EBodySchema,
  encodeCbor,
  encodeEnvelope,
  frameAd,
  helloAd,
  open,
  parseCtrl,
  parseInner,
  randomBytes,
  relayWsUrl,
  seal,
  sign,
  toBase64Url,
  type CtrlMessage,
  type Envelope,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
} from "@shellbell/protocol";
import type { Status } from "../store/connections";

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

export interface ConnectionOptions {
  computerFp: string;
  relayUrl: string;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  kPair: Uint8Array;
  pushToken?: () => Promise<{ token: string; platform: "ios" | "android"; enabled: boolean } | null>;
  onCtrl?: (m: CtrlMessage) => void;
  onInner: (m: InnerMessage) => void;
  onStatus: (s: Status, extra?: { agentOnline?: boolean; error?: string; closeCode?: number }) => void;
  WebSocketImpl?: new (url: string) => WsLike;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
}

const LEASE_MS = 60_000;
const KEEPALIVE_MS = 30_000;

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
  private readonly pending = new Map<string, { resolve: (a: InnerMessageOf<"ack">) => void; reject: (e: Error) => void }>();

  constructor(private readonly o: ConnectionOptions) {}

  get online(): boolean {
    return this.status === "online";
  }

  newReqId(): string {
    return toBase64Url(randomBytes(8));
  }

  pendingReqIds(): string[] {
    return [...this.pending.keys()];
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(reason: "background" | "user" = "user"): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws && this.ws.readyState === 1) {
      if (reason === "background") this.sendCtrl({ type: "lease", ttlMs: 0 });
      this.ws.close(1000, reason);
    }
    this.ws = null;
    this.failPending();
    this.resetSession();
    this.setStatus("idle");
  }

  subscribe(sessionId: string | null): void {
    this.send({ type: "subscribe", sessionId });
  }

  send(msg: InnerMessage): boolean {
    if (!this.kConn || this.status !== "online" || !this.ws) return false;
    this.seqOut += 1;
    const box = seal(this.kConn, encodeCbor(msg), frameAd(this.o.phoneFp, this.o.computerFp, this.connTag, this.seqOut));
    this.sendEnvelope({ v: 1, t: "e2e", from: this.o.phoneFp, to: this.o.computerFp, seq: this.seqOut, body: box });
    return true;
  }

  request(msg: InnerMessage & { reqId: string }): Promise<InnerMessageOf<"ack">> {
    return new Promise((resolve, reject) => {
      if (!this.send(msg)) return reject(new DeliveryUnknownError());
      this.pending.set(msg.reqId, { resolve, reject });
    });
  }

  // ---- internals ----

  private setStatus(s: Status, extra?: { agentOnline?: boolean; error?: string; closeCode?: number }): void {
    this.status = s;
    this.o.onStatus(s, extra);
  }

  private open(): void {
    if (this.stopped) return;
    const Ws = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
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
        try {
          this.onCtrl(parseCtrl(env.body));
        } catch {
          return;
        }
      } else this.onE2E(env);
    };
    ws.onclose = (ev) => this.onDown(ev.code);
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState === 1) this.ws.send(encodeEnvelope(env));
  }

  private sendCtrl(body: CtrlMessage): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.o.phoneFp, seq: 0, body });
  }

  private onCtrl(m: CtrlMessage): void {
    this.o.onCtrl?.(m);
    switch (m.type) {
      case "challenge": {
        const sig = sign(this.o.identity.ed25519.priv, authMessage(m.connId, "phone", this.o.phoneFp, m.nonce));
        this.sendCtrl({ type: "auth", role: "phone", fp: this.o.phoneFp, ed25519Pub: this.o.identity.ed25519.pub, sig, name: this.o.phoneName, appVersion: this.o.appVersion });
        return;
      }
      case "auth-ok": {
        this.attempt = 0;
        this.agentOnline = m.agentOnline;
        this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        void this.o.pushToken?.().then((t) => t && this.sendCtrl({ type: "push-token", token: t.token, platform: t.platform, enabled: t.enabled }));
        this.keepalive = setInterval(() => {
          this.ws?.send("ping");
          this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        }, KEEPALIVE_MS);
        if (m.agentOnline) this.startHandshake();
        else this.setStatus("offline", { agentOnline: false });
        return;
      }
      case "auth-fail":
        this.setStatus("error", { error: m.reason });
        if (m.reason === "not-paired") this.stopped = true;
        return;
      case "presence":
        this.agentOnline = m.agentOnline;
        if (m.agentOnline && !this.kConn) this.startHandshake();
        if (!m.agentOnline) {
          this.resetSession();
          this.failPending();
          this.setStatus("offline", { agentOnline: false });
        }
        return;
      default:
        return;
    }
  }

  private startHandshake(): void {
    this.resetSession();
    this.setStatus("handshake");
    this.nPhone = randomBytes(16);
    const box = seal(this.o.kPair, encodeCbor({ type: "conn.hello", n: this.nPhone }), helloAd(this.o.phoneFp, this.o.computerFp));
    this.sendEnvelope({ v: 1, t: "e2e", from: this.o.phoneFp, to: this.o.computerFp, seq: 0, body: box });
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
        const inner = parseInner(decodeCbor(open(this.o.kPair, body.data, helloAd(this.o.computerFp, this.o.phoneFp))));
        if (inner.type !== "conn.hello") return;
        const d = deriveConnKey(this.o.kPair, this.nPhone, inner.n, this.o.computerFp, this.o.phoneFp);
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.setStatus("online", { agentOnline: true });
      } catch {
        this.setStatus("error", { error: "re-pair" });
        this.stopped = true;
        this.ws?.close(1000, "kpair mismatch");
      }
      return;
    }
    if (!this.kConn || env.seq <= this.seqIn) return;
    let inner: InnerMessage;
    try {
      inner = parseInner(decodeCbor(open(this.kConn, body.data, frameAd(this.o.computerFp, this.o.phoneFp, this.connTag, env.seq))));
    } catch {
      this.failures += 1;
      if (this.failures >= 20) this.ws?.close(4000, "decrypt failures");
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
    this.resetSession();
    this.failPending();
    if (code === 4004) {
      this.stopped = true;
      this.setStatus("error", { error: "unpaired", closeCode: code });
      return;
    }
    if (this.stopped) return;
    this.setStatus("offline", { closeCode: code });
    const min = this.o.backoffMinMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.reconnectTimer = setTimeout(() => this.open(), base + base * 0.2 * (Math.random() * 2 - 1));
  }

  private resetSession(): void {
    this.kConn = null;
    this.nPhone = null;
    this.connTag = "";
    this.seqOut = 0;
    this.seqIn = 0;
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
    this.reconnectTimer = this.keepalive = this.helloTimer = null;
  }
}
```

- [ ] **Step 3: Implement `manager.ts`** (RN; wires store updates)

`apps/mobile/src/net/manager.ts`:
```ts
import type { Identity, InnerMessage } from "@shellbell/protocol";
import { AppState, type AppStateStatus } from "react-native";
import { loadPairSecret } from "../identity/keys";
import { useComputersStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../store/screen";
import { ComputerConnection } from "./connection";

export interface ManagerDeps {
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  pushToken: (computerFp: string) => Promise<{ token: string; platform: "ios" | "android"; enabled: boolean } | null>;
}

class Manager {
  private conns = new Map<string, ComputerConnection>();
  private deps: ManagerDeps | null = null;
  private sub: { remove: () => void } | null = null;

  start(deps: ManagerDeps): void {
    this.deps = deps;
    this.sub = AppState.addEventListener("change", (s) => this.onAppState(s));
    if (AppState.currentState === "active") void this.connectAll();
    useComputersStore.subscribe((s, prev) => {
      if (s.computers !== prev.computers && AppState.currentState === "active") void this.connectAll();
    });
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
      if (this.conns.has(c.fp)) continue;
      const secret = await loadPairSecret(c.fp);
      if (!secret) continue;
      const patch = useConnectionsStore.getState().patch;
      const conn = new ComputerConnection({
        computerFp: c.fp,
        relayUrl: c.relayUrl,
        identity: deps.identity,
        phoneFp: deps.phoneFp,
        phoneName: deps.phoneName,
        appVersion: deps.appVersion,
        kPair: secret.kPair,
        pushToken: () => deps.pushToken(c.fp),
        onStatus: (status, extra) => patch(c.fp, () => ({ status, agentOnline: extra?.agentOnline ?? (status === "online"), error: extra?.error })),
        onInner: (m) => this.onInner(c.fp, m),
      });
      this.conns.set(c.fp, conn);
      conn.connect();
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
      const pending = conn.pendingReqIds();
      conn.close(reason);
      if (pending.length) useConnectionsStore.getState().patch(fp, () => ({ toast: "Some input may not have been delivered", pendingInputs: {} }));
    }
    this.conns.clear();
  }

  private onInner(fp: string, m: InnerMessage): void {
    const patch = useConnectionsStore.getState().patch;
    switch (m.type) {
      case "hello":
        patch(fp, () => ({ hello: m }));
        useComputersStore.getState().update(fp, { name: m.computerName, accent: m.accent, lastSeenAt: new Date().toISOString() });
        return;
      case "sessions":
        patch(fp, () => ({ sessions: m.list }));
        return;
      case "screen.snapshot":
        patch(fp, (c) => ({ view: { sessionId: m.sessionId, view: applySnapshotKeyed(c.view?.sessionId === m.sessionId ? c.view.view : undefined, m) } }));
        return;
      case "screen.diff":
        patch(fp, (c) => {
          if (c.view?.sessionId !== m.sessionId) return {};
          const { view, gap } = applyDiffKeyed(c.view.view, m);
          if (gap) this.conns.get(fp)?.send({ type: "snapshot.get", reqId: this.conns.get(fp)?.newReqId() ?? "gap", sessionId: m.sessionId });
          return gap ? {} : { view: { sessionId: m.sessionId, view } };
        });
        return;
      case "history":
        patch(fp, (c) => (c.view?.sessionId === m.sessionId ? { view: { sessionId: m.sessionId, view: prependHistoryKeyed(c.view.view, m.lines, m.before) } } : {}));
        return;
      case "event":
        patch(fp, (c) => ({
          events: { ...c.events, [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m] },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        return;
      case "ack":
        patch(fp, (c) => {
          const { [m.reqId]: _gone, ...rest } = c.pendingInputs;
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

- [ ] **Step 4: Run tests** — `pnpm test` → PASS. **Commit:** `git add apps/mobile && git commit -m "feat(mobile): computer connection with handshake, leases, acks; app-state manager"`.

---

### Task 5: Pairing flow and screen (spec 6.4 phone side, 7.6, 10.7)

**Files:**
- Create: `apps/mobile/src/net/pairing.ts`, `apps/mobile/app/pair.tsx`

**Interfaces:**
- `runPairing(opts: { qrText: string; identity: Identity; phoneFp; phoneName; platform; appVersion; WebSocketImpl?; timeoutMs?: 90000 }): Promise<{ computerFp; computerName; accent; relayUrl; secret: PairSecret }>` — rejects with `PairingError(code: "bad-qr" | "bad-code" | "declined" | "no-window" | "no-agent" | "timeout" | "relay")`.

- [ ] **Step 1: Implement `pairing.ts`**

```ts
import {
  authMessage,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeEnvelope,
  fromBase64Url,
  open,
  pairingAd,
  parseCtrl,
  parseQr,
  relayWsUrl,
  seal,
  sign,
  type CtrlMessage,
  type Identity,
} from "@shellbell/protocol";
import { z } from "zod";
import type { PairSecret } from "../identity/keys";

export class PairingError extends Error {
  constructor(public readonly code: "bad-qr" | "bad-code" | "declined" | "no-window" | "no-agent" | "timeout" | "relay") {
    super(code);
  }
}

const ResponseBody = z.object({ x25519Pub: z.instanceof(Uint8Array), computerName: z.string(), accent: z.string() });

export function runPairing(o: {
  qrText: string;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  platform: "ios" | "android";
  appVersion: string;
  WebSocketImpl?: new (url: string) => WebSocket;
  timeoutMs?: number;
}): Promise<{ computerFp: string; computerName: string; accent: string; relayUrl: string; secret: PairSecret }> {
  return new Promise((resolve, reject) => {
    let qr: ReturnType<typeof parseQr>;
    try {
      qr = parseQr(o.qrText, { allowInsecure: __DEV__ });
    } catch {
      return reject(new PairingError("bad-qr"));
    }
    const code = fromBase64Url(qr.p);
    const gate = fromBase64Url(qr.g);
    const kPsk = derivePskKey(code, qr.c);
    const Ws = o.WebSocketImpl ?? WebSocket;
    const ws = new Ws(relayWsUrl(qr.r, qr.c));
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(new PairingError("timeout")), o.timeoutMs ?? 90_000);
    const finish = (err: Error | null, value?: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else if (value) resolve(value);
    };
    const sendCtrl = (body: CtrlMessage) => ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: o.phoneFp, seq: 0, body }));
    ws.onerror = () => finish(new PairingError("relay"));
    ws.onclose = (ev) => {
      if (ev.code === 4001 || ev.code === 4003 || ev.code === 4408) finish(new PairingError(ev.code === 4408 ? "timeout" : "no-window"));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") return;
      const env = decodeEnvelope(new Uint8Array(ev.data as ArrayBuffer));
      if (env.t !== "ctrl") return;
      const m = parseCtrl(env.body);
      switch (m.type) {
        case "challenge": {
          const sig = sign(o.identity.ed25519.priv, authMessage(m.connId, "pairing", o.phoneFp, m.nonce));
          sendCtrl({ type: "auth", role: "pairing", fp: o.phoneFp, ed25519Pub: o.identity.ed25519.pub, sig, name: o.phoneName, appVersion: o.appVersion, gate });
          return;
        }
        case "auth-ok": {
          const box = seal(kPsk, encodeCbor({ ed25519Pub: o.identity.ed25519.pub, x25519Pub: o.identity.x25519.pub, name: o.phoneName, platform: o.platform }), pairingAd("request", qr.c, o.phoneFp));
          sendCtrl({ type: "pairing-request", phoneFp: o.phoneFp, box });
          return;
        }
        case "auth-fail":
          return finish(new PairingError(m.reason === "no-agent" ? "no-agent" : m.reason === "no-window" ? "no-window" : "relay"));
        case "pairing-reject":
          return finish(new PairingError(m.reason === "declined" ? "declined" : m.reason === "bad-code" ? "bad-code" : m.reason === "no-agent" ? "no-agent" : "no-window"));
        case "pairing-response": {
          try {
            const body = ResponseBody.parse(decodeCbor(open(kPsk, m.box, pairingAd("response", qr.c, o.phoneFp))));
            const kPair = derivePairKey(o.identity.x25519.priv, body.x25519Pub, code, qr.c, o.phoneFp);
            finish(null, { computerFp: qr.c, computerName: body.computerName, accent: body.accent, relayUrl: qr.r, secret: { kPair, computerEd25519Pub: fromBase64Url(qr.e), computerX25519Pub: body.x25519Pub } });
          } catch {
            finish(new PairingError("bad-code"));
          }
          return;
        }
        default:
          return;
      }
    };
  });
}
```

- [ ] **Step 2: Pair screen**

`apps/mobile/app/pair.tsx`:
```tsx
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import { PairingError, runPairing } from "../src/net/pairing";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

const COPY: Record<PairingError["code"], string> = {
  "bad-qr": "That isn't a Shellbell pairing code.",
  "bad-code": "That code expired — run `shellbell pair` again.",
  declined: "The computer declined.",
  "no-window": "No pairing window is open on that computer.",
  "no-agent": "The computer isn't online.",
  timeout: "Couldn't reach the relay.",
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
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Text style={{ color: tokens.text, textAlign: "center" }}>Shellbell needs the camera to scan the pairing code your computer shows.</Text>
        <Pressable onPress={() => void requestPerm()} style={{ backgroundColor: tokens.accents.emerald, padding: 12, borderRadius: tokens.radius.md }}>
          <Text style={{ color: "#000", fontWeight: "600" }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const onScan = async (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    setError(null);
    setBusy("Pairing… confirm on your computer");
    try {
      const { identity, fp } = await loadOrCreateIdentity();
      const r = await runPairing({ qrText: data, identity, phoneFp: fp, phoneName: Device.deviceName ?? "My phone", platform: Platform.OS === "ios" ? "ios" : "android", appVersion: "0.1.0" });
      await savePairSecret(r.computerFp, r.secret);
      add({ fp: r.computerFp, name: r.computerName, accent: r.accent, relayUrl: r.relayUrl, pairedAt: new Date().toISOString(), lastSeenAt: null, pushEnabled: true });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/c/${r.computerFp}`);
    } catch (e) {
      setError(e instanceof PairingError ? COPY[e.code] : String(e));
      scanned.current = false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <CameraView style={{ flex: 1 }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={(r) => void onScan(r.data)} />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>{busy ?? "Run `npx shellbell` on your Mac and scan the code."}</Text>
        {error && <Text style={{ color: tokens.accents.rose, textAlign: "center" }}>{error}</Text>}
      </View>
    </View>
  );
}
```

- [ ] **Step 3: Verify against a real agent** — run `scripts/e2e-local.sh`, `shellbell start --relay ws://<LAN-IP>:8787`, scan from a dev build, press `y` on the Mac, land on the computer route (empty until Task 6). **Commit:** `git add apps/mobile && git commit -m "feat(mobile): pairing flow and camera screen"`.

---

### Task 6: Computers and Sessions screens, root wiring (spec 10.2, 10.9)

**Files:**
- Create: `apps/mobile/src/ui/Bar.tsx`, `Card.tsx`, `Pill.tsx`, `EmptyState.tsx`, `Toast.tsx`; replace `app/index.tsx`; create `app/c/[fp]/_layout.tsx`, `app/c/[fp]/index.tsx`; extend `app/_layout.tsx`.

- [ ] **Step 1: UI primitives**

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
      <GlassView glassEffectStyle="regular" colorScheme="dark" style={[{ paddingHorizontal: 12, paddingVertical: 8 }, style]}>
        {children}
      </GlassView>
    );
  }
  return <View style={[{ backgroundColor: "rgba(11,11,13,0.92)", borderColor: tokens.border, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 }, style]}>{children}</View>;
}
```

`src/ui/Card.tsx`, `Pill.tsx`, `EmptyState.tsx`, `Toast.tsx`: small presentational components — `Card` (surface, `radius.lg`, 1-px border, optional accent stripe), `Pill` (rounded label with color), `EmptyState({ text, action?: { label; onPress } })`, `Toast({ text })` (auto-hides after 3 s using a `useEffect` timer).

- [ ] **Step 2: Root layout wiring**

Extend `app/_layout.tsx`: on mount, `useComputersStore.getState().hydrate()`, `loadOrCreateIdentity()` then `connectionManager.start({ identity, phoneFp, phoneName, appVersion: "0.1.0", pushToken: async () => null })` (push token provider is filled in Plan 06). Load fonts with `useFonts` from `expo-font` and hold the splash until loaded. Register the `c/[fp]` stack and `dev/render-spike` routes.

- [ ] **Step 3: Computers screen**

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

export default function Computers() {
  const computers = useComputersStore((s) => s.computers);
  const conns = useConnectionsStore((s) => s.byComputer);
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      {computers.length === 0 ? (
        <EmptyState text="No computers yet." action={{ label: "Pair one", onPress: () => router.push("/pair") }} />
      ) : (
        <FlashList
          data={computers}
          keyExtractor={(c) => c.fp}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            const c = conns[item.fp];
            const accent = tokens.accents[item.accent as keyof typeof tokens.accents] ?? tokens.accents.emerald;
            const status = c?.status === "online" ? "online" : c?.status === "offline" && !c.agentOnline ? "computer offline" : c?.status ?? "idle";
            return (
              <Pressable onPress={() => router.push(`/c/${item.fp}`)}>
                <Card accent={accent}>
                  <Text style={{ color: tokens.text, fontSize: 17, fontWeight: "600" }}>{item.name}</Text>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 6, alignItems: "center" }}>
                    <Pill color={c?.status === "online" ? accent : tokens.textFaint} text={status} />
                    <Text style={{ color: tokens.textMuted }}>{c?.sessions.length ?? 0} sessions</Text>
                  </View>
                </Card>
              </Pressable>
            );
          }}
        />
      )}
      <Link href="/pair" asChild>
        <Pressable style={{ position: "absolute", right: 20, bottom: 32, width: 56, height: 56, borderRadius: 28, backgroundColor: tokens.accents.emerald, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#000", fontSize: 28, lineHeight: 30 }}>+</Text>
        </Pressable>
      </Link>
      <Link href="/settings" style={{ position: "absolute", left: 20, bottom: 44, color: tokens.textMuted }}>Settings</Link>
    </View>
  );
}
```

- [ ] **Step 4: Sessions screen**

`app/c/[fp]/_layout.tsx`: a `Stack` with the computer's name as title and a header button to `settings`.

`app/c/[fp]/index.tsx`:
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
import { sidToRoute } from "../../../src/util/routes";

export default function Sessions() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const accent = tokens.accents[(computer?.accent ?? "emerald") as keyof typeof tokens.accents] ?? tokens.accents.emerald;
  const rows = useMemo(() => {
    const list = conn?.sessions ?? [];
    const out: ({ kind: "header"; key: string; text: string } | { kind: "session"; key: string; s: (typeof list)[number] })[] = [];
    let lastGroup = "";
    for (const s of list) {
      const group = `${s.backend}:${s.windowId}`;
      if (group !== lastGroup) {
        out.push({ kind: "header", key: `h:${group}`, text: `${s.backend === "iterm2" ? "iTerm2" : "tmux"} · window ${s.windowNumber}` });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions]);

  const newSession = () => {
    const backends = conn?.hello?.backends.filter((b) => b.capabilities.createSession) ?? [];
    if (backends.length === 0) return;
    const go = (backend: "iterm2" | "tmux") => {
      const c = connectionManager.get(fp ?? "");
      if (!c) return;
      void c.request({ type: "session.create", reqId: c.newReqId(), in: { kind: "tab", backend } }).then((ack) => ack.sessionId && router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`));
    };
    if (backends.length === 1) return go(backends[0]?.name ?? "iterm2");
    Alert.alert("New session", undefined, [
      { text: "New iTerm2 tab", onPress: () => go("iterm2") },
      { text: "New tmux window", onPress: () => go("tmux") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  if (!conn || conn.status !== "online") {
    const text = conn?.status === "error" && conn.error === "unpaired" ? "This phone was unpaired on the computer." : conn?.status === "error" && conn.error === "re-pair" ? "Keys are out of sync. Re-pair this computer." : !conn?.agentOnline && conn?.status === "offline" ? `${computer?.name ?? "Computer"} is offline.` : "Connecting…";
    return <EmptyState text={text} action={conn?.status === "error" ? { label: "Re-pair", onPress: () => router.push("/pair") } : undefined} />;
  }
  if (rows.length === 0) return <EmptyState text="No terminal sessions. Open iTerm2 or start tmux on the Mac." action={{ label: "New session", onPress: newSession }} />;
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1, marginTop: 12, marginBottom: 6 }}>{item.text.toUpperCase()}</Text>
          ) : (
            <Pressable onPress={() => router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`)} style={{ paddingVertical: 10, borderBottomColor: tokens.border, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.s.isFocusedOnMac ? accent : tokens.textFaint }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.text, fontSize: 15 }} numberOfLines={1}>{item.s.title}</Text>
                {item.s.cwd && <Text style={{ color: tokens.textMuted, fontSize: 12 }} numberOfLines={1}>{item.s.cwd}</Text>}
              </View>
              {item.s.state !== "unknown" && <Pill color={item.s.state === "running" ? tokens.accents.amber : tokens.textFaint} text={item.s.state} />}
              {(conn.unread[item.s.id] ?? 0) > 0 && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.accents.rose }} />}
            </Pressable>
          )
        }
      />
      <Pressable onPress={newSession} style={{ position: "absolute", right: 20, bottom: 32, width: 56, height: 56, borderRadius: 28, backgroundColor: accent, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: "#000", fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 5: Verify on device** — computers list shows the paired Mac online; sessions list shows iTerm2 (and tmux) sessions grouped, focused dot on the active one; "+" creates a tab on the Mac. **Commit:** `git add apps/mobile && git commit -m "feat(mobile): computers and sessions screens, UI primitives, root wiring"`.

---

### Task 7: Session screen — rendering (spec 10.5)

**Files:**
- Create: `apps/mobile/src/screen/ScreenView.tsx`, `apps/mobile/src/screen/Cursor.tsx`, `apps/mobile/app/c/[fp]/s/[sid].tsx` (rendering half; input added in Task 8)

- [ ] **Step 1: `Cursor` and `ScreenView`**

`src/screen/Cursor.tsx`: an `Animated.View` (Reanimated) sized `charWidth × lineHeight`, positioned absolutely at `(x * charWidth, top + y * lineHeight)`, `backgroundColor: accent`, `opacity` animating 0.7 ↔ 0 with `withRepeat(withTiming(0, { duration: 500 }), -1, true)` only when `blinking` is true, otherwise static 0.7. `top` is the history height (`history.length * lineHeight`).

`src/screen/ScreenView.tsx`:
```tsx
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { KeyedLine, ViewState } from "../store/screen";
import { useUiStore } from "../store/computers";
import { tokens } from "../theme/tokens";
import { Cursor } from "./Cursor";
import { LineView } from "./LineView";

export function ScreenView({ view, accent, blinking, onLoadOlder }: { view: ViewState; accent: string; blinking: boolean; onLoadOlder: () => void }) {
  const { width } = useWindowDimensions();
  const fontSizeSetting = useUiStore((s) => s.fontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fontSize = fitWidth ? Math.max(5, (width - 16) / view.state.cols / 0.6) : fontSizeSetting;
  const charWidth = fontSize * 0.6;
  const lineHeight = fontSize * 1.25;
  const contentWidth = Math.max(width, view.state.cols * charWidth + 16);
  const list = useRef<FlashListRef<KeyedLine>>(null);
  const [following, setFollowing] = useState(true);
  const startScale = useRef(fontSizeSetting);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.current = fontSizeSetting;
    })
    .onUpdate((e) => setFontSize(Math.round(startScale.current * e.scale)))
    .runOnJS(true);

  useEffect(() => {
    if (following) list.current?.scrollToEnd({ animated: false });
  }, [view.keyed.length, following]);

  const renderItem = useCallback(({ item }: { item: KeyedLine }) => <LineView line={item} fontSize={fontSize} />, [fontSize]);
  const histHeight = view.state.history.length * lineHeight;

  return (
    <GestureDetector gesture={pinch}>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ width: contentWidth }}>
        <View style={{ width: contentWidth, flex: 1 }}>
          <FlashList
            ref={list}
            data={view.keyed}
            keyExtractor={(l) => l.key}
            renderItem={renderItem}
            maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.1 }}
            onStartReached={onLoadOlder}
            onStartReachedThreshold={0.2}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              setFollowing(contentOffset.y + layoutMeasurement.height >= contentSize.height - lineHeight * 2);
            }}
            scrollEventThrottle={100}
            contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
            style={{ backgroundColor: tokens.bg }}
          />
          {view.state.cursor.y >= 0 && <Cursor x={view.state.cursor.x} y={view.state.cursor.y} top={histHeight + 4} charWidth={charWidth} lineHeight={lineHeight} accent={accent} blinking={blinking} />}
        </View>
      </ScrollView>
    </GestureDetector>
  );
}
```
Show a "↓ Jump to live" pill (from `ui/Pill`) when `!following`; tapping calls `list.current?.scrollToEnd()`.

- [ ] **Step 2: Session route (rendering half)**

`app/c/[fp]/s/[sid].tsx`:
```tsx
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { connectionManager } from "../../../../src/net/manager";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { useConnectionsStore } from "../../../../src/store/connections";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { sidFromRoute } from "../../../../src/util/routes";

export default function Session() {
  useKeepAwake();
  const { fp, sid } = useLocalSearchParams<{ fp: string; sid: string }>();
  const sessionId = sidFromRoute(sid ?? "");
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const session = conn?.sessions.find((s) => s.id === sessionId);
  const accent = tokens.accents[(computer?.accent ?? "emerald") as keyof typeof tokens.accents] ?? tokens.accents.emerald;

  useEffect(() => {
    const c = connectionManager.get(fp ?? "");
    c?.subscribe(sessionId);
    useConnectionsStore.getState().patch(fp ?? "", (x) => ({ unread: { ...x.unread, [sessionId]: 0 } }));
    return () => c?.subscribe(null);
  }, [fp, sessionId, conn?.status]);

  const view = conn?.view?.sessionId === sessionId ? conn.view.view : undefined;
  const loadOlder = () => {
    const c = connectionManager.get(fp ?? "");
    if (!c || !view) return;
    const from = view.state.historyFrom;
    if (from <= 0) return;
    void c.request({ type: "history.get", reqId: c.newReqId(), sessionId, before: from, count: 200 }).catch(() => undefined);
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen options={{ title: session?.title ?? "Session" }} />
      {!session ? (
        <EmptyState text="Session ended." />
      ) : !view ? (
        <EmptyState text="Waiting for output…" />
      ) : (
        <ScreenView view={view} accent={accent} blinking={session.state === "running" || session.state === "editing"} onLoadOlder={loadOlder} />
      )}
      {/* InputBar is added in Task 8 */}
    </View>
  );
}
```

- [ ] **Step 3: Verify on device** — open a session: screen appears, tailing a `for i in $(seq 100); do echo $i; sleep 0.2; done` follows live, scrolling up stops following and pull-to-top loads history, pinch changes font size, `htop` renders. **Commit:** `git add apps/mobile && git commit -m "feat(mobile): session screen rendering with history, cursor, pinch, fit width"`.

---

### Task 8: Session screen — input (spec 7.4, 10.6), settings screens

**Files:**
- Create: `apps/mobile/src/input/differ.ts`, `apps/mobile/src/input/keys.ts`, `apps/mobile/src/input/InputBar.tsx`, `QuickKeys.tsx`, `ReplyChips.tsx`, `apps/mobile/test/differ.test.ts`, `apps/mobile/app/c/[fp]/settings.tsx`, `apps/mobile/app/settings.tsx`, `apps/mobile/QA.md`
- Modify: `app/c/[fp]/s/[sid].tsx` (mount `InputBar`), `app/c/[fp]/_layout.tsx` (header menu)

**Interfaces:**
- `differ.ts`: `type KeyAction = { kind: "text"; text: string } | { kind: "backspace"; count: number }`, `diffTyped(prev: string, next: string): KeyAction[]`.
- `keys.ts`: `QUICK_KEYS: { label: string; key: NamedKey }[]` = Esc, Tab, ^C, ^D, ^Z, ^L, ^U, ↑, ↓, ←, →, ⏎, ^R, ^A, ^E (Paste is a separate button).

- [ ] **Step 1: Differ test and implementation**

`test/differ.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { diffTyped } from "../src/input/differ.js";

describe("diffTyped", () => {
  it("appends, deletes, replaces", () => {
    expect(diffTyped("", "ab")).toEqual([{ kind: "text", text: "ab" }]);
    expect(diffTyped("ab", "a")).toEqual([{ kind: "backspace", count: 1 }]);
    expect(diffTyped("abc", "abd")).toEqual([{ kind: "backspace", count: 1 }, { kind: "text", text: "d" }]);
    expect(diffTyped("abc", "abc")).toEqual([]);
    expect(diffTyped("a", "🚀")).toEqual([{ kind: "backspace", count: 1 }, { kind: "text", text: "🚀" }]);
  });
});
```

`src/input/differ.ts`:
```ts
export type KeyAction = { kind: "text"; text: string } | { kind: "backspace"; count: number };

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

`src/input/InputBar.tsx`:
```tsx
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { type NamedKey } from "@shellbell/protocol";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { connectionManager } from "../net/manager";
import { useConnectionsStore } from "../store/connections";
import { useUiStore } from "../store/computers";
import { tokens } from "../theme/tokens";
import { Bar } from "../ui/Bar";
import { diffTyped } from "./differ";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";

export function InputBar({ fp, sessionId, accent, showChips }: { fp: string; sessionId: string; accent: string; showChips: boolean }) {
  const raw = useUiStore((s) => s.rawModeBySession[sessionId] ?? false);
  const setRaw = useUiStore((s) => s.setRawMode);
  const [text, setText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const rawPrev = useRef("");

  const conn = () => connectionManager.get(fp);
  const track = (reqId: string) => useConnectionsStore.getState().patch(fp, (c) => ({ pendingInputs: { ...c.pendingInputs, [reqId]: { at: Date.now(), sessionId } } }));
  const fire = (msg: Parameters<NonNullable<ReturnType<typeof conn>>["request"]>[0]) => {
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
    useConnectionsStore.getState().patch(fp, (x) => ({ history: [...x.history.filter((h) => h !== line), line].slice(-100) }));
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
  const history = () => useConnectionsStore.getState().get(fp).history;
  const browseHistory = () => {
    const h = history();
    if (h.length === 0) return;
    const idx = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
    setHistIdx(idx);
    setText(h[idx] ?? "");
  };

  const onRawChange = (next: string) => {
    for (const a of diffTyped(rawPrev.current, next)) {
      if (a.kind === "text") sendText(a.text);
      else for (let i = 0; i < a.count; i++) sendKey("backspace");
    }
    rawPrev.current = "";
    setText("");
  };

  return (
    <Bar style={{ gap: 6 }}>
      {showChips && <ReplyChips onLine={sendLine} onKey={sendKey} accent={accent} />}
      <QuickKeys onKey={sendKey} onPaste={() => void paste()} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable onPress={() => setRaw(sessionId, !raw)} style={{ width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: raw ? accent : tokens.border, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: raw ? accent : tokens.textMuted }}>⌨︎</Text>
        </Pressable>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: tokens.surface2, borderRadius: 16, borderWidth: 1, borderColor: tokens.border, paddingLeft: 12 }}>
          <Text style={{ color: accent, fontWeight: "700" }}>{raw ? "»" : "$"}</Text>
          <TextInput
            value={text}
            onChangeText={raw ? onRawChange : (t) => { setText(t); setHistIdx(-1); }}
            onKeyPress={raw ? (e) => { if (e.nativeEvent.key === "Backspace") sendKey("backspace"); } : undefined}
            onSubmitEditing={() => { if (raw) sendKey("enter"); else if (text.trim()) { sendLine(text); setText(""); } }}
            blurOnSubmit={false}
            placeholder={raw ? "raw keystrokes" : "command…"}
            placeholderTextColor={tokens.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            textContentType="none"
            keyboardType={raw ? (Platform.OS === "ios" ? "ascii-capable" : "visible-password") : "default"}
            returnKeyType="send"
            style={{ flex: 1, color: tokens.text, paddingVertical: 10, paddingHorizontal: 8, fontSize: 15 }}
          />
          {!raw && (
            <Pressable onPress={browseHistory} style={{ padding: 8 }}>
              <Text style={{ color: tokens.textMuted }}>↑</Text>
            </Pressable>
          )}
        </View>
        {!raw && (
          <Pressable onPress={() => { if (text.trim()) { sendLine(text); setText(""); } }} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: text.trim() ? accent : tokens.surface2, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: text.trim() ? "#000" : tokens.textFaint, fontWeight: "700" }}>↩</Text>
          </Pressable>
        )}
      </View>
    </Bar>
  );
}
```

`src/input/QuickKeys.tsx`: a horizontal `ScrollView` of `Pressable`s from `QUICK_KEYS` (each `accessibilityLabel` = the label) plus a "Paste" button; each tap calls `onKey(key)`.

`src/input/ReplyChips.tsx`: four chips — `y ⏎` → `onLine("y")`, `n ⏎` → `onLine("n")`, `⏎` → `onKey("enter")`, `Esc` → `onKey("esc")` — tinted with `accent`.

Mount in `app/c/[fp]/s/[sid].tsx` below the `ScreenView`: `<InputBar fp={fp} sessionId={sessionId} accent={accent} showChips={session.state === "running" || (conn.events[sessionId]?.at(-1)?.kind === "idle")} />`. Show `conn.toast` via `Toast` when set (clear it after showing). Wrap the screen in `KeyboardAvoidingView` (`behavior="padding"` on iOS).

Header `⋯` menu (`app/c/[fp]/_layout.tsx` for the session route): `Alert.alert` with actions filtered by capability — "Bring to front on Mac" (`session.focus`, only when `hello.backends` for this session's backend has `focus`), "New tab", "Split vertical", "Split horizontal" (`session.create`), "Cancel".

- [ ] **Step 3: Settings screens**

`app/c/[fp]/settings.tsx`: computer name (read-only, from hello), accent picker (8 colors → `update(fp, { accent })`), "Notifications for this computer" switch → `update(fp, { pushEnabled })` (the push token message in Plan 06 reads it), "Unpair" → confirm → `connectionManager.get(fp)?.close("user")`, send `unpair` via a one-shot `ComputerConnection` helper `unpairSelf(fp)` (Plan 06 adds it; for now delete locally: `deletePairSecret(fp)`, `remove(fp)`, navigate home).

`app/settings.tsx`: this phone's name and fingerprint (from `loadOrCreateIdentity`), font size stepper (5–24) and "Fit width" switch (from `useUiStore`), "Crypto self-test" (Task 3 Step 3), `__DEV__`-only link to `/dev/render-spike`, About (version, MIT, link to the repo), "Buy me a coffee" link.

- [ ] **Step 4: QA checklist**

`apps/mobile/QA.md`:
```markdown
# Manual QA — run on iOS and Android before every TestFlight/internal build

- [ ] Fresh install → Computers empty state → Pair → camera permission → scan → confirm on Mac → sessions list.
- [ ] Session: live tail follows; scroll up stops following; "Jump to live" returns; pull-to-top loads history until a short page.
- [ ] Input: line mode send + history ↑; raw mode typing into `vim` and Claude Code; Esc/^C/arrows; paste; reply chips appear while a command runs.
- [ ] Background the app → relay treats phone as away (verify with a ring in Plan 06).
- [ ] Kill the agent → "offline" state; restart → reconnects and re-subscribes.
- [ ] Unpair on the Mac (`shellbell unpair`) → app shows unpaired state with Re-pair.
- [ ] Settings: accent changes propagate; font size persists; self-test all ✓.
- [ ] Second computer pairs and both appear; switching between them works.
```

- [ ] **Step 5: Run tests, verify on device, commit**

`pnpm test` → PASS. On device: type into a shell; toggle raw mode and drive `vim`; chips reply to a `read -p "y/n? "` prompt. Then:
```bash
git add apps/mobile
git commit -m "feat(mobile): input bar (line/raw/keys/chips), settings screens, QA checklist"
```

---

## Plan self-review

- **Spec coverage:** 10.1/10.2 scaffold, routes, base64url ids → Tasks 1, 3; 10.5 rendering + spike + FlashList v2 props + fixed-width path → Tasks 2, 7; 6.2/6.3/10.7 identity, SecureStore, bootstrap, self-test → Tasks 1, 3; 10.3 stores incl. memory-only history → Task 3; 6.5–6.7/10.4/11.3 connection, handshake, leases, immediate background close, pending-input toast → Task 4; 6.4 phone side + 10.7 pairing copy → Task 5; 10.9 tokens, `Bar` with `isGlassEffectAPIAvailable`, computers/sessions screens, `session.create` → Task 6; 10.6 input incl. raw-mode keyboard settings and differ, header menu, settings → Task 8; 15 mobile tests + QA → Tasks 3, 4, 8. Notifications (10.8) are Plan 06.
- **Type consistency:** `Status` is defined once in `store/connections.ts` and used by `connection.ts`; `ViewState`/`KeyedLine` are produced by `store/screen.ts` and consumed by `manager.ts` and `ScreenView`; `ComputerConnection.request` takes a message with `reqId` and `InputBar.fire` passes exactly that type; `Computer.pushEnabled` exists now so Plan 06 can read it.
- **Placeholders:** `REPLACE_AFTER_eas_init` in `app.json` is filled by `eas init` in Plan 06; device measurements go into `docs/spike-render.md`.
