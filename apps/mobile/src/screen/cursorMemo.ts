export interface RowCursor {
  x: number;
  y: number;
  accent: string;
  blinking: boolean;
  inferred: boolean;
}

/**
 * Builds the `cursor` object passed to `ScreenRow`, reusing `prev`'s reference when every
 * primitive field is unchanged. `ScreenRow` is wrapped in `memo`, which does a shallow prop
 * comparison — a fresh object literal every render would make every row (not just the one that
 * owns the cursor) see a "changed" `cursor` prop and re-render regardless of `memo`.
 */
export function buildCursor(prev: RowCursor | null, next: RowCursor | null): RowCursor | null {
  if (next === null) return null;
  if (
    prev !== null &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.accent === next.accent &&
    prev.blinking === next.blinking &&
    prev.inferred === next.inferred
  ) {
    return prev;
  }
  return next;
}
