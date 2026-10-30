import { execFileSync } from 'node:child_process';
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
