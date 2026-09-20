import { describe, expect, it } from "vitest";
import { notificationIdFor } from "../src/notifications/content";

describe("notificationIdFor", () => {
  it("matches the identifier the ring handler presents under", () => {
    expect(notificationIdFor("abc", "s1")).toBe("abc:s1");
  });
});
