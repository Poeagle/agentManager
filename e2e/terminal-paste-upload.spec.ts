import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWv8AAAAASUVORK5CYII=';

async function paste(page: Page, file?: { name: string; type: string; base64?: string; text?: string }, text?: string) {
  await page.locator('.xterm-helper-textarea:visible').first().evaluate((element, data) => {
    const clipboard = new DataTransfer();
    if (data.file) {
      const bytes = data.file.base64
        ? Uint8Array.from(atob(data.file.base64), char => char.charCodeAt(0))
        : new TextEncoder().encode(data.file.text || '');
      clipboard.items.add(new File([bytes], data.file.name, { type: data.file.type }));
    }
    if (data.text) clipboard.setData('text/plain', data.text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  }, { file, text });
}

test('screenshot and file paste reach only the active input; text stays single and failed uploads show an error', async ({ page }) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(status.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(auth.ok()).toBeTruthy();

  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'paste-project');
  mkdirSync(projectPath, { recursive: true });
  const projectResponse = await page.request.post('/api/projects', { data: { name: 'Paste Project', path: projectPath } });
  expect(projectResponse.ok()).toBeTruthy();
  const { project } = await projectResponse.json();
  const sessions = [];
  for (const cli_type of ['claude', 'codex']) {
    const response = await page.request.post('/api/sessions', {
      data: { project_path: projectPath, project_id: project.id, mode: 'terminal', cli_type },
    });
    expect(response.ok()).toBeTruthy();
    sessions.push((await response.json()).session as { id: string });
  }
  expect((await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } })).ok()).toBeTruthy();
  expect((await page.request.put('/api/user-state/app', { data: {
    value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` },
  } })).ok()).toBeTruthy();
  expect((await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, { data: {
    value: {
      terminalLabels: { [sessions[0].id]: 'paste-claude', [sessions[1].id]: 'paste-codex' },
      terminalInstances: [
        { id: sessions[0].id, label: 'Terminal 1', customLabel: 'paste-claude' },
        { id: sessions[1].id, label: 'Terminal 2', customLabel: 'paste-codex' },
      ],
      activeTerminalId: sessions[0].id, hiddenSessionIds: [], explorerInstances: [],
    },
  } })).ok()).toBeTruthy();

  const writes = new Map<string, Array<{ type: string; data?: string }>>();
  page.on('websocket', socket => {
    const session = sessions.find(item => socket.url().includes(`/api/terminal/${item.id}`));
    if (!session) return;
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(typeof payload === 'string' ? payload : payload.toString());
        if (message.type === 'input') writes.set(session.id, [...(writes.get(session.id) || []), message]);
      } catch { /* terminal protocol is JSON */ }
    });
  });

  await page.goto('/');
  await expect(page.locator('.xterm-helper-textarea:visible').first()).toBeVisible();
  const firstWrites = () => writes.get(sessions[0].id) || [];
  const secondWrites = () => writes.get(sessions[1].id) || [];

  await paste(page, { name: 'screenshot.png', type: 'image/png', base64: PNG });
  await expect.poll(() => firstWrites().filter(item => item.data?.includes('/pastes/paste-')).length).toBe(1);
  const imageInput = firstWrites().find(item => item.data?.includes('/pastes/paste-'))!.data!;
  expect(imageInput).not.toContain('\r');
  expect(readFileSync(imageInput.trim())).toEqual(Buffer.from(PNG, 'base64'));

  // Some browsers expose screenshots through clipboardData.items but leave files empty.
  await page.locator('.xterm-helper-textarea:visible').first().evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const image = new File([bytes], 'items-only.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      files: [], items: [{ kind: 'file', getAsFile: () => image }], getData: () => '',
    } });
    element.dispatchEvent(event);
  }, PNG);
  await expect.poll(() => firstWrites().filter(item => item.data?.includes('/pastes/paste-')).length).toBe(2);

  await paste(page, undefined, 'one plain text paste');
  await expect.poll(() => firstWrites().filter(item => item.data === 'one plain text paste').length).toBe(1);
  await page.waitForTimeout(200);
  expect(firstWrites().filter(item => item.data === 'one plain text paste')).toHaveLength(1);

  await paste(page, { name: 'notes.txt', type: 'text/plain', text: 'file contents' });
  await expect.poll(() => firstWrites().filter(item => item.data?.includes('notes.txt')).length).toBe(1);
  const fileInput = firstWrites().find(item => item.data?.includes('notes.txt'))!.data!;
  expect(readFileSync(fileInput.trim(), 'utf8')).toBe('file contents');

  await page.locator('.xterm-helper-textarea:visible').first().evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['dropped contents'], 'dropped.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect.poll(() => firstWrites().filter(item => item.data?.includes('dropped.txt')).length).toBe(1);
  const droppedInput = firstWrites().find(item => item.data?.includes('dropped.txt'))!.data!;
  expect(readFileSync(droppedInput.trim(), 'utf8')).toBe('dropped contents');

  await page.route(`**/api/sessions/${sessions[0].id}/paste-image`, route => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Upload failed in test' }),
  }));
  const beforeFailure = firstWrites().length;
  await paste(page, { name: 'screenshot.png', type: 'image/png', base64: PNG });
  await expect(page.getByRole('alert').filter({ hasText: 'Upload failed in test' })).toBeVisible();
  expect(firstWrites()).toHaveLength(beforeFailure);
  await page.unroute(`**/api/sessions/${sessions[0].id}/paste-image`);

  let releaseUpload: (() => void) | undefined;
  let requestStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  await page.route(`**/api/sessions/${sessions[0].id}/paste-image`, async route => {
    requestStarted?.();
    await new Promise<void>(resolve => { releaseUpload = resolve; });
    await route.fulfill({ json: { ok: true, path: '/should-not-reach-either-session.png' } }).catch(() => {});
  });
  await paste(page, { name: 'screenshot.png', type: 'image/png', base64: PNG });
  await started;
  await page.getByRole('button', { name: 'paste-codex' }).click();
  await expect(page.locator('.xterm-helper-textarea:visible').first()).toBeVisible();
  releaseUpload?.();
  await page.waitForTimeout(300);
  expect(firstWrites().some(item => item.data?.includes('should-not-reach'))).toBe(false);
  expect(secondWrites().some(item => item.data?.includes('should-not-reach'))).toBe(false);
});
