import { afterEach, describe, expect, it } from "vitest";
import { isGlobalInstall, LABEL, plistFor } from "../src/launchd.js";

describe("plistFor", () => {
  it("emits a launchd plist with the label, argv, PATH and log paths", () => {
    const xml = plistFor({
      nodePath: "/opt/homebrew/bin/node",
      cliPath: "/usr/local/bin/shellbell",
      logPath: "/Users/x/.shellbell/agent.log",
    });
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(LABEL).toBe("dev.bilalahmad.shellbell");
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/usr/local/bin/shellbell</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<string>--service</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(xml).toContain(
      "<key>StandardOutPath</key><string>/Users/x/.shellbell/agent.log</string>",
    );
  });

  it("escapes XML metacharacters in paths", () => {
    const xml = plistFor({ nodePath: "/a&b/node", cliPath: "/c<d/cli.js", logPath: "/l.log" });
    expect(xml).toContain("/a&amp;b/node");
    expect(xml).toContain("/c&lt;d/cli.js");
    expect(xml).not.toContain("/a&b/node");
  });
});

describe("isGlobalInstall", () => {
  const original = process.argv[1] ?? "";
  afterEach(() => {
    process.argv[1] = original;
  });

  it("is true for a normal global/local install path", () => {
    process.argv[1] = "/opt/homebrew/lib/node_modules/shellbell/dist/cli.js";
    expect(isGlobalInstall()).toBe(true);
  });

  it("is false when run through npx's cache", () => {
    process.argv[1] = "/Users/x/.npm/_npx/abc123/node_modules/shellbell/dist/cli.js";
    expect(isGlobalInstall()).toBe(false);
  });
});
