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
      for (const c of this.pairClients)
        c.write(`${JSON.stringify({ event: "request", phoneFp, name })}\n`);
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

export function controlRequest(
  sockPath: string,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
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
  handlers: {
    onOpen: (qrText: string, expiresAt: number) => void;
    onRequest: (phoneFp: string, name: string) => Promise<boolean>;
    onError: (e: Error) => void;
  },
): { close: () => void } {
  const socket = createConnection(sockPath);
  socket.once("error", handlers.onError);
  socket.once("connect", () => socket.write(`${JSON.stringify({ cmd: "pair-open" })}\n`));
  const rl = createInterface({ input: socket });
  rl.on("line", (line) => {
    const m = JSON.parse(line) as {
      ok?: boolean;
      data?: { qrText: string; expiresAt: number };
      event?: string;
      phoneFp?: string;
      name?: string;
      error?: string;
    };
    if (m.event === "request" && m.phoneFp) {
      void handlers
        .onRequest(m.phoneFp, m.name ?? "")
        .then((accept) =>
          socket.write(
            `${JSON.stringify({ cmd: "confirm", args: { phoneFp: m.phoneFp, accept } })}\n`,
          ),
        );
    } else if (m.ok && m.data?.qrText) handlers.onOpen(m.data.qrText, m.data.expiresAt);
    else if (m.ok === false) handlers.onError(new Error(m.error ?? "control error"));
  });
  return { close: () => socket.end() };
}
