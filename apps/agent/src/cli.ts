#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { Agent } from "./agent.js";
import { ITerm2Backend } from "./backends/iterm2/backend.js";
import { ITerm2Client } from "./backends/iterm2/client.js";
import { BackendRegistry } from "./backends/registry.js";
import { BackendUnavailable } from "./backends/types.js";
import { ACCENTS, type AgentConfig, loadConfig, paths, saveConfig } from "./config.js";
import { ControlServer, controlPairSession, controlRequest } from "./control.js";
import { runDoctor } from "./doctor.js";
import { loadOrCreateIdentity } from "./identity.js";
import { install, uninstall } from "./launchd.js";
import { createLogger, type Logger } from "./log.js";

const VERSION = "0.1.0";
const program = new Command()
  .name("shellbell")
  .version(VERSION)
  .option("--relay <url>", "override relay url")
  .option("--json", "machine output")
  .option("--verbose", "debug logging");

function ctx() {
  const opts = program.opts<{ relay?: string; json?: boolean; verbose?: boolean }>();
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

function printQr(qrText: string, expiresAt: number, cfg: AgentConfig, fp: string): void {
  qrcode.generate(qrText, { small: true }, (qr) => {
    console.log(
      `\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n\n  Scan this with the Shellbell app:\n`,
    );
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

async function buildAgent(log: Logger, relayOverride?: string, yes = false) {
  const p = paths();
  const cfg = loadConfig(p);
  const { identity, fp } = loadOrCreateIdentity(p);
  const registry = new BackendRegistry(log);
  const client = new ITerm2Client({ log });
  const iterm = new ITerm2Backend(client, log);
  // ITerm2Backend owns reconnect once it has connected at least once (1 s -> 30 s, spec 8.5.1).
  // The CLI only retries the FIRST connect, which is what fails while iTerm2 is closed or its
  // Python API is off — spec 8.12 says re-detect every 10 s while a backend is absent.
  const firstConnect = async () => {
    try {
      await iterm.connect();
      registry.add(iterm);
      log.info("iTerm2 connected");
    } catch (err) {
      if (err instanceof BackendUnavailable)
        log.warn(`iTerm2 unavailable: ${err.message}`, { hint: err.hint });
      else log.warn("iTerm2 connect failed", { err: String(err) });
      setTimeout(() => void firstConnect(), 10_000);
    }
  };
  void firstConnect();
  const control = { server: null as ControlServer | null };
  const agent = new Agent({
    paths: p,
    config: cfg,
    identity,
    fp,
    registry,
    log,
    appVersion: VERSION,
    relayUrlOverride: relayOverride,
    confirm: async (phoneFp, name) => {
      if (yes) return true;
      if (control.server && !process.stdin.isTTY)
        return control.server.pairingConfirm(phoneFp, name);
      return askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000);
    },
    onSuperseded: () => {
      console.log("  another shellbell agent took over; exiting");
      process.exit(0);
    },
  });
  control.server = new ControlServer(p.sock, agent, log);
  return { agent, control: control.server, p, cfg, fp };
}

program
  .command("start", { isDefault: true })
  .description("run the agent in the foreground")
  .option("--service", "running under launchd")
  .action(async (o: { service?: boolean }) => {
    const { opts, log } = ctx();
    const { agent, control, p, cfg, fp } = await buildAgent(log, opts.relay);
    writeFileSync(p.pid, String(process.pid), { mode: 0o600 });
    await control.start();
    agent.start();
    console.log(
      `\n  Shellbell agent v${VERSION}\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n`,
    );
    if (agent.pairingList.length === 0 && !o.service && process.stdin.isTTY) {
      console.log("  No phones paired yet.");
      const { qrText, expiresAt } = agent.openPairing();
      printQr(qrText, expiresAt, cfg, fp);
    }
    const shutdown = async () => {
      agent.stop();
      await control.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("pair")
  .description("open a 5-minute pairing window and show the QR")
  .option("--yes", "auto-accept requests (unsafe on shared screens)")
  .action(async (o: { yes?: boolean }) => {
    const { opts, p, cfg, log } = ctx();
    const { fp } = loadOrCreateIdentity(p);
    if (existsSync(p.sock)) {
      const session = controlPairSession(p.sock, {
        onOpen: (qrText, expiresAt) => printQr(qrText, expiresAt, cfg, fp),
        onRequest: (phoneFp, name) =>
          o.yes
            ? Promise.resolve(true)
            : askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000),
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
      return;
    }
    const { agent, control } = await buildAgent(log, opts.relay, o.yes);
    await control.start();
    agent.start();
    const { qrText, expiresAt } = agent.openPairing();
    printQr(qrText, expiresAt, cfg, fp);
    setTimeout(
      async () => {
        agent.stop();
        await control.stop();
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
    else if (existsSync(p.log))
      process.stdout.write(readFileSync(p.log, "utf8").split("\n").slice(-200).join("\n"));
  });

program
  .command("config")
  .description("config set relay <url> | name <name> | accent <color>")
  .argument("<op>")
  .argument("<key>")
  .argument("<value>")
  .action((op: string, key: string, value: string) => {
    const { p, cfg } = ctx();
    if (op !== "set")
      return void console.error("  usage: shellbell config set <relay|name|accent> <value>");
    if (key === "relay") saveConfig(p, { ...cfg, relayUrl: value });
    else if (key === "name") saveConfig(p, { ...cfg, computerName: value });
    else if (key === "accent" && (ACCENTS as readonly string[]).includes(value))
      saveConfig(p, { ...cfg, accent: value });
    else
      return void console.error(
        `  unknown key ${key} (accent must be one of ${ACCENTS.join(", ")})`,
      );
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

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
