# Shellbell Plan 03 — Agent core and iTerm2 backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx shellbell` runs on a Mac: it holds an authenticated, reconnecting connection to the relay; pairs phones with a human confirmation; runs the per-connection key handshake; mirrors iTerm2 sessions as scroll-aligned styled diffs to whichever session each phone is viewing; executes inputs exactly once with acks; rings on finished commands and quiet programs; and can be installed as a LaunchAgent.

**Architecture:** `agent.ts` orchestrates five independent units — `RelayClient` (socket + auth + reconnect), `PhoneLink` (per-phone crypto and dedupe), `ScreenTracker` (diff engine), `EventEngine`/`Notifier` (rings), `PairingManager` — over a `TerminalBackend` facade (`BackendRegistry`). The iTerm2 backend is `ITerm2Client` (raw protobuf WebSocket) + `convert.ts` (cells → runs) + `ITerm2Backend` (interface implementation). Every unit is testable with fakes; one integration test wires them all against an in-process fake relay.

**Tech Stack:** Node 22, TypeScript 5.9, `@shellbell/protocol` (workspace), `zod` 4.5.4, `ws` 8.21.3, `@bufbuild/protobuf` 2.14.1, commander 15, qrcode-terminal 0.12, tsdown 0.23, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 6.4 (agent side), 6.6–6.7, 7.4, 8.1–8.10, 8.12 (iTerm2-only for now), 12, 15 (agent tests), 16. Plans 01 and 02 must be complete.

## Global Constraints

- All Plan 01 constraints apply. Runtime deps of the published package: `ws`, `@bufbuild/protobuf`, `commander`, `qrcode-terminal`, `zod`. `@shellbell/protocol` **and its own deps** (`cborg`, `@noble/*`) are bundled into `dist/cli.js` by tsdown (`noExternal: [/^@shellbell\//, "cborg", /^@noble\//]`); `zod` stays external because it is a declared runtime dep.
- **Steps marked "Human-run only" are never executed by implementers.** An implementer reaches such a step, records "not run (human-run only)", and moves on.
- Plan code blocks may exceed Biome's 100-column limit; implementers wrap lines (`pnpm lint:fix`) without changing semantics. `pnpm lint` must pass before every commit.
- `~/.shellbell/` files are written with mode `0600`, the directory `0700`. Tests never touch the real directory: every unit takes a `Paths` object, and tests use `mkdtempSync`.
- Never log keys, cookies, pairing codes, terminal content, or input text. Log input **lengths**.
- Timers: flush interval `max(125, minFrameMs)` ms (the `Agent` applies `minFrameMs` from every `auth-ok`); idle tick 1 s; relay ping 45 s / pong timeout 10 s; relay backoff 1→30 s ±20 %; iTerm2 backend reconnect backoff 1→30 s; `conn.hello` timeout 10 s; iTerm2 request timeout 5 s; pairing window 5 min; confirmation prompt 60 s.
- All units that use time accept `{ now?: () => number }`; units that own timers are driven by `vi.useFakeTimers()` in tests. There is no `setTimer`/`clearTimer` injection anywhere in this plan.
- Session ids leaving the registry are `"<backend>:<native>"`; backends only ever see native ids.
- Commit after every task with `type(scope): summary`.

---

## File structure created by this plan

```
apps/agent/
├── package.json (updated)  tsdown.config.ts  README.md
├── src/
│   ├── cli.ts              commander entry (start, pair, status, devices, unpair, service, logs, config, doctor)
│   ├── agent.ts            orchestrator
│   ├── config.ts           Paths, AgentConfig, Pairing persistence
│   ├── identity.ts         loadOrCreateIdentity
│   ├── log.ts              createLogger
│   ├── relay-client.ts     RelayClient
│   ├── phone-link.ts       PhoneLink
│   ├── screen-tracker.ts   ScreenTracker
│   ├── events.ts           EventEngine
│   ├── notifier.ts         Notifier
│   ├── pairing.ts          PairingManager
│   ├── control.ts          ControlServer / controlRequest
│   ├── launchd.ts          plist + launchctl
│   ├── doctor.ts           checks
│   └── backends/
│       ├── types.ts        TerminalBackend and friends
│       ├── registry.ts     BackendRegistry
│       └── iterm2/
│           ├── auth.ts     (Plan 01)
│           ├── client.ts   ITerm2Client
│           ├── convert.ts  lineContentsToLine
│           └── backend.ts  ITerm2Backend
└── test/
    ├── config.test.ts  log.test.ts  relay-client.test.ts  phone-link.test.ts
    ├── iterm2-client.test.ts  convert.test.ts  iterm2-backend.test.ts
    ├── screen-tracker.test.ts  events.test.ts  pairing.test.ts  registry.test.ts
    ├── agent.integration.test.ts  live-iterm2.test.ts  launchd.test.ts  doctor.test.ts
    ├── fakes/wait.ts  fakes/fake-relay.ts  fakes/fake-backend.ts  fakes/fake-phone.ts
    └── fixtures/  (from Plan 01)
```

---

### Task 1: Config, identity, logging (spec 8.2, 8.3, 8.10)

**Files:**
- Create: `apps/agent/src/config.ts`, `apps/agent/src/identity.ts`, `apps/agent/src/log.ts`, `apps/agent/test/config.test.ts`, `apps/agent/test/log.test.ts`
- Modify: `apps/agent/package.json` — add to `dependencies`:
  `"@shellbell/protocol": "workspace:*"`, `"commander": "15.0.0"`, `"qrcode-terminal": "0.12.0"`, `"zod": "4.5.4"`
  (the agent imports `@shellbell/protocol` from this task onward, and `config.ts`/`pairing.ts` import `zod`
  **directly**; neither is currently declared, and relying on pnpm hoisting is not acceptable).
  Add to `devDependencies`: `"tsdown": "0.23.0"`, `"@types/qrcode-terminal": "0.12.2"`.
  Add scripts `"build": "tsdown"`, `"dev": "tsx src/cli.ts"`.
  After editing, run `pnpm install` from the repo root so the workspace link is created.

**Interfaces:**
- `config.ts`: `DEFAULT_RELAY`, `ACCENTS`, `interface Paths { dir; identity; pairings; config; log; sock; pid }`, `paths(dir?: string): Paths` (default `$SHELLBELL_DIR` or `~/.shellbell`), `AgentConfigSchema`/`type AgentConfig { v: 1; relayUrl; computerName; accent; notifyMinCommandMs; idleQuietMs; idleMinActiveMs }`, `loadConfig(p): AgentConfig` (writes defaults when missing), `saveConfig(p, cfg)`, `PairingSchema`/`type Pairing` (spec 8.3), `loadPairings(p): Pairing[]`, `savePairings(p, list)`, `writeSecretFile(path, text)`.
- `identity.ts`: `loadOrCreateIdentity(p): { identity: Identity; fp: string }`.
- `log.ts`: `interface Logger { debug; info; warn; error: (msg: string, fields?: Record<string, unknown>) => void; child(fields): Logger }`, `createLogger(opts: { file?: string; verbose?: boolean; stdout?: boolean }): Logger`. Rotation at 1 MB, keep 5.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/config.test.ts`:
```ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY, loadConfig, loadPairings, paths, saveConfig, savePairings } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";

const tmp = () => paths(mkdtempSync(join(tmpdir(), "sb-")));

describe("config", () => {
  it("creates defaults with 0600/0700 modes", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    expect(cfg.relayUrl).toBe(DEFAULT_RELAY);
    expect(cfg.computerName.length).toBeGreaterThan(0);
    expect(cfg.notifyMinCommandMs).toBe(10000);
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
  it("round-trips edits", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    saveConfig(p, { ...cfg, relayUrl: "wss://x.example", accent: "rose" });
    expect(loadConfig(p)).toMatchObject({ relayUrl: "wss://x.example", accent: "rose" });
  });
  it("pairings persist", () => {
    const p = tmp();
    expect(loadPairings(p)).toEqual([]);
    savePairings(p, [{ phoneFp: "a".repeat(26), name: "iPhone", platform: "ios", ed25519Pub: "AA", x25519Pub: "BB", kPair: "CC", pairedAt: "2026-01-01T00:00:00Z", lastSeenAt: null }]);
    expect(loadPairings(p)[0]?.name).toBe("iPhone");
    expect(JSON.parse(readFileSync(p.pairings, "utf8")).v).toBe(1);
  });
});

describe("identity", () => {
  it("creates once and reloads the same fingerprint", () => {
    const p = tmp();
    const a = loadOrCreateIdentity(p);
    const b = loadOrCreateIdentity(p);
    expect(a.fp).toBe(b.fp);
    expect(statSync(p.identity).mode & 0o777).toBe(0o600);
  });
});
```

`apps/agent/test/log.test.ts`:
```ts
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

describe("logger", () => {
  it("writes json lines and rotates at 1 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    writeFileSync(file, "x".repeat(1_048_600));
    const log = createLogger({ file, stdout: false });
    log.info("hello", { n: 1 });
    expect(existsSync(`${file}.1`)).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line).toMatchObject({ level: "info", msg: "hello", n: 1 });
    expect(typeof line.t).toBe("string");
  });
  it("debug is dropped unless verbose; child merges fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    const log = createLogger({ file, stdout: false }).child({ phone: "abc" });
    log.debug("nope");
    log.warn("yes");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "warn", phone: "abc" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd apps/agent && pnpm test`.

- [ ] **Step 3: Implement**

`apps/agent/src/config.ts`:
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_RELAY = "wss://relay.shellbell.app";
export const ACCENTS = ["emerald", "blue", "amber", "violet", "rose", "cyan", "lime", "orange"] as const;

export interface Paths {
  dir: string;
  identity: string;
  pairings: string;
  config: string;
  log: string;
  sock: string;
  pid: string;
}

export function paths(dir = process.env.SHELLBELL_DIR ?? join(homedir(), ".shellbell")): Paths {
  return {
    dir,
    identity: join(dir, "identity.json"),
    pairings: join(dir, "pairings.json"),
    config: join(dir, "config.json"),
    log: join(dir, "agent.log"),
    sock: join(dir, "agent.sock"),
    pid: join(dir, "agent.pid"),
  };
}

export function ensureDir(p: Paths): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
}

export function writeSecretFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const AgentConfigSchema = z.object({
  v: z.literal(1),
  relayUrl: z.string().url(),
  computerName: z.string().min(1).max(64),
  accent: z.string().min(1).max(32),
  notifyMinCommandMs: z.number().int().nonnegative().default(10_000),
  idleQuietMs: z.number().int().positive().default(4_000),
  idleMinActiveMs: z.number().int().nonnegative().default(1_500),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

function defaultConfig(): AgentConfig {
  return {
    v: 1,
    relayUrl: DEFAULT_RELAY,
    computerName: hostname().replace(/\.local$/, "") || "Mac",
    accent: ACCENTS[0],
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4_000,
    idleMinActiveMs: 1_500,
  };
}

export function loadConfig(p: Paths): AgentConfig {
  ensureDir(p);
  if (!existsSync(p.config)) {
    const cfg = defaultConfig();
    saveConfig(p, cfg);
    return cfg;
  }
  return AgentConfigSchema.parse(JSON.parse(readFileSync(p.config, "utf8")));
}

export function saveConfig(p: Paths, cfg: AgentConfig): void {
  ensureDir(p);
  writeSecretFile(p.config, `${JSON.stringify(AgentConfigSchema.parse(cfg), null, 2)}\n`);
}

export const PairingSchema = z.object({
  phoneFp: z.string().regex(/^[a-z2-7]{26}$/),
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
  ed25519Pub: z.string(),
  x25519Pub: z.string(),
  kPair: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Pairing = z.infer<typeof PairingSchema>;
const PairingsFile = z.object({ v: z.literal(1), phones: z.array(PairingSchema) });

export function loadPairings(p: Paths): Pairing[] {
  ensureDir(p);
  if (!existsSync(p.pairings)) return [];
  return PairingsFile.parse(JSON.parse(readFileSync(p.pairings, "utf8"))).phones;
}

export function savePairings(p: Paths, phones: Pairing[]): void {
  ensureDir(p);
  writeSecretFile(p.pairings, `${JSON.stringify({ v: 1, phones }, null, 2)}\n`);
}
```

`apps/agent/src/identity.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { fingerprint, generateIdentity, identityFromJson, identityToJson, type Identity } from "@shellbell/protocol";
import { ensureDir, writeSecretFile, type Paths } from "./config.js";

export function loadOrCreateIdentity(p: Paths): { identity: Identity; fp: string } {
  ensureDir(p);
  let identity: Identity;
  if (existsSync(p.identity)) {
    identity = identityFromJson(JSON.parse(readFileSync(p.identity, "utf8")));
  } else {
    identity = generateIdentity();
    writeSecretFile(p.identity, `${JSON.stringify(identityToJson(identity), null, 2)}\n`);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}
```

`apps/agent/src/log.ts`:
```ts
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const MAX_BYTES = 1_048_576;
const KEEP = 5;

function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // best effort
  }
}

export function createLogger(opts: { file?: string; verbose?: boolean; stdout?: boolean }, base: Record<string, unknown> = {}): Logger {
  const stdout = opts.stdout ?? process.stdout.isTTY === true;
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (level === "debug" && !opts.verbose) return;
    const rec = { t: new Date().toISOString(), level, msg, ...base, ...fields };
    if (opts.file) {
      rotate(opts.file);
      try {
        appendFileSync(opts.file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      } catch {
        // disk problems must never crash the agent
      }
    }
    if (stdout) {
      const extra = Object.keys({ ...base, ...fields }).length ? ` ${JSON.stringify({ ...base, ...fields })}` : "";
      const line = `${rec.t.slice(11, 19)} ${level.padEnd(5)} ${msg}${extra}`;
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): config, identity and logging"
```

---

### Task 2: `RelayClient` — socket, auth, reconnect, keepalive (spec 6.5, 8.7)

**Files:**
- Create: `apps/agent/src/relay-client.ts`, `apps/agent/test/fakes/wait.ts`, `apps/agent/test/fakes/fake-relay.ts`, `apps/agent/test/relay-client.test.ts`

**Interfaces:**
- `RelayClientOptions { relayUrl; fp; identity: Identity; name; appVersion; log; backoffMinMs?: 1000; backoffMaxMs?: 30000; pingIntervalMs?: 45000; pongTimeoutMs?: 10000 }`
- `class RelayClient extends EventEmitter` with events: `"auth-ok"(msg)`, `"auth-fail"(reason)`, `"ctrl"(msg: CtrlMessage)`, `"e2e"(env: Envelope)`, `"down"()`. Methods: `start()`, `stop()`, `sendCtrl(body: CtrlMessage)`, `sendEnvelope(env: Envelope)`, getter `online: boolean`.
- `test/fakes/wait.ts`: `waitFor(fn: () => boolean, ms?: number): Promise<void>` — the **single** definition, imported by every test that polls. Do not re-declare it in a test file.
- `test/fakes/fake-relay.ts`: `class FakeRelay { constructor(computerFp: string); url: string; start(): Promise<void>; stop(): Promise<void>; agent: Peer | null; phones: Map<string, Peer>; pairing: Map<string, Peer>; received: { from: Peer; env: Envelope }[]; ctrlFromAgent: CtrlMessage[]; sendCtrl(ws, body); sendToAgent(body: CtrlMessage); nextCtrlFromAgent(timeoutMs?): Promise<CtrlMessage>; dropAgent(): void }` — implements challenge/auth (any valid signature passes; the fp must equal the URL's), replies `auth-ok` → `unpaired` → `phones` **in that order** for the agent role, forwards e2e between agent and registered fake phones, forwards `pairing-request`/`pairing-response`/`pairing-reject`, and exposes `dropAgent()` to simulate a disconnect.
  **Fidelity limits (deliberate, so tests stay readable):** the fake does *not* verify the pairing `gate` against `pairing-open.gateHash`, does *not* enforce the real relay's one-`pairing-request`-per-socket rule, does *not* close a pairing socket after `pairing-reject` (the real relay closes it `4003`), and does *not* enforce the 5-admission cap or the 60 msg/s token bucket. Anything that depends on those is covered by the relay's own tests in Plan 02.

- [ ] **Step 1: Write the shared wait helper and the fake relay**

`apps/agent/test/fakes/wait.ts` (the only definition of `waitFor` in the repo):
```ts
/** Polls `fn` every 10 ms until it is true, or rejects after `ms`. */
export function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
```

`apps/agent/test/fakes/fake-relay.ts`:
```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authMessage,
  decodeEnvelope,
  encodeEnvelope,
  fingerprint,
  parseCtrl,
  randomBytes,
  toBase64Url,
  verify,
  type CtrlMessage,
  type Envelope,
} from "@shellbell/protocol";
import { WebSocketServer, type WebSocket } from "ws";

interface Peer {
  ws: WebSocket;
  fp: string;
  role: "agent" | "phone" | "pairing";
  connId: string;
}

/** Minimal in-process relay double: one computer, any number of phones. */
export class FakeRelay {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = "";
  agent: Peer | null = null;
  phones = new Map<string, Peer>();
  pairing = new Map<string, Peer>();
  received: { from: Peer; env: Envelope }[] = [];
  ctrlFromAgent: CtrlMessage[] = [];
  private waiters: ((m: CtrlMessage) => void)[] = [];

  constructor(private readonly computerFp: string) {}

  async start(): Promise<void> {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws, req) => {
      const fpInUrl = (req.url ?? "").split("/").pop();
      if (fpInUrl !== this.computerFp) {
        ws.close(4001, "unknown computer");
        return;
      }
      const nonce = randomBytes(32);
      const connId = toBase64Url(randomBytes(16));
      let peer: Peer | null = null;
      this.sendCtrl(ws, { type: "challenge", nonce, connId });
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeEnvelope(new Uint8Array(data as Buffer));
        if (!peer) {
          const msg = parseCtrl(env.body);
          if (msg.type !== "auth") return ws.close(4403);
          const ok = fingerprint(msg.ed25519Pub) === msg.fp && verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig);
          if (!ok) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "bad-sig" });
            return ws.close(4001);
          }
          if (msg.role === "agent" && msg.fp !== this.computerFp) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "fp-mismatch" });
            return ws.close(4001);
          }
          peer = { ws, fp: msg.fp, role: msg.role, connId };
          const okMsg: CtrlMessage = { type: "auth-ok", role: msg.role, agentOnline: this.agent !== null || msg.role === "agent", computerName: "FakeMac", serverTime: Date.now(), minFrameMs: 125 };
          if (msg.role === "agent") {
            this.agent?.ws.close(4005);
            this.agent = peer;
            this.sendCtrl(ws, okMsg);
            this.sendCtrl(ws, { type: "unpaired", phoneFps: [] });
            this.sendCtrl(ws, { type: "phones", connected: [...this.phones.values()].map((p) => ({ phoneFp: p.fp, connId: p.connId, name: "phone" })) });
          } else if (msg.role === "phone") {
            this.phones.get(msg.fp)?.ws.close(4005);
            this.phones.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
            if (this.agent) this.sendCtrl(this.agent.ws, { type: "phone-connected", phoneFp: msg.fp, connId, name: msg.name });
          } else {
            this.pairing.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
          }
          return;
        }
        if (env.t === "ctrl") {
          const msg = parseCtrl(env.body);
          if (peer.role === "agent") {
            this.ctrlFromAgent.push(msg);
            this.waiters.shift()?.(msg);
            if (msg.type === "pairing-response" || msg.type === "pairing-reject") {
              const target = this.pairing.get(msg.phoneFp);
              if (target) this.sendCtrl(target.ws, msg);
            }
          } else if (peer.role === "pairing" && msg.type === "pairing-request" && this.agent) {
            this.sendCtrl(this.agent.ws, msg);
          }
          return;
        }
        this.received.push({ from: peer, env });
        const target = peer.role === "agent" ? this.phones.get(env.to ?? "")?.ws : this.agent?.ws;
        if (target) target.send(data as Buffer, { binary: true });
      });
      ws.on("close", () => {
        if (!peer) return;
        if (peer.role === "agent" && this.agent === peer) this.agent = null;
        if (peer.role === "phone" && this.phones.get(peer.fp) === peer) {
          this.phones.delete(peer.fp);
          if (this.agent) this.sendCtrl(this.agent.ws, { type: "phone-disconnected", phoneFp: peer.fp, connId: peer.connId });
        }
        if (peer.role === "pairing") this.pairing.delete(peer.fp);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }), { binary: true });
  }

  sendToAgent(body: CtrlMessage): void {
    if (this.agent) this.sendCtrl(this.agent.ws, body);
  }

  nextCtrlFromAgent(timeoutMs = 2000): Promise<CtrlMessage> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for agent ctrl")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  dropAgent(): void {
    this.agent?.ws.terminate();
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => this.wss?.close(() => r()));
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/relay-client.test.ts`:
```ts
import { fingerprint, generateIdentity } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { RelayClient } from "../src/relay-client.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let relay: FakeRelay;
const id = generateIdentity();
const fp = fingerprint(id.ed25519.pub);

beforeEach(async () => {
  relay = new FakeRelay(fp);
  await relay.start();
});
afterEach(async () => relay.stop());

describe("RelayClient", () => {
  it("authenticates, receives unpaired+phones, reports online", async () => {
    const c = new RelayClient({ relayUrl: relay.url, fp, identity: id, name: "MBP", appVersion: "t", log, backoffMinMs: 50, backoffMaxMs: 100 });
    const ctrl: string[] = [];
    c.on("ctrl", (m) => ctrl.push(m.type));
    c.start();
    await waitFor(() => c.online);
    await waitFor(() => ctrl.includes("phones"));
    expect(ctrl).toEqual(["unpaired", "phones"]);
    c.stop();
  });

  it("reconnects with backoff after the relay drops it", async () => {
    const c = new RelayClient({ relayUrl: relay.url, fp, identity: id, name: "MBP", appVersion: "t", log, backoffMinMs: 50, backoffMaxMs: 100 });
    let downs = 0;
    c.on("down", () => downs++);
    c.start();
    await waitFor(() => c.online);
    relay.dropAgent();
    await waitFor(() => downs === 1);
    await waitFor(() => c.online);
    expect(relay.agent).not.toBeNull();
    c.stop();
  });

  it("reports auth-fail bad-sig when the signing key does not match the fp", async () => {
    const other = generateIdentity();
    const c = new RelayClient({ relayUrl: relay.url, fp, identity: other, name: "MBP", appVersion: "t", log, backoffMinMs: 50, backoffMaxMs: 100 });
    let reason = "";
    c.on("auth-fail", (r) => (reason = r));
    c.start();
    await waitFor(() => reason !== "");
    expect(reason).toBe("bad-sig");
    c.stop();
  });

  it("forwards ctrl from the relay and sends ctrl to it", async () => {
    const c = new RelayClient({ relayUrl: relay.url, fp, identity: id, name: "MBP", appVersion: "t", log, backoffMinMs: 50, backoffMaxMs: 100 });
    c.start();
    await waitFor(() => c.online);
    c.sendCtrl({ type: "pairing-close" });
    expect((await relay.nextCtrlFromAgent()).type).toBe("pairing-close");
    const got: string[] = [];
    c.on("ctrl", (m) => got.push(m.type));
    relay.sendToAgent({ type: "presence", agentOnline: true, computerName: "x" });
    await waitFor(() => got.includes("presence"));
    c.stop();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 4: Implement `relay-client.ts`**

`apps/agent/src/relay-client.ts`:
```ts
import { EventEmitter } from "node:events";
import {
  authMessage,
  decodeEnvelope,
  encodeEnvelope,
  parseCtrl,
  relayWsUrl,
  sign,
  type CtrlMessage,
  type CtrlMessageOf,
  type Envelope,
  type Identity,
} from "@shellbell/protocol";
import WebSocket from "ws";
import type { Logger } from "./log.js";

export interface RelayClientOptions {
  relayUrl: string;
  fp: string;
  identity: Identity;
  name: string;
  appVersion: string;
  log: Logger;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface RelayClientEvents {
  "auth-ok": [CtrlMessageOf<"auth-ok">];
  "auth-fail": [CtrlMessageOf<"auth-fail">["reason"]];
  ctrl: [CtrlMessage];
  e2e: [Envelope];
  down: [];
}

export class RelayClient extends EventEmitter<RelayClientEvents> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private authed = false;
  private readonly log: Logger;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this.log = opts.log.child({ unit: "relay" });
  }

  get online(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "stop");
    this.ws = null;
    this.authed = false;
  }

  sendCtrl(body: CtrlMessage): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.opts.fp, seq: 0, body });
  }

  sendEnvelope(env: Envelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeEnvelope(env), { binary: true });
  }

  private connect(): void {
    if (this.stopped) return;
    const url = relayWsUrl(this.opts.relayUrl, this.opts.fp);
    this.log.info("connecting", { attempt: this.attempt });
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => this.log.debug("socket open"));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      let env: Envelope;
      try {
        env = decodeEnvelope(new Uint8Array(data as Buffer));
      } catch (err) {
        this.log.warn("malformed frame from relay", { err: String(err) });
        return;
      }
      if (env.t === "e2e") {
        if (this.authed) this.emit("e2e", env);
        return;
      }
      let msg: CtrlMessage;
      try {
        msg = parseCtrl(env.body);
      } catch (err) {
        this.log.warn("malformed ctrl from relay", { err: String(err) });
        return;
      }
      this.onCtrl(msg);
    });
    ws.on("pong", () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    ws.on("close", (code, reason) => {
      this.log.info("socket closed", { code, reason: reason.toString() });
      this.onDown();
    });
    ws.on("error", (err) => {
      this.log.warn("socket error", { err: err.message });
    });
  }

  private onCtrl(msg: CtrlMessage): void {
    if (msg.type === "challenge") {
      const sig = sign(this.opts.identity.ed25519.priv, authMessage(msg.connId, "agent", this.opts.fp, msg.nonce));
      this.sendCtrl({
        type: "auth",
        role: "agent",
        fp: this.opts.fp,
        ed25519Pub: this.opts.identity.ed25519.pub,
        sig,
        name: this.opts.name,
        appVersion: this.opts.appVersion,
      });
      return;
    }
    if (msg.type === "auth-ok") {
      this.authed = true;
      this.attempt = 0;
      this.startPing();
      this.log.info("authenticated", { minFrameMs: msg.minFrameMs });
      this.emit("auth-ok", msg);
      return;
    }
    if (msg.type === "auth-fail") {
      this.log.error("auth failed", { reason: msg.reason });
      this.emit("auth-fail", msg.reason);
      if (msg.reason === "fp-mismatch") this.stopped = true;
      return;
    }
    this.emit("ctrl", msg);
  }

  private onDown(): void {
    const wasAuthed = this.authed;
    this.authed = false;
    this.clearTimers();
    this.ws = null;
    if (wasAuthed) this.emit("down");
    if (this.stopped) return;
    const min = this.opts.backoffMinMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.reconnectTimer = setTimeout(() => this.connect(), Math.max(0, base + jitter));
  }

  private startPing(): void {
    const interval = this.opts.pingIntervalMs ?? 45_000;
    const timeout = this.opts.pongTimeoutMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.log.warn("pong timeout; reconnecting");
        this.ws?.terminate();
      }, timeout);
    }, interval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.pingTimer = this.pongTimer = null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): relay client with auth, backoff reconnect and protocol pings"
