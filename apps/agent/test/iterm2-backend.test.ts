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
  type Notification,
  NotificationResponseSchema,
  NotificationSchema,
  PromptNotificationCommandEndSchema,
  PromptNotificationSchema,
  ScreenUpdateNotificationSchema,
  SendTextResponseSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
  SessionSummarySchema,
  SizeSchema,
  SplitTreeNode_SplitTreeLinkSchema,
  SplitTreeNodeSchema,
  VariableResponseSchema,
  WindowedCoordRangeSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { createLogger } from "../src/log.js";

class FakeClient extends EventEmitter<{ notification: [Notification]; close: [] }> {
  connected = true;
  calls: ClientSub[] = [];
  async connect() {}
  close() {}
  async request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    this.calls.push(sub);
    const reply = (value: ServerOriginatedMessage["submessage"]) =>
      create(ServerOriginatedMessageSchema, { id: 1n, submessage: value });
    switch (sub.case) {
      case "listSessionsRequest":
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
  });

  it("getScreen converts with absolute scrollback and screen-relative cursor", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const s = await b.getScreen("S1");
    expect(s.rows).toBe(24);
    expect(s.lines[0]).toEqual({ r: [{ t: "hello" }] });
    expect(s.scrollbackTotal).toBe(100);
    expect(s.cursor).toEqual({ x: 5, y: 1 });
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
            case: "commandEnd",
            value: create(PromptNotificationCommandEndSchema, { status: 0 }),
          },
        }),
      }),
    );
    expect(events).toEqual(["screen-changed:S1", "command-end:S1"]);
  });

  it("reconnects with backoff after the iTerm2 socket closes, and stops after close()", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    let connects = 0;
    client.connect = async () => {
      connects++;
      client.connected = true;
    };
    const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 40 });
    await b.connect();
    expect(connects).toBe(1);
    client.connected = false;
    client.emit("close");
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(2); // first retry at 10 ms
    client.connected = false;
    client.emit("close");
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(2); // second retry is at 20 ms, not yet due
    await vi.advanceTimersByTimeAsync(15);
    expect(connects).toBe(3);
    await b.close();
    client.emit("close");
    await vi.advanceTimersByTimeAsync(200);
    expect(connects).toBe(3); // close() cancels the retry loop
    vi.useRealTimers();
  });

  it("sendText maps SESSION_NOT_FOUND to SessionGone", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    await b.sendText("S1", "ls\r");
    await expect(b.sendText("gone", "x")).rejects.toThrow(/session gone/);
  });
});
