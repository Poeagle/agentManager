import { expect, test } from '@playwright/test';
import { join } from 'path';

test('restores project and terminal tabs from server state after browser storage is lost', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '创建管理员账户' })).toBeVisible();
  await page.getByLabel('用户名').fill('e2e-admin');
  await page.getByLabel('显示名(可选)').fill('E2E Admin');
  await page.getByLabel('密码').fill('test-password');
  await page.getByRole('button', { name: '创建并进入' }).click();
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();

  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'project');
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
        webPageInstances: [],
      },
    },
  })).ok()).toBeTruthy();

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
