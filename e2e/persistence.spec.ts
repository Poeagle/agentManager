import { expect, test } from '@playwright/test';
import { join } from 'path';

test('restores project and terminal tabs from server state after browser storage is lost', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', display_name: 'E2E Admin', password: 'test-password' },
  });
  expect(auth.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();

  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'persistence-project');
  const projectResponse = await page.request.post('/api/projects', {
    data: { name: 'Persistence Project', path: projectPath },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const { project } = await projectResponse.json();

  const sessionResponse = await page.request.post('/api/sessions', {
    data: { project_path: projectPath, project_id: project.id, mode: 'terminal' },
  });
  expect(sessionResponse.ok()).toBeTruthy();
  const { session } = await sessionResponse.json();

  // Stop the mounted empty dashboard from racing these authoritative server
  // state writes with its own initial persistence effect.
  await page.goto('about:blank');

  // The home-page prompt can unmount as saved project tabs hydrate. Seed its
  // dismissal instead of racing a click against that navigation.
  expect((await page.request.put('/api/settings', {
    data: { settings: { statusline_prompted: 'true' } },
  })).ok()).toBeTruthy();

  expect((await page.request.put('/api/user-state/app', {
    data: {
      value: {
        projectTabs: [{ projectId: project.id, projectName: project.name, customName: 'Durable Project Tab' }],
        activeTab: `project-${project.id}`,
      },
    },
  })).ok()).toBeTruthy();
  expect((await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, {
    data: {
      value: {
        terminalLabels: { [session.id]: 'persistent-test1' },
        terminalInstances: [{ id: session.id, label: 'Terminal 1', customLabel: 'persistent-test1' }],
        activeTerminalId: session.id,
        hiddenSessionIds: [],
        explorerInstances: [],
      },
    },
  })).ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByText('Durable Project Tab', { exact: true })).toBeVisible();
  await expect(page.getByText('persistent-test1', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.getByText('Durable Project Tab', { exact: true })).toBeVisible();
  await expect(page.getByText('persistent-test1', { exact: true }).first()).toBeVisible();

  // A second reload proves the first hydration was not a one-off local cache hit.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText('persistent-test1', { exact: true }).first()).toBeVisible();

  const stateResponse = await page.request.get('/api/user-state');
  const { state } = await stateResponse.json();
  expect(state.app.activeTab).toBe(`project-${project.id}`);
  expect(state[`project:${project.id}`].activeTerminalId).toBe(session.id);
});
