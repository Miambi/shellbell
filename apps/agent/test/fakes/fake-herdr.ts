import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface FakeHerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

interface Stream {
  socket: Socket;
  /** Subscription entries this connection asked for, verbatim. */
  subscriptions: { type: string; pane_id?: string }[];
}

/**
 * Stand-in for the Herdr socket server. It models the transport facts that shape our client
 * (research §1): **one request per connection** — the server reads exactly one line, answers it and
 * hangs up — NDJSON framing, and an `events.subscribe` connection that stays open, acks with
 * `subscription_started`, and then streams bare `{"event":…,"data":…}` lines carrying no `id`.
 * Events are delivered only to streams that actually subscribed to them, so subscription bugs
 * surface in tests instead of being papered over.
 */
export class FakeHerdr {
  readonly dir: string;
  readonly path: string;
  readonly requests: FakeHerdrRequest[] = [];
  /** Lines written on a connection after its first one: the real server never reads them. */
  readonly ignoredLines: string[] = [];
  connections = 0;
  /** What `pane.copy_motion` reports as `content_revision`; tests bump it. */
  revision = 2;
  /**
   * Events to write in the SAME buffer as the next `events.subscribe` ack. A real server can
   * coalesce the ack and the first event lines into one TCP chunk; this is how a test reproduces
   * that exactly, instead of writing them separately and calling it a coalesced chunk.
   */
  readonly ackRider: { event: string; data: Record<string, unknown> }[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  private readonly failures = new Map<string, { code: string; message: string }>();
  private readonly silenced = new Set<string>();
  private readonly streams = new Set<Stream>();
  /** Per-method reply gates: `dispatch` awaits one, if set, before answering that method. */
  private readonly gates = new Map<string, Promise<void>>();
  /**
   * EVERY accepted connection, not just the event streams. `stop()` must destroy all of them:
   * `server.close()` only stops accepting and its callback fires when the last connection ends,
   * so a connection the fake never answered (`silence()`) would otherwise wedge `stop()` forever.
   */
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  /**
   * `path` lets a test bind a chosen socket file (one that does not exist yet, or a restart). When
   * given, `dir` is attributed to that path's OWN directory rather than a freshly minted one: a
   * restart reuses the previous server's `dir` (recreated by `start()`, see below), and `stop()`'s
   * `rmSync(this.dir, ...)` must clean up that directory, not an unrelated, unused temp dir that
   * would otherwise leak on every restart test.
   */
  constructor(path?: string) {
    this.dir = path ? dirname(path) : mkdtempSync(join(tmpdir(), "sb-herdr-"));
    this.path = path ?? join(this.dir, "herdr.sock");
  }

  /**
   * Delays the fake's reply to `method` until the test calls the returned release function.
   * Lets a test create a race between an in-flight RPC and events arriving before it resolves
   * (e.g. `session.snapshot` vs. a `pane_agent_status_changed` event landing while it is pending).
   */
  gate(method: string): () => void {
    let release = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(method, gated);
    return () => {
      this.gates.delete(method);
      release();
    };
  }

  reply(method: string, fn: (params: Record<string, unknown>) => unknown): void {
    this.handlers.set(method, fn);
    this.failures.delete(method);
    this.silenced.delete(method);
  }
  fail(method: string, code: string, message = code): void {
    this.failures.set(method, { code, message });
  }
  /** Accept the request and never answer it — drives the timeout tests. */
  silence(method: string): void {
    this.silenced.add(method);
  }
  called(method: string): FakeHerdrRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
  get streamCount(): number {
    return this.streams.size;
  }
  /** The subscription list of the most recently opened stream. */
  get lastSubscriptions(): { type: string; pane_id?: string }[] {
    return [...this.streams].at(-1)?.subscriptions ?? [];
  }

  /** Deliver an event to every stream that subscribed to it (dotted subscription names). */
  pushEvent(event: string, data: Record<string, unknown> = {}): number {
    const dotted = event.replaceAll("_", ".");
    const line = `${JSON.stringify({ event, data })}\n`;
    let delivered = 0;
    for (const s of this.streams) {
      const match = s.subscriptions.some(
        (sub) =>
          (sub.type === event || sub.type === dotted) &&
          (sub.pane_id === undefined || sub.pane_id === data.pane_id),
      );
      if (!match) continue;
      s.socket.write(line);
      delivered++;
    }
    return delivered;
  }
  /** Write a raw line to every stream, bypassing subscription filtering (framing tests). */
  pushRaw(line: string): void {
    this.pushBytes(Buffer.from(line, "utf8"));
  }
  /** Write raw bytes to every stream — lets a test choose exactly where a chunk is split. */
  pushBytes(bytes: Buffer): void {
    for (const s of this.streams) s.socket.write(bytes);
  }
  /** `herdr server stop`: every open connection dies with EOF. */
  dropStreams(): void {
    for (const s of this.streams) s.socket.destroy();
    this.streams.clear();
  }

  start(): Promise<void> {
    // A restart test rebinds `this.path` after the ORIGINAL FakeHerdr's own temp dir has been
    // `rmSync`ed in `stop()`. On macOS, `net.Server.listen()` on a unix socket whose parent
    // directory does not exist fails with EACCES (not ENOENT), so the directory must be recreated
    // here rather than assumed to exist.
    mkdirSync(dirname(this.path), { recursive: true });
    const server = createServer((socket) => {
      this.connections++;
      this.sockets.add(socket);
      let first = true;
      let buf = "";
      const decoder = new StringDecoder("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (first) {
            first = false;
            this.dispatch(socket, line);
          } else {
            this.ignoredLines.push(line);
          }
          i = buf.indexOf("\n");
        }
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        for (const s of this.streams) if (s.socket === socket) this.streams.delete(s);
      });
    });
    this.server = server;
    return new Promise((resolve) => server.listen(this.path, () => resolve()));
  }

  /**
   * Closes the listener and removes the socket file, exactly like a herdr server exiting; also
   * removes the temp directory it was created in, so tests don't leak `sb-herdr-*` dirs.
   *
   * Every accepted connection is destroyed first — not just the registered event streams. A
   * connection parked by `silence()` was never added to `streams`, and `server.close()` waits for
   * the last connection to end before firing its callback, so without this `stop()` never resolves
   * and the test (plus its `afterEach`) hangs.
   */
  stop(): Promise<void> {
    this.dropStreams();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    const cleanup = () => rmSync(this.dir, { recursive: true, force: true });
    if (!server) {
      cleanup();
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      server.close(() => {
        cleanup();
        resolve();
      }),
    );
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let msg: { id?: string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      socket.end();
      return;
    }
    const method = msg.method ?? "";
    const params = msg.params ?? {};
    this.requests.push({ method, params });
    // `called(method)` already reflects this request; `gate()` only delays the ANSWER, so a test
    // can wait for the request to have arrived before racing something else against its reply.
    const gated = this.gates.get(method);
    if (gated) await gated;
    if (this.silenced.has(method)) return;
    const failure = this.failures.get(method);
    if (failure) {
      socket.end(`${JSON.stringify({ id: msg.id, error: failure })}\n`);
      return;
    }
    if (method === "events.subscribe") {
      const subscriptions = (params.subscriptions ?? []) as { type: string; pane_id?: string }[];
      this.streams.add({ socket, subscriptions });
      // NB: `events.subscribe` is handled HERE, before `this.handlers` is consulted, so a
      // `reply("events.subscribe", …)` would be dead code. `fail("events.subscribe", …)` above
      // still works, and `ackRider` is how a test makes the ack share a chunk with its events.
      let out = `${JSON.stringify({ id: msg.id, result: { type: "subscription_started" } })}\n`;
      for (const e of this.ackRider.splice(0)) out += `${JSON.stringify(e)}\n`;
      socket.write(out); // ONE write: ack + riders land in the same chunk
      return;
    }
    const handler = this.handlers.get(method) ?? this.defaultHandler(method);
    const value = handler(params);
    // A handler may answer with an error for SOME parameters by returning `{ __error: {…} }`
    // (e.g. `pane.read` refusing only `source:"recent"`), which `fail()` cannot express.
    if (value && typeof value === "object" && "__error" in value) {
      const error = (value as { __error: { code: string; message?: string } }).__error;
      socket.end(`${JSON.stringify({ id: msg.id, error })}\n`);
      return;
    }
    socket.end(`${JSON.stringify({ id: msg.id, result: value })}\n`);
  }

  private defaultHandler(method: string): (params: Record<string, unknown>) => unknown {
    switch (method) {
      case "ping":
        return () => ({
          type: "pong",
          version: "0.8.2",
          protocol: 22,
          capabilities: { live_handoff: true, detached_server_daemon: true },
        });
      case "pane.copy_motion":
        return (p) => ({
          type: "pane_copy_motion",
          pane_id: p.pane_id,
          cursor: p.cursor,
          content_revision: this.revision,
        });
      default:
        return () => ({ type: "ok" });
    }
  }
}
