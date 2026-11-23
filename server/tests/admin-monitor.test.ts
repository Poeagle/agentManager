import {mkdirSync,writeFileSync} from 'fs';
import * as fs from 'fs/promises';
import {join} from 'path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it,vi } from 'vitest';
import { createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { userRoutes } from '../src/routes/users.js';
import { createTestDatabase } from './helpers/database.js';
import { resolveClaudeDir } from '../src/services/agents/claude/archive.js';
import { serverResourceSampler } from '../src/services/server-resources.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});

vi.mock('../src/services/agents/claude/archive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/agents/claude/archive.js')>();
  return { ...actual, resolveClaudeDir: vi.fn(actual.resolveClaudeDir) };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config, useTmux: false, useDtach: false } };
});

let cleanup: (() => void) | undefined;
afterEach(async () => { await serverResourceSampler.stop(); cleanup?.();vi.unstubAllEnvs(); vi.mocked(fs.readFile).mockReset(); vi.mocked(fs.readdir).mockReset(); });

describe('administrator monitoring', () => {
  it.skipIf(process.platform !== 'linux')('counts cgroup processes separately from threads and leaves unsampled totals unknown', async () => {
    const fixture = createTestDatabase();
    cleanup = fixture.cleanup;
    const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
    const db = getDb();
    db.prepare("INSERT INTO sessions (id, task, status, mode, created_by_user_id) VALUES ('sampled', 'Sampled', 'running', 'terminal', ?), ('unsampled', 'Unsampled', 'running', 'terminal', ?)").run(admin.id, admin.id);
    db.prepare("UPDATE sessions SET pid = ? WHERE id = 'unsampled'").run(process.pid);
    const group = join(fixture.dir, 'fake-cgroup');
    const child = join(group, 'child');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(group, 'memory.current'), '139460608\n');
    writeFileSync(join(group, 'pids.current'), '44\n');
    writeFileSync(join(group, 'cgroup.procs'), '101\n');
    writeFileSync(join(child, 'cgroup.procs'), '102\n');
    const actual = await vi.importActual<typeof fs>('fs/promises');
    const inFixture = (path: unknown) => typeof path === 'string'
      ? path.replace(/^.*\/agentmanager-sandbox-sampled\.service(?=\/|$)/, group)
      : path;
    vi.mocked(fs.readFile).mockImplementation((path, options) => actual.readFile(inFixture(path) as typeof path, options));
    vi.mocked(fs.readdir).mockImplementation((path, options) => actual.readdir(inFixture(path) as typeof path, options));
    const app = Fastify();
    app.addHook('onRequest', async (req) => { req.user = admin; });
    await app.register(userRoutes, { prefix: '/api' });
    try {
      const res = await app.inject('/api/admin/monitor');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const sessions = body.users[0].projects[0].sessions;
      expect(sessions.find((session: any) => session.id === 'sampled')).toMatchObject({
        memory_bytes: 139460608, process_count: 2, memory_source: 'cgroup',
      });
      expect(sessions.find((session: any) => session.id === 'unsampled')).toMatchObject({
        memory_bytes: null, process_count: null, last_activity_at: null,
      });
      expect(body).toMatchObject({ total_memory_bytes: 139460608, memory_sampled_sessions: 1, active_sessions: 2 });
    } finally {
      await app.close();
    }
  });

  it.each(['codex', 'claude'] as const)('reports native %s idle state and activity independently of the terminal', async (agent) => {
    const fixture = createTestDatabase();
    cleanup = fixture.cleanup;
    vi.stubEnv('CODEX_HOME', fixture.dir);
    vi.mocked(resolveClaudeDir).mockReturnValue(fixture.dir);
    const nativeId = '019ffabc-3434-7212-8212-123456789012';
    const when = '2026-11-23T01:02:05.000Z';
    const message = '原生助手消息';
    mkdirSync(join(fixture.dir, 'sessions'));
    const transcript = agent === 'codex' ? [
      {type: 'event_msg', timestamp: '2026-11-23T01:02:04.000Z', payload: {type: 'agent_message', phase: 'final_answer', message}},
      {type: 'event_msg', timestamp: when, payload: {type: 'task_complete'}},
    ] : [
      {type: 'assistant', timestamp: when, message: {model: 'claude-sonnet-4', role: 'assistant', stop_reason: 'end_turn', content: [{type: 'text', text: message}]}},
    ];
    const filename = agent === 'codex' ? join('sessions', `rollout-${nativeId}.jsonl`) : `${nativeId}.jsonl`;
    writeFileSync(join(fixture.dir, filename), transcript.map((event) => JSON.stringify(event)).join('\n') + '\n');
    const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
    const db = getDb();
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p1', 'Project One', ?)").run(fixture.dir);
    db.prepare(`INSERT INTO sessions (id, project_id, task, status, mode, agent_id, cli_type, native_session_id, created_by_user_id)
      VALUES ('active', 'p1', 'Run', 'running', 'session', ?, ?, ?, ?)`).run(agent, agent, nativeId, admin.id);

    const app = Fastify();
    app.addHook('onRequest', async (req) => { req.user = admin; });
    await app.register(userRoutes, { prefix: '/api' });
    try {
      const result = await app.inject('/api/admin/monitor');
      expect(result.statusCode).toBe(200);
      expect(result.json().users[0].projects[0].sessions[0]).toMatchObject({
        status: 'running',
        agent_state: 'idle',
        process_state: null,
        last_activity_at: when,
        last_output: message,
      });
    } finally {
      vi.mocked(resolveClaudeDir).mockReset();
      await app.close();
    }
  });

  it('rejects members and groups each users open projects and sessions for admins', async () => {
    const fixture=createTestDatabase();cleanup=fixture.cleanup;vi.stubEnv('CODEX_HOME',fixture.dir);mkdirSync(join(fixture.dir,'sessions'));
    const native='019ffabc-1212-7212-8212-123456789012';writeFileSync(join(fixture.dir,'sessions',`rollout-${native}.jsonl`),JSON.stringify({type:'event_msg',timestamp:'2026-10-31T02:00:00Z',payload:{type:'agent_message',phase:'commentary',message:'正在分析查询计划，等待结果'}})+'\n');
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
    }));
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('s1', 'p1', 'Inspect project', 'running', 'session', 'codex', ?)
    `).run(member.id);
    db.prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('legacy-session', 'p1', 'Legacy running task', 'running', 'session', 'codex', NULL)
    `).run();
    db.prepare("UPDATE sessions SET codex_session_id=? WHERE id='s1'").run(native);
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
    expect(body).toMatchObject({ active_users: 1, active_sessions: 2, total_memory_bytes: null, memory_sampled_sessions: 0 });
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
      process_count: null,
      last_output: '正在分析查询计划，等待结果',
      process_state: null,
    });
    expect(monitoredMember.projects[0].sessions.find((session: any) => session.id === 's1').last_activity_at).toEqual(expect.any(String));
    expect(monitoredMember.projects[0].sessions.find((session: any) => session.id === 'legacy-session')).toMatchObject({
      created_by_user_id: member.id,
      status: 'running',
      process_state: null,
      is_permission: false,
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
    expect(removed.json()).toMatchObject({ ok: true, session_continues: false });
    const removedState = JSON.parse((db.prepare("SELECT value FROM user_ui_state WHERE user_id = ? AND key = 'project:p1'").get(member.id) as any).value);
    expect(removedState.terminalInstances.some((tab: any) => tab.id === 'legacy-session')).toBe(false);
    expect(removedState.hiddenSessionIds).toContain('legacy-session');
    expect(db.prepare("SELECT status FROM sessions WHERE id = 'legacy-session'").get()).toEqual({ status: 'cancelled' });

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
