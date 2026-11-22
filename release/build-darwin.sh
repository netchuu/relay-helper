#!/usr/bin/env bash
# Builds, signs and notarizes the macOS helper (setup: release/README.md): release/build-darwin.sh <version> <dist dir>
set -euo pipefail

VERSION="${1:?usage: build-darwin.sh <version> <dist dir>}"
DIST="${2:?usage: build-darwin.sh <version> <dist dir>}"
NOTARY_PROFILE="${RELAY_NOTARY_PROFILE:-relay-notary}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/release/entitlements.plist"

# Sign by fingerprint: with two copies of the certificate in the keychain, signing by name fails as
# "ambiguous".
#
# RELAY_KEYCHAIN (set by keychain.sh in CI) names a keychain file to sign and notarize from; unset, the
# login keychain is used.
KC=()
[[ -z "${RELAY_KEYCHAIN:-}" ]] || KC=(--keychain "$RELAY_KEYCHAIN")
# Notarize with an App Store Connect API key when RELAY_NOTARY_KEY (the .p8 path), RELAY_NOTARY_KEY_ID and
# RELAY_NOTARY_ISSUER are set; otherwise with the keychain profile, which has twice gone missing from the keychain.
NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE" ${KC[@]+"${KC[@]}"})
if [[ -n "${RELAY_NOTARY_KEY:-}" && -n "${RELAY_NOTARY_KEY_ID:-}" && -n "${RELAY_NOTARY_ISSUER:-}" ]]; then
  NOTARY_AUTH=(--key "$RELAY_NOTARY_KEY" --key-id "$RELAY_NOTARY_KEY_ID" --issuer "$RELAY_NOTARY_ISSUER")
fi
IDENTITY="${RELAY_SIGN_IDENTITY:-$(security find-identity -v -p codesigning ${RELAY_KEYCHAIN:-} | awk '/Developer ID Application/ {print $2; exit}')}"
[[ -n "$IDENTITY" ]] || { echo "No 'Developer ID Application' certificate in the keychain." >&2; exit 1; }
echo "• signing with: $(security find-identity -v -p codesigning ${RELAY_KEYCHAIN:-} | grep "$IDENTITY" | sed 's/.*"\(.*\)"/\1/')"
cd "$ROOT"

for ARCH in arm64 x64; do
  OUT="$DIST/relay-$VERSION-darwin-$ARCH"
  mkdir -p "$OUT"
  echo "• building darwin-$ARCH"
  for ENTRY in "hook/client.ts:relay-hook" "cli.ts:relay" "shell/wrapMain.ts:relay-wrap"; do
    SRC="${ENTRY%%:*}"; NAME="${ENTRY##*:}"
    # No bunfig.toml or .env from the working directory: a bunfig.toml there could preload code into relay.
    bun build --compile --minify --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
      --target="bun-darwin-$ARCH" \
      --define "process.env.RELAY_VERSION=\"$VERSION\"" \
      "mac/src/$SRC" --outfile "$OUT/$NAME" >/dev/null
    codesign ${KC[@]+"${KC[@]}"} --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$OUT/$NAME"
    codesign --verify --strict "$OUT/$NAME"
  done
  cp "$ROOT/release/LICENSE.txt" "$OUT/"

  # Plain executables can't be stapled: notarize a zip, Gatekeeper checks the ticket online.
  ZIP="$DIST/relay-$VERSION-darwin-$ARCH.zip"
  ditto -c -k --keepParent "$OUT" "$ZIP"
  echo "• notarizing darwin-$ARCH (takes a few minutes)"
  # notarytool can exit 0 on a rejected submission, so read the verdict instead of the exit status.
  RESULT="$(xcrun notarytool submit "$ZIP" "${NOTARY_AUTH[@]}" --wait --output-format json)" || {
    echo "$RESULT" >&2
    echo "notarytool failed for darwin-$ARCH." >&2
    exit 1
  }
  field() { printf '%s' "$RESULT" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1; }
  STATUS="$(field status)"
  if [[ "$STATUS" != "Accepted" ]]; then
    echo "$RESULT" >&2
    echo "Apple did not accept darwin-$ARCH (status: ${STATUS:-unknown}, submission id: $(field id))." >&2
    echo "See why: xcrun notarytool log $(field id) ${NOTARY_AUTH[*]}" >&2
    exit 1
  fi
  rm "$ZIP"

  tar -C "$DIST" -czf "$DIST/relay-$VERSION-darwin-$ARCH.tar.gz" "relay-$VERSION-darwin-$ARCH"
done
