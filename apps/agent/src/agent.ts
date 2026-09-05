import {
  bytesForKey,
  type CtrlMessage,
  type Envelope,
  fromBase64Url,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
  type SessionInfo,
} from "@shellbell/protocol";
import type { BackendRegistry } from "./backends/registry.js";
import { type BackendEvent, BadWindow, SessionGone, Unsupported } from "./backends/types.js";
import {
  type AgentConfig,
  loadPairings,
  type Pairing,
  type Paths,
  savePairings,
} from "./config.js";
import { EventEngine } from "./events.js";
import type { Logger } from "./log.js";
import { Notifier } from "./notifier.js";
import { PairingManager } from "./pairing.js";
import { PhoneLink } from "./phone-link.js";
import { RelayClient } from "./relay-client.js";
import { ScreenTracker } from "./screen-tracker.js";

export interface AgentOptions {
  paths: Paths;
  config: AgentConfig;
  identity: Identity;
  fp: string;
  registry: BackendRegistry;
  log: Logger;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  appVersion: string;
  relay?: RelayClient;
  relayUrlOverride?: string;
}

export class Agent {
  readonly relay: RelayClient;
  readonly tracker: ScreenTracker;
  readonly events: EventEngine;
  readonly notifier: Notifier;
  readonly pairing: PairingManager;
  /** Keyed by relay connId (spec 6.6/8.7/12): a stale socket can never be confused with the live one. */
  private links = new Map<string, PhoneLink>();
  /** phoneFp -> connId of that phone's live socket; e2e envelopes only carry the fp. */
  private connByFp = new Map<string, string>();
  private pairings: Pairing[];
  private sessions: SessionInfo[] = [];
  private tick: NodeJS.Timeout | null = null;
  private sessionsDebounce: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(private readonly o: AgentOptions) {
    this.log = o.log.child({ unit: "agent" });
    this.pairings = loadPairings(o.paths);
    // `relayUrlOverride` (test-only) redirects where the agent's own socket connects, without
    // changing the relay URL the pairing QR advertises to phones -- PairingManager always uses
    // `o.config.relayUrl` below, since that is the address a real phone will actually dial.
    const socketUrl = o.relayUrlOverride ?? o.config.relayUrl;
    this.relay =
      o.relay ??
      new RelayClient({
        relayUrl: socketUrl,
        fp: o.fp,
        identity: o.identity,
        name: o.config.computerName,
        appVersion: o.appVersion,
        log: o.log,
      });
    this.tracker = new ScreenTracker({
      backend: o.registry,
      sink: (conn, msg) => this.sendTo(conn, msg),
      log: o.log,
      // The tracker discovered (via a failing getScreen) that a session is truly gone; refresh and
      // broadcast `sessions` the same way any other layout change does.
      onSessionGone: () => this.scheduleSessions(),
    });
    this.events = new EventEngine({
      notifyMinCommandMs: o.config.notifyMinCommandMs,
      idleQuietMs: o.config.idleQuietMs,
      idleMinActiveMs: o.config.idleMinActiveMs,
    });
    this.notifier = new Notifier((m) => this.relay.sendCtrl(m), o.log);
    this.pairing = new PairingManager({
      identity: o.identity,
      fp: o.fp,
      computerName: o.config.computerName,
      accent: o.config.accent,
      relayUrl: o.config.relayUrl,
      sendCtrl: (m) => this.relay.sendCtrl(m),
      savePairing: (p) => this.addPairing(p),
      confirm: o.confirm,
      pairingCount: () => this.pairings.length,
      log: o.log,
    });
    this.relay.on("auth-ok", (m) => {
      // spec 4.2/8.6: the relay advertises its minimum frame interval; the flush loop must honour it.
      this.tracker.setIntervalMs(Math.max(125, m.minFrameMs));
    });
    this.relay.on("ctrl", (m) => void this.onCtrl(m));
    this.relay.on("e2e", (env) => this.onE2E(env));
    this.relay.on("down", () => {
      for (const connId of this.links.keys()) this.tracker.dropViewer(connId);
      this.links.clear();
      this.connByFp.clear();
    });
    // spec: the relay closed us with 4005 (superseded by a newer agent) -- there is no reconnect
    // coming (RelayClient itself stops retrying), so just log it; `down` above already tore down
    // the phone links.
    this.relay.on("superseded", () => {
      this.log.warn("relay connection superseded by a newer agent instance; not reconnecting");
    });
    o.registry.on((e) => this.onBackendEvent(e));
    this.events.on("event", (ev) => this.broadcast(ev));
    this.events.on("ring", (r) => this.notifier.ring(r));
  }

