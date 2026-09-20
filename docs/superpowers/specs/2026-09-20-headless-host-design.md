# Headless hosts and native macOS control — product architecture

Date: 2026-09-20. Status: written design for user review; not implemented.

## Approved direction and scope

Source: Bilal's service-audit follow-up in this conversation:

- Address the service audit findings.
- Provide a native macOS installation and small Shellbell menu-bar icon.
- Keep the agent independent of the menu-bar app: quitting the UI must not stop
  remote access; an explicit service-stop action must.
- Support headless Linux hosts, including suitable AWS and DGX installations.
- Use **one agent identity per computer, per OS user**, not one privileged agent
  for the entire physical machine.

These decisions expand the earlier design's macOS-only host scope and the
previous deferral of a native Mac app. They do not mean those features exist yet.
This document defines the shared architecture and delivery boundaries; each new
subsystem needs its detailed implementation design before coding it. The first
bounded delivery is [service hardening](2026-09-20-service-hardening-design.md).

## Architecture and alternatives

Keep the existing TypeScript agent as the headless engine. CLI commands and an
optional native macOS controller operate the same user's agent through a local
control protocol. Platform service managers own its lifetime.

```text
one machine
  Alice's OS account
    agent identity A → Alice's terminal backends → relay object A
    CLI / optional Mac controller → Alice's local control socket
  Bob's OS account
    agent identity B → Bob's terminal backends → relay object B
    CLI / optional Mac controller → Bob's local control socket
```

Alternatives considered:

| Approach | Decision |
|---|---|
| Shared headless engine + platform lifecycle adapters + optional native controller | Selected direction: preserve backend/crypto behavior; no desktop dependency on servers |
| One root machine daemon multiplexing every user's terminals | Rejected: unnecessary privilege and a new cross-user authorization boundary |
| Rewrite the agent in Swift or embed it only inside a GUI process | Rejected: loses the shared Linux engine or couples remote access to UI lifetime |

The relay remains a separate Cloudflare deployment. Installing an agent on an
EC2 instance does not move the relay there. No inbound Shellbell TCP listener,
SSH transport, cloud account integration or GPU SDK is required for terminal
mirroring. Both endpoints continue to connect outbound to the configured relay.

### Privacy, free tier and streaming requirements

(Design addition, 2026-09-20, source: Bilal's subsequent privacy/cost/streaming
discussion.) Retain the current E2E relay transport for this delivery; do not
describe it as a direct network connection. Terminal bytes transit the relay as
ciphertext, but must not be archived there. Keep metadata minimal and review
existing device names, push metadata and platform logging separately; neither
chunking nor a native installer removes those records automatically.

Cloudflare Workers Free is the hosting constraint. Do not enable paid features
or upgrade the account without approval. Capacity must be measured across the
notify/open/check/respond/leave workload, not equated with an unlimited number
of concurrent viewers. Use aggregate, content-free instrumentation.

The [bounded streaming design](2026-09-20-bounded-terminal-streaming-design.md)
defines viewport-first delivery, incremental updates, lazy byte-bounded history,
chunking, backpressure, cancellation and bounded client memory. It is a separate
protocol/agent/client delivery following the basic service fixes.

## Identity, tenancy and security

The wire identifier remains the existing random cryptographic identity's
fingerprint. Do not replace it with a hostname, username, cloud instance ID or
hardware identifier, and do not introduce a machine-wide account service.
Existing wire fields such as `computerFp` can remain for compatibility: they
refer to an agent installation, not ownership of an entire physical computer.

Each computer/user boundary owns its own identity, pairings, configuration,
logs, local IPC endpoint and process lock. A phone may pair separately with
several such identities, including multiple users on one machine. Friendly
labels can be `DGX · Alice` and `DGX · Bob`; these are editable metadata visible
to the relay, not authorization keys. Existing labels must not change silently.

