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
#   AGENTMANAGER_VERSION=0.1.0 \
#   AGENTMANAGER_ARCHIVE_URL="https://example.com/agentmanager-v0.1.0.tar.gz" \
#   AGENTMANAGER_ARCHIVE_SHA256="<64 hex characters>" bash install.sh
# Custom archives require an explicit checksum. To intentionally install an
# unverifiable development artifact, set AGENTMANAGER_ALLOW_UNVERIFIED=1.

set -euo pipefail

INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$HOME/agentmanager}"
GITHUB_REPO="${AGENTMANAGER_GITHUB_REPO:-ai-genius-automations/agentmanager}"
VERSION="${AGENTMANAGER_VERSION:-latest}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
ARCHIVE_SHA256="${AGENTMANAGER_ARCHIVE_SHA256:-}"
CHECKSUM_URL="${AGENTMANAGER_CHECKSUM_URL:-}"
ALLOW_UNVERIFIED="${AGENTMANAGER_ALLOW_UNVERIFIED:-0}"

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
  if command -v getent >/dev/null 2>&1; then
    TARGET_HOME=$(getent passwd "$SUDO_USER" | awk -F: 'NR==1 { print $6 }')
  elif command -v dscl >/dev/null 2>&1; then
    TARGET_HOME=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk 'NR==1 { print $2 }')
  else
    TARGET_HOME=""
  fi
  if [ -z "$TARGET_HOME" ] || [ ! -d "$TARGET_HOME" ]; then
    echo "Cannot determine home directory for $SUDO_USER" >&2
    exit 1
  fi
  INSTALL_DIR="${AGENTMANAGER_INSTALL_DIR:-$TARGET_HOME/agentmanager}"
elif [ "$(id -u)" -eq 0 ]; then
  TARGET_USER="root"
  TARGET_HOME="$HOME"
else
  TARGET_USER="$(whoami)"
  TARGET_HOME="$HOME"
fi

validate_version() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]
}

canonicalize_install_dir() {
  local requested="$1"
  local parent leaf
  parent=$(dirname "$requested")
  leaf=$(basename "$requested")
  [ -n "$leaf" ] && [ "$leaf" != "." ] && [ "$leaf" != ".." ] || return 1
  mkdir -p "$parent"
  parent=$(cd "$parent" && pwd -P)
  INSTALL_DIR="$parent/$leaf"
  [ "$INSTALL_DIR" != "/" ] && [ "$INSTALL_DIR" != "$TARGET_HOME" ]
}

if ! canonicalize_install_dir "$INSTALL_DIR"; then
  echo "Unsafe install directory: $INSTALL_DIR" >&2
  exit 1
fi
if [ -e "$INSTALL_DIR" ] &&
   { [ ! -d "$INSTALL_DIR" ] || [ ! -f "$INSTALL_DIR/version.json" ] ||
     [ ! -f "$INSTALL_DIR/bin/agentmanager" ] || [ ! -d "$INSTALL_DIR/server" ]; }; then
  echo "Refusing to replace a path that is not an AgentManager installation: $INSTALL_DIR" >&2
  exit 1
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
CUSTOM_ARCHIVE=false
[ -n "$ARCHIVE_URL" ] && CUSTOM_ARCHIVE=true
RELEASE_INFO=""

if [ "$CUSTOM_ARCHIVE" = true ] && [ "$VERSION" = "latest" ]; then
  log_error "Custom archives require an explicit AGENTMANAGER_VERSION."
  exit 1
fi

