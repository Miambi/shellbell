import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
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

/** True if `pid` names a process we could plausibly signal (alive, ours or not). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we can't signal it -- still alive. ESRCH (or anything else):
    // no such process, i.e. a stale pid file left behind by a crash.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ControlServer {
  private server: Server | null = null;
  private pending = new Map<string, (accept: boolean) => void>();
  private pairClients = new Set<Socket>();
  /** The agent's confirm hook: resolves when a `confirm` command arrives (or after 60 s → false). */
  readonly pairingConfirm = (phoneFp: string, name: string): Promise<boolean> =>
    new Promise((resolve) => {
      if (this.pending.has(phoneFp)) {
        // Should not happen: PairingManager itself refuses a second concurrent request
        // (`pendingFp !== null` -> "too-many"). Guard anyway rather than clobber the first
        // caller's resolver.
        this.log.warn(
          "pairing confirm requested twice for the same phone; declining the newer one",
          {
            phone: phoneFp.slice(0, 8),
          },
        );
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(phoneFp);
        resolve(false);
      }, 60_000);
      this.pending.set(phoneFp, (accept) => {
        clearTimeout(timer);
        this.pending.delete(phoneFp);
        resolve(accept);
      });
      for (const c of this.pairClients)
        c.write(`${JSON.stringify({ event: "request", phoneFp, name })}\n`);
    });

  constructor(
    private readonly sockPath: string,
    private readonly agent: Agent,
    private readonly log: Logger,
    /** Optional pid-file path: when given, `start()` refuses to run over a still-live daemon and
     * `stop()` cleans it up alongside the socket. */
    private readonly pidPath?: string,
  ) {}

  get hasPairClients(): boolean {
    return this.pairClients.size > 0;
  }

  /** Broadcasts `{event:"closed"}` to every client currently watching a pairing window, then
   * stops tracking them -- a fresh `pair-open` re-subscribes. Call whenever the window closes
   * (expiry, explicit close, a completed pairing, too many bad codes). */
  notifyClosed(): void {
    for (const c of this.pairClients) c.write(`${JSON.stringify({ event: "closed" })}\n`);
    this.pairClients.clear();
  }

  async start(): Promise<void> {
    if (this.pidPath && existsSync(this.pidPath)) {
      const pid = Number(readFileSync(this.pidPath, "utf8").trim());
      if (isProcessAlive(pid)) {
        throw new Error(
          `shellbell is already running (pid ${pid}); stop it first or remove ${this.pidPath}`,
        );
      }
      unlinkSync(this.pidPath);
    }
    if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
    this.server = createServer((socket) => this.handle(socket));
    // §8.2: agent.sock must be 0600. `listen()` creates it as 0777 & ~umask, then `chmodSync`
    // below narrows it -- but that leaves a window where the socket is momentarily
    // world-connectable. Tightening the process umask around the call closes that window too
    // (belt as well as the `chmodSync` brace below; fully mitigated regardless by `~/.shellbell`
    // already being 0700).
    const prevUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.sockPath, () => resolve());
      });
    } finally {
      process.umask(prevUmask);
    }
    chmodSync(this.sockPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const c of this.pairClients) c.destroy();
    this.pairClients.clear();
    await new Promise<void>((r) => this.server?.close(() => r()));
    if (existsSync(this.sockPath)) unlinkSync(this.sockPath);
    if (this.pidPath && existsSync(this.pidPath)) unlinkSync(this.pidPath);
  }

  private handle(socket: Socket): void {
    const rl = createInterface({ input: socket });
    // See the comment in `controlRequest`: readline's own emitter needs its own error listener,
    // separate from the socket's -- an abrupt client disconnect (ECONNRESET) must not crash the
    // whole agent process.
    rl.on("error", () => {});
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
          phones: a.pairingList.map((p) => ({
            phoneFp: p.phoneFp,
            name: p.name,
            lastSeenAt: p.lastSeenAt,
          })),
          connected: a.connectedPhones,
        } satisfies StatusData;
      case "devices":
        return a.pairingList.map((p) => ({
          phoneFp: p.phoneFp,
          name: p.name,
          lastSeenAt: p.lastSeenAt,
        }));
      case "unpair":
        return { removed: a.unpair(String(req.args?.target ?? "")) };
      case "pair-open": {
        // Open first: openPairing() may synchronously close a previous window, which broadcasts
        // `closed` to every registered client -- this client must not be one of them yet.
        const opened = a.openPairing();
        this.pairClients.add(socket);
        return opened;
      }
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

const REQUEST_TIMEOUT_MS = 5_000;

export function controlRequest(
  sockPath: string,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = createConnection(sockPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("control socket timed out"));
    }, REQUEST_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    socket.on("error", (err) => finish(() => reject(err)));
    socket.once("connect", () => socket.write(`${JSON.stringify({ cmd, args })}\n`));
    const rl = createInterface({ input: socket });
    // readline's own EventEmitter throws if its input stream errors and nothing is listening on
    // the *Interface* itself -- the socket's own "error" listener above does not cover this; it
    // is a separate emitter. The real handling happens above; this just prevents a second,
    // unhandled "error" event on `rl` from crashing the process.
    rl.on("error", () => {});
    rl.once("line", (line) => {
      socket.end();
      finish(() => {
        let res: { ok: boolean; data?: unknown; error?: string };
        try {
          res = JSON.parse(line) as { ok: boolean; data?: unknown; error?: string };
        } catch {
          reject(new Error("control socket sent a malformed response"));
          return;
        }
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error ?? "control error"));
      });
    });
  });
}

/** Streaming pair session: opens a window and reports requests until the socket closes. */
export function controlPairSession(
  sockPath: string,
  handlers: {
    onOpen: (qrText: string, expiresAt: number) => void;
    onRequest: (phoneFp: string, name: string) => Promise<boolean>;
    /** The pairing window this session opened has closed (expiry, success, or explicit close). */
    onClose: () => void;
    onError: (e: Error) => void;
  },
): { close: () => void } {
  const socket = createConnection(sockPath);
  socket.on("error", handlers.onError);
  socket.once("connect", () => socket.write(`${JSON.stringify({ cmd: "pair-open" })}\n`));
  const rl = createInterface({ input: socket });
  // See the comment in `controlRequest`: readline's own emitter needs its own listener too.
  rl.on("error", () => {});
  rl.on("line", (line) => {
    let m: {
      ok?: boolean;
      data?: { qrText: string; expiresAt: number };
      event?: string;
      phoneFp?: string;
      name?: string;
      error?: string;
    };
    try {
      m = JSON.parse(line);
    } catch {
      handlers.onError(new Error("control socket sent a malformed message"));
      return;
    }
    if (m.event === "request" && m.phoneFp) {
      void handlers
        .onRequest(m.phoneFp, m.name ?? "")
        .then((accept) =>
          socket.write(
            `${JSON.stringify({ cmd: "confirm", args: { phoneFp: m.phoneFp, accept } })}\n`,
          ),
        )
        // `askYesNo` never rejects today, but `socket.write` on an already-destroyed socket
        // throws -- without this the rejection would escape as an unhandled rejection.
        .catch((e) => handlers.onError(e as Error));
    } else if (m.event === "closed") {
      handlers.onClose();
    } else if (m.ok && m.data?.qrText) handlers.onOpen(m.data.qrText, m.data.expiresAt);
    else if (m.ok === false) handlers.onError(new Error(m.error ?? "control error"));
  });
  return { close: () => socket.end() };
}
