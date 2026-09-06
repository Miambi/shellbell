import type { InnerMessageLooseOf, SessionInfoLoose } from "@shellbell/protocol";
import { create } from "zustand";
import type { ViewState } from "./screen";

export type Status = "idle" | "connecting" | "auth" | "handshake" | "online" | "offline" | "error";

/** Terminal error states: no reconnect will help until the user acts. */
export type ErrorKind = "unpaired" | "re-pair" | "superseded" | "rejected" | "relay";

export type SessionEvent = InnerMessageLooseOf<"event">;

export interface ComputerConn {
  status: Status;
  agentOnline: boolean;
  error?: ErrorKind;
  hello?: InnerMessageLooseOf<"hello">;
  sessions: SessionInfoLoose[];
  view?: { sessionId: string; view: ViewState };
  /** Oldest absolute line the agent still has, per session (from `history.oldestAvailable`). */
  oldestAvailable: Record<string, number>;
  events: Record<string, SessionEvent[]>;
  unread: Record<string, number>;
  pendingInputs: Record<string, { at: number; sessionId: string }>;
  history: string[];
  toast?: string;
}

const empty = (): ComputerConn => ({
  status: "idle",
  agentOnline: false,
  sessions: [],
  oldestAvailable: {},
  events: {},
  unread: {},
  pendingInputs: {},
  history: [],
});

interface ConnectionsState {
  byComputer: Record<string, ComputerConn>;
  read: (fp: string) => ComputerConn;
  patch: (fp: string, fn: (c: ComputerConn) => Partial<ComputerConn>) => void;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  byComputer: {},
  read: (fp) => get().byComputer[fp] ?? empty(),
  patch: (fp, fn) => {
    const cur = get().byComputer[fp] ?? empty();
    set({ byComputer: { ...get().byComputer, [fp]: { ...cur, ...fn(cur) } } });
  },
}));