```

---

### Task 3: `PhoneLink` — per-connection handshake, encryption, sequence and dedupe (spec 6.6, 6.7, 7.4)

**Files:**
- Create: `apps/agent/src/phone-link.ts`, `apps/agent/test/fakes/fake-phone.ts`, `apps/agent/test/phone-link.test.ts`

**Interfaces:**
- `PhoneLinkOptions { phoneFp; connId; name; kPair: Uint8Array; computerFp; send: (env: Envelope) => void; log; now?: () => number }`
- `class PhoneLink`: `readonly phoneFp`, `readonly connId`, `readonly name`, `readonly openedAt: number`, `handshaken: boolean`, `dormant: boolean`, `viewed: string | null`, `handleEnvelope(env: Envelope): InnerMessage | null` (handles `conn.hello`, replay/seq checks, `reqId` dedupe; returns a message the agent must act on, or `null`), `send(msg: InnerMessage): boolean` (false if not handshaken), `rememberAck(reqId: string, ack: InnerMessageOf<"ack">)`, `broken: boolean` (set after 20 consecutive decrypt failures), `onBroken?: () => void`, `helloOverdue(now?: number): boolean`.
- **`conn.hello` timeout (spec 6.6, 10 s).** `openedAt` is stamped when the link is created (on `phone-connected`). `helloOverdue(now)` is `true` when the link is still un-handshaken, not already `dormant`, and `now - openedAt >= 10_000`. The agent's 1 s tick calls it, logs **once**, and sets `dormant = true` — the link is then ignored until a `conn.hello` actually arrives, which clears `dormant`. The agent does **not** close the socket: the relay owns it.
- `test/fakes/fake-phone.ts`: `class FakePhone` — the phone side of the protocol for tests: `constructor(identity, computerFp, kPair)`, `hello(): Envelope` (its `conn.hello`), `acceptHello(env): void` (derives `K_conn`), `seal(msg: InnerMessage): Envelope`, `open(env): InnerMessage`.

- [ ] **Step 1: Write the fake phone**

`apps/agent/test/fakes/fake-phone.ts`:
```ts
import {
  decodeCbor,
  deriveConnKey,
  encodeCbor,
  fingerprint,
  frameAd,
  helloAd,
  open,
  parseInner,
  randomBytes,
  seal,
  type Envelope,
  type Identity,
  type InnerMessage,
} from "@shellbell/protocol";

export class FakePhone {
  readonly fp: string;
  private nPhone = randomBytes(16);
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seq = 0;
  private lastSeq = 0;

  constructor(
    readonly identity: Identity,
    private readonly computerFp: string,
    private readonly kPair: Uint8Array,
  ) {
    this.fp = fingerprint(identity.ed25519.pub);
  }

  hello(): Envelope {
    this.nPhone = randomBytes(16);
    this.kConn = null;
    this.seq = 0;
    this.lastSeq = 0;
    const box = seal(this.kPair, encodeCbor({ type: "conn.hello", n: this.nPhone }), helloAd(this.fp, this.computerFp));
    return { v: 1, t: "e2e", from: this.fp, to: this.computerFp, seq: 0, body: box };
  }

  acceptHello(env: Envelope): void {
    const body = env.body as { n: Uint8Array; c: Uint8Array };
    const inner = parseInner(decodeCbor(open(this.kPair, body, helloAd(this.computerFp, this.fp))));
    if (inner.type !== "conn.hello") throw new Error("expected conn.hello");
    const d = deriveConnKey(this.kPair, this.nPhone, inner.n, this.computerFp, this.fp);
    this.kConn = d.kConn;
    this.connTag = d.connTag;
  }

  seal(msg: InnerMessage): Envelope {
    if (!this.kConn) throw new Error("no kConn");
    this.seq += 1;
    const box = seal(this.kConn, encodeCbor(msg), frameAd(this.fp, this.computerFp, this.connTag, this.seq));
    return { v: 1, t: "e2e", from: this.fp, to: this.computerFp, seq: this.seq, body: box };
  }

  open(env: Envelope): InnerMessage {
    if (!this.kConn) throw new Error("no kConn");
    if (env.seq <= this.lastSeq) throw new Error("replay");
    this.lastSeq = env.seq;
    const body = env.body as { n: Uint8Array; c: Uint8Array };
    return parseInner(decodeCbor(open(this.kConn, body, frameAd(this.computerFp, this.fp, this.connTag, env.seq))));
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/phone-link.test.ts`:
```ts
import { derivePairKey, fingerprint, generateIdentity, randomBytes, type Envelope, type InnerMessage } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { PhoneLink } from "../src/phone-link.js";
import { FakePhone } from "./fakes/fake-phone.js";

const log = createLogger({ stdout: false });

function setup() {
  const mac = generateIdentity();
  const phoneId = generateIdentity();
  const fpC = fingerprint(mac.ed25519.pub);
  const fpP = fingerprint(phoneId.ed25519.pub);
  const code = randomBytes(16);
  const kPair = derivePairKey(mac.x25519.priv, phoneId.x25519.pub, code, fpC, fpP);
  const phone = new FakePhone(phoneId, fpC, derivePairKey(phoneId.x25519.priv, mac.x25519.pub, code, fpC, fpP));
  const sent: Envelope[] = [];
  const link = new PhoneLink({ phoneFp: fpP, connId: "c1", name: "iPhone", kPair, computerFp: fpC, send: (e) => sent.push(e), log });
  return { link, phone, sent };
}

describe("PhoneLink", () => {
  it("completes the handshake and exchanges frames both ways", () => {
    const { link, phone, sent } = setup();
    expect(link.handleEnvelope(phone.hello())).toBeNull();
    expect(link.handshaken).toBe(true);
    phone.acceptHello(sent[0] as Envelope);
    const msg: InnerMessage = { type: "subscribe", sessionId: "iterm2:x" };
    expect(link.handleEnvelope(phone.seal(msg))).toEqual(msg);
    expect(link.send({ type: "ack", reqId: "r", ok: true })).toBe(true);
    expect(phone.open(sent[1] as Envelope)).toEqual({ type: "ack", reqId: "r", ok: true });
  });

  it("rejects replayed and out-of-order frames", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const env = phone.seal({ type: "subscribe", sessionId: null });
    expect(link.handleEnvelope(env)).not.toBeNull();
    expect(link.handleEnvelope(env)).toBeNull(); // replay
  });

  it("re-handshake gives a new key so old frames stop decrypting", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const old = phone.seal({ type: "subscribe", sessionId: null });
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[1] as Envelope);
    expect(link.handleEnvelope(old)).toBeNull();
    expect(link.handleEnvelope(phone.seal({ type: "subscribe", sessionId: null }))).not.toBeNull();
  });

  it("returns a cached ack for a duplicate reqId instead of the message", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const input: InnerMessage = { type: "input.line", reqId: "r1", sessionId: "s", text: "ls" };
    expect(link.handleEnvelope(phone.seal(input))).toEqual(input);
    link.rememberAck("r1", { type: "ack", reqId: "r1", ok: true });
    expect(link.handleEnvelope(phone.seal(input))).toBeNull();
    expect(phone.open(sent[sent.length - 1] as Envelope)).toEqual({ type: "ack", reqId: "r1", ok: true });
  });

  it("marks itself broken after 20 consecutive failures", () => {
    const { link, phone } = setup();
    let broken = 0;
    link.onBroken = () => broken++;
    for (let i = 0; i < 20; i++) link.handleEnvelope({ ...phone.hello(), body: { n: new Uint8Array(24), c: new Uint8Array(20) } });
    expect(link.broken).toBe(true);
    expect(broken).toBe(1);
  });

  it("does not send before the handshake", () => {
    const { link } = setup();
    expect(link.send({ type: "ack", reqId: "r", ok: true })).toBe(false);
  });

  it("reports conn.hello overdue after 10 s and stops once a late hello arrives", () => {
    const { link, phone } = setup();
    const t0 = link.openedAt;
    expect(link.helloOverdue(t0 + 9_999)).toBe(false);
    expect(link.helloOverdue(t0 + 10_000)).toBe(true);
    link.dormant = true; // what the agent does after logging once
    expect(link.helloOverdue(t0 + 20_000)).toBe(false); // already reported; not reported twice
    link.handleEnvelope(phone.hello());
    expect(link.handshaken).toBe(true);
    expect(link.dormant).toBe(false);
    expect(link.helloOverdue(t0 + 60_000)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 4: Implement `phone-link.ts`**

`apps/agent/src/phone-link.ts`:
```ts
import {
  decodeCbor,
  deriveConnKey,
  E2EBodySchema,
  encodeCbor,
  frameAd,
  helloAd,
  open,
  parseInner,
  randomBytes,
  seal,
  type Envelope,
  type InnerMessage,
  type InnerMessageOf,
} from "@shellbell/protocol";
import type { Logger } from "./log.js";

export interface PhoneLinkOptions {
  phoneFp: string;
  connId: string;
  name: string;
  kPair: Uint8Array;
  computerFp: string;
  send: (env: Envelope) => void;
  log: Logger;
  now?: () => number;
}

const MAX_FAILURES = 20;
const ACK_CACHE = 256;
const HELLO_TIMEOUT_MS = 10_000;

export class PhoneLink {
  readonly phoneFp: string;
  readonly connId: string;
  readonly name: string;
  readonly openedAt: number;
  handshaken = false;
  broken = false;
  /** Set by the agent when no conn.hello arrived within 10 s; cleared by a late conn.hello. */
  dormant = false;
  viewed: string | null = null;
  onBroken?: () => void;
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seqOut = 0;
  private seqIn = 0;
  private failures = 0;
  private readonly acks = new Map<string, InnerMessageOf<"ack">>();
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: PhoneLinkOptions) {
    this.phoneFp = opts.phoneFp;
    this.connId = opts.connId;
    this.name = opts.name;
    this.now = opts.now ?? (() => Date.now());
    this.openedAt = this.now();
    this.log = opts.log.child({ phone: opts.phoneFp.slice(0, 8), conn: opts.connId.slice(0, 6) });
  }

  /** True once the 10 s conn.hello window (spec 6.6) has passed with no handshake. */
  helloOverdue(now: number = this.now()): boolean {
    return !this.handshaken && !this.dormant && now - this.openedAt >= HELLO_TIMEOUT_MS;
  }

  handleEnvelope(env: Envelope): InnerMessage | null {
    if (this.broken) return null;
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return this.fail("bad body");
    // conn.hello is always accepted under K_pair with seq 0 (re-handshake resets the connection)
    if (env.seq === 0) {
      try {
        const inner = parseInner(decodeCbor(open(this.opts.kPair, body.data, helloAd(this.phoneFp, this.opts.computerFp))));
        if (inner.type !== "conn.hello") return this.fail("expected conn.hello");
        const nAgent = randomBytes(16);
        const d = deriveConnKey(this.opts.kPair, inner.n, nAgent, this.opts.computerFp, this.phoneFp);
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        this.handshaken = true;
        this.dormant = false;
        this.failures = 0;
        this.acks.clear();
        const reply = seal(this.opts.kPair, encodeCbor({ type: "conn.hello", n: nAgent }), helloAd(this.opts.computerFp, this.phoneFp));
        this.opts.send({ v: 1, t: "e2e", from: this.opts.computerFp, to: this.phoneFp, seq: 0, body: reply });
        this.log.info("handshake complete");
        return null;
      } catch {
        return this.fail("hello decrypt failed");
      }
    }
    if (!this.kConn) return this.fail("frame before handshake");
    if (env.seq <= this.seqIn) {
      this.log.warn("replayed or reordered frame dropped", { seq: env.seq, last: this.seqIn });
      return null;
    }
    let inner: InnerMessage;
    try {
      inner = parseInner(decodeCbor(open(this.kConn, body.data, frameAd(this.phoneFp, this.opts.computerFp, this.connTag, env.seq))));
    } catch {
      return this.fail("frame decrypt failed");
    }
    this.seqIn = env.seq;
    this.failures = 0;
    if ("reqId" in inner) {
      const cached = this.acks.get(inner.reqId);
      if (cached) {
        this.send(cached);
        return null;
      }
    }
    return inner;
  }

  send(msg: InnerMessage): boolean {
    if (!this.kConn || this.broken) return false;
    this.seqOut += 1;
    const box = seal(this.kConn, encodeCbor(msg), frameAd(this.opts.computerFp, this.phoneFp, this.connTag, this.seqOut));
    this.opts.send({ v: 1, t: "e2e", from: this.opts.computerFp, to: this.phoneFp, seq: this.seqOut, body: box });
    return true;
  }

  rememberAck(reqId: string, ack: InnerMessageOf<"ack">): void {
    this.acks.set(reqId, ack);
    if (this.acks.size > ACK_CACHE) {
      const first = this.acks.keys().next().value;
      if (first !== undefined) this.acks.delete(first);
    }
  }

  private fail(reason: string): null {
    this.failures += 1;
    this.log.warn(reason, { failures: this.failures });
    if (this.failures >= MAX_FAILURES && !this.broken) {
      this.broken = true;
      this.onBroken?.();
    }
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): phone link with conn.hello handshake, seq and ack dedupe"
```

---

### Task 4: `ITerm2Client` — raw API client (spec 8.5.1)

**Files:**
- Create: `apps/agent/src/backends/iterm2/client.ts`, `apps/agent/test/iterm2-client.test.ts`

**Interfaces:**
- `ITerm2ClientOptions { log; socketPath?: string; url?: string; appName?: string; cookieProvider?: () => Promise<{ cookie: string; key: string }>; requestTimeoutMs?: number }` — **there is exactly one connect mode.**
- **How to dial the socket (settled by the M0 spike — do not improvise).** `docs/spike-iterm2.md` and Plan 01's errata record that *both* obvious approaches are dead in `ws@8.21.3`:
  - `ws+unix://${encodeURI(socketPath)}:/` fails `ENOENT` — the WHATWG `URL` parser percent-encodes the space in `.../Library/Application Support/iTerm2/...` to `%20` and `ws` uses that pathname verbatim as the filesystem path, never decoding it.
  - passing `socketPath` in the constructor options is dead code — `initAsClient` unconditionally resets `opts.socketPath = undefined`, so the client silently falls back to TCP `localhost:80` (`ECONNREFUSED`).

  The client therefore uses ws's documented `createConnection` hook, exactly as the shipped `scripts/spike-iterm2.ts` does:
  `new WebSocket("ws://localhost/", ["api.iterm2.com"], { headers, createConnection: () => netConnect({ path: socketPath }) })`
  with `import { connect as netConnect } from "node:net"`. `url` remains as a **test-only** override that dials a plain TCP `ws://` server.
- `type ClientSub = Exclude<ClientOriginatedMessage["submessage"], { case: undefined }>`
- `class ITerm2Client extends EventEmitter<{ notification: [Notification]; close: [] }>`: `connect(): Promise<void>`, `close(): void`, `request(sub: ClientSub): Promise<ServerOriginatedMessage>` (rejects after `requestTimeoutMs`, default 5000, or on socket close), `readonly connected: boolean`.
- Throws `ITerm2AuthError` from `auth.ts` when the cookie cannot be obtained.

- [ ] **Step 1: Write the failing test** (fake iTerm2 over TCP)

`apps/agent/test/iterm2-client.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ITerm2Client } from "../src/backends/iterm2/client.js";
import {
  ClientOriginatedMessageSchema,
  ListSessionsRequestSchema,
  ListSessionsResponseSchema,
  NotificationSchema,
  ScreenUpdateNotificationSchema,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { createLogger } from "../src/log.js";

let server: Server;
let wss: WebSocketServer;
let url: string;
let headersSeen: Record<string, string | string[] | undefined> = {};

beforeEach(async () => {
  server = createServer();
  wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has("api.iterm2.com") ? "api.iterm2.com" : false) });
  wss.on("connection", (ws, req) => {
    headersSeen = req.headers;
    ws.on("message", (data) => {
      const msg = fromBinary(ClientOriginatedMessageSchema, new Uint8Array(data as Buffer));
      if (msg.submessage.case === "listSessionsRequest") {
        const resp = create(ServerOriginatedMessageSchema, {
          id: msg.id,
          submessage: { case: "listSessionsResponse", value: create(ListSessionsResponseSchema, { windows: [] }) },
        });
        ws.send(toBinary(ServerOriginatedMessageSchema, resp));
        const notif = create(ServerOriginatedMessageSchema, {
          submessage: {
            case: "notification",
            value: create(NotificationSchema, { screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }) }),
          },
        });
        ws.send(toBinary(ServerOriginatedMessageSchema, notif));
      }
      // getBufferRequest is deliberately never answered → timeout test
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

const log = createLogger({ stdout: false });
const cookieProvider = async () => ({ cookie: "C", key: "K" });

describe("ITerm2Client", () => {
  it("connects with the iTerm2 headers and correlates responses; notifications are emitted", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 500 });
    const notifs: string[] = [];
    c.on("notification", (n) => notifs.push(n.screenUpdateNotification?.session ?? ""));
    await c.connect();
    expect(headersSeen["x-iterm2-cookie"]).toBe("C");
    expect(headersSeen["x-iterm2-key"]).toBe("K");
    expect(headersSeen["x-iterm2-advisory-name"]).toBe("Shellbell");
    const res = await c.request({ case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) });
    expect(res.submessage.case).toBe("listSessionsResponse");
    await new Promise((r) => setTimeout(r, 50));
    expect(notifs).toEqual(["S1"]);
    c.close();
  });

  it("times out an unanswered request", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 100 });
    await c.connect();
    await expect(c.request({ case: "getBufferRequest", value: { $typeName: "iterm2.GetBufferRequest", session: "x" } as never })).rejects.toThrow(/timeout/);
    c.close();
  });

  it("dials a Unix domain socket through createConnection when no url override is given", async () => {
    // Pins the fix from docs/spike-iterm2.md: never `socketPath`, never `ws+unix://`.
    const sock = join(mkdtempSync(join(tmpdir(), "sb-iterm-")), "socket");
    const unixServer = createServer();
    const unixWss = new WebSocketServer({ server: unixServer, handleProtocols: (p) => (p.has("api.iterm2.com") ? "api.iterm2.com" : false) });
    await new Promise<void>((r) => unixServer.listen(sock, r));
    const c = new ITerm2Client({ log, socketPath: sock, cookieProvider, requestTimeoutMs: 500 });
    await c.connect();
    expect(c.connected).toBe(true);
    c.close();
    for (const s of unixWss.clients) s.terminate();
    await new Promise<void>((r) => unixWss.close(() => r()));
    await new Promise<void>((r) => unixServer.close(() => r()));
  });

  it("rejects pending requests when the socket closes and emits close", async () => {
    const c = new ITerm2Client({ log, url, cookieProvider, requestTimeoutMs: 5000 });
    let closed = 0;
    c.on("close", () => closed++);
    await c.connect();
    const p = c.request({ case: "getBufferRequest", value: { $typeName: "iterm2.GetBufferRequest", session: "x" } as never });
    for (const s of wss.clients) s.terminate();
    await expect(p).rejects.toThrow(/closed/);
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `client.ts`**

`apps/agent/src/backends/iterm2/client.ts`:
```ts
import { EventEmitter } from "node:events";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import WebSocket from "ws";
import type { Logger } from "../../log.js";
import { requestCookieAndKey } from "./auth.js";
import {
  ClientOriginatedMessageSchema,
  ServerOriginatedMessageSchema,
  type ClientOriginatedMessage,
  type Notification,
  type ServerOriginatedMessage,
} from "./gen/iterm2_pb.js";

export type ClientSub = Exclude<ClientOriginatedMessage["submessage"], { case: undefined }>;

export interface ITerm2ClientOptions {
  log: Logger;
  socketPath?: string;
  /** Test-only override: dial this plain TCP ws:// URL instead of the Unix socket. */
  url?: string;
  appName?: string;
  cookieProvider?: () => Promise<{ cookie: string; key: string }>;
  requestTimeoutMs?: number;
}

export const DEFAULT_SOCKET = join(homedir(), "Library", "Application Support", "iTerm2", "private", "socket");

export class ITerm2Client extends EventEmitter<{ notification: [Notification]; close: [] }> {
  private ws: WebSocket | null = null;
  private nextId = 1n;
  private readonly pending = new Map<bigint, { resolve: (m: ServerOriginatedMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly log: Logger;

  constructor(private readonly opts: ITerm2ClientOptions) {
    super();
    this.log = opts.log.child({ unit: "iterm2" });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const appName = this.opts.appName ?? "Shellbell";
    const { cookie, key } = await (this.opts.cookieProvider ?? (() => requestCookieAndKey(appName)))();
    const headers = {
      origin: "ws://localhost/",
      "x-iterm2-library-version": "shellbell 0.1.0",
      "x-iterm2-disable-auth-ui": "true",
      "x-iterm2-advisory-name": appName,
      "x-iterm2-cookie": cookie,
      "x-iterm2-key": key,
    };
    const socketPath = this.opts.socketPath ?? DEFAULT_SOCKET;
    // ws 8.21.3 discards the `socketPath` option and mangles `ws+unix://` paths that contain a
    // space, so the Unix socket is dialled through the `createConnection` hook. See
    // docs/spike-iterm2.md. `url` is only used by tests.
    const ws = this.opts.url
      ? new WebSocket(this.opts.url, ["api.iterm2.com"], { headers })
      : new WebSocket("ws://localhost/", ["api.iterm2.com"], {
          headers,
          createConnection: () => netConnect({ path: socketPath }),
        });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(e));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`iTerm2 API responded HTTP ${res.statusCode}`)));
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      let msg: ServerOriginatedMessage;
      try {
        msg = fromBinary(ServerOriginatedMessageSchema, new Uint8Array(data as Buffer));
      } catch (err) {
        this.log.warn("undecodable message from iTerm2", { err: String(err) });
        return;
      }
      if (msg.submessage.case === "notification") {
        this.emit("notification", msg.submessage.value);
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
    });
    ws.on("close", () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("iTerm2 connection closed"));
        this.pending.delete(id);
      }
      this.ws = null;
      this.emit("close");
    });
    ws.on("error", (err) => this.log.warn("iTerm2 socket error", { err: err.message }));
    this.log.info("connected to iTerm2 API");
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("iTerm2 not connected"));
    const id = this.nextId++;
    const msg = create(ClientOriginatedMessageSchema, { id, submessage: sub });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iTerm2 request timeout (${sub.case})`));
      }, this.opts.requestTimeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(toBinary(ClientOriginatedMessageSchema, msg), { binary: true });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`. If the `ws` server rejects the subprotocol, check the `handleProtocols` callback in the test returns the string. The Unix-socket test binds under `mkdtempSync(tmpdir())`; on macOS the path must stay under ~104 bytes (it does).

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): iTerm2 protobuf client with request correlation and notifications"
```

---

### Task 5: `convert.ts` — iTerm2 cells → runs (spec 8.5.5)

**Files:**
- Create: `apps/agent/src/backends/types.ts`, `apps/agent/src/backends/iterm2/convert.ts`, `apps/agent/test/convert.test.ts`

**Interfaces:**
- `types.ts` exactly as spec 8.4 plus: `class BackendUnavailable extends Error { hint: string }`, `class SessionGone extends Error`, `class Unsupported extends Error`, `class BadWindow extends Error`, and two optional methods on `TerminalBackend`: `tmuxWindowIds?(): Set<string>` (iTerm2: tmux-integration window ids it shows) and `tmuxWindowIdOf?(nativeId: string): string | undefined` (tmux backend, Plan 04). It is created **here**, in Task 5, because `convert.ts` returns its `Screen` type; Task 6 consumes it unchanged.
- `lineContentsToLine(lc: LineContents): Line` and `bufferToScreen(resp: GetBufferResponse, rows: number, cols: number): Screen` — `Screen` is **imported from `../types.js`**. There is exactly one definition of that shape in the repo; do not declare a second `ScreenShape` interface.

- [ ] **Step 1: Write `backends/types.ts`**

`apps/agent/src/backends/types.ts`:
```ts
import type { BackendName, Capabilities, CreateWhere, Cursor, Line, SessionInfo } from "@shellbell/protocol";

