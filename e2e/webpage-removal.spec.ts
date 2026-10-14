import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('removes the webpage entry and ignores old webpage state while preserving terminal tabs', async ({ page }) => {
  await page.routeWebSocket((url) => url.port === '43111' && url.pathname === '/', () => {});
  const status = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  // This is the E2E harness's isolated project and shell, never a user's CLI.
  const path = join(process.cwd(), '.test-data', 'e2e', 'webpage-removal-project');
  mkdirSync(path, { recursive: true });
  const created = await page.request.post('/api/projects', { data: { name: 'Browser removal', path } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  expect(project).not.toHaveProperty('default_web_url');
  const opened = await page.request.post('/api/sessions', { data: { project_id: project.id, project_path: path, mode: 'terminal' } });
  expect(opened.ok()).toBeTruthy();
  const { session } = await opened.json();
  const saved = {
    activeMode: 'terminal', explorerInstances: [], activeExplorerId: null,
    terminalInstances: [{ id: session.id, label: 'Preserved terminal', customLabel: 'Preserved terminal' }],
    activeTerminalId: null, hiddenSessionIds: [],
    webPageInstances: [{ id: `${user.id}-${project.id}-webpage-1`, label: 'Old preview', url: 'https://example.com' }],
    activeWebPageId: `${user.id}-${project.id}-webpage-1`,
  };
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  const stateUrl = `/api/user-state/${encodeURIComponent(`project:${project.id}`)}`;
  await page.request.put(stateUrl, { data: { value: saved } });
  await page.addInitScript(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), {
    key: `agentmanager-project-${user.id}-${project.id}`, saved,
  });
  await page.goto('/');
  await expect(page.getByText('Preserved terminal', { exact: true })).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.getByRole('button', { name: '打开网页', exact: true })).toHaveCount(0);
  await expect(page.getByText('Old preview', { exact: true })).toHaveCount(0);
  await expect(page.locator('iframe[src="https://example.com"]')).toHaveCount(0);
  await expect.poll(async () => {
    const { state } = await (await page.request.get('/api/user-state')).json();
    const value = state[`project:${project.id}`];
    return { active: value?.activeTerminalId, web: 'webPageInstances' in (value ?? {}), tabs: value?.terminalInstances?.length };
  }).toEqual({ active: session.id, web: false, tabs: 1 });
});
