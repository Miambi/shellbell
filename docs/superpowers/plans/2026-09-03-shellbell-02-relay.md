# Shellbell Plan 02 — Relay (Cloudflare Worker + `ComputerDO`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable relay that authenticates devices by signature, gates pairing, forwards end-to-end-encrypted frames between one agent and its paired phones, and sends Expo push notifications — all within Cloudflare's free tier.

**Architecture:** One Worker route (`GET /ws/:fp`) upgrades WebSockets and hands them to a Durable Object named by the computer fingerprint. The DO uses the WebSocket Hibernation API, SQLite storage for pairings/push tokens/rate limits, an alarm to sweep unauthenticated sockets, and `fetch` to Expo's push API. It never decrypts anything.

**Tech Stack:** wrangler 4.129, `@cloudflare/workers-types` 5.x, `@cloudflare/vitest-pool-workers` 0.22, vitest 5, `@shellbell/protocol` (Plan 01).

**Spec:** `docs/superpowers/specs/2026-09-03-shellbell-design.md` — sections 6.5, 7.1–7.3, 9, 11.3, 12 (close codes), 13, 15 (relay tests). Plan 01 must be complete (the relay imports `@shellbell/protocol`).

## Global Constraints

- All the Plan 01 global constraints apply (Node ≥ 22, pnpm 11.12.0, TypeScript 5.9.3, Biome rules, commit style).
- The relay must not import Node built-ins; it runs on the Workers runtime. `@shellbell/protocol` is safe.
- The DO is **SQLite-backed** (`new_sqlite_classes`) — required for the free plan.
- Close codes (spec 12): `4001` auth failed · `4003` bad pairing message · `4004` unpaired · `4005` superseded · `4400` malformed · `4403` forbidden for role · `4413` too large · `4408` unauth timeout.
- Timeouts: unauthenticated socket **10 s**; pairing socket **60 s**; ring limit **60 s per session**; push cap **20 per phone per rolling hour**.
- The relay never logs frame contents. `console.log` only with fp prefixes (first 8 chars), roles, close codes, counts.
- The only outbound `fetch` is `https://exp.host/--/api/v2/push/send`.

---

## File structure

```
apps/relay/
├── package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts
├── src/
│   ├── index.ts          Worker entry: routes, upgrade → DO
│   ├── computer-do.ts    ComputerDO: sockets, auth, routing, pairing, push trigger, alarm
│   ├── schema.ts         SQL schema string
│   ├── auth.ts           pure: verifyAuth(...)
│   ├── push.ts           pure: buildPushMessages(...), sendExpoPush(...)
│   └── env.d.ts          Env interface
└── test/
    ├── helpers.ts        TestDevice, connect(), next()
    ├── auth.test.ts
    ├── pairing.test.ts
    ├── routing.test.ts
    └── push.test.ts
```

---

### Task 1: Relay package skeleton, config, and Worker entry (spec 9.1, 9.3)

**Files:**
- Create: `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/wrangler.jsonc`, `apps/relay/vitest.config.ts`, `apps/relay/src/env.d.ts`, `apps/relay/src/index.ts`, `apps/relay/src/schema.ts`, `apps/relay/src/computer-do.ts` (stub), `apps/relay/test/index.test.ts`

**Interfaces:**
- Produces: `Env { COMPUTER: DurableObjectNamespace<ComputerDO>; EXPO_ACCESS_TOKEN?: string }`; `export class ComputerDO`; `SCHEMA_SQL: string`.

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
  "observability": { "enabled": true }
  // Hosted deployment adds:  "routes": [{ "pattern": "relay.shellbell.app", "custom_domain": true }]
  // Self-hosters keep the *.workers.dev URL and put it in `shellbell config set relay wss://...`.
}
```

`apps/relay/vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
```

`apps/relay/src/env.d.ts`:
```ts
import type { ComputerDO } from "./computer-do.js";

