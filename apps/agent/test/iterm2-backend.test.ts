import { EventEmitter } from "node:events";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import type { ClientSub } from "../src/backends/iterm2/client.js";
import {
  CoordRangeSchema,
  CoordSchema,
  FocusChangedNotificationSchema,
  FocusResponseSchema,
  GetBufferResponseSchema,
  LineContentsSchema,
  ListSessionsResponse_TabSchema,
  ListSessionsResponse_WindowSchema,
  ListSessionsResponseSchema,
  NewSessionNotificationSchema,
  type Notification,
  NotificationResponseSchema,
  NotificationSchema,
  PromptNotificationCommandEndSchema,
  PromptNotificationCommandStartSchema,
  PromptNotificationPromptSchema,
  PromptNotificationSchema,
  ScreenUpdateNotificationSchema,
  SendTextResponseSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
  SessionSummarySchema,
  SizeSchema,
  SplitTreeNode_SplitTreeLinkSchema,
  SplitTreeNodeSchema,
  TerminateSessionNotificationSchema,
  VariableChangedNotificationSchema,
  VariableResponseSchema,
  WindowedCoordRangeSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { BackendUnavailable } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

class FakeClient extends EventEmitter<{ notification: [Notification]; close: [] }> {
  connected = false;
  connects = 0;
  failConnects = 0;
  failListSessions = 0;
  calls: ClientSub[] = [];
  async connect() {
    this.connects++;
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("fake connect failed");
    }
    this.connected = true;
  }
  close() {
    this.connected = false;
  }
  async request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    this.calls.push(sub);
    const reply = (value: ServerOriginatedMessage["submessage"]) =>
      create(ServerOriginatedMessageSchema, { id: 1n, submessage: value });
    switch (sub.case) {
      case "listSessionsRequest":
        if (this.failListSessions > 0) {
          this.failListSessions--;
          throw new Error("fake ListSessions failed");
        }
        return reply({ case: "listSessionsResponse", value: layout() });
      case "focusRequest":
        return reply({
          case: "focusResponse",
          value: create(FocusResponseSchema, {
            notifications: [
              create(FocusChangedNotificationSchema, { event: { case: "session", value: "S2" } }),
            ],
          }),
        });
      case "notificationRequest":
        return reply({
          case: "notificationResponse",
          value: create(NotificationResponseSchema, { status: 0 }),
        });
      case "variableRequest": {
        const name = sub.value.get[0];
        const sid = sub.value.scope.case === "sessionId" ? sub.value.scope.value : "";
        const v =
          name === "session.name" ? JSON.stringify(`title-${sid}`) : JSON.stringify(`/home/${sid}`);
        return reply({
          case: "variableResponse",
          value: create(VariableResponseSchema, { status: 0, values: [v] }),
        });
      }
      case "getBufferRequest":
        return reply({
          case: "getBufferResponse",
          value: create(GetBufferResponseSchema, {
            contents: [create(LineContentsSchema, { text: "hello" })],
            cursor: create(CoordSchema, { x: 5, y: 101n }),
            windowedCoordRange: create(WindowedCoordRangeSchema, {
              coordRange: create(CoordRangeSchema, {
                start: create(CoordSchema, { x: 0, y: 100n }),
              }),
            }),
          }),
        });
      case "sendTextRequest":
        return reply({
          case: "sendTextResponse",
          value: create(SendTextResponseSchema, { status: sub.value.session === "gone" ? 1 : 0 }),
        });
      default:
        throw new Error(`unexpected ${sub.case}`);
    }
  }
}

function layout() {
  const sess = (id: string, w: number, h: number) =>
    create(SessionSummarySchema, {
      uniqueIdentifier: id,
      title: `t-${id}`,
      gridSize: create(SizeSchema, { width: w, height: h }),
    });
  const leaf = (s: ReturnType<typeof sess>) =>
    create(SplitTreeNode_SplitTreeLinkSchema, { child: { case: "session", value: s } });
  return create(ListSessionsResponseSchema, {
    windows: [
      create(ListSessionsResponse_WindowSchema, {
        windowId: "w1",
        number: 1,
        tabs: [
          create(ListSessionsResponse_TabSchema, {
            tabId: "t1",
            root: create(SplitTreeNodeSchema, {
              links: [leaf(sess("S1", 80, 24)), leaf(sess("S2", 80, 24))],
            }),
          }),
          create(ListSessionsResponse_TabSchema, {
            tabId: "t2",
            tmuxWindowId: "@5",
            root: create(SplitTreeNodeSchema, { links: [leaf(sess("S3", 100, 30))] }),
          }),
        ],
      }),
    ],
  });
}

const log = createLogger({ stdout: false });