export type { Capabilities, CreateWhere, SessionInfo };

export interface Screen {
  cols: number;
  rows: number;
  cursor: Cursor;
  lines: Line[];
  scrollbackTotal: number;
}

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

export class BackendUnavailable extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "BackendUnavailable";
  }
}
export class SessionGone extends Error {
  constructor(id: string) {
    super(`session gone: ${id}`);
    this.name = "SessionGone";
  }
}
export class Unsupported extends Error {
  constructor(what: string) {
    super(`unsupported: ${what}`);
    this.name = "Unsupported";
  }
}
/** Spec 8.12: a `session.create` whose windowId prefix does not match `where.backend`. */
export class BadWindow extends Error {
  constructor(windowId: string) {
    super(`bad-window: ${windowId}`);
    this.name = "BadWindow";
  }
}

export interface TerminalBackend {
  readonly name: BackendName;
  readonly capabilities: Capabilities;
  connect(): Promise<void>;
  close(): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getScreen(sessionId: string): Promise<Screen>;
  getHistory(sessionId: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }>;
  sendText(sessionId: string, text: string): Promise<void>;
  createSession(where: CreateWhere): Promise<string>;
  focus(sessionId: string): Promise<void>;
  on(handler: (e: BackendEvent) => void): () => void;
  tmuxWindowIds?(): Set<string>;
  tmuxWindowIdOf?(nativeId: string): string | undefined;
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/convert.test.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import { codePoints } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { bufferToScreen, lineContentsToLine } from "../src/backends/iterm2/convert.js";
import {
  AlternateColor,
  CellStyleSchema,
  CodePointsPerCellSchema,
  LineContents_Continuation,
  LineContentsSchema,
  RGBColorSchema,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";

const style = (init: Parameters<typeof create<typeof CellStyleSchema>>[1]) => create(CellStyleSchema, init);

describe("lineContentsToLine", () => {
  it("unstyled text becomes one run", () => {
    const lc = create(LineContentsSchema, { text: "hello" });
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "hello" }] });
  });

  it("RLE styles split into runs; fgStandard/bgRgb/bold map; trailing spaces trimmed", () => {
    const lc = create(LineContentsSchema, {
      text: "abcd   ",
      style: [
        style({ fgColor: { case: "fgStandard", value: 1 }, bold: true, repeats: 2 }),
        style({ bgColor: { case: "bgRgb", value: create(RGBColorSchema, { red: 9, green: 8, blue: 7 }) }, repeats: 2 }),
        style({ repeats: 3 }),
      ],
    });
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "ab", fg: 1, b: true }, { t: "cd", bg: [9, 8, 7] }] });
  });

  it("inverse swaps with 15/0 defaults; alternate colors are undefined; invisible becomes spaces", () => {
    const lc = create(LineContentsSchema, {
      text: "xyzA",
      style: [
        style({ inverse: true, repeats: 1 }),
        style({ fgColor: { case: "fgAlternate", value: AlternateColor.DEFAULT }, repeats: 1 }),
        style({ invisible: true, fgColor: { case: "fgStandard", value: 2 }, repeats: 1 }),
        style({ repeats: 1 }),
      ],
    });
    // "A" keeps the invisible cell off the end of the line, so trimTrailing leaves it alone.
    expect(lineContentsToLine(lc)).toEqual({
      r: [{ t: "x", fg: 0, bg: 15 }, { t: "y" }, { t: " ", fg: 2 }, { t: "A" }],
    });
  });

  it("a trailing space-only run with no bg is dropped (shipped trimTrailing)", () => {
    const lc = create(LineContentsSchema, {
      text: "xz",
      style: [
        style({ repeats: 1 }),
        style({ invisible: true, fgColor: { case: "fgStandard", value: 2 }, repeats: 1 }),
      ],
    });
    // screen.ts trimTrailing() pops any trailing run whose text trims to "" and that has no bg,
    // so the invisible cell disappears entirely when it is last on the line.
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "x" }] });
  });

  it("code_points_per_cell: uninitialized cell → space, combining mark folds into one cell, n set when cells ≠ code points", () => {
    // The `text` literal below is DECOMPOSED on purpose: it is the two code points n + U+0303,
    // not the precomposed U+00F1. Editors and "fix mojibake" passes love to normalise it to NFC,
    // which is one code point -- that would make cells === codePoints, silently drop `n`, and fail
    // this test for a reason invisible in a diff. Verify with
    // `node -e 'console.log([..."<the literal>"].length)'` -> must print 3, not 2.
    // display: "a<uninitialized cell><n + combining tilde>".
    const lc = create(LineContentsSchema, {
      text: "añ",
      codePointsPerCell: [
        create(CodePointsPerCellSchema, { numCodePoints: 1, repeats: 1 }),
        create(CodePointsPerCellSchema, { numCodePoints: 0, repeats: 1 }),
        create(CodePointsPerCellSchema, { numCodePoints: 2, repeats: 1 }),
      ],
    });
    const line = lineContentsToLine(lc);
    expect(line.r).toHaveLength(1);
    expect(line.r[0]?.t).toBe("a ñ");
    expect(line.r[0]?.n).toBe(3);
    expect(codePoints(line.r[0]?.t ?? "")).toBe(4);
  });

  it("soft wrap sets w", () => {
    const lc = create(LineContentsSchema, { text: "x", continuation: LineContents_Continuation.SOFT_EOL });
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "x" }], w: true });
  });
});

