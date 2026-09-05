import {
  encodeCbor,
  type InnerMessage,
  type Line,
  lineKey,
  stripStyles,
} from "@shellbell/protocol";
import type { Screen, TerminalBackend } from "./backends/types.js";
import type { Logger } from "./log.js";

export interface ScreenTrackerOptions {
  backend: TerminalBackend;
  sink: (connId: string, msg: InnerMessage) => void;
  log: Logger;
  intervalMs?: number;
  maxFramesPerSecond?: number;
  maxEncodedBytes?: number;
  now?: () => number;
}

interface SessionState {
  viewers: Map<string, { lastSentGen: number; forceSnapshot: boolean; skipped: number }>;
  dirty: boolean;
  inflight: boolean;
  lastKeys: string[];
  lastCols: number;
  lastRows: number;
  lastBackendScrollback: number | null;
  reported: number;
  gen: number;
}

interface Budget {
  windowStart: number;
  count: number;
}

const SNAPSHOT_RATIO = 0.6;
const OVERLAP_MAX_SHIFT = 16;
const OVERLAP_MIN_MATCH = 0.8;
/** Consecutive coalesced ticks after which a viewer's catch-up frame is sent degraded. */
const COALESCE_DEGRADE_TICKS = 3;

export class ScreenTracker {
  private readonly sessions = new Map<string, SessionState>();
  private readonly viewerSession = new Map<string, string>();
  /** ONE bucket for every sink call: they all share the agent's single relay socket. */
  private budget: Budget = { windowStart: 0, count: 0 };
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: ScreenTrackerOptions) {
    this.intervalMs = Math.max(125, opts.intervalMs ?? 125);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "tracker" });
  }

  start(): void {
    if (this.timer) return;
    // The tracker subscribes to the backend itself: `screen-changed` is the only event that means
    // "there is new output", and `session-removed` is the only one that invalidates our state.
    this.unsubscribe ??= this.opts.backend.on((e) => {
      if (e.type === "screen-changed") this.markDirty(e.sessionId);
      else if (e.type === "session-removed") this.sessionRemoved(e.sessionId);
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  setIntervalMs(ms: number): void {
    const next = Math.max(125, ms);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  setViewed(connId: string, sessionId: string | null): void {
    const prev = this.viewerSession.get(connId);
    if (prev) {
      this.sessions.get(prev)?.viewers.delete(connId);
      this.viewerSession.delete(connId);
    }
    if (!sessionId) return;
    const s = this.state(sessionId);
    s.viewers.set(connId, { lastSentGen: -1, forceSnapshot: true, skipped: 0 });
    s.dirty = true;
    this.viewerSession.set(connId, sessionId);
  }

  dropViewer(connId: string): void {
    this.setViewed(connId, null);
  }

  viewedBy(sessionId: string): string[] {
    return [...(this.sessions.get(sessionId)?.viewers.keys() ?? [])];
  }

  markDirty(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.viewers.size > 0) s.dirty = true;
  }

  forceSnapshot(connId: string, sessionId: string): void {
    const v = this.sessions.get(sessionId)?.viewers.get(connId);
    if (!v) return;
    v.forceSnapshot = true;
    (this.sessions.get(sessionId) as SessionState).dirty = true;
  }

  sessionRemoved(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const conn of s.viewers.keys()) this.viewerSession.delete(conn);
    this.sessions.delete(sessionId);
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        viewers: new Map(),
        dirty: false,
        inflight: false,
        lastKeys: [],
        lastCols: 0,
        lastRows: 0,
        lastBackendScrollback: null,
        reported: 0,
        gen: 0,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private async tick(): Promise<void> {
    for (const [sessionId, s] of this.sessions) {
      if (!s.dirty || s.inflight || s.viewers.size === 0) continue;
      s.inflight = true;
      s.dirty = false;
      try {
        const screen = await this.opts.backend.getScreen(sessionId);
        this.processScreen(sessionId, s, screen);
      } catch (err) {
        this.log.warn("getScreen failed; dropping session", {
          session: sessionId.slice(0, 12),
          err: String(err),
        });
        this.sessionRemoved(sessionId);
      } finally {
        s.inflight = false;
      }
    }
  }

  private processScreen(sessionId: string, s: SessionState, screen: Screen): void {
    const keys = screen.lines.map(lineKey);
    const rows = screen.rows;
    let delta = 0;
    let reset = false;
    let forceSnapshotAll =
      s.lastKeys.length === 0 || s.lastCols !== screen.cols || s.lastRows !== screen.rows;

    if (s.lastBackendScrollback === null) {
      s.reported = screen.scrollbackTotal;
    } else {
      const backendDelta = screen.scrollbackTotal - s.lastBackendScrollback;
      if (backendDelta < 0) {
        reset = true;
        forceSnapshotAll = true;
        s.reported = screen.scrollbackTotal;
      } else if (backendDelta >= rows) {
        forceSnapshotAll = true;
        s.reported += backendDelta;
      } else if (backendDelta > 0) {
        delta = backendDelta;
        s.reported += backendDelta;
      } else if (!this.opts.backend.capabilities.absoluteLines && !forceSnapshotAll) {
        const changedRowForRow = countChanged(keys, s.lastKeys, 0);
        if (changedRowForRow > SNAPSHOT_RATIO * rows) {
          const k = detectOverlap(keys, s.lastKeys, rows);
          if (k > 0) {
            delta = k;
            s.reported += k;
          }
        }
      }
    }
    s.lastBackendScrollback = screen.scrollbackTotal;

    const changed: { i: number; line: Line }[] = [];
    if (!forceSnapshotAll) {
      for (let i = 0; i < rows; i++) {
        const old = i + delta < s.lastKeys.length ? s.lastKeys[i + delta] : undefined;
        if (old === undefined || old !== keys[i])
          changed.push({ i, line: screen.lines[i] as Line });
      }
      if (changed.length > SNAPSHOT_RATIO * rows) forceSnapshotAll = true;
    }

    s.gen += 1;
    s.lastKeys = keys;
    s.lastCols = screen.cols;
    s.lastRows = screen.rows;

    const base = { sessionId, cursor: screen.cursor, scrollbackTotal: s.reported, gen: s.gen };
    /** `degrade` is forced for a starved viewer; otherwise it is decided by the 256 KB cap. */
    const snapshot = (degrade: boolean): InnerMessage => {
      const full: InnerMessage = {
        type: "screen.snapshot",
        ...base,
        cols: screen.cols,
        rows: screen.rows,
        lines: screen.lines,
        reset: reset || undefined,
      };
      if (degrade || encodeCbor(full).byteLength > (this.opts.maxEncodedBytes ?? 262_144)) {
        return { ...full, lines: screen.lines.map(stripStyles), degraded: true };
      }
      return full;
    };
    const diff: InnerMessage = { type: "screen.diff", ...base, scroll: delta, changed };

    for (const [conn, v] of s.viewers) {
      if (!this.spend()) {
        // Global budget exhausted this tick: coalesce. `lastSentGen` stays stale, so this viewer
        // is served a snapshot on the next tick it wins the budget.
        v.skipped += 1;
        continue;
      }
      const starved = v.skipped >= COALESCE_DEGRADE_TICKS;
      const upToDate =
        v.lastSentGen === s.gen - 1 && !v.forceSnapshot && !forceSnapshotAll && !starved;
      this.opts.sink(conn, upToDate ? diff : snapshot(starved));
      v.lastSentGen = s.gen;
      v.forceSnapshot = false;
      v.skipped = 0;
    }
  }

  /**
   * One token bucket across every viewer of every session: all frames leave through the agent's
   * single relay socket, which the relay caps at 60 msg/s per connection (close 4429).
   */
  private spend(): boolean {
    const max = this.opts.maxFramesPerSecond ?? 40;
    const now = this.now();
    if (now - this.budget.windowStart >= 1000) {
      this.budget = { windowStart: now, count: 1 };
      return true;
    }
    if (this.budget.count >= max) return false;
    this.budget.count += 1;
    return true;
  }
}

function countChanged(keys: string[], last: string[], shift: number): number {
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (last[i + shift] !== keys[i]) n++;
  return n;
}

/** Returns k>0 if new row i equals old row i+k for ≥80% of comparable rows; the smallest such k wins. */
function detectOverlap(keys: string[], last: string[], rows: number): number {
  for (let k = 1; k <= Math.min(rows - 1, OVERLAP_MAX_SHIFT); k++) {
    const comparable = rows - k;
    if (comparable <= 0) break;
    let match = 0;
    for (let i = 0; i < comparable; i++) if (keys[i] === last[i + k]) match++;
    if (match >= OVERLAP_MIN_MATCH * comparable) return k;
  }
  return 0;
}
