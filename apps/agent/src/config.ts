import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_RELAY = "wss://relay.shellbell.dev";
export const ACCENTS = [
  "emerald",
  "blue",
  "amber",
  "violet",
  "rose",
  "cyan",
  "lime",
  "orange",
] as const;

export interface Paths {
  dir: string;
  identity: string;
  pairings: string;
  config: string;
  log: string;
  sock: string;
  pid: string;
}

export function paths(dir = process.env.SHELLBELL_DIR ?? join(homedir(), ".shellbell")): Paths {
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

export function ensureDir(p: Paths): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
}

/**
 * Writes `text` to `path` atomically: the file at `path` is either the old
 * content or the new content in full, never a partial write. Writes to a
 * sibling temp file, fsyncs it, then renames over the target. On any
 * failure the temp file is removed (best effort) and the error is rethrown.
 */
export function writeSecretFile(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup; the original error is what matters
    }
    throw err;
  }
}

/**
 * Reads and JSON-parses `path`, throwing a diagnostic `Error` naming the
 * file (never its content) if it cannot be read or is not valid JSON.
 */
export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`shellbell: cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`shellbell: ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export const AgentConfigSchema = z.object({
  v: z.literal(1),
  relayUrl: z.string().url(),
  computerName: z.string().min(1).max(64),
  accent: z.string().min(1).max(32),
  notifyMinCommandMs: z.number().int().nonnegative().default(10_000),
  idleQuietMs: z.number().int().positive().default(4_000),
  idleMinActiveMs: z.number().int().nonnegative().default(1_500),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

function defaultConfig(): AgentConfig {
  return {
    v: 1,
    relayUrl: DEFAULT_RELAY,
    computerName: hostname().replace(/\.local$/, "") || "Mac",
    accent: ACCENTS[0],
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4_000,
    idleMinActiveMs: 1_500,
  };
}

export function loadConfig(p: Paths): AgentConfig {
  ensureDir(p);
  if (!existsSync(p.config)) {
    const cfg = defaultConfig();
    saveConfig(p, cfg);
    return cfg;
  }
  const result = AgentConfigSchema.safeParse(readJsonFile(p.config));
  if (!result.success) {
    throw new Error(`shellbell: invalid config at ${p.config}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function saveConfig(p: Paths, cfg: AgentConfig): void {
  ensureDir(p);
  writeSecretFile(p.config, `${JSON.stringify(AgentConfigSchema.parse(cfg), null, 2)}\n`);
}

export const PairingSchema = z.object({
  phoneFp: z.string().regex(/^[a-z2-7]{26}$/),
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
  ed25519Pub: z.string(),
  x25519Pub: z.string(),
  kPair: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Pairing = z.infer<typeof PairingSchema>;
const PairingsFile = z.object({ v: z.literal(1), phones: z.array(PairingSchema) });

export function loadPairings(p: Paths): Pairing[] {
  ensureDir(p);
  if (!existsSync(p.pairings)) return [];
  const result = PairingsFile.safeParse(readJsonFile(p.pairings));
  if (!result.success) {
    throw new Error(
      `shellbell: invalid pairings at ${p.pairings}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data.phones;
}

export function savePairings(p: Paths, phones: Pairing[]): void {
  ensureDir(p);
  writeSecretFile(p.pairings, `${JSON.stringify({ v: 1, phones }, null, 2)}\n`);
}
