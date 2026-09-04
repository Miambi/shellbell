# Shellbell Plan 01 — Foundation: monorepo, spikes, protocol package

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, prove from Node that we can drive the iTerm2 API and tmux control mode, and ship `@shellbell/protocol` — the shared types, codec, crypto, key table, QR payload, cell-width table, SGR parser, screen-diff logic and golden vectors that the agent, relay and app all import.

**Architecture:** pnpm monorepo. `packages/protocol` is pure TypeScript with no platform APIs (runs in Node, Cloudflare Workers and React Native). The two spikes live inside `apps/agent` because their outputs (our proto subset, generated code, the cookie helper, the control-mode transcript, fixtures) are the first pieces of the real backends.

**Tech Stack:** pnpm 11, TypeScript 5.9.3, Biome 2.5, Vitest 5, zod 4, cborg 6, @noble/{curves,ciphers,hashes} 2.4, @bufbuild/protobuf 2.14 + buf 1.72, ws 8.21, tsx 4.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 5, 6, 7, 8.5.1, 8.5.2, 8.11 (spike only), 8.11.1, 8.11.2, 15, 16, Appendix A and C. Read those sections before starting; every task cites the section it implements.

## Global Constraints

- Node `>= 22` (author has 22.23.1). pnpm `11.12.0`. TypeScript `5.9.3` — **not** 7.x.
- Every package is ESM (`"type": "module"`); local imports use explicit `.js` extensions (`./foo.js`), which TypeScript resolves to `.ts` under `moduleResolution: "bundler"`.
- `@noble/*` subpath imports use the `.js` suffix: `@noble/curves/ed25519.js`, `@noble/ciphers/chacha.js`, `@noble/hashes/sha2.js`, `@noble/hashes/hkdf.js`, `@noble/hashes/utils.js`.
- `packages/protocol` must not import `node:*`, `Buffer`, `crypto`, `fs`, or anything from React Native or Workers. Only `@noble/*`, `cborg`, `zod`.
- Fingerprints are exactly 26 lowercase base32 chars (`/^[a-z2-7]{26}$/`). Byte fields on the wire are `Uint8Array`. Byte fields in JSON files and QR codes are base64url without padding.
- Frame byte limits (spec 7.1): unauth 4 096, ctrl 16 384, e2e-from-phone 65 536, e2e-from-agent 1 048 576. Exported as constants in `envelope.ts`.
- Biome: 2-space indent, double quotes, semicolons, 100-column lines. Run `pnpm lint` before every commit.
- Commit messages: `type(scope): summary` (`feat`, `fix`, `test`, `docs`, `chore`). Commit after every task.
- Never commit generated protobuf code (`apps/agent/src/backends/iterm2/gen/`). Fixtures captured from the author's Mac may be committed after the author reviews them for secrets.

---

## File structure created by this plan

```
shellbell/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json  .gitignore  .npmrc
├── LICENSE  TRADEMARK.md  README.md  .github/FUNDING.yml  .github/workflows/ci.yml
├── docs/spike-iterm2.md  docs/spike-tmux.md
├── packages/protocol/
│   ├── package.json  tsconfig.json  vitest.config.ts
│   ├── scripts/gen-vectors.ts
│   ├── src/
│   │   ├── index.ts          re-exports everything below
│   │   ├── bytes.ts          base64url, base32, utf8, concat, equal
│   │   ├── screen.ts         Color/Run/Line/Cursor types, mergeRuns, trimTrailing, lineKey, applyDiff, applySnapshot
│   │   ├── codec.ts          encodeCbor/decodeCbor (cborg), ProtocolError
│   │   ├── envelope.ts       Envelope schema, byte limits, encode/decode
│   │   ├── ctrl.ts           ctrl message zod schemas + types
│   │   ├── inner.ts          inner (encrypted) message zod schemas + types, SessionInfo
│   │   ├── crypto.ts         identity, fingerprint, sign/verify, seal/open, KDFs, AD builders
│   │   ├── keys.ts           NamedKey enum + byte table
│   │   ├── colors.ts         16-color theme + xterm-256 → hex
│   │   ├── qr.ts             QR payload schema, encode/parse
│   │   ├── width.ts          cellWidth / stringCells
│   │   └── sgr.ts            ANSI SGR line parser → Line
│   └── test/                 one *.test.ts per src file + vectors.json
└── apps/agent/
    ├── package.json  tsconfig.json  buf.gen.yaml  vitest.config.ts
    ├── proto/iterm2.proto    our subset (spec 8.5.2)
    ├── scripts/spike-iterm2.ts  scripts/spike-tmux.ts
    ├── src/backends/iterm2/auth.ts      cookie/key via osascript
    ├── src/backends/iterm2/gen/         generated (gitignored)
    └── test/fixtures/                   captured GetBuffer responses, tmux transcript
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.npmrc`, `.gitignore` (replace), `LICENSE`, `TRADEMARK.md`, `README.md`, `.github/FUNDING.yml`

**Interfaces:**
- Produces: root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

- [ ] **Step 1: Write the root files**

`package.json`:
```json
{
  "name": "shellbell-monorepo",
  "private": true,
  "packageManager": "pnpm@11.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "build": "pnpm -r --if-present build"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.12",
    "typescript": "5.9.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.npmrc`:
```
node-linker=hoisted
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.12/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/gen/**", "!**/dist/**", "!**/.expo/**", "!**/node_modules/**"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" } },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

`.gitignore`:
```
node_modules/
dist/
.expo/
.wrangler/
*.log
.DS_Store
apps/agent/src/backends/iterm2/gen/
```

`LICENSE`: the MIT license text with `Copyright (c) 2026 Bilal Ahmad`.

`TRADEMARK.md`:
```markdown
# Trademark notice

The Shellbell name, logo and app-store listings are trademarks of Bilal Ahmad and are
not covered by the MIT license. You may fork and redistribute this code under the MIT
license, but you may not publish a derivative to an app store or package registry under
the name "Shellbell" or with the Shellbell logo without written permission.
```

`README.md`:
```markdown
# Shellbell

Your terminal rings. You answer.

Shellbell mirrors your Mac's terminal sessions (iTerm2 natively, everything else via
tmux) to your phone, pings you when a command finishes or a program is waiting, and lets
you reply — from anywhere, end-to-end encrypted, no accounts.

Status: pre-alpha. See `docs/superpowers/specs/2026-09-03-shellbell-design.md`.
```

`.github/FUNDING.yml`: `buy_me_a_coffee: <handle>` — the author's Buy Me a Coffee handle is in the author's memory notes; if you do not have it, leave the value empty and say so in the commit message.

- [ ] **Step 2: Install and verify the toolchain**

Run: `cd /Users/bilal/workspace/personal/shellbell && pnpm install && pnpm lint && pnpm exec tsc --version`
Expected: install succeeds; `biome check` reports no errors; `Version 5.9.3`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold (pnpm, biome, tsconfig, license)"
```

---

### Task 2: iTerm2 spike from Node (spec 8.5.1, 8.5.2, 18.1, M0a)

**Files:**
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/buf.gen.yaml`, `apps/agent/vitest.config.ts`, `apps/agent/proto/iterm2.proto`, `apps/agent/src/backends/iterm2/auth.ts`, `apps/agent/scripts/spike-iterm2.ts`, `docs/spike-iterm2.md`
- Generated (gitignored): `apps/agent/src/backends/iterm2/gen/iterm2_pb.ts`

**Interfaces:**
- Produces: `requestCookieAndKey(appName: string): Promise<{ cookie: string; key: string }>` and `class ITerm2AuthError` in `auth.ts`; generated schemas from `gen/iterm2_pb.js`; `test/fixtures/getbuffer-*.json`, `listsessions-*.json` for Plan 03.

- [ ] **Step 1: Create the agent package skeleton**

`apps/agent/package.json`:
```json
{
  "name": "shellbell",
  "version": "0.0.1",
  "description": "Shellbell agent — mirrors your Mac's terminal sessions to your phone",
  "type": "module",
  "license": "MIT",
  "os": ["darwin"],
  "engines": { "node": ">=22" },
  "bin": { "shellbell": "dist/cli.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "proto:gen": "buf generate",
    "prebuild": "pnpm proto:gen",
    "pretest": "pnpm proto:gen",
    "typecheck": "pnpm proto:gen && tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "spike:iterm2": "pnpm proto:gen && tsx scripts/spike-iterm2.ts",
    "spike:tmux": "tsx scripts/spike-tmux.ts"
  },
  "dependencies": {
    "@bufbuild/protobuf": "2.14.1",
    "@shellbell/protocol": "workspace:*",
    "ws": "8.21.3"
  },
  "devDependencies": {
    "@bufbuild/buf": "1.72.0",
    "@bufbuild/protoc-gen-es": "2.14.1",
    "@types/node": "26.4.1",
    "@types/ws": "8.18.1",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "5.0.0"
  }
}
```

`apps/agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"], "outDir": "dist", "rootDir": "." },
  "include": ["src", "scripts", "test"]
}
```

`apps/agent/buf.gen.yaml`:
```yaml
version: v2
inputs:
  - directory: proto
plugins:
  - local: protoc-gen-es
    out: src/backends/iterm2/gen
    opt: target=ts
```

`apps/agent/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 2: Write our proto subset**

`apps/agent/proto/iterm2.proto` — names, field names and numbers match upstream iTerm2 `api.proto`; only what Shellbell uses is present (spec 8.5.2). Copy exactly:

