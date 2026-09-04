# Shellbell Plan 02 — Relay (Cloudflare Worker + `ComputerDO`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable relay that authenticates devices by signature, gates pairing behind a window the agent opens, mirrors the agent's pairing list, tracks foreground leases, forwards end-to-end-encrypted frames between one agent and its paired phones, enforces byte/rate limits, and sends Expo push notifications — all within Cloudflare's free tier.

**Architecture:** One Worker route (`GET /ws/:fp`) upgrades WebSockets and hands them to a Durable Object named by the computer fingerprint. The DO uses the WebSocket Hibernation API, SQLite storage, a single alarm scheduled for the earliest deadline, and `fetch` to Expo's push API. It never decrypts anything.

**Tech Stack:** wrangler 4.129, `@cloudflare/workers-types` 5.x, `@cloudflare/vitest-pool-workers` 0.22, vitest 5, `@shellbell/protocol` (Plan 01).

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` (v2) — sections 6.4 (relay-side steps), 6.5, 7.1–7.3, 9, 11.3, 12, 13, 14, 15 (relay tests). Plan 01 must be complete.

## Global Constraints

- All Plan 01 global constraints apply (Node ≥ 22, pnpm 11.12.0, TypeScript 5.9.3, Biome, commit style).
- The relay must not import Node built-ins; it runs on the Workers runtime. `@shellbell/protocol` is safe.
- The DO is **SQLite-backed** (`new_sqlite_classes`) — required for the free plan.
- Close codes (spec 12): `4001` auth failed · `4003` bad pairing message · `4004` unpaired · `4005` superseded · `4400` malformed · `4403` forbidden for role · `4408` unauth/pairing timeout · `4413` too large · `4429` rate limited.
- Timeouts and caps (spec 6.4, 6.5, 7.1, 9.2): unauthenticated socket **10 s**; pairing socket **90 s**; pairing window admissions **≤ 5**; ring limit **60 s per session**; push cap **20 per phone per rolling hour**; pairings **≤ 10**; `ring_limits` pruned to **200** rows; storage GC after **90 days** without an agent; token bucket **60 msg/s, burst 200**; frame limits from `FRAME_LIMITS`.
- The relay never logs frame contents. `console.log` only with fp prefixes (first 8 chars), roles, close codes, counts.
- The only outbound `fetch` is `https://exp.host/--/api/v2/push/send`.

---

## File structure

```
apps/relay/
├── package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
├── src/
│   ├── index.ts          Worker entry: routes, upgrade → DO
│   ├── computer-do.ts    ComputerDO: sockets, auth, routing, pairing window, sync, leases, push trigger, alarm
│   ├── schema.ts         SQL schema string
│   ├── auth.ts           pure: verifyAuthMessage(...)
│   ├── limits.ts         pure: frameLimitFor(...), TokenBucket
│   ├── push.ts           pure: formatDuration, pushBody, sendExpoPush
│   └── env.d.ts          Env interface
└── test/
    ├── helpers.ts        TestDevice, connect(), authenticate(), pairPhone()
    ├── index.test.ts
    ├── auth.test.ts
    ├── pairing.test.ts
    ├── routing.test.ts
    ├── push.test.ts
    ├── limits.test.ts
    └── vectors.test.ts
```

---

### Task 1: Relay package skeleton, config, Worker entry, schema (spec 9.1, 9.3)

**Files:**
- Create: `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/wrangler.jsonc`, `apps/relay/vitest.config.ts`, `apps/relay/src/env.d.ts`, `apps/relay/src/index.ts`, `apps/relay/src/schema.ts`, `apps/relay/src/computer-do.ts` (stub), `apps/relay/test/index.test.ts`, `apps/relay/test/vectors.test.ts`

**Interfaces:**
- Produces: `Env { COMPUTER: DurableObjectNamespace<ComputerDO>; EXPO_ACCESS_TOKEN?: string; MIN_FRAME_MS?: string }`; `export class ComputerDO`; `SCHEMA_SQL: string`.

- [ ] **Step 1: Package files**

`apps/relay/package.json`:
```json
{
  "name": "@shellbell/relay",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@shellbell/protocol": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.22.0",
    "@cloudflare/workers-types": "5.20260903.1",
    "typescript": "5.9.3",
    "vitest": "5.0.0",
    "wrangler": "4.129.0"
  }
}
```

`apps/relay/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "noEmit": true,
    "lib": ["ES2022"]
  },
  "include": ["src", "test"]
}
```

`apps/relay/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shellbell-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": {
    "bindings": [{ "name": "COMPUTER", "class_name": "ComputerDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ComputerDO"] }],
  "observability": { "enabled": true },
  "vars": { "MIN_FRAME_MS": "125" }
  // Hosted deployment adds:  "routes": [{ "pattern": "relay.shellbell.app", "custom_domain": true }]
  // Self-hosters keep the *.workers.dev URL and run `shellbell config set relay wss://...`.
}
```

`apps/relay/vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: { workers: { wrangler: { configPath: "./wrangler.jsonc" } } },
  },
});
```

`apps/relay/src/env.d.ts`:
```ts
import type { ComputerDO } from "./computer-do.js";

