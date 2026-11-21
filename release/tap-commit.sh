#!/usr/bin/env bash
# Commits the release files in a clone of the tap: release/tap-commit.sh <clone> <version>. Works on a runner with
# no git identity; the push later authenticates through gh's token.
set -euo pipefail
WORK="${1:?usage: tap-commit.sh <clone> <version>}"
# GitHub shows the account that owns the email; a made-up noreply address can belong to a stranger.
git -C "$WORK" -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -qm "Relay ${2:?}"
