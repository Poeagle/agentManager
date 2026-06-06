#!/usr/bin/env bash
# AgentManager Installer
# Downloads a pre-built release, extracts it, and starts the server.
#
# Prerequisites:
#   - Node.js 20+    https://nodejs.org
#   - Claude Code     npm install -g @anthropic-ai/claude-code
#
# IMPORTANT: You must run `claude` at least once and accept the terms before
# installing AgentManager. Sessions require non-interactive mode, so you must also
# run: claude --dangerously-skip-permissions
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ai-genius-automations/agentmanager/main/scripts/install.sh | bash
#   AGENTMANAGER_VERSION=0.1.0 bash install.sh
#   AGENTMANAGER_INSTALL_DIR=/opt/agentmanager bash install.sh
#
# For private repos / pre-release testing:
#   AGENTMANAGER_ARCHIVE_URL="https://example.com/agentmanager-v0.1.0.tar.gz" bash install.sh

set -euo pipefail

INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$HOME/agentmanager}"
GITHUB_REPO="${AGENTMANAGER_GITHUB_REPO:-ai-genius-automations/agentmanager}"
VERSION="${AGENTMANAGER_VERSION:-latest}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# Build auth header array for curl (used for private repo access)
AUTH_HEADER=()
if [ -n "$GITHUB_TOKEN" ]; then
  AUTH_HEADER=(-H "Authorization: token $GITHUB_TOKEN")
fi

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
log_error() { echo -e "${RED}[AgentManager]${NC} $1"; }
log_step()  { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=5

# Detect the target user (if running as root via sudo, install for the real user)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  TARGET_USER="$SUDO_USER"
  TARGET_HOME=$(eval echo "~$SUDO_USER")
  INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$TARGET_HOME/agentmanager}"
elif [ "$(id -u)" -eq 0 ]; then
  TARGET_USER="root"
  TARGET_HOME="$HOME"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
fi

OS="$(uname -s)"

# Use sudo for system commands when not running as root
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo &>/dev/null; then
    SUDO="sudo"
  fi
fi

# --- Step 1: Check prerequisites ---------------------------------------------

log_step 1 "Checking prerequisites..."

# Helper: prompt user to install something or exit
# Works even when piped (curl | bash) by reading from /dev/tty
prompt_install() {
  local name="$1"
  local install_msg="$2"
  if [ -e /dev/tty ]; then
    echo ""
    echo -n "  $name is required. Install it now? [Y/n]: "
    read -r answer < /dev/tty 2>/dev/null || answer="y"
    case "$answer" in
      [nN]|[nN][oO])
        log_error "$name is required to continue. Install it and re-run this installer."
        exit 1
        ;;
    esac
    return 0  # user said yes
  else
    # Truly non-interactive (no terminal at all)
    log_error "$name is required but not installed."
    echo ""
    echo "  $install_msg"
    echo "  Then re-run this installer."
    echo ""
    exit 1
  fi
}

# Check Node.js
NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    NEED_NODE=true
    log_warn "Node.js $NODE_MAJOR found but 20+ is required"
  fi
fi

if [ "$NEED_NODE" = true ]; then
  prompt_install "Node.js 20+" "Install from: https://nodejs.org"
  log_info "Installing Node.js 22..."
  case "$OS" in
    Linux*)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq ca-certificates curl gnupg
      $SUDO mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | $SUDO tee /etc/apt/sources.list.d/nodesource.list > /dev/null
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq nodejs
      ;;
    Darwin*)
      if command -v brew &>/dev/null; then
        brew install node 2>&1 || true
      else
        log_error "Cannot auto-install Node.js without Homebrew. Install from https://nodejs.org"
        exit 1
      fi
      ;;
    *)
      log_error "Cannot auto-install Node.js on this OS. Install from https://nodejs.org"
      exit 1
      ;;
  esac
  if ! command -v node &>/dev/null; then
    log_error "Node.js installation failed. Install manually from https://nodejs.org"
    exit 1
  fi
  log_ok "Node.js $(node -v) installed"
fi

