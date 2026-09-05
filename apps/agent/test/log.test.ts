import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

describe("logger", () => {
  it("writes json lines and rotates at 1 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    writeFileSync(file, "x".repeat(1_048_600));
    const log = createLogger({ file, stdout: false });
    log.info("hello", { n: 1 });
    expect(existsSync(`${file}.1`)).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line).toMatchObject({ level: "info", msg: "hello", n: 1 });
    expect(typeof line.t).toBe("string");
  });
  it("debug is dropped unless verbose; child merges fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    const log = createLogger({ file, stdout: false }).child({ phone: "abc" });
    log.debug("nope");
    log.warn("yes");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "warn", phone: "abc" });
  });
});
