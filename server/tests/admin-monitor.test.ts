import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { userRoutes } from '../src/routes/users.js';
import { createTestDatabase } from './helpers/database.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('administrator monitoring', () => {
  it('rejects members and groups each users open projects and sessions for admins', async () => {
    ({ cleanup } = createTestDatabase());
    const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
    const member = createUser({ username: 'member', password: 'password2', max_tabs: 4 });
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p1', 'Project One', '/tmp/project-one')").run();
    db.prepare(`
      INSERT INTO user_ui_state (user_id, key, value)
      VALUES (?, 'app', ?)
    `).run(member.id, JSON.stringify({
      projectTabs: [{ projectId: 'p1', projectName: 'Project One', customName: 'Member tab' }],
      activeTab: 'project-p1',
    }));
    db.prepare(`
      INSERT INTO user_ui_state (user_id, key, value)
      VALUES (?, 'project:p1', ?)
    `).run(member.id, JSON.stringify({
      terminalLabels: { s1: 'Latency investigation' },
      terminalInstances: [
        { id: 's1', label: 'Session 1', customLabel: 'Latency investigation' },
        { id: 'legacy-session', label: 'Session 2', customLabel: 'Legacy tab' },
      ],
      activeTerminalId: 's1',
      explorerInstances: [{ id: 'explorer-1', label: 'Server files' }],
      webPageInstances: [{ id: 'web-1', label: 'Preview', url: 'https://example.com' }],
    }));
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('s1', 'p1', 'Inspect project', 'running', 'session', 'codex', ?)
    `).run(member.id);
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('legacy-session', 'p1', 'Legacy running task', 'running', 'session', 'codex', NULL)
    `).run();
    db.prepare("INSERT INTO pty_output (session_id, seq, data) VALUES ('s1', 1, ?)").run('\u001b[32mAnalyzing query plan\u001b[0m\nWaiting for result');
    db.prepare("INSERT INTO pty_output (session_id, seq, data) VALUES ('legacy-session', 1, ?)").run('Do you want to proceed?\n❯ 1. Yes\n  2. No');

    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      req.user = req.headers['x-test-role'] === 'admin' ? admin : member;
    });
    await app.register(userRoutes, { prefix: '/api' });

    const denied = await app.inject({ method: 'GET', url: '/api/admin/monitor' });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/monitor',
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ active_users: 1, active_sessions: 2, total_memory_bytes: 0 });
    expect(body.server_resources).toMatchObject({
      hostname: expect.any(String),
      uptime_seconds: expect.any(Number),
      cpu: {
        usage_percent: expect.any(Number),
        core_count: expect.any(Number),
        load_average_1m: expect.any(Number),
      },
      memory: {
        total_bytes: expect.any(Number),
        used_bytes: expect.any(Number),
        usage_percent: expect.any(Number),
      },
    });
    const monitoredMember = body.users.find((user: any) => user.id === member.id);
    expect(monitoredMember).toMatchObject({
      username: 'member',
      max_tabs: 4,
      open_projects: 1,
      active_sessions: 2,
    });
    expect(monitoredMember.projects).toHaveLength(1);
    expect(monitoredMember.projects[0]).toMatchObject({
      id: 'p1',
      name: 'Project One',
      custom_name: 'Member tab',
      is_open: true,
      is_active: true,
    });
    expect(monitoredMember.projects[0].tabs).toEqual([
      { id: 's1', name: 'Latency investigation', kind: 'session', is_active: true },
      { id: 'legacy-session', name: 'Legacy tab', kind: 'session', is_active: false },
    ]);
    expect(monitoredMember.projects[0].sessions.find((session: any) => session.id === 's1')).toMatchObject({
      id: 's1',
      task: 'Inspect project',
      status: 'running',
      cli_type: 'codex',
      memory_bytes: null,
      process_count: 0,
      last_output: 'Analyzing query plan · Waiting for result',
      process_state: 'idle',
    });
    expect(monitoredMember.projects[0].sessions.find((session: any) => session.id === 's1').last_activity_at).toEqual(expect.any(String));
    expect(monitoredMember.projects[0].sessions.find((session: any) => session.id === 'legacy-session')).toMatchObject({
      created_by_user_id: member.id,
      status: 'running',
      process_state: 'waiting_for_input',
      is_permission: true,
    });

    const deniedRename = await app.inject({
      method: 'PATCH',
      url: `/api/admin/monitor/users/${member.id}/projects/p1/tabs/s1`,
      payload: { name: 'Renamed tab' },
    });
    expect(deniedRename.statusCode).toBe(403);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/admin/monitor/users/${member.id}/projects/p1/tabs/s1`,
      headers: { 'x-test-role': 'admin' },
      payload: { name: 'Renamed tab' },
    });
    expect(renamed.statusCode).toBe(200);
    const renamedState = JSON.parse((db.prepare("SELECT value FROM user_ui_state WHERE user_id = ? AND key = 'project:p1'").get(member.id) as any).value);
    expect(renamedState.terminalInstances.find((tab: any) => tab.id === 's1').customLabel).toBe('Renamed tab');
    expect(renamedState.terminalLabels.s1).toBe('Renamed tab');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/monitor/users/${member.id}/projects/p1/tabs/legacy-session`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, session_continues: true });
    const removedState = JSON.parse((db.prepare("SELECT value FROM user_ui_state WHERE user_id = ? AND key = 'project:p1'").get(member.id) as any).value);
    expect(removedState.terminalInstances.some((tab: any) => tab.id === 'legacy-session')).toBe(false);
    expect(removedState.hiddenSessionIds).toContain('legacy-session');
    expect(db.prepare("SELECT status FROM sessions WHERE id = 'legacy-session'").get()).toEqual({ status: 'running' });

    const selfDelete = await app.inject({
      method: 'DELETE',
      url: `/api/users/${admin.id}`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(selfDelete.statusCode).toBe(400);

    const memberDelete = await app.inject({ method: 'DELETE', url: `/api/users/${admin.id}` });
    expect(memberDelete.statusCode).toBe(403);

    const activeDelete = await app.inject({
      method: 'DELETE',
      url: `/api/users/${member.id}`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(activeDelete.statusCode).toBe(200);
    expect(activeDelete.json()).toMatchObject({ ok: true, closed_sessions: 1 });
    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(member.id)).toBeUndefined();
    expect(db.prepare("SELECT status, created_by_user_id FROM sessions WHERE id = 's1'").get()).toEqual({ status: 'cancelled', created_by_user_id: null });
    expect(db.prepare('SELECT 1 FROM user_ui_state WHERE user_id = ?').get(member.id)).toBeUndefined();

    await app.close();
  });
});
