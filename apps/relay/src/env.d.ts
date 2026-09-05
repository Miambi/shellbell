import type { ComputerDO } from "./computer-do.js";

export interface Env {
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  EXPO_ACCESS_TOKEN?: string;
  MIN_FRAME_MS?: string;
}