```proto
syntax = "proto2";
package iterm2;

// Subset of the iTerm2 API. Field numbers and names match
// https://github.com/gnachman/iTerm2/blob/master/proto/api.proto (protocol facts).
// Written independently for Shellbell (MIT). Unknown fields are ignored by protobuf, so
// omitting messages/fields we do not use is safe.

message ClientOriginatedMessage {
  optional int64 id = 1;
  oneof submessage {
    GetBufferRequest get_buffer_request = 100;
    GetPromptRequest get_prompt_request = 101;
    NotificationRequest notification_request = 103;
    ListSessionsRequest list_sessions_request = 106;
    SendTextRequest send_text_request = 107;
    CreateTabRequest create_tab_request = 108;
    SplitPaneRequest split_pane_request = 109;
    ActivateRequest activate_request = 114;
    VariableRequest variable_request = 115;
    FocusRequest focus_request = 117;
    InvokeFunctionRequest invoke_function_request = 132;
  }
}

message ServerOriginatedMessage {
  optional int64 id = 1;
  oneof submessage {
    string error = 2;
    GetBufferResponse get_buffer_response = 100;
    GetPromptResponse get_prompt_response = 101;
    NotificationResponse notification_response = 103;
    ListSessionsResponse list_sessions_response = 106;
    SendTextResponse send_text_response = 107;
    CreateTabResponse create_tab_response = 108;
    SplitPaneResponse split_pane_response = 109;
    ActivateResponse activate_response = 114;
    VariableResponse variable_response = 115;
    FocusResponse focus_response = 117;
    InvokeFunctionResponse invoke_function_response = 132;
    Notification notification = 1000;
  }
}

// ---- geometry ----
message Coord { optional int32 x = 1; optional int64 y = 2; }
message CoordRange { optional Coord start = 1; optional Coord end = 2; }
message Range { optional int64 location = 1; optional int64 length = 2; }
message WindowedCoordRange { optional CoordRange coord_range = 1; optional Range columns = 2; }
message Point { optional int32 x = 1; optional int32 y = 2; }
message Size { optional int32 width = 1; optional int32 height = 2; }
message Frame { optional Point origin = 1; optional Size size = 2; }

// ---- buffer ----
message LineRange {
  optional bool screen_contents_only = 1;
  optional int32 trailing_lines = 2;
  optional WindowedCoordRange windowed_coord_range = 3;
}
message GetBufferRequest {
  optional string session = 1;
  optional LineRange line_range = 2;
  optional bool include_styles = 3;
}
message RGBColor { optional uint32 red = 1; optional uint32 green = 2; optional uint32 blue = 3; }
enum AlternateColor { DEFAULT = 0; REVERSED_DEFAULT = 3; SYSTEM_MESSAGE = 4; }
message CellStyle {
  oneof fgColor { uint32 fgStandard = 1; AlternateColor fgAlternate = 2; RGBColor fgRgb = 3; }
  oneof bgColor { uint32 bgStandard = 5; AlternateColor bgAlternate = 6; RGBColor bgRgb = 7; }
  optional bool bold = 9;
  optional bool faint = 10;
  optional bool italic = 11;
  optional bool blink = 12;
  optional bool underline = 13;
  optional bool strikethrough = 14;
  optional bool invisible = 15;
  optional bool inverse = 16;
  optional uint32 repeats = 22;
}
message CodePointsPerCell { optional int32 num_code_points = 1 [default = 1]; optional int32 repeats = 2; }
message LineContents {
  optional string text = 1;
  repeated CodePointsPerCell code_points_per_cell = 2;
  enum Continuation { CONTINUATION_HARD_EOL = 1; CONTINUATION_SOFT_EOL = 2; }
  optional Continuation continuation = 3 [default = CONTINUATION_HARD_EOL];
  repeated CellStyle style = 4;
}
message GetBufferResponse {
  enum Status { OK = 0; SESSION_NOT_FOUND = 1; INVALID_LINE_RANGE = 2; REQUEST_MALFORMED = 3; }
  optional Status status = 1 [default = OK];
  repeated LineContents contents = 3;
  optional Coord cursor = 4;
  optional WindowedCoordRange windowed_coord_range = 6;
}

// ---- sessions / layout ----
message ListSessionsRequest {}
message SessionSummary {
  optional string unique_identifier = 1;
  optional Frame frame = 2;
  optional Size grid_size = 3;
  optional string title = 4;
}
message SplitTreeNode {
  optional bool vertical = 1;
  repeated SplitTreeLink links = 2;
  message SplitTreeLink { oneof child { SessionSummary session = 1; SplitTreeNode node = 2; } }
}
message ListSessionsResponse {
  message Window {
    repeated Tab tabs = 1;
    optional string window_id = 2;
    optional Frame frame = 3;
    optional int32 number = 4;
  }
  message Tab {
    optional SplitTreeNode root = 3;
    optional string tab_id = 2;
    optional string tmux_window_id = 4;
  }
  repeated Window windows = 1;
}

// ---- text ----
message SendTextRequest { optional string session = 1; optional string text = 2; optional bool suppress_broadcast = 3; }
message SendTextResponse { enum Status { OK = 0; SESSION_NOT_FOUND = 1; } optional Status status = 1; }

// ---- notifications ----
enum NotificationType {
  NOTIFY_ON_SCREEN_UPDATE = 2;
  NOTIFY_ON_PROMPT = 3;
  NOTIFY_ON_NEW_SESSION = 6;
  NOTIFY_ON_TERMINATE_SESSION = 7;
  NOTIFY_ON_LAYOUT_CHANGE = 8;
  NOTIFY_ON_FOCUS_CHANGE = 9;
  NOTIFY_ON_VARIABLE_CHANGE = 12;
}
enum PromptMonitorMode { PROMPT = 1; COMMAND_START = 2; COMMAND_END = 3; }
message PromptMonitorRequest { repeated PromptMonitorMode modes = 1; }
enum VariableScope { SESSION = 1; TAB = 2; WINDOW = 3; APP = 4; }
message VariableMonitorRequest { optional string name = 1; optional VariableScope scope = 2; optional string identifier = 3; }
message NotificationRequest {
  optional string session = 1;
  optional bool subscribe = 2;
  optional NotificationType notification_type = 3;
  oneof arguments {
    VariableMonitorRequest variable_monitor_request = 6;
    PromptMonitorRequest prompt_monitor_request = 9;
  }
}
message NotificationResponse {
  enum Status { OK = 0; SESSION_NOT_FOUND = 1; REQUEST_MALFORMED = 2; NOT_SUBSCRIBED = 3; ALREADY_SUBSCRIBED = 4; DUPLICATE_SERVER_ORIGINATED_RPC = 5; INVALID_IDENTIFIER = 6; }
  optional Status status = 1;
}
message ScreenUpdateNotification { optional string session = 1; }
message PromptNotificationPrompt { optional string placeholder = 1; optional GetPromptResponse prompt = 2; }
message PromptNotificationCommandStart { optional string command = 1; }
message PromptNotificationCommandEnd { optional int32 status = 1; }
message PromptNotification {
  optional string session = 1;
  oneof event {
    PromptNotificationPrompt prompt = 2;
    PromptNotificationCommandStart command_start = 3;
    PromptNotificationCommandEnd command_end = 4;
  }
  optional string unique_prompt_id = 5;
}
message NewSessionNotification { optional string session_id = 1; }
message TerminateSessionNotification { optional string session_id = 1; }
message LayoutChangedNotification { optional ListSessionsResponse list_sessions_response = 1; }
message FocusChangedNotification {
  message Window {
    enum WindowStatus { TERMINAL_WINDOW_BECAME_KEY = 0; TERMINAL_WINDOW_IS_CURRENT = 1; TERMINAL_WINDOW_RESIGNED_KEY = 2; }
    optional WindowStatus window_status = 1;
    optional string window_id = 2;
  }
  oneof event {
    bool application_active = 1;
    Window window = 2;
    string selected_tab = 3;
    string session = 4;
  }
}
message VariableChangedNotification { optional VariableScope scope = 1; optional string identifier = 2; optional string name = 3; optional string json_new_value = 4; }
message Notification {
  optional ScreenUpdateNotification screen_update_notification = 2;
  optional PromptNotification prompt_notification = 3;
  optional NewSessionNotification new_session_notification = 6;
  optional TerminateSessionNotification terminate_session_notification = 7;
  optional LayoutChangedNotification layout_changed_notification = 8;
  optional FocusChangedNotification focus_changed_notification = 9;
  optional VariableChangedNotification variable_changed_notification = 12;
}

// ---- prompts ----
message GetPromptRequest { optional string session = 1; optional string unique_prompt_id = 2; }
message GetPromptResponse {
  enum Status { OK = 0; SESSION_NOT_FOUND = 1; REQUEST_MALFORMED = 2; PROMPT_UNAVAILABLE = 3; }
  optional Status status = 1 [default = OK];
  optional string working_directory = 5;
  optional string command = 6;
  enum State { EDITING = 0; RUNNING = 1; FINISHED = 2; }
  optional State prompt_state = 7;
  optional uint32 exit_status = 9;
  optional string unique_prompt_id = 10;
}

// ---- create / split / activate ----
message CreateTabRequest { optional string profile_name = 1; optional string window_id = 2; optional uint32 tab_index = 3; optional bool select_tab = 6; }
message CreateTabResponse {
  enum Status { OK = 0; INVALID_PROFILE_NAME = 1; INVALID_WINDOW_ID = 2; INVALID_TAB_INDEX = 3; MISSING_SUBSTITUTION = 4; }
  optional Status status = 1; optional string window_id = 2; optional int32 tab_id = 3; optional string session_id = 4;
}
message SplitPaneRequest {
  optional string session = 1;
  enum SplitDirection { VERTICAL = 0; HORIZONTAL = 1; }
  optional SplitDirection split_direction = 2;
  optional bool before = 3 [default = false];
}
message SplitPaneResponse {
  enum Status { OK = 0; SESSION_NOT_FOUND = 1; INVALID_PROFILE_NAME = 2; CANNOT_SPLIT = 3; MALFORMED_CUSTOM_PROFILE_PROPERTY = 4; }
  optional Status status = 1; repeated string session_id = 2;
}
message ActivateRequest {
  oneof identifier { string window_id = 1; string tab_id = 2; string session_id = 3; }
  optional bool order_window_front = 4;
  optional bool select_tab = 5;
  optional bool select_session = 6;
  message App { optional bool raise_all_windows = 1; optional bool ignoring_other_apps = 2; }
  optional App activate_app = 7;
}
message ActivateResponse { enum Status { OK = 0; BAD_IDENTIFIER = 1; INVALID_OPTION = 2; } optional Status status = 1; }

// ---- variables / functions / focus ----
message VariableRequest {
  oneof scope { string session_id = 1; }
  message Set { optional string name = 1; optional string value = 2; }
  repeated Set set = 2;
  repeated string get = 3;
}
message VariableResponse {
  enum Status { OK = 0; SESSION_NOT_FOUND = 1; INVALID_NAME = 2; MISSING_SCOPE = 3; TAB_NOT_FOUND = 4; MULTI_GET_DISALLOWED = 5; WINDOW_NOT_FOUND = 6; }
  optional Status status = 1; repeated string values = 2;
}
message InvokeFunctionRequest {
  message Method { optional string receiver = 1; }
  oneof context { Method method = 7; }
  optional string invocation = 5;
  optional double timeout = 6 [default = -1];
}
message InvokeFunctionResponse {
  enum Status { TIMEOUT = 1; FAILED = 2; REQUEST_MALFORMED = 3; INVALID_ID = 4; }
  message Error { optional Status status = 1; optional string error_reason = 2; }
  message Success { optional string json_result = 1; }
  oneof disposition { Error error = 1; Success success = 2; }
}
message FocusRequest {}
message FocusResponse { repeated FocusChangedNotification notifications = 1; }
```

- [ ] **Step 3: Generate and check the code compiles**

Run: `cd apps/agent && pnpm install && pnpm proto:gen && ls src/backends/iterm2/gen/`
Expected: `iterm2_pb.ts` exists. Confirm exports such as `ClientOriginatedMessageSchema`, `GetBufferRequestSchema`, `AlternateColor`, `NotificationType` (protobuf-es v2 emits `<Message>Schema` descriptors and plain TS enums; field names are camelCased, e.g. `screenContentsOnly`, `codePointsPerCell`, `tmuxWindowId`).

- [ ] **Step 4: Write the cookie helper**

`apps/agent/src/backends/iterm2/auth.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ITerm2AuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "not-running" | "too-old" | "denied" | "unknown",
  ) {
    super(message);
    this.name = "ITerm2AuthError";
  }
}

/**
 * Asks iTerm2 for a one-time API cookie and key via AppleScript.
 * iTerm2 shows a consent dialog the first time an app name asks (unless the user has
 * enabled "Allow all apps to connect"). Cookies are not reusable across processes.
 */
export async function requestCookieAndKey(appName: string): Promise<{ cookie: string; key: string }> {
  const running = await runOsascript('if application "iTerm2" is running then\nreturn "yes"\nelse\nreturn "no"\nend if');
  if (running.trim() !== "yes") {
    throw new ITerm2AuthError("iTerm2 is not running", "not-running");
  }
  const safeName = appName.replace(/[\\"]/g, "");
  let out: string;
  try {
    out = await runOsascript(`tell application "iTerm2" to request cookie and key for app named "${safeName}"`);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/-274[01]/.test(msg)) throw new ITerm2AuthError("iTerm2 is too old (need 3.3+)", "too-old");
    if (/denied|not allowed|user/i.test(msg)) throw new ITerm2AuthError(msg.trim(), "denied");
    throw new ITerm2AuthError(msg.trim(), "unknown");
  }
  const [cookie, key] = out.trim().split(" ");
  if (!cookie || !key) throw new ITerm2AuthError(`unexpected osascript output: ${out}`, "unknown");
  return { cookie, key };
}

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script]);
  return stdout;
}
```

- [ ] **Step 5: Write the spike script**

`apps/agent/scripts/spike-iterm2.ts`:
```ts
/* Spike: talk to the iTerm2 API from Node. Run with `pnpm spike:iterm2`.
 * Prints sessions, the first session's styled screen, GetBuffer latency, and writes
 * fixtures to test/fixtures/. Set ITERM2_SPIKE_SEND=1 to also send a harmless echo. */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import WebSocket from "ws";
import { requestCookieAndKey } from "../src/backends/iterm2/auth.js";
import {
  ClientOriginatedMessageSchema,
  GetBufferRequestSchema,
  LineRangeSchema,
  ListSessionsRequestSchema,
  SendTextRequestSchema,
  ServerOriginatedMessageSchema,
  type ServerOriginatedMessage,
} from "../src/backends/iterm2/gen/iterm2_pb.js";

const SOCKET = join(homedir(), "Library", "Application Support", "iTerm2", "private", "socket");
const HEADERS_BASE = {
  origin: "ws://localhost/",
  "x-iterm2-library-version": "shellbell 0.0.1",
  "x-iterm2-disable-auth-ui": "true",
  "x-iterm2-advisory-name": "Shellbell",
};

async function connect(): Promise<WebSocket> {
  const { cookie, key } = await requestCookieAndKey("Shellbell");
  const headers = { ...HEADERS_BASE, "x-iterm2-cookie": cookie, "x-iterm2-key": key };
  const mode = process.env.ITERM2_SPIKE_MODE ?? "unix-url";
  const ws =
    mode === "socketpath"
      ? new WebSocket("ws://localhost/", ["api.iterm2.com"], { headers, socketPath: SOCKET })
      : new WebSocket(`ws+unix://${encodeURI(SOCKET)}:/`, ["api.iterm2.com"], { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return ws;
}

let nextId = 1n;
const pending = new Map<bigint, (m: ServerOriginatedMessage) => void>();