describe("real fixtures", () => {
  const dir = join(import.meta.dirname, "fixtures");
  const files = readdirSync(dir).filter((f) => f.startsWith("getbuffer-") && f.endsWith(".json"));

  it("has at least one committed GetBuffer fixture", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s converts with invariants", (file) => {
    const msg = fromJson(ServerOriginatedMessageSchema, JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (msg.submessage.case !== "getBufferResponse") throw new Error("fixture is not a GetBufferResponse");
    const resp = msg.submessage.value;
    let sawRun = false;
    for (const lc of resp.contents) {
      const line = lineContentsToLine(lc);
      const cells = line.r.reduce((n, r) => n + (r.n ?? codePoints(r.t)), 0);
      const totalCells = lc.codePointsPerCell.reduce((n, c) => n + (c.repeats || 1), 0) || codePoints(lc.text);
      // 1. Conversion never invents cells.
      expect(cells).toBeLessThanOrEqual(totalCells);
      for (const run of line.r) {
        sawRun = true;
        // 2. mergeRuns never leaves an empty run behind.
        expect(run.t.length).toBeGreaterThan(0);
        // 3. `n` is present only when it differs from the code-point count (spec 7.4).
        if (run.n !== undefined) expect(run.n).not.toBe(codePoints(run.t));
        // 4. Palette colors stay in range.
        if (typeof run.fg === "number") expect(run.fg).toBeLessThanOrEqual(255);
        if (typeof run.bg === "number") expect(run.bg).toBeLessThanOrEqual(255);
      }
      // 5. trimTrailing invariant: no trailing space-only run without a bg survives.
      const last = line.r[line.r.length - 1];
      if (last && last.bg === undefined) expect(last.t.replace(/ +$/, "")).not.toBe("");
    }
    expect(sawRun).toBe(true);
    const rows = resp.contents.length || 1;
    const screen = bufferToScreen(resp, rows, 80);
    expect(screen.lines.length).toBe(rows);
    expect(screen.cols).toBe(80);
    expect(screen.scrollbackTotal).toBeGreaterThanOrEqual(0);
    expect(screen.cursor.y).toBeGreaterThanOrEqual(-1);
    expect(screen.cursor.y).toBeLessThanOrEqual(rows - 1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 4: Implement `convert.ts`**

`apps/agent/src/backends/iterm2/convert.ts`:
```ts
import { codePoints, emptyLine, mergeRuns, trimTrailing, type Color, type Cursor, type Line, type Run } from "@shellbell/protocol";
import type { Screen } from "../types.js";
import { type CellStyle, type GetBufferResponse, type LineContents, LineContents_Continuation } from "./gen/iterm2_pb.js";

interface Style {
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  invisible?: boolean;
}

function normalize(st: CellStyle | undefined): Style {
  if (!st) return {};
  let fg: Color | undefined;
  let bg: Color | undefined;
  if (st.fgColor.case === "fgStandard") fg = st.fgColor.value;
  else if (st.fgColor.case === "fgRgb") fg = [st.fgColor.value.red ?? 0, st.fgColor.value.green ?? 0, st.fgColor.value.blue ?? 0];
  if (st.bgColor.case === "bgStandard") bg = st.bgColor.value;
  else if (st.bgColor.case === "bgRgb") bg = [st.bgColor.value.red ?? 0, st.bgColor.value.green ?? 0, st.bgColor.value.blue ?? 0];
  if (st.inverse) {
    const f = fg ?? 15;
    const g = bg ?? 0;
    fg = g;
    bg = f;
  }
  const out: Style = {};
  if (fg !== undefined) out.fg = fg;
  if (bg !== undefined) out.bg = bg;
  if (st.bold) out.b = true;
  if (st.italic) out.i = true;
  if (st.underline) out.u = true;
  if (st.strikethrough) out.s = true;
  if (st.faint) out.f = true;
  if (st.invisible) out.invisible = true;
  return out;
}

function styleKey(s: Style): string {
  return `${JSON.stringify(s.fg ?? null)}|${JSON.stringify(s.bg ?? null)}|${s.b ? 1 : 0}${s.i ? 1 : 0}${s.u ? 1 : 0}${s.s ? 1 : 0}${s.f ? 1 : 0}${s.invisible ? 1 : 0}`;
}

export function lineContentsToLine(lc: LineContents): Line {
  const cps = Array.from(lc.text ?? "");
  // `repeats` has no proto default, so protobuf-es materialises 0 when it is unset -- `|| 1`, not
  // `?? 1`, is what turns that into "one cell". `num_code_points` DOES carry [default = 1], so it
  // is already 1 when unset, and an explicit 0 legitimately means "uninitialized cell".
  const cellCp: number[] = [];
  for (const c of lc.codePointsPerCell) for (let k = 0; k < (c.repeats || 1); k++) cellCp.push(c.numCodePoints);
  if (cellCp.length === 0) for (let k = 0; k < cps.length; k++) cellCp.push(1);
  const cellStyle: (CellStyle | undefined)[] = [];
  for (const s of lc.style) for (let k = 0; k < (s.repeats || 1); k++) cellStyle.push(s);

  const runs: Run[] = [];
  let cur: { style: Style; key: string; text: string; cells: number } | null = null;
  let ti = 0;
  for (let k = 0; k < cellCp.length; k++) {
    const n = cellCp[k] as number;
    let cellText: string;
    if (n === 0) cellText = " ";
    else {
      cellText = cps.slice(ti, ti + n).join("");
      ti += n;
    }
    const st = normalize(cellStyle[k]);
    if (st.invisible) cellText = " ".repeat(Math.max(1, codePoints(cellText)));
    const key = styleKey(st);
    if (cur && cur.key === key) {
      cur.text += cellText;
      cur.cells += 1;
    } else {
      if (cur) runs.push(toRun(cur));
      cur = { style: st, key, text: cellText, cells: 1 };
    }
  }
  if (cur) runs.push(toRun(cur));
  const line: Line = { r: trimTrailing(mergeRuns(runs)) };
  // protobuf-es v2 strips the enum-name prefix: proto CONTINUATION_SOFT_EOL -> TS SOFT_EOL.
  if (lc.continuation === LineContents_Continuation.SOFT_EOL) line.w = true;
  return line;
}

function toRun(c: { style: Style; text: string; cells: number }): Run {
  const r: Run = { t: c.text };
  if (c.style.fg !== undefined) r.fg = c.style.fg;
  if (c.style.bg !== undefined) r.bg = c.style.bg;
  if (c.style.b) r.b = true;
  if (c.style.i) r.i = true;
  if (c.style.u) r.u = true;
  if (c.style.s) r.s = true;
  if (c.style.f) r.f = true;
  if (c.cells !== codePoints(c.text)) r.n = c.cells;
  return r;
}

export function bufferToScreen(resp: GetBufferResponse, rows: number, cols: number): Screen {
  const first = Number(resp.windowedCoordRange?.coordRange?.start?.y ?? 0n);
  const lines = resp.contents.map(lineContentsToLine);
  while (lines.length < rows) lines.push(emptyLine());
  if (lines.length > rows) lines.length = rows;
  const cy = resp.cursor ? Number(resp.cursor.y ?? 0n) - first : -1;
  const cursor: Cursor = { x: resp.cursor?.x ?? 0, y: Math.max(-1, Math.min(rows - 1, cy)) };
  return { cols, rows, cursor, lines, scrollbackTotal: first };
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. `apps/agent/test/fixtures/getbuffer-1788542830080.json` is committed, so the fixture suite must run **at least one** case — the `expect(files.length).toBeGreaterThan(0)` guard fails loudly if the fixtures ever go missing.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): iTerm2 cell/style conversion to runs"
```

---

### Task 6: `TerminalBackend` types and `ITerm2Backend` (spec 8.4, 8.5.3, 8.5.4, 8.5.6)

**Files:**
- Create: `apps/agent/src/backends/iterm2/backend.ts`, `apps/agent/test/iterm2-backend.test.ts`
- Already created in Task 5: `apps/agent/src/backends/types.ts`

**Interfaces:**
- `ITerm2Backend implements TerminalBackend` with `constructor(client: ITerm2Client, log: Logger, opts?: { backoffMinMs?: number; backoffMaxMs?: number })`. Capabilities `{ subscribe: true, prompts: true, createSession: true, focus: true, history: true, absoluteLines: true }`.
- **Reconnect (spec 8.5.1 step 4).** When the iTerm2 socket closes, the backend clears its session state, emits `layout-changed`, and retries `client.connect()` with backoff **1 s → 2 s → 4 s → 8 s → 16 s → 30 s (cap)**, resetting the attempt counter on a successful connect. A fresh cookie is requested on every attempt (`ITerm2Client.connect()` already calls the cookie provider each time). `close()` cancels any pending retry. The `ws://localhost:1912` TCP fallback in spec 8.5.1 is **not** built in this plan (see the corrections block at the end).

`types.ts` was created in Task 5 (it defines `Screen`, which `convert.ts` returns) — do not re-create it here.

- [ ] **Step 1: Write the failing tests** (fake `ITerm2Client` via a scripted `request` and `emit`)

`apps/agent/test/iterm2-backend.test.ts`:
```ts
import { EventEmitter } from "node:events";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import type { ClientSub } from "../src/backends/iterm2/client.js";
import {
  CoordRangeSchema,
  CoordSchema,
  FocusChangedNotificationSchema,
  FocusResponseSchema,
  GetBufferResponseSchema,
  LineContentsSchema,
  ListSessionsResponse_TabSchema,
  ListSessionsResponse_WindowSchema,
  ListSessionsResponseSchema,
  NotificationResponseSchema,
  NotificationSchema,
  PromptNotificationCommandEndSchema,
  PromptNotificationSchema,
  ScreenUpdateNotificationSchema,
  SendTextResponseSchema,
  ServerOriginatedMessageSchema,
  SessionSummarySchema,
  SizeSchema,
  SplitTreeNode_SplitTreeLinkSchema,
  SplitTreeNodeSchema,
  VariableResponseSchema,
  WindowedCoordRangeSchema,
  type Notification,
  type ServerOriginatedMessage,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { createLogger } from "../src/log.js";

class FakeClient extends EventEmitter<{ notification: [Notification]; close: [] }> {
  connected = true;
  calls: ClientSub[] = [];
  async connect() {}
  close() {}
  async request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    this.calls.push(sub);
    const reply = (value: ServerOriginatedMessage["submessage"]) => create(ServerOriginatedMessageSchema, { id: 1n, submessage: value });
    switch (sub.case) {
      case "listSessionsRequest":
        return reply({ case: "listSessionsResponse", value: layout() });
      case "focusRequest":
        return reply({ case: "focusResponse", value: create(FocusResponseSchema, { notifications: [create(FocusChangedNotificationSchema, { event: { case: "session", value: "S2" } })] }) });
      case "notificationRequest":
        return reply({ case: "notificationResponse", value: create(NotificationResponseSchema, { status: 0 }) });
      case "variableRequest": {
        const name = sub.value.get[0];
        const sid = sub.value.scope.case === "sessionId" ? sub.value.scope.value : "";
        const v = name === "session.name" ? JSON.stringify(`title-${sid}`) : JSON.stringify(`/home/${sid}`);
        return reply({ case: "variableResponse", value: create(VariableResponseSchema, { status: 0, values: [v] }) });
      }
      case "getBufferRequest":
        return reply({
          case: "getBufferResponse",
          value: create(GetBufferResponseSchema, {
            contents: [create(LineContentsSchema, { text: "hello" })],
            cursor: create(CoordSchema, { x: 5, y: 101n }),
            windowedCoordRange: create(WindowedCoordRangeSchema, { coordRange: create(CoordRangeSchema, { start: create(CoordSchema, { x: 0, y: 100n }) }) }),
          }),
        });
      case "sendTextRequest":
        return reply({ case: "sendTextResponse", value: create(SendTextResponseSchema, { status: sub.value.session === "gone" ? 1 : 0 }) });
      default:
        throw new Error(`unexpected ${sub.case}`);
    }
  }
}

function layout() {
  const sess = (id: string, w: number, h: number) => create(SessionSummarySchema, { uniqueIdentifier: id, title: `t-${id}`, gridSize: create(SizeSchema, { width: w, height: h }) });
  const leaf = (s: ReturnType<typeof sess>) => create(SplitTreeNode_SplitTreeLinkSchema, { child: { case: "session", value: s } });
  return create(ListSessionsResponseSchema, {
    windows: [
      create(ListSessionsResponse_WindowSchema, {
        windowId: "w1",
        number: 1,
        tabs: [
          create(ListSessionsResponse_TabSchema, { tabId: "t1", root: create(SplitTreeNodeSchema, { links: [leaf(sess("S1", 80, 24)), leaf(sess("S2", 80, 24))] }) }),
          create(ListSessionsResponse_TabSchema, { tabId: "t2", tmuxWindowId: "@5", root: create(SplitTreeNodeSchema, { links: [leaf(sess("S3", 100, 30))] }) }),
        ],
      }),
    ],
  });
}

const log = createLogger({ stdout: false });

describe("ITerm2Backend", () => {
  it("lists sessions with titles, cwd, layout positions and focus; exposes tmux window ids", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const list = await b.listSessions();
    expect(list.map((s) => [s.id, s.title, s.cwd, s.tabIndex, s.paneIndex, s.isFocusedOnMac])).toEqual([
      ["S1", "title-S1", "/home/S1", 0, 0, false],
      ["S2", "title-S2", "/home/S2", 0, 1, true],
      ["S3", "title-S3", "/home/S3", 1, 0, false],
    ]);
    expect(list[2]?.cols).toBe(100);
    expect(b.tmuxWindowIds?.()).toEqual(new Set(["@5"]));
    const notifs = client.calls.filter((c) => c.case === "notificationRequest");
    expect(notifs.length).toBeGreaterThanOrEqual(4 + 3 * 4); // 4 global + per session: screen, prompt, 2 variables
  });

  it("getScreen converts with absolute scrollback and screen-relative cursor", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const s = await b.getScreen("S1");
    expect(s.rows).toBe(24);
    expect(s.lines[0]).toEqual({ r: [{ t: "hello" }] });
    expect(s.scrollbackTotal).toBe(100);
    expect(s.cursor).toEqual({ x: 5, y: 1 });
  });

  it("maps notifications to backend events", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type + ("sessionId" in e ? `:${e.sessionId}` : "")));
    client.emit("notification", create(NotificationSchema, { screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }) }));
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, { session: "S1", event: { case: "commandEnd", value: create(PromptNotificationCommandEndSchema, { status: 0 }) } }),
      }),
    );
    expect(events).toEqual(["screen-changed:S1", "command-end:S1"]);
  });

  it("reconnects with backoff after the iTerm2 socket closes, and stops after close()", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    let connects = 0;
    client.connect = async () => {
      connects++;
      client.connected = true;
    };
    const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 40 });
    await b.connect();
    expect(connects).toBe(1);
    client.connected = false;
    client.emit("close");
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(2); // first retry at 10 ms
    client.connected = false;
    client.emit("close");
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(2); // second retry is at 20 ms, not yet due
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(3);
    await b.close();
    client.emit("close");
    await vi.advanceTimersByTimeAsync(200);
    expect(connects).toBe(3); // close() cancels the retry loop
    vi.useRealTimers();
  });

  it("sendText maps SESSION_NOT_FOUND to SessionGone", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    await b.sendText("S1", "ls\r");
    await expect(b.sendText("gone", "x")).rejects.toThrow(/session gone/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `backend.ts`**

`apps/agent/src/backends/iterm2/backend.ts`:
```ts
import { create } from "@bufbuild/protobuf";
import type { Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import { BackendUnavailable, SessionGone, type BackendEvent, type Screen, type TerminalBackend } from "../types.js";
import type { ITerm2Client } from "./client.js";
import { bufferToScreen, lineContentsToLine } from "./convert.js";
import {
  ActivateRequest_AppSchema,
  ActivateRequestSchema,
  CoordRangeSchema,
  CoordSchema,
  CreateTabRequestSchema,
  FocusRequestSchema,
  GetBufferRequestSchema,
  LineRangeSchema,
  ListSessionsRequestSchema,
  NotificationRequestSchema,
  NotificationType,
  PromptMonitorMode,
  PromptMonitorRequestSchema,
  SendTextRequestSchema,
  SplitPaneRequest_SplitDirection,
  SplitPaneRequestSchema,
  VariableMonitorRequestSchema,
  VariableRequestSchema,
  VariableScope,
  WindowedCoordRangeSchema,
  type ListSessionsResponse,
  type Notification,
  type SplitTreeNode,
} from "./gen/iterm2_pb.js";

interface Native {
  id: string;
  title: string;
  cwd?: string;
  cols: number;
  rows: number;
  windowId: string;
  windowNumber: number;
  tabId: string;
  tabIndex: number;
  paneIndex: number;
  tmuxWindowId?: string;
}

export class ITerm2Backend implements TerminalBackend {
  readonly name = "iterm2" as const;
  readonly capabilities: Capabilities = { subscribe: true, prompts: true, createSession: true, focus: true, history: true, absoluteLines: true };
  private sessions = new Map<string, Native>();
  private order: string[] = [];
  private focused: string | null = null;
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly subscribed = new Set<string>();
  private readonly log: Logger;

  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly client: ITerm2Client,
    log: Logger,
    private readonly backoff: { minMs?: number; maxMs?: number } = {},
  ) {
    this.log = log.child({ backend: "iterm2" });
    this.client.on("notification", (n) => this.onNotification(n));
    this.client.on("close", () => {
      this.sessions.clear();
      this.order = [];
      this.subscribed.clear();
      this.emit({ type: "layout-changed" });
      this.scheduleReconnect();
    });
  }

  /** Spec 8.5.1 step 4: 1 s -> 2 s -> 4 s -> 8 s -> 16 s -> 30 s cap, fresh cookie each attempt. */
  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const min = this.backoff.minMs ?? 1000;
    const max = this.backoff.maxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.log.info("iTerm2 gone; retrying", { delayMs: delay, attempt: this.attempt });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err) => {
        this.log.warn("iTerm2 reconnect failed", { err: String(err) });
        this.scheduleReconnect();
      });
    }, delay);
  }

  async connect(): Promise<void> {
    this.closed = false;
    if (!this.client.connected) {
      try {
        await this.client.connect();
      } catch (err) {
        throw new BackendUnavailable(String(err), "iTerm2 → Settings → General → Magic → ✓ Enable Python API, then run `shellbell` again.");
      }
    }
    this.attempt = 0;
    for (const t of [NotificationType.NOTIFY_ON_LAYOUT_CHANGE, NotificationType.NOTIFY_ON_NEW_SESSION, NotificationType.NOTIFY_ON_TERMINATE_SESSION, NotificationType.NOTIFY_ON_FOCUS_CHANGE]) {
      await this.client.request({ case: "notificationRequest", value: create(NotificationRequestSchema, { subscribe: true, notificationType: t }) });
    }
    const ls = await this.client.request({ case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) });
    if (ls.submessage.case === "listSessionsResponse") await this.applyLayout(ls.submessage.value);
    const focus = await this.client.request({ case: "focusRequest", value: create(FocusRequestSchema, {}) });
    if (focus.submessage.case === "focusResponse") {
      for (const n of focus.submessage.value.notifications) if (n.event.case === "session") this.focused = n.event.value;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client.close();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.order.map((id) => this.toInfo(this.sessions.get(id) as Native));
  }

  tmuxWindowIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values()) if (s.tmuxWindowId) out.add(s.tmuxWindowId);
    return out;
  }

  async getScreen(sessionId: string): Promise<Screen> {
    const native = this.sessions.get(sessionId);
    if (!native) throw new SessionGone(sessionId);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, { session: sessionId, lineRange: create(LineRangeSchema, { screenContentsOnly: true }), includeStyles: true }),
    });
    if (res.submessage.case !== "getBufferResponse" || res.submessage.value.status !== 0) throw new SessionGone(sessionId);
    return bufferToScreen(res.submessage.value, native.rows, native.cols);
  }

  async getHistory(sessionId: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }> {
    if (!this.sessions.has(sessionId)) throw new SessionGone(sessionId);
    const start = Math.max(0, before - count);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: sessionId,
        lineRange: create(LineRangeSchema, {
          windowedCoordRange: create(WindowedCoordRangeSchema, {
            coordRange: create(CoordRangeSchema, { start: create(CoordSchema, { x: 0, y: BigInt(start) }), end: create(CoordSchema, { x: 0, y: BigInt(before) }) }),
          }),
        }),
        includeStyles: true,
      }),
    });
    if (res.submessage.case !== "getBufferResponse") throw new SessionGone(sessionId);
    const lines = res.submessage.value.contents.map(lineContentsToLine);
    const oldestAvailable = lines.length < before - start ? before - lines.length : 0;
    return { lines, oldestAvailable };
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const res = await this.client.request({ case: "sendTextRequest", value: create(SendTextRequestSchema, { session: sessionId, text, suppressBroadcast: true }) });
    if (res.submessage.case !== "sendTextResponse" || res.submessage.value.status !== 0) throw new SessionGone(sessionId);
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "tab") {
      const res = await this.client.request({ case: "createTabRequest", value: create(CreateTabRequestSchema, { windowId: where.windowId, selectTab: false }) });
      if (res.submessage.case !== "createTabResponse" || !res.submessage.value.sessionId) throw new Error("create tab failed");
      return res.submessage.value.sessionId;
    }
    const res = await this.client.request({
      case: "splitPaneRequest",
      value: create(SplitPaneRequestSchema, {
        session: where.sessionId,
        splitDirection: where.direction === "vertical" ? SplitPaneRequest_SplitDirection.VERTICAL : SplitPaneRequest_SplitDirection.HORIZONTAL,
      }),
    });
    const id = res.submessage.case === "splitPaneResponse" ? res.submessage.value.sessionId[0] : undefined;
    if (!id) throw new Error("split failed");
    return id;
  }

  async focus(sessionId: string): Promise<void> {
    await this.client.request({
      case: "activateRequest",
      value: create(ActivateRequestSchema, {
        identifier: { case: "sessionId", value: sessionId },
        orderWindowFront: true,
        selectTab: true,
        selectSession: true,
        activateApp: create(ActivateRequest_AppSchema, { raiseAllWindows: false, ignoringOtherApps: false }),
      }),
    });
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- internals ----

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }

  private toInfo(n: Native): SessionInfo {
    return {
      id: n.id,
      backend: "iterm2",
      title: n.title,
      cwd: n.cwd,
      cols: n.cols,
      rows: n.rows,
      windowId: n.windowId,
      windowNumber: n.windowNumber,
      tabId: n.tabId,
      tabIndex: n.tabIndex,
      paneIndex: n.paneIndex,
      isFocusedOnMac: this.focused === n.id,
      state: "unknown",
    };
  }

  private async applyLayout(layout: ListSessionsResponse): Promise<void> {
    const next = new Map<string, Native>();
    const order: string[] = [];
    const windows = [...layout.windows].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const w of windows) {
      w.tabs.forEach((tab, tabIndex) => {
        let paneIndex = 0;
        const walk = (node: SplitTreeNode | undefined) => {
          if (!node) return;
          for (const link of node.links) {
            if (link.child.case === "session") {
              const s = link.child.value;
              const id = s.uniqueIdentifier ?? "";
              const prev = this.sessions.get(id);
              next.set(id, {
                id,
                title: prev?.title ?? s.title ?? "Session",
                cwd: prev?.cwd,
                cols: s.gridSize?.width ?? 80,
                rows: s.gridSize?.height ?? 24,
                windowId: w.windowId ?? "",
                windowNumber: w.number ?? 0,
                tabId: tab.tabId ?? "",
                tabIndex,
                paneIndex: paneIndex++,
                tmuxWindowId: tab.tmuxWindowId || undefined,
              });
              order.push(id);
            } else if (link.child.case === "node") walk(link.child.value);
          }
        };
        walk(tab.root);
      });
    }
    for (const id of this.sessions.keys()) if (!next.has(id)) this.subscribed.delete(id);
    this.sessions = next;
    this.order = order;
    await Promise.all(order.map((id) => this.ensureSession(id)));
    this.emit({ type: "layout-changed" });
  }

  private async ensureSession(id: string): Promise<void> {
    const n = this.sessions.get(id);
    if (!n) return;
    if (!this.subscribed.has(id)) {
      this.subscribed.add(id);
      const subs = [
        create(NotificationRequestSchema, { session: id, subscribe: true, notificationType: NotificationType.NOTIFY_ON_SCREEN_UPDATE }),
        create(NotificationRequestSchema, {
          session: id,
          subscribe: true,
          notificationType: NotificationType.NOTIFY_ON_PROMPT,
          arguments: { case: "promptMonitorRequest", value: create(PromptMonitorRequestSchema, { modes: [PromptMonitorMode.PROMPT, PromptMonitorMode.COMMAND_START, PromptMonitorMode.COMMAND_END] }) },
        }),
        ...["session.name", "session.path"].map((name) =>
          create(NotificationRequestSchema, {
            session: id,
            subscribe: true,
            notificationType: NotificationType.NOTIFY_ON_VARIABLE_CHANGE,
            arguments: { case: "variableMonitorRequest", value: create(VariableMonitorRequestSchema, { name, scope: VariableScope.SESSION, identifier: id }) },
          }),
        ),
      ];
      for (const s of subs) {
        try {
          await this.client.request({ case: "notificationRequest", value: s });
        } catch (err) {
          this.log.warn("subscribe failed", { session: id.slice(0, 8), err: String(err) });
        }
      }
    }
    const [name, path] = await Promise.all([this.variable(id, "session.name"), this.variable(id, "session.path")]);
    if (name) n.title = name;
    if (path) n.cwd = path;
  }

  private async variable(id: string, name: string): Promise<string | undefined> {
    try {
      const res = await this.client.request({ case: "variableRequest", value: create(VariableRequestSchema, { scope: { case: "sessionId", value: id }, get: [name] }) });
      if (res.submessage.case !== "variableResponse" || res.submessage.value.status !== 0) return undefined;
      const raw = res.submessage.value.values[0];
      if (!raw || raw === "null") return undefined;
      const v = JSON.parse(raw);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private onNotification(n: Notification): void {
    const now = Date.now();
    if (n.screenUpdateNotification?.session) {
      this.emit({ type: "screen-changed", sessionId: n.screenUpdateNotification.session });
      return;
    }
    if (n.promptNotification?.session) {
      const p = n.promptNotification;
      const sid = p.session as string;
      if (p.event.case === "commandStart") this.emit({ type: "command-start", sessionId: sid, command: p.event.value.command ?? "", at: now });
      else if (p.event.case === "commandEnd") this.emit({ type: "command-end", sessionId: sid, exitCode: p.event.value.status ?? 0, at: now });
      else if (p.event.case === "prompt") this.emit({ type: "prompt", sessionId: sid, at: now });
      return;
    }
    if (n.layoutChangedNotification?.listSessionsResponse) {
      void this.applyLayout(n.layoutChangedNotification.listSessionsResponse);
      return;
    }
    if (n.newSessionNotification?.sessionId) {
      void this.client.request({ case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) }).then((ls) => {
        if (ls.submessage.case === "listSessionsResponse") return this.applyLayout(ls.submessage.value);
      });
      this.emit({ type: "session-added", sessionId: n.newSessionNotification.sessionId });
      return;
    }
    if (n.terminateSessionNotification?.sessionId) {
      const id = n.terminateSessionNotification.sessionId;
      this.sessions.delete(id);
      this.subscribed.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.emit({ type: "session-removed", sessionId: id });
      this.emit({ type: "layout-changed" });
      return;
    }
    if (n.focusChangedNotification) {
      if (n.focusChangedNotification.event.case === "session") this.focused = n.focusChangedNotification.event.value;
      this.emit({ type: "focus-changed" });
      return;
    }
    if (n.variableChangedNotification?.identifier) {
      const v = n.variableChangedNotification;
      const s = this.sessions.get(v.identifier as string);
      if (!s) return;
      try {
        const val = JSON.parse(v.jsonNewValue ?? "null");
        if (v.name === "session.name" && typeof val === "string") s.title = val;
        if (v.name === "session.path" && typeof val === "string") s.cwd = val;
      } catch {
        return;
      }
      this.emit({ type: "title-changed", sessionId: s.id });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): iTerm2 backend with reconnect"
```

---

### Task 7: `ScreenTracker` — viewed sessions, scroll-aligned diffs, per-viewer generations (spec 8.6)

**Files:**
- Create: `apps/agent/src/screen-tracker.ts`, `apps/agent/test/fakes/fake-backend.ts`, `apps/agent/test/screen-tracker.test.ts`

**Interfaces:**
- `ScreenTrackerOptions { backend: TerminalBackend; sink: (connId: string, msg: InnerMessage) => void; log; intervalMs?: 125; maxFramesPerSecond?: 40; maxEncodedBytes?: 262144; now?: () => number }`
- `class ScreenTracker`: `start()`, `stop()`, `setViewed(connId: string, sessionId: string | null)`, `dropViewer(connId)`, `markDirty(sessionId)`, `forceSnapshot(connId, sessionId)`, `sessionRemoved(sessionId)`, `setIntervalMs(ms)`; getter `viewedBy(sessionId): string[]`.
- **The tracker owns its own dirty tracking.** `start()` calls `backend.on(...)` and keeps the unsubscribe function; it marks a session dirty on `BackendEvent` kind **`screen-changed`** (the only kind that means "output happened") and drops session state on **`session-removed`**. Every other kind is ignored here — layout/title/focus changes are the `Agent`'s business. `stop()` unsubscribes. `markDirty()` and `sessionRemoved()` stay public and idempotent so tests (and the `Agent`) can drive them directly.
- **Frame budget is global, not per viewer (Plan 02 parked item).** `maxFramesPerSecond` (default **40**) is a single token bucket over **every** `sink` call, because all of them leave through the agent's one relay socket, which the relay rate-limits at 60 msg/s per connection and closes with `4429` when exceeded. A per-viewer cap does not bound the total: 8 viewers × 8 fps = 64 msg/s → disconnect. When the budget is exhausted in a tick, the remaining viewers are **coalesced** — skipped this tick, `skipped++`. A skipped viewer's `lastSentGen` goes stale, so the existing lagging-viewer rule already gives it a fresh `screen.snapshot` on the next tick it is served; no state is lost.
- **`degraded` on a starved viewer.** A viewer coalesced **3 or more consecutive ticks** is served its catch-up `screen.snapshot` with styles stripped (`stripStyles`) and `degraded: true` — the same flag and the same cheap payload already used for the 256 KB cap. This is deliberately the *snapshot* path: `screen.diff` has **no** `degraded` field in `packages/protocol/src/inner.ts`, and this plan does not change the protocol package.
- `test/fakes/fake-backend.ts`: `class FakeBackend implements TerminalBackend` with in-memory sessions: `addSession(id, { cols, rows, lines: string[], scrollbackTotal?: number, absoluteLines? })`, `setLines(id, lines: string[])`, `appendLine(id, text)` (scrolls: drops top row, bumps `scrollbackTotal` unless `saturated`), `saturated = false`, `sentText: { id; text }[]`, `emit(e)`, `getScreenCalls`.

- [ ] **Step 1: Write the fake backend**

`apps/agent/test/fakes/fake-backend.ts`:
```ts
import type { BackendName, Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import { Unsupported, type BackendEvent, type Screen, type TerminalBackend } from "../../src/backends/types.js";

interface S {
  cols: number;
  rows: number;
  lines: string[];
  scrollbackTotal: number;
  history: string[];
}

export class FakeBackend implements TerminalBackend {
  capabilities: Capabilities = { subscribe: true, prompts: true, createSession: true, focus: true, history: true, absoluteLines: true };
  saturated = false;
  sentText: { id: string; text: string }[] = [];
  getScreenCalls = 0;
  /**
   * Declared as optional properties (not methods) so tests can assign them. `TerminalBackend`
   * declares them as optional methods, which a property of function type satisfies.
   */
  tmuxWindowIds?: () => Set<string>;
  tmuxWindowIdOf?: (nativeId: string) => string | undefined;
  private sessions = new Map<string, S>();
  private handlers = new Set<(e: BackendEvent) => void>();

  /** Pass "tmux" to stand in for the tmux backend in registry tests. */
  constructor(readonly name: BackendName = "iterm2") {}

  addSession(id: string, o: { cols?: number; rows?: number; lines?: string[]; scrollbackTotal?: number }): void {
    const rows = o.rows ?? 3;
    const lines = (o.lines ?? []).slice(0, rows);
    while (lines.length < rows) lines.push("");
    this.sessions.set(id, { cols: o.cols ?? 20, rows, lines, scrollbackTotal: o.scrollbackTotal ?? 0, history: [] });
  }
  setLines(id: string, lines: string[]): void {
    const s = this.sessions.get(id) as S;
    s.lines = lines.slice(0, s.rows);
    while (s.lines.length < s.rows) s.lines.push("");
    this.emit({ type: "screen-changed", sessionId: id });
  }
  appendLine(id: string, text: string): void {
    const s = this.sessions.get(id) as S;
    s.history.push(s.lines.shift() as string);
    s.lines.push(text);
    if (!this.saturated) s.scrollbackTotal += 1;
    this.emit({ type: "screen-changed", sessionId: id });
  }
  clear(id: string): void {
    const s = this.sessions.get(id) as S;
    s.lines = s.lines.map(() => "");
    s.scrollbackTotal = 0;
    s.history = [];
    this.emit({ type: "screen-changed", sessionId: id });
  }
  emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.entries()].map(([id, s], i) => ({
      id, backend: this.name, title: id, cols: s.cols, rows: s.rows, windowId: "w", windowNumber: 1, tabId: `t${i}`, tabIndex: i, paneIndex: 0, isFocusedOnMac: i === 0, state: "unknown",
    }));
  }
  async getScreen(id: string): Promise<Screen> {
    this.getScreenCalls++;
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session gone: ${id}`);
    return { cols: s.cols, rows: s.rows, cursor: { x: 0, y: s.rows - 1 }, lines: s.lines.map((t): Line => (t ? { r: [{ t }] } : { r: [] })), scrollbackTotal: s.scrollbackTotal };
  }
  async getHistory(id: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const s = this.sessions.get(id) as S;
    const all = s.history.map((t): Line => ({ r: [{ t }] }));
    const end = Math.min(before, all.length);
    const start = Math.max(0, end - count);
    return { lines: all.slice(start, end), oldestAvailable: 0 };
  }
  async sendText(id: string, text: string): Promise<void> {
    if (!this.sessions.has(id)) throw new Error(`session gone: ${id}`);
    this.sentText.push({ id, text });
  }
  async createSession(where: CreateWhere): Promise<string> {
    const id = `new${this.sessions.size}`;
    this.addSession(id, {});
    void where;
    return id;
  }
  async focus(_id: string): Promise<void> {
    if (!this.capabilities.focus) throw new Unsupported("focus");
  }
  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
```

- [ ] **Step 2: Write the failing tests**

`apps/agent/test/screen-tracker.test.ts`:
```ts
import type { InnerMessage } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
const text = (m: InnerMessage) => (m.type === "screen.snapshot" ? m.lines : m.type === "screen.diff" ? m.changed.map((c) => c.line) : []).map((l) => l.r[0]?.t ?? "");

let backend: FakeBackend;
let sent: { conn: string; msg: InnerMessage }[];
let tracker: ScreenTracker;

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  backend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
  sent = [];
  tracker = new ScreenTracker({ backend, sink: (conn, msg) => sent.push({ conn, msg }), log, now: () => Date.now() });
  tracker.start();
});
afterEach(() => {
  tracker.stop();
  vi.useRealTimers();
});

const flush = async () => {
  await vi.advanceTimersByTimeAsync(130);
};

describe("ScreenTracker", () => {
  it("snapshot on view; diff with scroll when tailing; nothing when no viewers", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent[0]?.msg.type).toBe("screen.snapshot");
    expect(text(sent[0]?.msg as InnerMessage)).toEqual(["a", "b", "c"]);
    backend.appendLine("S", "d");
    tracker.markDirty("S"); // idempotent: the tracker also hears screen-changed itself
    await flush();
    const diff = sent[1]?.msg;
    expect(diff?.type).toBe("screen.diff");
    if (diff?.type !== "screen.diff") throw new Error();
    expect(diff.scroll).toBe(1);
    expect(diff.changed).toEqual([{ i: 2, line: { r: [{ t: "d" }] } }]);
    expect(diff.scrollbackTotal).toBe(11);
    expect(diff.gen).toBe(2);
    tracker.setViewed("p1", null);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    expect(sent.length).toBe(2);
  });

  it("saturated history: detects scroll by overlap and keeps a monotonic scrollbackTotal", async () => {
    backend.saturated = true;
    backend.capabilities = { ...backend.capabilities, absoluteLines: false };
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    const diff = sent[1]?.msg;
    if (diff?.type !== "screen.diff") throw new Error(`expected diff, got ${diff?.type}`);
    expect(diff.scroll).toBe(1);
    expect(diff.scrollbackTotal).toBe(11);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    expect((sent[2]?.msg as { scrollbackTotal: number }).scrollbackTotal).toBe(12);
  });

  it("clear → snapshot with reset; >60% change → snapshot", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.clear("S");
    tracker.markDirty("S");
    await flush();
    const snap = sent[1]?.msg;
    expect(snap?.type).toBe("screen.snapshot");
    expect((snap as { reset?: boolean }).reset).toBe(true);
    backend.setLines("S", ["x", "y", "z"]);
    tracker.markDirty("S");
    await flush();
    expect(sent[2]?.msg.type).toBe("screen.snapshot");
    expect((sent[2]?.msg as { reset?: boolean }).reset).toBeUndefined();
  });

  it("a lagging viewer gets a snapshot; an up-to-date viewer gets the diff", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    tracker.setViewed("p2", "S"); // joins at gen 2 → snapshot
    await flush();
    expect(sent.filter((s) => s.conn === "p2").map((s) => s.msg.type)).toEqual(["screen.snapshot"]);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    const last = sent.slice(-2).map((s) => [s.conn, s.msg.type].join(":")).sort();
    expect(last).toEqual(["p1:screen.diff", "p2:screen.diff"]);
  });

  it("forceSnapshot sends a fresh snapshot to one viewer", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.forceSnapshot("p1", "S");
    await flush();
    expect(sent.map((s) => s.msg.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
  });

  it("does not poll unviewed sessions and coalesces bursts into one getScreen per tick", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    const before = backend.getScreenCalls;
    for (let i = 0; i < 10; i++) backend.appendLine("S", `l${i}`);
    tracker.markDirty("S");
    await flush();
    expect(backend.getScreenCalls - before).toBe(1);
  });

  it("session removal drops viewers silently", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.sessionRemoved("S");
    expect(tracker.viewedBy("S")).toEqual([]);
  });

  it("marks dirty from the backend's own screen-changed event, with no explicit markDirty", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent).toHaveLength(1);
    backend.appendLine("S", "d"); // emits screen-changed; the tracker subscribed in start()
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.msg.type).toBe("screen.diff");
  });

  it("caps TOTAL sink calls per second across all viewers and coalesces the rest", async () => {
    // Plan 02 parked item: every frame leaves through the agent's single relay socket, which the
    // relay caps at 60 msg/s (close 4429). 10 viewers at 8 fps is 80 msg/s without a GLOBAL bucket;
    // a per-viewer cap of 40 would not stop it. 7 flushes of 130 ms stay inside one 1 s window.
    for (let i = 0; i < 10; i++) tracker.setViewed(`v${i}`, "S");
    for (let t = 0; t < 7; t++) {
      backend.appendLine("S", `line${t}`);
      tracker.markDirty("S");
      await flush();
    }
    expect(sent.length).toBeGreaterThanOrEqual(10); // at least one tick was served in full
    expect(sent.length).toBeLessThanOrEqual(40); // 70 attempts, 40 tokens
  });

  it("sends a degraded, style-stripped snapshot to a viewer coalesced 3+ consecutive ticks", async () => {
    // maxFramesPerSecond 1 means exactly one frame per 1 s window; "hog" is first in the viewer map
    // and takes it every time, so "starved" accumulates coalesced ticks.
    tracker.stop();
    sent = [];
    tracker = new ScreenTracker({ backend, sink: (conn, msg) => sent.push({ conn, msg }), log, maxFramesPerSecond: 1, now: () => Date.now() });
    tracker.start();
    tracker.setViewed("hog", "S");
    tracker.setViewed("starved", "S");
    // Each pass advances past the 1 s bucket window, so exactly one token is issued per pass.
    const pass = async () => {
      backend.appendLine("S", "out");
      tracker.markDirty("S");
      await vi.advanceTimersByTimeAsync(1100);
    };
    await pass();
    await pass();
    await pass();
    expect(sent.every((x) => x.conn === "hog")).toBe(true); // starved got nothing: 3 coalesced ticks
    tracker.dropViewer("hog");
    await pass(); // now "starved" wins the token
    const starved = sent.filter((x) => x.conn === "starved");
    expect(starved).toHaveLength(1);
    const frame = starved[0]?.msg;
    if (frame?.type !== "screen.snapshot") throw new Error(`expected snapshot, got ${frame?.type}`);
    expect(frame.degraded).toBe(true);
    // stripStyles collapses every row to at most one unstyled run
    for (const line of frame.lines) {
      expect(line.r.length).toBeLessThanOrEqual(1);
      expect(line.r[0]?.fg).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 4: Implement `screen-tracker.ts`**

`apps/agent/src/screen-tracker.ts`:
```ts
import { encodeCbor, lineKey, stripStyles, type InnerMessage, type Line } from "@shellbell/protocol";
import type { Screen, TerminalBackend } from "./backends/types.js";
import type { Logger } from "./log.js";

export interface ScreenTrackerOptions {
  backend: TerminalBackend;
  sink: (connId: string, msg: InnerMessage) => void;
  log: Logger;
  intervalMs?: number;
  maxFramesPerSecond?: number;
  maxEncodedBytes?: number;
  now?: () => number;
}

interface SessionState {
  viewers: Map<string, { lastSentGen: number; forceSnapshot: boolean; skipped: number }>;
  dirty: boolean;
  inflight: boolean;
  lastKeys: string[];
  lastCols: number;
  lastRows: number;
  lastBackendScrollback: number | null;
  reported: number;
  gen: number;
}

interface Budget {
  windowStart: number;
  count: number;
}

const SNAPSHOT_RATIO = 0.6;
const OVERLAP_MAX_SHIFT = 16;
const OVERLAP_MIN_MATCH = 0.8;
/** Consecutive coalesced ticks after which a viewer's catch-up frame is sent degraded. */
const COALESCE_DEGRADE_TICKS = 3;

export class ScreenTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly viewerSession = new Map<string, string>();
  /** ONE bucket for every sink call: they all share the agent's single relay socket. */
  private budget: Budget = { windowStart: 0, count: 0 };
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: ScreenTrackerOptions) {
    this.intervalMs = Math.max(125, opts.intervalMs ?? 125);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "tracker" });
  }

  start(): void {
    if (this.timer) return;
    // The tracker subscribes to the backend itself: `screen-changed` is the only event that means
    // "there is new output", and `session-removed` is the only one that invalidates our state.
    this.unsubscribe ??= this.opts.backend.on((e) => {
      if (e.type === "screen-changed") this.markDirty(e.sessionId);
      else if (e.type === "session-removed") this.sessionRemoved(e.sessionId);
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  setIntervalMs(ms: number): void {
    const next = Math.max(125, ms);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  setViewed(connId: string, sessionId: string | null): void {
    const prev = this.viewerSession.get(connId);
    if (prev) {
      this.sessions.get(prev)?.viewers.delete(connId);
      this.viewerSession.delete(connId);
    }
    if (!sessionId) return;
    const s = this.state(sessionId);
    s.viewers.set(connId, { lastSentGen: -1, forceSnapshot: true, skipped: 0 });
    s.dirty = true;
    this.viewerSession.set(connId, sessionId);
  }

  dropViewer(connId: string): void {
    this.setViewed(connId, null);
  }

  viewedBy(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.viewers.keys() ?? [])];
  }

  markDirty(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.viewers.size > 0) s.dirty = true;
  }

  forceSnapshot(connId: string, sessionId: string): void {
    const v = this.sessions.get(sessionId)?.viewers.get(connId);
    if (!v) return;
    v.forceSnapshot = true;
    (this.sessions.get(sessionId) as SessionState).dirty = true;
  }

  sessionRemoved(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const conn of s.viewers.keys()) this.viewerSession.delete(conn);
    this.sessions.delete(sessionId);
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { viewers: new Map(), dirty: false, inflight: false, lastKeys: [], lastCols: 0, lastRows: 0, lastBackendScrollback: null, reported: 0, gen: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private async tick(): Promise<void> {
    for (const [sessionId, s] of this.sessions) {
      if (!s.dirty || s.inflight || s.viewers.size === 0) continue;
      s.inflight = true;
      s.dirty = false;
      try {
        const screen = await this.opts.backend.getScreen(sessionId);
        this.processScreen(sessionId, s, screen);
      } catch (err) {
        this.log.warn("getScreen failed; dropping session", { session: sessionId.slice(0, 12), err: String(err) });
        this.sessionRemoved(sessionId);
        continue;
      } finally {
        s.inflight = false;
      }
    }
  }

  private processScreen(sessionId: string, s: SessionState, screen: Screen): void {
    const keys = screen.lines.map(lineKey);
    const rows = screen.rows;
    let delta = 0;
    let reset = false;
    let forceSnapshotAll = s.lastKeys.length === 0 || s.lastCols !== screen.cols || s.lastRows !== screen.rows;

    if (s.lastBackendScrollback === null) {
      s.reported = screen.scrollbackTotal;
    } else {
      const backendDelta = screen.scrollbackTotal - s.lastBackendScrollback;
      if (backendDelta < 0) {
        reset = true;
        forceSnapshotAll = true;
        s.reported = screen.scrollbackTotal;
      } else if (backendDelta >= rows) {
        forceSnapshotAll = true;
        s.reported += backendDelta;
      } else if (backendDelta > 0) {
        delta = backendDelta;
        s.reported += backendDelta;
      } else if (!this.opts.backend.capabilities.absoluteLines && !forceSnapshotAll) {
        const changedRowForRow = countChanged(keys, s.lastKeys, 0);
        if (changedRowForRow > SNAPSHOT_RATIO * rows) {
          const k = detectOverlap(keys, s.lastKeys, rows);
          if (k > 0) {
            delta = k;
            s.reported += k;
          }
        }
      }
    }
    s.lastBackendScrollback = screen.scrollbackTotal;

    const changed: { i: number; line: Line }[] = [];
    if (!forceSnapshotAll) {
      for (let i = 0; i < rows; i++) {
        const old = i + delta < s.lastKeys.length ? s.lastKeys[i + delta] : undefined;
        if (old === undefined || old !== keys[i]) changed.push({ i, line: screen.lines[i] as Line });
      }
      if (changed.length > SNAPSHOT_RATIO * rows) forceSnapshotAll = true;
    }

    s.gen += 1;
    s.lastKeys = keys;
    s.lastCols = screen.cols;
    s.lastRows = screen.rows;

    const base = { sessionId, cursor: screen.cursor, scrollbackTotal: s.reported, gen: s.gen };
    /** `degrade` is forced for a starved viewer; otherwise it is decided by the 256 KB cap. */
    const snapshot = (degrade: boolean): InnerMessage => {
      const full: InnerMessage = { type: "screen.snapshot", ...base, cols: screen.cols, rows: screen.rows, lines: screen.lines, reset: reset || undefined };
      if (degrade || encodeCbor(full).byteLength > (this.opts.maxEncodedBytes ?? 262_144)) {
        return { ...full, lines: screen.lines.map(stripStyles), degraded: true };
      }
      return full;
    };
    const diff: InnerMessage = { type: "screen.diff", ...base, scroll: delta, changed };

    for (const [conn, v] of s.viewers) {
      if (!this.spend()) {
        // Global budget exhausted this tick: coalesce. `lastSentGen` stays stale, so this viewer
        // is served a snapshot on the next tick it wins the budget.
        v.skipped += 1;
        continue;
      }
      const starved = v.skipped >= COALESCE_DEGRADE_TICKS;
      const upToDate = v.lastSentGen === s.gen - 1 && !v.forceSnapshot && !forceSnapshotAll && !starved;
      this.opts.sink(conn, upToDate ? diff : snapshot(starved));
      v.lastSentGen = s.gen;
      v.forceSnapshot = false;
      v.skipped = 0;
    }
  }

  /**
   * One token bucket across every viewer of every session: all frames leave through the agent's
   * single relay socket, which the relay caps at 60 msg/s per connection (close 4429).
   */
  private spend(): boolean {
    const max = this.opts.maxFramesPerSecond ?? 40;
    const now = this.now();
    if (now - this.budget.windowStart >= 1000) {
      this.budget = { windowStart: now, count: 1 };
      return true;
    }
    if (this.budget.count >= max) return false;
    this.budget.count += 1;
    return true;
  }
}

function countChanged(keys: string[], last: string[], shift: number): number {
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (last[i + shift] !== keys[i]) n++;
  return n;
}

/** Returns k>0 if new row i equals old row i+k for ≥80% of comparable rows; the smallest such k wins. */
function detectOverlap(keys: string[], last: string[], rows: number): number {
  for (let k = 1; k <= Math.min(rows - 1, OVERLAP_MAX_SHIFT); k++) {
    const comparable = rows - k;
    if (comparable <= 0) break;
    let match = 0;
    for (let i = 0; i < comparable; i++) if (keys[i] === last[i + k]) match++;
    if (match >= OVERLAP_MIN_MATCH * comparable) return k;
  }
  return 0;
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. The "saturated" test relies on `detectOverlap`: after `appendLine`, rows `["b","c","d"]` vs last `["a","b","c"]` → k=1 matches 2 of 2 comparable rows.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): screen tracker with scroll-aligned diffs, overlap detection, per-viewer generations"
```

---

### Task 8: `EventEngine` and `Notifier` (spec 8.8)

**Files:**
- Create: `apps/agent/src/events.ts`, `apps/agent/src/notifier.ts`, `apps/agent/test/events.test.ts`

**Interfaces:**
- `EventEngineOptions { notifyMinCommandMs; idleQuietMs; idleMinActiveMs; now?: () => number }`
- `class EventEngine extends EventEmitter<{ event: [InnerMessageOf<"event">]; ring: [{ sessionId; kind: "prompt" | "idle"; exitCode?; durationMs? }] }>`: `onBackendEvent(e: BackendEvent)`, `tick()` (call every 1 s), `stateOf(sessionId): SessionInfo["state"]`, `forget(sessionId)`.
- `class Notifier { constructor(send: (m: CtrlMessage) => void, log, now?) ; ring(r: Ring): boolean }` — per-session 60 s limit.
- **Idle ring rule (spec 8.8), exactly.** The 1 s sweep emits the `idle` **event** whenever the quiet/active thresholds are met. It emits the `idle` **ring** only when *both* hold: (a) the session did not ring for `prompt` recently, and (b) `promptState !== "editing"` (the shell is sitting at a prompt; nothing is waiting on the user). "Recently" is `PROMPT_DEDUPE_MS (5 s) + idleQuietMs` rather than a bare 5 s, because the sweep can only fire at least `idleQuietMs` after the last screen change — widening the window by exactly that amount is what implements the spec's "a `prompt` event fired for this session in the last 5 s".
- **Ordering matters when you write the tests.** The sweep runs on `tick()`, so a test that advances 11 s *through* a `tick()` before delivering `command-end` will see the idle ring fire first — legitimately, since at that moment the command had not ended. Tests that mean "time passed, then the command ended" must advance the clock **without** ticking (`jump`) and tick afterwards.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/events.test.ts`:
```ts
import type { CtrlMessage } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { EventEngine } from "../src/events.js";
import { createLogger } from "../src/log.js";
import { Notifier } from "../src/notifier.js";

function engine() {
  let t = 1_000_000;
  const now = () => t;
  const e = new EventEngine({ notifyMinCommandMs: 10_000, idleQuietMs: 4000, idleMinActiveMs: 1500, now });
  const events: string[] = [];
  const rings: string[] = [];
  e.on("event", (ev) => events.push(`${ev.kind}:${ev.sessionId}:${ev.exitCode ?? ""}:${ev.durationMs ?? ""}`));
  e.on("ring", (r) => rings.push(`${r.kind}:${r.sessionId}`));
  /** Advance the clock AND run the 1 s sweep. */
  const advance = (ms: number) => {
    t += ms;
    e.tick();
  };
  /** Advance the clock WITHOUT sweeping — models time passing between ticks. */
  const jump = (ms: number) => {
    t += ms;
  };
  return { e, events, rings, advance, jump, now: () => t };
}

describe("EventEngine", () => {
  it("prompt path: command-end emits prompt event; rings only for long commands", () => {
    const { e, events, rings, advance, now } = engine();
    e.onBackendEvent({ type: "command-start", sessionId: "S", command: "sleep 1", at: now() });
    expect(e.stateOf("S")).toBe("running");
    advance(2000);
    e.onBackendEvent({ type: "command-end", sessionId: "S", exitCode: 0, at: now() });
    expect(events).toEqual(["prompt:S:0:2000"]);
    expect(rings).toEqual([]);
    e.onBackendEvent({ type: "command-start", sessionId: "S", command: "make", at: now() });
    advance(12_000);
    e.onBackendEvent({ type: "command-end", sessionId: "S", exitCode: 2, at: now() });
    expect(events[1]).toBe("prompt:S:2:12000");
    expect(rings).toEqual(["prompt:S"]);
    expect(e.stateOf("S")).toBe("finished");
    e.onBackendEvent({ type: "prompt", sessionId: "S", at: now() });
    expect(e.stateOf("S")).toBe("editing");
  });

  it("idle path: activity ≥1.5 s then quiet ≥4 s → idle event + ring; not while editing; not twice", () => {
    const { e, events, rings, advance } = engine();
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(1000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(3000);
    expect(events).toEqual([]);
    advance(1500);
    expect(events).toEqual(["idle:T::2000"]);
    expect(rings).toEqual(["idle:T"]);
    advance(5000);
    expect(events.length).toBe(1);
    // editing suppresses the ring but not the event
    e.onBackendEvent({ type: "prompt", sessionId: "T", at: 0 });
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "T" });
    advance(5000);
    expect(events.length).toBe(2);
    expect(rings.length).toBe(1);
  });

  it("idle ring is deduped within 5 s of a prompt ring", () => {
    const { e, rings, advance, jump, now } = engine();
    e.onBackendEvent({ type: "command-start", sessionId: "U", command: "x", at: now() });
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    // `jump`, not `advance`: the command is still running, so no sweep may run yet. Ticking here
    // would legitimately fire an idle ring before the command ended.
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    jump(11_000);
    e.onBackendEvent({ type: "command-end", sessionId: "U", exitCode: 0, at: now() });
    expect(rings).toEqual(["prompt:U"]);

    // The command ended, output resumes, then goes quiet: the idle EVENT fires but the ring is
    // suppressed because the prompt ring is still inside the dedupe window.
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    jump(2000);
    e.onBackendEvent({ type: "screen-changed", sessionId: "U" });
    advance(4000);
    expect(rings).toEqual(["prompt:U"]);
  });

  it("exit event on session removal, no ring", () => {
    const { e, events, rings } = engine();
    e.onBackendEvent({ type: "session-removed", sessionId: "V" });
    expect(events).toEqual(["exit:V::"]);
    expect(rings).toEqual([]);
  });
});

describe("Notifier", () => {
  it("sends notify and rate-limits per session for 60 s", () => {
    let t = 0;
    const sent: CtrlMessage[] = [];
    const n = new Notifier((m) => sent.push(m), createLogger({ stdout: false }), () => t);
    expect(n.ring({ sessionId: "S", kind: "prompt", exitCode: 0, durationMs: 15_000 })).toBe(true);
    expect(n.ring({ sessionId: "S", kind: "idle" })).toBe(false);
    expect(n.ring({ sessionId: "T", kind: "idle" })).toBe(true);
    t = 61_000;
    expect(n.ring({ sessionId: "S", kind: "idle" })).toBe(true);
    expect(sent[0]).toEqual({ type: "notify", sessionId: "S", kind: "prompt", exitCode: 0, durationMs: 15_000 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement**

`apps/agent/src/events.ts`:
```ts
import { EventEmitter } from "node:events";
import type { InnerMessageOf, SessionInfo } from "@shellbell/protocol";
import type { BackendEvent } from "./backends/types.js";

export interface Ring {
  sessionId: string;
  kind: "prompt" | "idle";
  exitCode?: number;
  durationMs?: number;
}

export interface EventEngineOptions {
  notifyMinCommandMs: number;
  idleQuietMs: number;
  idleMinActiveMs: number;
  now?: () => number;
}

interface S {
  promptState: SessionInfo["state"];
  commandStartedAt: number | null;
  command: string;
  lastChangeAt: number;
  activeSince: number | null;
  lastPromptRingAt: number;
}

const PROMPT_DEDUPE_MS = 5000;

export class EventEngine extends EventEmitter<{ event: [InnerMessageOf<"event">]; ring: [Ring] }> {
  private readonly s = new Map<string, S>();
  private readonly now: () => number;

  constructor(private readonly opts: EventEngineOptions) {
    super();
    this.now = opts.now ?? (() => Date.now());
  }

  stateOf(sessionId: string): SessionInfo["state"] {
    return this.s.get(sessionId)?.promptState ?? "unknown";
  }

  forget(sessionId: string): void {
    this.s.delete(sessionId);
  }

  private get(id: string): S {
    let x = this.s.get(id);
    if (!x) {
      x = { promptState: "unknown", commandStartedAt: null, command: "", lastChangeAt: 0, activeSince: null, lastPromptRingAt: Number.NEGATIVE_INFINITY };
      this.s.set(id, x);
    }
    return x;
  }

  onBackendEvent(e: BackendEvent): void {
    const now = this.now();
    switch (e.type) {
      case "screen-changed": {
        const x = this.get(e.sessionId);
        x.lastChangeAt = now;
        x.activeSince ??= now;
        return;
      }
      case "command-start": {
        const x = this.get(e.sessionId);
        x.promptState = "running";
        x.commandStartedAt = now;
        x.command = e.command;
        return;
      }
      case "command-end": {
        const x = this.get(e.sessionId);
        x.promptState = "finished";
        const durationMs = x.commandStartedAt === null ? undefined : now - x.commandStartedAt;
        x.commandStartedAt = null;
        this.emit("event", { type: "event", sessionId: e.sessionId, kind: "prompt", exitCode: e.exitCode, durationMs, command: x.command || undefined, at: now });
        if (durationMs !== undefined && durationMs >= this.opts.notifyMinCommandMs) {
          x.lastPromptRingAt = now;
          x.activeSince = null;
          this.emit("ring", { sessionId: e.sessionId, kind: "prompt", exitCode: e.exitCode, durationMs });
        }
        return;
      }
      case "prompt": {
        this.get(e.sessionId).promptState = "editing";
        return;
      }
      case "session-removed": {
        this.s.delete(e.sessionId);
        this.emit("event", { type: "event", sessionId: e.sessionId, kind: "exit", at: now });
        return;
      }
      default:
        return;
    }
  }

  /** Call once per second. */
  tick(): void {
    const now = this.now();
    for (const [id, x] of this.s) {
      if (x.activeSince === null) continue;
      if (now - x.lastChangeAt < this.opts.idleQuietMs) continue;
      if (x.lastChangeAt - x.activeSince < this.opts.idleMinActiveMs) {
        x.activeSince = null;
        continue;
      }
      const durationMs = x.lastChangeAt - x.activeSince;
      x.activeSince = null;
      this.emit("event", { type: "event", sessionId: id, kind: "idle", durationMs, at: now });
      const recentlyRang = now - x.lastPromptRingAt < PROMPT_DEDUPE_MS + this.opts.idleQuietMs;
      if (!recentlyRang && x.promptState !== "editing") this.emit("ring", { sessionId: id, kind: "idle", durationMs });
    }
  }
}
```

`apps/agent/src/notifier.ts`:
```ts
import type { CtrlMessage } from "@shellbell/protocol";
import type { Ring } from "./events.js";
import type { Logger } from "./log.js";

const RING_LIMIT_MS = 60_000;

export class Notifier {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly send: (m: CtrlMessage) => void,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  ring(r: Ring): boolean {
    const t = this.now();
    const prev = this.last.get(r.sessionId);
    if (prev !== undefined && t - prev < RING_LIMIT_MS) return false;
    this.last.set(r.sessionId, t);
    this.send({ type: "notify", sessionId: r.sessionId, kind: r.kind, exitCode: r.exitCode, durationMs: r.durationMs });
    this.log.info("ring", { session: r.sessionId.slice(0, 12), kind: r.kind });
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): event engine (prompt + idle heuristics) and notifier"
```

---

### Task 9: `PairingManager` — window, gate, confirmation, key derivation (spec 6.4 agent side)

**Files:**
- Create: `apps/agent/src/pairing.ts`, `apps/agent/test/pairing.test.ts`

**Interfaces:**
- `PairingManagerOptions { identity: Identity; fp: string; computerName: string; accent: string; relayUrl: string; sendCtrl: (m: CtrlMessage) => void; savePairing: (p: Pairing) => void; confirm: (phoneFp: string, name: string) => Promise<boolean>; log; now?: () => number; windowMs?: 300000 }`
- `class PairingManager`: `openWindow(): { qrText: string; expiresAt: number }` (sends `pairing-open`), `closeWindow()` (sends `pairing-close` when open), `isOpen: boolean`, `handleRequest(msg: CtrlMessageOf<"pairing-request">): Promise<void>` (does steps 3–5, sends `pairing-add`/`pairing-response`/`pairing-close` or `pairing-reject`), `onExpiry` hook called by the agent's 1 s tick via `tick()`.

- [ ] **Step 1: Write the failing tests**

`apps/agent/test/pairing.test.ts`:
```ts
import {
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  open,
  pairingAd,
  parseQr,
  seal,
  sha256,
  toBase64Url,
  type CtrlMessage,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import type { Pairing } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { PairingManager } from "../src/pairing.js";

function setup(confirm: (fp: string, name: string) => Promise<boolean>) {
  const identity = generateIdentity();
  const fp = fingerprint(identity.ed25519.pub);
  const sent: CtrlMessage[] = [];
  const saved: Pairing[] = [];
  let t = 0;
  const pm = new PairingManager({
    identity, fp, computerName: "MBP", accent: "emerald", relayUrl: "wss://relay.test",
    sendCtrl: (m) => sent.push(m), savePairing: (p) => saved.push(p), confirm, log: createLogger({ stdout: false }), now: () => t,
  });
  return { pm, identity, fp, sent, saved, advance: (ms: number) => { t += ms; pm.tick(); } };
}

function phoneRequest(qrText: string, phone = generateIdentity()) {
  const qr = parseQr(qrText);
  const code = fromBase64Url(qr.p);
  const phoneFp = fingerprint(phone.ed25519.pub);
  const kPsk = derivePskKey(code, qr.c);
  const box = seal(kPsk, encodeCbor({ ed25519Pub: phone.ed25519.pub, x25519Pub: phone.x25519.pub, name: "iPhone", platform: "ios" }), pairingAd("request", qr.c, phoneFp));
  return { phone, phoneFp, code, kPsk, qr, msg: { type: "pairing-request" as const, phoneFp, box } };
}

describe("PairingManager", () => {
  it("opens a window: QR carries relay, fp, pub, name, code, gate; relay gets gateHash", () => {
    const { pm, fp, identity, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const qr = parseQr(qrText);
    expect(qr.c).toBe(fp);
    expect(qr.e).toBe(toBase64Url(identity.ed25519.pub));
    expect(qr.r).toBe("wss://relay.test");
    const opened = sent[0];
    if (opened?.type !== "pairing-open") throw new Error();
    expect(opened.gateHash).toEqual(sha256(fromBase64Url(qr.g)));
    expect(pm.isOpen).toBe(true);
  });

  it("accepts a valid request after confirmation and derives the same K_pair as the phone", async () => {
    const confirmed: string[] = [];
    const { pm, identity, fp, sent, saved } = setup(async (pfp, name) => { confirmed.push(`${name}:${pfp.slice(0, 4)}`); return true; });
    const { qrText } = pm.openWindow();
    const req = phoneRequest(qrText);
    await pm.handleRequest(req.msg);
    expect(confirmed).toHaveLength(1);
    const types = sent.map((m) => m.type);
    expect(types).toEqual(["pairing-open", "pairing-add", "pairing-response", "pairing-close"]);
    const resp = sent[2];
    if (resp?.type !== "pairing-response") throw new Error();
    const inner = decodeCbor(open(req.kPsk, resp.box, pairingAd("response", fp, req.phoneFp))) as { x25519Pub: Uint8Array; computerName: string; accent: string };
    expect(inner.computerName).toBe("MBP");
    const phoneK = derivePairKey(req.phone.x25519.priv, inner.x25519Pub, req.code, fp, req.phoneFp);
    expect(fromBase64Url(saved[0]?.kPair ?? "")).toEqual(phoneK);
    expect(saved[0]?.phoneFp).toBe(req.phoneFp);
    expect(pm.isOpen).toBe(false);
    void identity;
  });

  it("declined confirmation → pairing-reject declined, window stays open", async () => {
    const { pm, sent } = setup(async () => false);
    const { qrText } = pm.openWindow();
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "declined" });
    expect(pm.isOpen).toBe(true);
  });

  it("bad code → reject bad-code; three failures close the window", async () => {
    const { pm, sent } = setup(async () => true);
    const { qrText } = pm.openWindow();
    const good = parseQr(qrText);
    const badQr = JSON.stringify({ ...good, p: toBase64Url(new Uint8Array(16).fill(9)) });
    for (let i = 0; i < 3; i++) await pm.handleRequest(phoneRequest(badQr).msg);
    const rejects = sent.filter((m) => m.type === "pairing-reject");
    expect(rejects).toHaveLength(3);
    expect(rejects[0]).toMatchObject({ reason: "bad-code" });
    expect(pm.isOpen).toBe(false);
    expect(sent.at(-1)?.type).toBe("pairing-close");
  });

  it("expires after the window and rejects late requests with window-closed", async () => {
    const { pm, sent, advance } = setup(async () => true);
    const { qrText } = pm.openWindow();
    advance(300_001);
    expect(pm.isOpen).toBe(false);
    await pm.handleRequest(phoneRequest(qrText).msg);
    expect(sent.at(-1)).toMatchObject({ type: "pairing-reject", reason: "window-closed" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `pairing.ts`**

`apps/agent/src/pairing.ts`:
```ts
import { z } from "zod";
import {
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeQr,
  fingerprint,
  open,
  pairingAd,
  randomBytes,
  seal,
  sha256,
  toBase64Url,
  type CtrlMessage,
  type CtrlMessageOf,
  type Identity,
} from "@shellbell/protocol";
import type { Pairing } from "./config.js";
import type { Logger } from "./log.js";

export interface PairingManagerOptions {
  identity: Identity;
  fp: string;
  computerName: string;
  accent: string;
  relayUrl: string;
  sendCtrl: (m: CtrlMessage) => void;
  savePairing: (p: Pairing) => void;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  log: Logger;
  now?: () => number;
  windowMs?: number;
}

const RequestBody = z.object({
  ed25519Pub: z.instanceof(Uint8Array),
  x25519Pub: z.instanceof(Uint8Array),
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
});

interface Window {
  code: Uint8Array;
  gate: Uint8Array;
  expiresAt: number;
  failures: number;
}

export class PairingManager {
  private window: Window | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: PairingManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "pairing" });
  }

  get isOpen(): boolean {
    return this.window !== null && this.now() < this.window.expiresAt;
  }

  openWindow(): { qrText: string; expiresAt: number } {
    const code = randomBytes(16);
    const gate = randomBytes(16);
    const expiresAt = this.now() + (this.opts.windowMs ?? 300_000);
    this.window = { code, gate, expiresAt, failures: 0 };
    this.opts.sendCtrl({ type: "pairing-open", gateHash: sha256(gate), expiresAt });
    const qrText = encodeQr({
      v: 1,
      r: this.opts.relayUrl,
      c: this.opts.fp,
      e: toBase64Url(this.opts.identity.ed25519.pub),
      n: this.opts.computerName.slice(0, 40),
      p: toBase64Url(code),
      g: toBase64Url(gate),
    });
    this.log.info("pairing window opened");
    return { qrText, expiresAt };
  }

  closeWindow(): void {
    if (!this.window) return;
    this.window = null;
    this.opts.sendCtrl({ type: "pairing-close" });
    this.log.info("pairing window closed");
  }

  /** Call once per second. */
  tick(): void {
    if (this.window && this.now() >= this.window.expiresAt) this.closeWindow();
  }

  async handleRequest(msg: CtrlMessageOf<"pairing-request">): Promise<void> {
    const reject = (reason: CtrlMessageOf<"pairing-reject">["reason"]) => {
      this.opts.sendCtrl({ type: "pairing-reject", phoneFp: msg.phoneFp, reason });
      this.log.warn("pairing rejected", { reason, phone: msg.phoneFp.slice(0, 8) });
    };
    if (!this.isOpen || !this.window) return reject("window-closed");
    const win = this.window;
    const kPsk = derivePskKey(win.code, this.opts.fp);
    let body: z.infer<typeof RequestBody>;
    try {
      body = RequestBody.parse(decodeCbor(open(kPsk, msg.box, pairingAd("request", this.opts.fp, msg.phoneFp))));
      if (fingerprint(body.ed25519Pub) !== msg.phoneFp) throw new Error("fp mismatch");
    } catch {
      win.failures += 1;
      reject("bad-code");
      if (win.failures >= 3) this.closeWindow();
      return;
    }
    const ok = await this.opts.confirm(msg.phoneFp, body.name);
    if (!ok) return reject("declined");
    if (!this.isOpen) return reject("window-closed");

    const kPair = derivePairKey(this.opts.identity.x25519.priv, body.x25519Pub, win.code, this.opts.fp, msg.phoneFp);
    this.opts.savePairing({
      phoneFp: msg.phoneFp,
      name: body.name,
      platform: body.platform,
      ed25519Pub: toBase64Url(body.ed25519Pub),
      x25519Pub: toBase64Url(body.x25519Pub),
      kPair: toBase64Url(kPair),
      pairedAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
    });
    this.opts.sendCtrl({ type: "pairing-add", phoneFp: msg.phoneFp, ed25519Pub: body.ed25519Pub, name: body.name });
    const response = seal(
      kPsk,
      encodeCbor({ x25519Pub: this.opts.identity.x25519.pub, computerName: this.opts.computerName, accent: this.opts.accent }),
      pairingAd("response", this.opts.fp, msg.phoneFp),
    );
    this.opts.sendCtrl({ type: "pairing-response", phoneFp: msg.phoneFp, box: response });
    this.log.info("paired", { phone: msg.phoneFp.slice(0, 8) });
    this.closeWindow();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): pairing manager with gated window and human confirmation"
```

---

### Task 10: `BackendRegistry`, `Agent` orchestrator, integration test (spec 4.2–4.4, 7.4, 8.7, 8.12)

**Files:**
- Create: `apps/agent/src/backends/registry.ts`, `apps/agent/src/agent.ts`, `apps/agent/test/registry.test.ts`, `apps/agent/test/agent.integration.test.ts`

**Interfaces:**
- `class BackendRegistry implements TerminalBackend`: `constructor(log)`, `add(backend: TerminalBackend)`, `remove(name)`, `connected(): { name: BackendName; capabilities: Capabilities }[]`, `nameOf(prefixedId): BackendName | null`; every `TerminalBackend` method prefixes/strips ids (`"<name>:"`), merges events, applies the tmux de-dup rule; `capabilities` of the facade is the OR of members'. `name` is `"iterm2"` (unused by callers).
- `AgentOptions { paths: Paths; config: AgentConfig; identity: Identity; fp: string; registry: BackendRegistry; log; relay?: RelayClient (injectable for tests); confirm: (fp, name) => Promise<boolean>; appVersion: string }`
- `class Agent`: `start()`, `stop()`, `openPairing(): { qrText; expiresAt }`, `closePairing()`, `unpair(phoneFpOrName): boolean`; getters `relayOnline: boolean`, `pairingList: Pairing[]`, `sessionList: SessionInfo[]`, `connectedPhones: { phoneFp; name; viewed }[]`. These five getters/methods are exactly what `ControlServer` (Task 11) reads — there is no `status()` and no `onPairingRequest` hook.
- **Links are keyed by `connId`** (spec 6.6, 8.7 and the §12 "Duplicate phone socket" row), with a `connByFp: Map<phoneFp, connId>` side index because relay `e2e` envelopes carry `from: phoneFp`, not the connId. `phone-disconnected { connId }` removes by **connId** and only clears the side index when it still points at that connId, so a superseded socket can never evict the live one.
- **`minFrameMs`.** Every `auth-ok` calls `tracker.setIntervalMs(Math.max(125, msg.minFrameMs))` (spec 4.2, 8.6).

- [ ] **Step 1: Write `registry.ts`**

`apps/agent/src/backends/registry.ts`:
```ts
import type { BackendName, Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../log.js";
import { BadWindow, SessionGone, type BackendEvent, type Screen, type TerminalBackend } from "./types.js";

export function prefixId(name: BackendName, native: string): string {
  return `${name}:${native}`;
}

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const name = id.slice(0, i);
  if (name !== "iterm2" && name !== "tmux") return null;
  return { name, native: id.slice(i + 1) };
}

export class BackendRegistry implements TerminalBackend {
  readonly name = "iterm2" as const;
  private readonly members = new Map<BackendName, TerminalBackend>();
  private readonly unsubs = new Map<BackendName, () => void>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();

  constructor(private readonly log: Logger) {}

  get capabilities(): Capabilities {
    const all = [...this.members.values()].map((b) => b.capabilities);
    const or = (k: keyof Capabilities) => all.some((c) => c[k]);
    return { subscribe: or("subscribe"), prompts: or("prompts"), createSession: or("createSession"), focus: or("focus"), history: or("history"), absoluteLines: all.every((c) => c.absoluteLines) };
  }

  add(backend: TerminalBackend): void {
    this.members.set(backend.name, backend);
    this.unsubs.get(backend.name)?.();
    this.unsubs.set(
      backend.name,
      backend.on((e) => this.emit(prefixEvent(backend.name, e))),
    );
    this.emit({ type: "layout-changed" });
  }

  remove(name: BackendName): void {
    this.unsubs.get(name)?.();
    this.unsubs.delete(name);
    this.members.delete(name);
    this.emit({ type: "layout-changed" });
  }

  connected(): { name: BackendName; capabilities: Capabilities }[] {
    return [...this.members.values()].map((b) => ({ name: b.name, capabilities: b.capabilities }));
  }

  nameOf(id: string): BackendName | null {
    return splitId(id)?.name ?? null;
  }

  capabilitiesOf(id: string): Capabilities | null {
    const n = this.nameOf(id);
    return n ? (this.members.get(n)?.capabilities ?? null) : null;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    await Promise.all([...this.members.values()].map((b) => b.close()));
  }

  async listSessions(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const iterm = this.members.get("iterm2");
    const tmux = this.members.get("tmux");
    const hidden = iterm?.tmuxWindowIds?.() ?? new Set<string>();
    if (iterm) for (const s of await iterm.listSessions()) out.push(withPrefix("iterm2", s));
    if (tmux) {
      for (const s of await tmux.listSessions()) {
        const w = tmux.tmuxWindowIdOf?.(s.id);
        if (w && hidden.has(w)) continue;
        out.push(withPrefix("tmux", s));
      }
    }
    return out;
  }

  private target(id: string): { backend: TerminalBackend; native: string } {
    const p = splitId(id);
    const backend = p ? this.members.get(p.name) : undefined;
    if (!p || !backend) throw new SessionGone(id);
    return { backend, native: p.native };
  }

  getScreen(id: string): Promise<Screen> {
    const { backend, native } = this.target(id);
    return backend.getScreen(native);
  }
  getHistory(id: string, before: number, count: number): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const { backend, native } = this.target(id);
    return backend.getHistory(native, before, count);
  }
  sendText(id: string, text: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.sendText(native, text);
  }
  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const { backend, native } = this.target(where.sessionId);
      return prefixId(backend.name, await backend.createSession({ kind: "split", sessionId: native, direction: where.direction }));
    }
    const backend = this.members.get(where.backend);
    if (!backend) throw new SessionGone(`backend ${where.backend}`);
    let windowId: string | undefined;
    if (where.windowId) {
      const p = splitId(where.windowId);
      // spec 8.12: a windowId whose prefix does not match `where.backend` must reach the phone as
      // ack.ok=false, error:"bad-window" -- a typed error, so the Agent can map it exactly.
      if (!p || p.name !== where.backend) throw new BadWindow(where.windowId);
      windowId = p.native;
    }
    return prefixId(backend.name, await backend.createSession({ kind: "tab", backend: where.backend, windowId }));
  }
  focus(id: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.focus(native);
  }
  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.error("backend event handler threw", { err: String(err) });
      }
    }
  }
}

function withPrefix(name: BackendName, s: SessionInfo): SessionInfo {
  return { ...s, id: prefixId(name, s.id), windowId: prefixId(name, s.windowId), tabId: prefixId(name, s.tabId), backend: name };
}

function prefixEvent(name: BackendName, e: BackendEvent): BackendEvent {
  return "sessionId" in e ? { ...e, sessionId: prefixId(name, e.sessionId) } : e;
}
```

- [ ] **Step 2: Write `registry.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { BackendRegistry, prefixId, splitId } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("BackendRegistry", () => {
  it("prefixes ids, routes calls, merges events, hides tmux panes iTerm2 already shows", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    iterm.tmuxWindowIds = () => new Set(["@1"]);
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    tmux.addSession("%2", {});
    tmux.tmuxWindowIdOf = (id: string) => (id === "%1" ? "@1" : "@2");
    reg.add(iterm);
    reg.add(tmux);
    const ids = (await reg.listSessions()).map((s) => s.id);
    expect(ids).toEqual(["iterm2:A", "tmux:%2"]);
    const events: string[] = [];
    reg.on((e) => events.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%2" });
    expect(events).toEqual(["tmux:%2"]);
    await reg.sendText("tmux:%2", "x");
    expect(tmux.sentText).toEqual([{ id: "%2", text: "x" }]);
    await expect(reg.sendText("kitty:1", "x")).rejects.toThrow(/session gone/);
    expect(await reg.createSession({ kind: "tab", backend: "tmux" })).toMatch(/^tmux:/);
    await expect(reg.createSession({ kind: "tab", backend: "tmux", windowId: "iterm2:w1" })).rejects.toThrow(/bad-window/);
    expect(splitId("tmux:%3")).toEqual({ name: "tmux", native: "%3" });
    expect(prefixId("iterm2", "x")).toBe("iterm2:x");
  });

  it("one backend failing does not affect the other (spec 15)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    reg.add(iterm);
    reg.add(tmux);

    // iTerm2 blows up on every call; tmux must keep working.
    iterm.getScreen = async () => {
      throw new Error("iTerm2 API died");
    };
    iterm.sendText = async () => {
      throw new Error("iTerm2 API died");
    };
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/iTerm2 API died/);
    await expect(reg.sendText("iterm2:A", "x")).rejects.toThrow(/iTerm2 API died/);
    expect((await reg.getScreen("tmux:%1")).rows).toBeGreaterThan(0);
    await reg.sendText("tmux:%1", "ok");
    expect(tmux.sentText).toEqual([{ id: "%1", text: "ok" }]);

    // Removing the broken backend leaves the healthy one listed and routable.
    reg.remove("iterm2");
    expect((await reg.listSessions()).map((x) => x.id)).toEqual(["tmux:%1"]);
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/session gone/);

    // Events from the survivor still reach subscribers.
    const seen: string[] = [];
    reg.on((e) => seen.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%1" });
    expect(seen).toContain("tmux:%1");
  });
});
```

- [ ] **Step 3: Write `agent.ts`**

`apps/agent/src/agent.ts`:
```ts
import {
  bytesForKey,
  fromBase64Url,
  type CtrlMessage,
  type Envelope,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
  type SessionInfo,
} from "@shellbell/protocol";
import type { BackendRegistry } from "./backends/registry.js";
import { BadWindow, SessionGone, Unsupported, type BackendEvent } from "./backends/types.js";
import { loadPairings, savePairings, type AgentConfig, type Pairing, type Paths } from "./config.js";
import { EventEngine } from "./events.js";
import type { Logger } from "./log.js";
import { Notifier } from "./notifier.js";
import { PairingManager } from "./pairing.js";
import { PhoneLink } from "./phone-link.js";
import { RelayClient } from "./relay-client.js";
import { ScreenTracker } from "./screen-tracker.js";

export interface AgentOptions {
  paths: Paths;
  config: AgentConfig;
  identity: Identity;
  fp: string;
  registry: BackendRegistry;
  log: Logger;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  appVersion: string;
  relay?: RelayClient;
  relayUrlOverride?: string;
}

export class Agent {
  readonly relay: RelayClient;
  readonly tracker: ScreenTracker;
  readonly events: EventEngine;
  readonly notifier: Notifier;
  readonly pairing: PairingManager;
  /** Keyed by relay connId (spec 6.6/8.7/12): a stale socket can never be confused with the live one. */
  private links = new Map<string, PhoneLink>();
  /** phoneFp -> connId of that phone's live socket; e2e envelopes only carry the fp. */
  private connByFp = new Map<string, string>();
  private pairings: Pairing[];
  private sessions: SessionInfo[] = [];
  private tick: NodeJS.Timeout | null = null;
  private sessionsDebounce: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(private readonly o: AgentOptions) {
    this.log = o.log.child({ unit: "agent" });
    this.pairings = loadPairings(o.paths);
    const relayUrl = o.relayUrlOverride ?? o.config.relayUrl;
    this.relay = o.relay ?? new RelayClient({ relayUrl, fp: o.fp, identity: o.identity, name: o.config.computerName, appVersion: o.appVersion, log: o.log });
    this.tracker = new ScreenTracker({ backend: o.registry, sink: (conn, msg) => this.sendTo(conn, msg), log: o.log });
    this.events = new EventEngine({ notifyMinCommandMs: o.config.notifyMinCommandMs, idleQuietMs: o.config.idleQuietMs, idleMinActiveMs: o.config.idleMinActiveMs });
    this.notifier = new Notifier((m) => this.relay.sendCtrl(m), o.log);
    this.pairing = new PairingManager({
      identity: o.identity, fp: o.fp, computerName: o.config.computerName, accent: o.config.accent, relayUrl,
      sendCtrl: (m) => this.relay.sendCtrl(m), savePairing: (p) => this.addPairing(p), confirm: o.confirm, log: o.log,
    });
    this.relay.on("auth-ok", (m) => {
      // spec 4.2/8.6: the relay advertises its minimum frame interval; the flush loop must honour it.
      this.tracker.setIntervalMs(Math.max(125, m.minFrameMs));
    });
    this.relay.on("ctrl", (m) => void this.onCtrl(m));
    this.relay.on("e2e", (env) => this.onE2E(env));
    this.relay.on("down", () => {
      for (const connId of this.links.keys()) this.tracker.dropViewer(connId);
      this.links.clear();
      this.connByFp.clear();
    });
    o.registry.on((e) => this.onBackendEvent(e));
    this.events.on("event", (ev) => this.broadcast(ev));
    this.events.on("ring", (r) => this.notifier.ring(r));
  }

  // ---- lifecycle ----

  start(): void {
    this.relay.start();
    this.tracker.start();
    this.tick = setInterval(() => {
      this.events.tick();
      this.pairing.tick();
      this.sweepHandshakes();
    }, 1000);
    void this.refreshSessions();
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.sessionsDebounce) clearTimeout(this.sessionsDebounce);
    this.sessionsDebounce = null;
    this.tracker.stop();
    this.relay.stop();
  }

  /**
   * spec 6.6: a phone must send conn.hello within 10 s of connecting. We do not close the socket
   * (the relay owns it) — we log once and leave the link dormant until a hello actually arrives.
   */
  private sweepHandshakes(): void {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (!link.helloOverdue(now)) continue;
      link.dormant = true;
      this.log.warn("no conn.hello within 10s; ignoring this link until one arrives", {
        phone: link.phoneFp.slice(0, 8),
        conn: link.connId.slice(0, 6),
      });
    }
  }

  get relayOnline(): boolean {
    return this.relay.online;
  }
  get pairingList(): Pairing[] {
    return this.pairings;
  }
  get sessionList(): SessionInfo[] {
    return this.sessions;
  }
  get connectedPhones(): { phoneFp: string; name: string; viewed: string | null }[] {
    return [...this.links.values()].map((l) => ({ phoneFp: l.phoneFp, name: l.name, viewed: l.viewed }));
  }

  /** Test seam: the live link for a phone fp, or undefined. */
  linkForPhone(phoneFp: string): PhoneLink | undefined {
    const connId = this.connByFp.get(phoneFp);
    return connId ? this.links.get(connId) : undefined;
  }

  openPairing(): { qrText: string; expiresAt: number } {
    return this.pairing.openWindow();
  }
  closePairing(): void {
    this.pairing.closeWindow();
  }

  unpair(fpOrName: string): boolean {
    const p = this.pairings.find((x) => x.phoneFp.startsWith(fpOrName) || x.name === fpOrName);
    if (!p) return false;
    this.pairings = this.pairings.filter((x) => x !== p);
    savePairings(this.o.paths, this.pairings);
    this.relay.sendCtrl({ type: "unpair", phoneFp: p.phoneFp });
    this.dropLinkFor(p.phoneFp);
    return true;
  }

  private dropLinkFor(phoneFp: string): void {
    const connId = this.connByFp.get(phoneFp);
    if (connId === undefined) return;
    this.tracker.dropViewer(connId);
    this.links.delete(connId);
    this.connByFp.delete(phoneFp);
  }

  private addPairing(p: Pairing): void {
    this.pairings = [...this.pairings.filter((x) => x.phoneFp !== p.phoneFp), p];
    savePairings(this.o.paths, this.pairings);
  }

  /** Local-only removal, for an `unpair` the relay has already applied. */
  private forgetPairing(phoneFp: string): void {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((x) => x.phoneFp !== phoneFp);
    if (this.pairings.length !== before) savePairings(this.o.paths, this.pairings);
    this.dropLinkFor(phoneFp);
  }

  // ---- relay ctrl ----

  private async onCtrl(m: CtrlMessage): Promise<void> {
    switch (m.type) {
      case "unpaired": {
        if (m.phoneFps.length) {
          this.pairings = this.pairings.filter((p) => !m.phoneFps.includes(p.phoneFp));
          savePairings(this.o.paths, this.pairings);
          for (const fp of m.phoneFps) this.dropLinkFor(fp);
          this.log.info("applied unpair tombstones", { count: m.phoneFps.length });
        }
        // Order is the contract: the relay clears every tombstone when it handles pairings-sync,
        // so the tombstones MUST already be applied to `this.pairings` before this send.
        this.relay.sendCtrl({
          type: "pairings-sync",
          phones: this.pairings.slice(0, 10).map((p) => ({ phoneFp: p.phoneFp, ed25519Pub: fromBase64Url(p.ed25519Pub), name: p.name })),
        });
        return;
      }
      case "phones":
        for (const p of m.connected) this.attach(p.phoneFp, p.connId, p.name);
        return;
      case "phone-connected":
        this.attach(m.phoneFp, m.connId, m.name);
        return;
      case "phone-disconnected": {
        // Remove by connId: a superseded socket's disconnect must not evict the live one.
        const link = this.links.get(m.connId);
        if (!link) return;
        this.tracker.dropViewer(m.connId);
        this.links.delete(m.connId);
        if (this.connByFp.get(link.phoneFp) === m.connId) this.connByFp.delete(link.phoneFp);
        return;
      }
      case "pairing-request":
        await this.pairing.handleRequest(m);
        return;
      case "unpair":
        // The relay already removed its row before forwarding this; just drop our local state.
        // Do NOT call unpair(), which would echo a redundant `unpair` back to the relay.
        this.forgetPairing(m.phoneFp);
        return;
      case "error":
        this.log.warn("relay error", { code: m.code, message: m.message });
        return;
      default:
        return;
    }
  }

  private attach(phoneFp: string, connId: string, name: string): void {
    const pairing = this.pairings.find((p) => p.phoneFp === phoneFp);
    if (!pairing) {
      this.log.warn("relay announced an unknown phone; ignoring", { phone: phoneFp.slice(0, 8) });
      return;
    }
    this.dropLinkFor(phoneFp); // the relay superseded any older socket for this phone (4005)
    const link = new PhoneLink({ phoneFp, connId, name, kPair: fromBase64Url(pairing.kPair), computerFp: this.o.fp, send: (env) => this.relay.sendEnvelope(env), log: this.o.log });
    link.onBroken = () => {
      this.tracker.dropViewer(connId);
      if (this.links.get(connId) === link) {
        this.links.delete(connId);
        if (this.connByFp.get(phoneFp) === connId) this.connByFp.delete(phoneFp);
      }
    };
    this.links.set(connId, link);
    this.connByFp.set(phoneFp, connId);
    pairing.lastSeenAt = new Date().toISOString();
    savePairings(this.o.paths, this.pairings);
  }

  // ---- e2e ----

  private onE2E(env: Envelope): void {
    // Envelopes carry the phone's fp, so resolve the live connId through the side index.
    const connId = this.connByFp.get(env.from);
    const link = connId === undefined ? undefined : this.links.get(connId);
    if (!link) return;
    const wasHandshaken = link.handshaken;
    const msg = link.handleEnvelope(env);
    if (!wasHandshaken && link.handshaken) {
      link.send({ type: "hello", agentVersion: this.o.appVersion, backends: this.o.registry.connected(), computerName: this.o.config.computerName, accent: this.o.config.accent });
      link.send({ type: "sessions", list: this.sessions });
    }
    if (msg) void this.onInner(link, msg);
  }

  private async onInner(link: PhoneLink, msg: InnerMessage): Promise<void> {
    const ack = (reqId: string, ok: boolean, extra: { error?: string; sessionId?: string } = {}) => {
      const a: InnerMessageOf<"ack"> = { type: "ack", reqId, ok, ...extra };
      link.rememberAck(reqId, a);
      link.send(a);
    };
    const reg = this.o.registry;
    try {
      switch (msg.type) {
        case "subscribe":
          link.viewed = msg.sessionId;
          this.tracker.setViewed(link.connId, msg.sessionId);
          return;
        case "input.line":
          this.log.info("input", { kind: "line", len: msg.text.length });
          await reg.sendText(msg.sessionId, `${msg.text}\r`);
          return ack(msg.reqId, true);
        case "input.text":
          this.log.info("input", { kind: "text", len: msg.text.length });
          await reg.sendText(msg.sessionId, msg.text);
          return ack(msg.reqId, true);
        case "input.key":
          await reg.sendText(msg.sessionId, bytesForKey(msg.key));
          return ack(msg.reqId, true);
        case "history.get": {
          const h = await reg.getHistory(msg.sessionId, msg.before, msg.count);
          link.send({ type: "history", sessionId: msg.sessionId, before: msg.before, lines: h.lines.slice(-200), oldestAvailable: h.oldestAvailable });
          return ack(msg.reqId, true);
        }
        case "session.create": {
          const id = await reg.createSession(msg.in);
          void this.refreshSessions();
          return ack(msg.reqId, true, { sessionId: id });
        }
        case "session.focus":
          if (!reg.capabilitiesOf(msg.sessionId)?.focus) return ack(msg.reqId, false, { error: "unsupported" });
          await reg.focus(msg.sessionId);
          return ack(msg.reqId, true);
        case "snapshot.get":
          this.tracker.forceSnapshot(link.connId, msg.sessionId);
          return ack(msg.reqId, true);
        default:
          return;
      }
    } catch (err) {
      const reqId = "reqId" in msg ? msg.reqId : null;
      // spec 8.12: a mismatched windowId must reach the phone as error:"bad-window", not "failed".
      const error =
        err instanceof SessionGone ? "session-gone" : err instanceof Unsupported ? "unsupported" : err instanceof BadWindow ? "bad-window" : "failed";
      this.log.warn("inner message failed", { type: msg.type, error, err: String(err) });
      if (reqId) ack(reqId, false, { error });
    }
  }

  private sendTo(connId: string, msg: InnerMessage): void {
    this.links.get(connId)?.send(msg);
  }

  private broadcast(msg: InnerMessage): void {
    for (const l of this.links.values()) l.send(msg);
  }

  // ---- backend ----

  private onBackendEvent(e: BackendEvent): void {
    this.events.onBackendEvent(e);
    // NB: the ScreenTracker subscribes to the registry itself (Task 7) and owns `markDirty` /
    // `sessionRemoved`. Do not mirror those calls here.
    switch (e.type) {
      case "screen-changed":
        return;
      case "session-removed":
        this.scheduleSessions();
        return;
      case "layout-changed":
      case "session-added":
      case "focus-changed":
      case "title-changed":
        this.scheduleSessions();
        return;
      default:
        return;
    }
  }

  private scheduleSessions(): void {
    if (this.sessionsDebounce) return;
    this.sessionsDebounce = setTimeout(() => {
      this.sessionsDebounce = null;
      void this.refreshSessions();
    }, 100);
  }

  private async refreshSessions(): Promise<void> {
    try {
      const list = await this.o.registry.listSessions();
      this.sessions = list.map((s) => ({ ...s, state: this.events.stateOf(s.id) }));
      this.broadcast({ type: "sessions", list: this.sessions });
    } catch (err) {
      this.log.warn("listSessions failed", { err: String(err) });
    }
  }
}
```


- [ ] **Step 4: Write the integration test**

`apps/agent/test/agent.integration.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authMessage,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeEnvelope,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  open,
  pairingAd,
  parseCtrl,
  parseQr,
  seal,
  sign,
  type CtrlMessage,
  type Envelope,
  type InnerMessage,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { loadConfig, loadPairings, paths, type Paths } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakePhone } from "./fakes/fake-phone.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });

/** A phone-side WebSocket client speaking the relay protocol. */
class PhoneSocket {
  ws!: WebSocket;
  ctrl: CtrlMessage[] = [];
  e2e: Envelope[] = [];
  inner: InnerMessage[] = [];
  phone: FakePhone | null = null;
  constructor(readonly identity = generateIdentity()) {}
  get fp() {
    return fingerprint(this.identity.ed25519.pub);
  }
  connect(url: string, computerFp: string, role: "phone" | "pairing", gate?: Uint8Array): Promise<void> {
    this.ws = new WebSocket(`${url}/ws/${computerFp}`);
    return new Promise((resolve) => {
      this.ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeEnvelope(new Uint8Array(data as Buffer));
        if (env.t === "e2e") {
          this.e2e.push(env);
          if (this.phone) {
            if (env.seq === 0) this.phone.acceptHello(env);
            else this.inner.push(this.phone.open(env));
          }
          return;
        }
        const m = parseCtrl(env.body);
        this.ctrl.push(m);
        if (m.type === "challenge") {
          const sig = sign(this.identity.ed25519.priv, authMessage(m.connId, role, this.fp, m.nonce));
          this.sendCtrl({ type: "auth", role, fp: this.fp, ed25519Pub: this.identity.ed25519.pub, sig, name: "iPhone", appVersion: "t", gate });
        }
        if (m.type === "auth-ok") resolve();
      });
    });
  }
  sendCtrl(body: CtrlMessage) {
    this.ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: this.fp, seq: 0, body }), { binary: true });
  }
  send(env: Envelope) {
    this.ws.send(encodeEnvelope(env), { binary: true });
  }
}

let relay: FakeRelay;
let backend: FakeBackend;
let agent: Agent;
let computerFp: string;
let agentPaths: Paths;

/** A PhoneSocket that has completed conn.hello, so `phone` is non-null. */
type ConnectedPhone = PhoneSocket & { phone: FakePhone };

/**
 * Runs the whole pairing dance for one phone and returns a connected, handshaken phone socket.
 * Used by every test below so the flow is written exactly once.
 */
async function pairAndConnect(): Promise<ConnectedPhone> {
  const { qrText } = agent.openPairing();
  const qr = parseQr(qrText, { allowInsecure: true });
  const pairSock = new PhoneSocket();
  await pairSock.connect(relay.url, computerFp, "pairing", fromBase64Url(qr.g));
  const code = fromBase64Url(qr.p);
  const kPsk = derivePskKey(code, computerFp);
  const box = seal(
    kPsk,
    encodeCbor({ ed25519Pub: pairSock.identity.ed25519.pub, x25519Pub: pairSock.identity.x25519.pub, name: "iPhone", platform: "ios" }),
    pairingAd("request", computerFp, pairSock.fp),
  );
  pairSock.sendCtrl({ type: "pairing-request", phoneFp: pairSock.fp, box });
  await waitFor(() => pairSock.ctrl.some((m) => m.type === "pairing-response"));
  const resp = pairSock.ctrl.find((m) => m.type === "pairing-response");
  if (resp?.type !== "pairing-response") throw new Error("no pairing-response");
  const inner = decodeCbor(open(kPsk, resp.box, pairingAd("response", computerFp, pairSock.fp))) as { x25519Pub: Uint8Array };
  const kPair = derivePairKey(pairSock.identity.x25519.priv, inner.x25519Pub, code, computerFp, pairSock.fp);
  pairSock.ws.close();

  const ph = new PhoneSocket(pairSock.identity);
  ph.phone = new FakePhone(pairSock.identity, computerFp, kPair);
  await ph.connect(relay.url, computerFp, "phone");
  ph.send(ph.phone.hello());
  await waitFor(() => ph.inner.some((m) => m.type === "sessions"));
  return ph as ConnectedPhone;
}

beforeEach(async () => {
  const p = paths(mkdtempSync(join(tmpdir(), "sb-agent-")));
  agentPaths = p;
  const { identity, fp } = loadOrCreateIdentity(p);
  computerFp = fp;
  relay = new FakeRelay(fp);
  await relay.start();
  backend = new FakeBackend();
  backend.addSession("S1", { rows: 3, lines: ["one", "two", "three"], scrollbackTotal: 5 });
  const registry = new BackendRegistry(log);
  registry.add(backend);
  const config = { ...loadConfig(p), relayUrl: relay.url, computerName: "MBP" };
  agent = new Agent({ paths: p, config, identity, fp, registry, log, confirm: async () => true, appVersion: "0.0.1-test" });
  agent.start();
  await waitFor(() => agent.relayOnline);
});
afterEach(async () => {
  agent.stop();
  await relay.stop();
});

describe("Agent end to end (fake relay, fake backend)", () => {
  it("pairs, handshakes, receives hello+sessions, views a session, types with ack, gets diffs and events", async () => {
    // --- pair, reconnect as a phone, run conn.hello (the dance lives in pairAndConnect) ---
    const ph = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(1);
    expect(ph.inner[0]).toMatchObject({ type: "hello", computerName: "MBP", backends: [{ name: "iterm2" }] });
    const sessions = ph.inner.find((m) => m.type === "sessions");
    if (sessions?.type !== "sessions") throw new Error();
    expect(sessions.list.map((s) => s.id)).toEqual(["iterm2:S1"]);

    // --- view + snapshot ---
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "screen.snapshot"));
    const snap = ph.inner.find((m) => m.type === "screen.snapshot");
    if (snap?.type !== "screen.snapshot") throw new Error();
    expect(snap.lines.map((l) => l.r[0]?.t)).toEqual(["one", "two", "three"]);

    // --- input with ack, duplicate reqId not re-executed ---
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack"));
    expect(backend.sentText).toEqual([{ id: "S1", text: "y\r" }]);
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.filter((m) => m.type === "ack").length === 2);
    expect(backend.sentText).toHaveLength(1);

    // --- output → diff; command-end → event to the phone; ring to the relay ---
    backend.appendLine("S1", "four");
    await waitFor(() => ph.inner.some((m) => m.type === "screen.diff"));
    backend.emit({ type: "command-start", sessionId: "S1", command: "make", at: Date.now() - 20_000 });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 0, at: Date.now() });
    await waitFor(() => ph.inner.some((m) => m.type === "event"));
    expect(ph.inner.find((m) => m.type === "event")).toMatchObject({ kind: "prompt", sessionId: "iterm2:S1", exitCode: 0 });
    // durationMs is 0 here because command-start was only just observed; ring requires ≥10 s → none expected
    expect(relay.ctrlFromAgent.filter((m) => m.type === "notify")).toHaveLength(0);

    // --- unsupported focus is acked with an error ---
    backend.capabilities = { ...backend.capabilities, focus: false };
    ph.send(ph.phone.seal({ type: "session.focus", reqId: "r2", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r2"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r2")).toMatchObject({ ok: false, error: "unsupported" });

    // --- a mismatched windowId is acked bad-window, not "failed" (spec 8.12) ---
    ph.send(ph.phone.seal({ type: "session.create", reqId: "r3", in: { kind: "tab", backend: "tmux", windowId: "iterm2:w1" } }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r3"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r3")).toMatchObject({ ok: false, error: "bad-window" });
    ph.ws.close();
  });

  it("applies the relay's minFrameMs to the flush interval", async () => {
    // FakeRelay advertises minFrameMs 125 in auth-ok; the agent must have applied it (spec 4.2/8.6).
    const spy = vi.spyOn(agent.tracker, "setIntervalMs");
    agent.relay.emit("auth-ok", { type: "auth-ok", role: "agent", agentOnline: true, computerName: "FakeMac", serverTime: Date.now(), minFrameMs: 400 });
    expect(spy).toHaveBeenCalledWith(400);
    agent.relay.emit("auth-ok", { type: "auth-ok", role: "agent", agentOnline: true, computerName: "FakeMac", serverTime: Date.now(), minFrameMs: 50 });
    expect(spy).toHaveBeenLastCalledWith(125); // never below the 125 ms floor
    spy.mockRestore();
  });

  it("applies unpaired tombstones BEFORE sending pairings-sync (Plan 02 parked item)", async () => {
    // The relay clears every tombstone when it handles pairings-sync, so a sync that still lists a
    // tombstoned phone would resurrect it. Order is the whole contract.
    const ph = await pairAndConnect();
    const removedFp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([removedFp]);
    ph.ws.close();

    relay.ctrlFromAgent.length = 0;
    relay.sendToAgent({ type: "unpaired", phoneFps: [removedFp] });
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "pairings-sync"));
    const sync = relay.ctrlFromAgent.find((m) => m.type === "pairings-sync");
    if (sync?.type !== "pairings-sync") throw new Error("no pairings-sync");
    // The tombstone was applied first: the sync must NOT re-register the removed phone.
    expect(sync.phones.map((p) => p.phoneFp)).not.toContain(removedFp);
    expect(agent.pairingList).toHaveLength(0);
    // And it is written through to disk, not just held in memory.
    expect(loadPairings(agentPaths)).toHaveLength(0);
  });

  it("unpair removes the pairing, persists it, drops the link and tells the relay", async () => {
    const ph = await pairAndConnect();
    const fp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([fp]);
    await waitFor(() => agent.connectedPhones.length === 1);
    relay.ctrlFromAgent.length = 0;

    expect(agent.unpair("nobody")).toBe(false);
    expect(agent.unpair(fp.slice(0, 6))).toBe(true); // fp prefix, per spec 8.1

    expect(agent.pairingList).toHaveLength(0);
    expect(loadPairings(agentPaths)).toHaveLength(0); // persisted
    expect(agent.connectedPhones).toHaveLength(0); // link dropped
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "unpair"));
    expect(relay.ctrlFromAgent.find((m) => m.type === "unpair")).toMatchObject({ type: "unpair", phoneFp: fp });
    ph.ws.close();
  });

  it("sends `event` to every handshaken phone, not just the viewer (spec 4.4, 7.4)", async () => {
    const a = await pairAndConnect();
    const b = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(2);
    // Only `a` is viewing anything.
    a.send(a.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => a.inner.some((m) => m.type === "screen.snapshot"));

    backend.emit({ type: "command-start", sessionId: "S1", command: "make", at: Date.now() });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 3, at: Date.now() });
    await waitFor(() => a.inner.some((m) => m.type === "event") && b.inner.some((m) => m.type === "event"));
    for (const p of [a, b]) {
      expect(p.inner.find((m) => m.type === "event")).toMatchObject({ kind: "prompt", sessionId: "iterm2:S1", exitCode: 3 });
    }
    // `b` never subscribed, so it got no screen frames at all.
    expect(b.inner.filter((m) => m.type === "screen.snapshot" || m.type === "screen.diff")).toHaveLength(0);
    a.ws.close();
    b.ws.close();
  });
});
```

- [ ] **Step 5: Run tests** — `pnpm test`. Expected: all green. The integration test exercises pairing, `conn.hello`, hello/sessions, snapshot, ack dedupe, diff, events and the unsupported-focus path.

- [ ] **Step 6: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): backend registry and agent orchestrator with end-to-end integration test"
```

---

### Task 11: Control socket, CLI, LaunchAgent, doctor, build (spec 8.1, 8.9, 16)

**Files:**
- Create: `apps/agent/src/control.ts`, `apps/agent/src/cli.ts`, `apps/agent/src/launchd.ts`, `apps/agent/src/doctor.ts`, `apps/agent/tsdown.config.ts`, `apps/agent/README.md`, `apps/agent/test/control.test.ts`, `apps/agent/test/launchd.test.ts`, `apps/agent/test/doctor.test.ts`

**Interfaces:**
- `control.ts`: `class ControlServer { constructor(sockPath, agent: Agent, log); start(): Promise<void>; stop(): Promise<void>; pairingConfirm: (fp, name) => Promise<boolean> }` — newline-delimited JSON over a Unix socket. Commands: `{ cmd: "status" }` → `{ ok, data: StatusData }`; `{ cmd: "devices" }`; `{ cmd: "unpair", args: { target } }`; `{ cmd: "pair-open" }` → `{ ok, data: { qrText, expiresAt } }` and then, on that same connection, streamed events `{ event: "request", phoneFp, name }` and `{ event: "closed" }`; `{ cmd: "confirm", args: { phoneFp, accept } }`. `controlRequest(sockPath, cmd, args?): Promise<unknown>` for one-shot commands; `controlPairSession(sockPath, handlers)` for the streaming one.
- `cli.ts`: commander program per spec 8.1. `start` builds the registry (iTerm2 only in this plan; Plan 04 adds tmux), the `Agent`, and a `ControlServer`; when stdin is a TTY and there are no pairings, it opens a window and prints the QR. `pair` uses the control socket if present, else starts an in-process agent and pairs directly.
- `launchd.ts`: `plistFor({ nodePath, cliPath, logPath }): string`, `install(p: Paths): Promise<string>` (writes `~/Library/LaunchAgents/dev.bilalahmad.shellbell.plist`, runs `launchctl bootstrap gui/<uid> <plist>`), `uninstall(): Promise<void>`, `isGlobalInstall(): boolean` (`process.argv[1]` is not under a directory containing `_npx`).
- `doctor.ts`: `runDoctor(p: Paths, cfg: AgentConfig): Promise<Check[]>` plus two **pure, exported and tested** helpers, `parseTmuxVersion(stdout: string): number | null` and `plistNodeOk(plistText: string, execPath: string): boolean`. `runDoctor` itself is never unit-tested — it shells out to `osascript` and dials the network (see the Human-run step).
- **Test coverage for this task:** `control.test.ts` (the socket protocol), `launchd.test.ts` (`plistFor` + `isGlobalInstall`, both pure), `doctor.test.ts` (`parseTmuxVersion` + `plistNodeOk`, both pure). `install`/`uninstall` are not tested: they call `launchctl` and would register a real LaunchAgent.

- [ ] **Step 1: Write the control server test**

`apps/agent/test/control.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlServer, controlRequest } from "../src/control.js";
import { createLogger } from "../src/log.js";

describe("control socket", () => {
  it("answers status/devices/unpair and rejects unknown commands", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "sb-ctl-")), "agent.sock");
    const fakeAgent = {
      relayOnline: true,
      pairingList: [{ phoneFp: "a".repeat(26), name: "iPhone", lastSeenAt: null }],
      sessionList: [{ id: "iterm2:x" }],
      connectedPhones: [],
      unpair: (t: string) => t === "iPhone",
      openPairing: () => ({ qrText: "{}", expiresAt: 1 }),
      closePairing: () => {},
    };
    const server = new ControlServer(sock, fakeAgent as never, createLogger({ stdout: false }));
    await server.start();
    const status = (await controlRequest(sock, "status")) as { relayOnline: boolean; sessions: number };
    expect(status.relayOnline).toBe(true);
    expect(status.sessions).toBe(1);
    expect(((await controlRequest(sock, "devices")) as { name: string }[])[0]?.name).toBe("iPhone");
    expect(await controlRequest(sock, "unpair", { target: "iPhone" })).toEqual({ removed: true });
    await expect(controlRequest(sock, "nope")).rejects.toThrow(/unknown command/);
    await server.stop();
  });
});
```

- [ ] **Step 1b: Write the pure-unit tests for launchd and doctor**

`apps/agent/test/launchd.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LABEL, plistFor } from "../src/launchd.js";

describe("plistFor", () => {
  it("emits a launchd plist with the label, argv, PATH and log paths", () => {
    const xml = plistFor({ nodePath: "/opt/homebrew/bin/node", cliPath: "/usr/local/bin/shellbell", logPath: "/Users/x/.shellbell/agent.log" });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(LABEL).toBe("dev.bilalahmad.shellbell");
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/usr/local/bin/shellbell</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--service</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(xml).toContain("<key>StandardOutPath</key><string>/Users/x/.shellbell/agent.log</string>");
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = plistFor({ nodePath: "/a&b/node", cliPath: "/c<d/cli.js", logPath: "/l.log" });
    expect(xml).toContain("/a&amp;b/node");
    expect(xml).toContain("/c&lt;d/cli.js");
    expect(xml).not.toContain("/a&b/node");
  });
});
```

`apps/agent/test/doctor.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseTmuxVersion, plistNodeOk } from "../src/doctor.js";

