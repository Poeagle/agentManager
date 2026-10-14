import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'path';

test('aligns host telemetry and separates scheduled task display from daily window settings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  // Dependency warming or concurrent source edits must not reload the page
  // and discard the unsaved editor while checking its layout.
  await page.routeWebSocket((url) => url.port === '43111' && url.pathname === '/', () => {});
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  await page.route('**/api/codex-quota', (route) => route.fulfill({ json: { quota: {
    usedPercent: 42, remainingPercent: 58, windowDurationMins: 10080,
    resetsAt: 1792202400, planType: 'pro', checkedAt: '2026-10-13T08:00:00Z',
  } } }));
  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'scheduled-windows-project');
  mkdirSync(projectPath, { recursive: true });
  const created = await page.request.post('/api/projects', { data: {
    name: 'Scheduling Project', path: projectPath,
  } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true', app_theme: 'light' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  await page.goto('/');
  const resource = page.getByLabel('部署服务器资源', { exact: true });
  await expect(resource.getByText('CPU')).toBeVisible();
  const monitor = page.getByTitle('平台管理', { exact: true });
  const [left, right] = await Promise.all([resource.boundingBox(), monitor.boundingBox()]);
  expect(left!.height).toBe(28);
  expect(left!.y).toBe(right!.y);
  expect(left!.x + left!.width).toBeLessThan(right!.x);
  await page.getByTitle('定时任务', { exact: true }).click();
  await expect(page.getByLabel('定时任务展示', { exact: true })).toBeVisible();
  await expect(page.getByLabel('任务名称', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByLabel('定时任务展示', { exact: true })).toHaveCount(0);
  await page.getByLabel('任务名称', { exact: true }).fill('定时 JIRA BUG 修复');
  await page.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
  await page.getByLabel('每次开始条件 1时间', { exact: true }).fill('09:00');
  await page.getByLabel('每天停止条件 1时间', { exact: true }).fill('18:00');
  await page.getByLabel('执行间隔', { exact: true }).fill('30');
  await page.getByLabel('提示词', { exact: true }).fill('检查最新 JIRA BUG，继续当前修复工作。');
  await page.getByLabel('启用', { exact: true }).uncheck();
  const settingsBounds = await page.getByLabel('定时任务设置', { exact: true }).evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const pane = node.closest('.page-content')!.parentElement!.getBoundingClientRect();
    return { left: bounds.left - pane.left, right: pane.right - bounds.right };
  });
  expect(settingsBounds.left).toBe(24);
  expect(settingsBounds.right).toBeLessThanOrEqual(24);
  const [nameBox, promptBox] = await Promise.all([
    page.getByLabel('任务名称', { exact: true }).boundingBox(),
    page.getByLabel('提示词', { exact: true }).boundingBox(),
  ]);
  expect(promptBox!.x).toBe(nameBox!.x);
  expect(promptBox!.y).toBeGreaterThan(nameBox!.y);
  expect(promptBox!.height).toBeGreaterThanOrEqual(144);
  expect(promptBox!.height).toBeLessThan(220);
  const intervalBox = await page.getByLabel('执行间隔', { exact: true }).boundingBox();
  expect(intervalBox!.width).toBeLessThanOrEqual(160);
  expect(nameBox!.width).toBeLessThanOrEqual(360);
  const createBox = await page.getByRole('button', { name: '创建任务', exact: true }).boundingBox();
  expect(createBox!.y).toBeLessThan(nameBox!.y);
  expect(createBox!.x).toBeGreaterThan(1600);
  await page.screenshot({ path: testInfo.outputPath('schedule-settings.png') });
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByLabel('定时任务展示', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '定时任务列表' }).getByText('每 30 分钟 · 按条件执行')).toBeVisible();
  const tableBounds = await page.getByRole('table', { name: '定时任务列表' }).boundingBox();
  expect(tableBounds!.width).toBeGreaterThan(1600);
  const { tasks } = await (await page.request.get(`/api/scheduled-tasks?project_id=${project.id}`)).json();
  expect(tasks[0]).toMatchObject({ daily_start_time: null, daily_end_time: null, schedule_value: '30', enabled: 0,
    start_conditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' }] },
    daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
    condition_unmet_policy: 'skip',
  });
  await page.screenshot({ path: testInfo.outputPath('schedule-list.png') });
  await expect(page.getByLabel('任务运行情况', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看任务 定时 JIRA BUG 修复', exact: true }).click();
  await expect(page.getByLabel('每次开始条件 1时间', { exact: true })).toHaveValue('09:00');
  await expect(page.getByLabel('每天停止条件 1时间', { exact: true })).toHaveValue('18:00');
  await expect(page.getByLabel('执行间隔', { exact: true })).toHaveValue('30');
  const save = page.getByRole('button', { name: '保存更改', exact: true });
  expect((await save.boundingBox())!.y).toBeLessThan((await page.getByLabel('任务名称', { exact: true }).boundingBox())!.y);
  await expect(save).toHaveCount(1);
  await expect(page.getByLabel('任务运行情况', { exact: true })).toBeAttached();
  await page.setViewportSize({ width: 900, height: 1000 });
  const [narrowName, narrowPrompt] = await Promise.all([
    page.getByLabel('任务名称', { exact: true }).boundingBox(),
    page.getByLabel('提示词', { exact: true }).boundingBox(),
  ]);
  expect(narrowPrompt!.x).toBe(narrowName!.x);
  expect(narrowPrompt!.y).toBeGreaterThan(narrowName!.y);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.getByLabel('任务运行情况', { exact: true }).scrollIntoViewIfNeeded();
  await expect(save).toBeVisible();
  expect((await save.boundingBox())!.y).toBeLessThan(200);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const projectHeader = page.locator('.page-content.sticky').filter({ has: page.getByRole('heading', { name: '项目', exact: true }) });
  await expect(projectHeader).toBeVisible();
  expect((await projectHeader.boundingBox())!.width).toBeGreaterThan(1700);
  await page.getByTitle('平台管理', { exact: true }).click();
  const platform = page.getByRole('dialog', { name: '平台管理', exact: true });
  await expect(platform).toBeVisible();
  expect((await platform.boundingBox())!.width).toBe(1752);
  await platform.getByRole('button', { name: '平台设置', exact: true }).click();
  const settingsContent = platform.locator('.settings-panel-content');
  await expect(settingsContent).toBeVisible();
  expect((await settingsContent.boundingBox())!.width).toBeGreaterThan(1300);
  await platform.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(platform.getByLabel('内存使用率阈值（%）', { exact: true })).toBeVisible();
  expect((await platform.getByLabel('内存使用率阈值（%）', { exact: true }).boundingBox())!.width).toBeLessThanOrEqual(160);
  await page.screenshot({ path: testInfo.outputPath('compact-settings.png') });
});
