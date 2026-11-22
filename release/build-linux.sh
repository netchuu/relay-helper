#!/usr/bin/env bash
# Builds the Linux helper (x64, arm64; glibc and musl) into tarballs: release/build-linux.sh <version> <dist dir>
set -euo pipefail

VERSION="${1:?usage: build-linux.sh <version> <dist dir>}"
DIST="${2:?usage: build-linux.sh <version> <dist dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for TARGET in linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
  OUT="$DIST/relay-$VERSION-$TARGET"
  mkdir -p "$OUT"
  echo "• building $TARGET"
  for ENTRY in "hook/client.ts:relay-hook" "cli.ts:relay" "shell/wrapMain.ts:relay-wrap"; do
    SRC="${ENTRY%%:*}"; NAME="${ENTRY##*:}"
    bun build --compile --minify --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
      --target="bun-$TARGET" \
      --define "process.env.RELAY_VERSION=\"$VERSION\"" \
      "mac/src/$SRC" --outfile "$OUT/$NAME" >/dev/null
  done
  cp "$ROOT/release/LICENSE.txt" "$OUT/" 2>/dev/null || true
  # No macOS extended attributes: GNU tar on Linux warns about them.
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$DIST" -czf "$DIST/relay-$VERSION-$TARGET.tar.gz" "relay-$VERSION-$TARGET"
done

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  for ARCH in x64 arm64; do
    PLATFORM=$([[ $ARCH == x64 ]] && echo linux/amd64 || echo linux/arm64)
    GOT=$(docker run --rm --platform "$PLATFORM" -v "$DIST/relay-$VERSION-linux-$ARCH:/r:ro" debian:stable-slim /r/relay --version)
    [[ "$GOT" == "relay $VERSION "* ]] || { echo "linux-$ARCH smoke test failed: $GOT" >&2; exit 1; }
    echo "• linux-$ARCH runs: $GOT"
  done
else
  echo "• Docker isn't running: skipped the Linux smoke test"
fi
