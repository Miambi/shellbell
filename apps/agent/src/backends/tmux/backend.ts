import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";
import {
  type Capabilities,
  type CreateWhere,
  type Line,
  parseSgrLine,
  type SessionInfo,
} from "@shellbell/protocol";
// `parseTmuxVersion` is the SHIPPED, unit-tested version comparator (`doctor.test.ts` asserts
// 3.2 <= 3.10). Never re-derive it with parseFloat: parseFloat("3.10") === 3.1 < 3.2.
// No cycle: doctor.ts imports herdr/start.ts and iterm2/*, never the tmux tree.
import { parseTmuxVersion } from "../../doctor.js";
import type { Logger } from "../../log.js";
import {
  type BackendEvent,
  BackendUnavailable,
  type Screen,
  SessionGone,
  type TerminalBackend,
  Unsupported,
} from "../types.js";
import { TmuxControl, tmuxQuote } from "./control.js";
import { tmuxKeyForBytes } from "./keys.js";
import {
  type PaneRow,
  parseClientRow,
  parseDisplay,
  parsePaneRow,
  Q_CLIENTS,
  Q_DISPLAY,
  Q_PANES,
  titleFor,
} from "./parse.js";

const run = promisify(execFile);
/** tmux 3.2, in `parseTmuxVersion`'s major + minor/100 space. */
const MIN_VERSION = 3.02;
export const TMUX_INSTALL_HINT = "brew install tmux (3.2+), then start a tmux session";

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

export interface TmuxBackendOptions {
  log: Logger;
  socketName?: string;
  hostname?: string;
  controlFactory?: (sessionId: string) => TmuxControl;
  execImpl?: (args: string[]) => Promise<string>;
  watchIntervalMs?: number;
  refreshDebounceMs?: number;
}