export interface Env {
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  EXPO_ACCESS_TOKEN?: string;
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
  paired_at INTEGER NOT NULL,
  last_seen INTEGER
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

`apps/relay/src/computer-do.ts` (stub for this task; replaced in Task 2):
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
      const id = env.COMPUTER.idFromName(fp);
      return env.COMPUTER.get(id).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Write the failing test**

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

- [ ] **Step 3: Install and run**

Run: `cd apps/relay && pnpm install && pnpm test`
Expected: PASS (the DO stub is not reached by these tests).

- [ ] **Step 4: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): worker skeleton, routes, DO stub, sqlite schema"
```

---

### Task 2: Test helpers and the DO's connection/auth handshake (spec 6.5, 9.2)

**Files:**
- Create: `apps/relay/test/helpers.ts`, `apps/relay/src/auth.ts`, `apps/relay/test/auth.test.ts`
- Modify: `apps/relay/src/computer-do.ts` (real implementation begins)

**Interfaces:**
- Produces (`auth.ts`): `verifyAuthMessage(msg: CtrlAuth, connId: string, nonce: Uint8Array): "ok" | "fp-mismatch" | "bad-sig"`.
- Produces (`computer-do.ts`): attachment shape `Attachment = { state: "unauth" | "agent" | "phone" | "pairing"; connId: string; nonce: string; since: number; fp: string | null; name: string | null }`; helpers `sendCtrl(ws, body)`, `socketsByState(state)`, `agentSocket()`, `phoneSocket(fp)`.
- Produces (`test/helpers.ts`): `class TestDevice { id: Identity; fp: string; constructor(name) }`, `connect(fp: string): Promise<Conn>` where `Conn = { ws: WebSocket; next(timeoutMs?): Promise<Envelope>; sendCtrl(body): void; sendRaw(bytes): void; closed: Promise<{ code: number }> }`, `authenticate(conn, device, role, name?): Promise<CtrlMessage>` which answers the challenge and returns the `auth-ok`/`auth-fail` message.

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
export async function authenticate(conn: Conn, dev: TestDevice, role: Role, appVersion = "test"): Promise<CtrlMessage> {
  const ch = await conn.nextCtrl();
  if (ch.type !== "challenge") throw new Error(`expected challenge, got ${ch.type}`);
  const sig = sign(dev.id.ed25519.priv, authMessage(ch.connId, role, dev.fp, ch.nonce));
  conn.sendCtrl(dev.fp, { type: "auth", role, fp: dev.fp, ed25519Pub: dev.id.ed25519.pub, sig, name: dev.name, appVersion });
  return conn.nextCtrl();
}
```

- [ ] **Step 2: Write the failing auth tests**

`apps/relay/test/auth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { authenticate, connect, TestDevice } from "./helpers.js";

describe("auth handshake", () => {
  it("agent authenticates against its own DO and gets the phone list", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    const ok = await authenticate(c, mac, "agent");
    expect(ok).toMatchObject({ type: "auth-ok", role: "agent", agentOnline: true, computerName: "MBP" });
    const phones = await c.nextCtrl();
    expect(phones).toEqual({ type: "phones", connected: [] });
    c.ws.close();
  });

  it("agent with a fingerprint that does not match the DO name is rejected", async () => {
    const mac = new TestDevice("MBP");
    const other = new TestDevice("Other");
    const c = await connect(mac.fp);
    const res = await authenticate(c, other, "agent");
    expect(res).toEqual({ type: "auth-fail", reason: "fp-mismatch" });
    expect((await c.closed).code).toBe(4001);
  });

  it("unpaired phone is rejected with not-paired", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c = await connect(mac.fp);
    const res = await authenticate(c, phone, "phone");
    expect(res).toEqual({ type: "auth-fail", reason: "not-paired" });
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

  it("pairing role needs an agent online", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const c = await connect(mac.fp);
    expect(await authenticate(c, phone, "pairing")).toEqual({ type: "auth-fail", reason: "no-agent" });
    expect((await c.closed).code).toBe(4001);
  });

  it("malformed frame closes with 4400", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendRaw(new Uint8Array([0xff, 0x00, 0x01]));
    expect((await c.closed).code).toBe(4400);
  });

  it("second agent supersedes the first with 4005", async () => {
    const mac = new TestDevice("MBP");
    const a = await connect(mac.fp);
    await authenticate(a, mac, "agent");
    const b = await connect(mac.fp);
    await authenticate(b, mac, "agent");
    expect((await a.closed).code).toBe(4005);
    b.ws.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — the stub returns 501, `connect` throws "upgrade failed".

- [ ] **Step 4: Implement `auth.ts`**

`apps/relay/src/auth.ts`:
```ts
import { authMessage, fingerprint, verify, type CtrlMessage } from "@shellbell/protocol";

