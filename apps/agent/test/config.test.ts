import { mkdtempSync, readFileSync, statSync } from "node:fs";
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
});

describe("identity", () => {
  it("creates once and reloads the same fingerprint", () => {
    const p = tmp();
    const a = loadOrCreateIdentity(p);
    const b = loadOrCreateIdentity(p);
    expect(a.fp).toBe(b.fp);
    expect(statSync(p.identity).mode & 0o777).toBe(0o600);
  });
});
