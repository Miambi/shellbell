import {
  applyDiff,
  applySnapshot,
  HISTORY_CAP,
  type Line,
  type ScreenDiff,
  type ScreenSnapshot,
  type ScreenState,
} from "@shellbell/protocol";

export type KeyedLine = Line & { key: string };

export interface ViewState {
  state: ScreenState;
  /** history followed by screen rows — exactly the FlashList data array */
  keyed: KeyedLine[];
}

let counter = 0;
const nextKey = () => `k${++counter}`;

function withKey(line: Line, existing?: KeyedLine): KeyedLine {
  if (existing && existing.r === line.r) return existing;
  return { ...line, key: nextKey() };
}

export function applySnapshotKeyed(prev: ViewState | undefined, snap: ScreenSnapshot): ViewState {
  const state = applySnapshot(prev?.state, snap);
  const history = state.history.map((l, i) => withKey(l, prev?.keyed[i]));
  const screen = state.lines.map((l) => withKey(l));
  return { state, keyed: [...history, ...screen] };
}

export function applyDiffKeyed(
  prev: ViewState,
  diff: ScreenDiff,
): { view: ViewState; gap: boolean } {
  const { state, gap } = applyDiff(prev.state, diff);
  if (gap) return { view: prev, gap: true };
  const histLen = prev.state.history.length;
  const oldHist = prev.keyed.slice(0, histLen);
  const oldScreen = prev.keyed.slice(histLen);
  // Mirror applyDiff's clamp so a malformed `scroll` cannot desynchronise keys from lines.
  const scrolled = Math.min(diff.scroll, oldScreen.length);
  let newHist = [...oldHist, ...oldScreen.slice(0, scrolled)];
  const drop = newHist.length - state.history.length;
  if (drop > 0) newHist = newHist.slice(drop);
  const shifted = oldScreen.slice(scrolled);
  const changed = new Set(diff.changed.map((c) => c.i));
  const screen = state.lines.map((line, i) =>
    changed.has(i) ? withKey(line) : (shifted[i] ?? withKey(line)),
  );
  return { view: { state, keyed: [...newHist, ...screen] }, gap: false };
}

/**
 * Prepend one `history` page. Returns `prev` unchanged when the page no longer lines up with the
 * current `historyFrom` (a stale response). Caps at HISTORY_CAP from the *oldest* end, matching
 * applyDiff, so the newest context is never dropped.
 */
export function prependHistoryKeyed(prev: ViewState, lines: Line[], before: number): ViewState {
  if (before !== prev.state.historyFrom || lines.length === 0) return prev;
  const keyedNew = lines.map((l) => withKey(l));
  let history = [...lines, ...prev.state.history];
  let keyed = [...keyedNew, ...prev.keyed];
  let historyFrom = prev.state.historyFrom - lines.length;
  const overflow = history.length - HISTORY_CAP;
  if (overflow > 0) {
    history = history.slice(overflow);
    keyed = keyed.slice(overflow);
    historyFrom += overflow;
  }
  return { state: { ...prev.state, history, historyFrom }, keyed };
}
