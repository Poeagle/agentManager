import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('keeps automatic context and scheduled input cards equally compact with room around scrollable details', async ({ page }) => {
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
  const message = (id: string, text: string, role = 'user') => JSON.stringify({
    type: 'response_item',
    timestamp: '2026-11-23T08:40:42Z',
    payload: { type: 'message', id, role, content: [{ type: 'input_text', text }] },
  });
  const resourceNotice = '<octoally_shared_resources>\n凭据文件：/project/.env\n使用说明。\n</octoally_shared_resources>';
  const skillIndex = 'You are in an Agent Manager tab. The platform skill agent-docs covers finding tabs, delegating work, reading progress and returning results. Load /project/agent-docs/SKILL.md only when this task calls for collaboration. The platform supplies the scoped tab credential to the included client automatically.';
  const scheduledInput = {
    type: 'event_msg',
    timestamp: '2026-11-23T08:40:43Z',
    payload: {
      type: 'item_completed',
      turn_id: 'scheduled-turn',
      item: {
        type: 'UserMessage',
        id: 'scheduled-input',
        client_id: 'scheduled-layout-client',
        content: [{ type: 'text', text: '定时任务正文' }],
      },
    },
  };
  writeFileSync(join(logDirectory, `rollout-layout-${native}.jsonl`), [
    message('platform-context', `${resourceNotice}\n\n${skillIndex}`, 'developer'),
    message('rules', rules),
    JSON.stringify(scheduledInput),
  ].join('\n') + '\n');

  const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db = new Database(join(root, 'agentmanager.db'));
  try {
    db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex', native, session.id);
    db.prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label) VALUES(?,?,?,?)')
      .run(session.id, scheduledInput.payload.item.client_id, 'scheduled', '每日会话布局与详情弹窗巡检');
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
    const platformTitle = '自动信息 · 共享资源 · agent-docs';
    const resourcesCard = chat.getByRole('button', { name: new RegExp(platformTitle) });
    const scheduledCard = chat.getByRole('button', { name: /定时任务 每日会话布局与详情弹窗巡检/ });
    const dialog = page.getByRole('dialog', { name: title });

    await resourcesCard.click();
    const platformDialog = page.getByRole('dialog', { name: platformTitle });
    const sections = platformDialog.getByRole('heading', { level: 2 });
    await expect(sections).toHaveText(['共享资源', 'agent-docs']);
    await expect(platformDialog).toContainText('/project/agent-docs/SKILL.md');
    await page.keyboard.press('Escape');

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 680 });
      const cards = [resourcesCard, rulesCard, scheduledCard];
      for (const card of cards) {
        await expect(card).toBeVisible();
        expect.soft(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      const [resourcesBox, rulesBox, scheduledBox] = await Promise.all(
        cards.map(async card => (await card.boundingBox())!),
      );
      expect.soft(resourcesBox.height).toBeLessThanOrEqual(30);
      expect.soft(rulesBox.height).toBe(resourcesBox.height);
      expect.soft(scheduledBox.height).toBe(resourcesBox.height);
      for (const gap of [
        rulesBox.y - resourcesBox.y - resourcesBox.height,
        scheduledBox.y - rulesBox.y - rulesBox.height,
      ]) {
        expect.soft(gap).toBeGreaterThan(0);
        expect.soft(gap).toBeLessThanOrEqual(6);
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
