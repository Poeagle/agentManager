import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(repoRoot, '.test-data', 'e2e');
const fakeHome = join(testRoot, 'home');
const projectPaths = [
  join(testRoot, 'persistence-project'),
  join(testRoot, 'prompt-copy-project'),
];

// The target is a fixed repository-local test directory, never a user path.
rmSync(testRoot, { recursive: true, force: true });
mkdirSync(fakeHome, { recursive: true });
for (const projectPath of projectPaths) mkdirSync(projectPath, { recursive: true });
// Prevent zsh's first-run wizard from consuming the first terminal keystroke
// in browser tests that exercise draft input.
writeFileSync(join(fakeHome, '.zshrc'), '');
const cleanup = () => rmSync(testRoot, { recursive: true, force: true });
// Playwright terminates web servers with a signal; register before index.ts so
// cleanup runs before the application's shutdown handler calls process.exit().
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
process.once('exit', cleanup);

Object.assign(process.env, {
  HOME: fakeHome,
  PORT: '43110',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'development',
  AGENTMANAGER_DB_PATH: join(testRoot, 'agentmanager.db'),
  AGENTMANAGER_USE_TMUX: 'false',
  AGENTMANAGER_USE_DTACH: 'false',
  AGENTMANAGER_SKIP_UPDATE_CHECK: '1',
});

await import('../server/src/index.ts');
