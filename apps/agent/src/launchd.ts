import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Paths } from "./config.js";

const run = promisify(execFile);
export const LABEL = "dev.bilalahmad.shellbell";
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export function isGlobalInstall(): boolean {
  const entry = process.argv[1] ?? "";
  return !entry.includes("/_npx/") && !entry.includes("/.npm/");
}

export function plistFor(o: { nodePath: string; cliPath: string; logPath: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(o.nodePath)}</string><string>${esc(o.cliPath)}</string><string>start</string><string>--service</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
</dict></plist>
`;
}

/** Pre-creates (or fixes the mode of) the launchd log file as 0600, before `install()` runs
 * `launchctl bootstrap` -- otherwise launchd creates `StandardOutPath`/`StandardErrorPath` itself
 * under the default umask the first time the service writes to it (§8.2). Exported so this can be
 * tested without touching `launchctl`; never truncates an existing file's content. */
export function prepareLogFile(logPath: string): void {
  if (!existsSync(logPath)) writeFileSync(logPath, "", { mode: 0o600 });
  else chmodSync(logPath, 0o600);
}

export async function install(p: Paths): Promise<string> {
  if (!isGlobalInstall())
    throw new Error("`service install` needs a global install: npm i -g shellbell");
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  prepareLogFile(p.log);
  const cliPath = process.argv[1] as string;
  writeFileSync(PLIST, plistFor({ nodePath: process.execPath, cliPath, logPath: p.log }));
  const uid = userInfo().uid;
  await run("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => undefined);
  await run("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  return PLIST;
}

export async function uninstall(): Promise<void> {
  const uid = userInfo().uid;
  await run("launchctl", ["bootout", `gui/${uid}`, PLIST]).catch(() => undefined);
  if (existsSync(PLIST)) unlinkSync(PLIST);
}
