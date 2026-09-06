import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHerdr } from "../src/backends/herdr/start.js";
import { ITerm2AuthError } from "../src/backends/iterm2/auth.js";
import type { AgentConfig, Paths } from "../src/config.js";
import { parseTmuxVersion, plistNodeOk, runDoctor } from "../src/doctor.js";
import { createLogger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";

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

const log = createLogger({ stdout: false });

function fakePaths(dir: string): Paths {
  return {
    dir,
    identity: join(dir, "identity.json"),
    pairings: join(dir, "pairings.json"),
    config: join(dir, "config.json"),
    log: join(dir, "agent.log"),
    sock: join(dir, "agent.sock"),
    pid: join(dir, "agent.pid"),
  };
}

function fakeConfig(): AgentConfig {
  return {
    v: 1,
    // Port 1 is refused instantly on loopback -- the relay check fails fast, no real network wait.
    relayUrl: "wss://127.0.0.1:1",
    computerName: "test",
    accent: "blue",
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4_000,
    idleMinActiveMs: 1_500,
  };
}

/** Never runs the real iTerm2 AppleScript check: on a machine with iTerm2 actually running, that
 * can pop a real consent dialog and hang the test forever waiting for a click that never comes. */
const noRealITerm2Cookie = async () => {
  throw new ITerm2AuthError("iTerm2 is not running", "not-running");
};

describe("runDoctor's herdr check (Minor, Task 6 review: injectable via RunDoctorDeps)", () => {
  let server: FakeHerdr | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("absent -> ok, optional (spec 8.13 ruling 14)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
    const checks = await runDoctor(fakePaths(dir), fakeConfig(), {
      requestCookieAndKey: noRealITerm2Cookie,
      checkHerdr: () => checkHerdr({ log, socketPath: join(dir, "herdr.sock") }),
    });
    expect(checks.find((c) => c.name === "herdr")).toEqual({
      name: "herdr",
      ok: true,
      detail: "not installed (optional)",
    });
  });

  it("old version -> fail, with the 0.7.2 upgrade hint", async () => {
    server = new FakeHerdr();
    server.reply("ping", () => ({ type: "pong", version: "0.6.9", protocol: 22 }));
    await server.start();
    const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
    const checks = await runDoctor(fakePaths(dir), fakeConfig(), {
      requestCookieAndKey: noRealITerm2Cookie,
      checkHerdr: () => checkHerdr({ log, socketPath: (server as FakeHerdr).path }),
    });
    const herdr = checks.find((c) => c.name === "herdr");
    expect(herdr?.ok).toBe(false);
    expect(herdr?.fix).toMatch(/0\.7\.2/);
  });

  it("present -> ok, with version and protocol", async () => {
    server = new FakeHerdr();
    server.reply("session.snapshot", () => ({
      type: "session_snapshot",
      snapshot: {
        version: "0.8.2",
        protocol: 22,
        workspaces: [],
        tabs: [],
        panes: [],
        layouts: [],
        agents: [],
      },
    }));
    await server.start();
    const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
    const checks = await runDoctor(fakePaths(dir), fakeConfig(), {
      requestCookieAndKey: noRealITerm2Cookie,
      checkHerdr: () => checkHerdr({ log, socketPath: (server as FakeHerdr).path }),
    });
    expect(checks.find((c) => c.name === "herdr")).toEqual({
      name: "herdr",
      ok: true,
      detail: "v0.8.2 protocol 20",
    });
  });
});

describe("runDoctor's tmux check (Task 4: injectable via RunDoctorDeps.tmuxVersion)", () => {
  it("tmux rows: ok at 3.2 and 3.10, fail below 3.2, fail when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
    const rowFor = async (tmuxVersion: () => Promise<string>) =>
      (
        await runDoctor(fakePaths(dir), fakeConfig(), {
          requestCookieAndKey: noRealITerm2Cookie,
          checkHerdr: () => checkHerdr({ log, socketPath: join(dir, "herdr.sock") }),
          tmuxVersion,
        })
      ).find((c) => c.name === "tmux");
    expect((await rowFor(async () => "tmux 3.2\n"))?.ok).toBe(true);
    // Regression against a parseFloat comparison: 3.10 is NEWER than 3.2.
    expect((await rowFor(async () => "tmux 3.10\n"))?.ok).toBe(true);
    expect((await rowFor(async () => "tmux 3.1a\n"))?.ok).toBe(false);
    const missing = await rowFor(async () => {
      throw new Error("ENOENT");
    });
    expect(missing?.ok).toBe(false);
    expect(missing?.detail).toBe("not found (optional)");
  });
});
