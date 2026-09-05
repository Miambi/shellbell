#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import pkg from "../package.json" with { type: "json" };
import { Agent } from "./agent.js";
import { startHerdrBackend } from "./backends/herdr/start.js";
import { ITerm2Backend } from "./backends/iterm2/backend.js";
import { ITerm2Client } from "./backends/iterm2/client.js";
import { BackendRegistry } from "./backends/registry.js";
import { BackendUnavailable } from "./backends/types.js";
import {
  ACCENTS,
  type AgentConfig,
  AgentConfigSchema,
  loadConfig,
  paths,
  saveConfig,
} from "./config.js";
import { ControlServer, controlPairSession, controlRequest } from "./control.js";
import { runDoctor } from "./doctor.js";
import { loadOrCreateIdentity } from "./identity.js";
import { install, uninstall } from "./launchd.js";
import { createLogger, type Logger } from "./log.js";

const VERSION = pkg.version;
const program = new Command()
  .name("shellbell")
  .version(VERSION)
  .option("--relay <url>", "override relay url")
  .option("--json", "machine output")
  .option("--verbose", "debug logging")
  .option("--insecure", "allow a ws:// relay url (LAN dev only)");

function ctx() {
  const opts = program.opts<{
    relay?: string;
    json?: boolean;
    verbose?: boolean;
    insecure?: boolean;
  }>();
  const p = paths();
  const cfg = loadConfig(p);
  const log = createLogger({
    file: p.log,
    verbose: opts.verbose,
    stdout: process.stdout.isTTY && !opts.json,
  });
  return { opts, p, cfg, log };
}

const fpShort = (fp: string) => `${fp.slice(0, 4)}-${fp.slice(4, 8)}`;

