import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('project history deletes a confirmed ended record and removes its persisted tab', async ({ page }, testInfo) => {
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
  let records = [session, other];
  let deletes = 0;
  // Exercise UI deletion and persistence without launching a CLI or deleting a real conversation.
  await page.route('**/api/sessions**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sessions') return route.fulfill({ json: { sessions: records } });
    if (url.pathname === `/api/sessions/${session.id}/record`) {
      expect(route.request().method()).toBe('DELETE');
      deletes++;
      if (deletes === 1) return route.fulfill({ status: 500, json: { error: '删除接口测试失败' } });
      records = records.filter((row) => row.id !== session.id);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.endsWith('/rendered-output')) return route.fulfill({ json: { rendered: 'Saved conversation' } });
    if (url.pathname.endsWith('/output')) return route.fulfill({ json: { chunks: [], hasMore: false, oldestSeq: null } });
    if (url.pathname === `/api/sessions/${session.id}`) return route.fulfill({ json: { session } });
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
  await dialog.getByRole('button', { name: '删除记录', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  await expect(table.getByRole('button', { name: '删除会话 保留的会话' })).toBeVisible();
  expect(deletes).toBe(2);
  await expect.poll(async () => {
    const { state } = await (await page.request.get('/api/user-state')).json();
    return state[`project:${project.id}`]?.terminalInstances?.some((tab: { id: string }) => tab.id === session.id);
  }).toBe(false);
});

test('submits 26 selected history records together and refreshes the history after cleanup', async ({ page }) => {
  const { needsSetup } = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();
  const { user } = await login.json();
  const path = join(process.cwd(), '.test-data', 'e2e', 'history-bulk-delete-project');
  mkdirSync(path, { recursive: true });
  const created = await page.request.post('/api/projects', { data: { name: 'Bulk Delete History Project', path } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();

  const selectedIds = Array.from({ length: 26 }, (_, index) => `bulk-history-${index + 1}`);
  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(process.cwd(), '.test-data', 'e2e', 'agentmanager.db'));
  try {
    const insert = db.prepare(`INSERT INTO sessions(id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, ?, ?, 'completed', 'session', ?, ?)`);
    db.transaction(() => {
      selectedIds.forEach((id, index) => insert.run(id, project.id, `批量测试 ${index + 1}`, index % 2 ? 'claude' : 'codex', user.id));
      insert.run('bulk-history-keep', project.id, '未勾选的会话', 'claude', user.id);
    })();
  } finally {
    db.close();
  }

  const snapshot = { activeMode: 'history', terminalInstances: [{ id: selectedIds[0], label: '批量测试 1' }],
    activeTerminalId: selectedIds[0], hiddenSessionIds: [], explorerInstances: [], activeExplorerId: null };
  const projectState = `project:${project.id}`;
  expect((await page.request.put(`/api/user-state/${encodeURIComponent(projectState)}`, { data: { value: snapshot } })).ok()).toBeTruthy();
  expect((await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } })).ok()).toBeTruthy();
  await page.addInitScript(({ userId, projectId, state }) => {
    localStorage.setItem(`agentmanager-project-${userId}-${projectId}`, JSON.stringify(state));
  }, { userId: user.id, projectId: project.id, state: snapshot });

  await page.goto('/');
  const table = page.getByRole('table', { name: '会话历史', exact: true });
  const all = table.getByRole('checkbox', { name: '全选可删除会话' });
  const keep = table.getByRole('checkbox', { name: '选择会话 未勾选的会话' });
  await all.check();
  await keep.uncheck();
  await page.getByRole('button', { name: '批量删除 (26)', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量删除会话记录' });
  const response = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/sessions/records/ended');
  await dialog.getByRole('button', { name: '确认批量删除' }).click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  const requestBody = accepted.request().postDataJSON();
  const result = await accepted.json();
  expect(requestBody.project_id).toBe(project.id);
  expect([...requestBody.session_ids].sort()).toEqual([...selectedIds].sort());
  expect([...result.accepted_ids].sort()).toEqual([...selectedIds].sort());
  expect(result.rejected_ids).toEqual([]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已提交 26 条后台删除。', { exact: true })).toBeVisible();
  await expect(keep).toBeEnabled();
  await expect(table.getByRole('checkbox', { name: /选择会话 批量测试/ })).toHaveCount(0);
  await expect.poll(async () => {
    const { state } = await (await page.request.get('/api/user-state')).json();
    return state[projectState]?.terminalInstances;
  }).toEqual([]);
});
