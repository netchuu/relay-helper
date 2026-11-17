#!/usr/bin/env bash
# Fails unless the tag names the version in package.json and the commit is on main: release/check-tag.sh v0.2.0 [commit]
# Run from the repository root; MAIN_REF (default origin/main) is the branch a release must come from.
set -euo pipefail

TAG="${1:?usage: check-tag.sh <tag> [commit]}"
COMMIT="${2:-HEAD}"
MAIN_REF="${MAIN_REF:-origin/main}"
TOP="$(git rev-parse --show-toplevel)"

VERSION="$(git -C "$TOP" show "$COMMIT:package.json" | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$VERSION" ]] || { echo "No version in package.json at $COMMIT." >&2; exit 1; }
if [[ "$TAG" != "v$VERSION" ]]; then
  echo "Tag $TAG does not match package.json version $VERSION (expected v$VERSION); not releasing." >&2; exit 1
fi
git -C "$TOP" rev-parse -q --verify "$MAIN_REF" >/dev/null || { echo "$MAIN_REF not found; fetch main first." >&2; exit 1; }
git -C "$TOP" merge-base --is-ancestor "$COMMIT" "$MAIN_REF" || {
  echo "Commit $(git -C "$TOP" rev-parse --short "$COMMIT") is not on main; not releasing." >&2; exit 1
}
echo "• $TAG matches package.json and is on main"
