import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { ControlServer, controlPairSession, controlRequest } from "../src/control.js";
import { createLogger } from "../src/log.js";

function newSock(): string {
  return join(mkdtempSync(join(tmpdir(), "sb-ctl-")), "agent.sock");
}

function fakeAgent() {
  return {
    relayOnline: true,
    pairingList: [{ phoneFp: "a".repeat(26), name: "iPhone", lastSeenAt: null }],
    sessionList: [{ id: "iterm2:x" }],
    connectedPhones: [],
    unpair: (t: string) => t === "iPhone",
    openPairing: () => ({ qrText: "{}", expiresAt: 1 }),
    closePairing: () => {},
  };
}

describe("control socket", () => {
  it("answers status/devices/unpair and rejects unknown commands", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
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

  it("creates the socket with mode 0600 (spec 8.2)", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    await server.stop();
  });

  it("serves two concurrent clients independently", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const [status, devices] = await Promise.all([
      controlRequest(sock, "status") as Promise<{ relayOnline: boolean }>,
      controlRequest(sock, "devices") as Promise<{ name: string }[]>,
    ]);
    expect(status.relayOnline).toBe(true);
    expect(devices[0]?.name).toBe("iPhone");
    await server.stop();
  });

  it("returns {ok:false} for malformed JSON and keeps the connection usable", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const socket = createConnection(sock);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const rl = createInterface({ input: socket });
    const nextLine = () => new Promise<string>((resolve) => rl.once("line", resolve));

    socket.write("not json at all\n");
    expect(JSON.parse(await nextLine())).toEqual({ ok: false, error: "bad json" });

    socket.write(`${JSON.stringify({ cmd: "status" })}\n`);
    const res = JSON.parse(await nextLine()) as { ok: boolean; data?: { relayOnline: boolean } };
    expect(res.ok).toBe(true);
    expect(res.data?.relayOnline).toBe(true);

    socket.end();
    await server.stop();
  });

  it("does not send `closed` to the client whose pair-open re-opened the window", async () => {
    const sock = newSock();
    // openPairing() on the real PairingManager closes a previous window first, which broadcasts
    // `closed` to every registered client. The client that is opening must not be registered yet.
    let server!: ControlServer;
    const agent = {
      ...fakeAgent(),
      openPairing: () => {
        server.notifyClosed();
        return { qrText: "{}", expiresAt: 1 };
      },
    };
    server = new ControlServer(sock, agent as never, createLogger({ stdout: false }));
    await server.start();

    let closedCount = 0;
    const opened = new Promise<string>((resolve) => {
      controlPairSession(sock, {
        onOpen: (qrText) => resolve(qrText),
        onRequest: () => Promise.resolve(false),
        onClose: () => {
          closedCount += 1;
        },
        onError: (e) => {
          throw e;
        },
      });
    });
    expect(await opened).toBe("{}");
    await new Promise((r) => setTimeout(r, 100));
    expect(closedCount).toBe(0);
    await server.stop();
  });

  it("streams pair-open requests, resolves pairingConfirm on confirm, and emits closed", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();

    let resolveOpen!: (v: { qrText: string; expiresAt: number }) => void;
    const opened = new Promise<{ qrText: string; expiresAt: number }>((r) => {
      resolveOpen = r;
    });
    let resolveRequest!: (v: { phoneFp: string; name: string }) => void;
    const requested = new Promise<{ phoneFp: string; name: string }>((r) => {
      resolveRequest = r;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    const decision: { resolve: ((accept: boolean) => void) | null } = { resolve: null };

    const session = controlPairSession(sock, {
      onOpen: (qrText, expiresAt) => resolveOpen({ qrText, expiresAt }),
      onRequest: (phoneFp, name) => {
        resolveRequest({ phoneFp, name });
        return new Promise<boolean>((resolve) => {
          decision.resolve = resolve;
        });
      },
      onClose: () => resolveClosed(),
      onError: (e) => {
        throw e;
      },
    });

    const openMsg = await opened;
    expect(openMsg.qrText).toBe("{}");

    const phoneFp = "b".repeat(26);
    const confirmResult = server.pairingConfirm(phoneFp, "Bilal's iPhone");
    const req = await requested;
    expect(req).toEqual({ phoneFp, name: "Bilal's iPhone" });
    decision.resolve?.(true);
    expect(await confirmResult).toBe(true);

    server.notifyClosed();
    await closed;

    session.close();
    await server.stop();
  });

  it("declines a second confirm request for the same fp instead of clobbering the first", async () => {
    const sock = newSock();
    const server = new ControlServer(sock, fakeAgent() as never, createLogger({ stdout: false }));
    await server.start();
    const fp = "c".repeat(26);
    const first = server.pairingConfirm(fp, "Phone1");
    const second = await server.pairingConfirm(fp, "Phone1-again");
    expect(second).toBe(false);
    await controlRequest(sock, "confirm", { phoneFp: fp, accept: true });
    expect(await first).toBe(true);
    await server.stop();
  });

  describe("agent.pid liveness (M1)", () => {
    it("refuses to start when agent.pid names a live process", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      writeFileSync(pid, String(process.pid));
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await expect(server.start()).rejects.toThrow(/already running/);
    });

    it("starts normally and removes a stale pid file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      writeFileSync(pid, "999999999");
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await server.start();
      expect(existsSync(pid)).toBe(false);
      await server.stop();
    });

    it("stop() removes both the socket and the pid file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-ctl-"));
      const sock = join(dir, "agent.sock");
      const pid = join(dir, "agent.pid");
      const server = new ControlServer(
        sock,
        fakeAgent() as never,
        createLogger({ stdout: false }),
        pid,
      );
      await server.start();
      writeFileSync(pid, String(process.pid));
      expect(existsSync(sock)).toBe(true);
      await server.stop();
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(pid)).toBe(false);
    });
  });
});

describe("controlRequest", () => {
  it("rejects with a clear error when the server sends malformed JSON", async () => {
    const sock = newSock();
    // A minimal raw server that replies with garbage, standing in for a wedged/buggy peer.
    const { createServer } = await import("node:net");
    const raw = createServer((socket) => {
      socket.on("data", () => socket.write("not json\n"));
    });
    await new Promise<void>((resolve) => raw.listen(sock, resolve));
    await expect(controlRequest(sock, "status")).rejects.toThrow(/malformed/);
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });
});
