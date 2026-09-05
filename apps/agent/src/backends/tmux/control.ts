import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Logger } from "../../log.js";

/**
 * From `docs/spike-tmux.md` (tmux 3.7c): ESC arrives as a literal 0x1B byte inside `%begin`/`%end`,
 * so reply lines need no unescaping. Only `%output` payloads are octal-escaped, and we ignore their
 * data entirely (they are a "screen changed" signal, nothing more).
 */
export const UNESCAPE_OCTAL = false;

export function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function unescapeOctal(s: string): string {
  return s.replace(/\\(\\|[0-7]{3})/g, (_m, g: string) =>
    g === "\\" ? "\\" : String.fromCharCode(Number.parseInt(g, 8)),
  );
}

/**
 * Spec 8.10: a control-channel command line can contain the user's keystrokes
 * (`send-keys -t %1 -l -- 'hunter2'`). Only the verb may ever reach a log or an Error message.
 */
export function verbOf(line: string): string {
  return line.trim().split(/\s+/, 1)[0] || "?";
}

export interface TmuxControlOptions {
  sessionId: string;
  socketName?: string;
  log: Logger;
  spawnImpl?: typeof spawn;
  commandTimeoutMs?: number;
  readyTimeoutMs?: number;
}

interface Pending {
  resolve: (lines: string[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  verb: string;
}

export class TmuxControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  private child: ChildProcess | null = null;
  private queue: Pending[] = [];
  private current: { lines: string[] } | null = null;
  private currentPending: Pending | null = null;
  private started = false;
  private readyTimer: NodeJS.Timeout | null = null;
  alive = false;
  private readonly log: Logger;

  constructor(private readonly opts: TmuxControlOptions) {
    super();
    this.log = opts.log.child({ backend: "tmux", session: opts.sessionId });
  }

  start(): Promise<void> {
    const args = [
      ...(this.opts.socketName ? ["-L", this.opts.socketName] : []),
      "-C",
      "attach-session",
      "-t",
      this.opts.sessionId,
      "-f",
      "ignore-size",
    ];
    const child = (this.opts.spawnImpl ?? spawn)("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    let firstBlock: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      firstBlock = resolve;
      // Bounded: a server that never answers must not wedge `connect()` forever.
      this.readyTimer = setTimeout(resolve, this.opts.readyTimeoutMs ?? 2000);
      this.readyTimer.unref?.();
    });
    const settleReady = () => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      firstBlock?.();
    };
    rl.on("line", (line) => {
      if (line.startsWith("%begin")) {
        this.current = { lines: [] };
        this.currentPending = this.started ? (this.queue.shift() ?? null) : null;
        return;
      }
      if (line.startsWith("%end") || line.startsWith("%error")) {
        const block = this.current;
        const pending = this.currentPending;
        this.current = null;
        this.currentPending = null;
        if (!this.started) {
          this.started = true;
          settleReady();
          return;
        }
        if (pending) {
          clearTimeout(pending.timer);
          if (line.startsWith("%error")) {
            // spec 8.10: the %error body echoes the command, which can carry keystrokes.
            pending.reject(new Error(`tmux error: ${pending.verb}`));
          } else {
            pending.resolve(
              (block?.lines ?? []).map((l) => (UNESCAPE_OCTAL ? unescapeOctal(l) : l)),
            );
          }
        }
        return;
      }
      // NB: tmux never interleaves notifications inside a %begin/%end block, so collecting every
      // non-terminator line into the open block is safe and is what keeps replies correlated.
      if (this.current) {
        this.current.lines.push(line);
        return;
      }
      if (line.startsWith("%output ")) {
        const pane = line.slice(8).split(" ")[0];
        if (pane) this.emit("output", pane);
        return;
      }
      if (
        /^%(layout-change|window-add|window-close|window-renamed|unlinked-window-|session-changed|session-renamed|sessions-changed)/.test(
          line,
        )
      ) {
        this.emit("layout");
        return;
      }
      if (line.startsWith("%exit")) this.onExit();
    });
    rl.on("close", () => this.onExit());
    child.on("exit", () => this.onExit());
    // Without this, `spawn("tmux")` on a machine with no tmux emits an 'error' event with no
    // listener, which Node throws as an UNCAUGHT exception and kills the agent.
    child.on("error", (err) => {
      this.log.warn("tmux control spawn failed", { error: err.name });
      settleReady();
      this.onExit();
    });
    // EPIPE on a dead child's stdin must not surface as an unhandled stream error either.
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", () => {
      // spec 8.10: tmux's stderr can echo the command line we wrote, keystrokes included.
      // Record only that there WAS stderr, never its text.
      this.log.debug("tmux stderr");
    });
    return ready;
  }

  command(line: string): Promise<string[]> {
    const verb = verbOf(line);
    if (!this.alive || !this.child?.stdin) {
      return Promise.reject(new Error("tmux control exited"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error(`tmux command timeout: ${verb}`));
      }, this.opts.commandTimeoutMs ?? 5000);
      const pending: Pending = { resolve, reject, timer, verb };
      this.queue.push(pending);
      try {
        this.child?.stdin?.write(`${line}\n`);
      } catch {
        clearTimeout(timer);
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error("tmux control exited"));
      }
    });
  }

  /** Idempotent: safe to call from `close()`, from `onExit`, and again by a caller. */
  stop(): void {
    if (this.child) {
      try {
        this.child.stdin?.write("detach-client\n");
      } catch {
        // the child is already gone; nothing to detach
      }
      this.child.kill();
    }
    this.onExit();
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    for (const p of [this.currentPending, ...this.queue]) {
      if (!p) continue;
      clearTimeout(p.timer);
      p.reject(new Error("tmux control exited"));
    }
    this.queue = [];
    this.currentPending = null;
    this.emit("exit");
  }
}
