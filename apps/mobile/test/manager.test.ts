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

interface RecordedConnection {
  opts: unknown;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  pendingReqIds: () => string[];
}

const created: RecordedConnection[] = [];
vi.mock("../src/net/connection", () => ({
  ComputerConnection: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
    const inst: RecordedConnection = {
      opts,
      connect: vi.fn(),
      close: vi.fn(),
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
});
