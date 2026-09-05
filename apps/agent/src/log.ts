import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const MAX_BYTES = 1_048_576;
const KEEP = 5;

function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // best effort
  }
}

export function createLogger(
  opts: { file?: string; verbose?: boolean; stdout?: boolean },
  base: Record<string, unknown> = {},
): Logger {
  const stdout = opts.stdout ?? process.stdout.isTTY === true;
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (level === "debug" && !opts.verbose) return;
    const rec = { t: new Date().toISOString(), level, msg, ...base, ...fields };
    if (opts.file) {
      rotate(opts.file);
      try {
        appendFileSync(opts.file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      } catch {
        // disk problems must never crash the agent
      }
    }
    if (stdout) {
      const extra = Object.keys({ ...base, ...fields }).length
        ? ` ${JSON.stringify({ ...base, ...fields })}`
        : "";
      const line = `${rec.t.slice(11, 19)} ${level.padEnd(5)} ${msg}${extra}`;
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}
