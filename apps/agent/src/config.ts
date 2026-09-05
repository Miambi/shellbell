import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_RELAY = "wss://relay.shellbell.app";
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

export function writeSecretFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
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
  return AgentConfigSchema.parse(JSON.parse(readFileSync(p.config, "utf8")));
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
  return PairingsFile.parse(JSON.parse(readFileSync(p.pairings, "utf8"))).phones;
}

export function savePairings(p: Paths, phones: Pairing[]): void {
  ensureDir(p);
  writeSecretFile(p.pairings, `${JSON.stringify({ v: 1, phones }, null, 2)}\n`);
}
