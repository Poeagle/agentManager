import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('project creation stays centered over the current list on desktop and mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.routeWebSocket((url) => url.port === '43111' && url.pathname === '/', () => {});
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true', app_theme: 'light' } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('table', { name: '项目列表', exact: true })).toBeVisible();
  const url = page.url();
  await page.getByRole('button', { name: '新增项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增项目', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('table', { name: '项目列表', exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '项目路径' })).toBeFocused();
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
  const bounds = (await dialog.boundingBox())!;
  expect(Math.abs(bounds.x + bounds.width / 2 - 900)).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - 500)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('centered-add-project.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentmanager:add-project')));
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = (await dialog.boundingBox())!;
  expect(mobile.x).toBeGreaterThanOrEqual(16);
  expect(mobile.width).toBeLessThanOrEqual(358);
  expect(mobile.height).toBeLessThanOrEqual(812);
  expect(Math.abs(mobile.y + mobile.height / 2 - 422)).toBeLessThan(2);
  await dialog.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('centered-add-project-mobile.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

async function structure(table: Locator) {
  return table.evaluate((node) => {
    const header = node.querySelector(':scope > thead > tr > th')!;
    const cell = node.querySelector(':scope > tbody > tr > td')!;
    const wrap = node.parentElement!;
    const tableStyle = getComputedStyle(node);
    const headStyle = getComputedStyle(header);
    const cellStyle = getComputedStyle(cell);
    const wrapStyle = getComputedStyle(wrap);
    return {
      tableClass: node.className, wrapClass: wrap.classList.contains('table-wrap'),
      layout: tableStyle.tableLayout, collapse: tableStyle.borderCollapse,
      font: tableStyle.fontSize, headerFont: headStyle.fontSize, headerWeight: headStyle.fontWeight,
      headerColor: headStyle.color, headerBackground: headStyle.backgroundColor,
      headerPadding: headStyle.padding, cellPadding: cellStyle.padding,
      border: wrapStyle.border, radius: wrapStyle.borderRadius, overflow: wrapStyle.overflowX,
      headersDoNotOverlap: [...node.querySelectorAll(':scope > thead .smart-table-heading')].every((heading) => {
        const sort = heading.querySelector('.smart-table-sort')!.getBoundingClientRect();
        const filter = heading.querySelector('.smart-table-filter')!.getBoundingClientRect();
        return sort.right <= filter.left;
      }),
    };
  });
}

test('all platform lists and expanded lists retain the same table structure', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.routeWebSocket((url) => url.port === '43111' && url.pathname === '/', () => {});
  const status = await (await page.request.get('/api/auth/status')).json();
  const { user } = await (await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).json();
  const path = join(process.cwd(), '.test-data', 'e2e', 'table-consistency-project');
  mkdirSync(path, { recursive: true });
  const existing = (await (await page.request.get('/api/projects')).json()).projects.find((project: { path: string }) => project.path === path);
  const project = existing ?? (await (await page.request.post('/api/projects', { data: { name: 'Consistent Tables', path } })).json()).project;
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true', app_theme: 'light' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: 'home',
  } } });
  await page.goto('/');
  const projects = page.getByRole('table', { name: '项目列表', exact: true });
  await expect(projects.getByRole('button', { name: `打开项目 ${project.name}` })).toBeVisible();
  const baseline = await structure(projects);
  expect(baseline.headersDoNotOverlap).toBe(true);
  const projectRow = projects.getByRole('button', { name: `打开项目 ${project.name}` }).locator('xpath=ancestor::tr');
  expect((await projectRow.boundingBox())!.height).toBeLessThan(48);
  await page.getByRole('button', { name: `展开项目 ${project.name} 的会话` }).click();
  const sessions = page.getByRole('table', { name: '项目会话', exact: true });
  await expect(sessions.getByRole('status')).toHaveText('该项目暂无活动会话');
  expect(await structure(sessions)).toEqual(baseline);
  await expect(sessions.locator('thead')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shared-project-tables.png') });
  await page.getByRole('button', { name: '平台管理', exact: true }).click();
  const platform = page.getByRole('dialog', { name: '平台管理', exact: true });
  const navigation = platform.getByRole('navigation', { name: '平台管理分类' });
  for (const [section, table] of [['用户管理', '用户列表'], ['角色与权限', '角色列表'], ['项目授权', '项目授权']] as const) {
    await navigation.getByRole('button', { name: section, exact: true }).click();
    const list = platform.getByRole('table', { name: table, exact: true });
    await expect(list.locator('tbody > tr').first()).toBeVisible();
    expect(await structure(list)).toEqual(baseline);
  }
  await navigation.getByRole('button', { name: '用户监控', exact: true }).click();
  const monitor = platform.getByRole('table', { name: '用户监控', exact: true });
  await expect(monitor.getByRole('button', { name: `展开用户 ${user.username}` })).toBeVisible();
  expect(await structure(monitor)).toEqual(baseline);
  await monitor.getByRole('button', { name: `展开用户 ${user.username}` }).click();
  const monitoredProjects = platform.getByRole('table', { name: `${user.username} 的项目`, exact: true });
  await expect(monitoredProjects).toBeVisible();
  expect(await structure(monitoredProjects)).toEqual(baseline);
  await platform.getByRole('button', { name: `展开项目 ${project.name}`, exact: true }).click();
  const monitoredSessions = platform.getByRole('table', { name: '会话监控', exact: true });
  await expect(monitoredSessions).toBeVisible();
  expect(await structure(monitoredSessions)).toEqual(baseline);
  await page.screenshot({ path: testInfo.outputPath('shared-monitor-tables.png') });
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await structure(monitoredSessions)).toEqual(baseline);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
});
