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
    for (const [sessionId, at] of this.last) {
      if (sessionId !== r.sessionId && t - at >= RING_LIMIT_MS) this.last.delete(sessionId);
    }
    if (prev !== undefined && t - prev < RING_LIMIT_MS) return false;
    this.last.set(r.sessionId, t);
    this.send({
      type: "notify",
      sessionId: r.sessionId,
      kind: r.kind,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    });
    this.log.info("ring", { session: r.sessionId.slice(0, 12), kind: r.kind });
    return true;
  }

  /** Drop rate-limit state for a session, e.g. when it is removed. */
  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }

  /** @internal test-only: number of sessions currently tracked for rate-limiting. */
  get size(): number {
    return this.last.size;
  }
}