export class TmuxBackend implements TerminalBackend {
  readonly name = "tmux" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    prompts: false,
    createSession: true,
    focus: false,
    history: true,
    absoluteLines: false,
  };

  private controls = new Map<string, TmuxControl>();
  private panes = new Map<string, PaneRow>();
  private reported = new Map<string, number>();
  private sessionIndex = new Map<string, number>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private watcher: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshBusy = false;
  private refreshDirty = false;
  private syncBusy = false;
  private closed = true;
  private readonly log: Logger;
  private readonly exec: (args: string[]) => Promise<string>;

  constructor(private readonly opts: TmuxBackendOptions) {
    this.log = opts.log.child({ backend: "tmux" });
    this.exec =
      opts.execImpl ??
      (async (args) =>
        (await run("tmux", [...(opts.socketName ? ["-L", opts.socketName] : []), ...args])).stdout);
  }

  /** Spec 8.12: false once every control client is gone, so the registry drops us from `hello`. */
  get isConnected(): boolean {
    return !this.closed && [...this.controls.values()].some((c) => c.alive);
  }

  static async detect(
    execImpl?: (args: string[]) => Promise<string>,
  ): Promise<{ ok: boolean; version: string; reason?: string }> {
    const exec = execImpl ?? (async (args) => (await run("tmux", args)).stdout);
    let raw: string;
    try {
      raw = await exec(["-V"]);
    } catch {
      return { ok: false, version: "", reason: "tmux not found" };
    }
    const version = /(\d+\.\d+)/.exec(raw)?.[1] ?? "";
    const parsed = parseTmuxVersion(raw);
    if (parsed === null || parsed < MIN_VERSION) {
      return {
        ok: false,
        version,
        reason: `tmux 3.2+ required for Shellbell (found ${version || raw.trim()})`,
      };
    }
    try {
      await exec(["list-sessions", "-F", "#{session_id}"]);
    } catch {
      return { ok: false, version, reason: "no tmux server running" };
    }
    return { ok: true, version };
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    const d = await TmuxBackend.detect(this.exec);
    if (!d.ok) throw new BackendUnavailable(d.reason ?? "tmux unavailable", TMUX_INSTALL_HINT);
    this.closed = false;
    await this.syncControls();
    await this.refreshPanes();
    this.watcher = setInterval(() => {
      void this.syncControls()
        .then(() => this.refreshPanes())
        .catch((err) => this.log.warn("tmux watcher failed", { error: errName(err) }));
    }, this.opts.watchIntervalMs ?? 5000);
    this.watcher.unref?.();
  }

  /** Idempotent (spec: `close()` may be called from `stop()` and again by the host). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.refreshDirty = false;
    for (const c of this.controls.values()) c.stop();
    this.controls.clear();
    this.panes.clear();
    this.reported.clear();
    this.sessionIndex.clear();
    this.handlers.clear();
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  // ---- control clients ----

  /**
   * Spec 8.11: the first control client is also the command channel; when it exits, another is
   * promoted. Realised as "any alive client, chosen per command", which is the same guarantee
   * without a promotion step that could race the watcher.
   *
   * NOT `SessionGone`: no channel is a TRANSIENT fault (the watcher re-attaches within 5 s), and
   * `ScreenTracker.tick` deletes a session from every viewer when it sees `SessionGone`.
   */
  private channel(): TmuxControl {
    const c = [...this.controls.values()].find((x) => x.alive);
    if (!c) throw new Error("tmux command channel unavailable");
    return c;
  }

  private async syncControls(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      let ids: string[];
      try {
        ids = (await this.exec(["list-sessions", "-F", "#{session_id}"]))
          .split("\n")
          .filter(Boolean);
      } catch {
        ids = [];
      }
      // spec 8.11: `windowNumber` is the session's index in `list-sessions`, captured here.
      this.sessionIndex = new Map(ids.map((id, i) => [id, i]));
      for (const [id, c] of this.controls) {
        if (!ids.includes(id) || !c.alive) {
          c.stop();
          this.controls.delete(id);
        }
      }
      for (const id of ids) {
        if (this.closed || this.controls.has(id)) continue;
        const c = (
          this.opts.controlFactory ??
          ((sid: string) =>
            new TmuxControl({
              sessionId: sid,
              socketName: this.opts.socketName,
              log: this.opts.log,
            }))
        )(id);
        c.on("output", (pane) => {
          // A pane we have not listed yet (created between two refreshes) would make `getScreen`
          // throw SessionGone and destroy the phone's session; refresh instead of emitting.
          if (!this.panes.has(pane)) this.scheduleRefresh();
          else this.emit({ type: "screen-changed", sessionId: pane });
        });
        c.on("layout", () => this.scheduleRefresh());
        c.on("exit", () => {
          this.controls.delete(id);
          this.scheduleRefresh();
        });
        // Registered before `await`, so a concurrent tick cannot spawn a second client for `id`.
        this.controls.set(id, c);
        await c.start();
      }
    } finally {
      this.syncBusy = false;
    }
  }

  // ---- pane map ----

  /** Spec 8.11: layout notifications are debounced 100 ms into one refresh. */
  private scheduleRefresh(): void {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshPanes().catch((err) =>
        this.log.warn("tmux refresh failed", { error: errName(err) }),
      );
    }, this.opts.refreshDebounceMs ?? 100);
    this.refreshTimer.unref?.();
  }

  /**
   * Coalescing single-flight, like `ITerm2Backend.applyLayout`: at most one refresh runs, and a
   * request that arrives while one is in flight is collapsed into exactly one more afterwards.
   */
  private async refreshPanes(): Promise<void> {
    if (this.closed) return;
    if (this.refreshBusy) {
      this.refreshDirty = true;
      return;
    }
    this.refreshBusy = true;
    try {
      do {
        this.refreshDirty = false;
        await this.runRefresh();
      } while (this.refreshDirty && !this.closed);
    } finally {
      // Never leave the lock held: a throw here would wedge every later refresh.
      this.refreshBusy = false;
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.controls.size === 0) {
      const had = [...this.panes.keys()];
      this.panes.clear();
      for (const id of had) this.emit({ type: "session-removed", sessionId: id });
      if (had.length > 0) this.emit({ type: "layout-changed" });
      return;
    }
    let rows: PaneRow[];
    try {
      rows = (await this.channel().command(`list-panes -a -F ${Q_PANES}`)).map(parsePaneRow);
    } catch (err) {
      this.log.warn("list-panes failed", { error: errName(err) });
      return;
    }
    const next = new Map(rows.filter((r) => !r.dead).map((r) => [r.paneId, r]));
    const removed = [...this.panes.keys()].filter((id) => !next.has(id));
    this.panes = next;
    for (const id of removed) {
      this.reported.delete(id);
      this.emit({ type: "session-removed", sessionId: id });
    }
    this.emit({ type: "layout-changed" });
  }

  private pane(paneId: string): PaneRow {
    const p = this.panes.get(paneId);
    // The one place `SessionGone` is correct: tmux itself does not have this pane.
    if (!p) throw new SessionGone(paneId);
    return p;
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionInfo[]> {
    let attached = new Set<string>();
    try {
      const rows = (await this.channel().command(`list-clients -F ${Q_CLIENTS}`)).map(
        parseClientRow,
      );
      // spec 8.11: our own control clients (`client_control_mode == 1`) never count as focus.
      attached = new Set(rows.filter((r) => !r.controlMode).map((r) => r.sessionId));
    } catch (err) {
      this.log.debug("list-clients failed; no pane reported focused", { error: errName(err) });
    }
    const host = this.opts.hostname ?? osHostname();
    const indexOf = (sid: string) => this.sessionIndex.get(sid) ?? Number.MAX_SAFE_INTEGER;
    return [...this.panes.values()]
      .sort(
        (a, b) =>
          indexOf(a.sessionId) - indexOf(b.sessionId) ||
          a.windowIndex - b.windowIndex ||
          a.paneIndex - b.paneIndex,
      )
      .map((p) => ({
        id: p.paneId,
        backend: "tmux" as const,
        title: titleFor(p, host),
        cwd: p.cwd || undefined,
        cols: Math.max(1, p.width),
        rows: Math.max(1, p.height),
        windowId: p.sessionId,
        windowNumber: this.sessionIndex.get(p.sessionId) ?? 0,
        tabId: p.windowId,
        tabIndex: p.windowIndex,
        paneIndex: p.paneIndex,
        isFocusedOnMac: p.paneActive && p.windowActive && attached.has(p.sessionId),
        state: "unknown" as const,
      }));
  }

  /** Spec 8.12: the registry hides any tmux pane whose tmux window id iTerm2 already shows. */
  tmuxWindowIdOf(nativeId: string): string | undefined {
    return this.panes.get(nativeId)?.windowId;
  }

  /** Spec 8.11: the tracker's monotonic `scrollbackTotal`; needed for history offsets. */
  setReported(paneId: string, reported: number): void {
    this.reported.set(paneId, reported);
  }

  // ---- screen / history ----

  async getScreen(paneId: string): Promise<Screen> {
    this.pane(paneId);
    const ch = this.channel();
    const [rows, disp] = await Promise.all([
      ch.command(`capture-pane -p -e -N -t ${paneId}`),
      ch.command(`display-message -p -t ${paneId} ${Q_DISPLAY}`),
    ]);
    const d = parseDisplay(disp[0] ?? "");
    const height = Math.max(1, d.height);
    const lines: Line[] = rows.map(parseSgrLine);
    while (lines.length < height) lines.push({ r: [] });
    if (lines.length > height) lines.length = height;
    return {
      cols: Math.max(1, d.width),
      rows: height,
      cursor: { x: d.cursorX, y: d.cursorY },
      lines,
      scrollbackTotal: d.historySize,
    };
  }

  /**
   * Spec 8.11: with `H = history_size` and the tracker's `reported`, the oldest retrievable
   * absolute line is `reported - H`, so `s = before - count - reported`, `e = before - 1 - reported`
   * (both <= -1, clamp `s >= -H`). tmux's `history_size` SATURATES at `history-limit` while
   * `reported` keeps climbing, which is exactly what makes `oldestAvailable` non-zero (spec 18.12).
   */
  async getHistory(
    paneId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    this.pane(paneId);
    const ch = this.channel();
    const d = parseDisplay(
      (await ch.command(`display-message -p -t ${paneId} ${Q_DISPLAY}`))[0] ?? "",
    );
    const reported = this.reported.get(paneId) ?? d.historySize;
    const oldestAvailable = Math.max(0, reported - d.historySize);
    const e = before - 1 - reported;
    const s = Math.max(before - count - reported, -d.historySize);
    if (e < s || e > -1) return { lines: [], oldestAvailable };
    const rows = await ch.command(`capture-pane -p -e -N -t ${paneId} -S ${s} -E ${e}`);
    return { lines: rows.map(parseSgrLine), oldestAvailable };
  }

  // ---- input ----

  /**
   * Spec 8.11 "Input". `agent.ts` turns `input.key` into raw bytes before we see it, so a payload
   * that is exactly one key's byte string goes out as a tmux key NAME; anything else is literal
   * text via `-l`, with every CR/LF becoming a real `Enter` (`-l` writes bytes and never submits).
   */
  async sendText(paneId: string, text: string): Promise<void> {
    this.pane(paneId);
    const ch = this.channel();
    const key = tmuxKeyForBytes(text);
    if (key) {
      // spec 8.10: NEVER log which key. Record only that one was sent.
      this.log.debug("tmux key");
      await ch.command(`send-keys -t ${paneId} ${key}`);
      return;
    }
    // Never log the text itself (spec 8.10) -- only its length.
    this.log.debug("tmux text", { len: text.length });
    const parts = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i++) {
      const body = parts[i] as string;
      if (body) await ch.command(`send-keys -t ${paneId} -l -- ${tmuxQuote(body)}`);
      if (i < parts.length - 1) await ch.command(`send-keys -t ${paneId} Enter`);
    }
  }

  // ---- create / focus ----

  async createSession(where: CreateWhere): Promise<string> {
    const ch = this.channel();
    const line =
      where.kind === "split"
        ? `split-window -P -F '#{pane_id}' -t ${where.sessionId} ${
            where.direction === "vertical" ? "-h" : "-v"
          }`
        : where.windowId
          ? `new-window -P -F '#{pane_id}' -t ${where.windowId}`
          : "new-session -d -P -F '#{pane_id}'";
    const out = await ch.command(line);
    const id = out[0]?.trim();
    // Never resolve "" -- the registry would prefix it to `"tmux:"` and ack it as a real session.
    if (!id) throw new Error(`tmux ${line.split(" ")[0]} returned no pane id`);
    this.scheduleRefresh();
    return id;
  }

  async focus(_paneId: string): Promise<void> {
    throw new Unsupported("focus");
  }
}
