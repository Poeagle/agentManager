import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('jumps to a typed server path and registers a directory through its link', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'octoally-project-picker-'));
  const hidden = join(root, '.directory with spaces');
  const target = join(root, 'actual project');
  const link = join(hidden, 'project alias');
  let projectId: string | undefined;

  try {
    mkdirSync(hidden);
    mkdirSync(target);
    symlinkSync(target, link);
    const status = await (await page.request.get('/api/auth/status')).json();
    expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
      data: { username: 'e2e-admin', password: 'test-password' },
    })).ok()).toBeTruthy();
    await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: '新增项目', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = page.getByRole('dialog', { name: '新增项目', exact: true });
    const path = dialog.getByRole('textbox', { name: '项目路径' });

    await path.fill(join(root, 'missing'));
    await dialog.getByRole('button', { name: '浏览目录' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Directory not found');
    await path.fill(hidden);
    await path.press('Enter');
    await expect(dialog.getByText(hidden, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'project alias', exact: true }).click();
    await expect(dialog.getByText(link, { exact: true })).toBeVisible();
    await path.press('Enter');
    await expect(dialog.getByText(hidden, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'project alias', exact: true }).click();
    await expect(dialog.getByText(link, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '选择此目录' }).click();
    await expect(path).toHaveValue(link);
    await expect(dialog.getByRole('textbox', { name: '项目名称' })).toHaveValue('project alias');

    const created = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/projects',
    );
    await dialog.getByRole('button', { name: '新增项目', exact: true }).click();
    const response = await created;
    expect(response.ok()).toBeTruthy();
    const { project } = await response.json();
    projectId = project.id;
    expect(project.path).toBe(realpathSync(target));
    await expect(dialog).toBeHidden();
  } finally {
    try {
      if (projectId) await page.request.delete(`/api/projects/${projectId}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