if [ "$CUSTOM_ARCHIVE" = false ]; then
  if [ "$VERSION" = "latest" ]; then
    log_info "Fetching latest release from GitHub..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null || true)
    if [ -z "$RELEASE_INFO" ]; then
      RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases" 2>/dev/null | node -e '
        let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
          try{const a=JSON.parse(d);if(a[0])process.stdout.write(JSON.stringify(a[0]));else process.exit(1)}catch{process.exit(1)}
        })' 2>/dev/null || true)
    fi
    if [ -z "$RELEASE_INFO" ]; then
      log_error "No releases found."
      exit 1
    fi
    VERSION=$(printf '%s' "$RELEASE_INFO" | node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        try{const v=JSON.parse(d).tag_name.replace(/^v/,"");process.stdout.write(v)}catch{process.exit(1)}
      })')
  elif [ -n "$GITHUB_TOKEN" ]; then
    log_info "Fetching release v${VERSION} from GitHub API..."
    RELEASE_INFO=$(curl -sf "${AUTH_HEADER[@]}" "https://api.github.com/repos/$GITHUB_REPO/releases/tags/v${VERSION}" 2>/dev/null || true)
  fi
fi

if ! validate_version "$VERSION"; then
  log_error "Invalid release version: $VERSION"
  exit 1
fi

ARCHIVE_NAME="agentmanager-v${VERSION}.tar.gz"
if [ "$CUSTOM_ARCHIVE" = false ]; then
  if [ -n "$GITHUB_TOKEN" ] && [ -n "$RELEASE_INFO" ]; then
    ARCHIVE_URL=$(ASSET_NAME="$ARCHIVE_NAME" node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        try{const a=(JSON.parse(d).assets||[]).find(x=>x.name===process.env.ASSET_NAME);
          if(!a)process.exit(1);process.stdout.write(a.url)}catch{process.exit(1)}
      })' <<< "$RELEASE_INFO" 2>/dev/null || true)
    CHECKSUM_URL=$(ASSET_NAME="$ARCHIVE_NAME.sha256" node -e '
      let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
        try{const a=(JSON.parse(d).assets||[]).find(x=>x.name===process.env.ASSET_NAME);
          if(!a)process.exit(1);process.stdout.write(a.url)}catch{process.exit(1)}
      })' <<< "$RELEASE_INFO" 2>/dev/null || true)
  else
    ARCHIVE_URL="https://github.com/$GITHUB_REPO/releases/download/v${VERSION}/$ARCHIVE_NAME"
    CHECKSUM_URL="$ARCHIVE_URL.sha256"
  fi
  if [ -z "$ARCHIVE_URL" ] || [ -z "$CHECKSUM_URL" ]; then
    log_error "Release is missing $ARCHIVE_NAME or its checksum asset."
    exit 1
  fi
elif [ -z "$ARCHIVE_SHA256" ] && [ -z "$CHECKSUM_URL" ] && [ "$ALLOW_UNVERIFIED" != "1" ]; then
  log_error "Custom archives require AGENTMANAGER_ARCHIVE_SHA256 or AGENTMANAGER_CHECKSUM_URL."
  log_error "Set AGENTMANAGER_ALLOW_UNVERIFIED=1 only for a trusted local development artifact."
  exit 1
fi