function request(ws: WebSocket, submessage: { case: string; value: unknown }): Promise<ServerOriginatedMessage> {
  const id = nextId++;
  const msg = create(ClientOriginatedMessageSchema, { id, submessage: submessage as never });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response ${id}`));
    }, 5000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    ws.send(toBinary(ClientOriginatedMessageSchema, msg));
  });
}

async function main() {
  const ws = await connect();
  console.log("connected via", process.env.ITERM2_SPIKE_MODE ?? "unix-url");
  ws.on("message", (data: Buffer) => {
    const m = fromBinary(ServerOriginatedMessageSchema, new Uint8Array(data));
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else if (m.submessage.case === "notification") {
      console.log("notification:", JSON.stringify(toJson(ServerOriginatedMessageSchema, m)).slice(0, 200));
    }
  });

  // 1. sessions
  const ls = await request(ws, { case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) });
  if (ls.submessage.case !== "listSessionsResponse") throw new Error(`unexpected ${ls.submessage.case}`);
  const sessions: { id: string; title: string; w: number; h: number; tmux: string }[] = [];
  for (const win of ls.submessage.value.windows) {
    for (const tab of win.tabs) {
      const walk = (node: typeof tab.root): void => {
        if (!node) return;
        for (const link of node.links) {
          if (link.child.case === "session") {
            const s = link.child.value;
            sessions.push({ id: s.uniqueIdentifier ?? "", title: s.title ?? "", w: s.gridSize?.width ?? 0, h: s.gridSize?.height ?? 0, tmux: tab.tmuxWindowId ?? "" });
          } else if (link.child.case === "node") walk(link.child.value);
        }
      };
      walk(tab.root);
    }
  }
  console.log(`${sessions.length} sessions:`);
  for (const s of sessions) console.log(`  ${s.id}  ${s.w}x${s.h}  ${s.title}${s.tmux ? `  (tmux ${s.tmux})` : ""}`);
  const target = sessions[0];
  if (!target) throw new Error("no sessions");

  // 2. styled screen of the first session
  const getBuffer = () =>
    request(ws, {
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: target.id,
        lineRange: create(LineRangeSchema, { screenContentsOnly: true }),
        includeStyles: true,
      }),
    });
  const first = await getBuffer();
  if (first.submessage.case !== "getBufferResponse") throw new Error("bad buffer response");
  const resp = first.submessage.value;
  console.log(`status=${resp.status} lines=${resp.contents.length} cursor=${resp.cursor?.x},${resp.cursor?.y} firstLine=${resp.windowedCoordRange?.coordRange?.start?.y}`);
  for (const line of resp.contents.slice(0, 5)) {
    console.log(JSON.stringify(line.text).slice(0, 100), "styles:", line.style.length, "cpc:", line.codePointsPerCell.length);
  }

  // 3. latency
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await getBuffer();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]?.toFixed(1);
  console.log(`GetBuffer latency ms: p50=${p(0.5)} p95=${p(0.95)} max=${samples.at(-1)?.toFixed(1)}`);

  // 4. fixtures
  const dir = join(import.meta.dirname, "..", "test", "fixtures");
  await mkdir(dir, { recursive: true });
  const stamp = Date.now();
  await writeFile(join(dir, `getbuffer-${stamp}.json`), JSON.stringify(toJson(ServerOriginatedMessageSchema, first), null, 2));
  await writeFile(join(dir, `listsessions-${stamp}.json`), JSON.stringify(toJson(ServerOriginatedMessageSchema, ls), null, 2));
  console.log("fixtures written to", dir);

  // 5. optional send
  if (process.env.ITERM2_SPIKE_SEND === "1") {
    const st = await request(ws, {
      case: "sendTextRequest",
      value: create(SendTextRequestSchema, { session: target.id, text: "echo shellbell-spike-ok\r", suppressBroadcast: true }),
    });
    console.log("sendText:", st.submessage.case, JSON.stringify(toJson(ServerOriginatedMessageSchema, st)));
  }
  ws.close();
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Run the spike (needs iTerm2 running with the Python API enabled)**

Run: `cd apps/agent && pnpm spike:iterm2`
Expected: iTerm2 may show "Allow Shellbell to control iTerm2?" — click Allow. Output lists sessions, prints the first lines of the first session with non-zero style counts, prints latency, writes two fixtures. If `unix-url` fails to connect, run `ITERM2_SPIKE_MODE=socketpath pnpm spike:iterm2` and record which mode worked. Then run once with `ITERM2_SPIKE_SEND=1` and confirm `shellbell-spike-ok` appears in that iTerm2 session.

- [ ] **Step 7: Write the spike report**

`docs/spike-iterm2.md` — fill in the real numbers:
```markdown
# Spike: iTerm2 API from Node — results (YYYY-MM-DD)

- Connection mode that works: `unix-url` | `socketpath` (the agent will use this one).
- iTerm2 version: X.Y.Z. Consent dialog seen: yes/no.
- Sessions listed: N. First session grid: WxH.
- GetBuffer (screen only, styles on) latency over 20 calls: p50 = __ ms, p95 = __ ms, max = __ ms.
  Spec 14/18.2: if p50 > 40 ms, set MIN_FRAME_MS to 200 in the relay config.
- SendText with "\r" produced a new prompt line: yes/no (if no, try "\n" and record).
- Fixtures: `apps/agent/test/fixtures/getbuffer-<stamp>.json`, `listsessions-<stamp>.json`.
  Reviewed for secrets before committing: yes.
```

- [ ] **Step 8: Commit**

Review the fixture files for anything private (paths, tokens in scrollback) and delete lines if needed. Then:
```bash
git add apps/agent docs/spike-iterm2.md
git commit -m "feat(agent): iTerm2 API spike — proto subset, cookie auth, styled screen fetch"
```

---

### Task 3: tmux control-mode spike (spec 8.11, 18.10, 18.11, M0b)

**Files:**
- Create: `apps/agent/scripts/spike-tmux.ts`, `docs/spike-tmux.md`, `apps/agent/test/fixtures/tmux-transcript.txt`

**Interfaces:**
- Produces: evidence for (a) `%output` flowing to a `-C` client with `-f read-only,ignore-size`, (b) whether such a client resizes a GUI-attached session, (c) the exact escaping of `capture-pane -e` output inside `%begin/%end`, (d) reply latency. The recorded transcript becomes the fixture for Plan 04's control-mode parser tests.

- [ ] **Step 1: Install tmux and create a test server**

Run: `brew install tmux && tmux -V` → expected `tmux 3.x` with x ≥ 2.
Then in a **GUI terminal window** (Terminal.app or Ghostty): `tmux -L sbspike new-session -s spike` — leave it open, note its size (`tmux -L sbspike display -p '#{window_width}x#{window_height}'`), and run `printf '\e[1;31mred bold\e[0m normal\n'` inside it so the screen has a styled line.

- [ ] **Step 2: Write the spike script**

`apps/agent/scripts/spike-tmux.ts`:
```ts
/* Spike: tmux control mode from Node. Run with `pnpm spike:tmux` while a GUI terminal is
 * attached to `tmux -L sbspike -t spike`. Records everything the control client prints to
 * test/fixtures/tmux-transcript.txt. */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SOCKET = process.env.TMUX_SPIKE_SOCKET ?? "sbspike";
const SESSION = process.env.TMUX_SPIKE_SESSION ?? "spike";

mkdirSync(join(import.meta.dirname, "..", "test", "fixtures"), { recursive: true });
const transcript = createWriteStream(join(import.meta.dirname, "..", "test", "fixtures", "tmux-transcript.txt"));

const client = spawn("tmux", ["-L", SOCKET, "-C", "attach-session", "-t", SESSION, "-f", "read-only,ignore-size"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const rl = createInterface({ input: client.stdout });

type Reply = { lines: string[]; error: boolean; t0: number };
const queue: ((r: Reply) => void)[] = [];
let current: Reply | null = null;

rl.on("line", (line) => {
  transcript.write(`${line}\n`);
  if (line.startsWith("%begin")) {
    current = { lines: [], error: false, t0: performance.now() };
  } else if (line.startsWith("%end") || line.startsWith("%error")) {
    if (current) {
      current.error = line.startsWith("%error");
      queue.shift()?.(current);
      current = null;
    }
  } else if (current) {
    current.lines.push(line);
  } else if (line.startsWith("%output")) {
    console.log("EVENT", line.slice(0, 80));
  } else {
    console.log("NOTIF", line.slice(0, 120));
  }
});

function cmd(s: string): Promise<Reply> {
  return new Promise((resolve) => {
    queue.push(resolve);
    client.stdin.write(`${s}\n`);
  });
}

async function main() {
  await new Promise((r) => setTimeout(r, 500));
  const panes = await cmd("list-panes -a -F '#{pane_id}\t#{session_name}\t#{pane_width}\t#{pane_height}\t#{history_size}'");
  console.log("panes:", panes.lines);
  const clients = await cmd("list-clients -F '#{client_session}\t#{client_control_mode}'");
  console.log("clients (expect one control=1 and one control=0):", clients.lines);
  const pane = panes.lines[0]?.split("\t")[0];
  if (!pane) throw new Error("no pane");

  const size1 = await cmd(`display-message -p -t ${pane} '#{pane_width}x#{pane_height}'`);
  console.log("pane size seen by control client:", size1.lines[0], "(compare with the GUI window; it must NOT have shrunk)");

  const cap = await cmd(`capture-pane -p -e -N -t ${pane}`);
  console.log("capture-pane raw reply lines (look at how ESC is escaped):");
  for (const l of cap.lines.slice(0, 6)) console.log(JSON.stringify(l));

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await cmd(`capture-pane -p -e -N -t ${pane}`);
    samples.push(performance.now() - r.t0);
  }
  samples.sort((a, b) => a - b);
  console.log(`capture-pane reply latency ms: p50=${samples[10]?.toFixed(1)} max=${samples.at(-1)?.toFixed(1)}`);

  console.log("sending keys via the control channel; expect %output events to follow…");
  await cmd(`send-keys -t ${pane} -l -- 'echo shellbell-tmux-spike-ok'`);
  await cmd(`send-keys -t ${pane} Enter`);
  await new Promise((r) => setTimeout(r, 800));

  const hist = await cmd(`capture-pane -p -e -N -t ${pane} -S -5 -E -1`);
  console.log("history capture (-S -5 -E -1) lines:", hist.lines.length);

  transcript.end();
  client.stdin.write("detach-client\n");
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error("SPIKE FAILED", e);
  process.exit(1);
});
```

- [ ] **Step 3: Run it and observe**

Run: `cd apps/agent && pnpm spike:tmux`
Watch the GUI terminal: its tmux window must **not** resize when the control client attaches. Confirm `EVENT %output …` lines appear after the `send-keys`, and `shellbell-tmux-spike-ok` shows in the GUI pane. Look at the JSON-printed capture lines: note whether `\x1b` arrives as a literal ESC byte or as the text `\033`.

- [ ] **Step 4: Write the report**

`docs/spike-tmux.md`:
```markdown
# Spike: tmux control mode — results (YYYY-MM-DD)

- tmux version: __.
- `-C attach -f read-only,ignore-size` resized the GUI session: yes/no.  (Spec 18.10 — if yes, the fallback is polling `capture-pane` over a plain client; record that decision here.)
- `%output` events arrived after send-keys: yes/no.
- `list-clients` shows our client with `client_control_mode=1` and the GUI client with `0`: yes/no.
- `capture-pane -e` inside `%begin/%end`: ESC arrives as literal byte / as `\033` text. (Spec 8.11 unescape rule: keep / adjust.)
- capture-pane reply latency: p50 = __ ms, max = __ ms.
- Transcript: `apps/agent/test/fixtures/tmux-transcript.txt` (reviewed for secrets: yes).
```

- [ ] **Step 5: Commit**

```bash
git add apps/agent/scripts/spike-tmux.ts apps/agent/test/fixtures/tmux-transcript.txt docs/spike-tmux.md
git commit -m "feat(agent): tmux control-mode spike with recorded transcript"
```

---

### Task 4: `@shellbell/protocol` — package skeleton and `bytes.ts`

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/vitest.config.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/bytes.ts`, `packages/protocol/test/bytes.test.ts`

**Interfaces:**
- Produces: `toBase64Url(b): string`, `fromBase64Url(s): Uint8Array`, `toBase32Lower(b): string`, `utf8(s): Uint8Array`, `fromUtf8(b): string`, `concat(...parts): Uint8Array`, `bytesEqual(a, b): boolean`, `hexToBytes(s): Uint8Array`, `bytesToHex(b): string`.

- [ ] **Step 1: Package files**

`packages/protocol/package.json`:
```json
{
  "name": "@shellbell/protocol",
  "version": "0.0.1",
  "type": "module",
  "license": "MIT",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "gen:vectors": "tsx scripts/gen-vectors.ts"
  },
  "dependencies": {
    "@noble/ciphers": "2.4.0",
    "@noble/curves": "2.4.0",
    "@noble/hashes": "2.4.0",
    "cborg": "6.1.2",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "5.0.0"
  }
}
```

`packages/protocol/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": [], "noEmit": true },
  "include": ["src", "test", "scripts"]
}
```

`packages/protocol/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`packages/protocol/src/index.ts` (grows as tasks add files):
```ts
export * from "./bytes.js";
```

- [ ] **Step 2: Write the failing tests**

`packages/protocol/test/bytes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bytesEqual, bytesToHex, concat, fromBase64Url, fromUtf8, hexToBytes, toBase32Lower, toBase64Url, utf8 } from "../src/bytes.js";

describe("base64url", () => {
  it("round-trips and uses no padding", () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = toBase64Url(b);
    expect(s).not.toMatch(/[=+/]/);
    expect(fromBase64Url(s)).toEqual(b);
  });
  it("encodes known vector", () => {
    expect(toBase64Url(utf8("hello"))).toBe("aGVsbG8");
    expect(fromUtf8(fromBase64Url("aGVsbG8"))).toBe("hello");
  });
  it("rejects invalid characters", () => {
    expect(() => fromBase64Url("ab$c")).toThrow();
  });
});

describe("base32", () => {
  it("encodes RFC 4648 vectors in lowercase without padding", () => {
    expect(toBase32Lower(utf8(""))).toBe("");
    expect(toBase32Lower(utf8("f"))).toBe("my");
    expect(toBase32Lower(utf8("fo"))).toBe("mzxq");
    expect(toBase32Lower(utf8("foo"))).toBe("mzxw6");
    expect(toBase32Lower(utf8("foobar"))).toBe("mzxw6ytboi");
  });
});

