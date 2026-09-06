import type { Identity, InnerMessageLoose } from "@shellbell/protocol";
import { AppState, type AppStateStatus } from "react-native";
import { loadPairSecret } from "../identity/keys";
import { useComputersStore } from "../store/computers";
import type { Status } from "../store/connections";
import { useConnectionsStore } from "../store/connections";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../store/screen";
import type { StatusExtra } from "./connection";
import { ComputerConnection, type PushTokenInfo } from "./connection";
import { LOST_INPUT_TOAST } from "./toasts";

export { LOST_INPUT_TOAST };

export interface ManagerDeps {
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  pushToken: (computerFp: string) => Promise<PushTokenInfo | null>;
  /** Spec 10.8 foreground path. Injected by `_layout.tsx` so this module stays native-free:
   *  importing `src/notifications` here would pull `expo-notifications` into `manager.test.ts`. */
  onForegroundEvent?: (computerFp: string, sessionTitle: string, kind: string) => void;
}

class Manager {
  private conns = new Map<string, ComputerConnection>();
  private starting = new Set<string>();
  private deps: ManagerDeps | null = null;
  /** Bumped by `closeAll`; a `connectAll` in flight when it changes must not resume as if
   *  still foregrounded (spec 11.3: a backgrounded phone must not hold a connection open). */
  private generation = 0;
  /** Set (R57) when a computer was skipped/bailed this round and might need a retry once the
   *  app is confirmed active again; consumed only where a `starting` lock actually releases (see
   *  `connectAll`), never eagerly, so a still-in-flight lock is never busy-polled. */
  private rerun = false;
  private sub: { remove: () => void } | null = null;
  private unsubscribeComputers: (() => void) | null = null;
  /** Last push token the relay is known to have per computer (M1): the protocol's `push-token`
   *  requires a non-empty `token` (packages/protocol/src/ctrl.ts), so an "off" toggle after a
   *  fresh fetch fails (permission revoked, transient Expo error) has nothing valid to send
   *  unless it falls back to a token we previously registered successfully. */
  private lastToken = new Map<string, PushTokenInfo>();

  start(deps: ManagerDeps): void {
    this.deps = deps;
    this.sub = AppState.addEventListener("change", (s) => this.onAppState(s));
    this.unsubscribeComputers = useComputersStore.subscribe((s, prev) => {
      if (s.computers !== prev.computers && AppState.currentState === "active") {
        void this.connectAll();
      }
    });
    if (AppState.currentState === "active") void this.connectAll();
  }

  stop(): void {
    this.sub?.remove();
    this.unsubscribeComputers?.();
    this.sub = null;
    this.unsubscribeComputers = null;
    this.closeAll("user");
  }

  get(fp: string): ComputerConnection | undefined {
    return this.conns.get(fp);
  }

  /** Review R60: forward a notifications-toggle change over the wire when a push token exists.
   *  Token acquisition itself is a Plan 06 stub (`async () => null` today) -- the store's
   *  `pushEnabled` flag is always the source of truth regardless of whether this send succeeds. */
  notifyPushToggle(fp: string, enabled: boolean): void {
    const conn = this.conns.get(fp);
    const deps = this.deps;
    if (!conn || !deps) return;
    this.fetchToken(fp)
      .then((t) => {
        if (t) {
          conn.sendPushToken({ ...t, enabled });
          return;
        }
        // M1: a fresh fetch failing (permission revoked, transient Expo error, placeholder
        // projectId) must not silently strand `enabled: false` -- the protocol requires a
        // non-empty token, so re-send the last token we know the relay already has with the
        // new `enabled` value. If we have never registered a token for this computer there is
        // genuinely nothing valid to send; this is a documented no-op, not a bug (the relay was
        // never told push was on in the first place, so "off" needs no message).
        const cached = this.lastToken.get(fp);
        if (cached) conn.sendPushToken({ ...cached, enabled });
      })
      .catch(() => undefined);
  }

  /** Wraps `deps.pushToken` to remember the last non-null result per computer (M1), so a later
   *  failed fetch (e.g. toggling push off) can still fall back to a token the relay already has. */
  private fetchToken(fp: string): Promise<PushTokenInfo | null> {
    const deps = this.deps;
    if (!deps) return Promise.resolve(null);
    return deps.pushToken(fp).then((t) => {
      if (t) this.lastToken.set(fp, t);
      return t;
    });
  }

  private onAppState(s: AppStateStatus): void {
    if (s === "active") void this.connectAll();
    else this.closeAll("background");
  }

