import { FRAME_LIMITS } from "@shellbell/protocol";

export type SocketState = "unauth" | "agent" | "phone" | "pairing";

export function frameLimitFor(state: SocketState, isCtrl: boolean): number {
  if (state === "unauth") return FRAME_LIMITS.unauth;
  if (isCtrl || state === "pairing") return FRAME_LIMITS.ctrl;
  return state === "agent" ? FRAME_LIMITS.e2eFromAgent : FRAME_LIMITS.e2eFromPhone;
}

// "t" key (0x61 0x74) followed by text(4) "ctrl" (0x64 0x63 0x74 0x72 0x6c)
const CTRL_SIG = [0x61, 0x74, 0x64, 0x63, 0x74, 0x72, 0x6c];

export function peekIsCtrl(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length - CTRL_SIG.length, 64);
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let k = 0; k < CTRL_SIG.length; k++) {
      if (bytes[i + k] !== CTRL_SIG[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export class TokenBucket {
  private tokens: number;
  private last: number | null = null;

  constructor(
    private readonly rate = 60,
    private readonly burst = 200,
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.last !== null && now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    }
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
