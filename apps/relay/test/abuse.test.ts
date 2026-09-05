import { describe, expect, it } from "vitest";
import { agentOnline, connect, TestDevice } from "./helpers.js";

describe("abuse controls", () => {
  it("oversized frame before auth closes with 4413", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    c.sendRaw(new Uint8Array(4097));
    expect((await c.closed).code).toBe(4413);
  });

  it("flooding ctrl frames trips the token bucket with 4429", async () => {
    const mac = new TestDevice("MBP");
    const { agent } = await agentOnline(mac);
    for (let i = 0; i < 260; i++) {
      agent.sendCtrl(mac.fp, { type: "pairing-close" });
    }
    expect((await agent.closed).code).toBe(4429);
  });

  it("unauthenticated socket is closed by the alarm sweep with 4408", async () => {
    const mac = new TestDevice("MBP");
    const c = await connect(mac.fp);
    await c.nextCtrl();
    expect((await c.closed).code).toBe(4408);
  }, 20_000);
});
