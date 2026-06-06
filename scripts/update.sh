#!/usr/bin/env bash
# AgentManager Update Script
# Pulls latest changes and rebuilds.
#
# Usage:
#   agentmanager update
#   bash scripts/update.sh

set -euo pipefail

# Find AgentManager installation directory
if [ -z "${AGENTMANAGER_DIR:-}" ]; then
  for candidate in "$HOME/agentmanager" "/opt/agentmanager"; do
    if [ -d "$candidate/.git" ]; then
      AGENTMANAGER_DIR="$candidate"
      break
    fi
  done
fi

if [ -z "${AGENTMANAGER_DIR:-}" ] || [ ! -d "$AGENTMANAGER_DIR" ]; then
  echo "[AgentManager] Error: Cannot find AgentManager installation directory"
  exit 1
fi

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[AgentManager]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[AgentManager]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[AgentManager]${NC} $1"; }
log_error() { echo -e "${RED}[AgentManager]${NC} $1"; }

cd "$AGENTMANAGER_DIR"

# Get current and target versions
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
CURRENT_HASH=$(git rev-parse --short HEAD)

log_info "Updating AgentManager ($CURRENT_BRANCH @ $CURRENT_HASH)..."

# Pull latest
git fetch origin
git pull origin "$CURRENT_BRANCH"

NEW_HASH=$(git rev-parse --short HEAD)
if [ "$CURRENT_HASH" = "$NEW_HASH" ]; then
  log_ok "Already up to date ($CURRENT_HASH)"
  exit 0
fi

log_info "Updated $CURRENT_HASH → $NEW_HASH"

# Rebuild server
log_info "Rebuilding server..."
cd "$AGENTMANAGER_DIR/server"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1
npm prune --production 2>&1 | tail -1
log_ok "Server rebuilt"

# Rebuild dashboard
log_info "Rebuilding dashboard..."
cd "$AGENTMANAGER_DIR/dashboard"
npm install 2>&1 | tail -1
npm run build 2>&1 | tail -1
log_ok "Dashboard rebuilt"

# Restart server — service-managed or manual.
if [ "$(uname -s)" = "Linux" ] && systemctl is-active --quiet agentmanager 2>/dev/null; then
  log_info "Restarting systemd service..."
  sudo systemctl restart agentmanager
  log_ok "Service restarted"
elif [ "$(uname -s)" = "Darwin" ] && launchctl list com.aigenius.agentmanager &>/dev/null; then
  log_info "Restarting launchd service..."
  launchctl stop com.aigenius.agentmanager 2>/dev/null || true
  launchctl start com.aigenius.agentmanager 2>/dev/null || true
  log_ok "Service restarted"
else
  # Manual/CLI-managed. The hardened cmd_stop in bin/agentmanager clears the user's
  # configured port even when the PID file is stale, and cmd_start preflight-
  # checks the port so silent port-bind failures surface as clear errors.
  CLI_PATH="$(command -v agentmanager 2>/dev/null || echo "$AGENTMANAGER_DIR/bin/agentmanager")"
  log_info "Restarting server..."
  "$CLI_PATH" stop 2>/dev/null || true
  "$CLI_PATH" start 2>/dev/null || true
  log_ok "Server restarted"
fi

log_ok "Update complete ($CURRENT_HASH → $NEW_HASH)"
exit 0
