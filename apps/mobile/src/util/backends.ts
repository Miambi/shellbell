import { type BackendName, BackendNameSchema } from "@shellbell/protocol";

const LABELS: Record<string, string> = {
  iterm2: "iTerm2",
  tmux: "tmux",
  herdr: "Herdr",
};

const NEW_SESSION_LABELS: Record<string, string> = {
  iterm2: "New iTerm2 tab",
  tmux: "New tmux window",
  herdr: "New Herdr tab",
};

/** Known backend -> its display name; anything else -> the raw string (spec 10.6). */
export function backendLabel(name: string): string {
  return LABELS[name] ?? name;
}

export function newSessionLabel(name: string): string {
  return NEW_SESSION_LABELS[name] ?? `New ${backendLabel(name)} session`;
}

/**
 * `session.create` and `session.focus` travel to the agent's *strict* parser, so only a backend the
 * shipped enum knows may be offered as an action. Unknown backends still render (label + badge);
 * they just get no "New …" entry.
 */
export function asBackendName(name: string): BackendName | null {
  const r = BackendNameSchema.safeParse(name);
  return r.success ? r.data : null;
}

/** Spec 8.13: a Herdr cursor is inferred from the agent's output, not a real terminal cursor. */
export function cursorIsInferred(backend: string): boolean {
  return backend === "herdr";
}

/** Session ids are "<backend>:<native id>"; the list groups by backend before window. */
export function backendOf(sessionId: string): string {
  const i = sessionId.indexOf(":");
  return i === -1 ? sessionId : sessionId.slice(0, i);
}
