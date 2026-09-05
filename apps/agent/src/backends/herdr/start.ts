import { existsSync } from "node:fs";
import { createLogger, type Logger } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
import { BackendUnavailable } from "../types.js";
import { HerdrBackend, type HerdrBackendOptions } from "./backend.js";
import {
  HerdrClient,
  HerdrError,
  INSTALL_HINT,
  UNSUPPORTED_CODES,
  UPGRADE_HINT,
} from "./client.js";
import type { SessionSnapshotResult } from "./types.js";

/** Structurally identical to `Check` in `src/doctor.ts`, so it drops straight into that list. */
export interface HerdrCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface CheckHerdrOptions {
  /** Optional so `doctor.ts`, which has no Logger, can call `checkHerdr()` with no arguments. */
  log?: Logger;
  socketPath?: string;
  client?: HerdrClient;
}

/**
 * Spec 8.13 (ruling 14): Herdr is OPTIONAL. `doctor` exits 1 if any check fails, so "not installed"
 * has to be a passing check — only a Herdr that is actually running and cannot be used is a
 * failure. When it is usable the line reads `herdr: v0.8.2 protocol 22`.
 */
export async function checkHerdr(opts: CheckHerdrOptions = {}): Promise<HerdrCheck> {
  const log = opts.log ?? createLogger({ stdout: false });
  const client =
    opts.client ?? new HerdrClient({ log, socketPath: opts.socketPath, requestTimeoutMs: 3000 });
  if (!existsSync(client.socketPath))
    return { name: "herdr", ok: true, detail: "not installed (optional)" };
  let pong: { version?: string; protocol?: number };
  try {
    pong = await client.ping();
  } catch (err) {
    if (err instanceof BackendUnavailable)
      return { name: "herdr", ok: false, detail: err.message, fix: err.hint };
    return { name: "herdr", ok: false, detail: String(err), fix: INSTALL_HINT };
  }
  // Gate 2 (ruling 12): the method that actually matters. `protocol` proves nothing about it.
  try {
    await client.request<SessionSnapshotResult>("session.snapshot", {});
  } catch (err) {
    const detail =
      err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code)
        ? `herdr ${pong.version ?? "?"} has no session.snapshot`
        : `session.snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    return { name: "herdr", ok: false, detail, fix: UPGRADE_HINT };
  }
  return {
    name: "herdr",
    ok: true,
    detail: `v${pong.version ?? "?"} protocol ${pong.protocol ?? "?"}`,
  };
}

export interface StartHerdrOptions {
  registry: BackendRegistry;
  log: Logger;
  socketPath?: string;
  client?: HerdrClient;
  /** Spec 8.12: retry every 10 s while the backend is absent. */
  retryMs?: number;
  /** Called once, with the pane count, when the backend connects — for the CLI's start banner. */
  onConnected?: (sessions: number) => void;
  backendOptions?: Omit<Partial<HerdrBackendOptions>, "client" | "log">;
}

/**
 * Spec 8.12/8.13: try Herdr at startup and every 10 s while it is not running.
 *
 * The backend is registered with the registry **before** `connect()` (ruling 11): `connect()` emits
 * `session-added` and the initial `agent-state` for every pane it discovers, and those must reach
 * the `EventEngine`, which only subscribes through the registry. A registered-but-disconnected
 * member reports `isConnected: false`, so it is not advertised in `hello.backends` until it is real.
 * Herdr not being installed is a perfectly normal state, so failures log at debug, never as errors.
 */
export function startHerdrBackend(opts: StartHerdrOptions): { stop(): void } {
  const log = opts.log.child({ unit: "herdr-start" });
  const client = opts.client ?? new HerdrClient({ log: opts.log, socketPath: opts.socketPath });
  const backend = new HerdrBackend({ client, log: opts.log, ...opts.backendOptions });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;

  opts.registry.add(backend);

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? 10_000);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || backend.isConnected) return;
    try {
      await backend.connect();
    } catch (err) {
      log.debug("herdr not available", {
        error: err instanceof Error ? err.message : String(err),
      });
      schedule();
      return;
    }
    if (stopped) return;
    log.info("herdr connected");
    if (opts.onConnected && !announced) {
      announced = true;
      const sessions = await backend.listSessions().catch(() => []);
      opts.onConnected(sessions.length);
    }
  };

  void attempt();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
    },
  };
}
