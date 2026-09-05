# shellbell

Your terminal rings. You answer. — Mac agent for [Shellbell](https://github.com/Miambi/shellbell).

    npx shellbell            # start, print a QR, scan it with the Shellbell app
    shellbell pair           # open a new pairing window
    shellbell status | devices | unpair <phone> | doctor
    npm i -g shellbell && shellbell service install   # run at login

Requires macOS, Node 22+, and iTerm2 with the Python API enabled (Settings → General →
Magic). tmux and Herdr backends are planned. Everything between your phone and this agent
is end-to-end encrypted; the relay only routes ciphertext.
