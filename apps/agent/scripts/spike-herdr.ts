/*
 * Spike: the Herdr socket API from Node. Run with `pnpm -F shellbell spike:herdr` while a real
 * herdr server is running for this user, ideally with at least one coding agent pane. It writes
 * sanitized fixtures into test/fixtures/ and prints the measurements docs/spike-herdr.md wants.
 *
 * Read-only by default. Set HERDR_SPIKE_KEYS=1 to also probe `pane.send_keys` — that TYPES INTO A
 * REAL PANE, so only do it against a scratch pane you created for the spike.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";
import { HerdrClient, herdrSocketPath, semverAtLeast } from "../src/backends/herdr/client.js";
import { HERDR_KEYS } from "../src/backends/herdr/keys.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: true, verbose: true });
const client = new HerdrClient({ log, requestTimeoutMs: 5000 });
const outDir = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(outDir, { recursive: true });

/** Replace this machine's identity before anything is written to disk. */
function sanitize<T>(value: T): T {
  const home = homedir();
  const user = userInfo().username;
  const text = JSON.stringify(value).split(home).join("/Users/dev").split(user).join("dev");
  return JSON.parse(text) as T;
}

function save(name: string, value: unknown): void {
  const file = join(outDir, name);
  writeFileSync(file, `${JSON.stringify(sanitize(value), null, 2)}\n`);
  console.log("wrote", file);
}

async function timed<T>(label: string, n: number, fn: () => Promise<T>): Promise<T> {
  const times: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? 0;
  console.log(
    `${label}: p50 ${p50.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms (n=${n})`,
  );
  return last as T;
}

