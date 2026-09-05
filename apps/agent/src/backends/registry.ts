import {
  type BackendName,
  BackendNameSchema,
  type Capabilities,
  type CreateWhere,
  type Line,
  type SessionInfo,
} from "@shellbell/protocol";
import type { Logger } from "../log.js";
import {
  type BackendEvent,
  BadWindow,
  type Screen,
  SessionGone,
  type TerminalBackend,
} from "./types.js";

export function prefixId(name: BackendName, native: string): string {
  return `${name}:${native}`;
}

/** Spec 8.12 ordering: iTerm2 first, then tmux, then herdr. */
const BACKEND_ORDER: BackendName[] = ["iterm2", "tmux", "herdr"];

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  // Validated against the schema rather than a hard-coded list: adding a backend name to the
  // protocol must never silently leave its ids unroutable here.
  const name = BackendNameSchema.safeParse(id.slice(0, i));
  if (!name.success) return null;
  return { name: name.data, native: id.slice(i + 1) };
}

export class BackendRegistry implements TerminalBackend {
  readonly name = "iterm2" as const;
  private readonly members = new Map<BackendName, TerminalBackend>();
  private readonly unsubs = new Map<BackendName, () => void>();
  private readonly handlers = new Set<(e: BackendEvent) => void>();

  constructor(private readonly log: Logger) {}

  get capabilities(): Capabilities {
    const all = [...this.members.values()].map((b) => b.capabilities);
    const or = (k: keyof Capabilities) => all.some((c) => c[k]);
    return {
      subscribe: or("subscribe"),
      prompts: or("prompts"),
      createSession: or("createSession"),
      focus: or("focus"),
      history: or("history"),
      // `Array.every` on an empty array is vacuously true; with no backends connected there is no
      // basis to claim absolute line numbering, so an empty registry must report `false` here.
      absoluteLines: all.length > 0 && all.every((c) => c.absoluteLines),
    };
  }

  add(backend: TerminalBackend): void {
    this.members.set(backend.name, backend);
    this.unsubs.get(backend.name)?.();
    this.unsubs.set(
      backend.name,
      backend.on((e) => this.emit(prefixEvent(backend.name, e))),
    );
    this.emit({ type: "layout-changed" });
  }

  remove(name: BackendName): void {
    this.unsubs.get(name)?.();
    this.unsubs.delete(name);
    this.members.delete(name);
    this.emit({ type: "layout-changed" });
  }

  /**
   * spec 8.12/8.13: only the backends that can actually serve a phone right now. A member whose
   * transport is down (`connected === false`) stays registered -- it reconnects itself and its
   * sessions must keep routing -- but it is not advertised in `hello.backends`.
   *
   * Ordered by `BACKEND_ORDER`, not insertion order: `startHerdrBackend` registers synchronously
   * while iTerm2 only joins after its own `await connect()` (`cli.ts`), so insertion order alone
   * would make `hello.backends` read `[herdr, iterm2]` in production -- not spec-ordered, and not
   * deterministic across runs.
   */
  connected(): { name: BackendName; capabilities: Capabilities }[] {
    const out: { name: BackendName; capabilities: Capabilities }[] = [];
    for (const name of BACKEND_ORDER) {
      const b = this.members.get(name);
      if (b && b.isConnected !== false) out.push({ name: b.name, capabilities: b.capabilities });
    }
    return out;
  }

  nameOf(id: string): BackendName | null {
    return splitId(id)?.name ?? null;
  }