export type CtrlAuth = Extract<CtrlMessage, { type: "auth" }>;

export function verifyAuthMessage(msg: CtrlAuth, connId: string, nonce: Uint8Array): "ok" | "fp-mismatch" | "bad-sig" {
  if (fingerprint(msg.ed25519Pub) !== msg.fp) return "fp-mismatch";
  if (!verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig)) return "bad-sig";
  return "ok";
}
```

- [ ] **Step 5: Implement the DO — connection lifecycle and auth**

Replace `apps/relay/src/computer-do.ts` entirely:
```ts
import { DurableObject } from "cloudflare:workers";
import {
  decodeEnvelope,
  encodeEnvelope,
  fromBase64Url,
  parseCtrl,
  ProtocolError,
  randomBytes,
  toBase64Url,
  type CtrlMessage,
  type Envelope,
} from "@shellbell/protocol";
import { verifyAuthMessage } from "./auth.js";
import type { Env } from "./env.js";
import { SCHEMA_SQL } from "./schema.js";

type State = "unauth" | "agent" | "phone" | "pairing";

interface Attachment {
  state: State;
  connId: string;
  nonce: string; // base64url
  since: number;
  fp: string | null;
  name: string | null;
}

interface PairingRow {
  phone_fp: string;
  ed25519_pub: ArrayBuffer;
  name: string;
  push_token: string | null;
  push_platform: string | null;
}

const UNAUTH_TIMEOUT_MS = 10_000;
const PAIRING_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 1_048_576;

