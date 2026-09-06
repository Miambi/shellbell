import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateIdentity, parseQr } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import {
  type BuildAgentDeps,
  buildAgent,
  chooseConfirm,
  resolveConfigSet,
  resolveRelayOverride,
  shutdown,
  socketAlive,
  tailFile,
  validateRelayUrl,
} from "../src/cli.js";
import { loadConfig, paths } from "../src/config.js";
import { ControlServer, controlPairSession } from "../src/control.js";
import { createLogger } from "../src/log.js";
import { PairingManager } from "../src/pairing.js";
import { waitFor } from "./fakes/wait.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sb-cli-"));
}

function fakeAgent() {
  return {
    relayOnline: true,
    pairingList: [],
    sessionList: [],
    connectedPhones: [],
    unpair: () => false,
    openPairing: () => ({ qrText: "{}", expiresAt: Date.now() + 1000 }),
    closePairing: () => {},
    stop: vi.fn(),
  };
}

describe("tailFile", () => {
  it("returns only the last maxLines lines within a maxBytes window", () => {
    const dir = tmpDir();
    const file = join(dir, "agent.log");
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const tail = tailFile(file, 64 * 1024, 200);
    const got = tail.split("\n").filter(Boolean);
    expect(got.length).toBe(200);
    expect(got[got.length - 1]).toBe("line 499");
    expect(got[0]).toBe("line 300");
  });

  it("handles a file smaller than maxBytes", () => {
    const dir = tmpDir();
    const file = join(dir, "agent.log");
    writeFileSync(file, "a\nb\nc\n");
    expect(
      tailFile(file, 64 * 1024, 200)
        .split("\n")
        .filter(Boolean),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("validateRelayUrl", () => {
  it("accepts wss:// unconditionally", () => {
    expect(validateRelayUrl("wss://relay.shellbell.app", false)).toBeNull();
  });
  it("rejects ws:// unless insecure is allowed", () => {
    expect(validateRelayUrl("ws://localhost:8787", false)).toMatch(/insecure/);
  });
  it("accepts ws:// when insecure is allowed (LAN dev)", () => {
    expect(validateRelayUrl("ws://localhost:8787", true)).toBeNull();
  });
  it("rejects other schemes", () => {
    expect(validateRelayUrl("http://relay.shellbell.app", false)).toMatch(/wss:\/\//);
  });
  it("rejects unparseable urls", () => {
    expect(validateRelayUrl("not a url", false)).toMatch(/valid URL/);
  });
});

describe("resolveRelayOverride (I2: --relay must steer both the socket and the QR)", () => {
  const cfg = loadConfig(paths(tmpDir()));

  it("passes the config through unchanged when no override is given", () => {
    const r = resolveRelayOverride(cfg, undefined);
    expect("cfg" in r && r.cfg).toBe(cfg);
    expect("cfg" in r && r.warning).toBeUndefined();
  });

  it("accepts a wss:// override with no warning", () => {
    const r = resolveRelayOverride(cfg, "wss://relay.example.com");
    expect("cfg" in r && r.cfg.relayUrl).toBe("wss://relay.example.com");
    expect("cfg" in r && r.warning).toBeUndefined();
  });

  it("accepts a ws:// override (unlike `config set relay`, no --insecure needed) with a warning", () => {
    const r = resolveRelayOverride(cfg, "ws://localhost:8787");
    expect("cfg" in r && r.cfg.relayUrl).toBe("ws://localhost:8787");
    expect("cfg" in r && r.warning).toMatch(/insecure relay URL; for local testing only/);
  });

  it("rejects a URL with a scheme other than ws(s)://", () => {
    const r = resolveRelayOverride(cfg, "http://relay.example.com");
    expect("error" in r && r.error).toMatch(/wss:\/\//);
  });

  it("rejects an unparseable URL", () => {
    const r = resolveRelayOverride(cfg, "not a url");
    expect("error" in r && r.error).toMatch(/valid URL/);
  });

  it("the resolved cfg.relayUrl is what the printed QR's `r` actually carries (I2 regression)", () => {
    const r = resolveRelayOverride(cfg, "ws://localhost:8787");
    if (!("cfg" in r)) throw new Error();
    const identity = generateIdentity();
    const pm = new PairingManager({
      identity,
      fp: fingerprint(identity.ed25519.pub),
      computerName: "MBP",
      accent: "emerald",
      relayUrl: r.cfg.relayUrl, // exactly what `buildAgent` passes to `Agent`'s PairingManager
      sendCtrl: () => true,
      savePairing: () => {},
      confirm: async () => true,
      pairingCount: () => 0,
      log: createLogger({ stdout: false }),
    });
    const { qrText } = pm.openWindow();
    expect(parseQr(qrText, { allowInsecure: true }).r).toBe("ws://localhost:8787");
  });
});

describe("resolveConfigSet", () => {
  const cfg = loadConfig(paths(tmpDir()));

  it("accepts a valid relay url", () => {
    const r = resolveConfigSet(cfg, "relay", "wss://relay.example.com", false);
    expect("next" in r && r.next.relayUrl).toBe("wss://relay.example.com");
  });

  it("rejects an insecure relay url with a one-line error, not a ZodError dump", () => {
    const r = resolveConfigSet(cfg, "relay", "ws://localhost:8787", false);
    expect("error" in r && r.error).toMatch(/insecure/);
  });

  it("accepts name changes", () => {
    const r = resolveConfigSet(cfg, "name", "Bilal's MBP", false);
    expect("next" in r && r.next.computerName).toBe("Bilal's MBP");
  });

  it("rejects a name that fails the schema, with a friendly one-line error", () => {
    const r = resolveConfigSet(cfg, "name", "", false);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.error).not.toMatch(/ZodError|\[\n/); // not a raw multi-line dump
    }
  });

  it("accepts a known accent and rejects an unknown one", () => {
    const ok = resolveConfigSet(cfg, "accent", "violet", false);
    expect("next" in ok && ok.next.accent).toBe("violet");
    const bad = resolveConfigSet(cfg, "accent", "beige", false);
    expect("error" in bad && bad.error).toMatch(/unknown accent/);
  });

  it("rejects an unknown key", () => {
    const r = resolveConfigSet(cfg, "bogus", "x", false);
    expect("error" in r && r.error).toMatch(/unknown key/);
  });
});

describe("socketAlive", () => {
  it("is false and does nothing when the socket file does not exist (ENOENT)", async () => {
    const sock = join(tmpDir(), "agent.sock");
    expect(await socketAlive(sock)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });

  it("is true when a real ControlServer is listening", async () => {
    const sock = join(tmpDir(), "agent.sock");
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    expect(await socketAlive(sock)).toBe(true);
    await server.stop();
  });

  it("is false and removes the file for a genuinely stale socket (ECONNREFUSED)", async () => {
    // Simulate a crash: a child process binds the socket and is SIGKILLed before it can clean
    // up, leaving a real (but unconnectable) AF_UNIX socket file behind -- the scenario I1
    // targets, distinct from a merely-missing file (ENOENT).
    const sock = join(tmpDir(), "agent.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require("node:net");const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write("ready\\n"));setInterval(()=>{},1000);`,
        sock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (d) => {
        if (d.toString().includes("ready")) resolve();
      });
    });
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(sock)).toBe(true);

    expect(await socketAlive(sock)).toBe(false);
    expect(existsSync(sock)).toBe(false);
  });
});

describe("chooseConfirm", () => {
  it("always accepts when --yes, without touching the server or the TTY prompt", async () => {
    const askYesNo = vi.fn(async () => false);
    const confirm = chooseConfirm({ server: null }, true, askYesNo);
    expect(await confirm("fp", "name")).toBe(true);
    expect(askYesNo).not.toHaveBeenCalled();
  });

  it("falls back to the TTY prompt when no pair-open client is connected", async () => {
    const askYesNo = vi.fn(async () => true);
    const confirm = chooseConfirm({ server: null }, false, askYesNo);
    expect(await confirm("fp", "name")).toBe(true);
    expect(askYesNo).toHaveBeenCalledWith("fp", "name");
  });

  it(
    "routes to the connected pair-open client instead of the TTY, even though the daemon " +
      "conceptually owns a TTY (critical fix C1)",
    async () => {
      const sock = join(tmpDir(), "agent.sock");
      const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
      await server.start();

      let resolveOpen!: () => void;
      const opened = new Promise<void>((r) => {
        resolveOpen = r;
      });
      let resolveRequest!: (v: { phoneFp: string; name: string }) => void;
      const requested = new Promise<{ phoneFp: string; name: string }>((r) => {
        resolveRequest = r;
      });
      const session = controlPairSession(sock, {
        onOpen: () => resolveOpen(),
        onRequest: (phoneFp, name) => {
          resolveRequest({ phoneFp, name });
          return Promise.resolve(true); // the client's own answer decides the result
        },
        onClose: () => {},
        onError: (e) => {
          throw e;
        },
      });
      await opened;
      expect(server.hasPairClients).toBe(true);

      // The daemon's own stdin/TTY prompt must never be consulted while a pair client is live.
      const askYesNo = vi.fn(async () => false);
      const confirm = chooseConfirm({ server }, false, askYesNo);

      const result = await confirm("d".repeat(26), "Bilal's iPhone");

      expect(await requested).toEqual({ phoneFp: "d".repeat(26), name: "Bilal's iPhone" });
      expect(result).toBe(true); // the client's confirm answer, not askYesNo's
      expect(askYesNo).not.toHaveBeenCalled();

      session.close();
      await server.stop();
    },
  );
});

describe("shutdown", () => {
  it("stops the agent, removes agent.sock and agent.pid, and exits(0)", async () => {
    const dir = tmpDir();
    const sock = join(dir, "agent.sock");
    const pid = join(dir, "agent.pid");
    const agent = fakeAgent();
    const server = new ControlServer(sock, agent as never, createLogger({ stdout: false }), pid);
    await server.start();
    writeFileSync(pid, String(process.pid));
    expect(existsSync(sock)).toBe(true);
    expect(existsSync(pid)).toBe(true);

    const exit = vi.fn();
    await shutdown(agent as never, server, exit);

    expect(agent.stop).toHaveBeenCalled();
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(pid)).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("runs the optional cleanup callback (e.g. cancelling buildAgent's first-connect retry timer)", async () => {
    const dir = tmpDir();
    const agent = fakeAgent();
    const server = new ControlServer(
      join(dir, "agent.sock"),
      agent as never,
      createLogger({ stdout: false }),
    );
    await server.start();
    const cleanup = vi.fn();
    const exit = vi.fn();
    await shutdown(agent as never, server, exit, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("minor: force-exits after a 5s hard deadline if control.stop() never settles, so Ctrl-C can't hang forever", async () => {
    vi.useFakeTimers();
    try {
      const agent = fakeAgent();
      const hangingControl = { stop: () => new Promise<void>(() => {}) };
      const exit = vi.fn();
      void shutdown(agent as never, hangingControl as never, exit);
      await vi.advanceTimersByTimeAsync(5000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Minimal fake control client, same shape as `tmux-backend.test.ts`'s `FakeControl`: one pane,
 * no real tmux anywhere in this file. */
class FakeControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  alive = true;
  constructor(readonly sessionId: string) {
    super();
  }
  async start(): Promise<void> {}
  stop(): void {
    this.alive = false;
  }
  async command(line: string): Promise<string[]> {
    if (line.startsWith("list-panes")) {
      return [
        [
          "%1",
          "$0",
          "main",
          "@0",
          "0",
          "zsh",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "1",
          "3",
          "0",
          "2",
          "0",
          "zsh",
        ].join("\t"),
      ];
    }
    if (line.startsWith("list-clients")) return ["$0\t1"];
    if (line.startsWith("display-message")) return ["4\t1\t3\t10\t3"];
    if (line.startsWith("capture-pane")) return ["hello", ""];
    throw new Error(`unexpected ${line.split(" ")[0]}`);
  }
}

/** M-6: `buildAgent`'s tmux banner wiring (`onConnected`/`onUnavailable` -> `print()`) had zero
 * coverage anywhere in the suite -- neither for tmux nor for herdr's identical pattern. Drives it
 * with the `tmuxBackendOptions` test seam (same fake `execImpl`/`controlFactory` shape
 * `tmux-start.test.ts` already injects into `startTmuxBackend` directly), isolated from the real
 * filesystem via `SHELLBELL_DIR`. The static `"  tmux       detecting…"` line the `start` command
 * prints unconditionally (no logic to exercise) is left to the Task 4 anchor verification; only
 * the two DYNAMIC lines that depend on the supervisor's async callbacks are asserted here. */
describe("buildAgent's tmux banner wiring (M-6)", () => {
  async function withCapturedPrints(
    tmuxBackendOptions: BuildAgentDeps["tmuxBackendOptions"],
    assert: (lines: string[]) => Promise<void> | void,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-tmux-"));
    const prevDir = process.env.SHELLBELL_DIR;
    process.env.SHELLBELL_DIR = dir;
    const log = createLogger({ stdout: false });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (line: string) => lines.push(String(line));
    let built: Awaited<ReturnType<typeof buildAgent>> | null = null;
    try {
      built = await buildAgent(log, undefined, true, { tmuxBackendOptions });
      built.releaseOutput();
      await waitFor(() => lines.some((l) => l.includes("tmux")), 3000);
      await assert(lines);
    } finally {
      console.log = origLog;
      built?.stopBackendDetectors();
      built?.agent.stop();
      if (prevDir === undefined) delete process.env.SHELLBELL_DIR;
      else process.env.SHELLBELL_DIR = prevDir;
    }
  }

  it('prints "tmux       not running" via onUnavailable, buffered through print() like iTerm2/herdr', async () => {
    await withCapturedPrints(
      {
        execImpl: async () => {
          throw new Error("no tmux in this test");
        },
      },
      (lines) => {
        expect(lines).toContain("  tmux       not running");
      },
    );
  });

  it('prints "tmux       connected · N panes" via onConnected once a fake tmux answers', async () => {
    const exec = async (args: string[]) => (args[0] === "-V" ? "tmux 3.4\n" : "$0\n");
    const control = new FakeControl("$0");
    await withCapturedPrints(
      { execImpl: exec, controlFactory: () => control as unknown as TmuxControl },
      (lines) => {
        expect(lines).toContain("  tmux       connected · 1 pane");
      },
    );
  });
});
