#!/usr/bin/env bash
# Fully isolated platform AI development: separate checkout, DB, ports and PTY resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DEV_API_PORT="${DEV_API_PORT:-43220}"
DEV_UI_PORT="${DEV_UI_PORT:-43221}"
DEV_DATA_DIR="$ROOT_DIR/.test-data/platform-ai-dev"
DEV_NAMESPACE="pai-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0,12))')"

# Probe without killing or reusing existing listeners.
node --input-type=module - "$DEV_API_PORT" "$DEV_UI_PORT" <<'JS'
import net from 'node:net';
const ports = process.argv.slice(2).map(Number);
if (new Set(ports).size !== 2 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) {
  throw new Error('Choose two distinct ports between 1024 and 65535');
}
for (const port of ports) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; choose another development port`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS

mkdir -p "$DEV_DATA_DIR"
chmod 700 "$DEV_DATA_DIR"
export AGENTMANAGER_DB_PATH="$DEV_DATA_DIR/agentmanager.db"
export AGENTMANAGER_RUNTIME_NAMESPACE="$DEV_NAMESPACE"
export AGENTMANAGER_SKIP_UPDATE_CHECK=1
export AGENTMANAGER_ALLOW_LAN=false
export HOST=127.0.0.1
export PORT="$DEV_API_PORT"
export VITE_PORT="$DEV_UI_PORT"
export VITE_CACHE_DIR="$ROOT_DIR/dashboard/node_modules/.vite-$DEV_NAMESPACE"
export VITE_API_TARGET="http://127.0.0.1:$DEV_API_PORT"

echo "Platform AI development UI: http://127.0.0.1:$DEV_UI_PORT"
echo "Database: $AGENTMANAGER_DB_PATH"
echo "PTY namespace: $DEV_NAMESPACE"
exec "$ROOT_DIR/node_modules/.bin/concurrently" --kill-others --names api,ui \
  "npm --prefix server run dev" "npm --prefix dashboard run dev -- --host 127.0.0.1"