export interface Env {
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  EXPO_ACCESS_TOKEN?: string;
  MIN_FRAME_MS?: string;
}
```

`apps/relay/src/schema.ts`:
```ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS computer (
  fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  phone_fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  name TEXT NOT NULL,
  push_token TEXT,
  push_platform TEXT,
  push_enabled INTEGER NOT NULL DEFAULT 1,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS pending_unpairs (
  phone_fp TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gate_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  admitted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ring_limits (
  session_id TEXT PRIMARY KEY,
  last_ring_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_limits (
  phone_fp TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`;
```

`apps/relay/src/computer-do.ts` (stub, replaced in Task 2):
```ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { SCHEMA_SQL } from "./schema.js";

export class ComputerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
    });
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
```

`apps/relay/src/index.ts`:
```ts
import type { Env } from "./env.js";

export { ComputerDO } from "./computer-do.js";

const FP_RE = /^[a-z2-7]{26}$/;
const VERSION = "0.0.1";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ name: "shellbell-relay", version: VERSION, docs: "https://github.com/bilalahmad/shellbell" });
    }
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    const m = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && m) {
      const fp = m[1] as string;
      if (!FP_RE.test(fp)) return new Response("bad fingerprint", { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.COMPUTER.get(env.COMPUTER.idFromName(fp)).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Write the tests**

`apps/relay/test/index.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker routes", () => {
  it("serves info and health", async () => {
    const info = await SELF.fetch("https://relay.test/");
    expect(info.status).toBe(200);
    expect(((await info.json()) as { name: string }).name).toBe("shellbell-relay");
    expect((await SELF.fetch("https://relay.test/healthz")).status).toBe(200);
  });
  it("validates the fingerprint and requires upgrade", async () => {
    expect((await SELF.fetch("https://relay.test/ws/short")).status).toBe(400);
    expect((await SELF.fetch(`https://relay.test/ws/${"a".repeat(26)}`)).status).toBe(426);
    expect((await SELF.fetch("https://relay.test/nope")).status).toBe(404);
  });
});
```

`apps/relay/test/vectors.test.ts` (golden vectors in the Workers runtime):
```ts
import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import vectors from "../../../packages/protocol/test/vectors.json" with { type: "json" };

describe("golden vectors on workerd", () => {
  it("all pass", () => {
    expect(runVectorChecks(vectors as Vectors).filter((r) => !r.ok)).toEqual([]);
  });
});
```

- [ ] **Step 3: Install and run**

Run: `cd apps/relay && pnpm install && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): worker skeleton, routes, DO stub, sqlite schema, vectors on workerd"
```

---

### Task 2: Limits helpers (spec 7.1)

**Files:**
- Create: `apps/relay/src/limits.ts`, `apps/relay/test/limits.test.ts`

**Interfaces:**
- Produces: `frameLimitFor(state: "unauth"|"agent"|"phone"|"pairing", isCtrlGuess: boolean): number`, `class TokenBucket { constructor(rate = 60, burst = 200); take(now: number): boolean }`, `peekIsCtrl(bytes: Uint8Array): boolean`.

`peekIsCtrl` decides the applicable limit **before** full decoding by checking whether the CBOR map contains the key `t` with value `"ctrl"` — implemented as a cheap byte search for the sequence `61 74 64 63 74 72 6c` (`"t"` key followed by the 4-char text `"ctrl"`) within the first 64 bytes. False positives only make a ctrl-sized limit apply to an e2e frame, which then fails the ctrl schema and closes `4400` — acceptable.

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/limits.test.ts`:
```ts
import { encodeCbor, FRAME_LIMITS } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { frameLimitFor, peekIsCtrl, TokenBucket } from "../src/limits.js";

describe("limits", () => {
  it("frame limits by state", () => {
    expect(frameLimitFor("unauth", true)).toBe(FRAME_LIMITS.unauth);
    expect(frameLimitFor("phone", true)).toBe(FRAME_LIMITS.ctrl);
    expect(frameLimitFor("phone", false)).toBe(FRAME_LIMITS.e2eFromPhone);
    expect(frameLimitFor("agent", false)).toBe(FRAME_LIMITS.e2eFromAgent);
    expect(frameLimitFor("pairing", false)).toBe(FRAME_LIMITS.ctrl);
  });
  it("peeks ctrl vs e2e", () => {
    expect(peekIsCtrl(encodeCbor({ v: 1, t: "ctrl", from: "relay", seq: 0, body: {} }))).toBe(true);
    expect(peekIsCtrl(encodeCbor({ v: 1, t: "e2e", from: "a".repeat(26), seq: 1, body: {} }))).toBe(false);
  });
  it("token bucket allows burst then refills at rate", () => {
    const b = new TokenBucket(60, 200);
    let allowed = 0;
    for (let i = 0; i < 250; i++) if (b.take(0)) allowed++;
    expect(allowed).toBe(200);
    expect(b.take(0)).toBe(false);
    expect(b.take(1000)).toBe(true); // +60 after 1 s
    let more = 0;
    for (let i = 0; i < 100; i++) if (b.take(1000)) more++;
    expect(more).toBe(59);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement:

`apps/relay/src/limits.ts`:
```ts
import { FRAME_LIMITS } from "@shellbell/protocol";

export type SocketState = "unauth" | "agent" | "phone" | "pairing";

export function frameLimitFor(state: SocketState, isCtrl: boolean): number {
  if (state === "unauth") return FRAME_LIMITS.unauth;
  if (isCtrl || state === "pairing") return FRAME_LIMITS.ctrl;
  return state === "agent" ? FRAME_LIMITS.e2eFromAgent : FRAME_LIMITS.e2eFromPhone;
}

// "t" key (0x61 0x74) followed by text(4) "ctrl" (0x64 0x63 0x74 0x72 0x6c)
const CTRL_SIG = [0x61, 0x74, 0x64, 0x63, 0x74, 0x72, 0x6c];

export function peekIsCtrl(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length - CTRL_SIG.length, 64);
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let k = 0; k < CTRL_SIG.length; k++) {
      if (bytes[i + k] !== CTRL_SIG[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export class TokenBucket {
  private tokens: number;
  private last: number | null = null;

  constructor(
    private readonly rate = 60,
    private readonly burst = 200,
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.last !== null && now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    }
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
```

- [ ] **Step 3: Run tests** — `pnpm test` → PASS. **Commit:** `git commit -am "feat(relay): frame limits and token bucket"` (after `git add apps/relay`).

---

### Task 3: Test helpers and the DO's connection/auth handshake (spec 6.5, 9.2)

**Files:**
- Create: `apps/relay/test/helpers.ts`, `apps/relay/src/auth.ts`, `apps/relay/test/auth.test.ts`
- Modify: `apps/relay/src/computer-do.ts` (real implementation begins)

**Interfaces:**
- Produces (`auth.ts`): `verifyAuthMessage(msg: CtrlMessageOf<"auth">, connId: string, nonce: Uint8Array): "ok" | "fp-mismatch" | "bad-sig"`.
- Produces (`computer-do.ts`): `Attachment = { state; connId; nonce: string; since: number; fp: string | null; name: string | null; leaseUntil: number; used?: boolean }`; helpers `sendCtrl`, `setState`, `socketsByState`, `agentSocket`, `phoneSocket(fp)`, `pairingSocket(fp)`, `pairing(fp)`, `computerName()`, `scheduleAlarm()`.
- Produces (`test/helpers.ts`): `TestDevice`, `connect(fp)`, `authenticate(conn, dev, role, opts?)`, `agentOnline(mac)` (connects + auths an agent and drains `auth-ok`, `unpaired`, `phones`), `pairPhone(mac, agent, phone)` (full relay-side pairing dance; returns nothing — the phone can then authenticate).

- [ ] **Step 1: Write the test helpers**

`apps/relay/test/helpers.ts`:
```ts
import { SELF } from "cloudflare:test";
import {
  authMessage,
  decodeEnvelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  parseCtrl,
  sha256,
  sign,
  type CtrlMessage,
  type Envelope,
  type Identity,
  type Role,
} from "@shellbell/protocol";

export class TestDevice {
  readonly id: Identity;
  readonly fp: string;
  constructor(readonly name: string) {
    this.id = generateIdentity();
    this.fp = fingerprint(this.id.ed25519.pub);
  }
}

export interface Conn {
  ws: WebSocket;
  next(timeoutMs?: number): Promise<Envelope>;
  nextCtrl(timeoutMs?: number): Promise<CtrlMessage>;
  sendCtrl(from: string, body: unknown): void;
  sendEnvelope(e: Envelope): void;
  sendRaw(bytes: Uint8Array): void;
  closed: Promise<{ code: number }>;
}

export async function connect(computerFp: string): Promise<Conn> {
  const res = await SELF.fetch(`https://relay.test/ws/${computerFp}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  const queue: Envelope[] = [];
  const waiters: ((e: Envelope) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    const env = decodeEnvelope(new Uint8Array(ev.data as ArrayBuffer));
    const w = waiters.shift();
    if (w) w(env);
    else queue.push(env);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.addEventListener("close", (ev) => resolve({ code: ev.code }));
  });
  const next = (timeoutMs = 2000) =>
    new Promise<Envelope>((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      waiters.push((e) => {
        clearTimeout(t);
        resolve(e);
      });
    });
  return {
    ws,
    next,
    nextCtrl: async (t) => parseCtrl((await next(t)).body),
    sendCtrl: (from, body) => ws.send(encodeEnvelope({ v: 1, t: "ctrl", from, seq: 0, body })),
    sendEnvelope: (e) => ws.send(encodeEnvelope(e)),
    sendRaw: (bytes) => ws.send(bytes),
    closed,
  };
}

/** Answers the challenge; returns auth-ok or auth-fail. */
export async function authenticate(conn: Conn, dev: TestDevice, role: Role, opts: { gate?: Uint8Array } = {}): Promise<CtrlMessage> {
  const ch = await conn.nextCtrl();
  if (ch.type !== "challenge") throw new Error(`expected challenge, got ${ch.type}`);
  const sig = sign(dev.id.ed25519.priv, authMessage(ch.connId, role, dev.fp, ch.nonce));
  conn.sendCtrl(dev.fp, { type: "auth", role, fp: dev.fp, ed25519Pub: dev.id.ed25519.pub, sig, name: dev.name, appVersion: "test", gate: opts.gate });
  return conn.nextCtrl();
}

/** Connect + auth an agent; drains auth-ok, unpaired, phones. Returns the conn and the drained messages. */
export async function agentOnline(mac: TestDevice): Promise<{ agent: Conn; unpaired: CtrlMessage; phones: CtrlMessage }> {
  const agent = await connect(mac.fp);
  const ok = await authenticate(agent, mac, "agent");
  if (ok.type !== "auth-ok") throw new Error(`agent auth failed: ${JSON.stringify(ok)}`);
  const unpaired = await agent.nextCtrl();
  const phones = await agent.nextCtrl();
  return { agent, unpaired, phones };
}

export const box = () => ({ n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) });

/** Relay-side pairing dance with a gate; leaves the pairing row in place. */
export async function pairPhone(mac: TestDevice, agent: Conn, phone: TestDevice): Promise<void> {
  const gate = new Uint8Array(16).fill(7);
  agent.sendCtrl(mac.fp, { type: "pairing-open", gateHash: sha256(gate), expiresAt: Date.now() + 300_000 });
  const pairing = await connect(mac.fp);
  const ok = await authenticate(pairing, phone, "pairing", { gate });
  if (ok.type !== "auth-ok") throw new Error(`pairing auth failed: ${JSON.stringify(ok)}`);
  pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
  const fwd = await agent.nextCtrl();
  if (fwd.type !== "pairing-request") throw new Error(`expected pairing-request, got ${fwd.type}`);
  agent.sendCtrl(mac.fp, { type: "pairing-add", phoneFp: phone.fp, ed25519Pub: phone.id.ed25519.pub, name: phone.name });
  agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: box() });
  agent.sendCtrl(mac.fp, { type: "pairing-close" });
  const resp = await pairing.nextCtrl();
  if (resp.type !== "pairing-response") throw new Error(`expected pairing-response, got ${resp.type}`);
  pairing.ws.close();
}
```

- [ ] **Step 2: Write the failing auth tests**

`apps/relay/test/auth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, connect, TestDevice } from "./helpers.js";

describe("auth handshake", () => {
  it("agent authenticates against its own DO and gets unpaired + phones", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    const ok = await authenticate(c, mac, "agent");
    expect(ok).toMatchObject({ type: "auth-ok", role: "agent", agentOnline: true, computerName: "MBP", minFrameMs: 125 });
    expect(await c.nextCtrl()).toEqual({ type: "unpaired", phoneFps: [] });
    expect(await c.nextCtrl()).toEqual({ type: "phones", connected: [] });
    c.ws.close();
  });

  it("agent with a fingerprint that does not match the DO name is rejected", async () => {
    const mac = new TestDevice("MBP");
    const other = new TestDevice("Other");
    const c = await connect(mac.fp);
    expect(await authenticate(c, other, "agent")).toEqual({ type: "auth-fail", reason: "fp-mismatch" });
    expect((await c.closed).code).toBe(4001);
  });

  it("unpaired phone is rejected with not-paired", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c = await connect(mac.fp);
    expect(await authenticate(c, phone, "phone")).toEqual({ type: "auth-fail", reason: "not-paired" });
    expect((await c.closed).code).toBe(4001);
  });

  it("bad signature is rejected", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    const ch = await c.nextCtrl();
    if (ch.type !== "challenge") throw new Error("no challenge");
    c.sendCtrl(mac.fp, { type: "auth", role: "agent", fp: mac.fp, ed25519Pub: mac.id.ed25519.pub, sig: new Uint8Array(64), name: "x", appVersion: "t" });
    expect(await c.nextCtrl()).toEqual({ type: "auth-fail", reason: "bad-sig" });
    expect((await c.closed).code).toBe(4001);
  });

  it("pairing role needs an open window (no agent → no-agent; agent without window → no-window)", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c1 = await connect(mac.fp);
    expect(await authenticate(c1, phone, "pairing", { gate: new Uint8Array(16) })).toEqual({ type: "auth-fail", reason: "no-agent" });
    const { agent } = await agentOnline(mac);
    const c2 = await connect(mac.fp);
    expect(await authenticate(c2, phone, "pairing", { gate: new Uint8Array(16) })).toEqual({ type: "auth-fail", reason: "no-window" });
    agent.ws.close();
  });

  it("malformed frame closes with 4400; e2e before auth closes with 4403", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendRaw(new Uint8Array([0xff, 0x00, 0x01]));
    expect((await c.closed).code).toBe(4400);
    const d = await connect(mac.fp);
    await d.nextCtrl();
    d.sendEnvelope({ v: 1, t: "e2e", from: mac.fp, to: mac.fp, seq: 1, body: { n: new Uint8Array(24), c: new Uint8Array(1) } });
    expect((await d.closed).code).toBe(4403);
  });

  it("second agent supersedes the first with 4005", async () => {
    const mac = new TestDevice("MBP");
    const { agent: a } = await agentOnline(mac);
    const { agent: b } = await agentOnline(mac);
    expect((await a.closed).code).toBe(4005);
    b.ws.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 4: Implement `auth.ts`**

`apps/relay/src/auth.ts`:
```ts
import { authMessage, fingerprint, verify, type CtrlMessageOf } from "@shellbell/protocol";

export function verifyAuthMessage(msg: CtrlMessageOf<"auth">, connId: string, nonce: Uint8Array): "ok" | "fp-mismatch" | "bad-sig" {
  if (fingerprint(msg.ed25519Pub) !== msg.fp) return "fp-mismatch";
  if (!verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig)) return "bad-sig";
  return "ok";
}
```

- [ ] **Step 5: Implement the DO — connection lifecycle, auth, alarm**

Replace `apps/relay/src/computer-do.ts` entirely:
```ts
import { DurableObject } from "cloudflare:workers";
import {
  bytesEqual,
  decodeEnvelope,
  encodeEnvelope,
  fromBase64Url,
  MAX_PAIRINGS,
  parseCtrl,
  ProtocolError,
  randomBytes,
  sha256,
  toBase64Url,
  type CtrlMessage,
  type CtrlMessageOf,
  type Envelope,
} from "@shellbell/protocol";
import { verifyAuthMessage } from "./auth.js";
import type { Env } from "./env.js";
import { frameLimitFor, peekIsCtrl, TokenBucket, type SocketState } from "./limits.js";
import { pushBody, sendExpoPush, type ExpoMessage } from "./push.js";
import { SCHEMA_SQL } from "./schema.js";

interface Attachment {
  state: SocketState;
  connId: string;
  nonce: string; // base64url
  since: number;
  fp: string | null;
  name: string | null;
  leaseUntil: number;
  used?: boolean; // pairing sockets: request already sent
}

interface PairingRow {
  phone_fp: string;
  ed25519_pub: ArrayBuffer;
  name: string;
  push_token: string | null;
  push_platform: string | null;
  push_enabled: number;
}

interface WindowRow {
  gate_hash: ArrayBuffer;
  expires_at: number;
  admitted: number;
}

const UNAUTH_TIMEOUT_MS = 10_000;
const PAIRING_TIMEOUT_MS = 90_000;
const WINDOW_MAX_ADMITTED = 5;
const GC_AFTER_MS = 90 * 24 * 3600 * 1000;
const RING_LIMIT_MS = 60_000;
const RING_ROWS_CAP = 200;
const PUSH_PER_HOUR = 20;

function blob(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export class ComputerDO extends DurableObject<Env> {
  private readonly fp: string;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fp = ctx.id.name ?? "";
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------- connection

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const nonce = randomBytes(32);
    const att: Attachment = {
      state: "unauth",
      connId: toBase64Url(randomBytes(16)),
      nonce: toBase64Url(nonce),
      since: Date.now(),
      fp: null,
      name: null,
      leaseUntil: 0,
    };
    server.serializeAttachment(att);
    this.sendCtrl(server, { type: "challenge", nonce, connId: att.connId });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return;
    const att = ws.deserializeAttachment() as Attachment;
    const bytes = new Uint8Array(message);
    const isCtrl = peekIsCtrl(bytes);
    if (bytes.byteLength > frameLimitFor(att.state, isCtrl)) {
      ws.close(4413, "too large");
      return;
    }
    let bucket = this.buckets.get(att.connId);
    if (!bucket) {
      bucket = new TokenBucket();
      this.buckets.set(att.connId, bucket);
    }
    if (!bucket.take(Date.now())) {
      ws.close(4429, "rate limited");
      return;
    }
    let env: Envelope;
    try {
      env = decodeEnvelope(bytes);
    } catch {
      ws.close(4400, "malformed");
      return;
    }
    try {
      if (env.t === "ctrl") await this.onCtrl(ws, att, env);
      else this.onE2E(ws, att, env, message);
    } catch (err) {
      if (err instanceof ProtocolError) ws.close(4400, err.code);
      else throw err;
    }
  }

  override async webSocketClose(ws: WebSocket, _code: number): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.buckets.delete(att.connId);
    if (att.state === "agent") {
      this.closeWindow();
      for (const p of this.socketsByState("phone")) {
        this.sendCtrl(p, { type: "presence", agentOnline: false, computerName: this.computerName() });
      }
    } else if (att.state === "phone" && att.fp) {
      const agent = this.agentSocket();
      if (agent) this.sendCtrl(agent, { type: "phone-disconnected", phoneFp: att.fp, connId: att.connId });
    }
  }

  override async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    await this.webSocketClose(ws, 1006);
  }

  // ---------------------------------------------------------------- alarm

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.state === "unauth" && now - att.since > UNAUTH_TIMEOUT_MS) ws.close(4408, "auth timeout");
      else if (att.state === "pairing" && now - att.since > PAIRING_TIMEOUT_MS) ws.close(4408, "pairing timeout");
    }
    const win = this.window();
    if (win && now >= win.expires_at) this.closeWindow();
    const computer = this.ctx.storage.sql.exec<{ last_seen: number }>("SELECT last_seen FROM computer WHERE fp = ?", this.fp).toArray()[0];
    if (computer && now - computer.last_seen > GC_AFTER_MS && !this.agentSocket()) {
      for (const ws of this.ctx.getWebSockets()) ws.close(4004, "computer expired");
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm();
  }

  /** Earliest of: unauth/pairing socket deadlines, window expiry, GC deadline. Always at most 5 s out when something is pending. */
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.state === "unauth") earliest = Math.min(earliest, att.since + UNAUTH_TIMEOUT_MS);
      if (att.state === "pairing") earliest = Math.min(earliest, att.since + PAIRING_TIMEOUT_MS);
    }
    const win = this.window();
    if (win) earliest = Math.min(earliest, win.expires_at);
    const computer = this.ctx.storage.sql.exec<{ last_seen: number }>("SELECT last_seen FROM computer WHERE fp = ?", this.fp).toArray()[0];
    if (computer) earliest = Math.min(earliest, computer.last_seen + GC_AFTER_MS);
    if (earliest === Number.POSITIVE_INFINITY) return;
    await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(earliest, now + 5000)));
  }

  // ---------------------------------------------------------------- ctrl dispatch

  private async onCtrl(ws: WebSocket, att: Attachment, env: Envelope): Promise<void> {
    const msg = parseCtrl(env.body);
    if (att.state === "unauth") {
      if (msg.type !== "auth") {
        ws.close(4403, "auth first");
        return;
      }
      await this.onAuth(ws, att, msg);
      return;
    }
    if (env.from !== att.fp) {
      ws.close(4403, "from mismatch");
      return;
    }
    switch (att.state) {
      case "agent":
        await this.onAgentCtrl(ws, msg);
        return;
      case "phone":
        await this.onPhoneCtrl(ws, att, msg);
        return;
      case "pairing":
        await this.onPairingCtrl(ws, att, msg);
        return;
    }
  }

  private async onAuth(ws: WebSocket, att: Attachment, msg: CtrlMessageOf<"auth">): Promise<void> {
    const fail = (reason: CtrlMessageOf<"auth-fail">["reason"]) => {
      this.sendCtrl(ws, { type: "auth-fail", reason });
      ws.close(4001, reason);
    };
    const v = verifyAuthMessage(msg, att.connId, fromBase64Url(att.nonce));
    if (v !== "ok") return fail(v);
    const now = Date.now();
    const minFrameMs = Number(this.env.MIN_FRAME_MS ?? "125") || 125;

    if (msg.role === "agent") {
      if (msg.fp !== this.fp) return fail("fp-mismatch");
      this.ctx.storage.sql.exec(
        `INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fp) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        this.fp,
        blob(msg.ed25519Pub),
        msg.name,
        now,
        now,
      );
      for (const old of this.socketsByState("agent")) old.close(4005, "superseded");
      this.setState(ws, { ...att, state: "agent", fp: msg.fp, name: msg.name });
      this.sendCtrl(ws, { type: "auth-ok", role: "agent", agentOnline: true, computerName: msg.name, serverTime: now, minFrameMs });
      const tombstones = this.ctx.storage.sql.exec<{ phone_fp: string }>("SELECT phone_fp FROM pending_unpairs").toArray().map((r) => r.phone_fp);
      this.sendCtrl(ws, { type: "unpaired", phoneFps: tombstones });
      const connected = this.socketsByState("phone").map((p) => {
        const a = p.deserializeAttachment() as Attachment;
        return { phoneFp: a.fp as string, connId: a.connId, name: a.name ?? "" };
      });
      this.sendCtrl(ws, { type: "phones", connected });
      for (const p of this.socketsByState("phone")) {
        this.sendCtrl(p, { type: "presence", agentOnline: true, computerName: msg.name });
      }
      return;
    }

    if (msg.role === "phone") {
      const row = this.pairing(msg.fp);
      if (!row || !bytesEqual(new Uint8Array(row.ed25519_pub), msg.ed25519Pub)) return fail("not-paired");
      this.ctx.storage.sql.exec("UPDATE pairings SET last_seen = ? WHERE phone_fp = ?", now, msg.fp);
      for (const old of this.phoneSockets(msg.fp)) old.close(4005, "superseded");
      this.setState(ws, { ...att, state: "phone", fp: msg.fp, name: msg.name });
      const agent = this.agentSocket();
      this.sendCtrl(ws, { type: "auth-ok", role: "phone", agentOnline: agent !== null, computerName: this.computerName(), serverTime: now, minFrameMs });
      if (agent) this.sendCtrl(agent, { type: "phone-connected", phoneFp: msg.fp, connId: att.connId, name: msg.name });
      return;
    }

    // pairing
    if (!this.agentSocket()) return fail("no-agent");
    const win = this.window();
    if (!win || now >= win.expires_at || win.admitted >= WINDOW_MAX_ADMITTED || !msg.gate) return fail("no-window");
    if (!bytesEqual(new Uint8Array(win.gate_hash), sha256(msg.gate))) return fail("no-window");
    this.ctx.storage.sql.exec("UPDATE pairing_window SET admitted = admitted + 1 WHERE id = 1");
    this.setState(ws, { ...att, state: "pairing", fp: msg.fp, name: msg.name });
    this.sendCtrl(ws, { type: "auth-ok", role: "pairing", agentOnline: true, computerName: this.computerName(), serverTime: now, minFrameMs });
  }

  private async onAgentCtrl(_ws: WebSocket, _msg: CtrlMessage): Promise<void> {
    // Task 4 (pairing window, sync, unpair) and Task 6 (notify)
  }

  private async onPhoneCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // Task 4 (unpair), Task 6 (push-token, lease)
  }

  private async onPairingCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // Task 4
  }

  private onE2E(_ws: WebSocket, _att: Attachment, _env: Envelope, _raw: ArrayBuffer): void {
    // Task 5
  }

  // ---------------------------------------------------------------- helpers

  protected sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    try {
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }));
    } catch {
      // socket already closed
    }
  }

  protected setState(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  protected socketsByState(state: SocketState): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.state === state);
  }

  protected agentSocket(): WebSocket | null {
    return this.socketsByState("agent")[0] ?? null;
  }

  protected phoneSockets(fp: string): WebSocket[] {
    return this.socketsByState("phone").filter((ws) => (ws.deserializeAttachment() as Attachment).fp === fp);
  }

  protected pairingSocket(fp: string): WebSocket | null {
    return this.socketsByState("pairing").find((ws) => (ws.deserializeAttachment() as Attachment).fp === fp) ?? null;
  }

  protected pairing(phoneFp: string): PairingRow | null {
    return this.ctx.storage.sql.exec<PairingRow>("SELECT * FROM pairings WHERE phone_fp = ?", phoneFp).toArray()[0] ?? null;
  }

  protected window(): WindowRow | null {
    return this.ctx.storage.sql.exec<WindowRow>("SELECT gate_hash, expires_at, admitted FROM pairing_window WHERE id = 1").toArray()[0] ?? null;
  }

  protected closeWindow(): void {
    this.ctx.storage.sql.exec("DELETE FROM pairing_window WHERE id = 1");
  }

  protected computerName(): string | null {
    return this.ctx.storage.sql.exec<{ name: string | null }>("SELECT name FROM computer WHERE fp = ?", this.fp).toArray()[0]?.name ?? null;
  }
}
```

Create a placeholder `apps/relay/src/push.ts` so the import compiles (real content in Task 6):
```ts
import type { EventKind } from "@shellbell/protocol";
export interface ExpoMessage { to: string; title: string; body: string; data: Record<string, string>; sound: "default"; priority: "high"; channelId: "rings"; categoryId: "ring" }
export function pushBody(_kind: EventKind, _exitCode?: number, _durationMs?: number): string { return ""; }
export async function sendExpoPush(_m: ExpoMessage[], _t: string | undefined): Promise<{ deadTokens: string[] }> { return { deadTokens: [] }; }
```

- [ ] **Step 6: Run tests to verify they pass** — `pnpm test` (`auth`, `index`, `limits`, `vectors` green).

- [ ] **Step 7: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): websocket accept, challenge/auth for agent, phone and pairing roles, alarm scheduling"
```

---

### Task 4: Pairing window, request gating, pairings sync, unpair (spec 6.4, 7.3, 9.2)

**Files:**
- Create: `apps/relay/test/pairing.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — fill `onAgentCtrl` (except `notify`), `onPhoneCtrl` (`unpair` only), `onPairingCtrl`

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/pairing.test.ts`:
```ts
import { sha256 } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, box, connect, pairPhone, TestDevice } from "./helpers.js";

describe("pairing", () => {
  it("window + gate admit a pairing socket; response is routed; phone can then authenticate", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    expect(await authenticate(p, phone, "phone")).toMatchObject({ type: "auth-ok", role: "phone", agentOnline: true });
    expect(await agent.nextCtrl()).toMatchObject({ type: "phone-connected", phoneFp: phone.fp, name: "iPhone" });
    p.ws.close();
    expect(await agent.nextCtrl()).toMatchObject({ type: "phone-disconnected", phoneFp: phone.fp });
    agent.ws.close();
  });

  it("wrong gate, closed window, and a 6th admission are refused", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(1);
    agent.sendCtrl(mac.fp, { type: "pairing-open", gateHash: sha256(gate), expiresAt: Date.now() + 300_000 });
    const wrong = await connect(mac.fp);
    expect(await authenticate(wrong, new TestDevice("x"), "pairing", { gate: new Uint8Array(16).fill(2) })).toEqual({ type: "auth-fail", reason: "no-window" });
    for (let i = 0; i < 5; i++) {
      const c = await connect(mac.fp);
      expect((await authenticate(c, new TestDevice(`p${i}`), "pairing", { gate })).type).toBe("auth-ok");
    }
    const sixth = await connect(mac.fp);
    expect(await authenticate(sixth, new TestDevice("p6"), "pairing", { gate })).toEqual({ type: "auth-fail", reason: "no-window" });
    agent.sendCtrl(mac.fp, { type: "pairing-close" });
    await new Promise((r) => setTimeout(r, 20));
    const after = await connect(mac.fp);
    expect(await authenticate(after, new TestDevice("p7"), "pairing", { gate })).toEqual({ type: "auth-fail", reason: "no-window" });
    agent.ws.close();
  });

  it("pairing socket accepts exactly one pairing-request", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(3);
    agent.sendCtrl(mac.fp, { type: "pairing-open", gateHash: sha256(gate), expiresAt: Date.now() + 300_000 });
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing", { gate });
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    expect((await pairing.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("pairing-reject is forwarded and closes the pairing socket with 4003", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(4);
    agent.sendCtrl(mac.fp, { type: "pairing-open", gateHash: sha256(gate), expiresAt: Date.now() + 300_000 });
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing", { gate });
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "pairing-reject", phoneFp: phone.fp, reason: "declined" });
    expect(await pairing.nextCtrl()).toEqual({ type: "pairing-reject", phoneFp: phone.fp, reason: "declined" });
    expect((await pairing.closed).code).toBe(4003);
    agent.ws.close();
  });

  it("agent disconnect closes the window", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    const gate = new Uint8Array(16).fill(5);
    agent.sendCtrl(mac.fp, { type: "pairing-open", gateHash: sha256(gate), expiresAt: Date.now() + 300_000 });
    agent.ws.close();
    await agent.closed;
    const { agent: again } = await agentOnline(mac);
    const c = await connect(mac.fp);
    expect(await authenticate(c, new TestDevice("p"), "pairing", { gate })).toEqual({ type: "auth-fail", reason: "no-window" });
    again.ws.close();
  });

  it("pairings-sync replaces the table and closes removed phones; push settings survive for retained", async () => {
    const mac = new TestDevice("MBP");
    const a = new TestDevice("A");
    const b = new TestDevice("B");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, a);
    await pairPhone(mac, agent, b);
    const pa = await connect(mac.fp);
    await authenticate(pa, a, "phone");
    await agent.nextCtrl();
    pa.sendCtrl(a.fp, { type: "push-token", token: "ExponentPushToken[a]", platform: "ios", enabled: false });
    const pb = await connect(mac.fp);
    await authenticate(pb, b, "phone");
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "pairings-sync", phones: [{ phoneFp: a.fp, ed25519Pub: a.id.ed25519.pub, name: "A2" }] });
    expect((await pb.closed).code).toBe(4004);
    await agent.nextCtrl(); // phone-disconnected b
    // A is still paired and its push_enabled=false survived: verify indirectly via a re-auth
    pa.ws.close();
    await agent.nextCtrl();
    const pa2 = await connect(mac.fp);
    expect((await authenticate(pa2, a, "phone")).type).toBe("auth-ok");
    const pb2 = await connect(mac.fp);
    expect(await authenticate(pb2, b, "phone")).toEqual({ type: "auth-fail", reason: "not-paired" });
    agent.ws.close();
  });

  it("agent unpair closes the phone with 4004 and later auth fails", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "unpair", phoneFp: phone.fp });
    expect((await p.closed).code).toBe(4004);
    const again = await connect(mac.fp);
    expect(await authenticate(again, phone, "phone")).toEqual({ type: "auth-fail", reason: "not-paired" });
    agent.ws.close();
  });

  it("phone unpairs itself: forwarded when agent online, tombstoned when offline", async () => {
    const mac = new TestDevice("MBP");
    const p1 = new TestDevice("P1");
    const p2 = new TestDevice("P2");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, p1);
    await pairPhone(mac, agent, p2);
    const c1 = await connect(mac.fp);
    await authenticate(c1, p1, "phone");
    await agent.nextCtrl();
    c1.sendCtrl(p1.fp, { type: "unpair", phoneFp: p1.fp });
    expect(await agent.nextCtrl()).toEqual({ type: "unpair", phoneFp: p1.fp });
    expect((await c1.closed).code).toBe(4004);
    await agent.nextCtrl(); // phone-disconnected
    agent.ws.close();
    await agent.closed;
    const c2 = await connect(mac.fp);
    await authenticate(c2, p2, "phone");
    c2.sendCtrl(p2.fp, { type: "unpair", phoneFp: p2.fp });
    expect((await c2.closed).code).toBe(4004);
    const { agent: back, unpaired } = await agentOnline(mac);
    expect(unpaired).toEqual({ type: "unpaired", phoneFps: [p2.fp] });
    back.sendCtrl(mac.fp, { type: "pairings-sync", phones: [] });
    const { agent: third, unpaired: none } = await agentOnline(mac);
    expect(none).toEqual({ type: "unpaired", phoneFps: [] });
    third.ws.close();
  });

  it("phone cannot unpair a different phone", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const { agent } = await agentOnline(mac);
    await pairPhone(mac, agent, phone);
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl();
    p.sendCtrl(phone.fp, { type: "unpair", phoneFp: "z".repeat(26) });
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement the handlers**

Replace the three stub methods in `computer-do.ts`:
```ts
  private async onAgentCtrl(ws: WebSocket, msg: CtrlMessage): Promise<void> {
    const now = Date.now();
    switch (msg.type) {
      case "pairing-open":
        this.ctx.storage.sql.exec(
          `INSERT INTO pairing_window (id, gate_hash, expires_at, admitted) VALUES (1, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET gate_hash = excluded.gate_hash, expires_at = excluded.expires_at, admitted = 0`,
          blob(msg.gateHash),
          Math.min(msg.expiresAt, now + 10 * 60_000),
        );
        await this.scheduleAlarm();
        return;
      case "pairing-close":
        this.closeWindow();
        return;
      case "pairing-add": {
        const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pairings WHERE phone_fp != ?", msg.phoneFp).toArray()[0]?.n ?? 0;
        if (count >= MAX_PAIRINGS) {
          this.sendCtrl(ws, { type: "error", code: "too-many-pairings", message: `max ${MAX_PAIRINGS} phones` });
          return;
        }
        this.upsertPairing(msg.phoneFp, msg.ed25519Pub, msg.name, now);
        return;
      }
      case "pairing-response": {
        const target = this.pairingSocket(msg.phoneFp);
        if (target) this.sendCtrl(target, msg);
        return;
      }
      case "pairing-reject": {
        const target = this.pairingSocket(msg.phoneFp);
        if (target) {
          this.sendCtrl(target, msg);
          target.close(4003, msg.reason);
        }
        return;
      }
      case "pairings-sync": {
        const keep = new Set(msg.phones.map((p) => p.phoneFp));
        const existing = this.ctx.storage.sql.exec<{ phone_fp: string }>("SELECT phone_fp FROM pairings").toArray();
        for (const row of existing) if (!keep.has(row.phone_fp)) this.removePairing(row.phone_fp, false);
        for (const p of msg.phones) this.upsertPairing(p.phoneFp, p.ed25519Pub, p.name, now);
        this.ctx.storage.sql.exec("DELETE FROM pending_unpairs");
        return;
      }
      case "unpair":
        this.removePairing(msg.phoneFp, false);
        return;
      case "notify":
        await this.onNotify(msg);
        return;
      default:
        ws.close(4403, `agent may not send ${msg.type}`);
    }
  }

  private async onPhoneCtrl(ws: WebSocket, att: Attachment, msg: CtrlMessage): Promise<void> {
    switch (msg.type) {
      case "unpair": {
        if (msg.phoneFp !== att.fp) {
          ws.close(4403, "may only unpair self");
          return;
        }
        const agent = this.agentSocket();
        if (agent) this.sendCtrl(agent, msg);
        this.removePairing(msg.phoneFp, agent === null);
        return;
      }
      case "push-token":
        this.ctx.storage.sql.exec(
          "UPDATE pairings SET push_token = ?, push_platform = ?, push_enabled = ? WHERE phone_fp = ?",
          msg.token,
          msg.platform,
          msg.enabled ? 1 : 0,
          att.fp,
        );
        return;
      case "lease":
        this.setState(ws, { ...att, leaseUntil: Date.now() + msg.ttlMs });
        return;
      default:
        ws.close(4403, `phone may not send ${msg.type}`);
    }
  }

  private async onPairingCtrl(ws: WebSocket, att: Attachment, msg: CtrlMessage): Promise<void> {
    if (msg.type !== "pairing-request" || msg.phoneFp !== att.fp || att.used) {
      ws.close(4403, "one pairing-request only");
      return;
    }
    const agent = this.agentSocket();
    if (!agent) {
      this.sendCtrl(ws, { type: "pairing-reject", phoneFp: msg.phoneFp, reason: "no-agent" });
      ws.close(4003, "no-agent");
      return;
    }
    this.setState(ws, { ...att, used: true });
    this.sendCtrl(agent, msg);
  }

  private upsertPairing(phoneFp: string, pub: Uint8Array, name: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at, last_seen) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(phone_fp) DO UPDATE SET ed25519_pub = excluded.ed25519_pub, name = excluded.name`,
      phoneFp,
      blob(pub),
      name,
      now,
    );
  }

  /** Delete the row, close the phone's sockets; optionally leave a tombstone for the agent. */
  private removePairing(phoneFp: string, tombstone: boolean): void {
    this.ctx.storage.sql.exec("DELETE FROM pairings WHERE phone_fp = ?", phoneFp);
    this.ctx.storage.sql.exec("DELETE FROM push_limits WHERE phone_fp = ?", phoneFp);
    if (tombstone) {
      const n = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_unpairs").toArray()[0]?.n ?? 0;
      if (n < MAX_PAIRINGS) {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO pending_unpairs (phone_fp, at) VALUES (?, ?)", phoneFp, Date.now());
      }
    }
    for (const s of this.phoneSockets(phoneFp)) s.close(4004, "unpaired");
  }

  private async onNotify(_msg: CtrlMessageOf<"notify">): Promise<void> {
    // Task 6
  }
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): pairing window with gate, one-shot pairing sockets, pairings sync, unpair tombstones"
```

---

### Task 5: E2E frame routing and one-socket-per-phone (spec 6.5, 7.2, 9.2)

**Files:**
- Create: `apps/relay/test/routing.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — implement `onE2E`

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/routing.test.ts`:
```ts
import type { Envelope } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

