import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test('keeps session context collapsed and pinned above paginated messages in injection order', async ({ page }) => {
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
    payload: { type: 'message', id, role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
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
    message('duplicate-resource', resourceNotice, 'developer'),
    ...Array.from({ length: 50 }, (_, index) => message(`reply-${index}`, `历史回答 ${index + 1}`, 'assistant')),
    message('updated-resource', resourceNotice.replace('使用说明。', '更新后的说明。'), 'developer'),
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
    const header = chat.getByText('会话上下文 · 5', { exact: true });
    const panel = chat.getByRole('list', { name: '已注入的上下文' });
    const scheduled = chat.getByRole('button', { name: /定时任务 每日会话布局与详情弹窗巡检/ });
    const scroll = chat.locator('.session-chat-scroll');
    await expect(header).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(scroll.getByRole('button', { name: /自动信息.*项目规则/ })).toHaveCount(0);
    await expect(scheduled).toBeVisible();

    const pinned = (await header.boundingBox())!;
    const reading = (await scroll.boundingBox())!;
    expect(reading.x + reading.width - pinned.x - pinned.width).toBeLessThan(50);
    await scroll.evaluate(element => { element.scrollTop = 0; });
    expect((await header.boundingBox())!.y).toBeCloseTo(pinned.y, 0);
    await header.press('Enter');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button')).toHaveText([
      /共享资源/, /agent-docs/, /项目规则/, /运行环境/, /共享资源/,
    ]);

    await panel.getByRole('button', { name: /agent-docs/ }).click();
    await expect(page.getByRole('dialog', { name: '自动信息 · agent-docs' })).toContainText('/project/agent-docs/SKILL.md');
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: /共享资源/ }).last().click();
    await expect(page.getByRole('dialog', { name: '自动信息 · 共享资源' })).toContainText('更新后的说明。');
    await page.keyboard.press('Escape');

    const rulesCard = panel.getByRole('button', { name: /项目规则/ });
    const dialog = page.getByRole('dialog', { name: '自动信息 · 项目规则' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 680 });
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(30);
      const panelBox = (await panel.boundingBox())!;
      expect(panelBox.x).toBeGreaterThanOrEqual(0);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(width);
      await rulesCard.click();
      await expect(dialog.getByRole('heading', { name: '项目规则', exact: true })).toBeVisible();
      await dialog.getByText('规则正文结束。', { exact: false }).scrollIntoViewIfNeeded();
      await expect(dialog.getByText('规则正文结束。', { exact: false })).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(rulesCard).toBeFocused();
    }

    await header.click();
    await chat.getByRole('button', { name: '加载更早的对话' }).click();
    await expect(chat.getByText('历史回答 1', { exact: true })).toBeAttached();
    await expect(header).toBeVisible();
    await page.reload();
    await expect(header).toBeVisible();
    await expect(panel).toBeHidden();
  } finally {
    await page.request.delete(`/api/sessions/${session.id}`);
  }
});