# Check Claude Code
if ! command -v claude &>/dev/null; then
  prompt_install "Claude Code" "Install with: npm install -g @anthropic-ai/claude-code"
  log_info "Installing Claude Code..."
  if [ "$OS" = "Darwin" ]; then
    npm install -g @anthropic-ai/claude-code 2>&1 || true
  else
    $SUDO npm install -g @anthropic-ai/claude-code 2>&1 || true
  fi
  if ! command -v claude &>/dev/null; then
    log_error "Claude Code installation failed. Install manually: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  log_ok "Claude Code $(claude --version 2>/dev/null || echo 'installed')"
fi

# Check if Claude Code has been run with --dangerously-skip-permissions
# This is required for AgentManager to run non-interactive agent sessions.
# The flag creates a config entry that persists — only needs to be run once.
CLAUDE_CONFIG_DIR="${HOME}/.claude"
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  CLAUDE_CONFIG_DIR="$TARGET_HOME/.claude"
fi

CLAUDE_INITIALIZED=false
if [ -d "$CLAUDE_CONFIG_DIR" ]; then
  # Check if settings or any config file indicates permissions were accepted
  if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ] || [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then
    CLAUDE_INITIALIZED=true
  fi
fi

if [ "$CLAUDE_INITIALIZED" = false ]; then
  log_warn "Claude Code has not been initialized yet."
  echo ""
  echo "  AgentManager requires Claude Code to be set up with non-interactive permissions."
  echo "  You need to run these commands (as your user, not root):"
  echo ""
  echo "    1. claude                              # Accept terms & sign in"
  echo "    2. claude --dangerously-skip-permissions  # Enable non-interactive mode"
  echo ""
  if [ -e /dev/tty ]; then
    echo -n "  Have you already done this? [y/N]: "
    read -r answer < /dev/tty 2>/dev/null || answer="n"
    case "$answer" in
      [yY]|[yY][eE][sS])
        log_info "Continuing with install..."
        ;;
      *)
        echo ""
        log_info "Please run the commands above first, then re-run this installer."
        echo ""
        echo "  Quick setup:"
        echo "    claude                                 # Accept terms & sign in"
        echo "    claude --dangerously-skip-permissions   # Enable non-interactive mode"
        echo "    # Then re-run this installer"
        echo ""
        exit 1
        ;;
    esac
  else
    log_error "Run 'claude' and 'claude --dangerously-skip-permissions' first, then re-run this installer."
    exit 1
  fi
fi

# Install runtime deps if missing (tmux, dtach, curl, build tools)
NEEDED=()
command -v tmux &>/dev/null  || NEEDED+=(tmux)
command -v dtach &>/dev/null || NEEDED+=(dtach)
command -v curl &>/dev/null  || NEEDED+=(curl)

case "$OS" in
  Linux*)
    command -v make &>/dev/null || NEEDED+=(build-essential)
    command -v g++ &>/dev/null  || NEEDED+=(build-essential)
    # Deduplicate
    if [ ${#NEEDED[@]} -gt 0 ]; then
      NEEDED=($(echo "${NEEDED[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))
      log_info "Installing: ${NEEDED[*]}..."
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq "${NEEDED[@]}"
    fi
    ;;
  Darwin*)
    if [ ${#NEEDED[@]} -gt 0 ] && command -v brew &>/dev/null; then
      log_info "Installing: ${NEEDED[*]}..."
      brew install "${NEEDED[@]}" 2>&1 || true
    fi
    ;;
esac

NODE_VER="$(node -v 2>/dev/null || echo 'not found')"
CLAUDE_VER="$(claude --version 2>/dev/null || echo 'ok')"
log_ok "Prerequisites met (Node ${NODE_VER}, Claude Code ${CLAUDE_VER})"

# --- Step 2: Download release ------------------------------------------------

log_step 2 "Downloading AgentManager..."

ARCHIVE_URL="${AGENTMANAGER_ARCHIVE_URL:-}"

if [ -z "$ARCHIVE_URL" ]; then
  # Resolve version from GitHub Releases API
  if [ "$VERSION" = "latest" ]; then
    log_info "Fetching latest release from GitHub..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || echo "")
    if [ -z "$RELEASE_INFO" ]; then
      RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases" 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
          try{const a=JSON.parse(d);if(a[0])console.log(JSON.stringify(a[0]))}catch{}
        })' 2>/dev/null || echo "")
    fi
    if [ -z "$RELEASE_INFO" ]; then
      log_error "No releases found. Set AGENTMANAGER_ARCHIVE_URL to install from a direct URL."
      exit 1
    fi
    VERSION=$(echo "$RELEASE_INFO" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).tag_name.replace(/^v/,""))}catch{process.exit(1)}})' 2>/dev/null)
  elif [ -n "$GITHUB_TOKEN" ]; then
    # Explicit version with token — fetch release info for API asset URL (CDN won't work for private repos)
    log_info "Fetching release v${VERSION} from GitHub API..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/tags/v${VERSION}" 2>/dev/null || echo "")
  fi

  # For private repos, extract the API asset URL (browser_download_url / CDN won't work with token)
  if [ -n "$GITHUB_TOKEN" ] && [ -n "${RELEASE_INFO:-}" ]; then
    ARCHIVE_URL=$(echo "$RELEASE_INFO" | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        try{const r=JSON.parse(d);const a=(r.assets||[]).find(x=>x.name.endsWith(".tar.gz"));
        if(a)console.log(a.url);else process.exit(1)}catch{process.exit(1)}
      })' 2>/dev/null || echo "")
  fi

  if [ -z "$ARCHIVE_URL" ]; then
    ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/agentmanager-v${VERSION}.tar.gz"
  fi
