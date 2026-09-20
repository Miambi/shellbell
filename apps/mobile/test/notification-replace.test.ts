import { describe, expect, it, vi } from "vitest";
import { handleIncomingRing } from "../src/notifications/ring";

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
});
