# Relay helper

[Relay](https://relay.relay-cloud.workers.dev) lets you answer Claude Code from your phone. When a session on
your Mac or Linux computer asks a question, wants a plan approved or needs permission to run something, it shows
up on your phone; you tap an answer and the session carries on.

This repository is everything that runs outside the phone: the helper on your computer, the protocol it speaks
with the app, and the Cloudflare Worker that relays encrypted traffic between them. It's open source so you can
check what the helper does instead of trusting it. The phone apps are separate and closed source.

To install Relay, follow the [install guide](https://github.com/netchuu/homebrew-tap#readme).

## What the helper can see and do

The helper runs as you, with your permissions, so this is worth knowing before you install it:

- It adds hooks to `~/.claude/settings.json` (keeping a backup), so Claude Code tells it about questions,
  plans, permission requests and finished turns. It reads those sessions' transcripts to show their progress.
- It types your phone's replies into the session's terminal or editor. On macOS that uses the Accessibility
  permission, which you grant yourself and can take back in System Settings.
- It starts at login (a launchd agent on macOS, a systemd user service on Linux) and keeps its data in
  `~/.relay`.
- It sends traffic to the Relay Worker, end-to-end encrypted with keys made at pairing, and push
  notifications that carry only an encrypted blob. [docs/RELAY.md](docs/RELAY.md) says what the Worker, Apple,
  Google and Cloudflare can see.
- `relay uninstall` stops the helper and removes the hooks, the login item (the launchd agent or systemd unit)
  and anything it changed in Zed. It keeps `~/.relay`, so a later install still knows your paired phones.
  `relay uninstall --purge` deletes `~/.relay` as well: the paired phones, the keys made at pairing, the
  database, attachments and logs. Phones paired before can't connect again; pair them anew after a new install.

## Layout

| Folder | What |
|---|---|
| `mac/` | The helper (macOS and Linux, despite the name): `mac/src/cli.ts` is the `relay` command, `mac/src/daemon/` the background service, `mac/src/hook/` the Claude Code hook |
| `protocol/` | Message schemas, and the fixtures both phone apps' tests decode, so the helper and the apps can't drift apart |
| `cloud/` | The Cloudflare Worker that relays encrypted frames and sends push notifications |
| `release/` | Release builds: signed and notarized macOS binaries, Linux binaries, `SHA256SUMS`, the Homebrew formula and `install.sh` |

## Building and testing

You need [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run test           # the helper's tests
bun run typecheck
bun run lint
bun run test:linux     # the same tests in a Linux container (needs Docker)
bun run build          # mac/bin/relay and mac/bin/relay-hook
```

## Privacy

- Everything between your computer and your phone is end-to-end encrypted. The private keys are made on the
  two devices when you pair them, and they never leave them.
- The relay (the Cloudflare Worker in `cloud/`) only passes encrypted messages along. It doesn't store them and
  can't read them. All it keeps is a short list of recent push times per phone, under a hash of its push token,
  to limit how many notifications a phone can get, and whether a computer has connected to its room.
- A notification's text is encrypted for your phone. Apple delivers the generic "New activity on your Mac"
  with an encrypted blob that only your phone can open.
- There are no accounts and no analytics. [docs/RELAY.md](docs/RELAY.md) describes the protocol and what each
  service in between can see.

## Licence

[Apache License 2.0](LICENSE).
