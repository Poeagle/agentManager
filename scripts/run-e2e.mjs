import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const playwright = 'node_modules/@playwright/test/cli.js';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`);
  return result.status;
}

export function runE2e(args, { directory = root, execute = run } = {}) {
  const npm = process.env.npm_execpath;
  const install = cwd => npm
    ? execute(process.execPath, [npm, 'ci', '--include=dev'], cwd)
    : execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--include=dev'], cwd);

  const listOnly = args.includes('--list') || args.includes('--help') || args.includes('-h');
  const required = [['', playwright]];
  if (!listOnly) required.push(['server','node_modules/tsx/dist/cli.mjs'], ['dashboard','node_modules/vite/bin/vite.js']);
  for (const [workspace, entry] of required) {
    const cwd = join(directory, workspace);
    if (existsSync(join(cwd, entry))) continue;
    const status = install(cwd);
    if (status) return status;
    if (!existsSync(join(cwd, entry))) throw new Error(`Installation did not provide ${join(cwd, entry)}`);
  }

  const cli = join(directory, playwright);
  if (!listOnly) {
    const status = execute(process.execPath, [cli, 'install', 'chromium'], directory);
    if (status) return status;
  }
  return execute(process.execPath, [cli, 'test', ...args], directory);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = runE2e(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
