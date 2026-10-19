#!/bin/bash
# Builds the signed macOS .dmg and .zip (Intel and Apple Silicon) and attaches
# them to the GitHub release for the version in package.json.
#
#   scripts/release-mac.sh            build only
#   scripts/release-mac.sh --upload   build, then upload to release v<version>
#
# Signs with this Mac's Apple Development certificate (codesign --timestamp,
# hardened runtime). Not notarized, so other Macs show a Gatekeeper prompt the
# first time; right-click > Open gets past it.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(node -p "require('./package.json').version")"
identity="${SHELF_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')}"
[ -n "$identity" ] || { echo "No Apple Development signing identity found" >&2; exit 1; }

rm -rf dist
CSC_NAME="$identity" npx electron-builder --mac --x64 --arm64 --publish never

for app in dist/mac/Shelf.app dist/mac-arm64/Shelf.app; do
  codesign --verify --deep --strict "$app"
  codesign -dvv "$app" 2>&1 | grep -E '^(Authority|Timestamp)=' | head -2
done

if [ "${1:-}" = "--upload" ]; then
  gh release upload "v$version" dist/Shelf-"$version"-mac-*.dmg dist/Shelf-"$version"-mac-*.zip --clobber
fi
ls -lh dist/Shelf-"$version"-mac-*
