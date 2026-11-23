import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('keeps automatic context cards compact and leaves room around scrollable details', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/status')).json();
  const login = await page.request.post(auth.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
    data: { username: 'e2e-admin', password: 'test-password' },
  });
  expect(login.ok()).toBeTruthy();

  const root = join(process.cwd(), '.test-data/e2e');
  const projectPath = join(root, 'automatic-context-project');
  const logDirectory = join(root, 'home/.codex/sessions');
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  const { project } = await (await page.request.post('/api/projects', {
    data: { name: 'Automatic context layout', path: projectPath },
  })).json();
  const { session } = await (await page.request.post('/api/sessions', {
    data: { project_id: project.id, project_path: projectPath, mode: 'terminal' },
  })).json();
  const native = '019ff001-abcd-7abc-8abc-abcdefabcd02';
  const rules = [
    `# AGENTS.md instructions for ${projectPath}`,
    '<INSTRUCTIONS>',
    ...Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 条项目规则。`),
    '规则正文结束。',
    '</INSTRUCTIONS>',
    '<environment_context><cwd>/project</cwd></environment_context>',
  ].join('\n\n');
  const message = (id: string, text: string) => JSON.stringify({
    type: 'response_item',
    timestamp: '2026-11-23T08:40:42Z',
    payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
  });
  writeFileSync(join(logDirectory, `rollout-layout-${native}.jsonl`), [
    message('resources', '<octoally_shared_resources>\n凭据文件：/project/.env\n使用说明。\n</octoally_shared_resources>'),
    message('rules', rules),
  ].join('\n') + '\n');

  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(root, 'agentmanager.db'));
  try {
    db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex', native, session.id);
  } finally {
    db.close();
  }

  try {
    await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });
    await page.request.put('/api/user-state/app', {
      data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } },
    });
    await page.request.put(`/api/user-state/project%3A${project.id}`, {
      data: { value: { terminalInstances: [{ id: session.id, label: '自动信息测试' }], activeTerminalId: session.id, explorerInstances: [] } },
    });
    await page.goto('/');

    const chat = page.getByRole('region', { name: '会话对话' }).filter({ visible: true });
    const title = '自动信息 · 项目规则 · 运行环境';
    const rulesCard = chat.getByRole('button', { name: new RegExp(title) });
    const resourcesCard = chat.getByRole('button', { name: /自动信息 · 共享资源/ });
    const dialog = page.getByRole('dialog', { name: title });

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 680 });
      for (const card of [rulesCard, resourcesCard]) {
        await expect(card).toBeVisible();
        expect.soft((await card.boundingBox())!.height).toBeLessThanOrEqual(30);
      }
      await rulesCard.click();
      await expect(dialog.getByRole('heading', { name: '项目规则', exact: true })).toBeVisible();
      const dialogTitle = dialog.getByRole('heading', { name: title });
      await expect(dialogTitle).toBeVisible();
      const topInset = (await dialogTitle.boundingBox())!.y - (await dialog.boundingBox())!.y;
      expect.soft(topInset).toBeGreaterThanOrEqual(22);

      const lastSection = dialog.getByRole('heading', { name: '运行环境', exact: true });
      await lastSection.scrollIntoViewIfNeeded();
      await expect(lastSection).toBeInViewport();
      const scrollInset = await lastSection.evaluate(heading => {
        const panel = heading.closest('[role="dialog"]')!;
        const scrollArea = heading.closest('.overflow-y-auto')!;
        return panel.getBoundingClientRect().bottom - scrollArea.getBoundingClientRect().bottom;
      });
      expect.soft(scrollInset).toBeGreaterThanOrEqual(10);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(rulesCard).toBeFocused();
    }
  } finally {
    await page.request.delete(`/api/sessions/${session.id}`);
  }
});
