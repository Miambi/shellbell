import {
  derivePairKey,
  type Envelope,
  fingerprint,
  generateIdentity,
  type InnerMessage,
  randomBytes,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { PhoneLink } from "../src/phone-link.js";
import { FakePhone } from "./fakes/fake-phone.js";

const log = createLogger({ stdout: false });

function setup() {
  const mac = generateIdentity();
  const phoneId = generateIdentity();
  const fpC = fingerprint(mac.ed25519.pub);
  const fpP = fingerprint(phoneId.ed25519.pub);
  const code = randomBytes(16);
  const kPair = derivePairKey(mac.x25519.priv, phoneId.x25519.pub, code, fpC, fpP);
  const phone = new FakePhone(
    phoneId,
    fpC,
    derivePairKey(phoneId.x25519.priv, mac.x25519.pub, code, fpC, fpP),
  );
  const sent: Envelope[] = [];
  let transportAccepted = true;
  const link = new PhoneLink({
    phoneFp: fpP,
    connId: "c1",
    name: "iPhone",
    kPair,
    computerFp: fpC,
    send: (e) => {
      sent.push(e);
      return transportAccepted;
    },
    log,
  });
  return {
    link,
    phone,
    sent,
    setTransportAccepted: (accepted: boolean) => {
      transportAccepted = accepted;
    },
  };
}

/** Flips a bit in a sealed envelope's ciphertext so AEAD decryption fails, without touching `n`. */
function corrupt(env: Envelope): Envelope {
  const body = env.body as { n: Uint8Array; c: Uint8Array };
  const c = new Uint8Array(body.c);
  const last = c.length - 1;
  c[last] = (c[last] as number) ^ 0xff;
  return { ...env, body: { n: body.n, c } };
}

describe("PhoneLink", () => {
  it("completes the handshake and exchanges frames both ways", () => {
    const { link, phone, sent } = setup();
    expect(link.handleEnvelope(phone.hello())).toBeNull();
    expect(link.handshaken).toBe(true);
    phone.acceptHello(sent[0] as Envelope);
    const msg: InnerMessage = { type: "subscribe", sessionId: "iterm2:x" };
    expect(link.handleEnvelope(phone.seal(msg))).toEqual(msg);
    expect(link.send({ type: "ack", reqId: "r", ok: true })).toBe(true);
    expect(phone.open(sent[1] as Envelope)).toEqual({ type: "ack", reqId: "r", ok: true });
  });

  it("rejects replayed and out-of-order frames", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const env = phone.seal({ type: "subscribe", sessionId: null });
    expect(link.handleEnvelope(env)).not.toBeNull();
    expect(link.handleEnvelope(env)).toBeNull(); // replay
  });

  it("re-handshake gives a new key so old frames stop decrypting", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const old = phone.seal({ type: "subscribe", sessionId: null });
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[1] as Envelope);
    expect(link.handleEnvelope(old)).toBeNull();
    expect(link.handleEnvelope(phone.seal({ type: "subscribe", sessionId: null }))).not.toBeNull();
  });

  it("returns a cached ack for a duplicate reqId instead of the message", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    const input: InnerMessage = { type: "input.line", reqId: "r1", sessionId: "s", text: "ls" };
    expect(link.handleEnvelope(phone.seal(input))).toEqual(input);
    link.rememberAck("r1", { type: "ack", reqId: "r1", ok: true });
    expect(link.handleEnvelope(phone.seal(input))).toBeNull();
    expect(phone.open(sent[sent.length - 1] as Envelope)).toEqual({
      type: "ack",
      reqId: "r1",
      ok: true,
    });
  });

  it("does not count an unrecognised-but-authentic inner message as a decrypt failure", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);

    // 25 frames that decrypt fine but carry an inner type this agent does not recognise.
    for (let i = 0; i < 25; i++) {
      const unknown = phone.seal({ type: "future.thing", i } as unknown as InnerMessage);
      expect(link.handleEnvelope(unknown)).toBeNull();
    }
    expect(link.broken).toBe(false);

    let broken = 0;
    link.onBroken = () => broken++;
    // If the 25 unrecognised messages above had counted, 20 more decrypt failures would already
    // have broken the link well before this loop finishes.
    for (let i = 0; i < 19; i++) {
      expect(
        link.handleEnvelope(corrupt(phone.seal({ type: "subscribe", sessionId: null }))),
      ).toBeNull();
    }
    expect(link.broken).toBe(false);
    expect(broken).toBe(0);

    expect(
      link.handleEnvelope(corrupt(phone.seal({ type: "subscribe", sessionId: null }))),
    ).toBeNull();
    expect(link.broken).toBe(true);
    expect(broken).toBe(1);
  });

  it("resets the consecutive-failure counter on a decrypt success", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    let broken = 0;
    link.onBroken = () => broken++;

    for (let i = 0; i < 19; i++) {
      expect(
        link.handleEnvelope(corrupt(phone.seal({ type: "subscribe", sessionId: null }))),
      ).toBeNull();
    }
    expect(link.broken).toBe(false);

    expect(link.handleEnvelope(phone.seal({ type: "subscribe", sessionId: null }))).not.toBeNull();

    for (let i = 0; i < 19; i++) {
      expect(
        link.handleEnvelope(corrupt(phone.seal({ type: "subscribe", sessionId: null }))),
      ).toBeNull();
    }
    expect(link.broken).toBe(false);
    expect(broken).toBe(0);
  });

  it("ignores a replayed conn.hello without re-keying the connection", () => {
    const { link, phone, sent } = setup();
    const hello = phone.hello();
    expect(link.handleEnvelope(hello)).toBeNull();
    phone.acceptHello(sent[0] as Envelope);
    const msg: InnerMessage = { type: "subscribe", sessionId: null };
    expect(link.handleEnvelope(phone.seal(msg))).toEqual(msg);

    const sentBefore = sent.length;
    expect(link.handleEnvelope(hello)).toBeNull(); // replayed hello, same n_p
    expect(sent.length).toBe(sentBefore); // no new hello reply: it was not re-keyed
    expect(link.handshaken).toBe(true);

    // the original connection is still alive under the original key
    const msg2: InnerMessage = { type: "subscribe", sessionId: "s2" };
    expect(link.handleEnvelope(phone.seal(msg2))).toEqual(msg2);
  });

  it("resets viewed on re-handshake but not on ordinary frames", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);
    link.viewed = "iterm2:x";
    link.handleEnvelope(phone.seal({ type: "subscribe", sessionId: "iterm2:x" }));
    expect(link.viewed).toBe("iterm2:x");

    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[1] as Envelope);
    expect(link.viewed).toBeNull();
  });

  it("bounds the ack cache to 256 entries with FIFO eviction", () => {
    const { link, phone, sent } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);

    for (let i = 0; i < 257; i++) {
      link.rememberAck(`r${i}`, { type: "ack", reqId: `r${i}`, ok: true });
    }

    // r0 was evicted (the 257th insert pushed the cache over its 256 bound): a duplicate of it
    // is no longer deduped and comes through as a fresh message.
    const dupOfEvicted: InnerMessage = {
      type: "input.line",
      reqId: "r0",
      sessionId: "s",
      text: "ls",
    };
    expect(link.handleEnvelope(phone.seal(dupOfEvicted))).toEqual(dupOfEvicted);

    // r256 is still cached: a duplicate is deduped and its cached ack resent instead.
    const dupOfRecent: InnerMessage = {
      type: "input.line",
      reqId: "r256",
      sessionId: "s",
      text: "ls",
    };
    expect(link.handleEnvelope(phone.seal(dupOfRecent))).toBeNull();
  });

  it("marks itself broken after 20 consecutive failures", () => {
    const { link, phone } = setup();
    let broken = 0;
    link.onBroken = () => broken++;
    for (let i = 0; i < 20; i++)
      link.handleEnvelope({
        ...phone.hello(),
        body: { n: new Uint8Array(24), c: new Uint8Array(20) },
      });
    expect(link.broken).toBe(true);
    expect(broken).toBe(1);
  });

  it("does not send before the handshake", () => {
    const { link } = setup();
    expect(link.send({ type: "ack", reqId: "r", ok: true })).toBe(false);
  });

  it("reports transport refusal without reusing the sealed frame sequence", () => {
    const { link, phone, sent, setTransportAccepted } = setup();
    link.handleEnvelope(phone.hello());
    phone.acceptHello(sent[0] as Envelope);

    setTransportAccepted(false);
    expect(link.send({ type: "ack", reqId: "refused", ok: true })).toBe(false);
    setTransportAccepted(true);
    expect(link.send({ type: "ack", reqId: "accepted", ok: true })).toBe(true);

    const [refused, accepted] = sent.slice(1);
    expect(refused?.seq).toBe(1);
    expect(accepted?.seq).toBe(2);
    expect((accepted?.seq ?? 0) > (refused?.seq ?? 0)).toBe(true);
  });

  it("reports conn.hello overdue after 10 s and stops once a late hello arrives", () => {
    const { link, phone } = setup();
    const t0 = link.openedAt;
    expect(link.helloOverdue(t0 + 9_999)).toBe(false);
    expect(link.helloOverdue(t0 + 10_000)).toBe(true);
    link.dormant = true; // what the agent does after logging once
    expect(link.helloOverdue(t0 + 20_000)).toBe(false); // already reported; not reported twice
    link.handleEnvelope(phone.hello());
    expect(link.handshaken).toBe(true);
    expect(link.dormant).toBe(false);
    expect(link.helloOverdue(t0 + 60_000)).toBe(false);
  });
});
