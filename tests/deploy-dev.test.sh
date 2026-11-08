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
cat > "$BIN/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\n' "$*" >> "$TEST_LOG"
exit "${NODE_CHECK_FAIL:-0}"
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
cat > "$BIN/launchctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'launchctl %s\n' "$*" >> "$TEST_LOG"
[ "${1:-}" = "print" ] && exit "${LAUNCHD_MISSING:-0}"
exit 0
EOF
cat > "$INSTALL/bin/agentmanager" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'agentmanager %s\n' "$*" >> "$TEST_LOG"
EOF
chmod +x "$BIN/build" "$BIN/node" "$BIN/curl" "$BIN/git" "$BIN/launchctl" "$INSTALL/bin/agentmanager" "$SOURCE/scripts/deploy-dev.sh"

run() {
  PATH="$BIN:$PATH" TEST_LOG="$TMP/log" TEST_SOURCE="$SOURCE" BUILD_FAIL="${BUILD_FAIL:-0}" NODE_CHECK_FAIL="${NODE_CHECK_FAIL:-0}" HEALTH_FAIL="${HEALTH_FAIL:-0}" LAUNCHD_MISSING="${LAUNCHD_MISSING:-0}" \
    AGENTMANAGER_INSTALL_DIR="$INSTALL" AGENTMANAGER_BUILD_CMD="$BIN/build" PORT=42010 "$SOURCE/scripts/deploy-dev.sh"
}

BUILD_FAIL=1 run 2>"$TMP/build-failure.err" || true
test "$(cat "$INSTALL/server/dist/index.js")" = previous-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = previous-dashboard
test ! -e "$TMP/log" || ! grep -q 'agentmanager stop' "$TMP/log"

NODE_CHECK_FAIL=1 run >"$TMP/syntax-failure.log" 2>"$TMP/syntax-failure.err" || true
test "$(cat "$INSTALL/server/dist/index.js")" = previous-server
test "$(grep -c 'agentmanager stop' "$TMP/log")" -eq 0
grep -q 'invalid JavaScript' "$TMP/syntax-failure.log"

run >"$TMP/success.log"
test "$(cat "$INSTALL/server/dist/index.js")" = new-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = new-dashboard
test "$(grep -c 'agentmanager stop' "$TMP/log")" -eq 1
test "$(grep -c 'launchctl kickstart' "$TMP/log")" -eq 1
grep -q 'Deploy complete' "$TMP/success.log"

HEALTH_FAIL=1 run >"$TMP/health-failure.log" 2>"$TMP/health-failure.err" || true
test "$(cat "$INSTALL/server/dist/index.js")" = new-server
test "$(cat "$INSTALL/dashboard/dist/index.html")" = new-dashboard
test "$(grep -c 'agentmanager stop' "$TMP/log")" -eq 3
test "$(grep -c 'launchctl kickstart' "$TMP/log")" -eq 3
grep -q 'Previous build restored' "$TMP/health-failure.log"
