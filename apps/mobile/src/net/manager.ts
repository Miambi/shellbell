import type { Identity, InnerMessageLoose } from "@shellbell/protocol";
import { AppState, type AppStateStatus } from "react-native";
import { loadPairSecret } from "../identity/keys";
import { useComputersStore } from "../store/computers";
import type { Status } from "../store/connections";
import { useConnectionsStore } from "../store/connections";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../store/screen";
import type { StatusExtra } from "./connection";
import { ComputerConnection, type PushTokenInfo } from "./connection";

const LOST_INPUT_TOAST = "Some input may not have been delivered";

export interface ManagerDeps {
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  pushToken: (computerFp: string) => Promise<PushTokenInfo | null>;
}

class Manager {
  private conns = new Map<string, ComputerConnection>();
  private starting = new Set<string>();
  private deps: ManagerDeps | null = null;
  /** Bumped by `closeAll`; a `connectAll` in flight when it changes must not resume as if
   *  still foregrounded (spec 11.3: a backgrounded phone must not hold a connection open). */
  private generation = 0;
  private sub: { remove: () => void } | null = null;
  private unsubscribeComputers: (() => void) | null = null;

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

  private onAppState(s: AppStateStatus): void {
    if (s === "active") void this.connectAll();
    else this.closeAll("background");
  }

  private async connectAll(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const gen = this.generation;
    for (const c of useComputersStore.getState().computers) {
      // Single-flight: `starting` is set synchronously, before the first await.
      if (this.conns.has(c.fp) || this.starting.has(c.fp)) continue;
      this.starting.add(c.fp);
      try {
        const secret = await loadPairSecret(c.fp);
        // Backgrounded (or superseded by a newer connectAll) while awaiting SecureStore: bail
        // rather than resuming as if still foregrounded — `closeAll` already bumped `generation`.
        if (this.generation !== gen || AppState.currentState !== "active") continue;
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
          pushToken: () => deps.pushToken(c.fp),
          onStatus: (status, extra) => this.onStatus(c.fp, status, extra),
          onInner: (m) => this.onInner(c.fp, m),
        });
        this.conns.set(c.fp, conn);
        conn.connect();
      } finally {
        this.starting.delete(c.fp);
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
      case "event":
        store.patch(fp, (c) => ({
          events: {
            ...c.events,
            [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m],
          },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        return;
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
