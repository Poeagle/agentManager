import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(repoRoot, '.test-data', 'e2e');
const attachmentRoot = mkdtempSync(join(tmpdir(), 'octoally-e2e-attachments-'));
const fakeHome = join(testRoot, 'home');
const fixtureBin = join(testRoot, 'bin');
const projectPaths = [
  join(testRoot, 'persistence-project'),
  join(testRoot, 'prompt-copy-project'),
];

// The target is a fixed repository-local test directory, never a user path.
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fixtureBin, { recursive: true });
// Reload verifies the installed client version before attaching the fake TUI.
// The browser suite supplies that version without launching an installed CLI.
writeFileSync(join(fixtureBin,'codex'), '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "codex-cli 0.167.0\\n"\n', {mode:0o700});
for (const projectPath of projectPaths) mkdirSync(projectPath, { recursive: true });
// Prevent zsh's first-run wizard from consuming the first terminal keystroke
// in browser tests that exercise draft input.
writeFileSync(join(fakeHome, '.zshrc'), '');
const cleanup = () => { rmSync(attachmentRoot, { recursive: true, force: true }); rmSync(testRoot, { recursive: true, force: true }); };
// Playwright terminates web servers with a signal; register before index.ts so
// cleanup runs before the application's shutdown handler calls process.exit().
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
process.once('exit', cleanup);

Object.assign(process.env, {
  HOME: fakeHome,
  PATH: fixtureBin + ':' + (process.env.PATH || ''),
  CODEX_HOME: join(fakeHome, '.codex'),
  PORT: process.env.E2E_API_PORT || '43110',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'development',
  AGENTMANAGER_ATTACHMENTS_DIR: attachmentRoot,
  AGENTMANAGER_DB_PATH: join(testRoot, 'agentmanager.db'),
  AGENTMANAGER_CODEX_STREAM_SOCKET: join(testRoot, 'codex.sock'),
  AGENTMANAGER_MANAGE_CODEX_ENGINES: 'false',
  AGENTMANAGER_USE_TMUX: 'false',
  AGENTMANAGER_USE_DTACH: 'false',
  AGENTMANAGER_SKIP_UPDATE_CHECK: '1',
});

await import('../server/src/index.ts');
