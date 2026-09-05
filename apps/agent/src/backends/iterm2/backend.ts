import { create } from "@bufbuild/protobuf";
import type { Capabilities, CreateWhere, Line, SessionInfo } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import {
  type BackendEvent,
  BackendUnavailable,
  type Screen,
  SessionGone,
  type TerminalBackend,
} from "../types.js";
import type { ITerm2Client } from "./client.js";
import { bufferToScreen, lineContentsToLine } from "./convert.js";
import {
  ActivateRequest_AppSchema,
  ActivateRequestSchema,
  CoordRangeSchema,
  CoordSchema,
  CreateTabRequestSchema,
  FocusRequestSchema,
  GetBufferRequestSchema,
  LineRangeSchema,
  ListSessionsRequestSchema,
  type ListSessionsResponse,
  type Notification,
  NotificationRequestSchema,
  NotificationType,
  PromptMonitorMode,
  PromptMonitorRequestSchema,
  SendTextRequestSchema,
  SplitPaneRequest_SplitDirection,
  SplitPaneRequestSchema,
  type SplitTreeNode,
  VariableMonitorRequestSchema,
  VariableRequestSchema,
  VariableScope,
  WindowedCoordRangeSchema,
} from "./gen/iterm2_pb.js";

interface Native {
  id: string;
  title: string;
  cwd?: string;
  cols: number;
  rows: number;
  windowId: string;
  windowNumber: number;
  tabId: string;
  tabIndex: number;
  paneIndex: number;
  tmuxWindowId?: string;
}

