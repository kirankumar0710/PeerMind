#!/usr/bin/env bash
# Build the PeerMind extension package for Brave and Chrome.
#
#   ./create_package.sh               run tests + compat check, then build
#   ./create_package.sh --skip-checks build only
#
# Produces:
#   dist/peermind-<version>.zip   the release package (same SHA-256 for the same sources)
#   dist/peermind-<version>/      the same package unzipped, for "Load unpacked"
set -euo pipefail

cd "$(dirname "$0")"

SKIP_CHECKS=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=true ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

for cmd in node npm unzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: '$cmd' is required but not installed." >&2; exit 1; }
done

VERSION="$(node -p "require('./manifest.json').version")"
ZIP="dist/peermind-${VERSION}.zip"
DIR="dist/peermind-${VERSION}"

if [ "$SKIP_CHECKS" = false ]; then
  if [ ! -d node_modules ]; then
    echo "==> Installing dev dependencies"
    npm install --silent
  fi
  echo "==> Running tests"
  npm test --silent
  echo "==> Running compatibility check"
  npm run -s check:compat
fi

echo "==> Building ${ZIP}"
PACKAGE_OUTPUT="$(npm run -s package)"
SHA256="$(printf '%s\n' "$PACKAGE_OUTPUT" | awk '/^sha256 /{print $2}')"

echo "==> Unzipping into ${DIR}/"
rm -rf "$DIR"
unzip -q "$ZIP" -d "$DIR"

cat <<EOF

Package ready
  Version : ${VERSION}
  Zip     : ${ZIP}
  Unzipped: ${DIR}/
  SHA-256 : ${SHA256}

Load in Brave:  brave://extensions  → Developer mode → Load unpacked → ${DIR}
Load in Chrome: chrome://extensions → Developer mode → Load unpacked → ${DIR}
Record the SHA-256 with every Brave and Chrome test result.
EOF
