#!/usr/bin/env bash
# Fails when a signing or notarization secret is missing or empty, before anything is built or uploaded.
# Checks only that each is set, never prints a value: release/check-secrets.sh [--publish]
set -euo pipefail

NAMES=(RELAY_SIGN_CERT_P12_BASE64 RELAY_SIGN_CERT_PASSWORD RELAY_NOTARY_APPLE_ID RELAY_NOTARY_TEAM_ID RELAY_NOTARY_PASSWORD)
[[ "${1:-}" == "--publish" ]] && NAMES+=(RELAY_TAP_TOKEN)

MISSING=()
for NAME in "${NAMES[@]}"; do
  [[ -n "${!NAME:-}" ]] || MISSING+=("$NAME")
done
if ((${#MISSING[@]})); then
  echo "Missing or empty secrets: ${MISSING[*]}. Not building: an unsigned build must never reach the tap." >&2
  exit 1
fi
echo "• all ${#NAMES[@]} release secrets are set"
