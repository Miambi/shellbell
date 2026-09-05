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

export type BackendEvent =
  | { type: "screen-changed"; sessionId: string }
  | { type: "layout-changed" }
  | { type: "session-added"; sessionId: string }
  | { type: "session-removed"; sessionId: string }
  | { type: "focus-changed" }
  | { type: "title-changed"; sessionId: string }
  | { type: "command-start"; sessionId: string; command: string; at: number }
  | { type: "command-end"; sessionId: string; exitCode: number; at: number }
  | { type: "prompt"; sessionId: string; at: number };

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
  /** Per-session capabilities, when this backend can distinguish (e.g. `BackendRegistry` fanning
   * out to distinct member backends by id prefix). Optional: a single-backend implementation can
   * omit it, and callers fall back to the aggregate `capabilities` getter above. */
  capabilitiesOf?(sessionId: string): Capabilities | null;
}