describe("ITerm2Backend", () => {
  it("lists sessions with titles, cwd, layout positions and focus; exposes tmux window ids", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const list = await b.listSessions();
    expect(
      list.map((s) => [s.id, s.title, s.cwd, s.tabIndex, s.paneIndex, s.isFocusedOnMac]),
    ).toEqual([
      ["S1", "title-S1", "/home/S1", 0, 0, false],
      ["S2", "title-S2", "/home/S2", 0, 1, true],
      ["S3", "title-S3", "/home/S3", 1, 0, false],
    ]);
    expect(list[2]?.cols).toBe(100);
    expect(b.tmuxWindowIds?.()).toEqual(new Set(["@5"]));

    const notifs = client.calls.filter((c) => c.case === "notificationRequest");
    expect(notifs.length).toBeGreaterThanOrEqual(4 + 3 * 4); // 4 global + per session: screen, prompt, 2 variables

    const promptSub = notifs.find(
      (c) =>
        c.case === "notificationRequest" &&
        c.value.session === "S1" &&
        c.value.arguments.case === "promptMonitorRequest",
    );
    expect(
      promptSub?.case === "notificationRequest" &&
        promptSub.value.arguments.case === "promptMonitorRequest"
        ? promptSub.value.arguments.value.modes
        : undefined,
    ).toEqual([0, 1, 2].map((i) => i + 1)); // PROMPT, COMMAND_START, COMMAND_END

    const nameSub = notifs.find(
      (c) =>
        c.case === "notificationRequest" &&
        c.value.session === "S1" &&
        c.value.arguments.case === "variableMonitorRequest" &&
        c.value.arguments.value.name === "session.name",
    );
    expect(
      nameSub?.case === "notificationRequest" &&
        nameSub.value.arguments.case === "variableMonitorRequest"
        ? [nameSub.value.arguments.value.scope, nameSub.value.arguments.value.identifier]
        : undefined,
    ).toEqual([1, "S1"]); // VariableScope.SESSION, session id

    // Re-listing (a second LayoutChange for the same sessions) must not re-issue variable
    // requests for sessions already subscribed -- only the initial per-session requests exist.
    const variableReqsBefore = client.calls.filter((c) => c.case === "variableRequest").length;
    client.emit(
      "notification",
      create(NotificationSchema, { layoutChangedNotification: { listSessionsResponse: layout() } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const variableReqsAfter = client.calls.filter((c) => c.case === "variableRequest").length;
    expect(variableReqsAfter).toBe(variableReqsBefore);
  });

  it("getScreen requests screen-only contents with styles and converts with absolute scrollback and screen-relative cursor", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const s = await b.getScreen("S1");
    expect(s.rows).toBe(24);
    expect(s.lines[0]).toEqual({ r: [{ t: "hello" }] });
    expect(s.scrollbackTotal).toBe(100);
    expect(s.cursor).toEqual({ x: 5, y: 1 });

    const req = client.calls.find((c) => c.case === "getBufferRequest");
    expect(
      req?.case === "getBufferRequest" ? req.value.lineRange?.screenContentsOnly : undefined,
    ).toBe(true);
    expect(req?.case === "getBufferRequest" ? req.value.includeStyles : undefined).toBe(true);
  });

  it("maps notifications to backend events", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type + ("sessionId" in e ? `:${e.sessionId}` : "")));

    client.emit(
      "notification",
      create(NotificationSchema, {
        screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: {
            case: "commandStart",
            value: create(PromptNotificationCommandStartSchema, { command: "ls" }),
          },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: {
            case: "commandEnd",
            value: create(PromptNotificationCommandEndSchema, { status: 0 }),
          },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: { case: "prompt", value: create(PromptNotificationPromptSchema, {}) },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        focusChangedNotification: create(FocusChangedNotificationSchema, {
          event: { case: "session", value: "S3" },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        variableChangedNotification: create(VariableChangedNotificationSchema, {
          identifier: "S1",
          name: "session.name",
          jsonNewValue: JSON.stringify("renamed"),
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        terminateSessionNotification: create(TerminateSessionNotificationSchema, {
          sessionId: "S2",
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        newSessionNotification: create(NewSessionNotificationSchema, { sessionId: "S9" }),
      }),
    );

    expect(events).toEqual([
      "screen-changed:S1",
      "command-start:S1",
      "command-end:S1",
      "prompt:S1",
      "focus-changed",
      "title-changed:S1",
      "session-removed:S2",
      "layout-changed",
      "session-added:S9",
    ]);

    const list = await b.listSessions();
    expect(list.find((s) => s.id === "S1")?.title).toBe("renamed");

    // Let the new_session-triggered ListSessions refresh (fire-and-forget) settle before the
    // test ends, so it can't leak a pending timer/rejection into the next test.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("a failing new_session ListSessions refresh never produces an unhandled rejection, and the backend stays connected", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();

    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      client.failListSessions = 1;
      const events: string[] = [];
      b.on((e) => events.push(e.type));
      client.emit(
        "notification",
        create(NotificationSchema, {
          newSessionNotification: create(NewSessionNotificationSchema, { sessionId: "S9" }),
        }),
      );
      // session-added is emitted synchronously, before the failing ListSessions settles.
      expect(events).toEqual(["session-added"]);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toBeUndefined();
      expect(client.connected).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it(
    "reconnects with exponential backoff while retries fail, resets after a successful connect, " +
      "and stops after close()",
    async () => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 40 });
      await b.connect();
      expect(client.connects).toBe(1);

      // Drop the connection; the next three retries (10 ms, 20 ms, 40 ms backoff) all fail.
      client.connected = false;
      client.failConnects = 3;
      client.emit("close");

      await vi.advanceTimersByTimeAsync(15);
      expect(client.connects).toBe(2); // retry #1 at +10 ms (fails)

      await vi.advanceTimersByTimeAsync(10); // elapsed 25 ms; retry #2 due at +30 ms, not yet
      expect(client.connects).toBe(2);

      await vi.advanceTimersByTimeAsync(10); // elapsed 35 ms; retry #2 fired at +30 ms (fails)
      expect(client.connects).toBe(3);

      await vi.advanceTimersByTimeAsync(30); // elapsed 65 ms; retry #3 due at +70 ms, not yet
      expect(client.connects).toBe(3);

      await vi.advanceTimersByTimeAsync(10); // elapsed 75 ms; retry #3 fired at +70 ms (fails, capped at 40 ms backoff)
      expect(client.connects).toBe(4);

      // Let the next retry (+40 ms, still capped) succeed.
      client.failConnects = 0;
      await vi.advanceTimersByTimeAsync(45); // elapsed 120 ms; retry #4 fired at +110 ms (succeeds)
      expect(client.connects).toBe(5);
      expect(client.connected).toBe(true);

      // Reset-on-success: one more drop retries at the base 10 ms again, not a longer delay.
      client.connected = false;
      client.emit("close");
      await vi.advanceTimersByTimeAsync(15);
      expect(client.connects).toBe(6); // back to the base 10 ms delay

      // close() cancels any pending/future retry.
      client.connected = false;
      await b.close();
      client.emit("close");
      await vi.advanceTimersByTimeAsync(200);
      expect(client.connects).toBe(6); // close() cancels the retry loop
      vi.useRealTimers();
    },
  );

  it("connect() rejects with BackendUnavailable when the post-handshake ListSessions fails", async () => {
    const client = new FakeClient();
    client.failListSessions = 1;
    const b = new ITerm2Backend(client as never, log);
    await expect(b.connect()).rejects.toThrow(BackendUnavailable);
  });

  it(
    "a post-handshake failure (socket connects, ListSessions fails) does not reset the backoff " +
      "attempt -- the retry delay keeps growing",
    async () => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 1000 });
      await b.connect();
      const lsAttempts = () => client.calls.filter((c) => c.case === "listSessionsRequest").length;
      expect(lsAttempts()).toBe(1);

      // The socket-level connect succeeds and stays connected throughout (a post-handshake RPC
      // failure does not necessarily close the socket); only the post-handshake ListSessions
      // fails, twice. `client.calls` (not `client.connects`, which only counts socket-level
      // connects) is the reliable per-attempt counter here, since `ITerm2Backend.connect()`
      // skips re-dialing a socket that's already open. If `attempt` were wrongly reset as soon
      // as the post-handshake sequence started (the bug this test guards against), the retry
      // delay would flatten back to 10 ms each time instead of growing 10 ms -> 20 ms.
      client.connected = false;
      client.failListSessions = 2;
      client.emit("close");

      await vi.advanceTimersByTimeAsync(15);
      expect(lsAttempts()).toBe(2); // retry #1 at +10 ms: ListSessions fails

      await vi.advanceTimersByTimeAsync(10); // elapsed 25 ms; retry #2 due at +30 ms, not yet
      expect(lsAttempts()).toBe(2);

      await vi.advanceTimersByTimeAsync(10); // elapsed 35 ms; retry #2 fires at +30 ms (fails again)
      expect(lsAttempts()).toBe(3);

      client.failListSessions = 0;
      await vi.advanceTimersByTimeAsync(45); // retry #3 at +40 ms more succeeds
      expect(lsAttempts()).toBe(4);
      expect(client.connected).toBe(true);
      vi.useRealTimers();
    },
  );

  it("sendText maps SESSION_NOT_FOUND to SessionGone, and suppresses broadcast", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    await b.sendText("S1", "ls\r");
    await expect(b.sendText("gone", "x")).rejects.toThrow(/session gone/);

    const req = client.calls.find((c) => c.case === "sendTextRequest" && c.value.session === "S1");
    expect(req?.case === "sendTextRequest" ? req.value.suppressBroadcast : undefined).toBe(true);
  });
});
