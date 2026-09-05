import { connect as netConnect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../../log.js";
import { BackendUnavailable } from "../types.js";
import type { HerdrEvent, Pong } from "./types.js";

/**
 * Spec 8.13: the JSON-API floor is a SEMVER version, not `ping.protocol` (which is herdr's binary
 * client/server generation and bumps for reasons that do not affect this API). `session.snapshot`
 * landed in 0.7.2 and is the feature probe the backend and `doctor` run as the second gate.
 */
export const MIN_VERSION: [number, number, number] = [0, 7, 2];
export const INSTALL_HINT =
  'Install Herdr: curl -fsSL https://herdr.dev/install.sh | sh, then start it with "herdr".';
export const UPGRADE_HINT =
  "Upgrade Herdr to 0.7.2 or newer: curl -fsSL https://herdr.dev/install.sh | sh, then restart it.";
/** Herdr's own per-line cap (`src/api/server.rs`): 1 MiB, counted in BYTES. */
const MAX_LINE_BYTES = 1_048_576;

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`herdr ${code}: ${message}`);
    this.name = "HerdrError";
  }
}

/** Herdr error codes that mean "that pane target is stale" (spec 8.13: trigger a resync). */
export const GONE_CODES = new Set(["not_found", "pane_not_found", "stale_pane_target"]);
/** Codes that mean "this build does not have that method" — the feature probe's failure modes. */
export const UNSUPPORTED_CODES = new Set([
  "invalid_request",
  "unsupported",
  "unknown_method",
  "method_not_found",
]);

export interface HerdrStream {
  close(): void;
}

export interface HerdrStreamHandlers {
  onEvent(e: HerdrEvent): void;
  /** Called once, after the ack, when the stream dies: "eof" | "error" | "closed" | "overflow". */
  onEnd(reason: string): void;
}

export interface HerdrClientOptions {
  log: Logger;
  socketPath?: string;
  requestTimeoutMs?: number;
}

interface WireResponse {
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: string;
  data?: unknown;
}

/** `null` when `version` is not semver-shaped (a dev build): the caller lets the probe decide. */
export function semverAtLeast(version: string, min: [number, number, number]): boolean | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const a = got[i] as number;
    const b = min[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Spec 8.13: `$HERDR_SOCKET_PATH`, else — when `$HERDR_SESSION` names a session —
 * `<config>/herdr/sessions/<name>/herdr.sock`, else `<config>/herdr/herdr.sock`, where `<config>`
 * is `$XDG_CONFIG_HOME` or `~/.config`.
 *
 * ⚠ The macOS default is the one thing here that is READ FROM THE RUST SOURCE BUT NOT YET
 * OBSERVED ON A MAC: research §1 shows the config dir resolving through `$XDG_CONFIG_HOME` →
 * `~/.config` with no `~/Library/Application Support` branch, and spec 8.13 states that as fact,
 * but the research's own spike checklist still lists it as unconfirmed. **Spike question 1 must
 * print the socket path herdr actually created on macOS.** If it turns out to live under
 * `~/Library/Application Support/herdr/`, this function needs a second candidate (probe both with
 * `existsSync` and prefer the one that exists) — nothing else in the plan changes, because every
 * caller already treats "no socket" as "herdr is not installed". Users are never stuck meanwhile:
 * `$HERDR_SOCKET_PATH` overrides everything.
 */
export function herdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.HERDR_SOCKET_PATH;
  if (explicit) return explicit;
  const config = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "herdr")
    : join(home, ".config", "herdr");
  const session = env.HERDR_SESSION;
  return session ? join(config, "sessions", session, "herdr.sock") : join(config, "herdr.sock");
}

function socketError(err: NodeJS.ErrnoException, method: string, path: string): HerdrError {
  const code = err.code ?? "";
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "EPERM")
    return new HerdrError("unavailable", `cannot reach the herdr socket at ${path} (${code})`);
  return new HerdrError("socket", `${method}: ${err.message}`);
}

/**
 * Feeds complete NDJSON lines to `onLine`. A `StringDecoder` is required, not `chunk.toString()`:
 * a styled `pane.read` carries multi-byte UTF-8 that can straddle a chunk boundary. Complete lines
 * are drained BEFORE the size check, so a chunk holding many valid lines is never rejected; only an
 * unterminated line longer than 1 MiB (in bytes) trips `onOverflow`.
 */
function pipeLines(socket: Socket, onLine: (line: string) => void, onOverflow: () => void): void {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
      i = buf.indexOf("\n");
    }
    if (Buffer.byteLength(buf, "utf8") > MAX_LINE_BYTES) {
      buf = "";
      onOverflow();
    }
  });
}

export class HerdrClient {
  private readonly log: Logger;
  private nextId = 1;

  constructor(private readonly opts: HerdrClientOptions) {
    this.log = opts.log.child({ unit: "herdr" });
  }

  get socketPath(): string {
    return this.opts.socketPath ?? herdrSocketPath();
  }

