import type {
  BackendName,
  Capabilities,
  CreateWhere,
  Cursor,
  Line,
  SessionInfo,
} from "@shellbell/protocol";

export type { Capabilities, CreateWhere, SessionInfo };

export interface Screen {
  cols: number;
  rows: number;
  cursor: Cursor;
  lines: Line[];
  scrollbackTotal: number;
}

/** Spec 8.13: the semantic state Herdr reports per pane. Shared with the `agent-state` event. */
export type AgentState = "working" | "blocked" | "idle" | "done" | "unknown";

export type BackendEvent =
  | { type: "screen-changed"; sessionId: string }
  | { type: "layout-changed" }
  | { type: "session-added"; sessionId: string }
  | { type: "session-removed"; sessionId: string }
  | { type: "focus-changed" }
  | { type: "title-changed"; sessionId: string }
  | { type: "command-start"; sessionId: string; command: string; at: number }
  | { type: "command-end"; sessionId: string; exitCode: number; at: number }
  | { type: "prompt"; sessionId: string; at: number }
  /**
   * Spec 8.13: Herdr's semantic per-pane agent state. Only the herdr backend emits it; the
   * `EventEngine` turns it into `blocked` and `prompt` rings (Task 5). Herdr has no command
   * lifecycle, so this replaces `command-start`/`command-end` rather than supplementing them.
   */
  | { type: "agent-state"; sessionId: string; state: AgentState; agent?: string; at: number };

export class BackendUnavailable extends Error {
  constructor(
    message: string,
    public readonly hint: string,
  ) {
    super(message);
    this.name = "BackendUnavailable";
  }
}
export class SessionGone extends Error {
  constructor(id: string) {
    super(`session gone: ${id}`);
    this.name = "SessionGone";
  }
}
export class Unsupported extends Error {
  constructor(what: string) {
    super(`unsupported: ${what}`);
    this.name = "Unsupported";
  }
}
/** Spec 8.12: a `session.create` whose windowId prefix does not match `where.backend`. */
export class BadWindow extends Error {
  constructor(windowId: string) {
    super(`bad-window: ${windowId}`);
    this.name = "BadWindow";
  }
}

export interface TerminalBackend {
  readonly name: BackendName;
  readonly capabilities: Capabilities;
  connect(): Promise<void>;
  close(): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getScreen(sessionId: string): Promise<Screen>;
  getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }>;
  sendText(sessionId: string, text: string): Promise<void>;
  createSession(where: CreateWhere): Promise<string>;
  focus(sessionId: string): Promise<void>;
  on(handler: (e: BackendEvent) => void): () => void;
  tmuxWindowIds?(): Set<string>;
  tmuxWindowIdOf?(nativeId: string): string | undefined;
  /** SHIPPED — do not remove. Per-session capabilities, when this backend can distinguish (e.g.
   * `BackendRegistry` fanning out to distinct member backends by id prefix). Optional: a
   * single-backend implementation can omit it, and callers fall back to the aggregate
   * `capabilities` getter above. `ScreenTracker.processScreen` already consults this for its
   * per-session `absoluteLines` decision. */
  capabilitiesOf?(sessionId: string): Capabilities | null;
  /**
   * Spec 8.13: the complete set of native session ids at least one phone is currently viewing.
   * A backend with no screen-change push (herdr) polls only these. `ScreenTracker` calls it
   * through the registry on every viewer change, always with the full set (never a delta), and
   * with `[]` when nothing is viewed. Backends that push screen changes ignore it.
   */
  setWatched?(nativeIds: string[]): void;
  /**
   * Spec 8.11 (tmux history): the tracker's monotonic `scrollbackTotal` for one session. A backend
   * whose native scrollback counter is NOT monotonic (tmux's `history_size` saturates at
   * `history-limit` and can shrink) needs this value to turn the phone's absolute `before` into a
   * `capture-pane -S/-E` range. `ScreenTracker.processScreen` pushes it once per processed frame,
   * through the registry, which strips the id prefix. Backends with absolute line numbers ignore it.
   */
  setReported?(nativeId: string, reported: number): void;
  /**
   * Spec 8.12/8.13: `false` while the backend's transport is down. The registry keeps such a
   * member registered (it reconnects itself) but leaves it out of `hello.backends`. A backend
   * that omits this property is always considered connected. Named `isConnected` (not
   * `connected`) because `BackendRegistry.connected()` is a pre-existing, unrelated aggregate
   * method (returns the list of connected member backends) and the two must not collide.
   */
  readonly isConnected?: boolean;
}
