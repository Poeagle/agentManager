import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

test.use({ timezoneId: 'Asia/Taipei' });

for (const agent of ['codex', 'claude']) {
  test(`restores scheduled input and brief history in ${agent} at desktop and narrow widths`, async ({ page }) => {
    const auth = await (await page.request.get('/api/auth/status')).json();
    expect((await page.request.post(auth.needsSetup ? '/api/auth/setup' : '/api/auth/login', {
      data: { username: 'e2e-admin', password: 'test-password' },
    })).ok()).toBeTruthy();

    const root = join(process.cwd(), '.test-data/e2e');
    const projectPath = join(root, `scheduled-card-${agent}`);
    mkdirSync(projectPath, { recursive: true });
    const { project } = await (await page.request.post('/api/projects', {
      data: { name: '定时卡片', path: projectPath },
    })).json();
    const { session } = await (await page.request.post('/api/sessions', {
      data: { project_id: project.id, project_path: projectPath, mode: 'terminal' },
    })).json();

    try {
      const native = randomUUID();
      const client = randomUUID();
      const timestamp = '2026-11-01T16:23:45.500Z';
      const context = {
        version: 1,
        turns: [{ input: '上一轮巡检提示', scheduled_task: '每日巡检', conclusion: '上一轮巡检结论' }],
        truncated: true,
        older_omitted: false,
        omitted_turns: 0,
      };
      const text = '以下是上一会话的记录节选，可能不完整，仅供当前需求参考：\n<agentmanager_brief_context>\n' +
        JSON.stringify(context) + '\n</agentmanager_brief_context>\n\n当前需求：\n定时提示正文\n第二行';
      const directory = agent === 'codex' ? join(root, 'home/.codex/sessions')
        : join(root, 'home/.claude/projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(directory, { recursive: true });
      const row = agent === 'codex' ? {
        type: 'event_msg', timestamp, payload: {
          type: 'item_completed', turn_id: 'turn', item: {
            type: 'UserMessage', id: 'scheduled-item', client_id: client, content: [{ type: 'text', text }],
          },
        },
      } : { type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: text } };
      writeFileSync(join(directory, agent === 'codex' ? `rollout-card-${native}.jsonl` : `${native}.jsonl`),
        JSON.stringify(row) + '\n');

      const Database = createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
      const db = new Database(join(root, 'agentmanager.db'));
      try {
        db.prepare('UPDATE sessions SET cli_type=?,agent_id=?,native_session_id=?,codex_session_id=?,claude_session_id=? WHERE id=?')
          .run(agent, agent, native, agent === 'codex' ? native : null, agent === 'claude' ? native : null, session.id);
        // Codex echoes the client ID. Claude keeps a native user message ID.
        const history = await page.request.get(`/api/sessions/${session.id}/conversation`);
        expect(history.ok()).toBeTruthy();
        const { messages } = await history.json();
        const message = messages.find((item: { role: string; text: string }) => item.role === 'user' && item.text === text);
        expect(message?.id).toBeTruthy();
        db.prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label,message_id) VALUES(?,?,?,?,?)')
          .run(session.id, client, 'scheduled', '每日巡检', agent === 'claude' ? message.id : null);
      } finally {
        db.close();
      }

      await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true', app_theme: 'light' } } });
      await page.request.put('/api/user-state/app', {
        data: { value: { projectTabs: [{ projectId: project.id, projectName: project.name }], activeTab: `project-${project.id}` } },
      });
      await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`, {
        data: { value: { terminalInstances: [{ id: session.id, label: '定时卡片' }], activeTerminalId: session.id, explorerInstances: [] } },
      });
      await page.routeWebSocket('**/conversation/stream*', socket => {
        socket.send(JSON.stringify({ type: 'snapshot', messages: [], busy: false, stage: 'idle' }));
      });

      const chat = page.getByRole('region', { name: '会话对话' }).filter({ visible: true });
      const card = chat.getByRole('button', { name: /定时任务 每日巡检/ });
      const brief = chat.getByRole('button', { name: /简要压缩 1 轮/ });
      const taskDialog = page.getByRole('dialog', { name: '定时任务 · 每日巡检' });
      const historyDialog = page.getByRole('dialog', { name: '简要压缩详情' });

      await page.goto('/');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(brief).toBeVisible();
        await expect(brief).toHaveCount(1);
        await expect(brief).toContainText('1 轮');
        await expect(brief).toContainText('部分记录已截取');
        await expect(card).toBeVisible();
        await expect(historyDialog).toHaveCount(0);
        await expect(taskDialog).toHaveCount(0);
        expect((await brief.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);

        const time = card.locator('time');
        await expect(time).toHaveAttribute('datetime', timestamp);
        await expect(time).toHaveText('2026-11-02 00:23:45');
        await expect(time).toBeInViewport();
        expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

        await brief.click();
        await expect(historyDialog.getByText('上一轮巡检结论', { exact: true })).toBeVisible();
        await expect(historyDialog.getByText('上一轮巡检提示', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(historyDialog).toHaveCount(0);
        await expect(brief).toBeFocused();

        await card.click();
        await expect(taskDialog).toBeVisible();
        await expect(taskDialog).toContainText('定时提示正文');
        await expect(taskDialog).not.toContainText('上一轮巡检结论');
        const box = (await taskDialog.boundingBox())!;
        expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
        expect(await taskDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(taskDialog).toHaveCount(0);
        await expect(card).toBeFocused();
        if (width === 1440) await page.reload();
      }
    } finally {
      await page.request.delete(`/api/sessions/${session.id}`);
      await page.request.delete(`/api/projects/${project.id}`);
    }
  });
}