function askYesNo(question: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const t = setTimeout(() => {
      rl.close();
      console.log("\n  (timed out — declined)");
      resolve(false);
    }, timeoutMs);
    rl.question(question, (a) => {
      clearTimeout(t);
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

function printPairHeader(cfg: AgentConfig, fp: string): void {
  console.log(
    `\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n\n  Scan this with the Shellbell app:\n`,
  );
}

function printQr(qrText: string, expiresAt: number): void {
  qrcode.generate(qrText, { small: true }, (qr) => {
    console.log(
      qr
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log(
      `\n  Pairing window closes in ${Math.round((expiresAt - Date.now()) / 60000)} min\n`,
    );
  });
}

/** Reads only the tail of a file (bounded I/O for a long-lived, rotated agent.log) and returns
 * its last `maxLines` lines. */
export function tailFile(path: string, maxBytes: number, maxLines: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    // Drop exactly one trailing newline (every log record ends with one) so the split below
    // yields real lines only -- without this, `slice(-maxLines)` counts the trailing "" as a
    // line and silently drops the actual last line of the file.
    const text = buf.toString("utf8").replace(/\n$/, "");
    return text.length === 0 ? "" : text.split("\n").slice(-maxLines).join("\n");
  } finally {
    closeSync(fd);
  }
}

/** Pure: is `value` an acceptable relay url? `ws://` is only allowed for LAN dev, via
 * `--insecure` or `SHELLBELL_ALLOW_INSECURE_RELAY=1`. Returns an error message, or null if ok. */
export function validateRelayUrl(value: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "must be a valid URL, e.g. wss://relay.example.com";
  }
  if (u.protocol === "wss:") return null;
  if (u.protocol === "ws:") {
    if (allowInsecure) return null;
    return "ws:// is insecure; pass --insecure or set SHELLBELL_ALLOW_INSECURE_RELAY=1 for LAN dev";
  }
  return "relay url must use wss:// (ws:// only with --insecure, for LAN dev)";
}

/** True if a control-socket daemon answers at `sockPath`. A stale socket file (nothing
 * listening, or nothing there at all) is removed and this returns false — spec 8.1: `pair`
 * falls back to an in-process agent whenever no daemon is actually reachable. */
export async function socketAlive(sockPath: string): Promise<boolean> {
  try {
    await controlRequest(sockPath, "status");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch {
        // best effort
      }
      return false;
    }
    // Any other failure (timeout, a malformed reply) still proves *something* is listening;
    // do not treat it as a stale socket and do not touch the file.
    return true;
  }
}

/**
 * Routes a pairing confirmation to whichever surface can actually show it: a connected
 * `pair-open` control-socket client (there is a human watching that terminal for exactly this),
 * falling back to this process's own TTY only when no such client is connected. Never reads the
 * daemon's stdin when a pair client is present, even if the daemon itself has a TTY (critical
 * fix: a foreground `start` with a TTY must not swallow a `pair`-triggered request).
 */
export function chooseConfirm(
  box: { server: ControlServer | null },
  yes: boolean,
  askYesNoFn: (phoneFp: string, name: string) => Promise<boolean>,
): (phoneFp: string, name: string) => Promise<boolean> {
  return async (phoneFp, name) => {
    if (yes) return true;
    if (box.server?.hasPairClients) return box.server.pairingConfirm(phoneFp, name);
    return askYesNoFn(phoneFp, name);
  };
}

/** One shutdown path for `start`: stops the agent and the control server (which removes
 * `agent.sock` and `agent.pid`), then exits. Shared by SIGINT/SIGTERM and `onSuperseded` so
 * neither leaves stale files behind.
 *
 * A hard 5 s deadline guarantees `exit` is always called even if `control.stop()` hangs (e.g. a
 * socket that never emits `close`) -- Ctrl-C must never leave the process unkillable. `cleanup`,
 * when given, runs synchronously first (e.g. cancelling `buildAgent`'s first-connect retry timer).
 */
export async function shutdown(
  agent: Agent,
  control: ControlServer,
  exit: (code: number) => void = process.exit,
  cleanup?: () => void,
): Promise<void> {
  cleanup?.();
  let exited = false;
  const onceExit = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const hardDeadline = setTimeout(() => onceExit(1), 5000);
  if (typeof hardDeadline.unref === "function") hardDeadline.unref();
  try {
    agent.stop();
    await control.stop();
    onceExit(0);
  } finally {
    clearTimeout(hardDeadline);
  }
}

/**
 * Pure: resolves the explicit `--relay <url>` flag against the loaded config. Unlike
 * `config set relay`, `ws://` is always accepted here (no `--insecure` needed) since the flag
 * only steers a single foreground run and is documented as LAN-dev-only (spec §15's
 * `--relay ws://localhost:8787` local e2e flow) -- but it still fails closed on a genuinely bad
 * URL (I2). Returns the config unchanged, with a `warning` to print, when no override is given.
 */
export function resolveRelayOverride(
  cfg: AgentConfig,
  relayOverride: string | undefined,
): { error: string } | { cfg: AgentConfig; warning?: string } {
  if (relayOverride === undefined) return { cfg };
  const err = validateRelayUrl(relayOverride, true);
  if (err) return { error: err };
  const insecure = new URL(relayOverride).protocol === "ws:";
  return {
    cfg: { ...cfg, relayUrl: relayOverride },
    warning: insecure ? "insecure relay URL; for local testing only" : undefined,
  };
}

async function buildAgent(log: Logger, relayOverride?: string, yes = false) {
  const p = paths();
  let cfg = loadConfig(p);
  if (relayOverride !== undefined) {
    // I2: --relay must steer BOTH the agent's own socket and the pairing QR (the QR's `r`), or a
    // scanned QR dials a relay the agent never connected to. Routing it into `cfg.relayUrl` here
    // (rather than the test-only `relayUrlOverride` seam) makes PairingManager and RelayClient
    // agree, exactly like `config set relay` already does for a persisted override.
    const resolved = resolveRelayOverride(cfg, relayOverride);
    if ("error" in resolved) {
      console.error(`  --relay ${relayOverride}: ${resolved.error}`);
      process.exit(1);
    }
    if (resolved.warning) console.error(`  warning: ${resolved.warning}`);
    cfg = resolved.cfg;
  }
  const { identity, fp } = loadOrCreateIdentity(p);
  const registry = new BackendRegistry(log);
  const client = new ITerm2Client({ log });
  const iterm = new ITerm2Backend(client, log);
  // Minor: `firstConnect` below can otherwise print its backend line before the caller's own
  // spec 8.1 header block (both `start` and `pair` print a header only after `buildAgent()`
  // returns) if iTerm2 answers fast -- buffer stdout lines here and let the caller release them
  // once its header is up, so the two can never interleave.
  const output: { ready: boolean; queue: string[] } = { ready: false, queue: [] };
  const print = (line: string) => {
    if (output.ready) console.log(line);
    else output.queue.push(line);
  };
  const releaseOutput = () => {
    output.ready = true;
    for (const line of output.queue) console.log(line);
    output.queue = [];
  };
  // ITerm2Backend owns reconnect once it has connected at least once (1 s -> 30 s, spec 8.5.1).
  // The CLI only retries the FIRST connect, which is what fails while iTerm2 is closed or its
  // Python API is off — spec 8.12 says re-detect every 10 s while a backend is absent.
  let firstConnectTimer: NodeJS.Timeout | null = null;
  const firstConnect = async () => {
    try {
      await iterm.connect();
      registry.add(iterm);
      const sessions = await iterm.listSessions().catch(() => []);
      print(
        `  iTerm2     connected · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      );
      log.info("iTerm2 connected");
    } catch (err) {
      if (err instanceof BackendUnavailable) {
        // spec 8.1's exact text for a disabled Python API.
        print(
          "\n  iTerm2's Python API is off. Turn it on:\n  iTerm2 → Settings → General → Magic → ✓ Enable Python API\n  then run `shellbell` again.\n",
        );
        log.warn(`iTerm2 unavailable: ${err.message}`, { hint: err.hint });
      } else {
        print("  iTerm2     unavailable — connect failed");
        log.warn("iTerm2 connect failed", { err: err instanceof Error ? err.name : "unknown" });
      }
      firstConnectTimer = setTimeout(() => void firstConnect(), 10_000);
    }
  };
  void firstConnect();
  // spec 8.12/8.13: herdr is optional and usually absent, so this never blocks startup and never
  // prints an error -- it registers the backend, retries every 10 s, and announces itself if and
  // when it connects. Buffered through `print` like the iTerm2 line, for the same reason.
  const herdr = startHerdrBackend({
    registry,
    log,
    onConnected: (n) => print(`  herdr      connected · ${n} pane${n === 1 ? "" : "s"}`),
  });
  // Minor: without this, the retry timer above outlives `stop()`/`shutdown()` -- harmless for the
  // CLI (every shutdown path calls `process.exit`) but it means `buildAgent` can't be reused in a
  // long-lived host. `shutdown()` calls this as its `cleanup` step.
  const stopFirstConnect = () => {
    if (firstConnectTimer) clearTimeout(firstConnectTimer);
    firstConnectTimer = null;
  };
  // `shutdown()`'s `cleanup` argument: cancel the iTerm2 first-connect retry AND stop the herdr
  // detector. Passed wherever `stopFirstConnect` used to be passed, so no exit path leaks either.
  const stopBackendDetectors = () => {
    stopFirstConnect();
    herdr.stop();
  };
  const control: { server: ControlServer | null } = { server: null };
  let agent: Agent;
  agent = new Agent({
    paths: p,
    config: cfg,
    identity,
    fp,
    registry,
    log,
    appVersion: VERSION,
    // relayUrlOverride intentionally omitted: cfg.relayUrl above (possibly overridden by --relay)
    // already steers both the socket and the pairing QR via PairingManager. relayUrlOverride
    // remains a genuinely test-only seam (agent.integration.test.ts) for pointing the socket at a
    // FakeRelay without disturbing a wss:// config the QR round-trip validation expects.
    confirm: chooseConfirm(control, yes, (phoneFp, name) =>
      askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000),
    ),
    onPairingClosed: () => control.server?.notifyClosed(),
    onSuperseded: () => {
      console.log("  another shellbell agent took over; exiting");
      if (control.server) {
        void shutdown(agent, control.server, () => process.exit(0), stopBackendDetectors).catch(
          () => process.exit(1),
        );
      } else process.exit(0);
    },
  });
  control.server = new ControlServer(p.sock, agent, log, p.pid);
  return {
    agent,
    control: control.server,
    p,
    cfg,
    fp,
    releaseOutput,
    stopFirstConnect,
    stopBackendDetectors,
    herdr,
  };
}

program
  .command("start", { isDefault: true })
  .description("run the agent in the foreground")
  .option("--service", "running under launchd")
  .action(async (o: { service?: boolean }) => {
    const { opts, log } = ctx();
    const { agent, control, p, cfg, fp, releaseOutput, stopBackendDetectors } = await buildAgent(
      log,
      opts.relay,
    );
    try {
      await control.start();
    } catch (err) {
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
    writeFileSync(p.pid, String(process.pid), { mode: 0o600 });
    agent.start();

    // spec 8.1's exact first-run block (Relay/iTerm2/tmux lines are updated in place as their
    // state changes -- a line per transition -- rather than only printed once).
    console.log(
      `\n  Shellbell agent v${VERSION}\n  Computer   ${cfg.computerName}  (${fpShort(fp)})`,
    );
    console.log(
      `  Relay      ${cfg.relayUrl}   ${agent.relayOnline ? "connected" : "connecting…"}`,
    );
    agent.relay.on("auth-ok", () => console.log(`  Relay      ${cfg.relayUrl}   connected`));
    agent.relay.on("down", () => console.log(`  Relay      ${cfg.relayUrl}   connecting…`));
    console.log("  tmux       not running"); // Plan 04 adds the tmux backend.
    console.log("  herdr      detecting…"); // followed up by startHerdrBackend's onConnected line
    // The header above is up: any iTerm2 line `buildAgent`'s firstConnect() queued while it was
    // still connecting can now be printed without interleaving spec 8.1's exact-text block.
    releaseOutput();

    if (agent.pairingList.length === 0 && !o.service && process.stdin.isTTY) {
      console.log("\n  No phones paired yet. Scan this with the Shellbell app:\n");
      const { qrText, expiresAt } = agent.openPairing();
      printQr(qrText, expiresAt);
    }
    // Minor: a second Ctrl-C while shutdown is already in flight forces an immediate exit rather
    // than leaving the process to wait out a hung `control.stop()` -- shutdown() also carries its
    // own 5 s hard deadline, so this is belt-and-braces for an impatient human.
    let shuttingDown = false;
    const onSignal = () => {
      if (shuttingDown) {
        console.error("  forcing exit");
        process.exit(130);
        return;
      }
      shuttingDown = true;
      void shutdown(agent, control, process.exit, stopBackendDetectors).catch(() =>
        process.exit(1),
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

program
  .command("pair")
  .description("open a 5-minute pairing window and show the QR")
  .option("--yes", "auto-accept requests (unsafe on shared screens)")
  .action(async (o: { yes?: boolean }) => {
    const { opts, p, cfg, log } = ctx();
    const { fp } = loadOrCreateIdentity(p);

    const startInProcess = async () => {
      // I2: destructure this call's own (possibly --relay-overridden) cfg/fp rather than the
      // outer `ctx()` ones, so the printed header's "Relay" line always matches the QR it prints.
      const {
        agent,
        control,
        cfg: agentCfg,
        fp: agentFp,
        releaseOutput,
        stopBackendDetectors,
      } = await buildAgent(log, opts.relay, o.yes);
      try {
        await control.start();
      } catch (err) {
        console.error(`  ${(err as Error).message}`);
        process.exit(1);
      }
      agent.start();
      const { qrText, expiresAt } = agent.openPairing();
      printPairHeader(agentCfg, agentFp);
      printQr(qrText, expiresAt);
      releaseOutput();
      setTimeout(
        () =>
          void shutdown(agent, control, () => process.exit(0), stopBackendDetectors).catch(() =>
            process.exit(1),
          ),
        5 * 60_000 + 1000,
      );
    };

    // spec 8.1: talks to a running agent's control socket; a dead/stale socket falls back to an
    // in-process agent rather than failing outright.
    if (!(await socketAlive(p.sock))) {
      await startInProcess();
      return;
    }

    const session = controlPairSession(p.sock, {
      onOpen: (qrText, expiresAt) => {
        printPairHeader(cfg, fp);
        printQr(qrText, expiresAt);
      },
      onRequest: (phoneFp, name) =>
        o.yes
          ? Promise.resolve(true)
          : askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000),
      onClose: () => {
        console.log("  pairing window closed");
        process.exit(0);
      },
      onError: (e) => {
        console.error(`  ${e.message}`);
        process.exit(1);
      },
    });
    setTimeout(
      () => {
        session.close();
        process.exit(0);
      },
      5 * 60_000 + 1000,
    );
  });

program
  .command("status")
  .description("show agent status")
  .action(async () => {
    const { opts, p } = ctx();
    try {
      const s = await controlRequest(p.sock, "status");
      console.log(opts.json ? JSON.stringify(s) : JSON.stringify(s, null, 2));
    } catch {
      console.log(opts.json ? JSON.stringify({ running: false }) : "  agent not running");
    }
  });

program
  .command("devices")
  .description("list paired phones")
  .action(async () => {
    const { opts, p } = ctx();
    try {
      const d = await controlRequest(p.sock, "devices");
      console.log(opts.json ? JSON.stringify(d) : JSON.stringify(d, null, 2));
    } catch {
      console.log("  agent not running");
    }
  });

program
  .command("unpair <target>")
  .description("remove a paired phone (fp prefix or name)")
  .action(async (target: string) => {
    const { p } = ctx();
    try {
      const r = (await controlRequest(p.sock, "unpair", { target })) as { removed: boolean };
      console.log(r.removed ? "  removed" : "  no such phone");
    } catch {
      console.log("  agent not running");
    }
  });

const service = program.command("service").description("manage the LaunchAgent");
service.command("install").action(async () => {
  const { p } = ctx();
  try {
    console.log(`  installed ${await install(p)}`);
  } catch (e) {
    console.error(`  ${(e as Error).message}`);
    process.exit(2);
  }
});
service.command("uninstall").action(async () => {
  await uninstall();
  console.log("  uninstalled");
});

program
  .command("logs")
  .option("-f, --follow")
  .description("show the agent log")
  .action((o: { follow?: boolean }) => {
    const { p } = ctx();
    if (o.follow) spawn("tail", ["-f", p.log], { stdio: "inherit" });
    else if (existsSync(p.log)) process.stdout.write(tailFile(p.log, 64 * 1024, 200));
  });

/**
 * Pure: resolves `shellbell config set <key> <value>` against the current config into either a
 * friendly one-line error or the new, schema-validated config to save. `relay` gets its own
 * wss://-only check (ws:// only with `allowInsecure`, for LAN dev); every key -- including a
 * relay url that passed that check -- is then re-validated against `AgentConfigSchema` so a bad
 * `name`/`accent` (or any future schema tightening) surfaces the same friendly, one-line message
 * instead of a raw ZodError dump.
 */
export function resolveConfigSet(
  cfg: AgentConfig,
  key: string,
  value: string,
  allowInsecure: boolean,
): { error: string } | { next: AgentConfig } {
  let next: AgentConfig;
  if (key === "relay") {
    const err = validateRelayUrl(value, allowInsecure);
    if (err) return { error: err };
    next = { ...cfg, relayUrl: value };
  } else if (key === "name") {
    next = { ...cfg, computerName: value };
  } else if (key === "accent") {
    if (!(ACCENTS as readonly string[]).includes(value)) {
      return { error: `unknown accent ${value} (must be one of ${ACCENTS.join(", ")})` };
    }
    next = { ...cfg, accent: value };
  } else {
    return { error: `unknown key ${key} (expected relay, name, or accent)` };
  }
  const result = AgentConfigSchema.safeParse(next);
  if (!result.success) {
    return { error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { next: result.data };
}

program
  .command("config")
  .description("config set relay <url> | name <name> | accent <color>")
  .argument("<op>")
  .argument("<key>")
  .argument("<value>")
  .action((op: string, key: string, value: string) => {
    const { opts, p, cfg } = ctx();
    if (op !== "set")
      return void console.error("  usage: shellbell config set <relay|name|accent> <value>");
    const allowInsecure =
      Boolean(opts.insecure) || process.env.SHELLBELL_ALLOW_INSECURE_RELAY === "1";
    const result = resolveConfigSet(cfg, key, value, allowInsecure);
    if ("error" in result) return void console.error(`  ${result.error}`);
    saveConfig(p, result.next);
    console.log("  saved");
  });

program
  .command("doctor")
  .description("check the local setup")
  .action(async () => {
    const { p, cfg, opts } = ctx();
    const checks = await runDoctor(p, cfg);
    if (opts.json) return void console.log(JSON.stringify(checks));
    for (const c of checks)
      console.log(
        `  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(18)} ${c.detail}${c.ok || !c.fix ? "" : `\n      fix: ${c.fix}`}`,
      );
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  });

// Only run the CLI when this file is the process entry point -- e.g. `node dist/cli.js` or
// `tsx src/cli.ts` -- never when a test imports the pure/exported helpers above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  program.parseAsync().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