describe("hex and misc", () => {
  it("hex round-trips", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(hexToBytes("000fff")).toEqual(new Uint8Array([0, 15, 255]));
  });
  it("concat and equal", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    expect(concat(a, b)).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytesEqual(concat(a, b), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(a, b)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/protocol && pnpm install && pnpm test`
Expected: FAIL — cannot resolve `../src/bytes.js`.

- [ ] **Step 4: Implement `bytes.ts`**

`packages/protocol/src/bytes.ts`:
```ts
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = new Map<string, number>([...B64].map((c, i) => [c, i]));
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function toBase64Url(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < b.length) {
    const b0 = b[i] as number;
    const b1 = i + 1 < b.length ? (b[i + 1] as number) : 0;
    const n = (b0 << 16) | (b1 << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < b.length) out += B64[(n >> 6) & 63]!;
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = ((acc << 6) | (B64_LOOKUP.get(ch) as number)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function toBase32Lower(b: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of b) {
    acc = ((acc << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31]!;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]!;
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): package skeleton and byte helpers"
```

---

### Task 5: `screen.ts` — runs, lines, `lineKey`, snapshot/diff application (spec 7.4, 8.6, 10.3)

**Files:**
- Create: `packages/protocol/src/screen.ts`, `packages/protocol/test/screen.test.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from "./screen.js";`)

**Interfaces:**
- Produces (all exported):
  - `type Color = number | [number, number, number]`
  - `interface Run { t: string; fg?: Color; bg?: Color; b?: boolean; i?: boolean; u?: boolean; s?: boolean; f?: boolean; n?: number }`
  - `interface Line { r: Run[]; w?: boolean }`, `interface Cursor { x: number; y: number }`
  - `interface ScreenSnapshot { cols; rows; cursor; lines: Line[]; scrollbackTotal; gen; reset?: boolean; degraded?: boolean }`
  - `interface ScreenDiff { scroll; changed: { i; line }[]; cursor; scrollbackTotal; gen }`
  - `interface ScreenState extends ScreenSnapshot { history: Line[]; historyFrom: number }`
  - `emptyLine()`, `sameStyle(a, b)`, `mergeRuns(runs)`, `trimTrailing(runs)`, `colorKey(c?)`, `lineKey(line): string`, `stripStyles(line): Line`, `codePoints(s): number`
  - `applySnapshot(prev: ScreenState | undefined, snap): ScreenState`
  - `applyDiff(state, diff): { state; gap: boolean }`
  - `HISTORY_CAP = 5000`

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/screen.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  applyDiff,
  applySnapshot,
  codePoints,
  emptyLine,
  lineKey,
  mergeRuns,
  stripStyles,
  trimTrailing,
  type Line,
  type ScreenState,
} from "../src/screen.js";

const L = (t: string, extra: Partial<Line["r"][number]> = {}): Line => ({ r: [{ t, ...extra }] });

describe("runs", () => {
  it("merges adjacent runs with identical style and sums n", () => {
    expect(mergeRuns([{ t: "a", fg: 1 }, { t: "b", fg: 1 }, { t: "c", fg: 2 }])).toEqual([
      { t: "ab", fg: 1 },
      { t: "c", fg: 2 },
    ]);
    expect(mergeRuns([{ t: "漢", n: 2 }, { t: "字", n: 2 }])).toEqual([{ t: "漢字", n: 4 }]);
    expect(mergeRuns([{ t: "a" }, { t: "漢", n: 2 }])).toEqual([{ t: "a漢", n: 3 }]);
  });
  it("treats rgb colors by value", () => {
    expect(mergeRuns([{ t: "a", fg: [1, 2, 3] }, { t: "b", fg: [1, 2, 3] }])).toEqual([{ t: "ab", fg: [1, 2, 3] }]);
  });
  it("trims trailing space-only runs without bg", () => {
    expect(trimTrailing([{ t: "hi" }, { t: "   " }])).toEqual([{ t: "hi" }]);
    expect(trimTrailing([{ t: "hi" }, { t: "   ", bg: 4 }])).toEqual([{ t: "hi" }, { t: "   ", bg: 4 }]);
    expect(trimTrailing([{ t: "  " }])).toEqual([]);
  });
  it("counts code points and strips styles", () => {
    expect(codePoints("a🚀b")).toBe(3);
    expect(stripStyles({ r: [{ t: "a", fg: 1, b: true, n: 1 }, { t: "b", bg: 2 }] })).toEqual({ r: [{ t: "ab" }] });
  });
});

describe("lineKey", () => {
  it("is the documented format", () => {
    expect(lineKey({ r: [{ t: "ab", fg: 1, b: true }, { t: "c", bg: [9, 8, 7], f: true, n: 2 }] })).toBe(
      "ab|1||10000|c||9,8,7|00001|2",
    );
  });
  it("differs for different styles and is stable", () => {
    expect(lineKey(L("x"))).toBe(lineKey(L("x")));
    expect(lineKey(L("x"))).not.toBe(lineKey(L("x", { b: true })));
  });
});

describe("applySnapshot / applyDiff", () => {
  const snap = { cols: 10, rows: 3, cursor: { x: 0, y: 2 }, lines: [L("a"), L("b"), L("c")], scrollbackTotal: 100, gen: 1 };

  it("first snapshot starts with empty history", () => {
    const st = applySnapshot(undefined, snap);
    expect(st.lines.map((l) => l.r[0]?.t)).toEqual(["a", "b", "c"]);
    expect(st.history).toEqual([]);
    expect(st.historyFrom).toBe(100);
  });

  it("scroll moves rows into history and appends empties, then applies changes", () => {
    const st = applySnapshot(undefined, snap);
    const { state, gap } = applyDiff(st, {
      scroll: 1,
      changed: [{ i: 2, line: L("d") }],
      cursor: { x: 0, y: 2 },
      scrollbackTotal: 101,
      gen: 2,
    });
    expect(gap).toBe(false);
    expect(state.history.map((l) => l.r[0]?.t)).toEqual(["a"]);
    expect(state.historyFrom).toBe(100);
    expect(state.lines.map((l) => l.r[0]?.t)).toEqual(["b", "c", "d"]);
    expect(state.scrollbackTotal).toBe(101);
  });

  it("a later snapshot keeps history when scrollbackTotal is unchanged, drops it otherwise or on reset", () => {
    let st = applySnapshot(undefined, snap);
    st = applyDiff(st, { scroll: 1, changed: [], cursor: { x: 0, y: 0 }, scrollbackTotal: 101, gen: 2 }).state;
    expect(st.history.length).toBe(1);
    const keep = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3 });
    expect(keep.history.length).toBe(1);
    const drop = applySnapshot(st, { ...snap, scrollbackTotal: 105, gen: 3 });
    expect(drop.history).toEqual([]);
    const reset = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3, reset: true });
    expect(reset.history).toEqual([]);
  });

  it("detects gen gaps and leaves state untouched", () => {
    const st = applySnapshot(undefined, snap);
    const r = applyDiff(st, { scroll: 0, changed: [], cursor: { x: 0, y: 0 }, scrollbackTotal: 100, gen: 5 });
    expect(r.gap).toBe(true);
    expect(r.state).toBe(st);
  });

  it("caps history at 5000 and advances historyFrom", () => {
    let st: ScreenState = applySnapshot(undefined, { ...snap, rows: 1, lines: [L("0")] });
    for (let g = 2; g <= 5002; g++) {
      st = applyDiff(st, { scroll: 1, changed: [{ i: 0, line: L(String(g)) }], cursor: { x: 0, y: 0 }, scrollbackTotal: 100 + g - 1, gen: g }).state;
    }
    expect(st.history.length).toBe(5000);
    expect(st.historyFrom).toBe(101);
  });

  it("emptyLine has no runs", () => {
    expect(emptyLine()).toEqual({ r: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `screen.ts`**

`packages/protocol/src/screen.ts`:
```ts
export type Color = number | [number, number, number];

export interface Run {
  t: string;
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  /** terminal cells occupied; present only when it differs from the code-point count of t */
  n?: number;
}

export interface Line {
  r: Run[];
  /** true when this row is soft-wrapped into the next one */
  w?: boolean;
}

export interface Cursor {
  x: number;
  y: number;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cursor: Cursor;
  lines: Line[];
  scrollbackTotal: number;
  gen: number;
  reset?: boolean;
  degraded?: boolean;
}

export interface ScreenDiff {
  scroll: number;
  changed: { i: number; line: Line }[];
  cursor: Cursor;
  scrollbackTotal: number;
  gen: number;
}

export interface ScreenState extends ScreenSnapshot {
  /** lines above the screen held locally; absolute index of history[0] is historyFrom */
  history: Line[];
  historyFrom: number;
}

export const HISTORY_CAP = 5000;

export function emptyLine(): Line {
  return { r: [] };
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function colorKey(c?: Color): string {
  if (c === undefined) return "";
  return typeof c === "number" ? String(c) : `${c[0]},${c[1]},${c[2]}`;
}

export function sameStyle(a: Run, b: Run): boolean {
  return (
    colorKey(a.fg) === colorKey(b.fg) &&
    colorKey(a.bg) === colorKey(b.bg) &&
    !!a.b === !!b.b &&
    !!a.i === !!b.i &&
    !!a.u === !!b.u &&
    !!a.s === !!b.s &&
    !!a.f === !!b.f
  );
}

function cellsOf(r: Run): number {
  return r.n ?? codePoints(r.t);
}

/** Merge adjacent runs with identical style. `n` is kept only when it differs from the code-point count. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) {
      const cells = cellsOf(last) + cellsOf(r);
      last.t += r.t;
      if (cells !== codePoints(last.t)) last.n = cells;
      else delete last.n;
    } else {
      const copy: Run = { ...r };
      if (copy.n !== undefined && copy.n === codePoints(copy.t)) delete copy.n;
      out.push(copy);
    }
  }
  return out;
}

/** Drop trailing runs that are only spaces and carry no background color. */
export function trimTrailing(runs: Run[]): Run[] {
  const out = runs.slice();
  while (out.length > 0) {
    const last = out[out.length - 1] as Run;
    if (last.bg === undefined && /^ *$/.test(last.t)) out.pop();
    else break;
  }
  return out;
}

export function stripStyles(line: Line): Line {
  const text = line.r.map((r) => r.t).join("");
  const out: Line = { r: text ? [{ t: text }] : [] };
  if (line.w) out.w = true;
  return out;
}

function flags(r: Run): string {
  return `${r.b ? 1 : 0}${r.i ? 1 : 0}${r.u ? 1 : 0}${r.s ? 1 : 0}${r.f ? 1 : 0}`;
}

/** Canonical string form used for row comparison: runs joined by \x1f. */
export function lineKey(line: Line): string {
  return line.r.map((r) => `${r.t}|${colorKey(r.fg)}|${colorKey(r.bg)}|${flags(r)}|${r.n ?? ""}`).join("");
}

export function applySnapshot(prev: ScreenState | undefined, snap: ScreenSnapshot): ScreenState {
  const keepHistory = prev !== undefined && !snap.reset && prev.scrollbackTotal === snap.scrollbackTotal;
  return {
    ...snap,
    lines: snap.lines.slice(),
    history: keepHistory ? prev.history : [],
    historyFrom: keepHistory ? prev.historyFrom : snap.scrollbackTotal,
  };
}

export function applyDiff(state: ScreenState, diff: ScreenDiff): { state: ScreenState; gap: boolean } {
  if (diff.gen !== state.gen + 1) return { state, gap: true };
  const lines = state.lines.slice();
  let history = state.history;
  let historyFrom = state.historyFrom;
  if (diff.scroll > 0) {
    const out = lines.splice(0, Math.min(diff.scroll, lines.length));
    if (history.length === 0) historyFrom = state.scrollbackTotal;
    history = history.concat(out);
    for (let k = 0; k < diff.scroll; k++) lines.push(emptyLine());
    if (history.length > HISTORY_CAP) {
      const drop = history.length - HISTORY_CAP;
      history = history.slice(drop);
      historyFrom += drop;
    }
  }
  for (const c of diff.changed) {
    if (c.i >= 0 && c.i < lines.length) lines[c.i] = c.line;
  }
  return {
    state: {
      ...state,
      lines,
      history,
      historyFrom,
      cursor: diff.cursor,
      scrollbackTotal: diff.scrollbackTotal,
      gen: diff.gen,
      reset: undefined,
      degraded: undefined,
    },
    gap: false,
  };
}
```

Add `export * from "./screen.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): screen types, lineKey, snapshot/diff application"
```

---

### Task 6: `codec.ts` + `envelope.ts` (spec 7.1, 7.2)

**Files:**
- Create: `packages/protocol/src/codec.ts`, `packages/protocol/src/envelope.ts`, `packages/protocol/test/envelope.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `class ProtocolError extends Error { code: "malformed" | "unsupported" | "crypto" | "replay" }`, `encodeCbor(v): Uint8Array`, `decodeCbor(b): unknown`, `Bytes(n?)` zod helper, `FpSchema`, `EnvelopeSchema`, `type Envelope`, `E2EBodySchema`, `type E2EBody`, `encodeEnvelope(e): Uint8Array`, `decodeEnvelope(b): Envelope`, `FRAME_LIMITS = { unauth: 4096, ctrl: 16384, e2eFromPhone: 65536, e2eFromAgent: 1048576 }`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/envelope.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import { decodeEnvelope, encodeEnvelope, FRAME_LIMITS, type Envelope } from "../src/envelope.js";

const FP_A = "a".repeat(26);
const FP_B = "b".repeat(26);

describe("cbor codec", () => {
  it("omits undefined properties and round-trips bytes", () => {
    const enc = encodeCbor({ a: 1, b: undefined, c: new Uint8Array([1, 2]) });
    const dec = decodeCbor(enc) as Record<string, unknown>;
    expect(Object.keys(dec)).toEqual(["a", "c"]);
    expect(dec.c).toBeInstanceOf(Uint8Array);
  });
});

describe("envelope", () => {
  it("round-trips an e2e envelope", () => {
    const e: Envelope = { v: 1, t: "e2e", from: FP_A, to: FP_B, seq: 7, body: { n: new Uint8Array(24), c: new Uint8Array([9]) } };
    const out = decodeEnvelope(encodeEnvelope(e));
    expect(out.from).toBe(FP_A);
    expect(out.seq).toBe(7);
    expect((out.body as { c: Uint8Array }).c).toEqual(new Uint8Array([9]));
  });
  it("accepts 'relay' as from for ctrl", () => {
    const e: Envelope = { v: 1, t: "ctrl", from: "relay", seq: 0, body: { type: "presence", agentOnline: true, computerName: null } };
    expect(decodeEnvelope(encodeEnvelope(e)).from).toBe("relay");
  });
  it("rejects malformed input", () => {
    expect(() => decodeEnvelope(new Uint8Array([0xff, 0x00]))).toThrow(/malformed/);
    expect(() => decodeEnvelope(encodeCbor({ v: 2 }))).toThrow(/malformed/);
    expect(() => decodeEnvelope(encodeCbor({ v: 1, t: "e2e", from: "short", seq: 0, body: {} }))).toThrow(/malformed/);
  });
  it("exposes the documented frame limits", () => {
    expect(FRAME_LIMITS).toEqual({ unauth: 4096, ctrl: 16384, e2eFromPhone: 65536, e2eFromAgent: 1048576 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement**

`packages/protocol/src/codec.ts`:
```ts
import { decode, encode } from "cborg";

export class ProtocolError extends Error {
  constructor(
    public readonly code: "malformed" | "unsupported" | "crypto" | "replay",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProtocolError";
  }
}

/** The only place cborg is called. Optional (undefined) properties never hit the wire. */
export function encodeCbor(value: unknown): Uint8Array {
  return encode(value, { ignoreUndefinedProperties: true });
}

export function decodeCbor(bytes: Uint8Array): unknown {
  try {
    return decode(bytes);
  } catch (err) {
    throw new ProtocolError("malformed", `cbor: ${(err as Error).message}`);
  }
}
```

`packages/protocol/src/envelope.ts`:
```ts
import { z } from "zod";
import { decodeCbor, encodeCbor, ProtocolError } from "./codec.js";

export const FRAME_LIMITS = {
  unauth: 4096,
  ctrl: 16384,
  e2eFromPhone: 65536,
  e2eFromAgent: 1048576,
} as const;

export const Bytes = (n?: number) =>
  z.custom<Uint8Array>((v) => v instanceof Uint8Array && (n === undefined || v.length === n), {
    message: n === undefined ? "expected bytes" : `expected ${n} bytes`,
  });

export const FpSchema = z.string().regex(/^[a-z2-7]{26}$/, "fingerprint");

export const EnvelopeSchema = z.object({
  v: z.literal(1),
  t: z.enum(["ctrl", "e2e"]),
  from: z.union([FpSchema, z.literal("relay")]),
  to: FpSchema.optional(),
  seq: z.number().int().nonnegative(),
  body: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const E2EBodySchema = z.object({ n: Bytes(24), c: Bytes() });
export type E2EBody = z.infer<typeof E2EBodySchema>;

export function encodeEnvelope(e: Envelope): Uint8Array {
  return encodeCbor(e);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const raw = decodeCbor(bytes);
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError("malformed", parsed.error.message);
  return parsed.data;
}
```

Add to `src/index.ts`: `export * from "./codec.js"; export * from "./envelope.js";`

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): cbor codec, envelope schema, frame limits"
```

---

### Task 7: `keys.ts` named keys (spec 7.5)

**Files:**
- Create: `packages/protocol/src/keys.ts`, `packages/protocol/test/keys.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `NAMED_KEYS: Record<NamedKey, string>`, `NamedKeySchema` (zod enum), `type NamedKey`, `bytesForKey(k): string`.

- [ ] **Step 1: Write the failing test**

`packages/protocol/test/keys.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bytesForKey, NAMED_KEYS, NamedKeySchema } from "../src/keys.js";

describe("named keys", () => {
  it("has the documented mappings", () => {
    expect(bytesForKey("enter")).toBe("\r");
    expect(bytesForKey("esc")).toBe("\x1b");
    expect(bytesForKey("ctrl-c")).toBe("\x03");
    expect(bytesForKey("ctrl-z")).toBe("\x1a");
    expect(bytesForKey("up")).toBe("\x1b[A");
    expect(bytesForKey("shift-tab")).toBe("\x1b[Z");
    expect(bytesForKey("delete")).toBe("\x1b[3~");
    expect(bytesForKey("f1")).toBe("\x1bOP");
    expect(bytesForKey("f12")).toBe("\x1b[24~");
    expect(bytesForKey("ctrl-space")).toBe("\x00");
  });
  it("every key maps to a non-empty string and the schema matches the table", () => {
    for (const k of NamedKeySchema.options) expect(NAMED_KEYS[k].length).toBeGreaterThan(0);
    expect(Object.keys(NAMED_KEYS).sort()).toEqual([...NamedKeySchema.options].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test`.

- [ ] **Step 3: Implement `keys.ts`**

`packages/protocol/src/keys.ts`:
```ts
import { z } from "zod";

const ctrl = Object.fromEntries(
  "abcdefghijklmnopqrstuvwxyz".split("").map((c, i) => [`ctrl-${c}`, String.fromCharCode(i + 1)]),
) as Record<`ctrl-${string}`, string>;

export const NAMED_KEYS = {
  enter: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  "page-up": "\x1b[5~",
  "page-down": "\x1b[6~",
  "ctrl-space": "\x00",
  ...ctrl,
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
} as const satisfies Record<string, string>;

export type NamedKey = keyof typeof NAMED_KEYS;
export const NamedKeySchema = z.enum(Object.keys(NAMED_KEYS) as [NamedKey, ...NamedKey[]]);

export function bytesForKey(k: NamedKey): string {
  return NAMED_KEYS[k];
}
```

Add `export * from "./keys.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): named key table"
```

---

### Task 8: `ctrl.ts` and `inner.ts` message schemas (spec 7.3, 7.4)

**Files:**
- Create: `packages/protocol/src/ctrl.ts`, `packages/protocol/src/inner.ts`, `packages/protocol/test/messages.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `CtrlMessageSchema` / `type CtrlMessage` / `parseCtrl(u)`; `InnerMessageSchema` / `type InnerMessage` / `parseInner(u)` / `type InnerMessageOf<T>`; `RoleSchema`, `EventKindSchema`, `AuthFailReasonSchema`, `PairingRejectReasonSchema`; `SessionInfoSchema`/`type SessionInfo`; `RunSchema`, `LineSchema`, `CursorSchema`, `ColorSchema`, `CapabilitiesSchema`/`type Capabilities`, `BackendNameSchema`/`type BackendName`, `CreateWhereSchema`/`type CreateWhere`; `MAX_PAIRINGS = 10`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/messages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseCtrl } from "../src/ctrl.js";
import { parseInner } from "../src/inner.js";

const FP = "c".repeat(26);
const box = { n: new Uint8Array(24), c: new Uint8Array(3) };

describe("ctrl messages", () => {
  it("parses every ctrl type", () => {
    const ok = [
      { type: "challenge", nonce: new Uint8Array(32), connId: "abc" },
      { type: "auth", role: "phone", fp: FP, ed25519Pub: new Uint8Array(32), sig: new Uint8Array(64), name: "iPhone", appVersion: "0.1.0" },
      { type: "auth", role: "pairing", fp: FP, ed25519Pub: new Uint8Array(32), sig: new Uint8Array(64), name: "iPhone", appVersion: "0.1.0", gate: new Uint8Array(16) },
      { type: "auth-ok", role: "phone", agentOnline: true, computerName: "MBP", serverTime: 1, minFrameMs: 125 },
      { type: "auth-fail", reason: "no-window" },
      { type: "presence", agentOnline: false, computerName: null },
      { type: "unpaired", phoneFps: [FP] },
      { type: "phones", connected: [{ phoneFp: FP, connId: "abc", name: "iPhone" }] },
      { type: "pairings-sync", phones: [{ phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "iPhone" }] },
      { type: "pairing-open", gateHash: new Uint8Array(32), expiresAt: 123 },
      { type: "pairing-close" },
      { type: "pairing-request", phoneFp: FP, box },
      { type: "pairing-response", phoneFp: FP, box },
      { type: "pairing-reject", phoneFp: FP, reason: "declined" },
      { type: "pairing-add", phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "iPhone" },
      { type: "unpair", phoneFp: FP },
      { type: "push-token", token: "ExponentPushToken[x]", platform: "ios", enabled: true },
      { type: "lease", ttlMs: 60000 },
      { type: "notify", sessionId: "iterm2:1", kind: "prompt", exitCode: 0, durationMs: 12000 },
      { type: "phone-connected", phoneFp: FP, connId: "abc", name: "iPhone" },
      { type: "phone-disconnected", phoneFp: FP, connId: "abc" },
      { type: "error", code: "x", message: "y" },
    ];
    for (const m of ok) expect(parseCtrl(m).type).toBe(m.type);
  });
  it("rejects unknown type, bad role, oversized lists", () => {
    expect(() => parseCtrl({ type: "nope" })).toThrow(/malformed/);
    expect(() => parseCtrl({ type: "auth", role: "god", fp: FP })).toThrow(/malformed/);
    expect(() => parseCtrl({ type: "lease", ttlMs: 999999 })).toThrow(/malformed/);
    expect(() => parseCtrl({ type: "pairings-sync", phones: Array(11).fill({ phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "x" }) })).toThrow(/malformed/);
  });
});

describe("inner messages", () => {
  it("parses representative inner types", () => {
    const line = { r: [{ t: "hi", fg: 2, b: true }, { t: "漢", n: 2 }] };
    const caps = { subscribe: true, prompts: true, createSession: true, focus: true, history: true, absoluteLines: true };
    const ok = [
      { type: "conn.hello", n: new Uint8Array(16) },
      { type: "hello", agentVersion: "0.1.0", backends: [{ name: "iterm2", capabilities: caps }], computerName: "MBP", accent: "emerald" },
      { type: "sessions", list: [{ id: "iterm2:x", backend: "iterm2", title: "zsh", cols: 80, rows: 24, windowId: "iterm2:w1", windowNumber: 1, tabId: "iterm2:t1", tabIndex: 0, paneIndex: 0, isFocusedOnMac: true, state: "editing" }] },
      { type: "screen.snapshot", sessionId: "iterm2:x", cols: 80, rows: 1, cursor: { x: 0, y: 0 }, lines: [line], scrollbackTotal: 0, gen: 1, reset: true, degraded: false },
      { type: "screen.diff", sessionId: "iterm2:x", scroll: 1, changed: [{ i: 0, line }], cursor: { x: 0, y: 0 }, scrollbackTotal: 1, gen: 2 },
      { type: "history", sessionId: "iterm2:x", before: 10, lines: [line], oldestAvailable: 0 },
      { type: "event", sessionId: "iterm2:x", kind: "idle", durationMs: 5000, at: 1 },
      { type: "ack", reqId: "r1", ok: true, sessionId: "iterm2:y" },
      { type: "subscribe", sessionId: "iterm2:x" },
      { type: "subscribe", sessionId: null },
      { type: "input.line", reqId: "r2", sessionId: "iterm2:x", text: "ls" },
      { type: "input.text", reqId: "r3", sessionId: "iterm2:x", text: "a" },
      { type: "input.key", reqId: "r4", sessionId: "iterm2:x", key: "ctrl-c" },
      { type: "history.get", reqId: "r5", sessionId: "iterm2:x", before: 10, count: 200 },
      { type: "session.create", reqId: "r6", in: { kind: "tab", backend: "tmux" } },
      { type: "session.create", reqId: "r7", in: { kind: "split", sessionId: "iterm2:x", direction: "vertical" } },
      { type: "session.focus", reqId: "r8", sessionId: "iterm2:x" },
      { type: "snapshot.get", reqId: "r9", sessionId: "iterm2:x" },
    ];
    for (const m of ok) expect(parseInner(m).type).toBe(m.type);
  });
  it("rejects a bad key name, count out of range, missing reqId, removed types", () => {
    expect(() => parseInner({ type: "input.key", reqId: "r", sessionId: "x", key: "ctrl-alt-del" })).toThrow(/malformed/);
    expect(() => parseInner({ type: "history.get", reqId: "r", sessionId: "x", before: 1, count: 201 })).toThrow(/malformed/);
    expect(() => parseInner({ type: "input.line", sessionId: "x", text: "ls" })).toThrow(/malformed/);
    expect(() => parseInner({ type: "session.rename", reqId: "r", sessionId: "x", title: "t" })).toThrow(/malformed/);
    expect(() => parseInner({ type: "event", sessionId: "x", kind: "bell", at: 1 })).toThrow(/malformed/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `ctrl.ts`**

`packages/protocol/src/ctrl.ts`:
```ts
import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { Bytes, E2EBodySchema, FpSchema } from "./envelope.js";

export const MAX_PAIRINGS = 10;

export const RoleSchema = z.enum(["agent", "phone", "pairing"]);
export const EventKindSchema = z.enum(["prompt", "idle", "exit"]);
export const AuthFailReasonSchema = z.enum(["bad-sig", "not-paired", "fp-mismatch", "no-agent", "no-window", "timeout"]);
export const PairingRejectReasonSchema = z.enum(["bad-code", "declined", "window-closed", "no-agent", "too-many"]);

const name = z.string().min(1).max(64);
const connId = z.string().min(1).max(64);
const PairingBox = E2EBodySchema;
const PairedPhone = z.object({ phoneFp: FpSchema, ed25519Pub: Bytes(32), name });

export const CtrlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: Bytes(32), connId }),
  z.object({
    type: z.literal("auth"),
    role: RoleSchema,
    fp: FpSchema,
    ed25519Pub: Bytes(32),
    sig: Bytes(64),
    name,
    appVersion: z.string().max(32),
    gate: Bytes(16).optional(),
  }),
  z.object({
    type: z.literal("auth-ok"),
    role: RoleSchema,
    agentOnline: z.boolean(),
    computerName: z.string().max(64).nullable(),
    serverTime: z.number(),
    minFrameMs: z.number().int().min(50).max(2000),
  }),
  z.object({ type: z.literal("auth-fail"), reason: AuthFailReasonSchema }),
  z.object({ type: z.literal("presence"), agentOnline: z.boolean(), computerName: z.string().max(64).nullable() }),
  z.object({ type: z.literal("unpaired"), phoneFps: z.array(FpSchema).max(MAX_PAIRINGS) }),
  z.object({ type: z.literal("phones"), connected: z.array(z.object({ phoneFp: FpSchema, connId, name })).max(MAX_PAIRINGS) }),
  z.object({ type: z.literal("pairings-sync"), phones: z.array(PairedPhone).max(MAX_PAIRINGS) }),
  z.object({ type: z.literal("pairing-open"), gateHash: Bytes(32), expiresAt: z.number() }),
  z.object({ type: z.literal("pairing-close") }),
  z.object({ type: z.literal("pairing-request"), phoneFp: FpSchema, box: PairingBox }),
  z.object({ type: z.literal("pairing-response"), phoneFp: FpSchema, box: PairingBox }),
  z.object({ type: z.literal("pairing-reject"), phoneFp: FpSchema, reason: PairingRejectReasonSchema }),
  z.object({ type: z.literal("pairing-add"), phoneFp: FpSchema, ed25519Pub: Bytes(32), name }),
  z.object({ type: z.literal("unpair"), phoneFp: FpSchema }),
  z.object({ type: z.literal("push-token"), token: z.string().min(1).max(256), platform: z.enum(["ios", "android"]), enabled: z.boolean() }),
  z.object({ type: z.literal("lease"), ttlMs: z.number().int().min(0).max(120000) }),
  z.object({
    type: z.literal("notify"),
    sessionId: z.string().min(1).max(128),
    kind: z.enum(["prompt", "idle"]),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("phone-connected"), phoneFp: FpSchema, connId, name }),
  z.object({ type: z.literal("phone-disconnected"), phoneFp: FpSchema, connId }),
  z.object({ type: z.literal("error"), code: z.string().max(64), message: z.string().max(512) }),
]);
export type CtrlMessage = z.infer<typeof CtrlMessageSchema>;
export type CtrlMessageOf<T extends CtrlMessage["type"]> = Extract<CtrlMessage, { type: T }>;
export type Role = z.infer<typeof RoleSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;

export function parseCtrl(u: unknown): CtrlMessage {
  const r = CtrlMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `ctrl: ${r.error.message}`);
  return r.data;
}
```

- [ ] **Step 4: Implement `inner.ts`**

`packages/protocol/src/inner.ts`:
```ts
import { z } from "zod";
import { ProtocolError } from "./codec.js";
import { EventKindSchema } from "./ctrl.js";
import { Bytes } from "./envelope.js";
import { NamedKeySchema } from "./keys.js";

export const BackendNameSchema = z.enum(["iterm2", "tmux"]);
export type BackendName = z.infer<typeof BackendNameSchema>;

const byte = z.number().int().min(0).max(255);
export const ColorSchema = z.union([byte, z.tuple([byte, byte, byte])]);
export const RunSchema = z.object({
  t: z.string().max(4096),
  fg: ColorSchema.optional(),
  bg: ColorSchema.optional(),
  b: z.boolean().optional(),
  i: z.boolean().optional(),
  u: z.boolean().optional(),
  s: z.boolean().optional(),
  f: z.boolean().optional(),
  n: z.number().int().min(0).max(4096).optional(),
});
export const LineSchema = z.object({ r: z.array(RunSchema).max(2048), w: z.boolean().optional() });
export const CursorSchema = z.object({ x: z.number().int(), y: z.number().int() });

export const CapabilitiesSchema = z.object({
  subscribe: z.boolean(),
  prompts: z.boolean(),
  createSession: z.boolean(),
  focus: z.boolean(),
  history: z.boolean(),
  absoluteLines: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const sid = z.string().min(1).max(128);
const reqId = z.string().min(1).max(64);

export const SessionInfoSchema = z.object({
  id: sid,
  backend: BackendNameSchema,
  title: z.string().max(256),
  cwd: z.string().max(1024).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  windowId: z.string().max(128),
  windowNumber: z.number().int(),
  tabId: z.string().max(128),
  tabIndex: z.number().int(),
  paneIndex: z.number().int(),
  isFocusedOnMac: z.boolean(),
  state: z.enum(["unknown", "editing", "running", "finished"]),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const CreateWhereSchema = z.union([
  z.object({ kind: z.literal("tab"), backend: BackendNameSchema, windowId: z.string().max(128).optional() }),
  z.object({ kind: z.literal("split"), sessionId: sid, direction: z.enum(["vertical", "horizontal"]) }),
]);
export type CreateWhere = z.infer<typeof CreateWhereSchema>;

const screenCommon = {
  sessionId: sid,
  cursor: CursorSchema,
  scrollbackTotal: z.number().int().nonnegative(),
  gen: z.number().int().nonnegative(),
};

export const InnerMessageSchema = z.discriminatedUnion("type", [
  // both directions
  z.object({ type: z.literal("conn.hello"), n: Bytes(16) }),
  // agent -> phone
  z.object({
    type: z.literal("hello"),
    agentVersion: z.string().max(32),
    backends: z.array(z.object({ name: BackendNameSchema, capabilities: CapabilitiesSchema })).max(4),
    computerName: z.string().max(64),
    accent: z.string().max(32),
  }),
  z.object({ type: z.literal("sessions"), list: z.array(SessionInfoSchema).max(500) }),
  z.object({
    type: z.literal("screen.snapshot"),
    ...screenCommon,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    lines: z.array(LineSchema).max(1000),
    reset: z.boolean().optional(),
    degraded: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("screen.diff"),
    ...screenCommon,
    scroll: z.number().int().nonnegative(),
    changed: z.array(z.object({ i: z.number().int().nonnegative(), line: LineSchema })).max(1000),
  }),
  z.object({
    type: z.literal("history"),
    sessionId: sid,
    before: z.number().int().nonnegative(),
    lines: z.array(LineSchema).max(200),
    oldestAvailable: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("event"),
    sessionId: sid,
    kind: EventKindSchema,
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    command: z.string().max(512).optional(),
    at: z.number(),
  }),
  z.object({ type: z.literal("ack"), reqId, ok: z.boolean(), error: z.string().max(256).optional(), sessionId: sid.optional() }),
  // phone -> agent (every one carries reqId except subscribe)
  z.object({ type: z.literal("subscribe"), sessionId: sid.nullable() }),
  z.object({ type: z.literal("input.line"), reqId, sessionId: sid, text: z.string().max(8192) }),
  z.object({ type: z.literal("input.text"), reqId, sessionId: sid, text: z.string().max(65536) }),
  z.object({ type: z.literal("input.key"), reqId, sessionId: sid, key: NamedKeySchema }),
  z.object({ type: z.literal("history.get"), reqId, sessionId: sid, before: z.number().int().nonnegative(), count: z.number().int().min(1).max(200) }),
  z.object({ type: z.literal("session.create"), reqId, in: CreateWhereSchema }),
  z.object({ type: z.literal("session.focus"), reqId, sessionId: sid }),
  z.object({ type: z.literal("snapshot.get"), reqId, sessionId: sid }),
]);
export type InnerMessage = z.infer<typeof InnerMessageSchema>;
export type InnerMessageOf<T extends InnerMessage["type"]> = Extract<InnerMessage, { type: T }>;

export function parseInner(u: unknown): InnerMessage {
  const r = InnerMessageSchema.safeParse(u);
  if (!r.success) throw new ProtocolError("malformed", `inner: ${r.error.message}`);
  return r.data;
}
```

Add to `src/index.ts`: `export * from "./ctrl.js"; export * from "./inner.js";`

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): ctrl and inner message schemas"
```

---

### Task 9: `crypto.ts` — identity, fingerprint, signatures, AEAD, KDFs (spec 6.1–6.7)

**Files:**
- Create: `packages/protocol/src/crypto.ts`, `packages/protocol/test/crypto.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces:
  - `interface Identity { ed25519: { pub; priv }; x25519: { pub; priv }; createdAt: string }`
  - `generateIdentity(): Identity`, `identityFromSeeds(edSeed: Uint8Array, xSeed: Uint8Array, createdAt): Identity` (for vectors), `identityToJson(id): IdentityJson`, `identityFromJson(j): Identity`
  - `fingerprint(ed25519Pub): string`, `sha256(bytes): Uint8Array` (re-export)
  - `sign(priv, msg: string | Uint8Array): Uint8Array`, `verify(pub, msg, sig): boolean`, `authMessage(connId, role, fp, nonce): string`
  - `interface Box { n: Uint8Array; c: Uint8Array }`, `seal(key, plaintext, ad): Box`, `sealWithNonce(key, nonce, plaintext, ad): Box`, `open(key, box, ad): Uint8Array`
  - `derivePskKey(code, computerFp)`, `derivePairKey(myX25519Priv, theirX25519Pub, code, computerFp, phoneFp)`, `deriveConnKey(kPair, nPhone, nAgent, computerFp, phoneFp): { kConn; connTag }`
  - `frameAd(from, to, connTag, seq)`, `helloAd(from, to)`, `pairingAd(kind, computerFp, phoneFp)`, `randomBytes(n)`

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/crypto.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import {
  authMessage,
  deriveConnKey,
  derivePairKey,
  derivePskKey,
  fingerprint,
  frameAd,
  generateIdentity,
  helloAd,
  identityFromJson,
  identityFromSeeds,
  identityToJson,
  open,
  pairingAd,
  randomBytes,
  seal,
  sealWithNonce,
  sign,
  verify,
} from "../src/crypto.js";

describe("identity", () => {
  it("generates 32-byte keys and a 26-char fingerprint", () => {
    const id = generateIdentity();
    expect(id.ed25519.pub.length).toBe(32);
    expect(id.x25519.priv.length).toBe(32);
    expect(fingerprint(id.ed25519.pub)).toMatch(/^[a-z2-7]{26}$/);
  });
  it("is deterministic from seeds", () => {
    const a = identityFromSeeds(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "2026-01-01T00:00:00Z");
    const b = identityFromSeeds(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "2026-01-01T00:00:00Z");
    expect(a.ed25519.pub).toEqual(b.ed25519.pub);
    expect(a.x25519.pub).toEqual(b.x25519.pub);
  });
  it("round-trips through JSON", () => {
    const id = generateIdentity();
    const back = identityFromJson(JSON.parse(JSON.stringify(identityToJson(id))));
    expect(back.ed25519.priv).toEqual(id.ed25519.priv);
    expect(back.x25519.pub).toEqual(id.x25519.pub);
  });
});

describe("signatures", () => {
  it("signs and verifies the auth message", () => {
    const id = generateIdentity();
    const fp = fingerprint(id.ed25519.pub);
    const nonce = randomBytes(32);
    const msg = authMessage("conn1", "phone", fp, nonce);
    const sig = sign(id.ed25519.priv, msg);
    expect(sig.length).toBe(64);
    expect(verify(id.ed25519.pub, msg, sig)).toBe(true);
    expect(verify(id.ed25519.pub, authMessage("conn2", "phone", fp, nonce), sig)).toBe(false);
  });
});

describe("aead", () => {
  it("seals and opens with matching ad; fails otherwise", () => {
    const key = randomBytes(32);
    const box = seal(key, utf8("secret"), "ad1");
    expect(box.n.length).toBe(24);
    expect(open(key, box, "ad1")).toEqual(utf8("secret"));
    expect(() => open(key, box, "ad2")).toThrow(/crypto/);
    expect(() => open(randomBytes(32), box, "ad1")).toThrow(/crypto/);
  });
  it("sealWithNonce is deterministic", () => {
    const key = new Uint8Array(32).fill(9);
    const n = new Uint8Array(24).fill(3);
    expect(sealWithNonce(key, n, utf8("x"), "ad")).toEqual(sealWithNonce(key, n, utf8("x"), "ad"));
  });
});

describe("key derivation", () => {
  const c = generateIdentity();
  const p = generateIdentity();
  const fpC = fingerprint(c.ed25519.pub);
  const fpP = fingerprint(p.ed25519.pub);
  const code = randomBytes(16);

  it("psk key depends on code and computer fp", () => {
    expect(derivePskKey(code, fpC)).toEqual(derivePskKey(code, fpC));
    expect(derivePskKey(code, fpC)).not.toEqual(derivePskKey(randomBytes(16), fpC));
    expect(derivePskKey(code, fpC)).not.toEqual(derivePskKey(code, fpP));
  });

  it("both sides derive the same K_pair; without the code they cannot", () => {
    const kc = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
    const kp = derivePairKey(p.x25519.priv, c.x25519.pub, code, fpC, fpP);
    expect(kc).toEqual(kp);
    expect(derivePairKey(c.x25519.priv, p.x25519.pub, randomBytes(16), fpC, fpP)).not.toEqual(kc);
  });

  it("K_conn differs per connection and old frames do not replay", () => {
    const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
    const a = deriveConnKey(kPair, randomBytes(16), randomBytes(16), fpC, fpP);
    const b = deriveConnKey(kPair, randomBytes(16), randomBytes(16), fpC, fpP);
    expect(a.kConn).not.toEqual(b.kConn);
    expect(a.connTag).toHaveLength(22);
    const frame = seal(a.kConn, utf8("rm -rf /"), frameAd(fpP, fpC, a.connTag, 1));
    expect(() => open(b.kConn, frame, frameAd(fpP, fpC, b.connTag, 1))).toThrow(/crypto/);
    expect(open(a.kConn, frame, frameAd(fpP, fpC, a.connTag, 1))).toEqual(utf8("rm -rf /"));
  });

  it("ad builders are the documented strings", () => {
    expect(frameAd("A", "B", "tag", 5)).toBe("1|A|B|tag|5");
    expect(helloAd("A", "B")).toBe("1|A|B|hello|0");
    expect(pairingAd("request", "C", "P")).toBe("pairing-request|C|P");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `crypto.ts`**

`packages/protocol/src/crypto.ts`:
```ts
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { concat, fromBase64Url, toBase32Lower, toBase64Url, utf8 } from "./bytes.js";
import { ProtocolError } from "./codec.js";

export { randomBytes, sha256 };

export interface Identity {
  ed25519: { pub: Uint8Array; priv: Uint8Array };
  x25519: { pub: Uint8Array; priv: Uint8Array };
  createdAt: string;
}

export function generateIdentity(): Identity {
  return identityFromSeeds(randomBytes(32), randomBytes(32), new Date().toISOString());
}

/** Deterministic construction used by golden vectors and tests. Seeds must be 32 bytes. */
export function identityFromSeeds(edSeed: Uint8Array, xSeed: Uint8Array, createdAt: string): Identity {
  const e = ed25519.keygen(edSeed);
  const x = x25519.keygen(xSeed);
  return {
    ed25519: { pub: e.publicKey, priv: e.secretKey },
    x25519: { pub: x.publicKey, priv: x.secretKey },
    createdAt,
  };
}

const IdentityJsonSchema = z.object({
  v: z.literal(1),
  ed25519: z.object({ pub: z.string(), priv: z.string() }),
  x25519: z.object({ pub: z.string(), priv: z.string() }),
  createdAt: z.string(),
});
export type IdentityJson = z.infer<typeof IdentityJsonSchema>;

export function identityToJson(id: Identity): IdentityJson {
  return {
    v: 1,
    ed25519: { pub: toBase64Url(id.ed25519.pub), priv: toBase64Url(id.ed25519.priv) },
    x25519: { pub: toBase64Url(id.x25519.pub), priv: toBase64Url(id.x25519.priv) },
    createdAt: id.createdAt,
  };
}

export function identityFromJson(j: unknown): Identity {
  const p = IdentityJsonSchema.parse(j);
  return {
    ed25519: { pub: fromBase64Url(p.ed25519.pub), priv: fromBase64Url(p.ed25519.priv) },
    x25519: { pub: fromBase64Url(p.x25519.pub), priv: fromBase64Url(p.x25519.priv) },
    createdAt: p.createdAt,
  };
}

/** base32lower(sha256(pub))[0..26] */
export function fingerprint(ed25519Pub: Uint8Array): string {
  return toBase32Lower(sha256(ed25519Pub)).slice(0, 26);
}

function asBytes(m: string | Uint8Array): Uint8Array {
  return typeof m === "string" ? utf8(m) : m;
}

export function sign(priv: Uint8Array, msg: string | Uint8Array): Uint8Array {
  return ed25519.sign(asBytes(msg), priv);
}

export function verify(pub: Uint8Array, msg: string | Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, asBytes(msg), pub);
  } catch {
    return false;
  }
}

export function authMessage(connId: string, role: string, fp: string, nonce: Uint8Array): string {
  return `shellbell-auth-v1|${connId}|${role}|${fp}|${toBase64Url(nonce)}`;
}

export interface Box {
  n: Uint8Array;
  c: Uint8Array;
}

export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: string): Box {
  const c = xchacha20poly1305(key, nonce, utf8(ad)).encrypt(plaintext);
  return { n: nonce, c };
}

export function seal(key: Uint8Array, plaintext: Uint8Array, ad: string): Box {
  return sealWithNonce(key, randomBytes(24), plaintext, ad);
}

export function open(key: Uint8Array, box: Box, ad: string): Uint8Array {
  try {
    return xchacha20poly1305(key, box.n, utf8(ad)).decrypt(box.c);
  } catch {
    throw new ProtocolError("crypto", "aead open failed");
  }
}

export function derivePskKey(code: Uint8Array, computerFp: string): Uint8Array {
  return hkdf(sha256, code, utf8("shellbell-pairing-v1"), utf8(computerFp), 32);
}

export function derivePairKey(
  myX25519Priv: Uint8Array,
  theirX25519Pub: Uint8Array,
  code: Uint8Array,
  computerFp: string,
  phoneFp: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(myX25519Priv, theirX25519Pub);
  if (shared.every((b) => b === 0)) throw new ProtocolError("crypto", "low-order point");
  return hkdf(sha256, concat(shared, code), utf8("shellbell-pair-v1"), utf8(`${computerFp}|${phoneFp}`), 32);
}

export function deriveConnKey(
  kPair: Uint8Array,
  nPhone: Uint8Array,
  nAgent: Uint8Array,
  computerFp: string,
  phoneFp: string,
): { kConn: Uint8Array; connTag: string } {
  const salt = concat(nPhone, nAgent);
  const kConn = hkdf(sha256, kPair, salt, utf8(`shellbell-conn-v1|${computerFp}|${phoneFp}`), 32);
  const connTag = toBase64Url(sha256(salt)).slice(0, 22);
  return { kConn, connTag };
}

export function frameAd(from: string, to: string, connTag: string, seq: number): string {
  return `1|${from}|${to}|${connTag}|${seq}`;
}

export function helloAd(from: string, to: string): string {
  return `1|${from}|${to}|hello|0`;
}

export function pairingAd(kind: "request" | "response", computerFp: string, phoneFp: string): string {
  return `pairing-${kind}|${computerFp}|${phoneFp}`;
}
```

Add `export * from "./crypto.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. If `ed25519.keygen` does not accept a seed argument, the installed `@noble/curves` is not 2.4.0 — fix the version, do not change the code.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): identity, signatures, AEAD, pairing and connection KDFs"
```

---

### Task 10: `colors.ts` and `qr.ts` (spec 7.6, 10.5, 10.9)

**Files:**
- Create: `packages/protocol/src/colors.ts`, `packages/protocol/src/qr.ts`, `packages/protocol/test/colors.test.ts`, `packages/protocol/test/qr.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `TERMINAL16`, `xterm256Hex(index, theme16?)`, `colorToHex(c, fallback, theme16?)`; `QrPayloadSchema`, `type QrPayload = { v: 1; r; c; e; n; p; g }`, `encodeQr(p)`, `parseQr(text, opts?)`, `relayWsUrl(r: string, fp: string): string`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/colors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { colorToHex, TERMINAL16, xterm256Hex } from "../src/colors.js";

describe("colors", () => {
  it("has 16 theme colors and maps indices", () => {
    expect(TERMINAL16).toHaveLength(16);
    expect(xterm256Hex(1)).toBe(TERMINAL16[1]);
    expect(xterm256Hex(16)).toBe("#000000");
    expect(xterm256Hex(21)).toBe("#0000ff");
    expect(xterm256Hex(196)).toBe("#ff0000");
    expect(xterm256Hex(231)).toBe("#ffffff");
    expect(xterm256Hex(232)).toBe("#080808");
    expect(xterm256Hex(255)).toBe("#eeeeee");
  });
  it("colorToHex handles rgb, index and undefined", () => {
    expect(colorToHex([255, 0, 128], "#abcdef")).toBe("#ff0080");
    expect(colorToHex(2, "#abcdef")).toBe(TERMINAL16[2]);
    expect(colorToHex(undefined, "#abcdef")).toBe("#abcdef");
  });
});
```

`packages/protocol/test/qr.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/bytes.js";
import { fingerprint, generateIdentity } from "../src/crypto.js";
import { encodeQr, parseQr, relayWsUrl } from "../src/qr.js";

describe("qr payload", () => {
  const id = generateIdentity();
  const good = {
    v: 1 as const,
    r: "wss://relay.shellbell.app",
    c: fingerprint(id.ed25519.pub),
    e: toBase64Url(id.ed25519.pub),
    n: "MBP",
    p: toBase64Url(new Uint8Array(16)),
    g: toBase64Url(new Uint8Array(16).fill(1)),
  };

  it("round-trips", () => {
    expect(parseQr(encodeQr(good))).toEqual(good);
  });
  it("rejects fp/e mismatch, non-wss, bad version, trailing slash", () => {
    expect(() => parseQr(encodeQr({ ...good, c: "a".repeat(26) }))).toThrow(/malformed/);
    expect(() => parseQr(encodeQr({ ...good, r: "ws://relay" }))).toThrow(/malformed/);
    expect(parseQr(encodeQr({ ...good, r: "ws://localhost:8787" }), { allowInsecure: true }).r).toBe("ws://localhost:8787");
    expect(() => parseQr(encodeQr({ ...good, r: "wss://relay.shellbell.app/" }))).toThrow(/malformed/);
    expect(() => parseQr(JSON.stringify({ ...good, v: 2 }))).toThrow(/malformed/);
    expect(() => parseQr("not json")).toThrow(/malformed/);
  });
  it("builds the socket url", () => {
    expect(relayWsUrl("wss://relay.shellbell.app", good.c)).toBe(`wss://relay.shellbell.app/ws/${good.c}`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement**

`packages/protocol/src/colors.ts`:
```ts
import type { Color } from "./screen.js";

/** Spec 10.9 terminal16 palette (dark theme). */
export const TERMINAL16: readonly string[] = [
  "#1c1c1e", "#f87171", "#4ade80", "#fbbf24", "#60a5fa", "#c084fc", "#22d3ee", "#d4d4d8",
  "#52525b", "#fca5a5", "#86efac", "#fde68a", "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff",
];

const CUBE = [0, 95, 135, 175, 215, 255];

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

export function xterm256Hex(index: number, theme16: readonly string[] = TERMINAL16): string {
  if (index < 16) return theme16[index] ?? "#ffffff";
  if (index < 232) {
    const i = index - 16;
    const r = CUBE[Math.floor(i / 36)] as number;
    const g = CUBE[Math.floor(i / 6) % 6] as number;
    const b = CUBE[i % 6] as number;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
}

export function colorToHex(c: Color | undefined, fallback: string, theme16: readonly string[] = TERMINAL16): string {
  if (c === undefined) return fallback;
  if (typeof c === "number") return xterm256Hex(c, theme16);
  return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
}
```

`packages/protocol/src/qr.ts`:
```ts
import { z } from "zod";
import { fromBase64Url } from "./bytes.js";
import { ProtocolError } from "./codec.js";
import { fingerprint } from "./crypto.js";
import { FpSchema } from "./envelope.js";

const b64u16 = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const QrPayloadSchema = z.object({
  v: z.literal(1),
  r: z.string().url().max(256),
  c: FpSchema,
  e: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  n: z.string().min(1).max(40),
  p: b64u16,
  g: b64u16,
});
export type QrPayload = z.infer<typeof QrPayloadSchema>;

export function encodeQr(p: QrPayload): string {
  return JSON.stringify(p);
}

export function parseQr(text: string, opts: { allowInsecure?: boolean } = {}): QrPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError("malformed", "qr: not json");
  }
  const r = QrPayloadSchema.safeParse(raw);
  if (!r.success) throw new ProtocolError("malformed", `qr: ${r.error.message}`);
  const p = r.data;
  const url = new URL(p.r);
  if (url.protocol !== "wss:" && !(opts.allowInsecure && url.protocol === "ws:")) {
    throw new ProtocolError("malformed", "qr: relay must be wss://");
  }
  if (p.r.endsWith("/") || url.pathname !== "/" || url.search || url.hash) {
    throw new ProtocolError("malformed", "qr: relay url must be scheme://host[:port] with no path");
  }
  if (fingerprint(fromBase64Url(p.e)) !== p.c) throw new ProtocolError("malformed", "qr: fingerprint mismatch");
  return p;
}

/** `${r}/ws/${fp}` — r is validated to have no trailing slash. */
export function relayWsUrl(r: string, fp: string): string {
  return `${r}/ws/${fp}`;
}
```

Add to `src/index.ts`: `export * from "./colors.js"; export * from "./qr.js";`

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): color palette, QR payload, relay url"
```

---

### Task 11: `width.ts` — terminal cell widths (spec 8.11.2)

**Files:**
- Create: `packages/protocol/src/width.ts`, `packages/protocol/test/width.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `cellWidth(cp: number): 0 | 1 | 2`, `stringCells(s: string): number`.

- [ ] **Step 1: Write the failing tests**

`packages/protocol/test/width.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cellWidth, stringCells } from "../src/width.js";

describe("cell widths", () => {
  it("ascii is 1", () => {
    expect(cellWidth("a".codePointAt(0) as number)).toBe(1);
    expect(stringCells("hello")).toBe(5);
  });
  it("CJK and fullwidth are 2", () => {
    expect(stringCells("漢字")).toBe(4);
    expect(stringCells("Ａ")).toBe(2);
    expect(stringCells("한")).toBe(2);
  });
  it("emoji presentation is 2", () => {
    expect(stringCells("🚀")).toBe(2);
    expect(stringCells("✅")).toBe(2);
  });
  it("combining marks and variation selectors are 0", () => {
    expect(stringCells("é")).toBe(1);
    expect(stringCells("️")).toBe(0);
    expect(stringCells("​")).toBe(0);
  });
  it("ZWJ sequence counts the widest element once", () => {
    expect(stringCells("👨‍💻")).toBe(2);
  });
  it("box drawing and nerd font private-use glyphs are 1", () => {
    expect(stringCells("├──")).toBe(3);
    expect(stringCells("")).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `width.ts`**

`packages/protocol/src/width.ts`:
```ts
/* Terminal cell widths after Markus Kuhn's wcwidth, trimmed to what terminals actually
 * render at 2 cells (East Asian Wide/Fullwidth + emoji presentation) and 0 cells
 * (combining marks, format characters). Ranges are inclusive [lo, hi]. */

const ZERO: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5],
  [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x0816, 0x082d],
  [0x0900, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0957],
  [0x0962, 0x0963], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef],
];

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid] as [number, number];
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

const ZWJ = 0x200d;

/** Sum of cell widths; a ZWJ-joined sequence counts as its widest element. */
export function stringCells(s: string): number {
  let total = 0;
  let joined = false;
  let widest = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === ZWJ) {
      joined = true;
      continue;
    }
    const w = cellWidth(cp);
    if (joined) {
      widest = Math.max(widest, w);
      joined = false;
      continue;
    }
    total += widest;
    widest = w;
  }
  return total + widest;
}
```

Add `export * from "./width.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. (`✅` U+2705 and `🚀` U+1F680 are in the WIDE table; `` is private-use and falls through to 1.)

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): terminal cell width table"
```

---

### Task 12: `sgr.ts` — ANSI SGR line parser (spec 8.11.1)

**Files:**
- Create: `packages/protocol/src/sgr.ts`, `packages/protocol/test/sgr.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `parseSgrLine(text: string): Line`.

- [ ] **Step 1: Write the failing table test**

`packages/protocol/test/sgr.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Line } from "../src/screen.js";
import { parseSgrLine } from "../src/sgr.js";

const E = "\x1b[";
const cases: [string, string, Line][] = [
  ["plain", "hello", { r: [{ t: "hello" }] }],
  ["empty", "", { r: [] }],
  ["bold", `${E}1mhi${E}0m there`, { r: [{ t: "hi", b: true }, { t: " there" }] }],
  ["fg basic", `${E}31mred${E}39m plain`, { r: [{ t: "red", fg: 1 }, { t: " plain" }] }],
  ["bg basic", `${E}44mblue${E}49m`, { r: [{ t: "blue", bg: 4 }] }],
  ["bright fg", `${E}92mok`, { r: [{ t: "ok", fg: 10 }] }],
  ["bright bg", `${E}103mwarn`, { r: [{ t: "warn", bg: 11 }] }],
  ["256 fg semicolon", `${E}38;5;208mo`, { r: [{ t: "o", fg: 208 }] }],
  ["256 bg colon", `${E}48:5:17mo`, { r: [{ t: "o", bg: 17 }] }],
  ["truecolor semicolon", `${E}38;2;1;2;3mx`, { r: [{ t: "x", fg: [1, 2, 3] }] }],
  ["truecolor colon with colorspace", `${E}38:2::9:8:7mx`, { r: [{ t: "x", fg: [9, 8, 7] }] }],
  ["truecolor colon without colorspace", `${E}48:2:9:8:7mx`, { r: [{ t: "x", bg: [9, 8, 7] }] }],
  ["combined params", `${E}1;4;35mx`, { r: [{ t: "x", b: true, u: true, fg: 5 }] }],
  ["reset via empty", `${E}1mx${E}my`, { r: [{ t: "x", b: true }, { t: "y" }] }],
  ["22 clears bold and faint", `${E}1;2mx${E}22my`, { r: [{ t: "x", b: true, f: true }, { t: "y" }] }],
  ["23 clears italic", `${E}3mx${E}23my`, { r: [{ t: "x", i: true }, { t: "y" }] }],
  ["24 clears underline", `${E}4mx${E}24my`, { r: [{ t: "x", u: true }, { t: "y" }] }],
  ["29 clears strike", `${E}9mx${E}29my`, { r: [{ t: "x", s: true }, { t: "y" }] }],
  ["inverse of defaults", `${E}7mx`, { r: [{ t: "x", fg: 0, bg: 15 }] }],
  ["inverse of colors", `${E}31;44;7mx`, { r: [{ t: "x", fg: 4, bg: 1 }] }],
  ["27 clears inverse", `${E}7mx${E}27my`, { r: [{ t: "x", fg: 0, bg: 15 }, { t: "y" }] }],
  ["adjacent same style merges", `${E}31ma${E}31mb`, { r: [{ t: "ab", fg: 1 }] }],
  ["unknown code ignored", `${E}99mx`, { r: [{ t: "x" }] }],
  ["osc stripped", "a\x1b]0;title\x07b", { r: [{ t: "ab" }] }],
  ["osc with ST stripped", "a\x1b]0;title\x1b\\b", { r: [{ t: "ab" }] }],
  ["charset escape stripped", "a\x1b(Bb", { r: [{ t: "ab" }] }],
  ["other csi ignored", `a${E}2Kb`, { r: [{ t: "ab" }] }],
  ["control chars stripped", "a\x07b\x08c", { r: [{ t: "abc" }] }],
  ["tab expands to next multiple of 8", "ab\tc", { r: [{ t: "ab      c" }] }],
  ["tab at column 8", "12345678\tx", { r: [{ t: "12345678        x" }] }],
  ["trailing spaces trimmed", "hi   ", { r: [{ t: "hi" }] }],
  ["trailing spaces with bg kept", `hi${E}41m   `, { r: [{ t: "hi" }, { t: "   ", bg: 1 }] }],
  ["malformed csi emitted literally", "a\x1b[12", { r: [{ t: "a\x1b[12" }] }],
  ["unicode passes through", `${E}32m✓ done`, { r: [{ t: "✓ done", fg: 2 }] }],
  ["emoji surrogate pair kept together and gets n", `${E}1m🚀${E}0mx`, { r: [{ t: "🚀", b: true, n: 2 }, { t: "x" }] }],
  ["CJK run gets n", "漢字ab", { r: [{ t: "漢字ab", n: 6 }] }],
  ["combining mark reduces n", "éx", { r: [{ t: "éx", n: 2 }] }],
  ["faint", `${E}2mx`, { r: [{ t: "x", f: true }] }],
  ["strike", `${E}9mx`, { r: [{ t: "x", s: true }] }],
  ["italic", `${E}3mx`, { r: [{ t: "x", i: true }] }],
  ["reset clears colors", `${E}31;44mx${E}0my`, { r: [{ t: "x", fg: 1, bg: 4 }, { t: "y" }] }],
  ["38 without args ignored", `${E}38mx`, { r: [{ t: "x" }] }],
  ["params with empty entries", `${E};1mx`, { r: [{ t: "x", b: true }] }],
];

describe("parseSgrLine", () => {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseSgrLine(input)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `sgr.ts`**

`packages/protocol/src/sgr.ts`:
```ts
import { type Color, type Line, type Run, codePoints, mergeRuns, trimTrailing } from "./screen.js";
import { stringCells } from "./width.js";

const ESC = "\x1b";
const MAX_CSI = 32;

interface Style {
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  inv?: boolean;
}

function toRun(text: string, st: Style): Run {
  const r: Run = { t: text };
  let fg = st.fg;
  let bg = st.bg;
  if (st.inv) {
    const f = fg ?? 15;
    const g = bg ?? 0;
    fg = g;
    bg = f;
  }
  if (fg !== undefined) r.fg = fg;
  if (bg !== undefined) r.bg = bg;
  if (st.b) r.b = true;
  if (st.i) r.i = true;
  if (st.u) r.u = true;
  if (st.s) r.s = true;
  if (st.f) r.f = true;
  const cells = stringCells(text);
  if (cells !== codePoints(text)) r.n = cells;
  return r;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

/** Parse one "38"/"48" extended color. Returns the color and how many extra groups were consumed. */
function extendedColor(groups: number[][], k: number): { color?: Color; consumed: number } {
  const grp = groups[k] as number[];
  if (grp.length > 1) {
    const mode = grp[1];
    const args = grp.slice(2);
    if (mode === 5 && args.length >= 1) return { color: clamp(args[0] as number), consumed: 0 };
    if (mode === 2) {
      const rgb = args.length >= 4 ? args.slice(1, 4) : args.slice(0, 3);
      if (rgb.length === 3) return { color: [clamp(rgb[0] as number), clamp(rgb[1] as number), clamp(rgb[2] as number)], consumed: 0 };
    }
    return { consumed: 0 };
  }
  const mode = groups[k + 1]?.[0];
  if (mode === 5 && groups[k + 2]) return { color: clamp(groups[k + 2]?.[0] ?? 0), consumed: 2 };
  if (mode === 2 && groups[k + 4]) {
    return {
      color: [clamp(groups[k + 2]?.[0] ?? 0), clamp(groups[k + 3]?.[0] ?? 0), clamp(groups[k + 4]?.[0] ?? 0)],
      consumed: 4,
    };
  }
  return { consumed: 0 };
}

function applySgr(st: Style, params: string): Style {
  const s: Style = { ...st };
  const groups = (params === "" ? ["0"] : params.split(";")).map((p) => p.split(":").map((x) => (x === "" ? 0 : Number(x))));
  for (let k = 0; k < groups.length; k++) {
    const n = groups[k]?.[0] ?? 0;
    if (n === 0) {
      for (const key of Object.keys(s) as (keyof Style)[]) delete s[key];
    } else if (n === 1) s.b = true;
    else if (n === 2) s.f = true;
    else if (n === 3) s.i = true;
    else if (n === 4) s.u = true;
    else if (n === 7) s.inv = true;
    else if (n === 9) s.s = true;
    else if (n === 22) {
      delete s.b;
      delete s.f;
    } else if (n === 23) delete s.i;
    else if (n === 24) delete s.u;
    else if (n === 27) delete s.inv;
    else if (n === 29) delete s.s;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n === 49) delete s.bg;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      const { color, consumed } = extendedColor(groups, k);
      if (color !== undefined) {
        if (n === 38) s.fg = color;
        else s.bg = color;
      }
      k += consumed;
    }
  }
  return s;
}

/** Convert one row of SGR-styled text (as emitted by `tmux capture-pane -e`) into a Line. */
export function parseSgrLine(text: string): Line {
  const runs: Run[] = [];
  let st: Style = {};
  let buf = "";
  let col = 0;
  const flush = () => {
    if (buf) runs.push(toRun(buf, st));
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ESC) {
      const next = text[i + 1];
      if (next === "[") {
        let j = i + 2;
        let params = "";
        while (j < text.length && j - (i + 2) < MAX_CSI) {
          const c = text.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          params += text[j];
          j++;
        }
        if (j >= text.length || j - (i + 2) >= MAX_CSI) {
          buf += ch;
          i++;
          continue;
        }
        if (text[j] === "m") {
          flush();
          st = applySgr(st, params);
        }
        i = j + 1;
        continue;
      }
      if (next === "]") {
        let j = i + 2;
        while (j < text.length && text[j] !== "\x07" && !(text[j] === ESC && text[j + 1] === "\\")) j++;
        i = text[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += next === undefined ? 1 : 2;
      if (next === "(" || next === ")") i += 1; // ESC ( B — designator has one more char
      continue;
    }
    const code = text.charCodeAt(i);
    if (ch === "\t") {
      const n = 8 - (col % 8);
      buf += " ".repeat(n);
      col += n;
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i++;
      continue;
    }
    buf += ch;
    if (code < 0xd800 || code > 0xdbff) col += 1;
    i++;
  }
  flush();
  return { r: trimTrailing(mergeRuns(runs)) };
}
```

Add `export * from "./sgr.js";` to `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. All 45 table cases must pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): ANSI SGR line parser with cell counts"
```

---

### Task 13: Golden vectors (spec 6.1, 15)

**Files:**
- Create: `packages/protocol/scripts/gen-vectors.ts`, `packages/protocol/test/vectors.json` (generated), `packages/protocol/test/vectors.test.ts`, `packages/protocol/src/vectors.ts`

**Interfaces:**
- Produces: `runVectorChecks(vectors: Vectors): { name: string; ok: boolean }[]` in `src/vectors.ts` — the same function the relay test and the app's self-test screen call; `type Vectors`.

- [ ] **Step 1: Write the checker (used by the test and by the other runtimes)**

`packages/protocol/src/vectors.ts`:
```ts
import { bytesToHex, hexToBytes, utf8 } from "./bytes.js";
import {
  deriveConnKey,
  derivePairKey,
  derivePskKey,
  fingerprint,
  frameAd,
  identityFromSeeds,
  open,
  sealWithNonce,
  sign,
  verify,
} from "./crypto.js";

export interface Vectors {
  v: 1;
  computer: { edSeed: string; xSeed: string; fp: string };
  phone: { edSeed: string; xSeed: string; fp: string };
  code: string;
  kPsk: string;
  kPair: string;
  nPhone: string;
  nAgent: string;
  connTag: string;
  kConn: string;
  frame: { nonce: string; plaintext: string; seq: number; ciphertext: string };
  auth: { connId: string; nonce: string; role: string; sig: string };
}

export function runVectorChecks(vec: Vectors): { name: string; ok: boolean }[] {
  const out: { name: string; ok: boolean }[] = [];
  const check = (name: string, fn: () => boolean) => {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    out.push({ name, ok });
  };
  const c = identityFromSeeds(hexToBytes(vec.computer.edSeed), hexToBytes(vec.computer.xSeed), "2026-01-01T00:00:00Z");
  const p = identityFromSeeds(hexToBytes(vec.phone.edSeed), hexToBytes(vec.phone.xSeed), "2026-01-01T00:00:00Z");
  const code = hexToBytes(vec.code);
  check("fingerprint computer", () => fingerprint(c.ed25519.pub) === vec.computer.fp);
  check("fingerprint phone", () => fingerprint(p.ed25519.pub) === vec.phone.fp);
  check("kPsk", () => bytesToHex(derivePskKey(code, vec.computer.fp)) === vec.kPsk);
  const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, vec.computer.fp, vec.phone.fp);
  check("kPair computer side", () => bytesToHex(kPair) === vec.kPair);
  check("kPair phone side", () => bytesToHex(derivePairKey(p.x25519.priv, c.x25519.pub, code, vec.computer.fp, vec.phone.fp)) === vec.kPair);
  const conn = deriveConnKey(kPair, hexToBytes(vec.nPhone), hexToBytes(vec.nAgent), vec.computer.fp, vec.phone.fp);
  check("connTag", () => conn.connTag === vec.connTag);
  check("kConn", () => bytesToHex(conn.kConn) === vec.kConn);
  const ad = frameAd(vec.phone.fp, vec.computer.fp, vec.connTag, vec.frame.seq);
  check("frame seal", () => bytesToHex(sealWithNonce(conn.kConn, hexToBytes(vec.frame.nonce), utf8(vec.frame.plaintext), ad).c) === vec.frame.ciphertext);
  check("frame open", () => new TextDecoder().decode(open(conn.kConn, { n: hexToBytes(vec.frame.nonce), c: hexToBytes(vec.frame.ciphertext) }, ad)) === vec.frame.plaintext);
  const authMsg = `shellbell-auth-v1|${vec.auth.connId}|${vec.auth.role}|${vec.phone.fp}|${vec.auth.nonce}`;
  check("auth signature", () => bytesToHex(sign(p.ed25519.priv, authMsg)) === vec.auth.sig && verify(p.ed25519.pub, authMsg, hexToBytes(vec.auth.sig)));
  return out;
}
```

Add `export * from "./vectors.js";` to `src/index.ts`.

- [ ] **Step 2: Write the generator**

`packages/protocol/scripts/gen-vectors.ts`:
```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, hexToBytes, toBase64Url, utf8 } from "../src/bytes.js";
import { deriveConnKey, derivePairKey, derivePskKey, fingerprint, frameAd, identityFromSeeds, sealWithNonce, sign } from "../src/crypto.js";
import type { Vectors } from "../src/vectors.js";

const fixed = (fill: number) => bytesToHex(new Uint8Array(32).fill(fill));
const c = identityFromSeeds(hexToBytes(fixed(0x11)), hexToBytes(fixed(0x22)), "2026-01-01T00:00:00Z");
const p = identityFromSeeds(hexToBytes(fixed(0x33)), hexToBytes(fixed(0x44)), "2026-01-01T00:00:00Z");
const fpC = fingerprint(c.ed25519.pub);
const fpP = fingerprint(p.ed25519.pub);
const code = new Uint8Array(16).fill(0x55);
const nPhone = new Uint8Array(16).fill(0x66);
const nAgent = new Uint8Array(16).fill(0x77);
const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
const conn = deriveConnKey(kPair, nPhone, nAgent, fpC, fpP);
const frameNonce = new Uint8Array(24).fill(0x88);
const plaintext = '{"type":"input.line","reqId":"r1","sessionId":"iterm2:x","text":"y"}';
const frame = sealWithNonce(conn.kConn, frameNonce, utf8(plaintext), frameAd(fpP, fpC, conn.connTag, 1));
const authNonce = toBase64Url(new Uint8Array(32).fill(0x99));
const authMsg = `shellbell-auth-v1|conn-abc|phone|${fpP}|${authNonce}`;

const vectors: Vectors = {
  v: 1,
  computer: { edSeed: fixed(0x11), xSeed: fixed(0x22), fp: fpC },
  phone: { edSeed: fixed(0x33), xSeed: fixed(0x44), fp: fpP },
  code: bytesToHex(code),
  kPsk: bytesToHex(derivePskKey(code, fpC)),
  kPair: bytesToHex(kPair),
  nPhone: bytesToHex(nPhone),
  nAgent: bytesToHex(nAgent),
  connTag: conn.connTag,
  kConn: bytesToHex(conn.kConn),
  frame: { nonce: bytesToHex(frameNonce), plaintext, seq: 1, ciphertext: bytesToHex(frame.c) },
  auth: { connId: "conn-abc", nonce: authNonce, role: "phone", sig: bytesToHex(sign(p.ed25519.priv, authMsg)) },
};
writeFileSync(join(import.meta.dirname, "..", "test", "vectors.json"), `${JSON.stringify(vectors, null, 2)}\n`);
console.log("wrote test/vectors.json", fpC, fpP);
```

- [ ] **Step 3: Write the test**

`packages/protocol/test/vectors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runVectorChecks, type Vectors } from "../src/vectors.js";
import vectors from "./vectors.json" with { type: "json" };

