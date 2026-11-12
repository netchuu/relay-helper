# Building the helper

`release/release.sh <version>` builds the helper into `release/dist/<version>`: macOS for Apple Silicon and
Intel, and Linux for x64 and arm64 (glibc and musl). It also writes `SHA256SUMS`, the Homebrew formula and
`install.sh`.

The macOS builds are signed with the hardened runtime and the entitlements in `entitlements.plist`, then
notarized by Apple, which needs a Developer ID. The Linux builds are checked against `SHA256SUMS` by the installer
and by Homebrew.

Published releases: https://github.com/netchuu/homebrew-tap/releases
