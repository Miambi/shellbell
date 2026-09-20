import type { SessionLabel } from "./content";

/**
 * Spec 2026-09-20 §5: a backgrounded app has no in-memory session list, so notifications cannot
 * name a session without this. ONLY titles are stored — never output, never commands. Extending
 * this store to anything else requires revisiting the privacy decision in PRIVACY.md.
 *
 * Pure on purpose: no Expo or react-native import here, so this file can be imported by node
 * tests. The kv-store-backed implementation lives in `./index.ts` as `kvTitleStorage` — that file
 * already imports Expo modules at module scope and is never imported by tests.
 */
export interface TitleStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

const KEY = "shellbell.sessionTitles";

type Book = Record<string, Record<string, SessionLabel>>;

function read(storage: TitleStorage): Book {
  const raw = storage.getItemSync(KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Book;
  } catch {
    // A corrupt value must not break rings. Start over rather than throw in a background task.
    return {};
  }
}

export interface SessionLike {
  id: string;
  title: string;
  backend: string;
}

/**
 * Replaces this computer's entry wholesale, so sessions that have gone away are evicted rather
 * than accumulating. The list is already bounded by the protocol (`max(500)`).
 */
export function saveSessionTitles(
  fp: string,
  sessions: readonly SessionLike[],
  storage: TitleStorage,
): void {
  const book = read(storage);
  const next: Record<string, SessionLabel> = {};
  for (const s of sessions) next[s.id] = { title: s.title, backend: s.backend };
  book[fp] = next;
  storage.setItemSync(KEY, JSON.stringify(book));
}

export function lookupSessionTitle(
  fp: string,
  sessionId: string,
  storage: TitleStorage,
): SessionLabel | undefined {
  return read(storage)[fp]?.[sessionId];
}
