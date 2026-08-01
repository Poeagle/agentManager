#!/usr/bin/env bash
# Build a release archive for AgentManager.
# Produces: agentmanager-vX.Y.Z.tar.gz and its SHA-256 sidecar.
#
# Usage:
#   bash scripts/build-archive.sh           # uses version from server/package.json
#   VERSION=0.2.0 bash scripts/build-archive.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Get version
if [ -z "${VERSION:-}" ]; then
  VERSION=$(node -e "console.log(require('$ROOT_DIR/server/package.json').version)")
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "Invalid release version: $VERSION" >&2
  exit 1
fi

ARCHIVE_NAME="agentmanager-v${VERSION}"
BUILD_DIR="$(mktemp -d)"
STAGE_DIR="$BUILD_DIR/$ARCHIVE_NAME"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "Building AgentManager v${VERSION} release..."

# --- Build server ---
echo "  [1/6] Building server..."
cd "$ROOT_DIR/server"
npm ci --ignore-scripts 2>&1 | tail -1
npm run build

# --- Build dashboard ---
echo "  [2/6] Building dashboard..."
cd "$ROOT_DIR/dashboard"
npm ci --ignore-scripts 2>&1 | tail -1
npm run build

# --- Stage files ---
echo "  [3/6] Staging release files..."
mkdir -p "$STAGE_DIR"

# Server: built JS + package files (node_modules installed on target machine
# because native modules like better-sqlite3 need platform-specific binaries)
mkdir -p "$STAGE_DIR/server"
cp -r "$ROOT_DIR/server/dist" "$STAGE_DIR/server/dist"
cp "$ROOT_DIR/server/package.json" "$STAGE_DIR/server/package.json"
cp "$ROOT_DIR/server/package-lock.json" "$STAGE_DIR/server/package-lock.json"

# Dashboard: static build output
mkdir -p "$STAGE_DIR/dashboard"
cp -r "$ROOT_DIR/dashboard/dist" "$STAGE_DIR/dashboard/dist"

# CLI + scripts + service files
cp -r "$ROOT_DIR/bin" "$STAGE_DIR/bin"
chmod +x "$STAGE_DIR/bin/agentmanager"
cp -r "$ROOT_DIR/scripts" "$STAGE_DIR/scripts"

# Version metadata
cat > "$STAGE_DIR/version.json" <<VJSON
{
  "version": "$VERSION",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node_version": "$(node -v)"
}
VJSON

# --- Create archive ---
echo "  [4/6] Creating archive..."
cd "$BUILD_DIR"
tar czf "$ROOT_DIR/$ARCHIVE_NAME.tar.gz" "$ARCHIVE_NAME"

# --- Checksum ---
echo "  [5/6] Creating SHA-256 checksum..."
cd "$ROOT_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE_NAME.tar.gz" > "$ARCHIVE_NAME.tar.gz.sha256"
else
  shasum -a 256 "$ARCHIVE_NAME.tar.gz" > "$ARCHIVE_NAME.tar.gz.sha256"
fi

# --- Cleanup ---
echo "  [6/6] Cleaning up..."

SIZE=$(du -h "$ROOT_DIR/$ARCHIVE_NAME.tar.gz" | cut -f1)
echo ""
echo "Done! $ARCHIVE_NAME.tar.gz ($SIZE)"
echo "Checksum: $ARCHIVE_NAME.tar.gz.sha256"
echo "Upload both files to the GitHub Release."
