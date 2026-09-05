import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

/**
 * Spec 8.13 "Input": Herdr validates every key name **before** writing any bytes, so a single
 * unknown name fails the whole `pane.send_keys` call. This table therefore contains only names the
 * research verified against Herdr's documented grammar. `delete`, `home`, `end`, `page-up`,
 * `page-down` and `ctrl-space` are deliberately absent — they are not in that grammar, so they go
 * out as their raw bytes through `pane.send_text`, which needs no key parsing at all. Task 7's
 * spike round-trips every name and Task 8 records the deltas here.
 */
export const HERDR_KEYS: Partial<Record<NamedKey, string>> = buildHerdrKeys();

function buildHerdrKeys(): Partial<Record<NamedKey, string>> {
  const out: Partial<Record<NamedKey, string>> = {
    enter: "enter",
    tab: "tab",
    "shift-tab": "shift+tab",
    esc: "esc",
    backspace: "backspace",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
  };
  for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
    if (/^ctrl-[a-z]$/.test(name)) out[name] = `ctrl+${name.slice(5)}`;
    else if (/^f([1-9]|1[0-2])$/.test(name)) out[name] = name;
  }
  return out;
}

/**
 * Reverse map: the exact byte string the agent hands `sendText` -> a Herdr key name.
 * `\r` (Enter), `\n` (also Enter — herdr has no separate name) and `\t` (Tab) are here on purpose:
 * `pane.send_text` writes literal bytes and does **not** submit, so a line typed on the phone would
 * never be executed if its trailing CR went through as text. They are inserted first, so the
 * `ctrl-m`/`ctrl-j`/`ctrl-i` aliases that share those bytes never claim them.
 */
const BYTES_TO_HERDR = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>([
    ["\r", "enter"],
    ["\n", "enter"],
    ["\t", "tab"],
  ]);
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    const herdr = HERDR_KEYS[name];
    if (herdr && !out.has(bytes)) out.set(bytes, herdr);
  }
  return out;
}

export function herdrKeyForBytes(text: string): string | undefined {
  return BYTES_TO_HERDR.get(text);
}