describe("parseTmuxVersion", () => {
  it.each([
    ["tmux 3.2a\n", 3.02],
    ["tmux 3.4\n", 3.04],
    ["tmux 3.10\n", 3.1],
    ["tmux 2.9\n", 2.09],
  ])("%j -> %s", (stdout, expected) => {
    expect(parseTmuxVersion(stdout)).toBeCloseTo(expected, 5);
  });

  it("orders versions so 3.1a < 3.2 <= 3.10", () => {
    const v = (s: string) => parseTmuxVersion(s) as number;
    expect(v("tmux 3.1a")).toBeLessThan(v("tmux 3.2"));
    expect(v("tmux 3.2")).toBeLessThanOrEqual(v("tmux 3.10"));
  });

  it("returns null for unrecognisable output", () => {
    expect(parseTmuxVersion("command not found")).toBeNull();
    expect(parseTmuxVersion("")).toBeNull();
  });
});

describe("plistNodeOk", () => {
  it("accepts the running node path and any absolute node path", () => {
    expect(plistNodeOk("<string>/opt/homebrew/bin/node</string>", "/opt/homebrew/bin/node")).toBe(true);
    expect(plistNodeOk("<string>/usr/local/bin/node</string>", "/opt/homebrew/bin/node")).toBe(true);
  });
  it("rejects a plist with no node path at all", () => {
    expect(plistNodeOk("<string>start</string>", "/opt/homebrew/bin/node")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `control.ts`**

`apps/agent/src/control.ts`:
```ts
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Agent } from "./agent.js";
import type { Logger } from "./log.js";

type Req = { cmd: string; args?: Record<string, unknown> };

export interface StatusData {
  relayOnline: boolean;
  sessions: number;
  phones: { phoneFp: string; name: string; lastSeenAt: string | null }[];
  connected: { phoneFp: string; name: string; viewed: string | null }[];
}

export class ControlServer {
  private server: Server | null = null;
  private pending = new Map<string, (accept: boolean) => void>();
  private pairClients = new Set<Socket>();
  /** The agent's confirm hook: resolves when a `confirm` command arrives (or after 60 s → false). */
  readonly pairingConfirm = (phoneFp: string, name: string): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(phoneFp);
        resolve(false);
      }, 60_000);
      this.pending.set(phoneFp, (accept) => {
        clearTimeout(timer);
        this.pending.delete(phoneFp);
        resolve(accept);
      });
      for (const c of this.pairClients) c.write(`${JSON.stringify({ event: "request", phoneFp, name })}\n`);
    });

  constructor(
    private readonly sockPath: string,
    private readonly agent: Agent,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.sockPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const c of this.pairClients) c.destroy();
    await new Promise<void>((r) => this.server?.close(() => r()));
    if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
  }

  private handle(socket: Socket): void {
    const rl = createInterface({ input: socket });
    rl.on("line", (line) => {
      let req: Req;
      try {
        req = JSON.parse(line) as Req;
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: "bad json" })}\n`);
        return;
      }
      try {
        const data = this.dispatch(req, socket);
        socket.write(`${JSON.stringify({ ok: true, data })}\n`);
      } catch (err) {
        socket.write(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
      }
    });
    socket.on("close", () => this.pairClients.delete(socket));
    socket.on("error", (err) => this.log.debug("control socket error", { err: err.message }));
  }

  private dispatch(req: Req, socket: Socket): unknown {
    const a = this.agent;
    switch (req.cmd) {
      case "status":
        return {
          relayOnline: a.relayOnline,
          sessions: a.sessionList.length,
          phones: a.pairingList.map((p) => ({ phoneFp: p.phoneFp, name: p.name, lastSeenAt: p.lastSeenAt })),
          connected: a.connectedPhones,
        } satisfies StatusData;
      case "devices":
        return a.pairingList.map((p) => ({ phoneFp: p.phoneFp, name: p.name, lastSeenAt: p.lastSeenAt }));
      case "unpair":
        return { removed: a.unpair(String(req.args?.target ?? "")) };
      case "pair-open":
        this.pairClients.add(socket);
        return a.openPairing();
      case "pair-close":
        a.closePairing();
        return {};
      case "confirm": {
        const fp = String(req.args?.phoneFp ?? "");
        const cb = this.pending.get(fp);
        if (!cb) throw new Error("no pending request");
        cb(Boolean(req.args?.accept));
        return {};
      }
      default:
        throw new Error(`unknown command: ${req.cmd}`);
    }
  }
}

