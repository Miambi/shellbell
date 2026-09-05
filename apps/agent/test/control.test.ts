import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlServer, controlRequest } from "../src/control.js";
import { createLogger } from "../src/log.js";

describe("control socket", () => {
  it("answers status/devices/unpair and rejects unknown commands", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "sb-ctl-")), "agent.sock");
    const fakeAgent = {
      relayOnline: true,
      pairingList: [{ phoneFp: "a".repeat(26), name: "iPhone", lastSeenAt: null }],
      sessionList: [{ id: "iterm2:x" }],
      connectedPhones: [],
      unpair: (t: string) => t === "iPhone",
      openPairing: () => ({ qrText: "{}", expiresAt: 1 }),
      closePairing: () => {},
    };
    const server = new ControlServer(sock, fakeAgent as never, createLogger({ stdout: false }));
    await server.start();
    const status = (await controlRequest(sock, "status")) as {
      relayOnline: boolean;
      sessions: number;
    };
    expect(status.relayOnline).toBe(true);
    expect(status.sessions).toBe(1);
    expect(((await controlRequest(sock, "devices")) as { name: string }[])[0]?.name).toBe("iPhone");
    expect(await controlRequest(sock, "unpair", { target: "iPhone" })).toEqual({ removed: true });
    await expect(controlRequest(sock, "nope")).rejects.toThrow(/unknown command/);
    await server.stop();
  });
});
