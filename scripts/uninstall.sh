#!/usr/bin/env bash
# AgentManager Uninstaller
# Removes AgentManager, its config, CLI, desktop app, shell functions, and external configs.
#
# Usage:
#   bash scripts/uninstall.sh
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/agentmanager/main/scripts/uninstall.sh | bash
#
# Options:
#   --keep-data    Keep ~/.agentmanager (database, projects, config)
#   --yes          Skip confirmation prompt

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[AgentManager]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[AgentManager]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[AgentManager]${NC} $1"; }

KEEP_DATA=false
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --keep-data) KEEP_DATA=true ;;
    --yes|-y)    SKIP_CONFIRM=true ;;
  esac
done

# Detect target user (same logic as installer)
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  SUDO="sudo"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
  SUDO=""
  if [ "$(id -u)" -ne 0 ] && [ ! -w "/usr/local/bin" ]; then
    SUDO="sudo"
  fi
fi

INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$TARGET_HOME/agentmanager}"
CONFIG_DIR="$TARGET_HOME/.agentmanager"

echo ""
echo -e "${BOLD}AgentManager Uninstaller${NC}"
echo ""
echo "This will remove:"
echo "  - Install directory: $INSTALL_DIR"
if [ "$KEEP_DATA" = false ]; then
  echo "  - Config & database: $CONFIG_DIR"
else
  echo "  - Config & database: $CONFIG_DIR (KEEPING — --keep-data)"
fi
echo "  - CLI symlink"
echo "  - Shell function from .bashrc/.zshrc"
echo "  - Desktop app (if installed)"
echo "  - Espanso config for AgentManager (if present)"
echo ""

if [ "$SKIP_CONFIRM" = false ] && [ -e /dev/tty ]; then
  echo -n "Continue? [y/N]: "
  read -r answer < /dev/tty 2>/dev/null || answer="n"
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

# --- Stop server --------------------------------------------------------------

