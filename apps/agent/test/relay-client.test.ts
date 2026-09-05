import { fingerprint, generateIdentity } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { RelayClient } from "../src/relay-client.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
let relay: FakeRelay;
const id = generateIdentity();
const fp = fingerprint(id.ed25519.pub);

beforeEach(async () => {
  relay = new FakeRelay(fp);
  await relay.start();
});
afterEach(async () => relay.stop());

describe("RelayClient", () => {
  it("authenticates, receives unpaired+phones, reports online", async () => {
    const c = new RelayClient({
      relayUrl: relay.url,
      fp,
      identity: id,
      name: "MBP",
      appVersion: "t",
      log,
      backoffMinMs: 50,
      backoffMaxMs: 100,
    });
    const ctrl: string[] = [];
    c.on("ctrl", (m) => ctrl.push(m.type));
    c.start();
    await waitFor(() => c.online);
    await waitFor(() => ctrl.includes("phones"));
    expect(ctrl).toEqual(["unpaired", "phones"]);
    c.stop();
  });

  it("reconnects with backoff after the relay drops it", async () => {
    const c = new RelayClient({
      relayUrl: relay.url,
      fp,
      identity: id,
      name: "MBP",
      appVersion: "t",
      log,
      backoffMinMs: 50,
      backoffMaxMs: 100,
    });
    let downs = 0;
    c.on("down", () => downs++);
    c.start();
    await waitFor(() => c.online);
    relay.dropAgent();
    await waitFor(() => downs === 1);
    await waitFor(() => c.online);
    expect(relay.agent).not.toBeNull();
    c.stop();
  });

  it("reports auth-fail bad-sig when the signing key does not match the fp", async () => {
    const other = generateIdentity();
    const c = new RelayClient({
      relayUrl: relay.url,
      fp,
      identity: other,
      name: "MBP",
      appVersion: "t",
      log,
      backoffMinMs: 50,
      backoffMaxMs: 100,
    });
    let reason = "";
    c.on("auth-fail", (r) => (reason = r));
    c.start();
    await waitFor(() => reason !== "");
    expect(reason).toBe("bad-sig");
    c.stop();
  });

  it("forwards ctrl from the relay and sends ctrl to it", async () => {
    const c = new RelayClient({
      relayUrl: relay.url,
      fp,
      identity: id,
      name: "MBP",
      appVersion: "t",
      log,
      backoffMinMs: 50,
      backoffMaxMs: 100,
    });
    c.start();
    await waitFor(() => c.online);
    c.sendCtrl({ type: "pairing-close" });
    expect((await relay.nextCtrlFromAgent()).type).toBe("pairing-close");
    const got: string[] = [];
    c.on("ctrl", (m) => got.push(m.type));
    relay.sendToAgent({ type: "presence", agentOnline: true, computerName: "x" });
    await waitFor(() => got.includes("presence"));
    c.stop();
  });
});
