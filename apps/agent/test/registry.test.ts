import { describe, expect, it } from "vitest";
import { BackendRegistry, prefixId, splitId } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("BackendRegistry", () => {
  it("prefixes ids, routes calls, merges events, hides tmux panes iTerm2 already shows", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    iterm.tmuxWindowIds = () => new Set(["@1"]);
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    tmux.addSession("%2", {});
    tmux.tmuxWindowIdOf = (id: string) => (id === "%1" ? "@1" : "@2");
    reg.add(iterm);
    reg.add(tmux);
    const ids = (await reg.listSessions()).map((s) => s.id);
    expect(ids).toEqual(["iterm2:A", "tmux:%2"]);
    const events: string[] = [];
    reg.on((e) => events.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%2" });
    expect(events).toEqual(["tmux:%2"]);
    await reg.sendText("tmux:%2", "x");
    expect(tmux.sentText).toEqual([{ id: "%2", text: "x" }]);
    await expect(reg.sendText("kitty:1", "x")).rejects.toThrow(/session gone/);
    expect(await reg.createSession({ kind: "tab", backend: "tmux" })).toMatch(/^tmux:/);
    await expect(
      reg.createSession({ kind: "tab", backend: "tmux", windowId: "iterm2:w1" }),
    ).rejects.toThrow(/bad-window/);
    expect(splitId("tmux:%3")).toEqual({ name: "tmux", native: "%3" });
    expect(prefixId("iterm2", "x")).toBe("iterm2:x");
  });

  it("one backend failing does not affect the other (spec 15)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    reg.add(iterm);
    reg.add(tmux);

    // iTerm2 blows up on every call; tmux must keep working.
    iterm.getScreen = async () => {
      throw new Error("iTerm2 API died");
    };
    iterm.sendText = async () => {
      throw new Error("iTerm2 API died");
    };
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/iTerm2 API died/);
    await expect(reg.sendText("iterm2:A", "x")).rejects.toThrow(/iTerm2 API died/);
    expect((await reg.getScreen("tmux:%1")).rows).toBeGreaterThan(0);
    await reg.sendText("tmux:%1", "ok");
    expect(tmux.sentText).toEqual([{ id: "%1", text: "ok" }]);

    // Removing the broken backend leaves the healthy one listed and routable.
    reg.remove("iterm2");
    expect((await reg.listSessions()).map((x) => x.id)).toEqual(["tmux:%1"]);
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/session gone/);

    // Events from the survivor still reach subscribers.
    const seen: string[] = [];
    reg.on((e) => seen.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%1" });
    expect(seen).toContain("tmux:%1");
  });

  it("listSessions isolates a failing backend and returns the survivors (spec 8.12/15)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    iterm.listSessions = async () => {
      throw new Error("iTerm2 API died");
    };
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    reg.add(iterm);
    reg.add(tmux);

    const sessions = await reg.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["tmux:%1"]);
  });

  it("reports absoluteLines: false when no backend is connected", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    expect(reg.capabilities.absoluteLines).toBe(false);
  });

  it("close() closes every member and clears them from the registry", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    reg.add(iterm);
    await reg.close();
    expect(reg.connected()).toEqual([]);
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/session gone/);
  });

  it("routes herdr ids and fans setWatched out to every member as native ids", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);

    expect((await reg.listSessions()).map((s) => s.id)).toEqual(["iterm2:A", "herdr:term_a"]);
    expect(splitId("herdr:term_a")).toEqual({ name: "herdr", native: "term_a" });
    await reg.sendText("herdr:term_a", "x");
    expect(herdr.sentText).toEqual([{ id: "term_a", text: "x" }]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);

    reg.setWatched(["herdr:term_a", "iterm2:A", "bogus"]);
    expect(herdr.watched.at(-1)).toEqual(["term_a"]);
    expect(iterm.watched.at(-1)).toEqual(["A"]);
    // A backend with no watchers still gets a call -- that is how it learns to stop polling.
    reg.setWatched([]);
    expect(herdr.watched.at(-1)).toEqual([]);
    expect(iterm.watched.at(-1)).toEqual([]);
  });

  it("hides a disconnected member from connected() but keeps routing to it", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2", "herdr"]);
    // spec 8.12/8.13: its socket died; it stays registered (it reconnects itself) but the phones
    // must not be told it is available.
    herdr.isConnected = false;
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2"]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);
  });
});