for pid_file in "$INSTALL_DIR/.agentmanager.pid"; do
  if [ -f "$pid_file" ]; then
    pid=$(cat "$pid_file" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi
done

# Also try the CLI stop command
for bin in "/usr/local/bin/agentmanager" "$TARGET_HOME/.local/bin/agentmanager" "$INSTALL_DIR/bin/agentmanager"; do
  if [ -x "$bin" ]; then
    "$bin" stop 2>/dev/null || true
    break
  fi
done

# --- Remove CLI symlinks -------------------------------------------------------

for link in "/usr/local/bin/agentmanager" "$TARGET_HOME/.local/bin/agentmanager"; do
  if [ -L "$link" ] || [ -f "$link" ]; then
    log_info "Removing CLI symlink: $link"
    $SUDO rm -f "$link" 2>/dev/null || rm -f "$link" 2>/dev/null || true
  fi
done

# --- Remove shell function from .bashrc / .zshrc ------------------------------

# Remove all AgentManager shell functions (current + old hivemind form)
FUNC_MARKER_AGENTMANAGER="# AgentManager session launcher function"
FUNC_END_AGENTMANAGER="# end-agentmanager-session"
FUNC_MARKER_AGENTMANAGER_OLD="# AgentManager hivemind launcher function"
FUNC_END_AGENTMANAGER_OLD="# end-agentmanager-hivemind"

remove_shell_func() {
  local rc_file="$1"
  [ -f "$rc_file" ] || return 0

  # Remove current AgentManager function
  if grep -q "$FUNC_MARKER_AGENTMANAGER" "$rc_file" 2>/dev/null; then
    if grep -q "$FUNC_END_AGENTMANAGER" "$rc_file" 2>/dev/null; then
      sed -i "/$FUNC_MARKER_AGENTMANAGER/,/$FUNC_END_AGENTMANAGER/d" "$rc_file"
    else
      sed -i "/$FUNC_MARKER_AGENTMANAGER/,/^}/d" "$rc_file"
    fi
    log_ok "Removed AgentManager shell function from $(basename "$rc_file")"
  fi

  # Remove old AgentManager hivemind function
  if grep -q "$FUNC_MARKER_AGENTMANAGER_OLD" "$rc_file" 2>/dev/null; then
    if grep -q "$FUNC_END_AGENTMANAGER_OLD" "$rc_file" 2>/dev/null; then
      sed -i "/$FUNC_MARKER_AGENTMANAGER_OLD/,/$FUNC_END_AGENTMANAGER_OLD/d" "$rc_file"
    else
      sed -i "/$FUNC_MARKER_AGENTMANAGER_OLD/,/^}/d" "$rc_file"
    fi
    log_ok "Removed old AgentManager hivemind function from $(basename "$rc_file")"
  fi

  # Remove orphaned end marker
  if grep -q "$FUNC_END_AGENTMANAGER" "$rc_file" 2>/dev/null && ! grep -q "$FUNC_MARKER_AGENTMANAGER" "$rc_file" 2>/dev/null; then
    sed -i "/^trap _cleanup EXIT INT TERM/,/$FUNC_END_AGENTMANAGER/d" "$rc_file"
  fi

  # Remove PATH additions from the installer
  if grep -q "# Added by AgentManager installer" "$rc_file" 2>/dev/null; then
    sed -i "/# Added by AgentManager installer/d" "$rc_file"
    log_ok "Removed PATH entry from $(basename "$rc_file")"
  fi
  sed -i '\|export PATH=.*\.local/bin.*agentmanager|d' "$rc_file" 2>/dev/null || true
}

remove_shell_func "$TARGET_HOME/.bashrc"
remove_shell_func "$TARGET_HOME/.zshrc"

# --- Remove espanso config ----------------------------------------------------

espanso_file="$TARGET_HOME/.config/espanso/config/agentmanager.yml"
if [ -f "$espanso_file" ]; then
  log_info "Removing espanso config: $espanso_file"
  rm -f "$espanso_file"
  log_ok "Espanso config removed"
fi

# --- Remove install directory --------------------------------------------------

if [ -d "$INSTALL_DIR" ]; then
  log_info "Removing install directory: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  log_ok "Install directory removed"
fi

# --- Remove config/data directory ----------------------------------------------

_remove_config_dir() {
  local dir="$1"
  local label="$2"
  [ -d "$dir" ] || return 0

  if [ "$KEEP_DATA" = true ]; then
    log_info "Keeping $label: $dir (--keep-data)"
  elif [ "$SKIP_CONFIRM" = true ]; then
    log_info "Removing $label: $dir"
    rm -rf "$dir"
    log_ok "$label removed"
  elif [ -e /dev/tty ]; then
    echo ""
    echo -e "${YELLOW}Your projects, sessions, and database are stored in:${NC}"
    echo "  $dir"
    echo ""
    echo "Keep this data? (You can reinstall later and pick up where you left off)"
    echo -n "Keep $label? [Y/n]: "
    read -r answer < /dev/tty 2>/dev/null || answer="y"
    case "$answer" in
      [nN]|[nN][oO])
        log_info "Removing $label: $dir"
        rm -rf "$dir"
        log_ok "$label removed"
        ;;
      *)
        KEEP_DATA=true
        log_ok "$label preserved"
        ;;
    esac
  else
    KEEP_DATA=true
    log_info "Keeping $label (run with --yes to remove, or --keep-data to silence this)"
  fi
}

_remove_config_dir "$CONFIG_DIR" "config & database"

# --- Done ----------------------------------------------------------------------

echo ""
echo -e "${GREEN}${BOLD}AgentManager has been uninstalled.${NC}"
if [ "$KEEP_DATA" = true ]; then
  echo ""
  echo "  Your data is preserved at: $CONFIG_DIR"
  echo "  To remove it later: rm -rf $CONFIG_DIR"
fi
echo ""