fi

TMPFILE=$(mktemp)
log_info "Downloading $ARCHIVE_URL..."
if ! curl -fSL "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" --progress-bar -o "$TMPFILE" "$ARCHIVE_URL" 2>&1; then
  rm -f "$TMPFILE"
  log_error "Download failed. Check the URL or version and try again."
  exit 1
fi

log_ok "Downloaded ($(du -h "$TMPFILE" | cut -f1))"

# --- Step 3: Extract and install ---------------------------------------------

log_step 3 "Installing to $INSTALL_DIR..."

# Stop existing server if running — try PID file first, then CLI, then pkill.
_stop_pid_file() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping existing server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}
_stop_pid_file "$INSTALL_DIR/.agentmanager.pid"
# Fallback: use CLI stop if available
if command -v agentmanager &>/dev/null; then
  agentmanager stop 2>/dev/null || true
fi
# Fallback: kill any remaining server process on our port. Respect a
# user-customized port — read from existing server/.env or settings DB before
# the extraction replaces $INSTALL_DIR. Falls back to 42010.
_resolve_install_port() {
  local default_port=42010
  if [ -n "${PORT:-}" ] && [[ "${PORT}" =~ ^[0-9]+$ ]]; then echo "$PORT"; return; fi
  local env_file="$INSTALL_DIR/server/.env"
  if [ -f "$env_file" ]; then
    local p
    p=$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$env_file" 2>/dev/null | tail -1 \
        | sed -E 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//; s/^["'"'"']//; s/["'"'"'][[:space:]]*$//; s/[[:space:]]*$//' || true)
    if [[ "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  local db="$TARGET_HOME/.agentmanager/agentmanager.db"
  if [ -f "$db" ]; then
    local p=""
    if command -v sqlite3 >/dev/null 2>&1; then
      p=$(sqlite3 "$db" "SELECT value FROM settings WHERE key='server_port' LIMIT 1;" 2>/dev/null || true)
    elif command -v node >/dev/null 2>&1 && [ -d "$INSTALL_DIR/server/node_modules/better-sqlite3" ]; then
      p=$(DB="$db" NM="$INSTALL_DIR/server/node_modules" node -e '
        try { const D=require(process.env.NM+"/better-sqlite3");
          const db=new D(process.env.DB,{readonly:true,fileMustExist:true});
          const r=db.prepare("SELECT value FROM settings WHERE key=?").get("server_port");
          db.close(); if(r&&r.value) process.stdout.write(String(r.value));
        } catch(e){}' 2>/dev/null || true)
    fi
    if [[ "$p" =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  fi
  echo "$default_port"
}
KILL_PORT="$(_resolve_install_port)"
# Linux uses GNU fuser (-s/-k/port/tcp). macOS ships a totally different
# `fuser` that takes -cfu and file paths only — invoking it with Linux
# syntax prints the macOS usage banner. Gate fuser on Linux and let
# Darwin (and other BSDs) fall through to lsof.
if [ "$OS" = "Linux" ] && command -v fuser &>/dev/null; then
  if fuser -s "${KILL_PORT}/tcp" 2>/dev/null; then
    log_info "Force-stopping process on port ${KILL_PORT}..."
    fuser -k -TERM "${KILL_PORT}/tcp" 2>/dev/null || true
    sleep 1
    fuser -s "${KILL_PORT}/tcp" 2>/dev/null && fuser -k -KILL "${KILL_PORT}/tcp" 2>/dev/null || true
  fi
elif command -v lsof &>/dev/null; then
  pids="$(lsof -ti "tcp:${KILL_PORT}" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    log_info "Force-stopping process on port ${KILL_PORT}..."
    echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti "tcp:${KILL_PORT}" 2>/dev/null || true)"
    [ -n "$pids" ] && echo "$pids" | xargs -r kill -KILL 2>/dev/null || true
  fi
fi

# Catch stale agentmanager servers the port-based kill above missed. Port-based
# detection is blind to any prior install bound to a non-default port — a
# leftover server on 42011 (old default) or a dev-mode PORT=42012 survives
# every subsequent upgrade. Mirrors agentmanager-pro's _kill_stale_pro_servers.
#
# CRITICAL: match "agentmanager/server" WITHOUT matching "agentmanager-pro/server".
# Pro is a separate app with its own installer; we must never touch it. Every
# pattern below either explicitly excludes "agentmanager-pro" or uses a case
# ordering that short-circuits on it first. Verified against a machine running
# both apps before shipping.
_kill_stale_agentmanager_servers() {
  local target_uid
  target_uid=$(id -u "$TARGET_USER" 2>/dev/null || echo "")
  [ -z "$target_uid" ] && return 0

  local pids=""

  # Pattern 1: pgrep cmdline match, then explicitly filter out Pro cmdlines.
  # pgrep's regex doesn't do negative lookahead, so we post-filter instead.
  if command -v pgrep >/dev/null 2>&1; then
    for pid in $(pgrep -u "$target_uid" -f 'agentmanager/server/dist/index\.js' 2>/dev/null); do
      local cl
      cl=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo '')
      case "$cl" in
        *agentmanager-pro*) continue ;;
      esac
      pids="$pids $pid"
    done
  fi

  # Pattern 2: Linux /proc/cwd — case ordering matters. Pro exclusion fires
  # FIRST so "*/agentmanager-pro/server/*" short-circuits before it could match
  # "*/agentmanager/server/*".
  if [ -d /proc ]; then
    for pid_dir in /proc/[0-9]*; do
      local pid="${pid_dir##*/}"
      [ "$pid" = "$$" ] && continue
      [ "$pid" = "$PPID" ] && continue
      local p_uid
      p_uid=$(stat -c %u "$pid_dir" 2>/dev/null || echo "-1")
      [ "$p_uid" = "$target_uid" ] || continue
      local cwd
      cwd=$(readlink "$pid_dir/cwd" 2>/dev/null || true)
      case "$cwd" in
        */agentmanager-pro/*) continue ;;
        */agentmanager/server|*/agentmanager/server/*) ;;
        *) continue ;;
      esac
      local cmdline
      cmdline=$(tr '\0' ' ' < "$pid_dir/cmdline" 2>/dev/null || true)
      case "$cmdline" in
        *pty-worker*) continue ;;
        *agentmanager-pro*) continue ;;
        *node*dist/index.js*) pids="$pids $pid" ;;
      esac
    done
  fi

  pids=$(echo "$pids" | tr ' ' '\n' | sort -u | grep -v '^$' || true)
  [ -z "$pids" ] && return 0

  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    log_info "Stopping stale agentmanager server (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}
_kill_stale_agentmanager_servers

# Extract
EXTRACT_DIR=$(mktemp -d)
tar xzf "$TMPFILE" -C "$EXTRACT_DIR"
rm -f "$TMPFILE"

EXTRACTED=$(ls -d "$EXTRACT_DIR"/agentmanager-* 2>/dev/null | head -1)
if [ -z "$EXTRACTED" ] || [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain expected agentmanager-vX.Y.Z directory"
  rm -rf "$EXTRACT_DIR"
  exit 1
fi

# Preserve user data from existing install
if [ -d "$INSTALL_DIR" ]; then
  for keep in logs .agentmanager .agentmanager.pid; do
    [ -e "$INSTALL_DIR/$keep" ] && cp -r "$INSTALL_DIR/$keep" "$EXTRACT_DIR/_keep_$keep" 2>/dev/null || true
  done
  rm -rf "$INSTALL_DIR"
fi

mv "$EXTRACTED" "$INSTALL_DIR"

for keep in logs .agentmanager .agentmanager.pid; do
  [ -e "$EXTRACT_DIR/_keep_$keep" ] && mv "$EXTRACT_DIR/_keep_$keep" "$INSTALL_DIR/$keep" 2>/dev/null || true
done
rm -rf "$EXTRACT_DIR"

mkdir -p "$INSTALL_DIR/logs"

# Read version from installed package
if [ -f "$INSTALL_DIR/version.json" ]; then
  VERSION=$(node -e "console.log(require('$INSTALL_DIR/version.json').version)" 2>/dev/null || echo "$VERSION")
fi

# Install server production dependencies (native modules compile on this platform)
# Reset CWD — the old $INSTALL_DIR was deleted and replaced above, so the shell's
# working directory may no longer exist (causes npm "uv_cwd" ENOENT).
cd "$INSTALL_DIR" || cd /
log_info "Installing server dependencies..."
if ! npm install --omit=dev --prefix "$INSTALL_DIR/server" 2>&1; then
  # On Node 22+, node-gyp 11.x has a known post-build ENOENT on
  # `build/node_gyp_bins` that exits non-zero even when the native module
  # actually built successfully. If better-sqlite3 and node-pty load, the
  # install is functionally complete — accept it and continue.
  if (cd "$INSTALL_DIR/server" \
       && node -e "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')") >/dev/null 2>&1; then
    log_warn "npm install exited non-zero, but native modules load — continuing"
  else
    log_error "npm install failed — see errors above"
    exit 1
  fi
fi

log_ok "AgentManager v${VERSION} installed to $INSTALL_DIR"

# --- Step 4: Install CLI -----------------------------------------------------

log_step 4 "Installing CLI..."

chmod +x "$INSTALL_DIR/bin/agentmanager"

# Always install to ~/.local/bin (no sudo needed)
LINK_DIR="$TARGET_HOME/.local/bin"
mkdir -p "$LINK_DIR"
ln -sf "$INSTALL_DIR/bin/agentmanager" "$LINK_DIR/agentmanager"

# Also symlink to /usr/local/bin if writable (no sudo needed) or if sudo already active
if [ -w "/usr/local/bin" ]; then
  ln -sf "$INSTALL_DIR/bin/agentmanager" "/usr/local/bin/agentmanager" 2>/dev/null || true
fi

# Add ~/.local/bin to PATH if not already there. Update every shell rc
# file that exists so the PATH works regardless of which shell the user
# actually launches. The old "first match wins, .bashrc first" logic
# silently failed on macOS users who had a stray .bashrc but used zsh —
# the export landed in .bashrc and zsh never sourced it, leaving
# `agentmanager` invisible despite a successful install.
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LINK_DIR"; then
  EXPORT_LINE='export PATH="$HOME/.local/bin:$PATH"'
  TOUCHED_ANY=false
  for rc in "$TARGET_HOME/.zshrc" "$TARGET_HOME/.bashrc" "$TARGET_HOME/.bash_profile" "$TARGET_HOME/.profile"; do
    if [ -f "$rc" ]; then
      TOUCHED_ANY=true
      if ! grep -q '.local/bin' "$rc" 2>/dev/null; then
        echo "$EXPORT_LINE" >> "$rc"
        log_info "Added ~/.local/bin to PATH in $(basename "$rc")"
      fi
    fi
  done
  if [ "$TOUCHED_ANY" = false ]; then
    # No rc files exist — create the OS-default so the next shell picks it up.
    case "$OS" in
      Darwin*) DEFAULT_RC="$TARGET_HOME/.zshrc" ;;
      *)       DEFAULT_RC="$TARGET_HOME/.bashrc" ;;
    esac
    echo "$EXPORT_LINE" >> "$DEFAULT_RC"
    if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
      chown "$TARGET_USER:$TARGET_USER" "$DEFAULT_RC" 2>/dev/null || true
    fi
    log_info "Created $(basename "$DEFAULT_RC") with ~/.local/bin in PATH"
  fi
  export PATH="$LINK_DIR:$PATH"
fi

# Fix ownership if running as root for another user
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  log_info "Setting ownership to $TARGET_USER..."
  chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

log_ok "CLI: $LINK_DIR/agentmanager"

# --- Step 5: Start server ----------------------------------------------------

log_step 5 "Starting AgentManager..."

# Start (as target user if we're root)
if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
  su - "$TARGET_USER" -c "PATH=\"$LINK_DIR:\$PATH\" agentmanager start"
else
  "$LINK_DIR/agentmanager" start
fi

# --- Step 5b: Install agentmanager shell function ----------------------------

# Shell function for launching Claude Code sessions from the terminal.
# Works in bash and zsh, on Linux and macOS.

AGENTMANAGER_FUNC_MARKER="# AgentManager session launcher function"
AGENTMANAGER_FUNC_END="# end-agentmanager-session"
AGENTMANAGER_FUNC_BODY='agentmanager() {
  local DEFAULT_PROMPT="start up and then ask me what I want you to do. DO NOT DO ANYTHING ELSE, NO TASKS! Just initialize and then prompt me"
  local prompt="${*:-$DEFAULT_PROMPT}"

  if [ "$PWD" = "$HOME" ]; then
    echo "Note: Claude Code always prompts for workspace trust when run from your home directory. cd into a project to skip this."
  fi

  claude "$prompt"
} '"$AGENTMANAGER_FUNC_END"

# Cross-platform sed -i (BSD sed on macOS requires -i '', GNU sed does not)
_sed_i() {
  if [ "$OS" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Legacy markers for cleanup (old hivemind versions)
LEGACY_MARKERS=(
  "# AgentManager hivemind launcher function|# end-agentmanager-hivemind"
)

_install_shell_func() {
  local RC_FILE="$1"
  [ ! -f "$RC_FILE" ] && return

  # Remove all legacy versions (old AgentManager hivemind)
  for marker_pair in "${LEGACY_MARKERS[@]}"; do
    local START="${marker_pair%%|*}"
    local END="${marker_pair##*|}"
    if grep -q "$START" "$RC_FILE" 2>/dev/null; then
      if grep -q "$END" "$RC_FILE" 2>/dev/null; then
        _sed_i "/$START/,/$END/d" "$RC_FILE"
      else
        _sed_i "/$START/,/^}/d" "$RC_FILE"
      fi
    fi
    # Self-heal orphaned tails
    if grep -q "$END" "$RC_FILE" 2>/dev/null && \
       ! grep -q "$START" "$RC_FILE" 2>/dev/null; then
      _sed_i "/^trap _cleanup EXIT INT TERM/,/$END/d" "$RC_FILE"
      _sed_i '/^$/N;/^\n$/N;/^\n\n$/N;/^\n\n\n$/d' "$RC_FILE"
    fi
  done

  # Remove old AgentManager session version if exists
  if grep -q "$AGENTMANAGER_FUNC_MARKER" "$RC_FILE" 2>/dev/null; then
    if grep -q "$AGENTMANAGER_FUNC_END" "$RC_FILE" 2>/dev/null; then
      _sed_i "/$AGENTMANAGER_FUNC_MARKER/,/$AGENTMANAGER_FUNC_END/d" "$RC_FILE"
    else
      _sed_i "/$AGENTMANAGER_FUNC_MARKER/,/^}/d" "$RC_FILE"
    fi
  fi

  echo "" >> "$RC_FILE"
  echo "$AGENTMANAGER_FUNC_MARKER" >> "$RC_FILE"
  echo "$AGENTMANAGER_FUNC_BODY" >> "$RC_FILE"
  log_ok "Installed agentmanager() shell function in $(basename "$RC_FILE")"
}

_install_shell_func "$TARGET_HOME/.bashrc"
_install_shell_func "$TARGET_HOME/.zshrc"

# --- Done --------------------------------------------------------------------

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  AgentManager v${VERSION} installed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Dashboard${NC}   http://localhost:42010"
echo -e "  ${BOLD}CLI${NC}         $LINK_DIR/agentmanager"
echo -e "  ${BOLD}Install${NC}     $INSTALL_DIR"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    agentmanager                   Launch Claude Code session"
echo "    agentmanager status            Check status"
echo "    agentmanager stop / start      Stop or start the server"
echo "    agentmanager update            Update to latest release"
echo "    agentmanager install-service   Auto-start on boot"
echo ""
