import {
  type Cursor,
  encodeCbor,
  type InnerMessage,
  type InnerMessageOf,
  type Line,
  lineKey,
  stripStyles,
} from "@shellbell/protocol";
import { type Screen, SessionGone, type TerminalBackend } from "./backends/types.js";
import type { Logger } from "./log.js";

export interface ScreenTrackerOptions {
  backend: TerminalBackend;
  sink: (connId: string, msg: InnerMessage) => void;
  log: Logger;
  intervalMs?: number;
  maxFramesPerSecond?: number;
  maxEncodedBytes?: number;
  now?: () => number;
  /** Called when `getScreen` reports the session is truly gone (Task 10 wires this to `sessions`). */
  onSessionGone?: (sessionId: string) => void;
}

interface SessionState {
  viewers: Map<string, { lastSentGen: number; forceSnapshot: boolean; skipped: number }>;
  dirty: boolean;
  inflight: boolean;
  lastKeys: string[];
  lastCols: number;
  lastRows: number;
  lastCursor: Cursor | null;
  lastBackendScrollback: number | null;
  reported: number;
  gen: number;
  /** Round-robin start offset for fair tie-breaking under a scarce frame budget. */
  rrOffset: number;
  /** Set once we've logged that even a stripped snapshot exceeds `maxEncodedBytes`. */
  oversizeWarned: boolean;
}

