import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CtrlMessage, SessionInfo } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHerdrBackend } from "../src/backends/herdr/start.js";
import { BackendRegistry } from "../src/backends/registry.js";
import type { BackendEvent } from "../src/backends/types.js";
import { EventEngine, type Ring } from "../src/events.js";
import { createLogger } from "../src/log.js";
import { Notifier } from "../src/notifier.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
const snapshot = () =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "herdr-session-snapshot.json"), "utf8"),
  ).result as unknown;

let server: FakeHerdr;
let handle: { stop(): void } | null = null;

beforeEach(async () => {
  server = new FakeHerdr();
  server.reply("session.snapshot", snapshot);
  await server.start();
});
afterEach(async () => {
  handle?.stop();
  handle = null;
  await server.stop();
});

/**
 * The real wiring in miniature: registry -> EventEngine -> Notifier, exactly as `Agent` composes
 * them, so the startup ordering bug (states emitted before anyone is listening, then flattened to
 * "unknown") cannot come back.
 */
function harness() {
  const registry = new BackendRegistry(log);
  const events = new EventEngine({
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4000,
    idleMinActiveMs: 1500,
  });
  const rings: Ring[] = [];
  const notified: CtrlMessage[] = [];
  const notifier = new Notifier((m) => notified.push(m), log);
  events.on("ring", (r) => {
    rings.push(r);
    notifier.ring(r);
  });
  const seen: BackendEvent[] = [];
  registry.on((e) => {
    seen.push(e);
    events.onBackendEvent(e);
  });
  const sessions = async (): Promise<SessionInfo[]> =>
    (await registry.listSessions()).map((s) => {
      const known = events.stateOf(s.id);
      return known === "unknown" ? s : { ...s, state: known };
    });
  return { registry, events, rings, notified, seen, sessions };
}

describe("herdr through the agent's units", () => {
  it("shows an already-blocked agent without ringing, then rings on the next transition", async () => {
    const h = harness();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, revisionPollMs: 60_000, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);

    const list = await h.sessions();
    expect(list.map((s) => [s.id, s.state])).toEqual([
      ["herdr:term_a", "blocked"],
      ["herdr:term_b", "unknown"],
      ["herdr:term_c", "running"],
    ]);
    // Adoption is not a transition: the phone sees `blocked`, but nothing rang.
    expect(h.rings).toEqual([]);
    expect(h.notified).toEqual([]);

    // Now a real transition: working -> blocked rings, and reaches the relay as `notify`.
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "working" });
    await waitFor(() =>
      h.seen.some((e) => e.type === "agent-state" && e.sessionId === "herdr:term_b"),
    );
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "blocked" });
    await waitFor(() => h.rings.length === 1, 3000);
    expect(h.rings[0]).toMatchObject({ sessionId: "herdr:term_b", kind: "blocked" });
    expect(h.notified[0]).toMatchObject({
      type: "notify",
      sessionId: "herdr:term_b",
      kind: "blocked",
    });
    expect((await h.sessions()).find((s) => s.id === "herdr:term_b")?.state).toBe("blocked");
  });

  it("drops every herdr session when the socket dies and re-adopts without ringing", async () => {
    const h = harness();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 30, revisionPollMs: 60_000, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);
    const path = server.path;

    await server.stop();
    await waitFor(() => h.seen.filter((e) => e.type === "session-removed").length === 3, 3000);
    expect(h.registry.connected()).toEqual([]); // spec 8.12: dropped from hello.backends
    expect(await h.sessions()).toEqual([]);

    server = new FakeHerdr(path);
    server.reply("session.snapshot", snapshot);
    await server.start();
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 5000);
    // term_a is still blocked, and it is a first sighting again -> state yes, ring no.
    expect((await h.sessions()).find((s) => s.id === "herdr:term_a")?.state).toBe("blocked");
    expect(h.rings).toEqual([]);
  });
});
