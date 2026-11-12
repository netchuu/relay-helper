#!/usr/bin/env bash
# Builds, signs and notarizes the macOS helper for both architectures into release tarballs.
# Called by release/release.sh; run on a Mac with your Developer ID certificate in the keychain.
#
#   release/build-darwin.sh <version> <dist dir>
#
# One-time setup (see release/README.md):
#   - "Developer ID Application" certificate (Xcode → Settings → Accounts → Manage Certificates)
#   - xcrun notarytool store-credentials relay-notary   (Apple ID + app-specific password)
set -euo pipefail

VERSION="${1:?usage: build-darwin.sh <version> <dist dir>}"
DIST="${2:?usage: build-darwin.sh <version> <dist dir>}"
NOTARY_PROFILE="${RELAY_NOTARY_PROFILE:-relay-notary}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/release/entitlements.plist"

# Sign by fingerprint: with two copies of the certificate in the keychain, signing by name fails as
# "ambiguous".
IDENTITY="${RELAY_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')}"
[[ -n "$IDENTITY" ]] || { echo "No 'Developer ID Application' certificate in the keychain." >&2; exit 1; }
echo "• signing with: $(security find-identity -v -p codesigning | grep "$IDENTITY" | sed 's/.*"\(.*\)"/\1/')"
cd "$ROOT"

for ARCH in arm64 x64; do
  OUT="$DIST/relay-$VERSION-darwin-$ARCH"
  mkdir -p "$OUT"
  echo "• building darwin-$ARCH"
  for ENTRY in "hook/client.ts:relay-hook" "cli.ts:relay"; do
    SRC="${ENTRY%%:*}"; NAME="${ENTRY##*:}"
    # No bunfig.toml or .env from the working directory: a bunfig.toml there could preload code into relay.
    bun build --compile --minify --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
      --target="bun-darwin-$ARCH" \
      --define "process.env.RELAY_VERSION=\"$VERSION\"" \
      "mac/src/$SRC" --outfile "$OUT/$NAME" >/dev/null
    codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$OUT/$NAME"
    codesign --verify --strict "$OUT/$NAME"
  done
  cp "$ROOT/release/LICENSE.txt" "$OUT/"

  # Plain executables can't be stapled: notarize a zip, Gatekeeper checks the ticket online.
  ZIP="$DIST/relay-$VERSION-darwin-$ARCH.zip"
  ditto -c -k --keepParent "$OUT" "$ZIP"
  echo "• notarizing darwin-$ARCH (takes a few minutes)"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  rm "$ZIP"

  tar -C "$DIST" -czf "$DIST/relay-$VERSION-darwin-$ARCH.tar.gz" "relay-$VERSION-darwin-$ARCH"
done