export class ComputerDO extends DurableObject<Env> {
  private readonly fp: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fp = ctx.id.name ?? "";
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- connection ----

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
    };
    server.serializeAttachment(att);
    this.sendCtrl(server, { type: "challenge", nonce, connId: att.connId });
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") return; // only ping/pong are text and those are auto-answered
    if (message.byteLength > MAX_FRAME_BYTES) {
      ws.close(4413, "too large");
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    let env: Envelope;
    try {
      env = decodeEnvelope(new Uint8Array(message));
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
    if (att.state === "agent") {
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

  override async alarm(): Promise<void> {
    const now = Date.now();
    let pending = false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.state === "unauth" && now - att.since > UNAUTH_TIMEOUT_MS) ws.close(4408, "auth timeout");
      else if (att.state === "pairing" && now - att.since > PAIRING_TIMEOUT_MS) ws.close(4408, "pairing timeout");
      else if (att.state === "unauth" || att.state === "pairing") pending = true;
    }
    if (pending) await this.ctx.storage.setAlarm(now + 5_000);
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  // ---- ctrl ----

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

  private async onAuth(ws: WebSocket, att: Attachment, msg: Extract<CtrlMessage, { type: "auth" }>): Promise<void> {
    const fail = (reason: Extract<CtrlMessage, { type: "auth-fail" }>["reason"]) => {
      this.sendCtrl(ws, { type: "auth-fail", reason });
      ws.close(4001, reason);
    };
    const v = verifyAuthMessage(msg, att.connId, fromBase64Url(att.nonce));
    if (v !== "ok") return fail(v);
    const now = Date.now();

    if (msg.role === "agent") {
      if (msg.fp !== this.fp) return fail("fp-mismatch");
      this.ctx.storage.sql.exec(
        `INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fp) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        this.fp,
        msg.ed25519Pub.buffer.slice(msg.ed25519Pub.byteOffset, msg.ed25519Pub.byteOffset + 32),
        msg.name,
        now,
        now,
      );
      for (const old of this.socketsByState("agent")) old.close(4005, "superseded");
      this.setState(ws, { ...att, state: "agent", fp: msg.fp, name: msg.name });
      this.sendCtrl(ws, { type: "auth-ok", role: "agent", agentOnline: true, computerName: msg.name, serverTime: now });
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
      if (!row) return fail("not-paired");
      const stored = new Uint8Array(row.ed25519_pub);
      if (stored.length !== 32 || !stored.every((b, i) => b === msg.ed25519Pub[i])) return fail("not-paired");
      this.ctx.storage.sql.exec("UPDATE pairings SET last_seen = ? WHERE phone_fp = ?", now, msg.fp);
      this.setState(ws, { ...att, state: "phone", fp: msg.fp, name: msg.name });
      const agent = this.agentSocket();
      this.sendCtrl(ws, { type: "auth-ok", role: "phone", agentOnline: agent !== null, computerName: this.computerName(), serverTime: now });
      if (agent) this.sendCtrl(agent, { type: "phone-connected", phoneFp: msg.fp, connId: att.connId, name: msg.name });
      return;
    }

    // pairing
    if (!this.agentSocket()) return fail("no-agent");
    this.setState(ws, { ...att, state: "pairing", fp: msg.fp, name: msg.name });
    this.sendCtrl(ws, { type: "auth-ok", role: "pairing", agentOnline: true, computerName: this.computerName(), serverTime: now });
  }

  private async onAgentCtrl(_ws: WebSocket, _msg: CtrlMessage): Promise<void> {
    // filled in by Task 3 (pairing) and Task 5 (notify)
  }

  private async onPhoneCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // filled in by Task 3 (unpair) and Task 5 (push-token)
  }

  private async onPairingCtrl(_ws: WebSocket, _att: Attachment, _msg: CtrlMessage): Promise<void> {
    // filled in by Task 3
  }

  // ---- e2e ----

  private onE2E(_ws: WebSocket, _att: Attachment, _env: Envelope, _raw: ArrayBuffer): void {
    // filled in by Task 4
  }

  // ---- helpers ----

  protected sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    try {
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }));
    } catch {
      // socket already closed; nothing to do
    }
  }

  protected setState(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  protected socketsByState(state: State): WebSocket[] {
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
    const rows = this.ctx.storage.sql.exec<PairingRow>("SELECT * FROM pairings WHERE phone_fp = ?", phoneFp).toArray();
    return rows[0] ?? null;
  }

  protected computerName(): string | null {
    const rows = this.ctx.storage.sql.exec<{ name: string | null }>("SELECT name FROM computer WHERE fp = ?", this.fp).toArray();
    return rows[0]?.name ?? null;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: `auth.test.ts` and `index.test.ts` PASS. If `ctx.id.name` is undefined in tests, the DO was addressed by `idFromString`; the Worker uses `idFromName` so this is only possible if a test bypassed the Worker — tests must always go through `SELF.fetch`.

- [ ] **Step 7: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): websocket accept, challenge/auth for agent, phone and pairing roles"
```

---

### Task 3: Pairing gating and unpair (spec 6.4 steps 1–6, 7.3)

**Files:**
- Create: `apps/relay/test/pairing.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — fill `onAgentCtrl` (pairing-add / pairing-response / pairing-reject / unpair), `onPhoneCtrl` (unpair self), `onPairingCtrl`

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/pairing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { authenticate, connect, TestDevice } from "./helpers.js";

const box = () => ({ n: new Uint8Array(24), c: new Uint8Array([1, 2, 3]) });

async function pairedSetup() {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const agent = await connect(mac.fp);
  await authenticate(agent, mac, "agent");
  await agent.nextCtrl(); // phones []
  const pairing = await connect(mac.fp);
  expect((await authenticate(pairing, phone, "pairing")).type).toBe("auth-ok");
  pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
  const fwd = await agent.nextCtrl();
  expect(fwd).toMatchObject({ type: "pairing-request", phoneFp: phone.fp });
  agent.sendCtrl(mac.fp, { type: "pairing-add", phoneFp: phone.fp, ed25519Pub: phone.id.ed25519.pub, name: "iPhone" });
  agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: box() });
  const resp = await pairing.nextCtrl();
  expect(resp).toMatchObject({ type: "pairing-response", phoneFp: phone.fp });
  pairing.ws.close();
  return { mac, phone, agent };
}

describe("pairing", () => {
  it("forwards request to agent, response to phone, then the phone can authenticate", async () => {
    const { mac, phone, agent } = await pairedSetup();
    const p = await connect(mac.fp);
    expect(await authenticate(p, phone, "phone")).toMatchObject({ type: "auth-ok", role: "phone", agentOnline: true });
    expect(await agent.nextCtrl()).toMatchObject({ type: "phone-connected", phoneFp: phone.fp, name: "iPhone" });
    p.ws.close();
    expect(await agent.nextCtrl()).toMatchObject({ type: "phone-disconnected", phoneFp: phone.fp });
    agent.ws.close();
  });

  it("pairing socket accepts exactly one pairing-request", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const agent = await connect(mac.fp);
    await authenticate(agent, mac, "agent");
    await agent.nextCtrl();
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing");
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    expect((await pairing.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("pairing-reject is forwarded and closes the pairing socket with 4003", async () => {
    const mac = new TestDevice("MBP");
    const phone = new TestDevice("iPhone");
    const agent = await connect(mac.fp);
    await authenticate(agent, mac, "agent");
    await agent.nextCtrl();
    const pairing = await connect(mac.fp);
    await authenticate(pairing, phone, "pairing");
    pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: box() });
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "pairing-reject", phoneFp: phone.fp, reason: "bad-code" });
    expect(await pairing.nextCtrl()).toEqual({ type: "pairing-reject", phoneFp: phone.fp, reason: "bad-code" });
    expect((await pairing.closed).code).toBe(4003);
    agent.ws.close();
  });

  it("agent unpair removes the row and closes the phone with 4004", async () => {
    const { mac, phone, agent } = await pairedSetup();
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl(); // phone-connected
    agent.sendCtrl(mac.fp, { type: "unpair", phoneFp: phone.fp });
    expect((await p.closed).code).toBe(4004);
    const again = await connect(mac.fp);
    expect(await authenticate(again, phone, "phone")).toEqual({ type: "auth-fail", reason: "not-paired" });
    agent.ws.close();
  });

  it("phone can unpair itself; it is forwarded to the agent", async () => {
    const { mac, phone, agent } = await pairedSetup();
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl(); // phone-connected
    p.sendCtrl(phone.fp, { type: "unpair", phoneFp: phone.fp });
    expect(await agent.nextCtrl()).toEqual({ type: "unpair", phoneFp: phone.fp });
    expect((await p.closed).code).toBe(4004);
    agent.ws.close();
  });

  it("phone cannot unpair a different phone", async () => {
    const { mac, phone, agent } = await pairedSetup();
    const p = await connect(mac.fp);
    await authenticate(p, phone, "phone");
    await agent.nextCtrl();
    p.sendCtrl(phone.fp, { type: "unpair", phoneFp: "z".repeat(26) });
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm test` → pairing tests time out / fail.

- [ ] **Step 3: Implement the three ctrl handlers**

Replace the three stub methods in `computer-do.ts`:
```ts
  private async onAgentCtrl(ws: WebSocket, msg: CtrlMessage): Promise<void> {
    switch (msg.type) {
      case "pairing-add": {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO pairings (phone_fp, ed25519_pub, name, paired_at, last_seen) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(phone_fp) DO UPDATE SET ed25519_pub = excluded.ed25519_pub, name = excluded.name, paired_at = excluded.paired_at`,
          msg.phoneFp,
          msg.ed25519Pub.buffer.slice(msg.ed25519Pub.byteOffset, msg.ed25519Pub.byteOffset + 32),
          msg.name,
          now,
        );
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
      case "unpair":
        this.removePairing(msg.phoneFp);
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
        this.removePairing(msg.phoneFp);
        return;
      }
      case "push-token":
        this.ctx.storage.sql.exec("UPDATE pairings SET push_token = ?, push_platform = ? WHERE phone_fp = ?", msg.token, msg.platform, att.fp);
        return;
      default:
        ws.close(4403, `phone may not send ${msg.type}`);
    }
  }

  private async onPairingCtrl(ws: WebSocket, att: Attachment, msg: CtrlMessage): Promise<void> {
    if (msg.type !== "pairing-request" || msg.phoneFp !== att.fp || (att as Attachment & { used?: boolean }).used) {
      ws.close(4403, "one pairing-request only");
      return;
    }
    const agent = this.agentSocket();
    if (!agent) {
      this.sendCtrl(ws, { type: "pairing-reject", phoneFp: msg.phoneFp, reason: "no-agent" });
      ws.close(4003, "no-agent");
      return;
    }
    this.setState(ws, { ...att, used: true } as Attachment);
    this.sendCtrl(agent, msg);
  }

  private removePairing(phoneFp: string): void {
    this.ctx.storage.sql.exec("DELETE FROM pairings WHERE phone_fp = ?", phoneFp);
    this.ctx.storage.sql.exec("DELETE FROM push_limits WHERE phone_fp = ?", phoneFp);
    for (const s of this.phoneSockets(phoneFp)) s.close(4004, "unpaired");
  }

  private async onNotify(_msg: Extract<CtrlMessage, { type: "notify" }>): Promise<void> {
    // Task 5
  }
```

Also extend the `Attachment` interface with `used?: boolean` (pairing sockets only).

- [ ] **Step 4: Run tests to verify they pass** — `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): pairing forward/gate, pairing-add persistence, unpair"
```

---

### Task 4: E2E frame routing (spec 7.2, 9.2)

**Files:**
- Create: `apps/relay/test/routing.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — implement `onE2E`

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/routing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Envelope } from "@shellbell/protocol";
import { authenticate, connect, TestDevice } from "./helpers.js";