interface Budget {
  /** Tokens available right now; refilled continuously, capped at `maxFramesPerSecond`. */
  tokens: number;
  last: number;
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
  private readonly budget: Budget;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  /** Guards against a `getScreen` in flight at `stop()` time still reaching the sink. */
  private stopped = true;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: ScreenTrackerOptions) {
    this.intervalMs = Math.max(125, opts.intervalMs ?? 125);
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "tracker" });
    this.budget = { tokens: 0, last: this.now() };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // The tracker subscribes to the backend itself: `screen-changed` is the only event that means
    // "there is new output", and `session-removed` is the only one that invalidates our state.
    this.unsubscribe ??= this.opts.backend.on((e) => {
      if (e.type === "screen-changed") this.markDirty(e.sessionId);
      else if (e.type === "session-removed") this.sessionRemoved(e.sessionId);
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
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
        lastCursor: null,
        lastBackendScrollback: null,
        reported: 0,
        gen: 0,
        rrOffset: 0,
        oversizeWarned: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private async tick(): Promise<void> {
    for (const [sessionId, s] of this.sessions) {
      if (this.stopped) return;
      if (!s.dirty || s.inflight || s.viewers.size === 0) continue;
      s.inflight = true;
      s.dirty = false;
      try {
        const screen = await this.opts.backend.getScreen(sessionId);
        // A `stop()` may have landed while `getScreen` was in flight: never reach the sink after it.
        if (this.stopped) continue;
        this.processScreen(sessionId, s, screen);
      } catch (err) {
        if (err instanceof SessionGone) {
          this.log.warn("getScreen: session gone; dropping", { session: sessionId.slice(0, 12) });
          this.opts.onSessionGone?.(sessionId);
          this.sessionRemoved(sessionId);
        } else {
          // Transient error (RPC timeout, etc.): keep viewers, resync everyone next tick.
          this.log.warn("getScreen failed; will retry", {
            session: sessionId.slice(0, 12),
            err: err instanceof Error ? err.name : String(err),
          });
          for (const v of s.viewers.values()) v.forceSnapshot = true;
          s.dirty = true;
        }
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

    const cursorChanged =
      !s.lastCursor || s.lastCursor.x !== screen.cursor.x || s.lastCursor.y !== screen.cursor.y;
    // Nothing to say this tick: don't advance `gen` or wake an already-current viewer.
    const noOp = !forceSnapshotAll && delta === 0 && changed.length === 0 && !cursorChanged;

    if (!noOp) s.gen += 1;
    s.lastKeys = keys;
    s.lastCols = screen.cols;
    s.lastRows = screen.rows;
    s.lastCursor = screen.cursor;

    const base = { sessionId, cursor: screen.cursor, scrollbackTotal: s.reported, gen: s.gen };
    const maxBytes = this.opts.maxEncodedBytes ?? 262_144;
    // Encoded once per tick (not once per viewer): every lagging/new viewer this tick shares it.
    let fullMsg: InnerMessageOf<"screen.snapshot"> | undefined;
    let fullBytes: number | undefined;
    let degradedMsg: InnerMessageOf<"screen.snapshot"> | undefined;
    const getFull = (): InnerMessageOf<"screen.snapshot"> => {
      fullMsg ??= {
        type: "screen.snapshot",
        ...base,
        cols: screen.cols,
        rows: screen.rows,
        lines: screen.lines,
        reset: reset || undefined,
      };
      return fullMsg;
    };
    const getDegraded = (): InnerMessageOf<"screen.snapshot"> => {
      if (!degradedMsg) {
        degradedMsg = { ...getFull(), lines: screen.lines.map(stripStyles), degraded: true };
        // stripStyles is the only fallback we have; if it's still too big, send it anyway but say so.
        if (!s.oversizeWarned) {
          const bytes = encodeCbor(degradedMsg).byteLength;
          if (bytes > maxBytes) {
            this.log.warn("screen.snapshot exceeds maxEncodedBytes even after stripStyles", {
              session: sessionId.slice(0, 12),
              bytes,
              maxEncodedBytes: maxBytes,
            });
            s.oversizeWarned = true;
          }
        }
      }
      return degradedMsg;
    };
    /** `starved` forces the degraded path; otherwise size against the 256 KB (default) cap decides. */
    const snapshotFor = (starved: boolean): InnerMessage => {
      if (starved) return getDegraded();
      fullBytes ??= encodeCbor(getFull()).byteLength;
      return fullBytes > maxBytes ? getDegraded() : getFull();
    };
    const diff: InnerMessage = { type: "screen.diff", ...base, scroll: delta, changed };

    // Fair service order under a scarce budget: most-coalesced viewer first; ties broken by
    // rotating the start offset each tick, so no viewer is stuck permanently at the back.
    const entries = [...s.viewers.entries()];
    const n = entries.length;
    const offset = s.rrOffset % n;
    const rotated = entries.slice(offset).concat(entries.slice(0, offset));
    const ordered = rotated
      .map((entry, idx) => ({ entry, idx }))
      .sort((a, b) => b.entry[1].skipped - a.entry[1].skipped || a.idx - b.idx)
      .map((x) => x.entry);
    s.rrOffset = (s.rrOffset + 1) % n;

    for (const [conn, v] of ordered) {
      const stale = v.lastSentGen !== s.gen;
      if (!stale && !v.forceSnapshot) continue; // already has this exact generation; nothing to do
      if (!this.spend()) {
        // Global budget exhausted this tick: coalesce. `lastSentGen` stays stale, so this viewer
        // is served a snapshot on the next tick it wins the budget.
        v.skipped += 1;
        continue;
      }
      const starved = v.skipped >= COALESCE_DEGRADE_TICKS;
      const upToDate =
        v.lastSentGen === s.gen - 1 && !v.forceSnapshot && !forceSnapshotAll && !starved;
      this.opts.sink(conn, upToDate ? diff : snapshotFor(starved));
      v.lastSentGen = s.gen;
      v.forceSnapshot = false;
      v.skipped = 0;
    }
  }

  /**
   * One continuously-refilling token bucket across every viewer of every session: all frames
   * leave through the agent's single relay socket, which the relay caps at 60 msg/s (close 4429).
   */
  private spend(): boolean {
    const max = this.opts.maxFramesPerSecond ?? 40;
    const now = this.now();
    const elapsed = Math.max(0, now - this.budget.last);
    this.budget.tokens = Math.min(max, this.budget.tokens + (elapsed * max) / 1000);
    this.budget.last = now;
    if (this.budget.tokens < 1) return false;
    this.budget.tokens -= 1;
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
