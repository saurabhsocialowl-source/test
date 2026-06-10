#!/usr/bin/env bash
# Build the Chrome Web Store upload package.
# Produces store-assets/couch-<version>.zip with manifest.json at the zip root.
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -e "process.stdout.write(require('./extension/manifest.json').version)")
OUT="store-assets/couch-${VERSION}.zip"

mkdir -p store-assets
rm -f "$OUT"

# Zip the *contents* of extension/ (the store requires manifest.json at the root).
( cd extension && zip -r -X "../$OUT" . \
    -x '*.map' -x '.DS_Store' -x '*/.DS_Store' >/dev/null )

echo "Built $OUT"
unzip -l "$OUT" | tail -n +2
