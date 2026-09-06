# shellbell

Your terminal rings. You answer. — Mac agent for [Shellbell](https://github.com/Miambi/shellbell).

    npx shellbell            # start, print a QR, scan it with the Shellbell app
    shellbell pair           # open a new pairing window
    shellbell status | devices | unpair <phone> | doctor
    npm i -g shellbell && shellbell service install   # run at login

Requires macOS and Node 22+. Mirrors iTerm2, tmux (so Ghostty, Warp, Terminal.app, Alacritty,
Kitty and WezTerm work too) and [Herdr](https://herdr.dev) coding-agent panes, all shipped today.
iTerm2's Python API (Settings → General → Magic) is only required for the native iTerm2 backend;
tmux and Herdr need no extra setup. Everything between your phone and this agent is end-to-end
encrypted; the relay only routes ciphertext.
