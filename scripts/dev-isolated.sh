#!/usr/bin/env bash
# AgentManager 隔离 dev 启动器 —— 与 prod (systemd, :42010) 并行运行,互不影响。
#
#   dev 后端 : :42020,独立库 ~/.agentmanager-dev/agentmanager.db
#   dev 前端 : :42011 (vite),API 代理到 :42020
#   prod     : 完全不碰 —— 独立 DB、不停服务、不重启
#
# 与 prod 共享(可接受,非破坏性): tmux server `agentmanager`、pipe 目录、
# ~/.agentmanager/projects.json(dev 启动时会从中导入 prod 的项目列表)。
#
# 用法: bash scripts/dev-isolated.sh    (或: npm run dev:isolated)
# 退出: Ctrl-C —— 前后端一起停
#
# 可用环境变量覆盖默认值: DEV_API_PORT / DEV_UI_PORT / DEV_DB
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEV_API_PORT="${DEV_API_PORT:-42020}"
DEV_UI_PORT="${DEV_UI_PORT:-42011}"
DEV_DB="${DEV_DB:-$HOME/.agentmanager-dev/agentmanager.db}"

CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${CYAN}[dev-isolated]${NC} $1"; }

# 设了 DB_PATH 时 server 不会自动建目录,先确保存在
mkdir -p "$(dirname "$DEV_DB")"

# 防重复启动:端口被占就退出(避免误连到别的进程)
for p in "$DEV_API_PORT" "$DEV_UI_PORT"; do
  if ss -tlnp 2>/dev/null | grep -qE ":${p}\b"; then
    echo -e "${YELLOW}[dev-isolated]${NC} 端口 ${p} 已占用 —— dev 可能已在运行。"
    echo -e "${YELLOW}[dev-isolated]${NC} 先停止: fuser -k ${DEV_API_PORT}/tcp ${DEV_UI_PORT}/tcp"
    exit 1
  fi
done

log "dev 后端 : http://localhost:${DEV_API_PORT}   (DB: ${DEV_DB})"
log "dev 前端 : http://localhost:${DEV_UI_PORT}"
log "prod :42010 不受影响。按 Ctrl-C 停止 dev。"
echo

cd "$ROOT_DIR"
export AGENTMANAGER_SKIP_UPDATE_CHECK=1
# --kill-others: 任一进程退出/Ctrl-C 时,另一个也一起停,不留孤儿
exec npx concurrently --kill-others --names "api,ui" --prefix-colors "cyan,magenta" \
  "cd server && DB_PATH=${DEV_DB} PORT=${DEV_API_PORT} npm run dev" \
  "cd dashboard && VITE_PORT=${DEV_UI_PORT} VITE_API_TARGET=http://127.0.0.1:${DEV_API_PORT} npm run dev -- --host 127.0.0.1"
