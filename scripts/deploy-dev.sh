#!/usr/bin/env bash
# Build a verified source checkout, then atomically deploy to the local installation.
# Usage: bash scripts/deploy-dev.sh
# Set AGENTMANAGER_INSTALL_DIR when the service runs from a checkout other than ~/agentmanager.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$HOME/agentmanager}"
PORT="${PORT:-42010}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[deploy]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[deploy]${NC} $1"; }
log_error() { echo -e "${RED}[deploy]${NC} $1"; }

if [ ! -x "$INSTALL_DIR/bin/agentmanager" ]; then
  log_error "AgentManager installation not found at $INSTALL_DIR"
  exit 1
fi

# Build before stopping the current service. Dependency installation is optional:
# deploy the existing, verified tree when the lockfile is already installed.
log_info "Preparing deployment from $SRC_DIR..."
cd "$SRC_DIR"
if [ "${AGENTMANAGER_INSTALL_DEPENDENCIES:-0}" = "1" ]; then
  log_info "Installing dependencies..."
  npm run install:all
fi

log_info "Building dashboard + server..."
"${AGENTMANAGER_BUILD_CMD:-npm run build}"

if [ ! -f "$SRC_DIR/dashboard/dist/index.html" ] || [ ! -f "$SRC_DIR/server/dist/index.js" ]; then
  log_error "Build output is incomplete; the running service was not changed."
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentmanager-deploy-backup.XXXXXX")"
SERVER_NEXT="$INSTALL_DIR/server/dist.next-$STAMP"
SERVER_PREVIOUS="$INSTALL_DIR/server/dist.previous-$STAMP"
DASHBOARD_NEXT="$INSTALL_DIR/dashboard/dist.next-$STAMP"
DASHBOARD_PREVIOUS="$INSTALL_DIR/dashboard/dist.previous-$STAMP"

rollback() {
  local reason="$1"
  log_error "Deployment failed: $reason"
  if [ -d "$SERVER_PREVIOUS" ]; then
    if [ -d "$INSTALL_DIR/server/dist" ]; then mv "$INSTALL_DIR/server/dist" "$BACKUP_DIR/server-dist-failed"; fi
    mv "$SERVER_PREVIOUS" "$INSTALL_DIR/server/dist"
  fi
  if [ -d "$DASHBOARD_PREVIOUS" ]; then
    if [ -d "$INSTALL_DIR/dashboard/dist" ]; then mv "$INSTALL_DIR/dashboard/dist" "$BACKUP_DIR/dashboard-dist-failed"; fi
    mv "$DASHBOARD_PREVIOUS" "$INSTALL_DIR/dashboard/dist"
  fi
  [ -d "$SERVER_NEXT" ] && mv "$SERVER_NEXT" "$BACKUP_DIR/server-dist-next" || true
  [ -d "$DASHBOARD_NEXT" ] && mv "$DASHBOARD_NEXT" "$BACKUP_DIR/dashboard-dist-next" || true
  "$INSTALL_DIR/bin/agentmanager" restart >/dev/null 2>&1 || true
  log_info "Previous build restored and service restart requested. Recovery artifacts: $BACKUP_DIR"
  exit 1
}

log_info "Staging build output..."
cp -R "$SRC_DIR/server/dist" "$SERVER_NEXT"
cp -R "$SRC_DIR/dashboard/dist" "$DASHBOARD_NEXT"

log_info "Switching build output..."
mv "$INSTALL_DIR/server/dist" "$SERVER_PREVIOUS"
mv "$SERVER_NEXT" "$INSTALL_DIR/server/dist"
mv "$INSTALL_DIR/dashboard/dist" "$DASHBOARD_PREVIOUS"
mv "$DASHBOARD_NEXT" "$INSTALL_DIR/dashboard/dist"

log_info "Restarting service..."
if ! "$INSTALL_DIR/bin/agentmanager" restart; then
  rollback "service restart failed"
fi

log_info "Checking health on port $PORT..."
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log_ok "Deploy complete from $SRC_DIR"
    log_info "Processed commit: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done

rollback "health check did not recover within 30 seconds"
