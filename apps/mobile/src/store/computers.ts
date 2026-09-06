import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";

export interface Computer {
  fp: string;
  name: string;
  accent: string;
  relayUrl: string;
  pairedAt: string;
  lastSeenAt: string | null;
  pushEnabled: boolean;
}

const KEY = "shellbell.computers.v1";
const UI_KEY = "shellbell.ui.v1";

interface ComputersState {
  computers: Computer[];
  hydrated: boolean;
  hydrate: () => void;
  add: (c: Computer) => void;
  remove: (fp: string) => void;
  update: (fp: string, patch: Partial<Computer>) => void;
}

function persist(list: Computer[]) {
  Storage.setItemSync(KEY, JSON.stringify(list));
}

export const useComputersStore = create<ComputersState>((set, get) => ({
  computers: [],
  hydrated: false,
  hydrate: () => {
    const raw = Storage.getItemSync(KEY);
    set({ computers: raw ? (JSON.parse(raw) as Computer[]) : [], hydrated: true });
  },
  add: (c) => {
    const list = [...get().computers.filter((x) => x.fp !== c.fp), c];
    persist(list);
    set({ computers: list });
  },
  remove: (fp) => {
    const list = get().computers.filter((x) => x.fp !== fp);
    persist(list);
    set({ computers: list });
  },
  update: (fp, patch) => {
    const list = get().computers.map((x) => (x.fp === fp ? { ...x, ...patch } : x));
    persist(list);
    set({ computers: list });
  },
}));

interface UiState {
  fontSize: number;
  fitWidth: boolean;
  rawModeBySession: Record<string, boolean>;
  setFontSize: (n: number) => void;
  setFitWidth: (b: boolean) => void;
  setRawMode: (sid: string, b: boolean) => void;
}

const uiRaw = Storage.getItemSync(UI_KEY);
const uiInit = uiRaw ? (JSON.parse(uiRaw) as Partial<UiState>) : {};

function persistUi(s: UiState) {
  Storage.setItemSync(
    UI_KEY,
    JSON.stringify({
      fontSize: s.fontSize,
      fitWidth: s.fitWidth,
      rawModeBySession: s.rawModeBySession,
    }),
  );
}

export const useUiStore = create<UiState>((set, get) => ({
  fontSize: uiInit.fontSize ?? 12,
  fitWidth: uiInit.fitWidth ?? false,
  rawModeBySession: uiInit.rawModeBySession ?? {},
  setFontSize: (n) => {
    set({ fontSize: Math.max(5, Math.min(24, n)) });
    persistUi(get());
  },
  setFitWidth: (b) => {
    set({ fitWidth: b });
    persistUi(get());
  },
  setRawMode: (sid, b) => {
    set({ rawModeBySession: { ...get().rawModeBySession, [sid]: b } });
    persistUi(get());
  },
}));
