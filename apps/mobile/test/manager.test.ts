import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `manager.ts` pulls in `react-native` (`AppState`) and, via `store/computers.ts`,
 * `expo-sqlite/kv-store` — neither runs under vitest/node. These mocks are the seam: `AppState`
 * exposes a controllable `currentState` plus a real listener list (via `__setAppState`, a
 * test-only escape hatch) so `connectAll`'s generation guard can be driven deterministically
 * without a real device or a real timer race.
 */
vi.mock("react-native", () => {
  let currentState: string = "active";
  const listeners: Array<(s: string) => void> = [];
  return {
    AppState: {
      get currentState() {
        return currentState;
      },
      addEventListener: (_event: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      },
    },
    __setAppState: (s: string) => {
      currentState = s;
      for (const cb of [...listeners]) cb(s);
    },
  };
});

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: () => null,
    setItemSync: () => {},
  },
}));

vi.mock("../src/identity/keys", () => ({
  loadPairSecret: vi.fn(),
}));

interface ConnOpts {
  onInner: (m: { type: string; [k: string]: unknown }) => void;
  onStatus: (s: string, extra?: unknown) => void;
  pushToken?: () => Promise<{
    token: string;
    platform: "ios" | "android";
    enabled: boolean;
  } | null>;
}

interface RecordedConnection {
  opts: ConnOpts;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  newReqId: ReturnType<typeof vi.fn>;
  sendPushToken: ReturnType<typeof vi.fn>;
  unpairSelf: ReturnType<typeof vi.fn>;
  pendingReqIds: () => string[];
}

const created: RecordedConnection[] = [];
vi.mock("../src/net/connection", () => ({
  ComputerConnection: vi.fn().mockImplementation(function (this: unknown, opts: ConnOpts) {
    const inst: RecordedConnection = {
      opts,
      connect: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      newReqId: vi.fn(() => "req1"),
      sendPushToken: vi.fn(),
      unpairSelf: vi.fn(),
      pendingReqIds: () => [],
    };
    created.push(inst);
    return inst;
  }),
}));

const setAppState = async (s: "active" | "background" | "inactive") => {
  const rn = (await import("react-native")) as unknown as { __setAppState: (s: string) => void };
  rn.__setAppState(s);
};

const computer = {
  fp: "f1",
  name: "MBP",
  accent: "emerald",
  relayUrl: "ws://relay.invalid",
  pairedAt: new Date().toISOString(),
  lastSeenAt: null,
  pushEnabled: false,
};

