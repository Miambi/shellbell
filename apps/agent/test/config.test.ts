import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY,
  loadConfig,
  loadPairings,
  paths,
  saveConfig,
  savePairings,
  writeSecretFile,
} from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";

const tmp = () => paths(mkdtempSync(join(tmpdir(), "sb-")));

describe("config", () => {
  it("creates defaults with 0600/0700 modes", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    expect(cfg.relayUrl).toBe(DEFAULT_RELAY);
    expect(cfg.computerName.length).toBeGreaterThan(0);
    expect(cfg.notifyMinCommandMs).toBe(10000);
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
  it("round-trips edits", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    saveConfig(p, { ...cfg, relayUrl: "wss://x.example", accent: "rose" });
    expect(loadConfig(p)).toMatchObject({ relayUrl: "wss://x.example", accent: "rose" });
  });
  it("pairings persist", () => {
    const p = tmp();
    expect(loadPairings(p)).toEqual([]);
    savePairings(p, [
      {
        phoneFp: "a".repeat(26),
        name: "iPhone",
        platform: "ios",
        ed25519Pub: "AA",
        x25519Pub: "BB",
        kPair: "CC",
        pairedAt: "2026-01-01T00:00:00Z",
        lastSeenAt: null,
      },
    ]);
    expect(loadPairings(p)[0]?.name).toBe("iPhone");
    expect(JSON.parse(readFileSync(p.pairings, "utf8")).v).toBe(1);
  });
  it("writeSecretFile is atomic: no leftover temp file, mode 0600", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    writeSecretFile(file, "hello\n");
    const leftovers = readdirSync(p.dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("hello\n");
  });
  it("loadConfig throws a diagnostic error naming the path on invalid JSON", () => {
    const p = tmp();
    loadConfig(p);
    writeFileSync(p.config, "{ not json");
    expect(() => loadConfig(p)).toThrow(p.config);
  });
  it("loadConfig throws a diagnostic error naming the path on a schema mismatch", () => {
    const p = tmp();
    loadConfig(p);
    writeFileSync(p.config, JSON.stringify({ v: 2 }));
    expect(() => loadConfig(p)).toThrow(p.config);
  });
  it("loadPairings throws a diagnostic error naming the path on invalid JSON", () => {
    const p = tmp();
    loadPairings(p);
    writeFileSync(p.pairings, "{ not json");
    expect(() => loadPairings(p)).toThrow(p.pairings);
  });
});

describe("identity", () => {
  it("creates once and reloads the same fingerprint", () => {
    const p = tmp();
    const a = loadOrCreateIdentity(p);
    const b = loadOrCreateIdentity(p);
    expect(a.fp).toBe(b.fp);
    expect(statSync(p.identity).mode & 0o777).toBe(0o600);
  });
  it("throws a diagnostic error naming the path on a corrupt identity file", () => {
    const p = tmp();
    loadOrCreateIdentity(p);
    writeFileSync(p.identity, "{ not json");
    expect(() => loadOrCreateIdentity(p)).toThrow(p.identity);
  });
});
