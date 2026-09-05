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
      x = {
        promptState: "unknown",
        commandStartedAt: null,
        command: "",
        lastChangeAt: 0,
        activeSince: null,
        lastPromptRingAt: Number.NEGATIVE_INFINITY,
      };
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
        this.emit("event", {
          type: "event",
          sessionId: e.sessionId,
          kind: "prompt",
          exitCode: e.exitCode,
          durationMs,
          command: x.command || undefined,
          at: now,
        });
        if (durationMs !== undefined && durationMs >= this.opts.notifyMinCommandMs) {
          x.lastPromptRingAt = now;
          x.activeSince = null;
          this.emit("ring", {
            sessionId: e.sessionId,
            kind: "prompt",
            exitCode: e.exitCode,
            durationMs,
          });
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
      if (!recentlyRang && x.promptState !== "editing")
        this.emit("ring", { sessionId: id, kind: "idle", durationMs });
    }
  }
}
