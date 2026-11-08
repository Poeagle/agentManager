#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/agentmanager-deploy-test.XXXXXX")"
trap 'mv "$TMP" "${TMP}.done"' EXIT

SOURCE="$TMP/source"
INSTALL="$TMP/install"
BIN="$TMP/bin"
mkdir -p "$SOURCE/scripts" "$SOURCE/server/dist" "$SOURCE/dashboard/dist" \
  "$INSTALL/server/dist" "$INSTALL/dashboard/dist" "$INSTALL/bin" "$BIN"

cp "$ROOT/scripts/deploy-dev.sh" "$SOURCE/scripts/deploy-dev.sh"
cp "$ROOT/package.json" "$SOURCE/package.json"
printf 'previous-server\n' > "$INSTALL/server/dist/index.js"
printf 'previous-dashboard\n' > "$INSTALL/dashboard/dist/index.html"
printf 'old\n' > "$SOURCE/server/dist/index.js"
printf 'old\n' > "$SOURCE/dashboard/dist/index.html"

cat > "$BIN/build" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'build\n' >> "$TEST_LOG"
if [ "${BUILD_FAIL:-0}" = "1" ]; then exit 1; fi
printf 'new-server\n' > "$TEST_SOURCE/server/dist/index.js"
printf 'new-dashboard\n' > "$TEST_SOURCE/dashboard/dist/index.html"
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$TEST_LOG"
exit "${HEALTH_FAIL:-0}"
EOF
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '0123456\n'
EOF
cat > "$INSTALL/bin/agentmanager" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'agentmanager %s\n' "$*" >> "$TEST_LOG"
EOF
chmod +x "$BIN/build" "$BIN/curl" "$BIN/git" "$INSTALL/bin/agentmanager" "$SOURCE/scripts/deploy-dev.sh"

run() {
  PATH="$BIN:$PATH" TEST_LOG="$TMP/log" TEST_SOURCE="$SOURCE" \
    AGENTMANAGER_INSTALL_DIR="$INSTALL" AGENTMANAGER_BUILD_CMD="$BIN/build" PORT=42010 "$SOURCE/scripts/deploy-dev.sh"
}

BUILD_FAIL=1 run 2>"$TMP/build-failure.err" || true
test "$(cat "$INSTALL/server/dist/index.js")" = previous-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = previous-dashboard
test ! -e "$TMP/log" || ! grep -q 'agentmanager restart' "$TMP/log"

run >"$TMP/success.log"
test "$(cat "$INSTALL/server/dist/index.js")" = new-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = new-dashboard
test "$(grep -c 'agentmanager restart' "$TMP/log")" -eq 1
grep -q 'Deploy complete' "$TMP/success.log"

HEALTH_FAIL=1 run >"$TMP/health-failure.log" 2>"$TMP/health-failure.err" || true
test "$(cat "$INSTALL/server/dist/index.js")" = new-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = new-dashboard
test "$(grep -c 'agentmanager restart' "$TMP/log")" -eq 3
grep -q 'Previous build restored' "$TMP/health-failure.log"