Service code runs without root. The supported backend discovery boundary is the
current OS account; do not enumerate other users' tmux servers or use privilege
escalation to attach to them. Validate state/control endpoint ownership and reject
unsafe cross-user paths instead of fixing their permissions blindly. A paired
client has the host account's terminal authority; this is not a sandbox against
commands that account can already execute. Root/admin compromise and deliberate
credential sharing remain outside the isolation guarantee.

### Shared homes, migration and image cloning

Per-user home storage alone is insufficient when a home is mounted on several
servers. Linux storage must have an explicit host scope, and local IPC/process
locks must reside on local storage, not an NFS-mounted home. A detailed state
layout/migration design is a gate for Linux implementation, with these invariants:

1. The same user on different computers gets different agent keys and pairings.
2. Restart, hostname rename and upgrade on the same installation preserve keys.
3. Existing Mac installations preserve their identity and pairings; no automatic
   destructive reset or ambiguous shared-home migration is allowed.
4. Any OS machine identifier used locally to select a namespace is not the wire
   identity and is not sent to the relay or logged as a public identifier.
5. An ambiguous legacy identity or copied state requires an explicit adoption/new
   identity decision. Do not silently reuse credentials in two active hosts.
6. Golden images must contain no generated Shellbell identities/pairings. Agent
   provisioning happens on the resulting instance, not in the image template.

