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
});
