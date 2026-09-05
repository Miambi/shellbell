import type { EventKind } from "@shellbell/protocol";

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  priority: "high";
  channelId: "rings";
  categoryId: "ring";
}

interface ExpoTicket {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function pushBody(
  kind: EventKind | "prompt" | "idle",
  exitCode?: number,
  durationMs?: number,
): string {
  switch (kind) {
    case "prompt": {
      const exit = exitCode === undefined ? "" : ` — exit ${exitCode}`;
      const dur = durationMs === undefined ? "" : ` after ${formatDuration(durationMs)}`;
      return `A command finished${exit}${dur}`;
    }
    case "idle":
      return "A session went quiet — waiting for you?";
    case "blocked":
      // spec 8.13/11.3: deliberately generic — the relay never learns which agent, which
      // session title, or what it is asking.
      return "An agent is waiting for you";
    default:
      return "A session needs attention";
  }
}

export async function sendExpoPush(
  messages: ExpoMessage[],
  accessToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ deadTokens: string[] }> {
  if (messages.length === 0) return { deadTokens: [] };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    console.warn("expo push http", res.status);
    return { deadTokens: [] };
  }
  const json = (await res.json()) as { data?: ExpoTicket[] };
  const deadTokens: string[] = [];
  (json.data ?? []).forEach((ticket, i) => {
    if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
      const to = messages[i]?.to;
      if (to) deadTokens.push(to);
    } else if (ticket.status === "error") {
      console.warn("expo push ticket error", ticket.details?.error ?? "unknown");
    }
  });
  return { deadTokens };
}