Detection cannot guarantee distinguishing an exact VM clone with copied keys and
identical OS identifiers. Document that boundary and require reprovisioning; do
not claim automatic clone isolation. This is consistent with systemd's
[guidance for safely building images](https://systemd.io/BUILDING_IMAGES/).

## Lifecycle contract

Installing software, enabling a service, starting it, and opening its controller
are distinct actions. Merely installing or opening a settings window must not
silently authorize persistent remote terminal access.

| Action | Required result |
|---|---|
| First setup | Explain terminal access; choose whether to enable the service/autostart |
| Start Service | Start this user's agent, show actual readiness or actionable failure |
| Stop Service | Stop this agent intentionally; no immediate KeepAlive/restart loop |
| Restart Service | Controlled stop/start with bounded waits; preserve identity/pairings |
| Quit menu-bar app | Close only the UI; agent remains available |
| Reopen menu-bar app | Attach to the existing agent, never create a duplicate |
| Uninstall service | Stop/unregister only this user's service; preserve keys unless explicitly erased |

The next platform designs must specify whether a manual stop persists across
reboot and how it interacts with autostart; UI labels must make the distinction
visible. Proposed onboarding defaults for review: no persistent access before
consent, offer service autostart, and leave menu-bar UI autolaunch off. Background
service readiness, backend availability and relay connectivity are separate
states. Offline relay alone must not prevent local status or recovery controls.

## Linux headless host

Use a systemd **user** service, one per account, with explicit backend selection
and no iTerm2 probes on Linux. Start with local tmux as the required supported
server backend. Herdr support is conditional on separate Linux qualification.
Do not advertise all DGX/AWS environments as supported merely because they run
Linux: distro, architecture, runtime and backend compatibility need testing.

Initial proposed qualification targets are Ubuntu 22.04/24.04 on x86-64 and ARM64.
Amazon Linux and particular DGX distributions are additional qualification
targets, not assumed compatibility. Windows, musl-only distributions, containers
as a host packaging format and non-systemd service installation are outside the
first Linux delivery. Foreground operation remains useful for diagnostics.

Use the existing package/CLI first, with Node 22+ as an explicit Linux prerequisite.
Do not block Linux qualification on a new standalone executable format. Public
npm publication remains subject to the existing release gates; source-built
packages must be testable without publishing.

Pair through an authenticated SSH session: `shellbell pair` displays a QR on the
operator's local terminal and asks that operator to confirm the client. Pairing
secrets must not enter journal logs, shell history or unattended auto-accept
flows. Closing the SSH session must not stop a configured persistent service.

That persistence requires checking user-manager policy: systemd lingering can
keep a user manager running after logout and start it at boot. Setup must report
whether it is configured and explain any administrator authorization needed;
never enable it for other users or alter server login policy silently. See
[loginctl](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).

The tmux server/session lifetime also needs logout testing. Install instructions
must create/use a supported tmux session; the agent does not capture an arbitrary
existing SSH shell, discover every process, or turn detached training jobs into
terminal sessions. Slurm, Kubernetes, Docker and GPU job monitoring are separate
integrations, not implied by Linux support.

## Native macOS host controller

Proposed implementation: a small Swift/AppKit controller with SwiftUI where
appropriate, shipped as `Shellbell.app` in a signed/notarized disk image. Bundle
a private runtime and the existing agent's runtime dependencies so users do not
install Node or npm. External terminal backends remain prerequisites; do not
silently install iTerm2, tmux or Herdr.

Target macOS 13+ initially, subject to bundled-runtime/build qualification.
Use Apple's app-bundled per-user service mechanism; no root LaunchDaemon is
needed. Apple's [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)
supports app-managed agents on that platform range. Detailed lifecycle, packaging
and compatibility tests must establish behavior, not just successful registration.

Use the existing monochrome template assets under `brand/macos/menu-bar/18/`,
with native system tinting; use the service app icon for the host controller.
No new logo work is needed. The controller is not a desktop terminal client for
connecting to another machine.

Menu essentials: service/relay/backend status, Pair Device, paired-device
management, settings, diagnostics, explicit Start/Stop/Restart Service and Quit
Menu Bar App. Pairing confirmation is shown only while an operator has opened
the pairing flow. Normal operation needs no persistent window or Dock icon.

Existing CLI installations must be detected before enabling the bundled service.
Migration requires an explicit handoff, preserving identity/pairings, waiting for
the old process to release ownership, and never running two managers against the
same state. A failed handoff must leave a recoverable old installation. CLI and
controller must share versioned IPC, not edit live identity files independently.

Verify the real macOS Login Items attribution after signing; merely renaming the
plist or adding a native launcher is not proof it displays Shellbell correctly.
Sign nested executables appropriately and test Gatekeeper/notarization and both
CPU architectures. No certificate issuance, release upload or deployment is
authorized implicitly by this design review.

The Mac user still needs to be logged in and the computer awake. Keeping the Mac
awake, pre-login remote access and unattended encrypted-disk unlock are not
provided. Uninstall instructions must unregister background work before removal
and distinguish removal from device revocation or credential erasure.

## Delivery boundaries and acceptance

1. **Service hardening:** fix reproduced audit defects and validate operational
   foundations without changing platform support or publishing.
2. **Headless host design/implementation:** platform adapters, host/user state,
   Linux package qualification, systemd lifecycle and multi-user tests.
3. **Native Mac design/implementation:** controller IPC, packaging/signing,
   approval/migration UX and lifecycle validation against the hardened core.
4. **Notification reliability design/implementation:** audit S7 remains an
   explicit workstream, including receipts, bounded failure handling and privacy-
   safe diagnostics. Do not mark it solved by packaging work or a green test run.

These are separate deliverables, not one large patch. Desktop terminal clients,
Windows hosts, read-only pairing and job schedulers require subsequent designs.
Bounded terminal streaming is an additional workstream with its own compatibility
gate; it is not silently folded into the first service-hardening patch.

Cross-cutting release acceptance:

- Two different OS users on one Linux host can run different sessions concurrently;
  pairing/controlling/stopping user A never exposes or stops user B's agent.
- One phone can distinguish and independently revoke both agent identities.
- One user with a shared home on two hosts receives separate identities and IPC.
- Logout/reboot and explicit stop behavior match documented persistence settings.
- Closing the Mac controller does not interrupt viewed sessions or rings.
- Old CLI-to-native migration preserves keys, refuses duplicate ownership, and
  recovers from failure without exposing secrets.
- No claim of Linux, Intel Mac or specific DGX support until that target is tested.
- Existing release/device gates remain applicable; these features do not authorize
  merging the Version Packages PR, publishing npm or deploying the relay.
