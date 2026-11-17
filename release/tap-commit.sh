#!/usr/bin/env bash
# Commits the release files in a clone of the tap: release/tap-commit.sh <clone> <version>. Works on a runner with
# no git identity; the push later authenticates through gh's token.
set -euo pipefail
WORK="${1:?usage: tap-commit.sh <clone> <version>}"
git -C "$WORK" -c user.name="Relay release" -c user.email="release@users.noreply.github.com" \
  commit -qm "Relay ${2:?}"
