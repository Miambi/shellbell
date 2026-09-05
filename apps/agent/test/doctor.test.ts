import { describe, expect, it } from "vitest";
import { parseTmuxVersion, plistNodeOk } from "../src/doctor.js";

describe("parseTmuxVersion", () => {
  it.each([
    ["tmux 3.2a\n", 3.02],
    ["tmux 3.4\n", 3.04],
    ["tmux 3.10\n", 3.1],
    ["tmux 2.9\n", 2.09],
  ])("%j -> %s", (stdout, expected) => {
    expect(parseTmuxVersion(stdout)).toBeCloseTo(expected, 5);
  });

  it("orders versions so 3.1a < 3.2 <= 3.10", () => {
    const v = (s: string) => parseTmuxVersion(s) as number;
    expect(v("tmux 3.1a")).toBeLessThan(v("tmux 3.2"));
    expect(v("tmux 3.2")).toBeLessThanOrEqual(v("tmux 3.10"));
  });

  it("returns null for unrecognisable output", () => {
    expect(parseTmuxVersion("command not found")).toBeNull();
    expect(parseTmuxVersion("")).toBeNull();
  });
});

describe("plistNodeOk", () => {
  it("accepts the running node path and any absolute node path", () => {
    expect(plistNodeOk("<string>/opt/homebrew/bin/node</string>", "/opt/homebrew/bin/node")).toBe(
      true,
    );
    expect(plistNodeOk("<string>/usr/local/bin/node</string>", "/opt/homebrew/bin/node")).toBe(
      true,
    );
  });
  it("rejects a plist with no node path at all", () => {
    expect(plistNodeOk("<string>start</string>", "/opt/homebrew/bin/node")).toBe(false);
  });
});
