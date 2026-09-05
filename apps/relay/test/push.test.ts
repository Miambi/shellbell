import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDuration, pushBody } from "../src/push.js";
import { agentOnline, authenticate, connect, pairPhone, TestDevice } from "./helpers.js";

/**
 * cloudflare:test on this pool (0.22.0) does not export `fetchMock` — it was
 * removed. The main worker and its Durable Objects run in the same isolate
 * as the tests (per the pool's own docs), so we stub the global `fetch`
 * instead. Only requests to the Expo push endpoint are answered; anything
 * else throws, mirroring `disableNetConnect`.
 */
function installFetchStub() {
  const sent: unknown[] = [];
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let reply: unknown = { data: [{ status: "ok" }] };
  const setReply = (r: unknown) => {
    reply = r;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://exp.host/--/api/v2/push/send") {
        throw new Error(`net connect disabled: ${url}`);
      }
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      sent.push(...(JSON.parse(init?.body as string) as unknown[]));
      return Response.json(reply);
    }),
  );
  return { sent, setReply, calls: () => calls.length };
}

afterEach(() => vi.unstubAllGlobals());

async function pairedWithToken(enabled = true) {
  const mac = new TestDevice("MBP");
  const phone = new TestDevice("iPhone");
  const { agent } = await agentOnline(mac);
  await pairPhone(mac, agent, phone);
  const p = await connect(mac.fp);
  await authenticate(p, phone, "phone");
  await agent.nextCtrl();
  p.sendCtrl(phone.fp, {
    type: "push-token",
    token: "ExponentPushToken[abc]",
    platform: "ios",
    enabled,
  });
  await new Promise((r) => setTimeout(r, 20));
  return { mac, phone, agent, p };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

describe("push text", () => {
  it("formats durations and bodies", () => {
    expect(formatDuration(43_000)).toBe("43s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(pushBody("prompt", 0, 43_000)).toBe("A command finished — exit 0 after 43s");
    expect(pushBody("idle")).toBe("A session went quiet — waiting for you?");
  });
});

describe("notify → push", () => {
  it("does not push while the phone holds a lease; pushes after lease 0 + close", async () => {
    const { sent, calls } = installFetchStub();
    const { mac, agent, p, phone } = await pairedWithToken();
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 60_000 });
    await settle();
    agent.sendCtrl(mac.fp, {
      type: "notify",
      sessionId: "s1",
      kind: "prompt",
      exitCode: 0,
      durationMs: 43_000,
    });
    await settle();
    expect(calls()).toBe(0);
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 0 });
    p.ws.close();
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s2", kind: "idle", durationMs: 5000 });
    await settle();
    expect(sent).toEqual([
      {
        to: "ExponentPushToken[abc]",
        title: "MBP",
        body: "A session went quiet — waiting for you?",
        data: { computerFp: mac.fp, sessionId: "s2", kind: "idle" },
        sound: "default",
        priority: "high",
        channelId: "rings",
        categoryId: "ring",
      },
    ]);
    agent.ws.close();
  });

  it("a connected phone with an expired lease is pushed", async () => {
    const { calls } = installFetchStub();
    const { mac, agent, p, phone } = await pairedWithToken();
    p.sendCtrl(phone.fp, { type: "lease", ttlMs: 1 });
    await settle();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    await settle();
    expect(calls()).toBe(1);
    agent.ws.close();
    p.ws.close();
  });

  it("push disabled for the pairing → never pushed", async () => {
    const { calls } = installFetchStub();
    const { mac, agent, p } = await pairedWithToken(false);
    p.ws.close();
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    await settle();
    expect(calls()).toBe(0);
    agent.ws.close();
  });

  it("rate-limits one ring per session per 60s", async () => {
    const { calls } = installFetchStub();
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s", kind: "idle" });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "t", kind: "idle" });
    await settle();
    expect(calls()).toBe(2);
    agent.ws.close();
  });

  it("clears a token Expo reports as DeviceNotRegistered", async () => {
    const { calls, setReply } = installFetchStub();
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    setReply({
      data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }],
    });
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s1", kind: "idle" });
    await settle();
    agent.sendCtrl(mac.fp, { type: "notify", sessionId: "s2", kind: "idle" });
    await settle();
    expect(calls()).toBe(1);
    agent.ws.close();
  });

  it("caps pushes at 20 per phone per rolling hour", async () => {
    const { calls } = installFetchStub();
    const { mac, agent, p } = await pairedWithToken();
    p.ws.close();
    await agent.nextCtrl();
    for (let i = 0; i <= 20; i++) {
      agent.sendCtrl(mac.fp, { type: "notify", sessionId: `s${i}`, kind: "idle" });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(calls()).toBe(20);
    agent.ws.close();
  });
});