INSTALL_PARENT=$(dirname "$INSTALL_DIR")
LOCK_DIR="$INSTALL_PARENT/.agentmanager-install.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log_error "Another AgentManager install or update is already running."
    exit 1
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log_error "Could not recover a stale install lock."
    exit 1
  fi
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
WORK_DIR=""
cleanup_early_lock() { rm -f "$LOCK_DIR/pid" 2>/dev/null || true; rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup_early_lock EXIT INT TERM
WORK_DIR=$(mktemp -d "$INSTALL_PARENT/.agentmanager-install.XXXXXX")
chmod 700 "$WORK_DIR"
TMPFILE="$WORK_DIR/$ARCHIVE_NAME"
CHECKSUM_FILE="$WORK_DIR/$ARCHIVE_NAME.sha256"
EXTRACT_DIR="$WORK_DIR/extract"
BACKUP_DIR="$WORK_DIR/previous"
FAILED_DIR="$WORK_DIR/failed"
ROLLBACK_ARMED=false
SERVICE_TYPE="direct"

cleanup_installer() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  if [ "$ROLLBACK_ARMED" = true ]; then
    rollback_install || true
  fi
  if [ "$ROLLBACK_ARMED" = false ] && [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ] &&
     [ "$(dirname "$WORK_DIR")" = "$INSTALL_PARENT" ] &&
     [[ "$(basename "$WORK_DIR")" == .agentmanager-install.* ]]; then
    rm -rf "$WORK_DIR"
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup_installer EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log_info "Downloading $ARCHIVE_URL..."
if ! curl -fSL "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" --progress-bar -o "$TMPFILE" "$ARCHIVE_URL" 2>&1; then
  log_error "Download failed. Check the URL or version and try again."
  exit 1
fi

if [ -n "$CHECKSUM_URL" ]; then
  if ! curl -fsSL "${AUTH_HEADER[@]}" -H "Accept: application/octet-stream" -o "$CHECKSUM_FILE" "$CHECKSUM_URL"; then
    log_error "Checksum download failed; refusing to install an unverified release."
    exit 1
  fi
  ARCHIVE_SHA256=$(EXPECTED_NAME="$ARCHIVE_NAME" node -e '
    const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/);
    for(const line of lines){const m=line.trim().match(/^([0-9a-fA-F]{64})(?:\s+\*?([^\s]+))?$/);
      if(!m)continue;if(m[2]&&require("path").basename(m[2])!==process.env.EXPECTED_NAME)process.exit(2);
      process.stdout.write(m[1].toLowerCase());process.exit(0)}process.exit(1)
  ' "$CHECKSUM_FILE") || {
    log_error "Checksum file is invalid or names a different archive."
    exit 1
  }
fi

