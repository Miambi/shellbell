import { existsSync } from "node:fs";
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
  // The currently running interpreter is trusted without a filesystem check -- it exists by
  // construction, so this branch must stay true regardless of the test machine's disk layout.
  it("accepts the running node path without checking the filesystem", () => {
    expect(plistNodeOk(`<string>${process.execPath}</string>`, process.execPath)).toBe(true);
  });

  it("accepts a different node path that still exists on disk", () => {
    // Deterministic stand-in for "some other node install": the running interpreter's own path,
    // checked as if it were a *different* recorded execPath so the regex branch (not the
    // exact-match branch) is what's exercised.
    expect(existsSync(process.execPath)).toBe(true);
    expect(
      plistNodeOk(`<string>${process.execPath}</string>`, "/definitely/not/the/running/node"),
    ).toBe(true);
  });

  it("rejects a node path that no longer exists on disk", () => {
    expect(
      plistNodeOk("<string>/definitely/not/a/real/node/binary</string>", process.execPath),
    ).toBe(false);
  });

  it("rejects a plist with no node path at all", () => {
    expect(plistNodeOk("<string>start</string>", process.execPath)).toBe(false);
  });
});
