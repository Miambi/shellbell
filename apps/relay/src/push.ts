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

export function pushBody(_kind: EventKind, _exitCode?: number, _durationMs?: number): string {
  return "";
}

export async function sendExpoPush(
  _m: ExpoMessage[],
  _t: string | undefined,
): Promise<{ deadTokens: string[] }> {
  return { deadTokens: [] };
}