describe("golden vectors", () => {
  it("all checks pass in Node", () => {
    const results = runVectorChecks(vectors as Vectors);
    expect(results.length).toBe(10);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});
```

- [ ] **Step 4: Generate, run, commit**

Run: `pnpm gen:vectors && pnpm test`
Expected: `vectors.json` written; all tests pass. The generated file is committed and must never be regenerated casually — it is the interoperability contract (regenerating it after a deliberate crypto change is a protocol version bump).

```bash
git add packages/protocol
git commit -m "feat(protocol): golden vectors and cross-runtime checker"
```

---

### Task 14: CI workflow and full-repo verification

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11.12.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```
(macOS runner because the agent package is `os: ["darwin"]`; nothing in CI talks to iTerm2 or tmux — the live tests are env-gated. Plan 05 adds an `expo-doctor` step.)

- [ ] **Step 2: Run the same commands locally**

Run: `pnpm lint && pnpm typecheck && pnpm test` from the repo root.
Expected: all green. Fix Biome complaints with `pnpm lint:fix` and re-run.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint, typecheck, test on push and PR"
```

---

## Plan self-review

- **Spec coverage:** 5 (layout) → Tasks 1, 4; 6.1–6.7 (crypto, vectors) → Tasks 9, 13; 7.1–7.2 → Task 6; 7.3–7.4 → Task 8; 7.5 → Task 7; 7.6 → Task 10; 8.5.1–8.5.2 + 18.1 → Task 2; 8.11 spike + 18.10/18.11 → Task 3; 8.6/10.3 diff application → Task 5; 8.11.1 → Task 12; 8.11.2 → Task 11; 10.9 palette → Task 10; 16 tooling/CI → Tasks 1, 14. Not in this plan (by design): relay (Plan 02), agent runtime (Plan 03), tmux backend (Plan 04), mobile (Plan 05), rings/release (Plan 06).
- **Type consistency:** `Line`/`Run`/`Cursor`/`ScreenSnapshot`/`ScreenDiff` are defined once in `screen.ts` and mirrored by zod schemas in `inner.ts` (`reset`/`degraded`/`n` present in both); `NamedKeySchema` is imported by `inner.ts`; `Box` (crypto) has the same shape as `E2EBodySchema`; `EventKindSchema` (`prompt|idle|exit`) is used by `inner.ts` while `notify` uses the narrower `prompt|idle`; `Capabilities` has six booleans in both the interface and the schema; `identityFromSeeds` is used by both the vectors checker and generator.
- **Placeholders:** none. The only values an implementer fills in are the spikes' measured numbers and the FUNDING.yml handle.