  private async connectAll(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const gen = this.generation;
    for (const c of useComputersStore.getState().computers) {
      if (this.conns.has(c.fp)) continue;
      if (this.starting.has(c.fp)) {
        // Another connectAll is already handling this fp (mid-`loadPairSecret`); that call may
        // bail below without ever creating a connection if a background/foreground flap changed
        // the generation out from under it (R57). Flag a rerun -- it is only ever consumed once
        // *some* call's own lock below actually releases, never eagerly here: this path never
        // awaits, so eagerly retrying here would busy-loop against a lock that hasn't had a
        // chance to clear yet.
        this.rerun = true;
        continue;
      }
      this.starting.add(c.fp);
      try {
        const secret = await loadPairSecret(c.fp);
        // Never create a socket for a stale generation -- but the app may be active again by the
        // time this settles, so flag a rerun rather than stranding this computer until the next
        // AppState/store trigger (R57).
        if (this.generation !== gen || AppState.currentState !== "active") {
          this.rerun = true;
          continue;
        }
        if (!secret) continue;
        if (this.conns.has(c.fp)) continue;
        const conn = new ComputerConnection({
          computerFp: c.fp,
          relayUrl: c.relayUrl,
          identity: deps.identity,
          phoneFp: deps.phoneFp,
          phoneName: deps.phoneName,
          appVersion: deps.appVersion,
          kPair: secret.kPair,
          pushToken: () => this.fetchToken(c.fp),
          onStatus: (status, extra) => this.onStatus(c.fp, status, extra),
          onInner: (m) => this.onInner(c.fp, m),
        });
        this.conns.set(c.fp, conn);
        conn.connect();
      } finally {
        this.starting.delete(c.fp);
        // Self-healing (R57): a lock just released, which guarantees real async progress was
        // made (this path only runs after an `await`) -- if anything was flagged as missed while
        // this or another call was in flight, re-scan once. Loop-safe: clear before recursing so
        // a rerun that itself needs another rerun isn't silently swallowed by this call clearing
        // it afterwards.
        if (this.rerun && AppState.currentState === "active") {
          this.rerun = false;
          void this.connectAll();
        }
      }
    }
    if (this.generation !== gen) return;
    for (const [fp, conn] of this.conns) {
      if (!useComputersStore.getState().computers.some((c) => c.fp === fp)) {
        conn.close("user");
        this.conns.delete(fp);
      }
    }
  }

  private closeAll(reason: "background" | "user"): void {
    this.generation++;
    for (const [fp, conn] of this.conns) {
      const lost = conn.pendingReqIds();
      conn.close(reason);
      if (lost.length > 0) this.noteLostInputs(fp, lost);
    }
    this.conns.clear();
  }

  /** Spec 12: any close with un-acked input raises the toast — not only a deliberate background. */
  private noteLostInputs(fp: string, lost: string[]): void {
    if (lost.length === 0) return;
    useConnectionsStore.getState().patch(fp, (c) => {
      const rest = { ...c.pendingInputs };
      for (const id of lost) delete rest[id];
      return { pendingInputs: rest, toast: LOST_INPUT_TOAST };
    });
  }

  private onStatus(fp: string, status: Status, extra?: StatusExtra): void {
    useConnectionsStore.getState().patch(fp, () => ({
      status,
      agentOnline: extra?.agentOnline ?? status === "online",
      error: extra?.error,
    }));
    // Spec 12: any close with un-acked input raises the toast, not only a deliberate background.
    if (extra?.lostReqIds?.length) this.noteLostInputs(fp, extra.lostReqIds);
  }

  private onInner(fp: string, m: InnerMessageLoose): void {
    const store = useConnectionsStore.getState();
    switch (m.type) {
      case "hello":
        store.patch(fp, () => ({ hello: m }));
        useComputersStore.getState().update(fp, {
          name: m.computerName,
          accent: m.accent,
          lastSeenAt: new Date().toISOString(),
        });
        return;
      case "sessions":
        store.patch(fp, () => ({ sessions: m.list }));
        return;
      case "screen.snapshot":
        store.patch(fp, (c) => ({
          view: {
            sessionId: m.sessionId,
            view: applySnapshotKeyed(
              c.view?.sessionId === m.sessionId ? c.view.view : undefined,
              m,
            ),
          },
        }));
        return;
      case "screen.diff": {
        // Compute first, patch second, send third: no side effects inside the reducer.
        const cur = store.read(fp);
        if (cur.view?.sessionId !== m.sessionId) return;
        const { view, gap } = applyDiffKeyed(cur.view.view, m);
        if (gap) {
          const conn = this.conns.get(fp);
          if (conn) {
            conn.send({
              type: "snapshot.get",
              reqId: conn.newReqId(),
              sessionId: m.sessionId,
            });
          }
          return;
        }
        store.patch(fp, () => ({ view: { sessionId: m.sessionId, view } }));
        return;
      }
      case "history":
        store.patch(fp, (c) => ({
          oldestAvailable: { ...c.oldestAvailable, [m.sessionId]: m.oldestAvailable },
          view:
            c.view?.sessionId === m.sessionId
              ? {
                  sessionId: m.sessionId,
                  view: prependHistoryKeyed(c.view.view, m.lines, m.before),
                }
              : c.view,
        }));
        return;
      case "event": {
        const title = store.read(fp).sessions.find((s) => s.id === m.sessionId)?.title ?? "Session";
        store.patch(fp, (c) => ({
          events: {
            ...c.events,
            [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m],
          },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        this.deps?.onForegroundEvent?.(fp, title, m.kind);
        return;
      }
      case "ack":
        store.patch(fp, (c) => {
          const rest = { ...c.pendingInputs };
          delete rest[m.reqId];
          return { pendingInputs: rest };
        });
        return;
      default:
        return;
    }
  }
}

export const connectionManager = new Manager();