  /**
   * One request, one connection (research §1: the server reads exactly one line per connection and
   * then drops it). There is deliberately no request-id map and no pipelining; the echoed `id` is
   * decorative, so a mismatch is logged, not treated as an error.
   */
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `sb${this.nextId++}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    const path = this.socketPath;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const socket = netConnect({ path });
      const done = (err: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => done(new HerdrError("timeout", `${method} did not answer within ${timeoutMs} ms`)),
        timeoutMs,
      );
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      pipeLines(
        socket,
        (line) => {
          let msg: WireResponse;
          try {
            msg = JSON.parse(line) as WireResponse;
          } catch {
            done(new HerdrError("malformed", `${method} answered with a non-JSON line`));
            return;
          }
          if (msg.id !== undefined && msg.id !== id)
            this.log.debug("herdr echoed a different id", { method });
          if (msg.error) {
            done(new HerdrError(msg.error.code || "error", msg.error.message || method));
            return;
          }
          if (msg.result === undefined || msg.result === null) {
            done(new HerdrError("malformed", `${method} answered without a result`));
            return;
          }
          done(null, msg.result as T);
        },
        () => done(new HerdrError("overflow", `${method} answered with an oversized line`)),
      );
      socket.on("error", (err: NodeJS.ErrnoException) => done(socketError(err, method, path)));
      socket.on("close", () =>
        done(new HerdrError("closed", `herdr closed the connection before answering ${method}`)),
      );
    });
  }

  /**
   * Opens the long-lived event stream. Resolves once Herdr has acked with `subscription_started`;
   * after that, every bare `{"event":…,"data":…}` line reaches `onEvent`, and the stream dying
   * reaches `onEnd` exactly once. Herdr has no "add subscription" method, so changing the per-pane
   * subscription set means opening a new stream and closing this one (spec 8.13, two-phase).
   */
  subscribe(subscriptions: unknown[], handlers: HerdrStreamHandlers): Promise<HerdrStream> {
    const id = `sb${this.nextId++}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 5000;
    const path = this.socketPath;
    return new Promise<HerdrStream>((resolve, reject) => {
      const socket = netConnect({ path });
      let acked = false;
      let ended = false;
      let closedByUs = false;
      const stream: HerdrStream = {
        close() {
          closedByUs = true;
          socket.destroy();
        },
      };
      const failBeforeAck = (err: Error): void => {
        if (acked) return;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const end = (reason: string): void => {
        if (ended) return;
        ended = true;
        handlers.onEnd(closedByUs ? "closed" : reason);
      };
      const timer = setTimeout(
        () => failBeforeAck(new HerdrError("timeout", "events.subscribe was not acknowledged")),
        timeoutMs,
      );
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
        );
      });
      pipeLines(
        socket,
        (line) => {
          let msg: WireResponse;
          try {
            msg = JSON.parse(line) as WireResponse;
          } catch {
            this.log.warn("undecodable herdr stream line", { chars: line.length });
            return;
          }
          if (!acked) {
            if (msg.error) {
              failBeforeAck(
                new HerdrError(msg.error.code || "error", msg.error.message || "events.subscribe"),
              );
              return;
            }
            const type = (msg.result as { type?: string } | undefined)?.type;
            if (type !== "subscription_started") {
              failBeforeAck(new HerdrError("malformed", `events.subscribe answered ${type}`));
              return;
            }
            acked = true;
            clearTimeout(timer);
            resolve(stream);
            return;
          }
          // Event lines carry no `id`. The ack and the first events can arrive in one chunk, so
          // this can run before the caller's `await` resumes — the caller must arm its buffer
          // before calling `subscribe`.
          if (typeof msg.event === "string") {
            const data =
              msg.data && typeof msg.data === "object" ? (msg.data as Record<string, unknown>) : {};
            handlers.onEvent({ event: msg.event, data });
          }
        },
        () => {
          // An oversized line is unrecoverable: we have lost stream position either way.
          if (!acked) failBeforeAck(new HerdrError("overflow", "events.subscribe line too long"));
          else {
            socket.destroy();
            end("overflow");
          }
        },
      );
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (!acked) failBeforeAck(socketError(err, "events.subscribe", path));
        else end("error");
      });
      // A socket that dies before the ack must reject NOW, not after the 5 s ack timeout.
      socket.on("close", () => {
        if (!acked) {
          failBeforeAck(
            new HerdrError("closed", "herdr closed the connection before acknowledging the stream"),
          );
          return;
        }
        end("eof");
      });
    });
  }

  /**
   * Discovery call. Throws `BackendUnavailable` (never `HerdrError`) so `connect()` and `doctor`
   * both get an actionable hint: no socket -> install/start Herdr; version < 0.7.2 -> upgrade. An
   * unparseable version is accepted with a warning — the `session.snapshot` feature probe run by
   * the caller is the second gate (spec 8.13).
   */
  async ping(): Promise<Pong> {
    let pong: Pong;
    try {
      pong = await this.request<Pong>("ping", {});
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BackendUnavailable(detail, INSTALL_HINT);
    }
    const version = typeof pong.version === "string" ? pong.version : "";
    const ok = semverAtLeast(version, MIN_VERSION);
    if (ok === false)
      throw new BackendUnavailable(
        `herdr ${version} is older than 0.7.2 (session.snapshot and scroll metrics landed there)`,
        UPGRADE_HINT,
      );
    if (ok === null)
      this.log.warn("herdr reported an unparseable version; relying on the feature probe", {
        version,
      });
    this.log.debug("herdr ping ok", { version, protocol: pong.protocol });
    return pong;
  }
}
