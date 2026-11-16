#!/usr/bin/env bash
# Repackages the release tarballs as Homebrew bottles (skips its Xcode checks): release/bottles.sh <version> <dist dir>
set -euo pipefail

VERSION="${1:?usage: bottles.sh <version> <dist dir>}"
DIST="${2:?usage: bottles.sh <version> <dist dir>}"

# Release target → bottle tag; Ventura because the Bun-built binaries need macOS 13.0.
TAGS=(darwin-arm64:arm64_ventura darwin-x64:ventura linux-arm64:arm64_linux linux-x64:x86_64_linux)

for PAIR in "${TAGS[@]}"; do
  TARGET="${PAIR%%:*}"; TAG="${PAIR##*:}"
  TARBALL="$DIST/relay-$VERSION-$TARGET.tar.gz"
  [[ -f "$TARBALL" ]] || continue
  WORK="$(mktemp -d)"
  tar -xzf "$TARBALL" -C "$WORK"
  KEG="$WORK/bottle/relay/$VERSION"
  mkdir -p "$KEG/bin"
  cp "$WORK/relay-$VERSION-$TARGET/relay" "$WORK/relay-$VERSION-$TARGET/relay-hook" "$KEG/bin/"
  cp "$WORK/relay-$VERSION-$TARGET/LICENSE.txt" "$KEG/"
  # Homebrew downloads "<name>-<version>.<tag>.bottle.tar.gz" from root_url (one dash, not the "--" it
  # uses in its cache). No macOS extended attributes, as in build-linux.sh.
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$WORK/bottle" \
    -czf "$DIST/relay-$VERSION.$TAG.bottle.tar.gz" relay
  rm -rf "$WORK"
done