  capabilitiesOf(id: string): Capabilities | null {
    const n = this.nameOf(id);
    return n ? (this.members.get(n)?.capabilities ?? null) : null;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    await Promise.all([...this.members.values()].map((b) => b.close()));
    for (const unsub of this.unsubs.values()) unsub();
    this.unsubs.clear();
    this.members.clear();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const iterm = this.members.get("iterm2");
    let hidden = new Set<string>();
    if (iterm) {
      try {
        hidden = iterm.tmuxWindowIds?.() ?? new Set<string>();
      } catch (err) {
        this.log.warn("tmuxWindowIds failed; tmux panes will not be de-duped this round", {
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    // spec 8.12/15: one backend's failure must never affect the others -- settle each member's
    // `listSessions()` independently, log the failure, and return whatever the survivors have.
    const lists = await Promise.all(
      BACKEND_ORDER.map(
        (name): Promise<[BackendName, SessionInfo[]]> =>
          this.safeListSessions(this.members.get(name), name).then((sessions) => [name, sessions]),
      ),
    );
    const out: SessionInfo[] = [];
    for (const [name, sessions] of lists) {
      for (const s of sessions) {
        if (name === "tmux") {
          const w = this.members.get("tmux")?.tmuxWindowIdOf?.(s.id);
          if (w && hidden.has(w)) continue;
        }
        out.push(withPrefix(name, s));
      }
    }
    return out;
  }

  private async safeListSessions(
    backend: TerminalBackend | undefined,
    name: BackendName,
  ): Promise<SessionInfo[]> {
    if (!backend) return [];
    try {
      return await backend.listSessions();
    } catch (err) {
      this.log.warn("listSessions failed for backend; returning the other backends' sessions", {
        backend: name,
        err: err instanceof Error ? err.name : String(err),
      });
      return [];
    }
  }

  private target(id: string): { backend: TerminalBackend; native: string } {
    const p = splitId(id);
    const backend = p ? this.members.get(p.name) : undefined;
    if (!p || !backend) throw new SessionGone(id);
    return { backend, native: p.native };
  }

  // NB: these must be `async` (not a bare function returning the callee's promise) so that a
  // synchronous throw from `target()` (unknown/gone session) becomes a rejected promise rather
  // than an exception thrown at call time -- callers always get a Promise to `.catch`/`await`.
  async getScreen(id: string): Promise<Screen> {
    const { backend, native } = this.target(id);
    return backend.getScreen(native);
  }
  async getHistory(
    id: string,
    before: number,
    count: number,
  ): Promise<{ lines: Line[]; oldestAvailable: number }> {
    const { backend, native } = this.target(id);
    return backend.getHistory(native, before, count);
  }
  async sendText(id: string, text: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.sendText(native, text);
  }
  async createSession(where: CreateWhere): Promise<string> {
    if (where.kind === "split") {
      const { backend, native } = this.target(where.sessionId);
      return prefixId(
        backend.name,
        await backend.createSession({
          kind: "split",
          sessionId: native,
          direction: where.direction,
        }),
      );
    }
    let windowId: string | undefined;
    if (where.windowId) {
      const p = splitId(where.windowId);
      // spec 8.12: a windowId whose prefix does not match `where.backend` must reach the phone as
      // ack.ok=false, error:"bad-window" -- a typed error, so the Agent can map it exactly. Checked
      // before the backend lookup below so it fires even when `where.backend` isn't registered.
      if (!p || p.name !== where.backend) throw new BadWindow(where.windowId);
      windowId = p.native;
    }
    const backend = this.members.get(where.backend);
    if (!backend) throw new SessionGone(`backend ${where.backend}`);
    return prefixId(
      backend.name,
      await backend.createSession({ kind: "tab", backend: where.backend, windowId }),
    );
  }
  async focus(id: string): Promise<void> {
    const { backend, native } = this.target(id);
    return backend.focus(native);
  }
  /**
   * Spec 8.13: fan the tracker's watched set out to every member, each with its own native ids.
   * Every member is called on every change, including with an empty array -- that is how a backend
   * learns that its last viewer went away and it can stop polling.
   */
  setWatched(ids: string[]): void {
    const byBackend = new Map<BackendName, string[]>();
    for (const name of this.members.keys()) byBackend.set(name, []);
    for (const id of ids) {
      const p = splitId(id);
      if (!p) continue;
      byBackend.get(p.name)?.push(p.native);
    }
    for (const [name, natives] of byBackend) {
      try {
        this.members.get(name)?.setWatched?.(natives);
      } catch (err) {
        this.log.warn("setWatched failed for backend", {
          backend: name,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
  }
  on(handler: (e: BackendEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  private emit(e: BackendEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        this.log.error("backend event handler threw", { err: String(err) });
      }
    }
  }
}

function withPrefix(name: BackendName, s: SessionInfo): SessionInfo {
  return {
    ...s,
    id: prefixId(name, s.id),
    windowId: prefixId(name, s.windowId),
    tabId: prefixId(name, s.tabId),
    backend: name,
  };
}

function prefixEvent(name: BackendName, e: BackendEvent): BackendEvent {
  return "sessionId" in e ? { ...e, sessionId: prefixId(name, e.sessionId) } : e;
}
