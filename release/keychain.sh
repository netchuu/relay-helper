#!/usr/bin/env bash
# A temporary keychain for CI signing. setup imports the Developer ID certificate and stores the notary profile
# in it, then exports RELAY_KEYCHAIN, RELAY_SIGN_IDENTITY and RELAY_NOTARY_PROFILE to $GITHUB_ENV; teardown removes it.
#   release/keychain.sh setup     needs RELAY_SIGN_CERT_P12_BASE64, RELAY_SIGN_CERT_PASSWORD,
#                                 RELAY_NOTARY_APPLE_ID, RELAY_NOTARY_TEAM_ID, RELAY_NOTARY_PASSWORD
#   release/keychain.sh teardown  uses RELAY_KEYCHAIN
set -euo pipefail

PROFILE="relay-notary"
case "${1:-}" in
  setup)
    DIR="$(mktemp -d)"
    KEYCHAIN="$DIR/relay-release.keychain-db"
    PASS="$(uuidgen)"
    echo "::add-mask::$PASS"
    printf '%s' "$RELAY_SIGN_CERT_P12_BASE64" | base64 --decode > "$DIR/cert.p12"
    security create-keychain -p "$PASS" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$PASS" "$KEYCHAIN"
    security import "$DIR/cert.p12" -k "$KEYCHAIN" -P "$RELAY_SIGN_CERT_PASSWORD" -T /usr/bin/codesign
    rm -f "$DIR/cert.p12"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KEYCHAIN" >/dev/null
    # codesign and notarytool find the keychain through the search list
    security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
    xcrun notarytool store-credentials "$PROFILE" --apple-id "$RELAY_NOTARY_APPLE_ID" \
      --team-id "$RELAY_NOTARY_TEAM_ID" --password "$RELAY_NOTARY_PASSWORD" --keychain "$KEYCHAIN" >/dev/null
    IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk '/Developer ID Application/ {print $2; exit}')"
    [[ -n "$IDENTITY" ]] || { echo "The certificate has no Developer ID Application identity." >&2; exit 1; }
    {
      echo "RELAY_KEYCHAIN=$KEYCHAIN"
      echo "RELAY_SIGN_IDENTITY=$IDENTITY"
      echo "RELAY_NOTARY_PROFILE=$PROFILE"
    } >> "${GITHUB_ENV:-/dev/stdout}"
    echo "• signing keychain ready"
    ;;
  teardown)
    [[ -n "${RELAY_KEYCHAIN:-}" ]] || exit 0
    security delete-keychain "$RELAY_KEYCHAIN" 2>/dev/null || true
    rm -rf "$(dirname "$RELAY_KEYCHAIN")"
    ;;
  *) echo "usage: keychain.sh setup|teardown" >&2; exit 1 ;;
esac
