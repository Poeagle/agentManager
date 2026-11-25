import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

async function resolveConfig(port: string, command: 'serve' | 'build' = 'serve') {
  // Load Vite in Node, not jsdom: esbuild's typed arrays must share a realm.
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { loadConfigFromFile } from 'vite';
    const { config } = await loadConfigFromFile({ command: '${command}', mode: 'development' });
    process.stdout.write(JSON.stringify({
      cacheDir: config.cacheDir, server: { port: config.server.port },
      resolve: config.resolve, optimizeDeps: config.optimizeDeps,
    }));
  `], { cwd: process.cwd(), env: { ...process.env, VITE_PORT: port }, encoding: 'utf8' }));
}

it('isolates dependency caches between live development, browser tests and builds', async () => {
  const live = await resolveConfig('42011');
  const browserTests = await resolveConfig('43111');
  const build = await resolveConfig('42011', 'build');
  expect(new Set([live.cacheDir, browserTests.cacheDir, build.cacheDir]).size).toBe(3);
  expect(live.server?.port).toBe(42011);
  expect(browserTests.server?.port).toBe(43111);
});

it('deduplicates React and prebundles the lazy Markdown editor with the renderer', async () => {
  const resolved = await resolveConfig('42011');
  expect(resolved.resolve?.dedupe).toEqual(expect.arrayContaining(['react', 'react-dom']));
  expect(resolved.optimizeDeps?.include).toEqual(expect.arrayContaining([
    'react', 'react-dom/client', 'react/jsx-runtime', '@tiptap/react', '@tiptap/starter-kit', '@tiptap/markdown',
  ]));
});

it('detects recreated shared modules and serves their new exports in a running dev server', async () => {
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'vite-shared-'));
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, unlink, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createServer, loadConfigFromFile } from 'vite';

    async function waitFor(check, message) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await delay(25);
      }
      throw new Error(message);
    }

    const workspace = process.argv[1];
    let vite;
    try {
      const root = join(workspace, 'dashboard');
      const shared = join(workspace, 'server', 'src', 'shared');
      const importer = join(root, 'entry.ts');
      const dependency = join(shared, 'conversation-context.ts');
      await mkdir(root);
      await mkdir(shared, { recursive: true });
      await writeFile(importer, "export { existing } from '../server/src/shared/conversation-context';");
      await writeFile(dependency, 'export function existing() {}');

      const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' });
      vite = await createServer({
        ...config, configFile: false, root, logLevel: 'silent', cacheDir: join(root, '.vite'),
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, ws: false, fs: { allow: [workspace] } },
      });
      const readImporter = () => vite.transformRequest('/entry.ts');
      const dependencyUrl = result => result.code.match(/from "([^"]+)"/)[1];
      const watched = () => (vite.watcher.getWatched()[shared] ?? []).includes('conversation-context.ts');
      const oldUrl = dependencyUrl(await readImporter());
      const original = await vite.transformRequest(oldUrl);
      assert.match(original.code, /function existing/);
      assert.doesNotMatch(original.code, /function added/);
      await waitFor(watched, 'Vite never watched the shared module');

      await unlink(dependency);
      await waitFor(() => !watched(), 'Vite missed removal of the shared module');
      await writeFile(dependency, 'export function existing() {}\\nexport function added() {}');
      await waitFor(watched, 'Vite missed recreation of the shared module');
      await writeFile(importer, "export { existing, added } from '../server/src/shared/conversation-context';");

      await waitFor(async () => {
        const updated = await readImporter();
        const url = dependencyUrl(updated);
        if (!updated.code.includes('added') || url === oldUrl) return false;
        return (await vite.transformRequest(url)).code.includes('function added');
      }, 'The updated importer still points to a stale shared module');
    } finally {
      await vite?.close();
    }
  `;
  try {
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, workspace], {
      cwd: process.cwd(), timeout: 12000,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}, 15000);
