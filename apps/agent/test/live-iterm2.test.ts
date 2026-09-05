import { describe, expect, it } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import { ITerm2Client } from "../src/backends/iterm2/client.js";
import { createLogger } from "../src/log.js";

describe.skipIf(!process.env.SHELLBELL_LIVE)("live iTerm2", () => {
  it("lists sessions, reads a styled screen, sends text and sees it", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const client = new ITerm2Client({ log });
    const b = new ITerm2Backend(client, log);
    await b.connect();
    const sessions = await b.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const s = sessions[0] as (typeof sessions)[number];
    const before = await b.getScreen(s.id);
    expect(before.rows).toBe(s.rows);
    await b.sendText(s.id, "echo shellbell-live-ok\r");
    await new Promise((r) => setTimeout(r, 700));
    const after = await b.getScreen(s.id);
    const text = after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text).toContain("shellbell-live-ok");
    await b.close();
  }, 20_000);
});
