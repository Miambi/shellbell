export type Color = number | [number, number, number];

export interface Run {
  t: string;
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  /** terminal cells occupied; present only when it differs from the code-point count of t */
  n?: number;
}

export interface Line {
  r: Run[];
  /** true when this row is soft-wrapped into the next one */
  w?: boolean;
}

export interface Cursor {
  x: number;
  y: number;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cursor: Cursor;
  lines: Line[];
  scrollbackTotal: number;
  gen: number;
  reset?: boolean;
  degraded?: boolean;
}

export interface ScreenDiff {
  scroll: number;
  changed: { i: number; line: Line }[];
  cursor: Cursor;
  scrollbackTotal: number;
  gen: number;
}

export interface ScreenState extends ScreenSnapshot {
  /** lines above the screen held locally; absolute index of history[0] is historyFrom */
  history: Line[];
  historyFrom: number;
}

export const HISTORY_CAP = 5000;

export function emptyLine(): Line {
  return { r: [] };
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function colorKey(c?: Color): string {
  if (c === undefined) return "";
  return typeof c === "number" ? String(c) : `${c[0]},${c[1]},${c[2]}`;
}

export function sameStyle(a: Run, b: Run): boolean {
  return (
    colorKey(a.fg) === colorKey(b.fg) &&
    colorKey(a.bg) === colorKey(b.bg) &&
    !!a.b === !!b.b &&
    !!a.i === !!b.i &&
    !!a.u === !!b.u &&
    !!a.s === !!b.s &&
    !!a.f === !!b.f
  );
}

function cellsOf(r: Run): number {
  return r.n ?? codePoints(r.t);
}

/** Merge adjacent runs with identical style. `n` is kept only when it differs from the code-point count. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) {
      const cells = cellsOf(last) + cellsOf(r);
      last.t += r.t;
      if (cells !== codePoints(last.t)) last.n = cells;
      else delete last.n;
    } else {
      const copy: Run = { ...r };
      if (copy.n !== undefined && copy.n === codePoints(copy.t)) delete copy.n;
      out.push(copy);
    }
  }
  return out;
}

/** Drop trailing runs that are only spaces and carry no background color. Trim trailing spaces from the final run if it has no background color, adjusting n arithmetically. */
export function trimTrailing(runs: Run[]): Run[] {
  const out = runs.slice();
  while (out.length > 0) {
    const last = out[out.length - 1] as Run;
    if (last.bg === undefined && /^ *$/.test(last.t)) out.pop();
    else break;
  }
  // Trim trailing spaces from the last run if it has no background color
  if (out.length > 0) {
    const last = out[out.length - 1] as Run;
    if (last.bg === undefined) {
      const trimmed = last.t.replace(/\s+$/, "");
      if (trimmed === "") {
        out.pop();
      } else if (trimmed !== last.t) {
        // Copy the run to avoid mutating caller's object
        const copy: Run = { ...last };
        const removed = last.t.length - trimmed.length;
        const cells = (last.n ?? codePoints(last.t)) - removed;
        copy.t = trimmed;
        if (cells !== codePoints(trimmed)) copy.n = cells;
        else delete copy.n;
        out[out.length - 1] = copy;
      }
    }
  }
  return out;
}

export function stripStyles(line: Line): Line {
  const text = line.r.map((r) => r.t).join("");
  const out: Line = { r: text ? [{ t: text }] : [] };
  if (line.w) out.w = true;
  return out;
}

function flags(r: Run): string {
  return `${r.b ? 1 : 0}${r.i ? 1 : 0}${r.u ? 1 : 0}${r.s ? 1 : 0}${r.f ? 1 : 0}`;
}

/** Canonical string form used for row comparison: runs joined by \x1f. */
export function lineKey(line: Line): string {
  return line.r
    .map((r) => `${r.t}|${colorKey(r.fg)}|${colorKey(r.bg)}|${flags(r)}|${r.n ?? ""}`)
    .join("\x1f");
}

export function applySnapshot(prev: ScreenState | undefined, snap: ScreenSnapshot): ScreenState {
  const keepHistory =
    prev !== undefined && !snap.reset && prev.scrollbackTotal === snap.scrollbackTotal;
  return {
    ...snap,
    lines: snap.lines.slice(),
    history: keepHistory ? prev.history : [],
    historyFrom: keepHistory ? prev.historyFrom : snap.scrollbackTotal,
  };
}

export function applyDiff(
  state: ScreenState,
  diff: ScreenDiff,
): { state: ScreenState; gap: boolean } {
  if (diff.gen !== state.gen + 1) return { state, gap: true };
  const lines = state.lines.slice();
  let history = state.history;
  let historyFrom = state.historyFrom;
  if (diff.scroll > 0) {
    const out = lines.splice(0, Math.min(diff.scroll, lines.length));
    if (history.length === 0) historyFrom = state.scrollbackTotal;
    history = history.concat(out);
    for (let k = 0; k < diff.scroll; k++) lines.push(emptyLine());
    if (history.length > HISTORY_CAP) {
      const drop = history.length - HISTORY_CAP;
      history = history.slice(drop);
      historyFrom += drop;
    }
  }
  for (const c of diff.changed) {
    if (c.i >= 0 && c.i < lines.length) lines[c.i] = c.line;
  }
  return {
    state: {
      ...state,
      lines,
      history,
      historyFrom,
      cursor: diff.cursor,
      scrollbackTotal: diff.scrollbackTotal,
      gen: diff.gen,
      reset: undefined,
      degraded: undefined,
    },
    gap: false,
  };
}