/** Research §10.1: prove the server really does read exactly one line per connection. */
function twoRequestsOnOneConnection(path: string): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const socket = netConnect({ path });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "a", method: "ping", params: {} })}\n`);
      socket.write(`${JSON.stringify({ id: "b", method: "ping", params: {} })}\n`);
    });
    socket.on("data", (c) => lines.push(...c.toString().split("\n").filter(Boolean)));
    socket.on("close", () => resolve(lines));
    setTimeout(() => socket.destroy(), 2000);
  });
}

async function main(): Promise<void> {
  const path = herdrSocketPath();
  console.log("socket:", path, "HERDR_SESSION:", process.env.HERDR_SESSION ?? "(unset)");
  // Spike question 1 is blocking: the macOS default (`~/.config/herdr/…`, no
  // `~/Library/Application Support` branch) is read from the Rust source but never observed on a
  // Mac. Say so loudly rather than dying with a bare ENOENT that reads like "herdr isn't running".
  if (!existsSync(path)) {
    console.error(
      `\n!! No socket at ${path}\n` +
        "!! If a herdr server IS running, herdrSocketPath() is WRONG for this platform.\n" +
        '!! Check: ls -l ~/.config/herdr/ "$HOME/Library/Application Support/herdr/"\n' +
        "!! Record the real path as errata (spike question 1) — Task 6's detector and the doctor\n" +
        '!! check will both silently report "not installed" until herdrSocketPath() is fixed.\n' +
        "!! Workaround for the rest of this spike: HERDR_SOCKET_PATH=<real path> pnpm -F shellbell spike:herdr\n",
    );
  }

  const pong = await timed("ping", 5, () =>
    client.request<{ version?: string; protocol?: number }>("ping", {}),
  );
  console.log("version gate:", pong.version, "->", semverAtLeast(pong.version ?? "", [0, 7, 2]));
  save("herdr-ping.json", { id: "sb1", result: pong });

  const snapshot = await timed("session.snapshot", 5, () =>
    client.request<{ snapshot: Record<string, unknown> }>("session.snapshot", {}),
  );
  save("herdr-session-snapshot.json", { id: "sb2", result: snapshot });

  const panes = (snapshot.snapshot.panes ?? []) as {
    pane_id: string;
    terminal_id?: string;
    scroll?: Record<string, unknown>;
  }[];
  console.log(
    "panes:",
    panes.map((p) => `${p.pane_id}/${p.terminal_id ?? "NO terminal_id"}`),
  );
  console.log("scroll on pane 0:", JSON.stringify(panes[0]?.scroll ?? null));
  console.log("layouts:", JSON.stringify(snapshot.snapshot.layouts).slice(0, 400));
  const paneId = panes[0]?.pane_id;
  if (!paneId) throw new Error("no panes: open one in herdr first");

  const visible = await timed("pane.read visible ansi", 20, () =>
    client.request("pane.read", { pane_id: paneId, source: "visible", format: "ansi" }),
  );
  save("herdr-pane-read-visible.json", { id: "sb7", result: visible });
  const text = (visible as { read: { text?: string } }).read.text ?? "";
  // Built from a string, not a regex literal: an ESC char in a `/.../ ` regex trips Biome's
  // noControlCharactersInRegex rule, but we need to match the real CSI escape byte here.
  const csiFinal = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*([A-Za-z])`, "g");
  const escapes = [...text.matchAll(csiFinal)].map((m) => m[1]);
  console.log("escape finals seen (expect only 'm'):", [...new Set(escapes)].join(" "));
  console.log("rows returned:", text.split("\n").length);

  const recent = await timed("pane.read recent ansi 200", 5, () =>
    client.request("pane.read", { pane_id: paneId, source: "recent", format: "ansi", lines: 200 }),
  );
  save("herdr-pane-read-recent.json", { id: "sb8", result: recent });

  const motion = await timed("pane.copy_motion", 20, () =>
    client.request("pane.copy_motion", {
      pane_id: paneId,
      cursor: { row: 0, col: 0 },
      motion: "line_end",
    }),
  );
  save("herdr-copy-motion.json", { id: "sb9", result: motion });

  // Poll cost at scale: the adaptive poller opens one connection per watched pane per tick.
  for (const n of [1, 5, 20]) {
    const targets = panes.slice(0, n).map((p) => p.pane_id);
    if (targets.length < n) break;
    const t0 = performance.now();
    for (const id of targets)
      await client.request("pane.copy_motion", {
        pane_id: id,
        cursor: { row: 0, col: 0 },
        motion: "line_end",
      });
    console.log(`sequential copy_motion x${n}: ${(performance.now() - t0).toFixed(1)} ms total`);
  }

  const two = await twoRequestsOnOneConnection(path);
  console.log("responses to two pipelined requests (expect 1):", two.length);

  if (process.env.HERDR_SPIKE_KEYS === "1") {
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
      const candidate = HERDR_KEYS[name] ?? name.replace(/^ctrl-/, "ctrl+").replace(/-/g, "");
      try {
        await client.request("pane.send_keys", { pane_id: paneId, keys: [candidate] });
        accepted.push(`${name} -> ${candidate}`);
      } catch (err) {
        rejected.push(`${name} -> ${candidate}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`keys accepted:\n  ${accepted.join("\n  ")}`);
    console.log(`keys rejected:\n  ${rejected.join("\n  ")}`);
  }

  console.log("subscribing for 30 s — go make an agent ask you something…");
  let events = 0;
  const stream = await client.subscribe(
    [
      { type: "pane.created" },
      { type: "pane.closed" },
      { type: "pane.updated" },
      { type: "pane.focused" },
      { type: "pane.moved" },
      { type: "layout.updated" },
      ...panes.flatMap((p) => [
        { type: "pane.agent_status_changed", pane_id: p.pane_id },
        { type: "pane.scroll_changed", pane_id: p.pane_id },
      ]),
    ],
    {
      onEvent: (e) => {
        events++;
        console.log("EVENT", e.event, JSON.stringify(e.data).slice(0, 200));
        if (e.event.includes("agent_status_changed"))
          save("herdr-agent-status-event.json", { event: e.event, data: e.data });
      },
      onEnd: (reason) => console.log("stream ended:", reason),
    },
  );
  await new Promise((r) => setTimeout(r, 30_000));
  stream.close();
  console.log(`captured ${events} events`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