  // ---- lifecycle ----

  start(): void {
    this.relay.start();
    this.tracker.start();
    this.tick = setInterval(() => {
      this.events.tick();
      this.pairing.tick();
      this.sweepHandshakes();
    }, 1000);
    void this.refreshSessions();
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.sessionsDebounce) clearTimeout(this.sessionsDebounce);
    this.sessionsDebounce = null;
    this.tracker.stop();
    this.relay.stop();
  }

  /**
   * spec 6.6: a phone must send conn.hello within 10 s of connecting. We do not close the socket
   * (the relay owns it) — we log once and leave the link dormant until a hello actually arrives.
   */
  private sweepHandshakes(): void {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (!link.helloOverdue(now)) continue;
      link.dormant = true;
      this.log.warn("no conn.hello within 10s; ignoring this link until one arrives", {
        phone: link.phoneFp.slice(0, 8),
        conn: link.connId.slice(0, 6),
      });
    }
  }

  get relayOnline(): boolean {
    return this.relay.online;
  }
  get pairingList(): Pairing[] {
    return this.pairings;
  }
  get sessionList(): SessionInfo[] {
    return this.sessions;
  }
  get connectedPhones(): { phoneFp: string; name: string; viewed: string | null }[] {
    return [...this.links.values()].map((l) => ({
      phoneFp: l.phoneFp,
      name: l.name,
      viewed: l.viewed,
    }));
  }

  /** Test seam: the live link for a phone fp, or undefined. */
  linkForPhone(phoneFp: string): PhoneLink | undefined {
    const connId = this.connByFp.get(phoneFp);
    return connId ? this.links.get(connId) : undefined;
  }

  openPairing(): { qrText: string; expiresAt: number } {
    return this.pairing.openWindow();
  }
  closePairing(): void {
    this.pairing.closeWindow();
  }

  unpair(fpOrName: string): boolean {
    const p = this.pairings.find((x) => x.phoneFp.startsWith(fpOrName) || x.name === fpOrName);
    if (!p) return false;
    this.pairings = this.pairings.filter((x) => x !== p);
    savePairings(this.o.paths, this.pairings);
    this.relay.sendCtrl({ type: "unpair", phoneFp: p.phoneFp });
    this.dropLinkFor(p.phoneFp);
    return true;
  }

  private dropLinkFor(phoneFp: string): void {
    const connId = this.connByFp.get(phoneFp);
    if (connId === undefined) return;
    this.tracker.dropViewer(connId);
    this.links.delete(connId);
    this.connByFp.delete(phoneFp);
  }

  private addPairing(p: Pairing): void {
    this.pairings = [...this.pairings.filter((x) => x.phoneFp !== p.phoneFp), p];
    savePairings(this.o.paths, this.pairings);
  }

  /** Local-only removal, for an `unpair` the relay has already applied. */
  private forgetPairing(phoneFp: string): void {
    const before = this.pairings.length;
    this.pairings = this.pairings.filter((x) => x.phoneFp !== phoneFp);
    if (this.pairings.length !== before) savePairings(this.o.paths, this.pairings);
    this.dropLinkFor(phoneFp);
  }

  // ---- relay ctrl ----

  private async onCtrl(m: CtrlMessage): Promise<void> {
    switch (m.type) {
      case "unpaired": {
        if (m.phoneFps.length) {
          this.pairings = this.pairings.filter((p) => !m.phoneFps.includes(p.phoneFp));
          savePairings(this.o.paths, this.pairings);
          for (const fp of m.phoneFps) this.dropLinkFor(fp);
          this.log.info("applied unpair tombstones", { count: m.phoneFps.length });
        }
        // Order is the contract: the relay clears every tombstone when it handles pairings-sync,
        // so the tombstones MUST already be applied to `this.pairings` before this send.
        this.relay.sendCtrl({
          type: "pairings-sync",
          phones: this.pairings.slice(0, 10).map((p) => ({
            phoneFp: p.phoneFp,
            ed25519Pub: fromBase64Url(p.ed25519Pub),
            name: p.name,
          })),
        });
        return;
      }
      case "phones":
        for (const p of m.connected) this.attach(p.phoneFp, p.connId, p.name);
        return;
      case "phone-connected":
        this.attach(m.phoneFp, m.connId, m.name);
        return;
      case "phone-disconnected": {
        // Remove by connId: a superseded socket's disconnect must not evict the live one.
        const link = this.links.get(m.connId);
        if (!link) return;
        this.tracker.dropViewer(m.connId);
        this.links.delete(m.connId);
        if (this.connByFp.get(link.phoneFp) === m.connId) this.connByFp.delete(link.phoneFp);
        return;
      }
      case "pairing-request":
        await this.pairing.handleRequest(m);
        return;
      case "unpair":
        // The relay already removed its row before forwarding this; just drop our local state.
        // Do NOT call unpair(), which would echo a redundant `unpair` back to the relay.
        this.forgetPairing(m.phoneFp);
        return;
      case "error":
        this.log.warn("relay error", { code: m.code, message: m.message });
        return;
      default:
        return;
    }
  }

  private attach(phoneFp: string, connId: string, name: string): void {
    const pairing = this.pairings.find((p) => p.phoneFp === phoneFp);
    if (!pairing) {
      this.log.warn("relay announced an unknown phone; ignoring", { phone: phoneFp.slice(0, 8) });
      return;
    }
    this.dropLinkFor(phoneFp); // the relay superseded any older socket for this phone (4005)
    const link = new PhoneLink({
      phoneFp,
      connId,
      name,
      kPair: fromBase64Url(pairing.kPair),
      computerFp: this.o.fp,
      send: (env) => this.relay.sendEnvelope(env),
      log: this.o.log,
    });
    link.onBroken = () => {
      this.tracker.dropViewer(connId);
      if (this.links.get(connId) === link) {
        this.links.delete(connId);
        if (this.connByFp.get(phoneFp) === connId) this.connByFp.delete(phoneFp);
      }
    };
    this.links.set(connId, link);
    this.connByFp.set(phoneFp, connId);
    pairing.lastSeenAt = new Date().toISOString();
    savePairings(this.o.paths, this.pairings);
  }

  // ---- e2e ----

  private onE2E(env: Envelope): void {
    // Envelopes carry the phone's fp, so resolve the live connId through the side index.
    const connId = this.connByFp.get(env.from);
    const link = connId === undefined ? undefined : this.links.get(connId);
    if (!link) return;
    const wasHandshaken = link.handshaken;
    const msg = link.handleEnvelope(env);
    if (!wasHandshaken && link.handshaken) {
      link.send({
        type: "hello",
        agentVersion: this.o.appVersion,
        backends: this.o.registry.connected(),
        computerName: this.o.config.computerName,
        accent: this.o.config.accent,
      });
      link.send({ type: "sessions", list: this.sessions });
    }
    if (msg) void this.onInner(link, msg);
  }

  private async onInner(link: PhoneLink, msg: InnerMessage): Promise<void> {
    const ack = (
      reqId: string,
      ok: boolean,
      extra: { error?: string; sessionId?: string } = {},
    ) => {
      const a: InnerMessageOf<"ack"> = { type: "ack", reqId, ok, ...extra };
      link.rememberAck(reqId, a);
      link.send(a);
    };
    const reg = this.o.registry;
    try {
      switch (msg.type) {
        case "subscribe":
          link.viewed = msg.sessionId;
          this.tracker.setViewed(link.connId, msg.sessionId);
          return;
        case "input.line":
          this.log.info("input", { kind: "line", len: msg.text.length });
          await reg.sendText(msg.sessionId, `${msg.text}\r`);
          return ack(msg.reqId, true);
        case "input.text":
          this.log.info("input", { kind: "text", len: msg.text.length });
          await reg.sendText(msg.sessionId, msg.text);
          return ack(msg.reqId, true);
        case "input.key":
          await reg.sendText(msg.sessionId, bytesForKey(msg.key));
          return ack(msg.reqId, true);
        case "history.get": {
          const h = await reg.getHistory(msg.sessionId, msg.before, msg.count);
          link.send({
            type: "history",
            sessionId: msg.sessionId,
            before: msg.before,
            lines: h.lines.slice(-200),
            oldestAvailable: h.oldestAvailable,
          });
          return ack(msg.reqId, true);
        }
        case "session.create": {
          const id = await reg.createSession(msg.in);
          void this.refreshSessions();
          return ack(msg.reqId, true, { sessionId: id });
        }
        case "session.focus":
          if (!reg.capabilitiesOf(msg.sessionId)?.focus)
            return ack(msg.reqId, false, { error: "unsupported" });
          await reg.focus(msg.sessionId);
          return ack(msg.reqId, true);
        case "snapshot.get":
          this.tracker.forceSnapshot(link.connId, msg.sessionId);
          return ack(msg.reqId, true);
        default:
          return;
      }
    } catch (err) {
      const reqId = "reqId" in msg ? msg.reqId : null;
      // spec 8.12: a mismatched windowId must reach the phone as error:"bad-window", not "failed".
      const error =
        err instanceof SessionGone
          ? "session-gone"
          : err instanceof Unsupported
            ? "unsupported"
            : err instanceof BadWindow
              ? "bad-window"
              : "failed";
      this.log.warn("inner message failed", { type: msg.type, error, err: String(err) });
      if (reqId) ack(reqId, false, { error });
    }
  }

  private sendTo(connId: string, msg: InnerMessage): void {
    this.links.get(connId)?.send(msg);
  }

  private broadcast(msg: InnerMessage): void {
    for (const l of this.links.values()) l.send(msg);
  }

  // ---- backend ----

  private onBackendEvent(e: BackendEvent): void {
    this.events.onBackendEvent(e);
    // NB: the ScreenTracker subscribes to the registry itself (Task 7) and owns `markDirty` /
    // `sessionRemoved`. Do not mirror those calls here.
    switch (e.type) {
      case "screen-changed":
        return;
      case "session-removed":
        // The notifier's rate-limit state and the event engine's per-session prompt state must not
        // leak forever once a session is gone (events.onBackendEvent already dropped its own state
        // above for "session-removed", but forget() is idempotent -- call it explicitly here too so
        // the contract holds even if that internal handling ever changes).
        this.notifier.forget(e.sessionId);
        this.events.forget(e.sessionId);
        this.scheduleSessions();
        return;
      case "layout-changed":
      case "session-added":
      case "focus-changed":
      case "title-changed":
        this.scheduleSessions();
        return;
      default:
        return;
    }
  }

  private scheduleSessions(): void {
    if (this.sessionsDebounce) return;
    this.sessionsDebounce = setTimeout(() => {
      this.sessionsDebounce = null;
      void this.refreshSessions();
    }, 100);
  }

  private async refreshSessions(): Promise<void> {
    try {
      const list = await this.o.registry.listSessions();
      this.sessions = list.map((s) => ({ ...s, state: this.events.stateOf(s.id) }));
      this.broadcast({ type: "sessions", list: this.sessions });
    } catch (err) {
      this.log.warn("listSessions failed", { err: String(err) });
    }
  }
}
