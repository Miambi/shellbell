import type { Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import {
  type AgentState,
  type BackendEvent,
  BackendUnavailable,
  BadWindow,
  type Screen,
  SessionGone,
  type TerminalBackend,
} from "../types.js";
import {
  GONE_CODES,
  type HerdrClient,
  HerdrError,
  type HerdrStream,
  INSTALL_HINT,
  UNSUPPORTED_CODES,
  UPGRADE_HINT,
} from "./client.js";
import { herdrScreen, parseAnsiLines } from "./convert.js";
import { herdrKeyForBytes } from "./keys.js";
import type {
  HerdrEvent,
  HerdrSubscription,
  PaneInfo,
  PaneInfoResult,
  PaneLayoutSnapshot,
  PaneReadResult,
  PaneScroll,
  SessionSnapshot,
  SessionSnapshotResult,
  TabCreatedResult,
} from "./types.js";

/** Herdr caps a single `pane.read` at 1000 lines (`line_limit = lines.min(1000)`). */
const MAX_READ_LINES = 1000;
/** Cap on events buffered during a bootstrap, so a storm cannot grow without bound. */
const MAX_BUFFERED_EVENTS = 1000;

/**
 * The lifecycle subscriptions we always want, plus the two per-pane ones. Herdr has no incremental
 * "add subscription" method, so this list is fixed for the life of a stream and the pane set
 * changing means opening a new stream (two-phase, see `openStream`).
 */
export function herdrSubscriptions(paneIds: string[]): HerdrSubscription[] {
  const subs: HerdrSubscription[] = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
    { type: "pane.updated" },
    { type: "pane.focused" },
    { type: "pane.moved" },
    { type: "pane.agent_detected" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.focused" },
    { type: "tab.renamed" },
    { type: "tab.moved" },
    { type: "workspace.created" },
    { type: "workspace.updated" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "workspace.renamed" },
    { type: "workspace.moved" },
    { type: "workspace.reordered" },
    { type: "layout.updated" },
  ];
  for (const paneId of paneIds) {
    subs.push({ type: "pane.agent_status_changed", pane_id: paneId });
    subs.push({ type: "pane.scroll_changed", pane_id: paneId });
  }
  return subs;
}

const AGENT_STATES = new Set<string>(["working", "blocked", "idle", "done", "unknown"]);

function agentStateOf(v: unknown): AgentState {
  return typeof v === "string" && AGENT_STATES.has(v) ? (v as AgentState) : "unknown";
}

/**
 * Spec 8.13: `working` -> running, `idle`/`done` -> finished, `blocked` -> the new state. Herdr's
 * `done` is "idle and not yet seen in the Herdr UI"; the phone cannot observe that, so both map to
 * `finished` on purpose.
 */
const SESSION_STATE: Record<AgentState, SessionInfo["state"]> = {
  working: "running",
  blocked: "blocked",
  idle: "finished",
  done: "finished",
  unknown: "unknown",
};

/** Spec 8.13: agent name, else pane title, else cwd basename, else "Pane". */
function titleOf(pane: PaneInfo): string {
  const cwd = pane.foreground_cwd ?? pane.cwd;
  const base = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
  return (
    pane.display_agent || pane.agent || pane.title || pane.terminal_title_stripped || base || "Pane"
  );
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function scrollOf(v: unknown): PaneScroll | undefined {
  return v && typeof v === "object" ? (v as PaneScroll) : undefined;
}

function sameSet(a: string[], b: Set<string>): boolean {
  return a.length === b.size && a.every((x) => b.has(x));
}

interface Pane {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  title: string;
  cwd?: string;
  /** Layout rect width in cells, else 80. */
  cols: number;
  /** Layout rect height in cells, else `scroll.viewport_rows`, else 24. */
  rows: number;
  /** True when `rows` came from a layout rect, so a scroll refresh must not override it. */
  rowsFromRect: boolean;
  windowNumber: number;
  tabIndex: number;
  paneIndex: number;
  focused: boolean;
  agentStatus: AgentState;
  /** `scroll.max_offset_from_bottom`: rows above the viewport = our `scrollbackTotal`. */
  scrollMax: number;
  /** Set when a `pane.scroll_changed` event carried no usable numbers. */
  scrollStale: boolean;
  scrollFetchedAt: number;
  /**
   * `eventSeq` value stamped when a live, revision-ordered `pane_updated` last updated
   * `agentStatus`. Guards against an in-flight `session.snapshot` reverting a status a fresher
   * event already applied while the RPC was outstanding (spec 8.13 race, review fix 4).
   * `pane_agent_status_changed` no longer stamps this (spec 8.13, revised 2026-09-06): it is a
   * hint, not a mutation, so there is nothing of its own to protect from being reverted.
   */
  statusSeq: number;
  /**
   * Spec 8.13 (revised): `pane_updated.pane.revision`, a monotonic content counter. `screen-changed`
   * fires whenever a `pane_updated` event or a post-reconnect snapshot carries a different value.
   */
  revision: number;
}

interface StreamState {
  cancelled: boolean;
  live: boolean;
  buffer: HerdrEvent[];
  stream: HerdrStream | null;
  /** M-6: set once this bootstrap has already logged an overflow, so a storm logs only once. */
  overflowed: boolean;
}

export interface HerdrBackendOptions {
  client: HerdrClient;
  log: Logger;
  /** Spec 8.13: poll for the socket every 2 s after the server goes away. */
  reconnectMs?: number;
  /** Debounce before a lifecycle-hint snapshot refresh / stream rebuild. */
  syncDebounceMs?: number;
  /** Minimum gap between `pane.get` scroll refreshes for one pane. */
  scrollRefreshMs?: number;
}

export class HerdrBackend implements TerminalBackend {
  readonly name = "herdr" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    // Herdr has no prompt/command lifecycle and no exit codes at all: the idle heuristic (8.8) and
    // `agent-state` carry the whole notification story.
    prompts: false,
    createSession: true,
    focus: true,
    history: true,
    // `pane.read` has no stable absolute line numbering, so the tracker must use `lineKey` overlap.
    absoluteLines: false,
  };

  private panes = new Map<string, Pane>();
  private byPaneId = new Map<string, string>();
  private order: string[] = [];
  private workspaces = new Set<string>();
  private focusedWorkspace: string | null = null;
  /**
   * Bumped every time a live, revision-ordered `pane_updated` event applies a status to a pane;
   * captured just before each `session.snapshot` request so the (later) response can tell whether
   * a per-pane status it is about to apply has since gone stale (review fix 4). Not touched by
   * `pane_agent_status_changed` (spec 8.13, revised 2026-09-06): that event is a hint, so it has
   * nothing of its own to protect from reversion.
   */
  private eventSeq = 0;

  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly log: Logger;
  private readonly client: HerdrClient;

  private active: StreamState | null = null;
  private subscribedPaneIds = new Set<string>();

  private closed = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncBusy = false;
  private wantSnapshot = false;
  private wantResubscribe = false;

  constructor(private readonly opts: HerdrBackendOptions) {
    this.client = opts.client;
    this.log = opts.log.child({ backend: "herdr" });
  }

  /** Spec 8.12/8.13: `false` while the socket is down, so the registry drops us from `hello`. */
  get isConnected(): boolean {
    return !this.closed && this.active !== null;
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    this.closed = false;
    // Gate 1: semver (throws BackendUnavailable). Gate 2: the discovery snapshot doubles as the
    // `session.snapshot` feature probe -- it landed in 0.7.2 -- and tells us which panes exist, so
    // the very first subscription already covers all of them.
    await this.client.ping();
    let discovered: string[] = [];
    try {
      const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
      discovered = assertSnapshot(res?.snapshot).panes.map((p) => p.pane_id);
    } catch (err) {
      throw this.unavailable(err);
    }
    try {
      await this.openStream(discovered);
    } catch (err) {
      if (err instanceof BackendUnavailable) throw err;
      throw this.unavailable(err);
    }
  }

  private unavailable(err: unknown): BackendUnavailable {
    if (err instanceof BackendUnavailable) return err;
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code))
      return new BackendUnavailable(
        `herdr does not support session.snapshot (${detail})`,
        UPGRADE_HINT,
      );
    if (err instanceof HerdrError && err.code === "malformed")
      return new BackendUnavailable(
        `herdr answered session.snapshot with junk (${detail})`,
        UPGRADE_HINT,
      );
    return new BackendUnavailable(detail, INSTALL_HINT);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    const active = this.active;
    this.active = null;
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    // Review fix 5: leaving any of these set would surface as one spurious sync/rebuild on a
    // future `connect()` of the SAME instance, and a handler left registered after `close()`
    // would keep firing for an owner that thinks it long since unsubscribed.
    this.wantSnapshot = false;
    this.wantResubscribe = false;
    this.syncBusy = false;
    this.subscribedPaneIds.clear();
    this.handlers.clear();
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- sessions ----

  async listSessions(): Promise<SessionInfo[]> {
    return this.order
      .map((id) => this.panes.get(id))
      .filter((p): p is Pane => p !== undefined)
      .map((p) => this.toInfo(p));
  }

  async getScreen(sessionId: string): Promise<Screen> {
    const pane = this.pane(sessionId);
    if (pane.scrollStale) await this.refreshScroll(pane);
    const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
      pane_id: pane.paneId,
      source: "visible",
      format: "ansi",
    });
    return herdrScreen({
      text: res?.read?.text ?? "",
      rows: pane.rows,
      cols: pane.cols,
      scrollMax: pane.scrollMax,
    });
  }

  /**
   * Spec 8.13: best-effort, styled, bounded. `source:"recent"` returns the **last** N lines of the
   * buffer (screen included), N <= 1000. `before` is in the same coordinate system as the
   * `scrollbackTotal` we emit (`scroll.max_offset_from_bottom` = the index of the screen's first
   * row), so `depth` is how far above our own screen top the requested page ends. There is no
   * stable absolute numbering (`absoluteLines: false`), so a short page plus `oldestAvailable` is
   * how the phone learns it has reached the top.
   */
  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const pane = this.pane(sessionId);
    const depth = Math.max(0, pane.scrollMax - before);
    const want = Math.min(MAX_READ_LINES, depth + count + pane.rows);
    let text: string;
    try {
      const res = await this.call<PaneReadResult>(sessionId, "pane.read", {
        pane_id: pane.paneId,
        source: "recent",
        format: "ansi",
        lines: want,
      });
      text = res?.read?.text ?? "";
    } catch (err) {
      // A deep read of a busy recognised agent is refused, and an ANSI read never scrolls a
      // full-screen TUI anyway. Fall back to what we can always get -- the visible screen -- and
      // tell the phone to stop paging.
      if (err instanceof HerdrError && err.code === "agent_not_idle") {
        // M-7: a visible read can come back TALLER than the cached rect (Ghostty usually trims, so
        // this is the exception, not the rule). Those extra rows are CURRENT screen content, not
        // scrollback -- returning them here would place them at coordinates that claim otherwise
        // (spec 7.4). The honest answer when herdr refuses a deep read is "no history available",
        // so this never attaches any lines, visible or not.
        this.log.debug("herdr refused a deep read while the agent is busy", { want });
        return { lines: [], oldestAvailable: before };
      }
      throw err;
    }
    const all = parseAnsiLines(text);
    const end = Math.max(0, all.length - depth - pane.rows);
    const start = Math.max(0, end - count);
    const lines = all.slice(start, end);
    const exhausted = all.length < want;
    const oldestAvailable = exhausted && start === 0 ? Math.max(0, before - lines.length) : 0;
    return { lines, oldestAvailable };
  }

  /**
   * Spec 8.13: `pane.send_text` writes literal bytes and never submits, so anything that ends in a
   * newline is split into text + a real `enter` key, and a payload that is exactly one named key's
   * bytes goes out as that key.
   */
  async sendText(sessionId: string, text: string): Promise<void> {
    const pane = this.pane(sessionId);
    const whole = herdrKeyForBytes(text);
    if (whole) {
      // spec 8.10 / Global Constraints: NEVER log keys. A key name is still a keystroke, so this
      // records only that one key was sent -- not which one.
      this.log.debug("herdr key");
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: [whole] });
      return;
    }
    // Never log the text itself (spec 8.10) -- only its length.
    this.log.debug("herdr text", { len: text.length });
    if (text.endsWith("\r") || text.endsWith("\n")) {
      const body = text.slice(0, -1);
      if (body) await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text: body });
      await this.call(sessionId, "pane.send_keys", { pane_id: pane.paneId, keys: ["enter"] });
      return;
    }
    await this.call(sessionId, "pane.send_text", { pane_id: pane.paneId, text });
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const pane = this.pane(where.sessionId);
      // Shellbell's axis names the DIVIDER (like iTerm2's SplitPane.VERTICAL): "vertical" puts the
      // new pane to the right. Herdr's "down" is a horizontal divider. It has no left/up split.
      const res = await this.client.request<PaneInfoResult>("pane.split", {
        target_pane_id: pane.paneId,
        direction: where.direction === "vertical" ? "right" : "down",
        focus: false,
      });
      const id = str(res?.pane?.terminal_id);
      if (!id) throw new Error("herdr pane.split returned no terminal_id");
      // The snapshot is the only writer of the map: ask for one and return the new id now.
      this.scheduleSync("snapshot");
      return id;
    }
    if (where.windowId !== undefined && !this.workspaces.has(where.windowId))
      throw new BadWindow(where.windowId);
    const workspaceId = where.windowId ?? this.focusedWorkspace ?? [...this.workspaces][0];
    if (!workspaceId) throw new Error("herdr has no workspace to create a tab in");
    const res = await this.client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    const id = str(res?.root_pane?.terminal_id);
    if (!id) throw new Error("herdr tab.create returned no terminal_id");
    this.scheduleSync("snapshot");
    return id;
  }

  /** Spec 8.13: only ever from an explicit user action — this marks a `done` agent as seen. */
  async focus(sessionId: string): Promise<void> {
    const pane = this.pane(sessionId);
    await this.call(sessionId, "pane.focus", { pane_id: pane.paneId });
  }

  // Spec 8.13 (revised after the Task 8 spike): `pane.copy_motion` does not exist in Herdr 0.8.2
  // (`invalid_request: unknown variant`), so there is no revision poller and no `setWatched`
  // implementation here — `TerminalBackend.setWatched?` stays optional and unused by this backend.
  // Change detection is entirely event-driven: see `handleEvent`'s `pane_updated` case below.

  // ---- internals ----

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.warn("event handler failed", { error: errName(err) });
      }
    }
  }

  private pane(sessionId: string): Pane {
    const pane = this.panes.get(sessionId);
    if (!pane) throw new SessionGone(sessionId);
    return pane;
  }

  /**
   * Every pane-targeted call goes through here so a stale pane target does two things: tell the
   * caller (`SessionGone`) and ask the snapshot -- the only authority -- to reconcile, which is
   * what actually emits `session-removed` if the pane is really gone (spec 8.13).
   */
  private async call<T>(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (err) {
      if (err instanceof HerdrError && GONE_CODES.has(err.code)) {
        this.scheduleSync("snapshot");
        throw new SessionGone(sessionId);
      }
      throw err;
    }
  }

  private toInfo(p: Pane): SessionInfo {
    return {
      id: p.terminalId,
      backend: "herdr",
      title: p.title,
      cwd: p.cwd,
      cols: Math.max(1, p.cols),
      rows: Math.max(1, p.rows),
      windowId: p.workspaceId,
      windowNumber: p.windowNumber,
      tabId: p.tabId,
      tabIndex: p.tabIndex,
      paneIndex: p.paneIndex,
      // Herdr has no "my window is frontmost" signal; pane focus is the closest thing.
      isFocusedOnMac: p.focused,
      state: SESSION_STATE[p.agentStatus],
    };
  }

  private sortOrder(): void {
    this.order = [...this.panes.values()]
      .sort(
        (a, b) =>
          a.windowNumber - b.windowNumber ||
          a.tabIndex - b.tabIndex ||
          a.paneIndex - b.paneIndex ||
          a.paneId.localeCompare(b.paneId),
      )
      .map((p) => p.terminalId);
  }

  // ---- stream / sync ----

  /**
   * Two-phase (spec 8.13): the new subscription connection is opened and **acked** — and is already
   * buffering events — before it replaces the current one, so the handover loses nothing. The
   * snapshot that follows is the only writer of the pane map; if it fails, the new stream is closed
   * and the reconnect poll takes over.
   */
  private async openStream(paneIds?: string[]): Promise<void> {
    const ids = paneIds ?? [...this.byPaneId.keys()];
    const state: StreamState = {
      cancelled: false,
      live: false,
      buffer: [],
      stream: null,
      overflowed: false,
    };
    const stream = await this.client.subscribe(herdrSubscriptions(ids), {
      onEvent: (e) => {
        if (state.cancelled) return;
        if (state.live) {
          this.onEvent(e);
          return;
        }
        if (state.buffer.length < MAX_BUFFERED_EVENTS) {
          state.buffer.push(e);
          return;
        }
        // M-6: a storm past the cap drops events with no compensating action; log once (count
        // only, never event content) and make sure the round ends with a fresh snapshot so
        // whatever a dropped hint would have told us gets picked up anyway.
        if (!state.overflowed) {
          state.overflowed = true;
          this.log.warn("herdr bootstrap event buffer overflowed; dropping events", {
            max: MAX_BUFFERED_EVENTS,
          });
        }
        this.scheduleSync("snapshot");
      },
      onEnd: (reason) => {
        if (!state.cancelled && this.active === state) this.onStreamEnd(reason);
      },
    });
    state.stream = stream;
    if (this.closed) {
      state.cancelled = true;
      stream.close();
      return;
    }
    const previous = this.active;
    this.active = state;
    this.subscribedPaneIds = new Set(ids);
    if (previous) {
      previous.cancelled = true;
      previous.stream?.close();
    }
    try {
      await this.refreshSnapshot();
    } catch (err) {
      state.cancelled = true;
      stream.close();
      if (this.active === state) this.active = null;
      throw err;
    }
    // Only now do buffered events run — against a map the snapshot has already installed.
    state.live = true;
    const buffered = state.buffer;
    state.buffer = [];
    for (const e of buffered) this.onEvent(e);
    this.emit({ type: "layout-changed" });
  }

  private async refreshSnapshot(): Promise<void> {
    // Captured BEFORE the round-trip: any live, revision-ordered `pane_updated` event that bumps a
    // pane's `statusSeq` past this value while the request is outstanding is fresher than the
    // response about to arrive (review fix 4).
    const requestSeq = this.eventSeq;
    const res = await this.client.request<SessionSnapshotResult>("session.snapshot", {});
    if (this.closed) return;
    this.applySnapshot(assertSnapshot(res?.snapshot), requestSeq);
  }

  /**
   * Spec 8.13: every lifecycle event is a hint. They coalesce into one debounced, single-flight
   * snapshot (and, when the pane set changed, one stream rebuild). Nothing here can be scheduled by
   * the work it triggers, so there is no loop.
   */
  private scheduleSync(reason: "snapshot" | "resubscribe"): void {
    if (this.closed) return;
    if (reason === "resubscribe") this.wantResubscribe = true;
    else this.wantSnapshot = true;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSync().catch((err) => {
        this.log.warn("herdr sync crashed", { error: errName(err) });
      });
    }, this.opts.syncDebounceMs ?? 250);
    this.syncTimer.unref?.();
  }

  private async runSync(): Promise<void> {
    if (this.syncBusy || this.closed) return;
    this.syncBusy = true;
    try {
      while ((this.wantResubscribe || this.wantSnapshot) && !this.closed && this.active) {
        const resubscribe = this.wantResubscribe;
        this.wantResubscribe = false;
        this.wantSnapshot = false;
        if (resubscribe) await this.openStream();
        else await this.refreshSnapshot();
      }
    } catch (err) {
      // The socket is the only thing that can fail here; treat it as a disconnect so the normal
      // reconnect path (and its `session-removed` storm) runs exactly once.
      this.log.warn("herdr sync failed", { error: errName(err) });
      this.onStreamEnd("sync-failed");
    } finally {
      this.syncBusy = false;
    }
  }

  /** Spec 8.13: the server exiting removes the socket file; poll for it every 2 s. */
  private onStreamEnd(reason: string): void {
    if (this.closed) return;
    const active = this.active;
    this.active = null;
    if (active) {
      active.cancelled = true;
      active.stream?.close();
    }
    this.log.info("herdr stream ended", { reason });
    // Loudly: the tracker drops its viewers, the EventEngine forgets each session (so a pane that
    // comes back blocked counts as a first sighting, not a transition), and `isConnected` is false.
    const ids = [...this.order];
    this.panes.clear();
    this.byPaneId.clear();
    this.order = [];
    this.subscribedPaneIds.clear();
    for (const id of ids) this.emit({ type: "session-removed", sessionId: id });
    this.emit({ type: "layout-changed" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.opts.reconnectMs ?? 2000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err) => {
        this.log.debug("herdr reconnect failed", { error: errName(err) });
        this.scheduleReconnect();
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- snapshot ----

  private applySnapshot(snap: SessionSnapshot, requestSeq = 0): void {
    const workspaceNumbers = new Map<string, number>();
    const workspaces = new Set<string>();
    for (const w of snap.workspaces ?? []) {
      workspaces.add(w.workspace_id);
      workspaceNumbers.set(w.workspace_id, w.number ?? 0);
    }
    const tabNumbers = new Map<string, number>();
    for (const t of snap.tabs ?? []) tabNumbers.set(t.tab_id, t.number ?? 0);
    const rects = rectIndex(snap.layouts ?? []);

    const prev = this.panes;
    const next = new Map<string, Pane>();
    const byPaneId = new Map<string, string>();
    const changed: { id: string; state: AgentState; agent?: string }[] = [];
    // I-1: the snapshot is the sole writer of `title`/`cwd`, so it is the only place that can
    // notice one changed on a pane that merely got renamed/`cd`ed -- the event path already emits
    // `title-changed` for its own title updates (`pane.agent_status_changed`), this closes the gap
    // for `tab.renamed`/`pane.moved` (which only ever schedule a snapshot) and for a KNOWN pane's
    // `pane.updated` once that handler's own title/cwd check (below) has scheduled one too --
    // `pane.updated` carries no `agent`/`display_agent` name, so this snapshot pass is what
    // actually applies a shell pane's new title/cwd and emits `title-changed` for it.
    const titleChanged = new Set<string>();
    // Spec 8.13 (revised): a pane that already existed with a different numeric `revision` missed
    // its `pane_updated` event while the stream was down (reconnect gap) -- emit `screen-changed`
    // so a stale phone screen gets refreshed. First sight of a pane stores its revision silently.
    const revisionChanged = new Set<string>();
    for (const info of snap.panes) {
      const id = info.terminal_id ?? info.pane_id;
      const was = prev.get(id);
      const rect = rects.get(info.pane_id);
      const snapshotState = agentStateOf(info.agent_status);
      // Review fix 4: a live, revision-ordered `pane_updated` event applied to this pane AFTER the
      // `session.snapshot` request was issued is fresher than the value this response carries —
      // keep it rather than reverting (and never emit a stale `agent-state` for the revert).
      const statusSeq = was?.statusSeq ?? 0;
      const staleStatus = statusSeq > requestSeq;
      const state = staleStatus ? (was?.agentStatus ?? snapshotState) : snapshotState;
      const viewportRows = info.scroll?.viewport_rows;
      const title = titleOf(info);
      const cwd = info.foreground_cwd ?? info.cwd;
      if (was && (was.title !== title || was.cwd !== cwd)) titleChanged.add(id);
      // Same freshness rule as `statusSeq` above: a live `pane_updated` that landed after this
      // `session.snapshot` request was issued already applied a `revision` at least this fresh, so
      // the (older) snapshot answer must not rewind it or emit a spurious `screen-changed` for the
      // "revert". `staleStatus` is driven entirely by `pane_updated`'s own `statusSeq` stamp now
      // (`pane_agent_status_changed` no longer stamps it), so this stays correct even when the
      // fresher event never touched `revision` at all -- `was.revision` is simply left untouched in
      // that case.
      const revision = staleStatus
        ? (was?.revision ?? (typeof info.revision === "number" ? info.revision : 0))
        : typeof info.revision === "number"
          ? info.revision
          : (was?.revision ?? 0);
      if (
        !staleStatus &&
        was &&
        typeof info.revision === "number" &&
        typeof was.revision === "number" &&
        info.revision !== was.revision
      )
        revisionChanged.add(id);
      next.set(id, {
        terminalId: id,
        paneId: info.pane_id,
        workspaceId: info.workspace_id,
        tabId: info.tab_id,
        title,
        cwd,
        cols: rect?.cols ?? was?.cols ?? 80,
        rows: Math.max(1, rect?.rows ?? viewportRows ?? was?.rows ?? 24),
        rowsFromRect: rect !== undefined,
        windowNumber: workspaceNumbers.get(info.workspace_id) ?? 0,
        tabIndex: tabNumbers.get(info.tab_id) ?? 0,
        paneIndex: rect?.order ?? 0,
        focused: info.focused === true || info.pane_id === snap.focused_pane_id,
        agentStatus: state,
        scrollMax: info.scroll?.max_offset_from_bottom ?? was?.scrollMax ?? 0,
        scrollStale: was?.scrollStale ?? false,
        scrollFetchedAt: was?.scrollFetchedAt ?? 0,
        statusSeq,
        revision,
      });
      byPaneId.set(info.pane_id, id);
      workspaces.add(info.workspace_id);
      if (!staleStatus && was?.agentStatus !== state)
        changed.push({ id, state, agent: info.display_agent ?? info.agent });
    }
    const removed = [...prev.keys()].filter((id) => !next.has(id));
    const addedSet = new Set([...next.keys()].filter((id) => !prev.has(id)));
    const changedById = new Map(changed.map((c) => [c.id, c]));

    this.panes = next;
    this.byPaneId = byPaneId;
    this.workspaces = workspaces;
    this.focusedWorkspace = snap.focused_workspace_id ?? null;
    this.sortOrder();

    // Order matters: the agent must learn a session exists before it hears about its state, and
    // both must follow the sorted display order (window/tab/rect) rather than the snapshot's raw
    // pane array order, which the fixtures deliberately scramble (rect-order rule coverage).
    for (const id of removed) this.emit({ type: "session-removed", sessionId: id });
    for (const id of this.order)
      if (addedSet.has(id)) this.emit({ type: "session-added", sessionId: id });
    const at = Date.now();
    for (const id of this.order) {
      const c = changedById.get(id);
      if (c)
        this.emit({ type: "agent-state", sessionId: c.id, state: c.state, agent: c.agent, at });
    }
    // I-1: a retained pane whose title or cwd moved gets the same event the event path emits for
    // its own title updates, so `Agent.onBackendEvent` re-broadcasts `sessions` either way.
    for (const id of this.order)
      if (titleChanged.has(id)) this.emit({ type: "title-changed", sessionId: id });
    for (const id of this.order)
      if (revisionChanged.has(id)) this.emit({ type: "screen-changed", sessionId: id });
    if (removed.length > 0 || addedSet.size > 0) this.emit({ type: "layout-changed" });

    // Herdr has no incremental subscription call, so a changed pane set means a new stream.
    // This is the ONLY place that asks for one, and after it runs the sets match -- no loop.
    if (!sameSet([...byPaneId.keys()], this.subscribedPaneIds)) this.scheduleSync("resubscribe");
  }

  // ---- events ----

  private onEvent(e: HerdrEvent): void {
    try {
      this.handleEvent(e);
    } catch (err) {
      this.log.warn("herdr event handling failed", { event: e.event, error: errName(err) });
    }
  }

  /**
   * Lifecycle events arrive snake_case (`pane_created`) while the three subscription-driven ones
   * keep their dotted subscription name (`pane.agent_status_changed`). Normalising the separator
   * makes the table tolerant of both.
   */
  private handleEvent(e: HerdrEvent): void {
    const kind = e.event.replaceAll(".", "_");
    const data = e.data;
    switch (kind) {
      // --- hints: the snapshot decides what actually changed ---
      case "pane_created":
      case "pane_closed":
      case "pane_exited":
      case "pane_moved":
      case "pane_agent_detected":
      case "tab_created":
      case "tab_closed":
      case "tab_renamed":
      case "tab_moved":
      case "workspace_created":
      case "workspace_updated":
      case "workspace_closed":
      case "workspace_renamed":
      case "workspace_moved":
      case "workspace_reordered":
        this.scheduleSync("snapshot");
        return;

      // --- values on a pane that already exists ---
      // Spec 8.13 (revised after the Task 8 spike): `pane_updated.pane` is a full `PaneInfo`, not a
      // hint. An unknown `pane_id` means a pane appeared and only the snapshot can add it; a known
      // pane is updated in place -- scroll, agent status (latest-wins; `agent` may appear but no display name, so the
      // title itself is never WRITTEN from this payload), and the monotonic `revision`, which is
      // what change detection now runs on (there is no `pane.copy_motion` in Herdr 0.8.2 --
      // `docs/spike-herdr.md` Q9). A plain shell pane's title/cwd only ever change via this event,
      // though, so a moved `titleOf(info)`/`cwd` still schedules the debounced snapshot refresh --
      // the only thing that actually writes `title`/`cwd` (I-1) -- so `title-changed` keeps firing.
      case "pane_updated": {
        const info = data.pane as Partial<PaneInfo> | undefined;
        const paneId = str(info?.pane_id);
        if (!paneId) return;
        const pane = this.paneByPaneId(paneId);
        if (!pane) {
          this.scheduleSync("snapshot");
          return;
        }
        // Spec 8.13 (revised 2026-09-06): `events.subscribe` replays a bounded backlog of recent
        // events -- including old `pane_updated` revisions -- right after its ack, at a 100 ms
        // cadence, before any live event (`docs/spike-herdr.md` "Third run"). A `revision` that is
        // not strictly newer than the stored one is that replay (or a reorder) and is ignored
        // entirely: no scroll, no status, no title/cwd sync, no `screen-changed`. The stored
        // revision never moves backwards; only a snapshot (`applySnapshot`) is allowed to do that,
        // and only because it is authoritative.
        if (
          typeof info?.revision === "number" &&
          typeof pane.revision === "number" &&
          info.revision <= pane.revision
        )
          return;
        if (
          titleOf(info as PaneInfo) !== pane.title ||
          (info?.foreground_cwd ?? info?.cwd) !== pane.cwd
        )
          this.scheduleSync("snapshot");
        const scroll = scrollOf(info?.scroll);
        if (scroll && typeof scroll.max_offset_from_bottom === "number") {
          pane.scrollMax = scroll.max_offset_from_bottom;
          if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
            pane.rows = Math.max(1, scroll.viewport_rows);
          pane.scrollStale = false;
        }
        // Review fix 4's freshness stamp applies here too: this event's payload is at least as
        // fresh as anything a `session.snapshot` requested earlier could answer with.
        pane.statusSeq = ++this.eventSeq;
        const state = agentStateOf(info?.agent_status);
        if (pane.agentStatus !== state) {
          pane.agentStatus = state;
          this.emit({ type: "agent-state", sessionId: pane.terminalId, state, at: Date.now() });
        }
        if (typeof info?.revision === "number" && info.revision !== pane.revision) {
          pane.revision = info.revision;
          this.emit({ type: "screen-changed", sessionId: pane.terminalId });
        }
        return;
      }
      case "pane_agent_status_changed": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        // Spec 8.13 (revised 2026-09-06): a hint, not a mutation. It carries no revision, and the
        // subscription replay re-delivers stale ones (`docs/spike-herdr.md` "Third run"), so
        // applying it directly could flip a pane back to a status it left seconds ago. Schedule
        // the same debounced snapshot refresh as every other hint; `applySnapshot` is
        // authoritative for `agent_status` and already emits `agent-state` on a transition and
        // `title-changed` on a title change (it reads the snapshot's own `agent`/`display_agent`
        // fields), so there is nothing left to apply here directly. No `statusSeq` stamp either --
        // that freshness rule now belongs only to `pane_updated`, which is revision-ordered. The
        // live `pane_updated` Herdr emits for the same transition (measured ~0.6 s later, spec
        // 8.13) carries a revision and needs no round trip, so it usually applies first; `blocked`
        // rings otherwise trail the transition by the debounce plus one snapshot (~350 ms).
        this.scheduleSync("snapshot");
        return;
      }
      case "pane_scroll_changed": {
        // The research documents this event as `{ pane_id }` only, so the `pane.get` refresh
        // below is the PRIMARY path and the payload branch is an opportunistic shortcut for a
        // build that does send numbers. Both are cheap; neither is load-bearing on the other.
        const pane = this.paneByPaneId(str(data.pane_id));
        if (!pane) return;
        const scroll = scrollOf(data.scroll);
        if (scroll && typeof scroll.max_offset_from_bottom === "number") {
          pane.scrollMax = scroll.max_offset_from_bottom;
          if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
            pane.rows = Math.max(1, scroll.viewport_rows);
          pane.scrollStale = false;
          return;
        }
        // The payload shape is a spike item: mark it stale and let `getScreen` refresh it, at most
        // once a second, rather than firing a `pane.get` per scrolled line.
        pane.scrollStale = true;
        return;
      }
      case "layout_updated": {
        const layout = data.layout as PaneLayoutSnapshot | undefined;
        if (layout) {
          for (const [paneId, rect] of rectIndex([layout])) {
            const pane = this.paneByPaneId(paneId);
            if (!pane) continue;
            pane.cols = rect.cols;
            pane.rows = Math.max(1, rect.rows);
            pane.rowsFromRect = true;
            pane.paneIndex = rect.order;
          }
          this.sortOrder();
        }
        this.emit({ type: "layout-changed" });
        return;
      }
      case "pane_focused": {
        const pane = this.paneByPaneId(str(data.pane_id));
        if (pane) for (const p of this.panes.values()) p.focused = p === pane;
        // A pane we have never seen means our map is behind: ask the only authority there is.
        else this.scheduleSync("snapshot");
        this.emit({ type: "focus-changed" });
        return;
      }
      case "tab_focused":
      case "workspace_focused":
        this.emit({ type: "focus-changed" });
        return;
      default:
        this.log.debug("unhandled herdr event", { event: e.event });
        return;
    }
  }

  private paneByPaneId(paneId: string | undefined): Pane | undefined {
    const id = paneId ? this.byPaneId.get(paneId) : undefined;
    return id ? this.panes.get(id) : undefined;
  }

  private async refreshScroll(pane: Pane): Promise<void> {
    const now = Date.now();
    const gap = this.opts.scrollRefreshMs ?? 1000;
    if (now - pane.scrollFetchedAt < gap) return;
    pane.scrollFetchedAt = now;
    try {
      const res = await this.client.request<PaneInfoResult>("pane.get", { pane_id: pane.paneId });
      const scroll = res?.pane?.scroll;
      if (scroll && typeof scroll.max_offset_from_bottom === "number") {
        pane.scrollMax = scroll.max_offset_from_bottom;
        if (!pane.rowsFromRect && typeof scroll.viewport_rows === "number")
          pane.rows = Math.max(1, scroll.viewport_rows);
      }
      pane.scrollStale = false;
    } catch (err) {
      this.log.debug("herdr scroll refresh failed", { error: errName(err) });
    }
  }
}

/** `session.snapshot` must actually be a snapshot; anything else is a broken/incompatible herdr. */
function assertSnapshot(snap: unknown): SessionSnapshot {
  const s = snap as SessionSnapshot | undefined;
  if (!s || typeof s !== "object" || !Array.isArray(s.panes))
    throw new HerdrError("malformed", "session.snapshot returned no panes array");
  return s;
}

function rectIndex(
  layouts: PaneLayoutSnapshot[],
): Map<string, { cols: number; rows: number; order: number }> {
  const out = new Map<string, { cols: number; rows: number; order: number }>();
  for (const layout of layouts) {
    const panes = [...(layout.panes ?? [])].sort(
      (a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0) || (a.rect?.x ?? 0) - (b.rect?.x ?? 0),
    );
    panes.forEach((p, order) => {
      out.set(p.pane_id, {
        cols: Math.max(1, p.rect?.width ?? 80),
        rows: Math.max(1, p.rect?.height ?? 24),
        order,
      });
    });
  }
  return out;
}
