#!/usr/bin/env bash
# Builds a Relay helper release for macOS and Linux, then writes SHA256SUMS, the Homebrew formula and
# install.sh. Run on a Mac (the macOS builds need signing and notarization there).
#
#   release/release.sh 0.2.0              # build into release/dist/0.2.0
#   release/release.sh 0.2.0 --publish    # also create the GitHub release and update the tap
#
# RELAY_PLATFORMS="linux" builds only Linux (for trying it out; don't publish a release like that).
set -euo pipefail

VERSION="${1:?usage: release.sh <version> [--publish]}"
PUBLISH="${2:-}"
PLATFORMS="${RELAY_PLATFORMS:-darwin linux}"
TAP_REPO="${RELAY_TAP_REPO:-netchuu/homebrew-tap}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/release/dist/$VERSION"

if [[ "$PUBLISH" == "--publish" && "$PLATFORMS" != "darwin linux" ]]; then
  echo "A published release needs both platforms; unset RELAY_PLATFORMS." >&2; exit 1
fi
# gh acts as the tap's account whatever account is active in gh (one that can't see the tap answers
# 404 and the release is never created). Checked before the build, not after an hour of notarizing.
if [[ "$PUBLISH" == "--publish" && -z "${GH_TOKEN:-}" ]]; then
  GH_USER="${RELAY_GH_USER:-netchuu}"
  GH_TOKEN="$(gh auth token --user "$GH_USER" 2>/dev/null)" || {
    echo "gh has no login for $GH_USER (gh auth login, or set RELAY_GH_USER); not releasing." >&2; exit 1
  }
  export GH_TOKEN
fi

rm -rf "$DIST" && mkdir -p "$DIST"
cd "$ROOT"
bun test >/dev/null || { echo "Tests failed; not releasing." >&2; exit 1; }

for OS in $PLATFORMS; do "$ROOT/release/build-$OS.sh" "$VERSION" "$DIST"; done

"$ROOT/release/bottles.sh" "$VERSION" "$DIST"

( cd "$DIST" && shasum -a 256 ./*.tar.gz | sed 's# \./# #' > SHA256SUMS )
sha() { awk -v f="relay-$VERSION-$1.tar.gz" '$2 == f { print $1 }' "$DIST/SHA256SUMS"; }
bsha() { awk -v f="relay-$VERSION.$1.bottle.tar.gz" '$2 == f { print $1 }' "$DIST/SHA256SUMS"; }

sed -e "s/@VERSION@/$VERSION/g" -e "s#@TAP_REPO@#$TAP_REPO#g" \
  -e "s/@SHA_DARWIN_ARM64@/$(sha darwin-arm64)/" -e "s/@SHA_DARWIN_X64@/$(sha darwin-x64)/" \
  -e "s/@SHA_LINUX_ARM64@/$(sha linux-arm64)/" -e "s/@SHA_LINUX_X64@/$(sha linux-x64)/" \
  -e "s/@SHA_BOTTLE_ARM64_VENTURA@/$(bsha arm64_ventura)/" -e "s/@SHA_BOTTLE_VENTURA@/$(bsha ventura)/" \
  -e "s/@SHA_BOTTLE_ARM64_LINUX@/$(bsha arm64_linux)/" -e "s/@SHA_BOTTLE_X86_64_LINUX@/$(bsha x86_64_linux)/" \
  "$ROOT/release/relay.rb.in" > "$DIST/relay.rb"
sed -e "s#@TAP_REPO@#$TAP_REPO#g" "$ROOT/release/install.sh" > "$DIST/install.sh"
echo "• built into $DIST"
cat "$DIST/SHA256SUMS"

if [[ "$PUBLISH" == "--publish" ]]; then
  gh release create "v$VERSION" --repo "$TAP_REPO" --title "Relay $VERSION" \
    --notes "Relay helper $VERSION for macOS and Linux" "$DIST"/*.tar.gz "$DIST/SHA256SUMS"
  WORK="$(mktemp -d)"
  gh repo clone "$TAP_REPO" "$WORK" -- --depth 1 -q
  mkdir -p "$WORK/Formula" && cp "$DIST/relay.rb" "$WORK/Formula/relay.rb" && cp "$DIST/install.sh" "$WORK/install.sh"
  cp "$ROOT/release/tap-README.md" "$WORK/README.md"
  git -C "$WORK" add -A && git -C "$WORK" commit -qm "Relay $VERSION" && git -C "$WORK" push -q
  rm -rf "$WORK"
  echo "• published: brew install ${TAP_REPO%%/*}/tap/relay"
fi
