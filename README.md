# Shellbell

Your terminal rings. You answer.

**[MIT licensed](LICENSE)** · the Shellbell name and logo are a trademark ([`TRADEMARK.md`](TRADEMARK.md)) · free to use

Shellbell mirrors your Mac's terminal sessions to your phone, so you can see and type into
iTerm2, tmux and Herdr panes from anywhere. It rings you the moment a command finishes, a program
goes quiet, or a coding agent is blocked waiting on you, and lets you type straight back. There
are no accounts to create, and everything between your phone and Mac is end-to-end encrypted.

## 60-second setup

1. On the Mac: `npx shellbell`
2. On the phone: install the Shellbell app.
3. Scan the QR the Mac prints.
4. Confirm the pairing request on the Mac.

## See it in action

![demo](docs/demo.gif)
<!-- TODO(before-first-release): record docs/demo.gif -->

## Supported terminals

- **iTerm2** — native support, no configuration.
- **Ghostty, Warp, Terminal.app, Alacritty, Kitty and WezTerm** — via tmux.
- **[Herdr](https://herdr.dev)** coding-agent panes — native support, including the `blocked`
  state when an agent is waiting on you.

## Notifications

- The relay routes a push to your phone; it never sees terminal content, session titles,
  commands or input.
- A push carries only your computer's name, a generic body ("A command finished — exit 0 after
  15s", "A session went quiet — waiting for you?", "An agent is waiting for you"), and enough
  routing data to open the right session — nothing else.
- Everything between your phone and Mac is end-to-end encrypted; the relay cannot read it.

See [`PRIVACY.md`](PRIVACY.md) for the full data-handling story.

## Self-hosting and the protocol

- Don't want to use the author's hosted relay? See [`docs/self-hosting.md`](docs/self-hosting.md).
- Wire protocol reference (generated from the source of truth, the zod schemas): see
  [`docs/protocol.md`](docs/protocol.md).

## Costs

Shellbell is free to use. The author pays for it: an Apple Developer account ($99/yr), a Google
Play Console account ($25 once), and the `shellbell.dev` domain.

## License

MIT — see [`LICENSE`](LICENSE). The Shellbell name and logo are a trademark; see
[`TRADEMARK.md`](TRADEMARK.md).
