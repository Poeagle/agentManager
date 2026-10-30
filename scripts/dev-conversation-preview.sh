#!/usr/bin/env bash
# One independent preview server. Never imports the running installation's DB.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREVIEW_PORT="${CONVERSATION_PREVIEW_PORT:-43231}"
PREVIEW_DIR="$ROOT_DIR/.test-data/conversation-preview"
cd "$ROOT_DIR"
node --input-type=module - "$PREVIEW_PORT" <<'JS'
import net from 'node:net';
const port=Number(process.argv[2]);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid preview port');
await new Promise((resolve,reject)=>{
 const server=net.createServer();server.once('error',()=>reject(new Error(`Preview port ${port} is already in use; no service was stopped`)));
 server.listen(port,'0.0.0.0',()=>server.close(resolve));
});
JS
mkdir -p "$PREVIEW_DIR"
chmod 700 "$PREVIEW_DIR"
npm run build
export AGENTMANAGER_CODEX_STREAM_SOCKET="$(node scripts/conversation-codex-server.mjs)"
export NODE_ENV=production
export PORT="$PREVIEW_PORT"
export HOST=0.0.0.0
export AGENTMANAGER_DB_PATH="$PREVIEW_DIR/agentmanager.db"
export AGENTMANAGER_RUNTIME_NAMESPACE=chat-preview
export AGENTMANAGER_SKIP_UPDATE_CHECK=1
echo "Conversation preview: http://127.0.0.1:$PREVIEW_PORT"
echo "Database: $AGENTMANAGER_DB_PATH"
exec node server/dist/index.js
