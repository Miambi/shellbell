import type {
  BackendName,
  Capabilities,
  CreateWhere,
  Line,
  SessionInfo,
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

export function splitId(id: string): { name: BackendName; native: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const name = id.slice(0, i);
  if (name !== "iterm2" && name !== "tmux") return null;
  return { name, native: id.slice(i + 1) };
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
      absoluteLines: all.every((c) => c.absoluteLines),
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

  connected(): { name: BackendName; capabilities: Capabilities }[] {
    return [...this.members.values()].map((b) => ({ name: b.name, capabilities: b.capabilities }));
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
  }

  async listSessions(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    const iterm = this.members.get("iterm2");
    const tmux = this.members.get("tmux");
    const hidden = iterm?.tmuxWindowIds?.() ?? new Set<string>();
    if (iterm) for (const s of await iterm.listSessions()) out.push(withPrefix("iterm2", s));
    if (tmux) {
      for (const s of await tmux.listSessions()) {
        const w = tmux.tmuxWindowIdOf?.(s.id);
        if (w && hidden.has(w)) continue;
        out.push(withPrefix("tmux", s));
      }
    }
    return out;
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
