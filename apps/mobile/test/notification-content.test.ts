import { describe, expect, it } from "vitest";
import { buildRingNotification } from "../src/notifications/content";

const known = () => ({ title: "claude-code", backend: "herdr" as const });
const none = () => undefined;

describe("buildRingNotification", () => {
  it("names the session and keys the notification to it", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s1", kind: "blocked" }, known);
    expect(n.identifier).toBe("abc:s1");
    expect(n.title).toBe("claude-code");
    expect(n.body).toBe("An agent is waiting for you");
  });

  it.each([
    ["prompt", "A command finished"],
    ["idle", "A session went quiet — waiting for you?"],
    ["blocked", "An agent is waiting for you"],
  ])("uses the relay's wording for %s", (kind, body) => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s1", kind }, known);
    expect(n.body).toBe(body);
  });

  it("falls back to the backend label when the title is unknown", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, () => ({
      title: "",
      backend: "tmux" as const,
    }));
    expect(n.title).toBe("tmux");
  });

  it("falls back to Session when nothing is known", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, none);
    expect(n.title).toBe("Session");
  });

  it("never renders a raw session id", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, none);
    expect(n.title).not.toContain("s9");
    expect(n.body).not.toContain("s9");
  });
});
