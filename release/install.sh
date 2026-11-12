#!/bin/sh
# Installs the Relay helper on macOS or Linux without Homebrew:
#   curl -fsSL https://raw.githubusercontent.com/@TAP_REPO@/main/install.sh | sh
# Downloads the release for this computer, checks it against SHA256SUMS, runs `relay install` (copies it to
# ~/.relay/bin, adds the Claude Code hooks, starts it at login), then `relay pair`, which shows the QR code
# to scan with the phone. One command from nothing to paired. No sudo needed.
set -eu

REPO="@TAP_REPO@"
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)
    OS=linux
    # Alpine and other musl systems need the musl build (and libstdc++, as Claude Code does).
    if ls /lib/ld-musl-* >/dev/null 2>&1; then ARCH="$ARCH-musl"; fi
    ;;
  *) echo "The Relay helper runs on macOS and Linux. On Windows, install it inside WSL." >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

VERSION="${RELAY_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)}"
[ -n "$VERSION" ] || { echo "Couldn't find the latest release. Check your connection and try again." >&2; exit 1; }

NAME="relay-$VERSION-$OS-$ARCH"
# RELAY_BASE_URL points at a local copy of a release, for testing the installer.
BASE="${RELAY_BASE_URL:-https://github.com/$REPO/releases/download/v$VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Relay $VERSION ($OS-$ARCH)…"
curl -fsSL "$BASE/$NAME.tar.gz" -o "$TMP/$NAME.tar.gz"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
EXPECTED="$(awk -v f="$NAME.tar.gz" '$2 == f || $2 == "./" f { print $1 }' "$TMP/SHA256SUMS")"
ACTUAL="$(sha256 "$TMP/$NAME.tar.gz")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "The download doesn't match its checksum, so it wasn't installed. Try again." >&2; exit 1; }

tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
"$TMP/$NAME/relay" install

mkdir -p "$HOME/.local/bin"
ln -sf "${RELAY_HOME:-$HOME/.relay}/bin/relay" "$HOME/.local/bin/relay"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to your PATH to use the relay command." ;; esac
# Finish with the pairing code, so one command takes a new user from nothing to scanning.
"${RELAY_HOME:-$HOME/.relay}/bin/relay" pair
