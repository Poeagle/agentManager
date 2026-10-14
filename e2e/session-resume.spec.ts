import { expect, test } from '@playwright/test';
import { join } from 'path';

test('Close session releases server resources, removes the tab, and persists the closure', async ({ page }, testInfo) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'persistence-project');
  const existing = (await (await page.request.get('/api/projects')).json()).projects.find((project: { path: string }) => project.path === projectPath);
  const project = existing ?? (await (await page.request.post('/api/projects', { data: { name: 'Close Session Project', path: projectPath } })).json()).project;
  const { session } = await (await page.request.post('/api/sessions', { data: { project_path: projectPath, project_id: project.id, mode: 'terminal' } })).json();
  expect((await page.request.delete(`/api/sessions/${session.id}`)).ok()).toBeTruthy();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } } });
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, { data: { value: {
    terminalInstances: [{ id: session.id, label: 'Close test' }], activeTerminalId: session.id,
    hiddenSessionIds: [], explorerInstances: [],
  } } });
  let closes = 0;
  await page.route(`**/api/sessions/${session.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    closes++;
    if (closes === 1) await route.fulfill({ status: 500, json: { error: 'Test cleanup failure' } });
    else await route.continue();
  });
  await page.goto('/');
  const actions = page.getByRole('group', { name: '会话操作' });
  await expect(actions).toBeVisible();
  const parentBox = await actions.locator('..').boundingBox();
  const actionBox = await actions.boundingBox();
  expect(parentBox).not.toBeNull(); expect(actionBox).not.toBeNull();
  expect(Math.abs(actionBox!.x + actionBox!.width / 2 - parentBox!.x - parentBox!.width / 2)).toBeLessThan(2);
  expect(Math.abs(actionBox!.y + actionBox!.height / 2 - parentBox!.y - parentBox!.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('ended-session-centered.png') });
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(actions.getByRole('alert')).toHaveText('Test cleanup failure');
  await expect(actions).toBeVisible();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(actions).toBeHidden();
  await expect(page.getByText('Close test', { exact: true })).toBeHidden();
  expect(closes).toBe(2);
  await expect.poll(async () => {
    const state = await (await page.request.get('/api/user-state')).json();
    return state.state[`project:${project.id}`]?.terminalInstances?.some((tab: { id: string }) => tab.id === session.id);
  }).toBe(false);
  await page.reload();
  await expect(page.getByRole('group', { name: '会话操作' })).toBeHidden();
  expect((await (await page.request.get(`/api/sessions/${session.id}`)).json()).session.pid).toBeNull();
});

test('Resume shows failure, immediate retry feedback, and progress until terminal readiness', async ({ page }, testInfo) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  })).ok()).toBeTruthy();
  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'persistence-project');
  const existing = (await (await page.request.get('/api/projects')).json()).projects.find((project: { path: string }) => project.path === projectPath);
  const project = existing ?? (await (await page.request.post('/api/projects', {
    data: { name: 'Resume Feedback Project', path: projectPath },
  })).json()).project;
  const { session } = await (await page.request.post('/api/sessions', {
    data: { project_path: projectPath, project_id: project.id, mode: 'terminal' },
  })).json();
  await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
  await page.request.put('/api/user-state/app', { data: { value: {
    projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}`,
  } } });
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, { data: { value: {
    terminalInstances: [{ id: session.id, label: 'Resume test' }], activeTerminalId: session.id,
    hiddenSessionIds: [], explorerInstances: [],
  } } });

  // Simulate a native CLI's delayed restore without launching Claude/Codex or
  // touching the user's real sessions. The full UI and xterm handshake run.
  let row = { ...session, status: 'completed', cli_type: 'codex', codex_session_id: 'test-conversation' };
  let requests = 0;
  let connections = 0;
  let handshakes = 0;
  let extraSessions = 0;
  let releaseResume!: () => void;
  let terminalReady!: () => void;
  let terminalError!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  await page.route('**/api/sessions**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/sessions/${session.id}/resume`) {
      requests++;
      if (requests === 1) {
        await route.fulfill({ status: 400, json: { error: 'Test restore failure' } });
      } else {
        await resumeGate;
        row = { ...row, status: 'running' };
        await route.fulfill({ json: { ok: true, session: row } });
      }
    } else if (url.pathname === '/api/sessions') {
      if (route.request().method() === 'POST') extraSessions++;
      await route.fulfill({ json: { sessions: [row] } });
    } else if (url.pathname === `/api/sessions/${session.id}/rendered-output`) {
      await route.fulfill({ json: { rendered: 'Previously saved conversation\r\n' } });
    } else {
      await route.continue();
    }
  });
  await page.routeWebSocket(`**/api/terminal/${session.id}?**`, (socket) => {
    connections++;
    terminalError = () => socket.send(JSON.stringify({ type: 'error', message: 'Test connection failure' }));
    terminalReady = () => {
      socket.send(JSON.stringify({ type: 'output', data: 'Restored conversation\r\n' }));
      socket.send(JSON.stringify({ type: 'ready' }));
    };
    socket.onMessage((message) => {
      const type = JSON.parse(String(message)).type;
      if (type === 'resize') handshakes++;
      if (type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Test restore failure');
  await page.getByRole('button', { name: '重试恢复会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在恢复…' })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: /Resuming|Session resumed/ })).toContainText('starting session');
  expect(requests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('resume-starting.png') });

  releaseResume();
  await expect(page.getByRole('status').filter({ hasText: /Resuming|Session resumed/ })).toContainText('connecting terminal');
  await expect(page.getByRole('button', { name: '恢复会话', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeHidden();
  await expect.poll(() => typeof terminalReady).toBe('function');
  await page.screenshot({ path: testInfo.outputPath('resume-connecting.png') });
  const connectionsBeforeRetry = connections;
  const handshakesBeforeRetry = handshakes;
  terminalError();
  await expect(page.getByRole('alert')).toContainText('Test connection failure');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(() => connections).toBeGreaterThan(connectionsBeforeRetry);
  await expect.poll(() => handshakes).toBeGreaterThan(handshakesBeforeRetry);
  terminalReady();
  await expect(page.getByRole('status').filter({ hasText: /Resuming|Session resumed/ })).toHaveText('Session resumed');
  await expect(page.getByRole('status').filter({ hasText: /Resuming|Session resumed/ })).toBeHidden();
  expect(requests).toBe(2);
  expect(extraSessions).toBe(0);
});
