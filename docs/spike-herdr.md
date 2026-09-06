# Herdr socket spike — 2026-09-06

Run by Bilal (twice) with `pnpm -F shellbell spike:herdr` against a live `herdr` 0.8.2 on macOS,
one workspace, one plain shell pane; plus one controller-run scratch-tab probe (own tab via
`tab.create`, closed afterwards) that sent three `printf` lines and watched `pane.updated`.

| Q | Result |
|---|---|
| Q1 socket | `~/.config/herdr/herdr.sock` exists; `-client.sock` sibling exists; `HERDR_SESSION` unset |
| Q2 ping | `version 0.8.2`, `protocol 20` (the synthetic fixture said 22), capabilities `{live_handoff, detached_server_daemon}`; semver gate passes |
| Q3 pipelining | two requests on one connection → 1 response (one request per connection confirmed) |
| Q4 latency | ping p50 105 ms, `session.snapshot` 104 ms, `pane.read visible ansi` 105 ms (n=20, max 106), `pane.read recent 200` 106 ms — every call costs one ~100 ms server tick |
| Q5 pane.read | CSI finals seen: only `m`; rows returned are **trimmed to the last non-blank row** (37 of a 51-row viewport on a half-full pane, 1 on a fresh prompt, 51 on a full one) — pad client-side |
| Q6 terminal_id | every pane carries one (`term_…`) |
| Q7 layout | rect fields `x, y, width, height` in cells (`187×51` for a full-width pane) |
| Q8 scroll | `pane.get` returns `scroll {offset_from_bottom, max_offset_from_bottom, viewport_rows}`; no `pane.scroll_changed` event fired in a non-scrolling pane |
| Q9 revision | **`pane.copy_motion` does not exist** — `invalid_request: unknown variant`. Instead `pane.updated` events carry `pane.revision`: 1 → 2,3 → 4,5 → 6,7 across three shell commands (output + prompt each), first event ≤ 110 ms after `pane.send_text`, zero events during 6 s idle; `pane.get` reports the same `revision` (7) |
| Q10 agent state | second run (2026-09-06 19:23, `claude` started in a Herdr pane): `pane.agent_status_changed` **does** fire, dotted name, payload `{agent: "claude", agent_status: "working", pane_id, workspace_id}` — no `display_agent`, `title` or `state_labels`; the same transition also appears in the next `pane_updated` (`agent`, `agent_status`), ~600 ms later. `pane_updated` additionally showed `agent: "claude"` with `agent_status: "unknown"` while the agent was starting, then `idle`, then back to `unknown` (no `agent`) when it exited. Only `working` was observed; `blocked` was not reached inside the 30 s window |
| Q11 keys | not probed (`HERDR_SPIKE_KEYS` unset); `pane.send_text` with a trailing `\n` executed the line |
| Q12 restart | not exercised |
| Q13 sanitization | fixtures rewritten with `/Users/dev`, `dev`, `<host>` |

Method list the server accepts (from the error text): `ping server.stop server.live_handoff
server.reload_config server.agent_manifests server.reload_agent_manifests notification.show
client.window_title.set client.window_title.clear session.snapshot workspace.* worktree.* tab.*
agent.list agent.get agent.read agent.explain agent.send_keys agent.rename agent.view.set
agent.view.clear agent.focus agent.start agent.prompt agent.wait pane.split pane.swap pane.move
pane.zoom pane.layout pane.process_info layout.export layout.apply layout.set_split_ratio
pane.neighbor pane.edges pane.focus_direction pane.resize pane.list pane.current pane.get pane.focus
pane.input.set pane.rename pane.send_text pane.send_keys pane.send_input pane.read pane.graphics.*
pane.report_agent pane.report_agent_session pane.report_metadata pane.clear_agent_authority
pane.release_agent pane.close popup.close events.subscribe events.wait pane.wait_for_output
integration.* plugin.*`.

`pane_updated` payload (sanitized):

```json
{"type":"pane_updated","pane":{"pane_id":"w1:p2","terminal_id":"term_65ad2d30a3f482","workspace_id":"w1","tab_id":"w1:t2","focused":false,"cwd":"/Users/dev","foreground_cwd":"/Users/dev","terminal_title":"dev@<host>:~","terminal_title_stripped":"dev@<host>:~","agent_status":"unknown","revision":2,"scroll":{"offset_from_bottom":0,"max_offset_from_bottom":0,"viewport_rows":51}}}
```

Second-run note: the spike rewrites every fixture, and a run from a pane whose `cwd` is a private repo leaks that path into `session.snapshot`/`pane.read` fixtures (sanitize only masks `$HOME`, the user and the host) — review `git diff` before adopting; the 19:23 run was discarded except for the agent-status event.

Consequence: spec §8.13 "Change detection" was rewritten; the copy_motion poller is removed in favour
of `pane_updated.revision` (Plan 04b Task 8, revised).

## Third run (2026-09-06 19:24) — subscription replay

Two spikes started ~40 s apart received the **same first ~25 events** with identical relative
timestamps (+106 ms … +2407 ms): `pane_created w1:p2` (revision 0), `pane_updated w1:p1` revisions
1→8 (including the `agent: claude` idle→unknown transitions from an earlier claude session), the
historic `cwd` walk of `w2:p1`, and a `pane.agent_status_changed working` that had happened minutes
before. Conclusion: `events.subscribe` replays a bounded recent-event backlog at 100 ms cadence after
the ack, then goes live. Only `pane_updated` carries an ordering signal (`revision`). Live events
followed: `pane.agent_status_changed idle` at +6.9 s when claude finished. `ping` p50 was 0.9 ms this
time (max 106 ms): latency depends on where in the server's 100 ms tick a request lands.
