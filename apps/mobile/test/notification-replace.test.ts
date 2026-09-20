import { describe, expect, it, vi } from "vitest";
import { extractRingPayload, handleIncomingRing } from "../src/notifications/ring";

function deps() {
  return {
    lookup: () => ({ title: "claude-code", backend: "herdr" }),
    present: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
  };
}

describe("handleIncomingRing (spec 2026-09-20 §4)", () => {
  it("presents an enriched notification keyed to the session", async () => {
    const d = deps();
    await handleIncomingRing(
      { computerFp: "abc", sessionId: "s1", kind: "blocked" },
      "incoming-id",
      d,
    );
    expect(d.present).toHaveBeenCalledWith({
      identifier: "abc:s1",
      title: "claude-code",
      body: "An agent is waiting for you",
    });
  });

  it("dismisses the relay's generic notification it replaced", async () => {
    const d = deps();
    await handleIncomingRing(
      { computerFp: "abc", sessionId: "s1", kind: "idle" },
      "incoming-id",
      d,
    );
    expect(d.dismiss).toHaveBeenCalledWith("incoming-id");
  });

  it("does nothing when the payload is not a ring", async () => {
    const d = deps();
    await handleIncomingRing({ computerFp: "", sessionId: "", kind: "" }, "incoming-id", d);
    expect(d.present).not.toHaveBeenCalled();
    expect(d.dismiss).not.toHaveBeenCalled();
  });

  it("still presents when the title is unknown, using the fallback", async () => {
    const d = { ...deps(), lookup: () => undefined };
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "i", d);
    expect(d.present).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Session", identifier: "abc:s1" }),
    );
  });

  it("never dismisses without presenting first (a swapped await must not pass)", async () => {
    const order: string[] = [];
    const d = {
      lookup: () => ({ title: "claude-code", backend: "herdr" }),
      present: vi.fn(async () => {
        order.push("present");
      }),
      dismiss: vi.fn(async () => {
        order.push("dismiss");
      }),
    };
    await handleIncomingRing({ computerFp: "abc", sessionId: "s1", kind: "idle" }, "i", d);
    expect(order).toEqual(["present", "dismiss"]);
  });
});

/**
 * Spec 2026-09-20 §4 / review finding: `expo-task-manager`'s background delivery is NOT run
 * through expo-notifications' `mapNotificationContent`, so the raw payload never has `.data` —
 * only `.dataString`, a JSON string, which must be parsed here. Traced against the installed
 * native source: `RemoteMessageSerializer.java` (`data.dataString`, Android's plain-message
 * path), `NotificationSerializer.java` (`content.dataString`, the tap/response path), and
 * `mapNotificationResponse.ts`'s `mapNotificationContent`, which performs the identical
 * `dataString` → `JSON.parse` → `.data` mapping for the paths that DO get mapped (confirming the
 * shape). `.data` is kept as a fallback for whichever path already mapped it.
 */
describe("extractRingPayload (spec 2026-09-20 §4: raw expo-task-manager payload shapes)", () => {
  const payload = { computerFp: "abc", sessionId: "s1", kind: "idle" };

  it("parses a dataString-carrying request (the real, unmapped background-task shape)", () => {
    expect(extractRingPayload({ dataString: JSON.stringify(payload) })).toEqual(payload);
  });

  it("falls back to an already-mapped data field", () => {
    expect(extractRingPayload({ data: payload })).toEqual(payload);
  });

  it("fails safe (no throw) on malformed JSON", () => {
    expect(extractRingPayload({ dataString: "{not json" })).toBeUndefined();
  });

  it("fails safe on a missing payload", () => {
    expect(extractRingPayload(undefined)).toBeUndefined();
    expect(extractRingPayload(null)).toBeUndefined();
    expect(extractRingPayload({})).toBeUndefined();
  });

  it("fails safe when required fields are missing", () => {
    expect(extractRingPayload({ data: { computerFp: "abc" } })).toBeUndefined();
    expect(
      extractRingPayload({ dataString: JSON.stringify({ computerFp: "abc", sessionId: "s1" }) }),
    ).toBeUndefined();
  });
});