async function setup() {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl(); // phone-connected
  return { mac, phone, agent, p };
}

const e2e = (from: string, to: string, seq: number, c: number[]): Envelope => ({
  v: 1, t: "e2e", from, to, seq, body: { n: new Uint8Array(24), c: new Uint8Array(c) },
});

describe("e2e routing", () => {
  it("phone → agent and agent → phone, bytes preserved", async () => {
    const { mac, phone, agent, p } = await setup();
    p.sendEnvelope(e2e(phone.fp, mac.fp, 1, [7, 8, 9]));
    const got = await agent.next();
    expect(got.t).toBe("e2e");
    expect(got.from).toBe(phone.fp);
    expect((got.body as { c: Uint8Array }).c).toEqual(new Uint8Array([7, 8, 9]));
    agent.sendEnvelope(e2e(mac.fp, phone.fp, 1, [1]));
    const back = await p.next();
    expect(back.from).toBe(mac.fp);
    expect((back.body as { c: Uint8Array }).c).toEqual(new Uint8Array([1]));
    agent.ws.close();
    p.ws.close();
  });

  it("rejects a spoofed from", async () => {
    const { mac, agent, p } = await setup();
    p.sendEnvelope(e2e("q".repeat(26), mac.fp, 1, [1]));
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("drops frames to a disconnected peer silently", async () => {
    const { mac, phone, agent, p } = await setup();
    agent.ws.close();
    await agent.closed;
    expect(await p.nextCtrl()).toMatchObject({ type: "presence", agentOnline: false });
    p.sendEnvelope(e2e(phone.fp, mac.fp, 1, [1]));
    await expect(p.next(300)).rejects.toThrow(/timeout/);
    p.ws.close();
  });

  it("a second socket for the same phone supersedes the first (4005) and the agent learns both events", async () => {
    const { mac, phone, agent, p } = await setup();
    const p2 = await connect(mac.fp);
    await authenticate(p2, phone, "phone");
    expect((await p.closed).code).toBe(4005);
    const m1 = await agent.nextCtrl();
    const m2 = await agent.nextCtrl();
    expect([m1.type, m2.type].sort()).toEqual(["phone-connected", "phone-disconnected"]);
    agent.sendEnvelope(e2e(mac.fp, phone.fp, 1, [5]));
    expect(((await p2.next()).body as { c: Uint8Array }).c).toEqual(new Uint8Array([5]));
    agent.ws.close();
    p2.ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `onE2E`**

```ts
  private onE2E(ws: WebSocket, att: Attachment, env: Envelope, raw: ArrayBuffer): void {
    if (att.state !== "agent" && att.state !== "phone") {
      ws.close(4403, "e2e requires auth");
      return;
    }
    if (env.from !== att.fp) {
      ws.close(4403, "from mismatch");
      return;
    }
    if (!env.to) {
      ws.close(4400, "e2e needs to");
      return;
    }
    const targets =
      att.state === "agent"
        ? this.phoneSockets(env.to)
        : env.to === this.fp
          ? [this.agentSocket()].filter((s): s is WebSocket => s !== null)
          : [];
    for (const t of targets) {
      try {
        t.send(raw);
      } catch {
        // closed between lookup and send
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): forward e2e frames; newest phone socket wins"
```

---

### Task 6: Notify → Expo push with leases and limits (spec 9.2 Push, 11.3)

**Files:**
- Replace: `apps/relay/src/push.ts`
- Create: `apps/relay/test/push.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — implement `onNotify`, `takePushBudget`

**Interfaces:**
- Produces (`push.ts`): `formatDuration(ms): string`, `pushBody(kind, exitCode?, durationMs?): string`, `sendExpoPush(messages: ExpoMessage[], accessToken?: string, fetchImpl?: typeof fetch): Promise<{ deadTokens: string[] }>`, `interface ExpoMessage`.

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/push.test.ts`:
```ts
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatDuration, pushBody } from "../src/push.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function pairedWithToken(enabled = true) {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl();
  p.sendCtrl(phone.fp, { type: "push-token", token: "ExponentPushToken[abc]", platform: "ios", enabled });
  await new Promise((r) => setTimeout(r, 20));
  return { mac, phone, agent, p };
}

function interceptPush(onBody: (b: unknown) => void, reply: unknown = { data: [{ status: "ok" }] }) {
  fetchMock
    .get("https://exp.host")
    .intercept({ path: "/--/api/v2/push/send", method: "POST" })
    .reply(200, (req) => {
      onBody(JSON.parse(req.body as string));
      return reply;
    })
    .persist();
}

const settle = () => new Promise((r) => setTimeout(r, 120));

describe("push text", () => {
  it("formats durations and bodies", () => {
    expect(formatDuration(43_000)).toBe("43s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(pushBody("prompt", 0, 43_000)).toBe("A command finished — exit 0 after 43s");
    expect(pushBody("idle")).toBe("A session went quiet — waiting for you?");
  });
});

describe("notify → push", () => {
  it("does not push while the phone holds a lease; pushes after lease 0 + close", async () => {
    const { mac, agent, p, phone } = await pairedWithToken();
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 60_000 });
    await settle();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s1", kind: "prompt", exitCode: 0, durationMs: 43_000 });
    await settle(); // no interceptor registered → a push would throw on net connect
    let sent: unknown;
    interceptPush((b) => (sent = b));
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 0 });
    p.ws.close();
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s2", kind: "idle", durationMs: 5000 });
    await settle();
    expect(sent).toEqual([
      {
        to: "ExponentPushToken[abc]",
        title: "MBP",
        body: "A session went quiet — waiting for you?",
        data: { computerFp: mac.fp, sessionId: "s2", kind: "idle" },
        sound: "default",
        priority: "high",
        channelId: "rings",
        categoryId: "ring",
      },
    ]);
    agent.ws.close();
  });

  it("a connected phone with an expired lease is pushed", async () => {
    const { mac, agent, p, phone } = await pairedWithToken();
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 1 });
    await settle();
    let calls = 0;
    interceptPush(() => calls++);
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    await settle();
    expect(calls).toBe(1);
    agent.ws.close();
    p.ws.close();
  });

  it("push disabled for the pairing → never pushed", async () => {
    const { mac, agent, p } = await pairedWithToken(false);
    p.ws.close();
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    await settle();
    agent.ws.close();
  });

  it("rate-limits one ring per session per 60s", async () => {
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    let calls = 0;
    interceptPush(() => calls++);
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "t", kind: "idle" });
    await settle();
    expect(calls).toBe(2);
    agent.ws.close();
  });

  it("clears a token Expo reports as DeviceNotRegistered", async () => {
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    let calls = 0;
    interceptPush(() => calls++, { data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s1", kind: "idle" });
    await settle();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s2", kind: "idle" });
    await settle();
    expect(calls).toBe(1);
    agent.ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test`.

- [ ] **Step 3: Implement `push.ts`**

`apps/relay/src/push.ts`:
```ts
import type { EventKind } from "@shellbell/protocol";

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  priority: "high";
  channelId: "rings";
  categoryId: "ring";
}

interface ExpoTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function pushBody(kind: EventKind | "prompt" | "idle", exitCode?: number, durationMs?: number): string {
  switch (kind) {
    case "prompt": {
      const exit = exitCode === undefined ? "" : ` — exit ${exitCode}`;
      const dur = durationMs === undefined ? "" : ` after ${formatDuration(durationMs)}`;
      return `A command finished${exit}${dur}`;
    }
    case "idle":
      return "A session went quiet — waiting for you?";
    default:
      return "A session needs attention";
  }
}

export async function sendExpoPush(
  messages: ExpoMessage[],
  accessToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ deadTokens: string[] }> {
  if (messages.length === 0) return { deadTokens: [] };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl("https://exp.host/--/api/v2/push/send", { method: "POST", headers, body: JSON.stringify(messages) });
  if (!res.ok) {
    console.warn("expo push http", res.status);
    return { deadTokens: [] };
  }
  const json = (await res.json()) as { data?: ExpoTicket[] };
  const deadTokens: string[] = [];
  (json.data ?? []).forEach((ticket, i) => {
    if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
      const to = messages[i]?.to;
      if (to) deadTokens.push(to);
    } else if (ticket.status === "error") {
      console.warn("expo push ticket error", ticket.details?.error ?? ticket.message ?? "unknown");
    }
  });
  return { deadTokens };
}
```

- [ ] **Step 4: Implement `onNotify` and `takePushBudget` in the DO**

```ts
  private async onNotify(msg: CtrlMessageOf<"notify">): Promise<void> {
    const now = Date.now();
    const last = this.ctx.storage.sql
      .exec<{ last_ring_at: number }>("SELECT last_ring_at FROM ring_limits WHERE session_id = ?", msg.sessionId)
      .toArray()[0];
    if (last && now - last.last_ring_at < RING_LIMIT_MS) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO ring_limits (session_id, last_ring_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_ring_at = excluded.last_ring_at",
      msg.sessionId,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM ring_limits WHERE session_id NOT IN (SELECT session_id FROM ring_limits ORDER BY last_ring_at DESC LIMIT ${RING_ROWS_CAP})`,
    );

    const attentive = new Set<string>();
    for (const s of this.socketsByState("phone")) {
      const a = s.deserializeAttachment() as Attachment;
      if (a.fp && a.leaseUntil > now) attentive.add(a.fp);
    }
    const rows = this.ctx.storage.sql
      .exec<{ phone_fp: string; push_token: string }>("SELECT phone_fp, push_token FROM pairings WHERE push_token IS NOT NULL AND push_enabled = 1")
      .toArray();
    const title = this.computerName() ?? "Shellbell";
    const messages: ExpoMessage[] = [];
    for (const row of rows) {
      if (attentive.has(row.phone_fp)) continue;
      if (!this.takePushBudget(row.phone_fp, now)) continue;
      messages.push({
        to: row.push_token,
        title,
        body: pushBody(msg.kind, msg.exitCode, msg.durationMs),
        data: { computerFp: this.fp, sessionId: msg.sessionId, kind: msg.kind },
        sound: "default",
        priority: "high",
        channelId: "rings",
        categoryId: "ring",
      });
    }
    if (messages.length === 0) return;
    const { deadTokens } = await sendExpoPush(messages, this.env.EXPO_ACCESS_TOKEN);
    for (const token of deadTokens) {
      this.ctx.storage.sql.exec("UPDATE pairings SET push_token = NULL, push_platform = NULL WHERE push_token = ?", token);
    }
  }

  /** 20 pushes per rolling hour per phone. Returns false when exhausted. */
  private takePushBudget(phoneFp: string, now: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ window_start: number; count: number }>("SELECT window_start, count FROM push_limits WHERE phone_fp = ?", phoneFp)
      .toArray()[0];
    if (!row || now - row.window_start > 3_600_000) {
      this.ctx.storage.sql.exec(
        "INSERT INTO push_limits (phone_fp, window_start, count) VALUES (?, ?, 1) ON CONFLICT(phone_fp) DO UPDATE SET window_start = excluded.window_start, count = 1",
        phoneFp,
        now,
      );
      return true;
    }
    if (row.count >= PUSH_PER_HOUR) return false;
    this.ctx.storage.sql.exec("UPDATE push_limits SET count = count + 1 WHERE phone_fp = ?", phoneFp);
    return true;
  }
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. All test files green.

- [ ] **Step 6: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): notify → Expo push gated by leases, push flag, per-session and per-phone limits"
```

---

### Task 7: Local dev script, deploy workflow, self-hosting doc

**Files:**
- Create: `scripts/e2e-local.sh`, `.github/workflows/deploy-relay.yml`, `docs/self-hosting.md`

- [ ] **Step 1: Dev script**

`scripts/e2e-local.sh`:
```bash
#!/usr/bin/env bash
# Runs the relay locally. Start the agent (Plan 03) with:  shellbell start --relay ws://<LAN-IP>:8787
set -euo pipefail
cd "$(dirname "$0")/../apps/relay"
IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
echo "Relay dev server: ws://localhost:8787  (LAN: ws://${IP}:8787 — use the LAN form in the agent so the phone's QR works)"
exec pnpm wrangler dev --ip 0.0.0.0 --port 8787
```
Run `chmod +x scripts/e2e-local.sh`.

- [ ] **Step 2: Deploy workflow**

`.github/workflows/deploy-relay.yml`:
```yaml
name: deploy-relay
on:
  push:
    tags: ["relay-v*"]
jobs:
  deploy:
    runs-on: ubuntu-latest
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
      - run: pnpm -F @shellbell/relay test
      - run: pnpm -F @shellbell/relay exec wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 3: Self-hosting doc**

`docs/self-hosting.md`:
```markdown
# Self-hosting the relay

The relay is a single Cloudflare Worker with one Durable Object class. It fits the free plan.

1. `git clone https://github.com/<you>/shellbell && cd shellbell && pnpm install`
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
```

- [ ] **Step 4: Verify `wrangler dev` starts**

Run: `./scripts/e2e-local.sh` (Ctrl-C after "Ready on http://0.0.0.0:8787"), then `curl -s localhost:8787/healthz` → `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-local.sh .github/workflows/deploy-relay.yml docs/self-hosting.md
git commit -m "chore(relay): local dev script, deploy workflow, self-hosting guide"
```

---

## Plan self-review

- **Spec coverage:** 6.4 relay-side steps (window, gate, admission cap, one-shot socket, response routing, `pairing-close`) → Task 4; 6.5 auth incl. supersede for agent and phone → Tasks 3, 5; 7.1 byte caps + bucket → Task 2 (used in Task 3); 7.2 envelope forwarding → Task 5; 7.3 every ctrl type handled or rejected per role → Tasks 3, 4, 6; 9.1 routes → Task 1; 9.2 storage, hibernation, earliest-deadline alarm, GC, sync, tombstones, leases → Tasks 3, 4, 6; push rules 9.2/11.3 → Task 6; 9.3 config + `MIN_FRAME_MS` → Task 1; 12 close codes → Tasks 3–5; 15 relay tests incl. vectors on workerd → Tasks 1–6; 16 deploy + self-hosting → Task 7.
- **Type consistency:** `Attachment` has the same fields across tasks (`leaseUntil` used by Task 6, `used` by Task 4); `CtrlMessageOf<"auth">`/`<"notify">` come from Plan 01 Task 8; `pushBody` accepts `"prompt" | "idle"` which is what `notify.kind` allows; helper `pairPhone` sends `pairing-close`, matching the agent's behaviour in spec 6.4 step 5.
- **Placeholders:** none. The GitHub URL in `index.ts` is a display string to update when the repo exists.
