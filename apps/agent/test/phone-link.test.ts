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
  const link = new PhoneLink({
    phoneFp: fpP,
    connId: "c1",
    name: "iPhone",
    kPair,
    computerFp: fpC,
    send: (e) => sent.push(e),
    log,
  });
  return { link, phone, sent };
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