describe("ConnectionManager", () => {
  beforeEach(async () => {
    vi.resetModules();
    created.length = 0;
    await setAppState("active");
    const { useComputersStore } = await import("../src/store/computers");
    useComputersStore.setState({ computers: [computer] });
  });

  it("connects when the app is foreground throughout", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(1);
    expect(created[0]?.connect).toHaveBeenCalledTimes(1);
    connectionManager.stop();
  });

  it("backgrounded mid-await bails: no connection is ever created", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    let resolveSecret!: (v: unknown) => void;
    (loadPairSecret as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((r) => {
          resolveSecret = r;
        }),
    );
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    // `connectAll` is now suspended awaiting `loadPairSecret`; background before it resumes.
    await setAppState("background");
    resolveSecret({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0);
    connectionManager.stop();
  });

  it("R57: a background/foreground flap during loadPairSecret self-heals to exactly one connection", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    const secret = {
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    };
    let resolveSecret!: (v: unknown) => void;
    // The first call (call A, from `start()`) hangs until we resolve it below; any call made by
    // a self-healing rerun resolves immediately, as a real SecureStore retry would.
    (loadPairSecret as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecret = r;
          }),
      )
      .mockResolvedValue(secret);
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    // `connectAll` (call A) is now suspended awaiting the first `loadPairSecret`.
    await setAppState("background"); // bumps the generation; nothing to close yet
    await setAppState("active"); // the re-triggered connectAll (call B) finds f1 still "starting"
    // Give the self-healing machinery a few ticks *without* resolving call A yet, proving it
    // does not busy-loop or connect early while the original call is genuinely still in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0);
    // Now let the original await resolve: it bails on the stale generation and flags a rerun,
    // which re-scans against the (by-then active) current state and connects for real.
    resolveSecret(secret);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(1);
    expect(created[0]?.connect).toHaveBeenCalledTimes(1);
    connectionManager.stop();
  });

  it("onInner: a generation gap on screen.diff sends snapshot.get, not a bad local patch (spec 15)", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    const sessionId = "iterm2:s1";
    const state = {
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0 },
      lines: [],
      scrollbackTotal: 0,
      gen: 1,
      history: [],
      historyFrom: 0,
    };
    useConnectionsStore
      .getState()
      .patch("f1", () => ({ view: { sessionId, view: { state, keyed: [] } } }));

    // gen 5 with a current gen of 1 is a gap (expects gen 2): must ask for a fresh snapshot, and
    // must not silently apply/patch the stale-relative diff.
    conn.opts.onInner({
      type: "screen.diff",
      sessionId,
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 0,
      gen: 5,
    });
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "snapshot.get", sessionId }),
    );
    // The view's generation is untouched -- no side effect from the gap itself.
    expect(useConnectionsStore.getState().read("f1").view?.view.state.gen).toBe(1);
    connectionManager.stop();
  });

  it("onInner: a sessions message persists titles via the injected titleStorage (spec 2026-09-20 §5)", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    const { lookupSessionTitle } = await import("../src/notifications/sessionTitles");
    const titles = new Map<string, string>();
    const titleStorage = {
      getItemSync: (k: string) => titles.get(k) ?? null,
      setItemSync: (k: string, v: string) => void titles.set(k, v),
    };
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
      titleStorage,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    // Drives the real `case "sessions":` branch through the manager's message loop -- not a
    // direct call to `onSessionsMessage` -- so this guards the wiring itself (the call site and
    // the `this.deps?.titleStorage` plumbing), not just the exported function's own logic.
    conn.opts.onInner({
      type: "sessions",
      list: [{ id: "s1", title: "claude-code", backend: "herdr" }],
    });

    expect(lookupSessionTitle("f1", "s1", titleStorage)?.title).toBe("claude-code");
    connectionManager.stop();
  });

  it("notifyPushToggle sends push-token when a token exists, and is a no-op otherwise", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async (fp: string) => ({ token: `tok-${fp}`, platform: "ios", enabled: false }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    connectionManager.notifyPushToggle("f1", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: true,
    });

    // An unknown fp (no live connection) must not throw.
    expect(() => connectionManager.notifyPushToggle("unknown", true)).not.toThrow();
    connectionManager.stop();
  });

  it("M1: toggling push off falls back to the last known token when a fresh fetch resolves null", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    let resolveToken = true;
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      // Resolves a real token on connect (so the manager caches it), then null afterwards --
      // e.g. permission revoked or a transient Expo failure on the toggle's own fetch.
      pushToken: async (fp: string) =>
        resolveToken ? { token: `tok-${fp}`, platform: "ios", enabled: false } : null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    // First toggle succeeds with a real token -- this is what populates the cache (the mocked
    // `ComputerConnection.connect()` is a no-op, so it never calls `opts.pushToken` itself).
    connectionManager.notifyPushToggle("f1", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: true,
    });

    // Now a fresh fetch fails (permission revoked, transient Expo error, ...): the "off" toggle
    // must still reach the relay using the token cached from the successful fetch above, since
    // the protocol's `push-token.token` is required non-empty (packages/protocol/src/ctrl.ts).
    resolveToken = false;
    connectionManager.notifyPushToggle("f1", false);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: false,
    });
    connectionManager.stop();
  });

  it("M1: toggling push with no token ever cached is a silent no-op", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    connectionManager.notifyPushToggle("f1", false);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).not.toHaveBeenCalled();
    connectionManager.stop();
  });
});