export function controlRequest(sockPath: string, cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ cmd, args })}\n`));
    const rl = createInterface({ input: socket });
    rl.once("line", (line) => {
      socket.end();
      const res = JSON.parse(line) as { ok: boolean; data?: unknown; error?: string };
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error ?? "control error"));
    });
  });
}

/** Streaming pair session: opens a window and reports requests until the socket closes. */
export function controlPairSession(
  sockPath: string,
  handlers: { onOpen: (qrText: string, expiresAt: number) => void; onRequest: (phoneFp: string, name: string) => Promise<boolean>; onError: (e: Error) => void },
): { close: () => void } {
  const socket = createConnection(sockPath);
  socket.once("error", handlers.onError);
  socket.once("connect", () => socket.write(`${JSON.stringify({ cmd: "pair-open" })}\n`));
  const rl = createInterface({ input: socket });
  rl.on("line", (line) => {
    const m = JSON.parse(line) as { ok?: boolean; data?: { qrText: string; expiresAt: number }; event?: string; phoneFp?: string; name?: string; error?: string };
    if (m.event === "request" && m.phoneFp) {
      void handlers.onRequest(m.phoneFp, m.name ?? "").then((accept) => socket.write(`${JSON.stringify({ cmd: "confirm", args: { phoneFp: m.phoneFp, accept } })}\n`));
    } else if (m.ok && m.data?.qrText) handlers.onOpen(m.data.qrText, m.data.expiresAt);
    else if (m.ok === false) handlers.onError(new Error(m.error ?? "control error"));
  });
  return { close: () => socket.end() };
}
```

