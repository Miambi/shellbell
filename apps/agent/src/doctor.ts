import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { relayWsUrl } from "@shellbell/protocol";
import WebSocket from "ws";
import type { ITerm2AuthError } from "./backends/iterm2/auth.js";
import { requestCookieAndKey } from "./backends/iterm2/auth.js";
import { DEFAULT_SOCKET } from "./backends/iterm2/client.js";
import type { AgentConfig, Paths } from "./config.js";
import { PLIST } from "./launchd.js";

const run = promisify(execFile);
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Pure: `tmux -V` output -> a comparable number, or null when it is not recognisable. */
export function parseTmuxVersion(stdout: string): number | null {
  const m = /(\d+)\.(\d+)/.exec(stdout);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 100;
}

/** Does this plist point at a node binary that still exists on this machine? The currently
 * running interpreter is trusted without a filesystem check (it exists by construction); any
 * other `<string>…node</string>` path found in the plist is checked with `existsSync`. */
export function plistNodeOk(plistText: string, execPath: string): boolean {
  if (plistText.includes(execPath)) return true;
  const path = /<string>(\/[^<]*node)<\/string>/.exec(plistText)?.[1];
  return path !== undefined && existsSync(path);
}

export async function runDoctor(p: Paths, cfg: AgentConfig): Promise<Check[]> {
  const out: Check[] = [];
  out.push({
    name: "identity",
    ok: existsSync(p.identity),
    detail: p.identity,
    fix: "run `shellbell` once",
  });
  out.push({
    name: "iTerm2 API socket",
    ok: existsSync(DEFAULT_SOCKET),
    detail: DEFAULT_SOCKET,
    fix: "iTerm2 → Settings → General → Magic → Enable Python API",
  });
  try {
    await requestCookieAndKey("Shellbell");
    out.push({ name: "iTerm2 cookie", ok: true, detail: "granted" });
  } catch (err) {
    const e = err as ITerm2AuthError;
    out.push({
      name: "iTerm2 cookie",
      ok: false,
      detail: e.message,
      fix:
        e.kind === "not-running"
          ? "start iTerm2"
          : "allow Shellbell in the iTerm2 dialog, or enable “Allow all apps to connect”",
    });
  }
  try {
    const { stdout } = await run("tmux", ["-V"]);
    const v = parseTmuxVersion(stdout);
    out.push({
      name: "tmux",
      ok: v !== null && v >= 3.02,
      detail: stdout.trim(),
      fix: "brew install tmux (3.2+)",
    });
  } catch {
    out.push({
      name: "tmux",
      ok: false,
      detail: "not found (optional)",
      fix: "brew install tmux — needed for Ghostty/Warp/Terminal.app sessions",
    });
  }
  const url = relayWsUrl(cfg.relayUrl, "a".repeat(26));
  const reachable = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    ws.once("open", () => {
      ws.close();
      resolve(true);
    });
    ws.once("error", () => resolve(false));
  });
  out.push({
    name: "relay",
    ok: reachable,
    detail: cfg.relayUrl,
    fix: "check the relay URL (`shellbell config set relay …`) and your network",
  });
  if (existsSync(PLIST)) {
    const nodeOk = plistNodeOk(readFileSync(PLIST, "utf8"), process.execPath);
    out.push({
      name: "LaunchAgent",
      ok: nodeOk,
      detail: PLIST,
      fix: "re-run `shellbell service install` after upgrading Node or Shellbell",
    });
  }
  return out;
}
