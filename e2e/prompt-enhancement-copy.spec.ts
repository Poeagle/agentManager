import { expect, test } from '@playwright/test';
import { join } from 'path';

async function authenticate(page: import('@playwright/test').Page) {
  await page.goto('/');
  const createHeading = page.getByRole('heading', { name: '创建管理员账户' });
  if (await createHeading.isVisible().catch(() => false)) {
    await page.getByLabel('用户名').fill('e2e-admin');
    await page.getByLabel('显示名(可选)').fill('E2E Admin');
    await page.getByLabel('密码').fill('test-password');
    await page.getByRole('button', { name: '创建并进入' }).click();
  } else {
    await page.getByLabel('用户名').fill('e2e-admin');
    await page.getByLabel('密码').fill('test-password');
    await page.getByRole('button', { name: '登录' }).click();
  }
  await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible();
}

test('copying an enhanced prompt keeps the preview open and never writes to the terminal', async ({ page }) => {
  await authenticate(page);
  // Keep the mounted dashboard from persisting its initial empty tab state
  // over the server state this test is about to create.
  await page.goto('about:blank');

  const projectPath = join(process.cwd(), '.test-data', 'e2e', 'prompt-copy-project');
  const projectResponse = await page.request.post('/api/projects', {
    data: { name: 'Prompt Copy Project', path: projectPath },
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
        projectTabs: [{ projectId: project.id, projectName: project.name }],
        activeTab: `project-${project.id}`,
      },
    },
  })).ok()).toBeTruthy();
  expect((await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, {
    data: {
      value: {
        terminalLabels: { [session.id]: 'prompt-copy-terminal' },
        terminalInstances: [{ id: session.id, label: 'Terminal 1', customLabel: 'prompt-copy-terminal' }],
        activeTerminalId: session.id,
        hiddenSessionIds: [],
        explorerInstances: [],
        webPageInstances: [],
      },
    },
  })).ok()).toBeTruthy();

  const terminalWrites: string[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes(`/api/terminal/${session.id}`)) return;
    socket.on('framesent', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString();
      try {
        const message = JSON.parse(text);
        if (message.type === 'input' || message.type === 'replace-input') terminalWrites.push(text);
      } catch { /* terminal protocol is JSON-only */ }
    });
  });

  await page.route('**/api/prompt-enhancer/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        prompt: 'Enhanced copy-only prompt',
        context: { requested_rounds: 3, included_rounds: 2 },
      }),
    });
  });

  await page.goto('/');
  const dismissStatusline = page.getByRole('button', { name: 'No thanks' });
  if (await dismissStatusline.isVisible().catch(() => false)) {
    await dismissStatusline.click();
    await expect(dismissStatusline).toBeHidden();
  }
  const terminalInput = page.locator('.xterm-helper-textarea').last();
  await expect(terminalInput).toBeVisible();
  await terminalInput.click();
  await page.keyboard.type('Original terminal draft');
  const renderedTerminal = async () => {
    const response = await page.request.get(`/api/sessions/${session.id}/rendered-output`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()).rendered as string;
  };
  await expect.poll(renderedTerminal).toContain('Original terminal draft');

  await page.getByRole('button', { name: '优化当前 Terminal 输入' }).click();
  const preview = page.getByRole('dialog', { name: '提示词优化预览' });
  await expect(preview).toBeVisible();
  const enhancedEditor = preview.getByLabel('编辑优化后的提示词');
  await expect(enhancedEditor).toHaveValue('Enhanced copy-only prompt');
  await expect(preview.getByText('已参考最近 2 轮')).toBeVisible();

  terminalWrites.length = 0;
  await enhancedEditor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await expect(preview).toBeVisible();
  await page.waitForTimeout(100);
  expect(terminalWrites).toEqual([]);
  await expect.poll(renderedTerminal).toContain('Original terminal draft');

  terminalWrites.length = 0;
  await preview.getByRole('button', { name: '复制优化结果' }).click();
  await expect(preview).toBeVisible();
  await expect(preview.getByText('已复制；预览保持打开，终端原输入未修改')).toBeVisible();
  await page.waitForTimeout(300);
  expect(terminalWrites).toEqual([]);

  await preview.getByRole('button', { name: '保留原输入' }).click();
  await expect(preview).toBeHidden();
  await expect.poll(renderedTerminal).toContain('Original terminal draft');
});