async function pairAndConnect() {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const agent = await connect(mac.fp);
  await authenticate(agent, mac, "agent");
  await agent.nextCtrl();
  const pairing = await connect(mac.fp);
  await authenticate(pairing, phone, "pairing");
  pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: { n: new Uint8Array(24), c: new Uint8Array(1) } });
  await agent.nextCtrl();
  agent.sendCtrl(mac.fp, { type: "pairing-add", phoneFp: phone.fp, ed25519Pub: phone.id.ed25519.pub, name: "iPhone" });
  agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: { n: new Uint8Array(24), c: new Uint8Array(1) } });
  await pairing.nextCtrl();
  pairing.ws.close();
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl(); // phone-connected
  return { mac, phone, agent, p };
}

const e2e = (from: string, to: string, seq: number, c: number[]): Envelope => ({
  v: 1,
  t: "e2e",
  from,
  to,
  seq,
  body: { n: new Uint8Array(24), c: new Uint8Array(c) },
});

describe("e2e routing", () => {
  it("phone → agent and agent → phone, bytes preserved", async () => {
    const { mac, phone, agent, p } = await pairAndConnect();
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
    const { mac, agent, p } = await pairAndConnect();
    p.sendEnvelope(e2e("q".repeat(26), mac.fp, 1, [1]));
    expect((await p.closed).code).toBe(4403);
    agent.ws.close();
  });

  it("drops frames to a disconnected peer silently", async () => {
    const { mac, phone, agent, p } = await pairAndConnect();
    agent.ws.close();
    await agent.closed;
    p.sendEnvelope(e2e(phone.fp, mac.fp, 1, [1]));
    // socket stays open; a presence(false) was sent first
    const pres = await p.nextCtrl();
    expect(pres).toMatchObject({ type: "presence", agentOnline: false });
    await expect(p.next(300)).rejects.toThrow(/timeout/);
    p.ws.close();
  });

  it("unauthenticated socket cannot send e2e", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendEnvelope(e2e(mac.fp, mac.fp, 1, [1]));
    expect((await c.closed).code).toBe(4403);
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
    const targets = att.state === "agent" ? this.phoneSockets(env.to) : env.to === this.fp ? [this.agentSocket()].filter((s): s is WebSocket => s !== null) : [];
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
git commit -m "feat(relay): forward e2e frames between agent and paired phones"
```

---

### Task 5: Notify → Expo push with rate limits (spec 9.2 Push, 11)

**Files:**
- Create: `apps/relay/src/push.ts`, `apps/relay/test/push.test.ts`
- Modify: `apps/relay/src/computer-do.ts` — implement `onNotify`

**Interfaces:**
- Produces (`push.ts`): `pushBody(kind, exitCode?, durationMs?): string`, `formatDuration(ms): string`, `sendExpoPush(messages: ExpoMessage[], accessToken: string | undefined, fetchImpl?: typeof fetch): Promise<{ deadTokens: string[] }>`, `interface ExpoMessage { to: string; title: string; body: string; data: Record<string, string>; sound: "default"; priority: "high"; channelId: "rings"; categoryId: "ring" }`.

- [ ] **Step 1: Write the failing tests**

`apps/relay/test/push.test.ts`:
```ts
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatDuration, pushBody } from "../src/push.js";
import { authenticate, connect, TestDevice } from "./helpers.js";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function pairedWithToken() {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const agent = await connect(mac.fp);
  await authenticate(agent, mac, "agent");
  await agent.nextCtrl();
  const pairing = await connect(mac.fp);
  await authenticate(pairing, phone, "pairing");
  pairing.sendCtrl(phone.fp, { type: "pairing-request", phoneFp: phone.fp, box: { n: new Uint8Array(24), c: new Uint8Array(1) } });
  await agent.nextCtrl();
  agent.sendCtrl(mac.fp, { type: "pairing-add", phoneFp: phone.fp, ed25519Pub: phone.id.ed25519.pub, name: "iPhone" });
  agent.sendCtrl(mac.fp, { type: "pairing-response", phoneFp: phone.fp, box: { n: new Uint8Array(24), c: new Uint8Array(1) } });
  await pairing.nextCtrl();
  pairing.ws.close();
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl();
  p.sendCtrl(phone.fp, { type: "push-token", token: "ExponentPushToken[abc]", platform: "ios" });
  return { mac, phone, agent, p };
}

describe("push text", () => {
  it("formats durations and bodies", () => {
    expect(formatDuration(43_000)).toBe("43s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(pushBody("prompt", 0, 43_000)).toBe("A command finished — exit 0 after 43s");
    expect(pushBody("idle")).toBe("A session went quiet — waiting for you?");
    expect(pushBody("bell")).toBe("A session rang the bell");
  });
});

describe("notify → push", () => {
  it("pushes to a disconnected paired phone, not to a connected one", async () => {
    const { mac, agent, p } = await pairedWithToken();
    // connected: no push expected (no interceptor registered → would throw on net connect)
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "iterm2:s1", kind: "prompt", exitCode: 0, durationMs: 43_000, mutedFor: [] });
    await new Promise((r) => setTimeout(r, 50));
    p.ws.close();
    await agent.nextCtrl(); // phone-disconnected

    let sent: unknown;
    fetchMock
      .get("https://exp.host")
      .intercept({ path: "/--/api/v2/push/send", method: "POST" })
      .reply(200, (req) => {
        sent = JSON.parse(req.body as string);
        return { data: [{ status: "ok" }] };
      });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "iterm2:s2", kind: "idle", durationMs: 5000, mutedFor: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([
      {
        to: "ExponentPushToken[abc]",
        title: "MBP",
        body: "A session went quiet — waiting for you?",
        data: { computerFp: mac.fp, sessionId: "iterm2:s2", kind: "idle" },
        sound: "default",
        priority: "high",
        channelId: "rings",
        categoryId: "ring",
      },
    ]);
    agent.ws.close();
  });

  it("rate-limits one ring per session per 60s and honours mutedFor", async () => {
    const { mac, phone, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    let calls = 0;
    fetchMock.get("https://exp.host").intercept({ path: "/--/api/v2/push/send", method: "POST" }).reply(200, () => {
      calls++;
      return { data: [{ status: "ok" }] };
    }).persist();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle", mutedFor: [] });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle", mutedFor: [] });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "t", kind: "idle", mutedFor: [phone.fp] });
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(1);
    agent.ws.close();
  });

  it("clears a token Expo reports as DeviceNotRegistered", async () => {
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    let calls = 0;
    fetchMock.get("https://exp.host").intercept({ path: "/--/api/v2/push/send", method: "POST" }).reply(200, () => {
      calls++;
      return { data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] };
    }).persist();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s1", kind: "idle", mutedFor: [] });
    await new Promise((r) => setTimeout(r, 100));
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s2", kind: "idle", mutedFor: [] });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(1); // second notify had no token to send to
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

export function pushBody(kind: EventKind, exitCode?: number, durationMs?: number): string {
  switch (kind) {
    case "prompt": {
      const exit = exitCode === undefined ? "" : ` — exit ${exitCode}`;
      const dur = durationMs === undefined ? "" : ` after ${formatDuration(durationMs)}`;
      return `A command finished${exit}${dur}`;
    }
    case "idle":
      return "A session went quiet — waiting for you?";
    case "bell":
      return "A session rang the bell";
    case "exit":
      return "A session ended";
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

- [ ] **Step 4: Implement `onNotify` in the DO**

```ts
  private async onNotify(msg: Extract<CtrlMessage, { type: "notify" }>): Promise<void> {
    const now = Date.now();
    const last = this.ctx.storage.sql
      .exec<{ last_ring_at: number }>("SELECT last_ring_at FROM ring_limits WHERE session_id = ?", msg.sessionId)
      .toArray()[0];
    if (last && now - last.last_ring_at < 60_000) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO ring_limits (session_id, last_ring_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_ring_at = excluded.last_ring_at",
      msg.sessionId,
      now,
    );

    const connected = new Set(this.socketsByState("phone").map((s) => (s.deserializeAttachment() as Attachment).fp));
    const muted = new Set(msg.mutedFor);
    const rows = this.ctx.storage.sql
      .exec<{ phone_fp: string; push_token: string }>("SELECT phone_fp, push_token FROM pairings WHERE push_token IS NOT NULL")
      .toArray();
    const title = this.computerName() ?? "Shellbell";
    const messages: ExpoMessage[] = [];
    for (const row of rows) {
      if (connected.has(row.phone_fp) || muted.has(row.phone_fp)) continue;
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
    if (row.count >= 20) return false;
    this.ctx.storage.sql.exec("UPDATE push_limits SET count = count + 1 WHERE phone_fp = ?", phoneFp);
    return true;
  }
```

Add the imports at the top of `computer-do.ts`: `import { pushBody, sendExpoPush, type ExpoMessage } from "./push.js";`

- [ ] **Step 5: Run tests to verify they pass** — `pnpm test`. All four test files green.

- [ ] **Step 6: Commit**

```bash
git add apps/relay
git commit -m "feat(relay): notify → Expo push with per-session and per-phone limits"
```

---

### Task 6: Local dev script, deploy workflow, self-hosting doc

**Files:**
- Create: `scripts/e2e-local.sh`, `.github/workflows/deploy-relay.yml`, `docs/self-hosting.md`

- [ ] **Step 1: Dev script**

`scripts/e2e-local.sh`:
```bash
#!/usr/bin/env bash
# Runs the relay locally. The agent (Plan 03) is started with:
#   pnpm -F shellbell dev -- --relay ws://localhost:8787
# Phones on the same Wi-Fi need the LAN IP instead of localhost; print it for convenience.
set -euo pipefail
cd "$(dirname "$0")/../apps/relay"
IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
echo "Relay dev server: ws://localhost:8787  (LAN: ws://${IP}:8787)"
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
3. (Optional, for push notifications) create an Expo access token at expo.dev → Account → Access tokens, then
   `pnpm wrangler secret put EXPO_ACCESS_TOKEN`. Without it, pushes still work but are unauthenticated to Expo.
4. `pnpm wrangler deploy` → note the `https://shellbell-relay.<account>.workers.dev` URL.
5. On each Mac: `shellbell config set relay wss://shellbell-relay.<account>.workers.dev`, then `shellbell pair`.
   The QR carries the relay URL, so phones need no configuration.

The relay never sees terminal content: everything between phone and Mac is end-to-end encrypted.
It stores: computer name, paired phone public keys and names, Expo push tokens, and rate-limit counters.
```

- [ ] **Step 4: Verify `wrangler dev` starts**

Run: `./scripts/e2e-local.sh` (Ctrl-C after it prints "Ready on http://0.0.0.0:8787"), then in another terminal `curl -s localhost:8787/healthz` → `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-local.sh .github/workflows/deploy-relay.yml docs/self-hosting.md
git commit -m "chore(relay): local dev script, deploy workflow, self-hosting guide"
```

---

## Plan self-review

- **Spec coverage:** 6.5 auth → Task 2; 6.4 pairing gating (relay side) → Task 3; 7.2 envelope handling + `from` check → Tasks 2/4; 7.3 every ctrl type is either handled or rejected per role → Tasks 2/3/5; 9.1 routes → Task 1; 9.2 storage, hibernation, alarm sweep, supersede, presence, phone-connected/disconnected → Task 2; push rules 9.2/11.3 → Task 5; 9.3 config → Task 1; close codes (12) → Tasks 2–4; 15 relay tests → Tasks 1–5; 16 deploy + self-hosting → Task 6.
- **Type consistency:** `Attachment` fields are used identically across tasks; `sendCtrl` always takes a `CtrlMessage`; the pairing socket's `used` flag is added to `Attachment` in Task 3; `ExpoMessage` shape in `push.ts` matches the test's expected JSON exactly.
- **Placeholders:** none. GitHub org in `index.ts` info URL should be updated to the real repo when it exists (it is a display string only).
