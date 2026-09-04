import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import { decodeEnvelope, type Envelope, encodeEnvelope, FRAME_LIMITS } from "../src/envelope.js";

const FP_A = "a".repeat(26);
const FP_B = "b".repeat(26);

describe("cbor codec", () => {
  it("omits undefined properties and round-trips bytes", () => {
    const enc = encodeCbor({ a: 1, b: undefined, c: new Uint8Array([1, 2]) });
    const dec = decodeCbor(enc) as Record<string, unknown>;
    expect(Object.keys(dec)).toEqual(["a", "c"]);
    expect(dec.c).toBeInstanceOf(Uint8Array);
  });
});

describe("envelope", () => {
  it("round-trips an e2e envelope", () => {
    const e: Envelope = {
      v: 1,
      t: "e2e",
      from: FP_A,
      to: FP_B,
      seq: 7,
      body: { n: new Uint8Array(24), c: new Uint8Array([9]) },
    };
    const out = decodeEnvelope(encodeEnvelope(e));
    expect(out.from).toBe(FP_A);
    expect(out.seq).toBe(7);
    expect((out.body as { c: Uint8Array }).c).toEqual(new Uint8Array([9]));
  });
  it("accepts 'relay' as from for ctrl", () => {
    const e: Envelope = {
      v: 1,
      t: "ctrl",
      from: "relay",
      seq: 0,
      body: { type: "presence", agentOnline: true, computerName: null },
    };
    expect(decodeEnvelope(encodeEnvelope(e)).from).toBe("relay");
  });
  it("rejects malformed input", () => {
    expect(() => decodeEnvelope(new Uint8Array([0xff, 0x00]))).toThrow(/malformed/);
    expect(() => decodeEnvelope(encodeCbor({ v: 2 }))).toThrow(/malformed/);
    expect(() =>
      decodeEnvelope(encodeCbor({ v: 1, t: "e2e", from: "short", seq: 0, body: {} })),
    ).toThrow(/malformed/);
  });
  it("exposes the documented frame limits", () => {
    expect(FRAME_LIMITS).toEqual({
      unauth: 4096,
      ctrl: 16384,
      e2eFromPhone: 65536,
      e2eFromAgent: 1048576,
    });
  });
});
