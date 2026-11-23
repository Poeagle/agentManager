import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('project history queues a confirmed ended record and removes its persisted tab after cleanup', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.routeWebSocket((url) => url.port === (process.env.E2E_UI_PORT || '43111') && url.pathname === '/', () => {});
  const status = await (await page.request.get('/api/auth/status')).json();
  const { user } = await (await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).json();
  const path = join(process.cwd(), '.test-data', 'e2e', 'history-delete-project');
  mkdirSync(path, { recursive: true });
  const created = await page.request.post('/api/projects', { data: { name: 'Delete History Project', path } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  const session = { id: 'history-delete-fixture', project_id: project.id, task: '历史测试任务', status: 'cancelled', mode: 'session', cli_type: 'codex',
    created_by_user_id: user.id, pid: null, exit_code: null, started_at: null, completed_at: '2026-10-14T09:00:00Z', created_at: '2026-10-14T08:00:00Z' };
  const other = { ...session, id: 'history-keep-fixture', task: '保留的会话' };
  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(process.cwd(), '.test-data', 'e2e', 'agentmanager.db'));
  try {
    const insert = db.prepare(`INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id,created_at,completed_at)
      VALUES (@id,@project_id,@task,@status,@mode,@cli_type,@created_by_user_id,@created_at,@completed_at)`);
    insert.run(session);
    insert.run(other);
  } finally { db.close(); }
  let deletes = 0;
  await page.route('**/api/sessions/records/ended', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ project_id: project.id, session_ids: [session.id] });
    deletes++;
    if (deletes === 1) return route.fulfill({ status: 409, json: { error: '删除接口测试失败' } });
    return route.continue();
  });
  const snapshot = { activeMode: 'history', terminalInstances: [{ id: session.id, label: 'Session 1', customLabel: '历史测试会话' }],
    activeTerminalId: session.id, hiddenSessionIds: [], explorerInstances: [], activeExplorerId: null };
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true', app_theme: 'light' } } });
  await page.request.put('/api/user-state/app', { data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } } });
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, { data: { value: snapshot } });
  await page.addInitScript(({ userId, projectId, state }) => {
    localStorage.setItem(`agentmanager-project-${userId}-${projectId}`, JSON.stringify(state));
  }, { userId: user.id, projectId: project.id, state: snapshot });
  await page.goto('/');
  const table = page.getByRole('table', { name: '会话历史', exact: true });
  await expect(table.getByRole('columnheader').last()).toHaveText('操作');
  const remove = table.getByRole('button', { name: '删除会话 历史测试会话', exact: true });
  await expect(remove).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('session-history-actions.png') });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '删除记录', exact: true });
  await expect(dialog).toBeVisible();
  expect(deletes).toBe(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(remove).toBeVisible();
  await remove.click();
  await dialog.getByRole('button', { name: '删除记录', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除接口测试失败');
  await expect(remove).toBeVisible();
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/records/ended' && response.status() === 202);
  await dialog.getByRole('button', { name: '删除记录', exact: true }).click();
  await accepted;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已提交 1 条后台删除。', { exact: true })).toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(table.getByRole('button', { name: '删除会话 保留的会话' })).toBeVisible();
  expect(deletes).toBe(2);
  await expect.poll(async () => {
    const { state } = await (await page.request.get('/api/user-state')).json();
    return state[`project:${project.id}`]?.terminalInstances?.some((tab: { id: string }) => tab.id === session.id);
  }).toBe(false);
});

test('submits another project’s 33 selected records immediately after the first 26', async ({ page }) => {
  const { needsSetup } = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  const projects: Array<{ id: string; name: string; selectedIds: string[] }> = [];
  for (const [suffix, count] of [['A', 26], ['B', 33]] as const) {
    const path = join(process.cwd(), '.test-data', 'e2e', `history-bulk-delete-${suffix}`);
    mkdirSync(path, { recursive: true });
    const name = `Bulk Delete Project ${suffix}`;
    const created = await page.request.post('/api/projects', { data: { name, path } });
    expect(created.ok()).toBeTruthy();
    const { project } = await created.json();
    projects.push({ id: project.id, name, selectedIds: Array.from({ length: count }, (_, index) => `bulk-${suffix}-${index + 1}`) });
  }

  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(process.cwd(), '.test-data', 'e2e', 'agentmanager.db'));
  try {
    const insert = db.prepare(`INSERT INTO sessions(id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, ?, ?, 'completed', 'session', ?, ?)`);
    db.transaction(() => {
      for (const project of projects) {
        project.selectedIds.forEach((id, index) => insert.run(id, project.id, `批量测试 ${index + 1}`, index % 2 ? 'claude' : 'codex', user.id));
        insert.run(`keep-${project.id}`, project.id, '未勾选的会话', 'claude', user.id);
      }
    })();
  } finally {
    db.close();
  }

  const snapshots = projects.map(project => ({ projectId: project.id, state: {
    activeMode: 'history', terminalInstances: [{ id: project.selectedIds[0], label: '批量测试 1' }],
    activeTerminalId: project.selectedIds[0], hiddenSessionIds: [], explorerInstances: [], activeExplorerId: null,
  } }));
  for (const { projectId, state } of snapshots) {
    expect((await page.request.put(`/api/user-state/${encodeURIComponent(`project:${projectId}`)}`, { data: { value: state } })).ok()).toBeTruthy();
  }
  expect((await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: projects.map(project => ({ projectId: project.id, projectName: project.name })), activeTab: `project-${projects[0].id}`,
  } } })).ok()).toBeTruthy();
  await page.addInitScript(({ userId, snapshots }) => {
    for (const { projectId, state } of snapshots) {
      localStorage.setItem(`agentmanager-project-${userId}-${projectId}`, JSON.stringify(state));
    }
  }, { userId: user.id, snapshots });

  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: '项目标签' });
  const table = page.getByRole('table', { name: '会话历史', exact: true });
  const all = table.getByRole('checkbox', { name: '全选可删除会话' });
  const keep = table.getByRole('checkbox', { name: '选择会话 未勾选的会话' });
  for (const { id, name, selectedIds } of projects) {
    await tabs.getByRole('button', { name, exact: true }).click();
    await all.check();
    await keep.uncheck();
    await page.getByRole('button', { name: `批量删除 (${selectedIds.length})`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '批量删除会话记录' });
    const response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/sessions/records/ended');
    await dialog.getByRole('button', { name: '确认批量删除' }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const requestBody = accepted.request().postDataJSON();
    const result = await accepted.json();
    expect(requestBody.project_id).toBe(id);
    expect([...requestBody.session_ids].sort()).toEqual([...selectedIds].sort());
    expect([...result.accepted_ids].sort()).toEqual([...selectedIds].sort());
    expect(result.rejected_ids).toEqual([]);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`已提交 ${selectedIds.length} 条后台删除。`, { exact: true })).toBeVisible();
    await expect(keep).toBeEnabled();
  }
  for (const { name } of projects) {
    await tabs.getByRole('button', { name, exact: true }).click();
    await expect(table.getByRole('checkbox', { name: /选择会话 批量测试/ })).toHaveCount(0);
    await expect(keep).toBeEnabled();
  }
  await expect.poll(async () => {
    const { state } = await (await page.request.get('/api/user-state')).json();
    return projects.map(({ id }) => state[`project:${id}`]?.terminalInstances);
  }).toEqual([[], []]);
});
