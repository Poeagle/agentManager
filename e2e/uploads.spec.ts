import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

async function dropFile(page: Page, target: Locator, name: string, content: string) {
  const dataTransfer = await page.evaluateHandle(({ name, content }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name, { type: 'text/plain' }));
    return transfer;
  }, { name, content });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

test('uploads from the sidebar and folder tree to the correct server directory', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(auth.ok()).toBeTruthy();
  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'upload-project');
  const reportsPath = join(projectPath, 'reports');
  mkdirSync(reportsPath, { recursive: true });
  const response = await page.request.post('/api/projects', { data: { name: 'Upload Project', path: projectPath } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  expect((await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } })).ok()).toBeTruthy();
  expect((await page.request.put('/api/user-state/app', {
    data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } },
  })).ok()).toBeTruthy();
  await page.goto('/');
  const sidebar = page.getByTitle('File Explorer', { exact: true });
  await expect(sidebar).toBeVisible();

  await dropFile(page, sidebar, 'sidebar.txt', 'sidebar content');
  const zone = page.getByLabel('文件上传区域').filter({ visible: true });
  await expect(zone.getByRole('status')).toContainText('已上传 1/1 个文件');
  expect(readFileSync(join(projectPath, 'sidebar.txt'), 'utf8')).toBe('sidebar content');
  await expect(zone.getByRole('button', { name: 'sidebar.txt', exact: true })).toBeVisible();
  await expect(zone.getByTitle('Parent directory')).toBeDisabled();

  // Neither manual navigation nor stale browser state can restore /home.
  const rootInput = zone.locator('form input');
  await rootInput.fill('/home');
  await rootInput.press('Enter');
  await expect(rootInput).toHaveValue(projectPath);
  await expect(zone.getByText('只能访问当前项目目录及其子目录')).toBeVisible();
  expect((await page.request.get(`/api/files?project_id=${project.id}&path=/home`)).status()).toBe(403);
  await page.evaluate(({ projectId }) => {
    const key = Object.keys(localStorage).find(key => key.startsWith('agentmanager-explorer-') && key.includes(projectId));
    if (!key) throw new Error('Explorer state was not persisted');
    const saved = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...saved, currentPath: '/home', expandedPaths: ['/home'], openTabPaths: [] }));
  }, { projectId: project.id });
  await page.reload();
  await expect(zone.locator('form input')).toHaveValue(projectPath);
  await expect(zone.getByTitle('Parent directory')).toBeDisabled();

  await dropFile(page, zone.getByRole('button', { name: 'reports', exact: true }), '数据.txt', 'nested content');
  await expect(zone.getByRole('status')).toContainText(`已上传 1/1 个文件到 ${reportsPath}`);
  expect(readFileSync(join(reportsPath, '数据.txt'), 'utf8')).toBe('nested content');
  await expect(zone.getByRole('button', { name: '数据.txt', exact: true })).toBeVisible();

  // The sidebar must use the active explorer's navigated path, not the project root.
  const pathInput = zone.locator('form input');
  await pathInput.fill(reportsPath);
  await pathInput.press('Enter');
  await expect(zone.getByRole('button', { name: '数据.txt', exact: true })).toBeVisible();
  await dropFile(page, sidebar, 'current.txt', 'current directory');
  await expect(zone.getByRole('status')).toContainText(`已上传 1/1 个文件到 ${reportsPath}`);
  expect(readFileSync(join(reportsPath, 'current.txt'), 'utf8')).toBe('current directory');

  await dropFile(page, sidebar, 'current.txt', 'do not overwrite');
  await expect(zone.getByRole('alert')).toContainText('同名文件已存在');
  expect(readFileSync(join(reportsPath, 'current.txt'), 'utf8')).toBe('current directory');
});