export class ITerm2Backend implements TerminalBackend {
  readonly name = "iterm2" as const;
  readonly capabilities: Capabilities = {
    subscribe: true,
    prompts: true,
    createSession: true,
    focus: true,
    history: true,
    absoluteLines: true,
  };
  private sessions = new Map<string, Native>();
  private order: string[] = [];
  private focused: string | null = null;
  private readonly handlers = new Set<(e: BackendEvent) => void>();
  private readonly subscribed = new Set<string>();
  private readonly log: Logger;

  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly client: ITerm2Client,
    log: Logger,
    private readonly backoff: { minMs?: number; maxMs?: number } = {},
  ) {
    this.log = log.child({ backend: "iterm2" });
    this.client.on("notification", (n) => this.onNotification(n));
    this.client.on("close", () => {
      this.sessions.clear();
      this.order = [];
      this.subscribed.clear();
      this.emit({ type: "layout-changed" });
      this.scheduleReconnect();
    });
  }

  /** Spec 8.5.1 step 4: 1 s -> 2 s -> 4 s -> 8 s -> 16 s -> 30 s cap, fresh cookie each attempt. */
  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const min = this.backoff.minMs ?? 1000;
    const max = this.backoff.maxMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.log.info("iTerm2 gone; retrying", { delayMs: delay, attempt: this.attempt });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((err) => {
        this.log.warn("iTerm2 reconnect failed", { err: String(err) });
        this.scheduleReconnect();
      });
    }, delay);
  }

  async connect(): Promise<void> {
    this.closed = false;
    if (!this.client.connected) {
      try {
        await this.client.connect();
      } catch (err) {
        throw new BackendUnavailable(
          String(err),
          "iTerm2 → Settings → General → Magic → ✓ Enable Python API, then run `shellbell` again.",
        );
      }
    }
    this.attempt = 0;
    for (const t of [
      NotificationType.NOTIFY_ON_LAYOUT_CHANGE,
      NotificationType.NOTIFY_ON_NEW_SESSION,
      NotificationType.NOTIFY_ON_TERMINATE_SESSION,
      NotificationType.NOTIFY_ON_FOCUS_CHANGE,
    ]) {
      await this.client.request({
        case: "notificationRequest",
        value: create(NotificationRequestSchema, { subscribe: true, notificationType: t }),
      });
    }
    const ls = await this.client.request({
      case: "listSessionsRequest",
      value: create(ListSessionsRequestSchema, {}),
    });
    if (ls.submessage.case === "listSessionsResponse") await this.applyLayout(ls.submessage.value);
    const focus = await this.client.request({
      case: "focusRequest",
      value: create(FocusRequestSchema, {}),
    });
    if (focus.submessage.case === "focusResponse") {
      for (const n of focus.submessage.value.notifications)
        if (n.event.case === "session") this.focused = n.event.value;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client.close();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.order.map((id) => this.toInfo(this.sessions.get(id) as Native));
  }

  tmuxWindowIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values()) if (s.tmuxWindowId) out.add(s.tmuxWindowId);
    return out;
  }

  async getScreen(sessionId: string): Promise<Screen> {
    const native = this.sessions.get(sessionId);
    if (!native) throw new SessionGone(sessionId);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: sessionId,
        lineRange: create(LineRangeSchema, { screenContentsOnly: true }),
        includeStyles: true,
      }),
    });
    if (res.submessage.case !== "getBufferResponse" || res.submessage.value.status !== 0)
      throw new SessionGone(sessionId);
    return bufferToScreen(res.submessage.value, native.rows, native.cols);
  }

  async getHistory(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    if (!this.sessions.has(sessionId)) throw new SessionGone(sessionId);
    const start = Math.max(0, before - count);
    const res = await this.client.request({
      case: "getBufferRequest",
      value: create(GetBufferRequestSchema, {
        session: sessionId,
        lineRange: create(LineRangeSchema, {
          windowedCoordRange: create(WindowedCoordRangeSchema, {
            coordRange: create(CoordRangeSchema, {
              start: create(CoordSchema, { x: 0, y: BigInt(start) }),
              end: create(CoordSchema, { x: 0, y: BigInt(before) }),
            }),
          }),
        }),
        includeStyles: true,
      }),
    });
    if (res.submessage.case !== "getBufferResponse") throw new SessionGone(sessionId);
    const lines = res.submessage.value.contents.map(lineContentsToLine);
    const oldestAvailable = lines.length < before - start ? before - lines.length : 0;
    return { lines, oldestAvailable };
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const res = await this.client.request({
      case: "sendTextRequest",
      value: create(SendTextRequestSchema, { session: sessionId, text, suppressBroadcast: true }),
    });
    if (res.submessage.case !== "sendTextResponse" || res.submessage.value.status !== 0)
      throw new SessionGone(sessionId);
  }

  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "tab") {
      const res = await this.client.request({
        case: "createTabRequest",
        value: create(CreateTabRequestSchema, { windowId: where.windowId, selectTab: false }),
      });
      if (res.submessage.case !== "createTabResponse" || !res.submessage.value.sessionId)
        throw new Error("create tab failed");
      return res.submessage.value.sessionId;
    }
    const res = await this.client.request({
      case: "splitPaneRequest",
      value: create(SplitPaneRequestSchema, {
        session: where.sessionId,
        splitDirection:
          where.direction === "vertical"
            ? SplitPaneRequest_SplitDirection.VERTICAL
            : SplitPaneRequest_SplitDirection.HORIZONTAL,
      }),
    });
    const id =
      res.submessage.case === "splitPaneResponse" ? res.submessage.value.sessionId[0] : undefined;
    if (!id) throw new Error("split failed");
    return id;
  }

  async focus(sessionId: string): Promise<void> {
    await this.client.request({
      case: "activateRequest",
      value: create(ActivateRequestSchema, {
        identifier: { case: "sessionId", value: sessionId },
        orderWindowFront: true,
        selectTab: true,
        selectSession: true,
        activateApp: create(ActivateRequest_AppSchema, {
          raiseAllWindows: false,
          ignoringOtherApps: false,
        }),
      }),
    });
  }

  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- internals ----

  private emit(e: BackendEvent): void {
    for (const h of this.handlers) h(e);
  }

  private toInfo(n: Native): SessionInfo {
    return {
      id: n.id,
      backend: "iterm2",
      title: n.title,
      cwd: n.cwd,
      cols: n.cols,
      rows: n.rows,
      windowId: n.windowId,
      windowNumber: n.windowNumber,
      tabId: n.tabId,
      tabIndex: n.tabIndex,
      paneIndex: n.paneIndex,
      isFocusedOnMac: this.focused === n.id,
      state: "unknown",
    };
  }

  private async applyLayout(layout: ListSessionsResponse): Promise<void> {
    const next = new Map<string, Native>();
    const order: string[] = [];
    const windows = [...layout.windows].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    for (const w of windows) {
      w.tabs.forEach((tab, tabIndex) => {
        let paneIndex = 0;
        const walk = (node: SplitTreeNode | undefined) => {
          if (!node) return;
          for (const link of node.links) {
            if (link.child.case === "session") {
              const s = link.child.value;
              const id = s.uniqueIdentifier ?? "";
              const prev = this.sessions.get(id);
              next.set(id, {
                id,
                title: prev?.title ?? s.title ?? "Session",
                cwd: prev?.cwd,
                cols: s.gridSize?.width ?? 80,
                rows: s.gridSize?.height ?? 24,
                windowId: w.windowId ?? "",
                windowNumber: w.number ?? 0,
                tabId: tab.tabId ?? "",
                tabIndex,
                paneIndex: paneIndex++,
                tmuxWindowId: tab.tmuxWindowId || undefined,
              });
              order.push(id);
            } else if (link.child.case === "node") walk(link.child.value);
          }
        };
        walk(tab.root);
      });
    }
    for (const id of this.sessions.keys()) if (!next.has(id)) this.subscribed.delete(id);
    this.sessions = next;
    this.order = order;
    await Promise.all(order.map((id) => this.ensureSession(id)));
    this.emit({ type: "layout-changed" });
  }

  private async ensureSession(id: string): Promise<void> {
    const n = this.sessions.get(id);
    if (!n) return;
    if (!this.subscribed.has(id)) {
      this.subscribed.add(id);
      const subs = [
        create(NotificationRequestSchema, {
          session: id,
          subscribe: true,
          notificationType: NotificationType.NOTIFY_ON_SCREEN_UPDATE,
        }),
        create(NotificationRequestSchema, {
          session: id,
          subscribe: true,
          notificationType: NotificationType.NOTIFY_ON_PROMPT,
          arguments: {
            case: "promptMonitorRequest",
            value: create(PromptMonitorRequestSchema, {
              modes: [
                PromptMonitorMode.PROMPT,
                PromptMonitorMode.COMMAND_START,
                PromptMonitorMode.COMMAND_END,
              ],
            }),
          },
        }),
        ...["session.name", "session.path"].map((name) =>
          create(NotificationRequestSchema, {
            session: id,
            subscribe: true,
            notificationType: NotificationType.NOTIFY_ON_VARIABLE_CHANGE,
            arguments: {
              case: "variableMonitorRequest",
              value: create(VariableMonitorRequestSchema, {
                name,
                scope: VariableScope.SESSION,
                identifier: id,
              }),
            },
          }),
        ),
      ];
      for (const s of subs) {
        try {
          await this.client.request({ case: "notificationRequest", value: s });
        } catch (err) {
          this.log.warn("subscribe failed", { session: id.slice(0, 8), err: String(err) });
        }
      }
    }
    const [name, path] = await Promise.all([
      this.variable(id, "session.name"),
      this.variable(id, "session.path"),
    ]);
    if (name) n.title = name;
    if (path) n.cwd = path;
  }

  private async variable(id: string, name: string): Promise<string | undefined> {
    try {
      const res = await this.client.request({
        case: "variableRequest",
        value: create(VariableRequestSchema, {
          scope: { case: "sessionId", value: id },
          get: [name],
        }),
      });
      if (res.submessage.case !== "variableResponse" || res.submessage.value.status !== 0)
        return undefined;
      const raw = res.submessage.value.values[0];
      if (!raw || raw === "null") return undefined;
      const v = JSON.parse(raw);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private onNotification(n: Notification): void {
    const now = Date.now();
    if (n.screenUpdateNotification?.session) {
      this.emit({ type: "screen-changed", sessionId: n.screenUpdateNotification.session });
      return;
    }
    if (n.promptNotification?.session) {
      const p = n.promptNotification;
      const sid = p.session as string;
      if (p.event.case === "commandStart")
        this.emit({
          type: "command-start",
          sessionId: sid,
          command: p.event.value.command ?? "",
          at: now,
        });
      else if (p.event.case === "commandEnd")
        this.emit({
          type: "command-end",
          sessionId: sid,
          exitCode: p.event.value.status ?? 0,
          at: now,
        });
      else if (p.event.case === "prompt") this.emit({ type: "prompt", sessionId: sid, at: now });
      return;
    }
    if (n.layoutChangedNotification?.listSessionsResponse) {
      void this.applyLayout(n.layoutChangedNotification.listSessionsResponse);
      return;
    }
    if (n.newSessionNotification?.sessionId) {
      void this.client
        .request({ case: "listSessionsRequest", value: create(ListSessionsRequestSchema, {}) })
        .then((ls) => {
          if (ls.submessage.case === "listSessionsResponse")
            return this.applyLayout(ls.submessage.value);
        });
      this.emit({ type: "session-added", sessionId: n.newSessionNotification.sessionId });
      return;
    }
    if (n.terminateSessionNotification?.sessionId) {
      const id = n.terminateSessionNotification.sessionId;
      this.sessions.delete(id);
      this.subscribed.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.emit({ type: "session-removed", sessionId: id });
      this.emit({ type: "layout-changed" });
      return;
    }
    if (n.focusChangedNotification) {
      if (n.focusChangedNotification.event.case === "session")
        this.focused = n.focusChangedNotification.event.value;
      this.emit({ type: "focus-changed" });
      return;
    }
    if (n.variableChangedNotification?.identifier) {
      const v = n.variableChangedNotification;
      const s = this.sessions.get(v.identifier as string);
      if (!s) return;
      try {
        const val = JSON.parse(v.jsonNewValue ?? "null");
        if (v.name === "session.name" && typeof val === "string") s.title = val;
        if (v.name === "session.path" && typeof val === "string") s.cwd = val;
      } catch {
        return;
      }
      this.emit({ type: "title-changed", sessionId: s.id });
    }
  }
}
