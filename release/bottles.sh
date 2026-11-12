#!/usr/bin/env bash
# Repackages the release tarballs in <dist dir> as Homebrew bottles. Called by release/release.sh.
#
#   release/bottles.sh <version> <dist dir>
#
# Without a bottle, Homebrew treats the formula as a source build and first runs its build checks.
# Those checks are fatal when Xcode or the Command Line Tools are older than the running macOS
# (e.g. Xcode 26.6 on macOS 27 gives "Your Xcode ... is too outdated"), even though nothing is
# compiled. A poured bottle skips them. The binaries go in unchanged, so the macOS signatures and
# notarization still hold; the formula marks them `cellar: :any_skip_relocation`.
#
# Homebrew uses a bottle on the macOS version in its tag and on every newer one. The tag is Ventura
# because the Bun-built binaries need macOS 13.0 (their LC_BUILD_VERSION minos).
set -euo pipefail

VERSION="${1:?usage: bottles.sh <version> <dist dir>}"
DIST="${2:?usage: bottles.sh <version> <dist dir>}"

# Release target → Homebrew bottle tag.
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