if [ -n "$ARCHIVE_SHA256" ]; then
  if [[ ! "$ARCHIVE_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    log_error "Archive SHA-256 must contain exactly 64 hexadecimal characters."
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256=$(sha256sum "$TMPFILE" | awk '{ print $1 }')
  else
    ACTUAL_SHA256=$(shasum -a 256 "$TMPFILE" | awk '{ print $1 }')
  fi
  ACTUAL_SHA256=$(printf '%s' "$ACTUAL_SHA256" | tr '[:upper:]' '[:lower:]')
  ARCHIVE_SHA256=$(printf '%s' "$ARCHIVE_SHA256" | tr '[:upper:]' '[:lower:]')
  if [ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]; then
    log_error "Release checksum verification failed."
    exit 1
  fi
  log_ok "SHA-256 verified"
else
  log_warn "Installing custom archive without integrity verification (explicit opt-out)."
fi

log_ok "Downloaded ($(du -h "$TMPFILE" | cut -f1))"

# --- Step 3: Extract and install ---------------------------------------------

log_step 3 "Installing to $INSTALL_DIR..."

# PID fallback for an old installation whose CLI cannot stop cleanly.
_stop_pid_file() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || echo "")
    if [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping existing server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}
# Resolve the port for the post-start health check. Respect a user-customized
# value from the environment, installed .env, or settings database.
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
EXPECTED_ROOT="agentmanager-v${VERSION}"
ENTRY_LIST="$WORK_DIR/archive-entries.txt"
if ! tar tzf "$TMPFILE" > "$ENTRY_LIST"; then
  log_error "Release archive is not a readable gzip-compressed tar file."
  exit 1
fi
if [ ! -s "$ENTRY_LIST" ]; then
  log_error "Release archive is empty."
  exit 1
fi
while IFS= read -r entry; do
  trimmed="${entry%/}"
  if [ -z "$trimmed" ] || [[ "$trimmed" == /* ]] || [[ "$trimmed" == *\\* ]]; then
    log_error "Unsafe archive entry: $entry"
    exit 1
  fi
  case "$trimmed" in
    "$EXPECTED_ROOT"|"$EXPECTED_ROOT"/*) ;;
    *) log_error "Archive entry escapes $EXPECTED_ROOT: $entry"; exit 1 ;;
  esac
  IFS='/' read -r -a path_parts <<< "$trimmed"
  for part in "${path_parts[@]}"; do
    if [ -z "$part" ] || [ "$part" = "." ] || [ "$part" = ".." ]; then
      log_error "Unsafe archive entry: $entry"
      exit 1
    fi
  done
done < "$ENTRY_LIST"

while IFS= read -r listing; do
  entry_type="${listing:0:1}"
  if [ "$entry_type" != "-" ] && [ "$entry_type" != "d" ]; then
    log_error "Release archive may only contain regular files and directories."
    exit 1
  fi
done < <(tar tvzf "$TMPFILE")

mkdir -p "$EXTRACT_DIR"
tar xzf "$TMPFILE" -C "$EXTRACT_DIR"
EXTRACTED="$EXTRACT_DIR/$EXPECTED_ROOT"
if [ ! -d "$EXTRACTED" ]; then
  log_error "Archive does not contain $EXPECTED_ROOT."
  exit 1
fi

for required in version.json bin/agentmanager server/package.json server/package-lock.json server/dist/index.js; do
  if [ ! -f "$EXTRACTED/$required" ]; then
    log_error "Archive is missing $required."
    exit 1
  fi
done
if ! node -e '
  const actual=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version;
  if(actual!==process.argv[2]){console.error(`expected ${process.argv[2]}, got ${actual}`);process.exit(1)}
' "$EXTRACTED/version.json" "$VERSION"; then
  log_error "Archive version metadata does not match v${VERSION}."
  exit 1
fi

# Do all slow, failure-prone dependency work before stopping the live server.
log_info "Installing server dependencies in staging..."
if ! npm ci --omit=dev --prefix "$EXTRACTED/server" 2>&1; then
  log_warn "npm ci exited non-zero — verifying the dependency tree before deciding."
fi
if ! npm ls --omit=dev --depth=0 --prefix "$EXTRACTED/server" >/dev/null; then
  log_error "Staged production dependency tree is incomplete."
  exit 1
fi
if ! (cd "$EXTRACTED/server" && node -e "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')") >/dev/null 2>&1; then
  log_info "Rebuilding native modules for the current Node runtime..."
  npm rebuild better-sqlite3 node-pty-prebuilt-multiarch --prefix "$EXTRACTED/server"
fi
if ! (cd "$EXTRACTED/server" && node -e "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')") >/dev/null 2>&1; then
  log_error "Native module verification failed; the existing installation was not touched."
  exit 1
fi
chmod +x "$EXTRACTED/bin/agentmanager"

_run_cli_as_target() {
  local cli_path="$1"
  local action="$2"
  if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$TARGET_USER" -- env "PATH=$TARGET_HOME/.local/bin:$PATH" "$cli_path" "$action"
    else
      sudo -u "$TARGET_USER" env "PATH=$TARGET_HOME/.local/bin:$PATH" "$cli_path" "$action"
    fi
  else
    "$cli_path" "$action"
  fi
}

_start_current_install() {
  case "$SERVICE_TYPE" in
    systemd) $SUDO systemctl start agentmanager ;;
    launchd) launchctl start com.aigenius.agentmanager ;;
    *) _run_cli_as_target "$INSTALL_DIR/bin/agentmanager" start ;;
  esac
}

_stop_current_install() {
  case "$SERVICE_TYPE" in
    systemd) $SUDO systemctl stop agentmanager ;;
    launchd) launchctl stop com.aigenius.agentmanager 2>/dev/null || true ;;
    *)
      [ -x "$INSTALL_DIR/bin/agentmanager" ] && \
        _run_cli_as_target "$INSTALL_DIR/bin/agentmanager" stop 2>/dev/null || true
      ;;
  esac
  _stop_pid_file "$INSTALL_DIR/.agentmanager.pid"
}

rollback_install() {
  log_error "Installation failed after replacement; restoring the previous installation."
  _stop_current_install >/dev/null 2>&1 || true
  # Infer the exact rename phase from the filesystem. This also closes the tiny
  # signal window between an atomic mv and the following shell assignment.
  if [ -e "$BACKUP_DIR" ] && [ -e "$INSTALL_DIR" ]; then
    rm -rf "$FAILED_DIR"
    if ! mv "$INSTALL_DIR" "$FAILED_DIR"; then
      log_error "Could not move the failed release aside. Recovery files remain in $WORK_DIR."
      return 1
    fi
  fi
  if [ -e "$BACKUP_DIR" ]; then
    if ! mv "$BACKUP_DIR" "$INSTALL_DIR"; then
      log_error "Could not restore the previous release. Recovery files remain in $WORK_DIR."
      return 1
    fi
    if ! _start_current_install; then
      log_error "Previous files were restored, but the previous server could not be restarted."
    else
      log_warn "Previous AgentManager installation restored."
    fi
  elif [ -e "$EXTRACTED" ] && [ -e "$INSTALL_DIR" ]; then
    # The old tree was never renamed; only the stop/preserve phase failed.
    if ! _start_current_install; then
      log_error "The existing files are intact, but the existing server could not be restarted."
    fi
  elif [ ! -e "$EXTRACTED" ] && [ -e "$INSTALL_DIR" ]; then
    # Fresh install: the staged tree was renamed into place, but there is no
    # previous release to restore.
    rm -rf "$FAILED_DIR"
    if ! mv "$INSTALL_DIR" "$FAILED_DIR"; then
      log_error "Could not move the failed fresh install aside. Recovery files remain in $WORK_DIR."
      return 1
    fi
  fi
  ROLLBACK_ARMED=false
}

if [ "$OS" = "Linux" ] && systemctl is-active --quiet agentmanager 2>/dev/null; then
  SERVICE_TYPE="systemd"
elif [ "$OS" = "Darwin" ] && launchctl list com.aigenius.agentmanager >/dev/null 2>&1; then
  SERVICE_TYPE="launchd"
fi

log_info "Stopping the existing server for the final directory switch..."
ROLLBACK_ARMED=true
_stop_current_install

# Copy mutable local configuration only after the old server has stopped.
if [ -e "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR" ]; then
    for keep in logs .agentmanager server/.env; do
      if [ -e "$INSTALL_DIR/$keep" ]; then
        rm -rf "$EXTRACTED/$keep"
        mkdir -p "$(dirname "$EXTRACTED/$keep")"
        cp -a "$INSTALL_DIR/$keep" "$EXTRACTED/$keep"
      fi
    done
    rm -f "$EXTRACTED/.agentmanager.pid"
  fi
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi

# Both directories are siblings on the same filesystem, so each rename is
# atomic. The EXIT trap restores BACKUP_DIR if any subsequent step fails.
mv "$EXTRACTED" "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"

log_ok "AgentManager v${VERSION} staged at $INSTALL_DIR"

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

_start_current_install

START_PORT="$(_resolve_install_port)"
SERVER_READY=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 1 "http://127.0.0.1:${START_PORT}/api/health" >/dev/null 2>&1; then
    SERVER_READY=true
    break
  fi
  sleep 0.5
done
if [ "$SERVER_READY" != true ]; then
  log_error "The new server did not pass its health check on port ${START_PORT}."
  exit 1
fi

# Replacement and startup both succeeded. The previous tree can now be removed.
ROLLBACK_ARMED=false
rm -rf "$BACKUP_DIR" || log_warn "Could not remove the previous release staging directory."

# --- Step 5b: Remove obsolete shell-function shadowing -----------------------

# Older installers defined an `agentmanager()` shell function that intercepted
# every CLI subcommand. Remove it so the installed executable handles update,
# status, start, and all other commands.
AGENTMANAGER_FUNC_MARKER="# AgentManager session launcher function"
AGENTMANAGER_FUNC_END="# end-agentmanager-session"
_sed_i() {
  if [ "$OS" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

LEGACY_MARKERS=(
  "# AgentManager hivemind launcher function|# end-agentmanager-hivemind"
)

_remove_shadowing_shell_func() {
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

  log_info "Removed obsolete agentmanager() shell function from $(basename "$RC_FILE")"
}

_remove_shadowing_shell_func "$TARGET_HOME/.bashrc"
_remove_shadowing_shell_func "$TARGET_HOME/.zshrc"

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