- [ ] **Step 3: Implement `launchd.ts` and `doctor.ts`**

`apps/agent/src/launchd.ts`:
```ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Paths } from "./config.js";

const run = promisify(execFile);
export const LABEL = "dev.bilalahmad.shellbell";
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export function isGlobalInstall(): boolean {
  const entry = process.argv[1] ?? "";
  return !entry.includes("/_npx/") && !entry.includes("/.npm/");
}

export function plistFor(o: { nodePath: string; cliPath: string; logPath: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(o.nodePath)}</string><string>${esc(o.cliPath)}</string><string>start</string><string>--service</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
</dict></plist>
`;
}

export async function install(p: Paths): Promise<string> {
  if (!isGlobalInstall()) throw new Error("`service install` needs a global install: npm i -g shellbell");
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const cliPath = process.argv[1] as string;
  writeFileSync(PLIST, plistFor({ nodePath: process.execPath, cliPath, logPath: p.log }));
  const uid = userInfo().uid;
  await run("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => undefined);
  await run("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  return PLIST;
}

export async function uninstall(): Promise<void> {
  const uid = userInfo().uid;
  await run("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => undefined);
  if (existsSync(PLIST)) unlinkSync(PLIST);
}
```

`apps/agent/src/doctor.ts`:
```ts
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { relayWsUrl } from "@shellbell/protocol";
import WebSocket from "ws";
import type { ITerm2AuthError } from "./backends/iterm2/auth.js";
import { requestCookieAndKey } from "./backends/iterm2/auth.js";
import { DEFAULT_SOCKET } from "./backends/iterm2/client.js";
import type { AgentConfig, Paths } from "./config.js";
import { PLIST } from "./launchd.js";

const run = promisify(execFile);
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Pure: `tmux -V` output -> a comparable number, or null when it is not recognisable. */
export function parseTmuxVersion(stdout: string): number | null {
  const m = /(\d+)\.(\d+)/.exec(stdout);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 100;
}

/** Pure: does this plist point at a node binary that still exists on this machine? */
export function plistNodeOk(plistText: string, execPath: string): boolean {
  return plistText.includes(execPath) || /<string>\/[^<]*node<\/string>/.test(plistText);
}

export async function runDoctor(p: Paths, cfg: AgentConfig): Promise<Check[]> {
  const out: Check[] = [];
  out.push({ name: "identity", ok: existsSync(p.identity), detail: p.identity, fix: "run `shellbell` once" });
  out.push({ name: "iTerm2 API socket", ok: existsSync(DEFAULT_SOCKET), detail: DEFAULT_SOCKET, fix: "iTerm2 → Settings → General → Magic → Enable Python API" });
  try {
    await requestCookieAndKey("Shellbell");
    out.push({ name: "iTerm2 cookie", ok: true, detail: "granted" });
  } catch (err) {
    const e = err as ITerm2AuthError;
    out.push({ name: "iTerm2 cookie", ok: false, detail: e.message, fix: e.kind === "not-running" ? "start iTerm2" : "allow Shellbell in the iTerm2 dialog, or enable “Allow all apps to connect”" });
  }
  try {
    const { stdout } = await run("tmux", ["-V"]);
    const v = parseTmuxVersion(stdout);
    out.push({ name: "tmux", ok: v !== null && v >= 3.02, detail: stdout.trim(), fix: "brew install tmux (3.2+)" });
  } catch {
    out.push({ name: "tmux", ok: false, detail: "not found (optional)", fix: "brew install tmux — needed for Ghostty/Warp/Terminal.app sessions" });
  }
  const url = relayWsUrl(cfg.relayUrl, "a".repeat(26));
  const reachable = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    ws.once("open", () => {
      ws.close();
      resolve(true);
    });
    ws.once("error", () => resolve(false));
  });
  out.push({ name: "relay", ok: reachable, detail: cfg.relayUrl, fix: "check the relay URL (`shellbell config set relay …`) and your network" });
  if (existsSync(PLIST)) {
    const nodeOk = plistNodeOk(readFileSync(PLIST, "utf8"), process.execPath);
    out.push({ name: "LaunchAgent", ok: nodeOk, detail: PLIST, fix: "re-run `shellbell service install` after upgrading Node or Shellbell" });
  }
  return out;
}
```

- [ ] **Step 4: Implement `cli.ts`**

`apps/agent/src/cli.ts`:
```ts
#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { Agent } from "./agent.js";
import { ITerm2Client } from "./backends/iterm2/client.js";
import { ITerm2Backend } from "./backends/iterm2/backend.js";
import { BackendRegistry } from "./backends/registry.js";
import { BackendUnavailable } from "./backends/types.js";
import { ACCENTS, loadConfig, paths, saveConfig, type AgentConfig } from "./config.js";
import { ControlServer, controlPairSession, controlRequest } from "./control.js";
import { runDoctor } from "./doctor.js";
import { loadOrCreateIdentity } from "./identity.js";
import { install, uninstall } from "./launchd.js";
import { createLogger, type Logger } from "./log.js";

const VERSION = "0.1.0";
const program = new Command().name("shellbell").version(VERSION).option("--relay <url>", "override relay url").option("--json", "machine output").option("--verbose", "debug logging");

function ctx() {
  const opts = program.opts<{ relay?: string; json?: boolean; verbose?: boolean }>();
  const p = paths();
  const cfg = loadConfig(p);
  const log = createLogger({ file: p.log, verbose: opts.verbose, stdout: process.stdout.isTTY && !opts.json });
  return { opts, p, cfg, log };
}

const fpShort = (fp: string) => `${fp.slice(0, 4)}-${fp.slice(4, 8)}`;

function askYesNo(question: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const t = setTimeout(() => {
      rl.close();
      console.log("\n  (timed out — declined)");
      resolve(false);
    }, timeoutMs);
    rl.question(question, (a) => {
      clearTimeout(t);
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

function printQr(qrText: string, expiresAt: number, cfg: AgentConfig, fp: string): void {
  qrcode.generate(qrText, { small: true }, (qr) => {
    console.log(`\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n\n  Scan this with the Shellbell app:\n`);
    console.log(qr.split("\n").map((l) => `  ${l}`).join("\n"));
    console.log(`\n  Pairing window closes in ${Math.round((expiresAt - Date.now()) / 60000)} min\n`);
  });
}

async function buildAgent(log: Logger, relayOverride?: string, yes = false) {
  const p = paths();
  const cfg = loadConfig(p);
  const { identity, fp } = loadOrCreateIdentity(p);
  const registry = new BackendRegistry(log);
  const client = new ITerm2Client({ log });
  const iterm = new ITerm2Backend(client, log);
  // ITerm2Backend owns reconnect once it has connected at least once (1 s -> 30 s, spec 8.5.1).
  // The CLI only retries the FIRST connect, which is what fails while iTerm2 is closed or its
  // Python API is off — spec 8.12 says re-detect every 10 s while a backend is absent.
  const firstConnect = async () => {
    try {
      await iterm.connect();
      registry.add(iterm);
      log.info("iTerm2 connected");
    } catch (err) {
      if (err instanceof BackendUnavailable) log.warn(`iTerm2 unavailable: ${err.message}`, { hint: err.hint });
      else log.warn("iTerm2 connect failed", { err: String(err) });
      setTimeout(() => void firstConnect(), 10_000);
    }
  };
  void firstConnect();
  const control = { server: null as ControlServer | null };
  const agent = new Agent({
    paths: p,
    config: cfg,
    identity,
    fp,
    registry,
    log,
    appVersion: VERSION,
    relayUrlOverride: relayOverride,
    confirm: async (phoneFp, name) => {
      if (yes) return true;
      if (control.server && !process.stdin.isTTY) return control.server.pairingConfirm(phoneFp, name);
      return askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000);
    },
  });
  control.server = new ControlServer(p.sock, agent, log);
  return { agent, control: control.server, p, cfg, fp };
}

program
  .command("start", { isDefault: true })
  .description("run the agent in the foreground")
  .option("--service", "running under launchd")
  .action(async (o: { service?: boolean }) => {
    const { opts, log } = ctx();
    const { agent, control, p, cfg, fp } = await buildAgent(log, opts.relay);
    writeFileSync(p.pid, String(process.pid), { mode: 0o600 });
    await control.start();
    agent.start();
    console.log(`\n  Shellbell agent v${VERSION}\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n`);
    if (agent.pairingList.length === 0 && !o.service && process.stdin.isTTY) {
      console.log("  No phones paired yet.");
      const { qrText, expiresAt } = agent.openPairing();
      printQr(qrText, expiresAt, cfg, fp);
    }
    const shutdown = async () => {
      agent.stop();
      await control.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("pair")
  .description("open a 5-minute pairing window and show the QR")
  .option("--yes", "auto-accept requests (unsafe on shared screens)")
  .action(async (o: { yes?: boolean }) => {
    const { opts, p, cfg, log } = ctx();
    const { fp } = loadOrCreateIdentity(p);
    if (existsSync(p.sock)) {
      const session = controlPairSession(p.sock, {
        onOpen: (qrText, expiresAt) => printQr(qrText, expiresAt, cfg, fp),
        onRequest: (phoneFp, name) => (o.yes ? Promise.resolve(true) : askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000)),
        onError: (e) => {
          console.error(`  ${e.message}`);
          process.exit(1);
        },
      });
      setTimeout(() => {
        session.close();
        process.exit(0);
      }, 5 * 60_000 + 1000);
      return;
    }
    const { agent, control } = await buildAgent(log, opts.relay, o.yes);
    await control.start();
    agent.start();
    const { qrText, expiresAt } = agent.openPairing();
    printQr(qrText, expiresAt, cfg, fp);
    setTimeout(async () => {
      agent.stop();
      await control.stop();
      process.exit(0);
    }, 5 * 60_000 + 1000);
  });

program.command("status").description("show agent status").action(async () => {
  const { opts, p } = ctx();
  try {
    const s = await controlRequest(p.sock, "status");
    console.log(opts.json ? JSON.stringify(s) : JSON.stringify(s, null, 2));
  } catch {
    console.log(opts.json ? JSON.stringify({ running: false }) : "  agent not running");
  }
});

program.command("devices").description("list paired phones").action(async () => {
  const { opts, p } = ctx();
  try {
    const d = await controlRequest(p.sock, "devices");
    console.log(opts.json ? JSON.stringify(d) : JSON.stringify(d, null, 2));
  } catch {
    console.log("  agent not running");
  }
});

program.command("unpair <target>").description("remove a paired phone (fp prefix or name)").action(async (target: string) => {
  const { p } = ctx();
  try {
    const r = (await controlRequest(p.sock, "unpair", { target })) as { removed: boolean };
    console.log(r.removed ? "  removed" : "  no such phone");
  } catch {
    console.log("  agent not running");
  }
});

const service = program.command("service").description("manage the LaunchAgent");
service.command("install").action(async () => {
  const { p } = ctx();
  try {
    console.log(`  installed ${await install(p)}`);
  } catch (e) {
    console.error(`  ${(e as Error).message}`);
    process.exit(2);
  }
});
service.command("uninstall").action(async () => {
  await uninstall();
  console.log("  uninstalled");
});

program.command("logs").option("-f, --follow").description("show the agent log").action((o: { follow?: boolean }) => {
  const { p } = ctx();
  if (o.follow) spawn("tail", ["-f", p.log], { stdio: "inherit" });
  else if (existsSync(p.log)) process.stdout.write(readFileSync(p.log, "utf8").split("\n").slice(-200).join("\n"));
});

program.command("config").description("config set relay <url> | name <name> | accent <color>").argument("<op>").argument("<key>").argument("<value>").action((op: string, key: string, value: string) => {
  const { p, cfg } = ctx();
  if (op !== "set") return void console.error("  usage: shellbell config set <relay|name|accent> <value>");
  if (key === "relay") saveConfig(p, { ...cfg, relayUrl: value });
  else if (key === "name") saveConfig(p, { ...cfg, computerName: value });
  else if (key === "accent" && (ACCENTS as readonly string[]).includes(value)) saveConfig(p, { ...cfg, accent: value });
  else return void console.error(`  unknown key ${key} (accent must be one of ${ACCENTS.join(", ")})`);
  console.log("  saved");
});

program.command("doctor").description("check the local setup").action(async () => {
  const { p, cfg, opts } = ctx();
  const checks = await runDoctor(p, cfg);
  if (opts.json) return void console.log(JSON.stringify(checks));
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(18)} ${c.detail}${c.ok || !c.fix ? "" : `\n      fix: ${c.fix}`}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
});

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Build config and README**

`apps/agent/tsdown.config.ts`:
```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Bundle the workspace package AND its own deps: cborg / @noble/* are NOT runtime deps of the
  // published `shellbell` tarball, so leaving them external produces a dist/cli.js that imports
  // packages nobody installs. `zod` stays external because it IS a declared runtime dep.
  noExternal: [/^@shellbell\//, "cborg", /^@noble\//],
  external: ["ws", "@bufbuild/protobuf", "commander", "qrcode-terminal", "zod"],
  banner: { js: "#!/usr/bin/env node" },
});
```
(If `tsdown` rejects `banner`, drop it — `src/cli.ts` already starts with the shebang and tsdown preserves it.)

After building, verify nothing leaked: `node -e "const s=require('node:fs').readFileSync('dist/cli.js','utf8'); for (const m of s.matchAll(/from\s*[\"']([^.\"'][^\"']*)[\"']/g)) console.log(m[1])" | sort -u`
must print only `ws`, `@bufbuild/protobuf`, `commander`, `qrcode-terminal`, `zod` and `node:*` builtins.

`apps/agent/README.md`:
```markdown
# shellbell

Your terminal rings. You answer. — Mac agent for [Shellbell](https://github.com/Miambi/shellbell).

    npx shellbell            # start, print a QR, scan it with the Shellbell app
    shellbell pair           # open a new pairing window
    shellbell status | devices | unpair <phone> | doctor
    npm i -g shellbell && shellbell service install   # run at login

Requires macOS, Node 22+, and iTerm2 with the Python API enabled (Settings → General →
Magic) and/or tmux 3.2+. Everything between your phone and this agent is end-to-end
encrypted; the relay only routes ciphertext.
```

- [ ] **Step 6: Run tests and build**

Run: `pnpm test && pnpm build && node dist/cli.js --help`
Expected: tests green; `dist/cli.js` exists and prints help. `--help` touches nothing outside the process.

- [ ] **Step 7: Smoke `doctor` — Human-run only**

**Implementers skip this step and report it as "not run (human-run only)".** `shellbell doctor`
runs `osascript ... request cookie and key`, which pops iTerm2's consent dialog; the M0 spike
recorded unattended runs hanging for the full ~120 s AppleEvent timeout and then failing with
`-1712`. It also shells out to `tmux -V` and opens a real WebSocket to the production relay,
and it exits `1` whenever any check fails — so it can neither be automated nor chained with `&&`.

A human runs `node dist/cli.js doctor` and expects a list of checks (the relay check may fail
until Plan 02 is deployed — that is fine).

- [ ] **Step 8: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): control socket, CLI, LaunchAgent, doctor, tsdown build"
```

---

### Task 12: Live iTerm2 integration test (spec 15)

**Files:**
- Create: `apps/agent/test/live-iterm2.test.ts`

- [ ] **Step 1: Write the env-gated test**

```ts
import { describe, expect, it } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import { ITerm2Client } from "../src/backends/iterm2/client.js";
import { createLogger } from "../src/log.js";

describe.skipIf(!process.env.SHELLBELL_LIVE)("live iTerm2", () => {
  it("lists sessions, reads a styled screen, sends text and sees it", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const client = new ITerm2Client({ log });
    const b = new ITerm2Backend(client, log);
    await b.connect();
    const sessions = await b.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const s = sessions[0] as (typeof sessions)[number];
    const before = await b.getScreen(s.id);
    expect(before.rows).toBe(s.rows);
    await b.sendText(s.id, "echo shellbell-live-ok\r");
    await new Promise((r) => setTimeout(r, 700));
    const after = await b.getScreen(s.id);
    const text = after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text).toContain("shellbell-live-ok");
    await b.close();
  }, 20_000);
});
```

- [ ] **Step 2: Run it once for real — Human-run only**

**Implementers skip this step and report it as "not run (human-run only)".** The test needs a real
iTerm2 with the Python API enabled, triggers `osascript ... request cookie and key` (the M0 spike
recorded unattended runs hanging ~120 s and failing `-1712` until a human clicked Allow), and it
**types into the operator's first live iTerm2 session** — which the spike showed can be a TUI, not
a shell.

A human runs: `SHELLBELL_LIVE=1 pnpm vitest run test/live-iterm2.test.ts`
Expected: PASS, and `shellbell-live-ok` appears in the first iTerm2 session.
Without `SHELLBELL_LIVE` the suite is skipped, so `pnpm test` in CI is unaffected.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/test/live-iterm2.test.ts
git commit -m "test(agent): env-gated live iTerm2 integration"
```

---

## Plan self-review

- **Spec coverage:** 8.2/8.3/8.10 → Task 1; 6.5 + 8.7 relay side → Task 2; 6.6 (incl. the 10 s `conn.hello` timeout)/6.7 + 7.4 dedupe → Task 3; 8.5.1 → Task 4; 8.4 (`types.ts`) + 8.5.5 → Task 5; 8.5.1 step 4 reconnect + 8.5.3/8.5.4/8.5.6 → Task 6; 8.6 → Task 7; 8.8 → Task 8; 6.4 agent side incl. confirmation and 3-failure close → Task 9; 8.12 (iTerm2 half; tmux in Plan 04), 4.2–4.4, 7.4 inputs/acks/at-most-once, `unpaired`→`pairings-sync` ordering, events to all phones → Task 10; 8.1/8.9/16 CLI, control socket, launchd, doctor, build → Task 11; 15 live test → Task 12.
- **Type consistency:** `TerminalBackend` (Task 5's `types.ts`) is what `FakeBackend` (Task 7), `ITerm2Backend` (Task 6) and `BackendRegistry` (Task 10) implement; `Screen` is defined **once**, in `types.ts`, and imported by `convert.ts` — there is no second `ScreenShape`; `Ring` from `events.ts` is consumed by `Notifier`; `PhoneLink.send` returns boolean and `Agent.sendTo` ignores it deliberately; `ControlServer.pairingConfirm` has the same signature as `AgentOptions.confirm`; `StatusData` matches what `cli.ts status` prints; `waitFor` is defined once in `test/fakes/wait.ts`.
- **Placeholders:** none. `ITerm2Client` has a single connect mode (the `createConnection` hook settled by the M0 spike); `VERSION` in `cli.ts` is bumped by Changesets in Plan 06.
- **Generated protobuf identifiers** used by Tasks 4–6 were each checked against `apps/agent/src/backends/iterm2/gen/iterm2_pb.ts`: protobuf-es v2 names a **nested** message `Outer_InnerSchema` and strips the enum-name prefix from enum members, but `PromptNotificationCommandStart`/`CommandEnd` are **top-level** messages in `proto/iterm2.proto`, so they are `PromptNotificationCommandEndSchema` (no underscore). Verified present: `ClientOriginatedMessageSchema`, `ServerOriginatedMessageSchema`, `ListSessionsRequest/ResponseSchema`, `ListSessionsResponse_Window/_TabSchema`, `SplitTreeNodeSchema`, `SplitTreeNode_SplitTreeLinkSchema`, `SessionSummarySchema`, `SizeSchema`, `GetBufferRequest/ResponseSchema`, `LineRangeSchema`, `Coord/CoordRange/WindowedCoordRangeSchema`, `LineContentsSchema`, `CellStyleSchema`, `CodePointsPerCellSchema`, `RGBColorSchema`, `NotificationSchema`, `ScreenUpdateNotificationSchema`, `PromptNotificationSchema`, `PromptNotificationCommandEndSchema`, `NotificationRequest/ResponseSchema`, `PromptMonitorRequestSchema`, `VariableMonitorRequestSchema`, `VariableRequest/ResponseSchema`, `FocusRequest/ResponseSchema`, `FocusChangedNotificationSchema`, `SendTextRequest/ResponseSchema`, `CreateTabRequestSchema`, `SplitPaneRequestSchema`, `ActivateRequestSchema`, `ActivateRequest_AppSchema`. Enum members verified: `LineContents_Continuation.SOFT_EOL` / `.HARD_EOL`, `AlternateColor.DEFAULT`, `NotificationType.NOTIFY_ON_{SCREEN_UPDATE,PROMPT,NEW_SESSION,TERMINATE_SESSION,LAYOUT_CHANGE,FOCUS_CHANGE,VARIABLE_CHANGE}`, `PromptMonitorMode.{PROMPT,COMMAND_START,COMMAND_END}`, `VariableScope.SESSION`, `SplitPaneRequest_SplitDirection.{VERTICAL,HORIZONTAL}`.

---

## Pre-execution corrections (2026-09-05)

A pre-flight consistency scan (`.superpowers/sdd/2026-09-03-shellbell-03-agent/preflight-scan.md`)
checked this plan against the shipped `packages/protocol`, the shipped `apps/relay/src/computer-do.ts`,
the generated `apps/agent/src/backends/iterm2/gen/iterm2_pb.ts`, `docs/spike-iterm2.md`, and the
errata of Plans 01 and 02. The plan text above has been corrected in place. What changed and why:

**Blocking defects (would have stopped a task at "run the tests"):**

- **B1 · Task 4 — iTerm2 connect.** The plan defaulted to `connectMode: "unix-url"` and offered
  `socketPath` as the alternative. `docs/spike-iterm2.md` and Plan 01's errata record that *both*
  are dead in `ws@8.21.3` (`%20` in "Application Support" is never decoded; `initAsClient` resets
  `opts.socketPath = undefined`). Replaced with the single `createConnection: () => netConnect({ path })`
  mode the shipped spike uses; `connectMode` deleted; a Unix-socket test added so the TCP-only tests
  can no longer hide it.
- **B2 · Tasks 5 — `LineContents_Continuation.CONTINUATION_SOFT_EOL` does not exist.** protobuf-es v2
  strips the enum-name prefix; the member is `SOFT_EOL`. Fixed in `convert.ts` and its test.
- **B3 · Task 6 — `PromptNotification_CommandEndSchema` does not exist.** `PromptNotificationCommandEnd`
  is a top-level message in `proto/iterm2.proto`, so the export is `PromptNotificationCommandEndSchema`.
- **B4 · Task 5 — convert expectations contradicted shipped `trimTrailing`.** A trailing space-only
  run with no `bg` is popped by `screen.ts`, so the "invisible becomes spaces" case could never have
  produced three runs. Split into two cases: one with a following character (run survives) and one
  where it is last (run is dropped).
- **B5 · Task 7 — the ScreenTracker never became dirty.** It did not subscribe to the backend, and
  the tests only mutated the fake backend, so five of seven tracker tests asserted a second frame
  that could not exist. `start()` now subscribes and marks dirty on `screen-changed` / drops state on
  `session-removed`; the tests also call `markDirty` explicitly, and a new test proves the
  subscription alone is sufficient.
- **B6 · Task 10 — `registry.test.ts` did not typecheck.** It assigned `tmuxWindowIds` /
  `tmuxWindowIdOf` onto a `FakeBackend` that declared neither (TS2339), via an `Object.assign`
  name-override that types `name` as `never`. `FakeBackend` now declares both as optional properties
  and takes its `name` as a constructor argument.
- **B7 · Task 1 — undeclared dependencies.** `@shellbell/protocol` and `zod` are imported from Task 1
  onward but were never added to `apps/agent/package.json`; the plan was relying on pnpm hoisting.
  Both are now added explicitly.
- **B8 · Task 8 — the idle-dedupe test was unsatisfiable.** `advance(11_000)` ran the 1 s sweep
  *before* `command-end`, so an idle ring legitimately fired first. The helper now has `jump` (move
  the clock without sweeping) and the test uses it, then verifies the dedupe on the tick after the
  prompt ring. The ring rule is stated explicitly in the task's Interfaces.
- **B9 · Task 10 — the integration test died on its second line.** It called `parseQr(qrText)` on a
  QR whose `r` is the fake relay's `ws://127.0.0.1:<port>`; shipped `parseQr` rejects non-`wss://`.
  It now passes `{ allowInsecure: true }`, which the protocol package already supports — the protocol
  package itself is unchanged.

**Rulings applied on top:**

- **9 · `minFrameMs`.** The `Agent` ignored it, so the plan's own "flush interval `max(125, minFrameMs)`"
  constraint was unimplemented. Every `auth-ok` now calls `tracker.setIntervalMs(Math.max(125, minFrameMs))`,
  asserted in the integration test.
- **10 · Agent socket budget (Plan 02 parked item).** `maxFramesPerSecond` was a *per-viewer* cap, which
  does not bound the agent's single relay socket (60 msg/s, close `4429`): 8 viewers at 8 fps = 64 msg/s.
  It is now one global token bucket over every `sink` call, with per-viewer coalescing; a new test drives
  10 viewers and asserts ≤ 40 sink calls per second.
- **11 · Links keyed by `connId`** (spec 6.6, 8.7, §12) with a `connByFp` side index, because `e2e`
  envelopes carry only the phone fp. `phone-disconnected` removes by `connId`.
- **12 · `bad-window`.** A mismatched `windowId` threw a bare `Error`, which the `Agent` mapped to
  `ack.error: "failed"`. A typed `BadWindow` error now maps to `ack.error: "bad-window"` exactly as
  spec 8.12 requires. (`pairing-reject` was *not* used for this: `bad-window` is an inner `ack` on
  `session.create`, not a pairing ctrl, and `ack.error` is a free-form string in the shipped schema.)
- **13 · `conn.hello` 10 s timeout.** `PhoneLink` stamps `openedAt` and exposes `helloOverdue(now)`;
  the `Agent`'s 1 s tick logs once and marks the link `dormant`, which a late `conn.hello` clears. The
  socket is never closed — the relay owns it.
- **14 · Missing spec-§15 tests added:** global 40 fps cap, `degraded` catch-up frame, `event` fan-out
  to every handshaken link, registry isolation (one backend failing does not affect the other), and the
  `unpaired` → `pairings-sync` ordering test that Plan 02 parked for this plan. iTerm2 reconnect with
  1→30 s backoff added to Task 6 with a fake-timer test.
- **15 · Rubric fixes:** the tautological fixture assertion (`expect(x).toBe(x)`) replaced with five real
  invariants; the `unpair` test now asserts what its title promises (removed, persisted, link dropped,
  relay told); `Screen` defined once (`types.ts` moved into Task 5) instead of duplicated as `ScreenShape`;
  `waitFor` defined once in `test/fakes/wait.ts`; the "write this, then replace it" dynamic-import note in
  Task 10 removed in favour of the final code; the unused `CtrlMessageOf` import and the never-read
  `awaitingUnpaired` field removed; the whole pairing dance in the integration test factored into one
  `pairAndConnect()` helper; pure tests added for `plistFor`, `parseTmuxVersion` and `plistNodeOk`.
- **16 · Hazards.** Task 11's smoke step is split: the automated half is `pnpm test && pnpm build &&
  node dist/cli.js --help`, and `doctor` (osascript consent, production relay, `exit 1`) is a new
  **Human-run only** step. Task 12's live test is gated on `SHELLBELL_LIVE`. Global Constraints now say
  implementers never run Human-run-only steps.
- **17 · Housekeeping.** README repo link corrected to `https://github.com/Miambi/shellbell` (Plan 02
  errata). Global Constraints note that plan code blocks may exceed Biome's 100-column limit and that
  implementers wrap with `pnpm lint:fix` without changing semantics.

**Deliberately deferred (not defects in this plan):**

- The `ws://localhost:1912` TCP fallback for the iTerm2 API (spec 8.5.1 step 2) is **not** built here;
  it is deferred to Plan 06. The socket path is the only supported transport in v1.
- Spec 8.12's "a change in the connected backend set triggers a new `hello`" is not implemented: the
  `Agent` sends `hello` once per handshake and re-broadcasts `sessions` on every layout change. Phones
  therefore learn about a backend appearing or disappearing through `sessions`, not `hello`. Revisit in
  Plan 04, when tmux makes the backend set actually dynamic.
- The `ScreenTracker` still drops a session locally when `getScreen` throws without asking the `Agent` to
  re-broadcast `sessions` (spec 8.6, last bullet). The next layout event corrects it.
- The `FakeRelay` does not model gate validation, the one-`pairing-request`-per-socket rule, the
  post-reject socket close, the 5-admission cap, or the token bucket. Those are covered by the relay's
  own tests in Plan 02; the limits are written down in Task 2's Interfaces so nobody mistakes the double
  for the real thing.
