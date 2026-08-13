import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({
  createSession: vi.fn(),
  spawnSession: vi.fn(),
  spawnAgent: vi.fn(),
  spawnTerminal: vi.fn(),
  getSession: vi.fn(),
  isSessionActive: vi.fn(() => true),
  writeToSession: vi.fn(() => true),
  reconnectSession: vi.fn(),
  recoverSessionOnAttach: vi.fn(),
  resumeSessionById: vi.fn(),
}));

vi.mock('../src/services/session-manager.js', () => manager);

import { authHook, createSession as createAuthSession, createUser, setProjectToolAccess } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { scheduledTaskRoutes } from '../src/routes/scheduled-tasks.js';
import { tickScheduledTasks } from '../src/services/scheduled-task-runner.js';
import { createTestDatabase } from './helpers/database.js';

describe('scheduled task API', () => {
  let app: FastifyInstance;
  let cleanup: () => void;
  let ownerId: string;
  let otherId: string;
  let cookie: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager.isSessionActive.mockReturnValue(true);
    manager.writeToSession.mockReturnValue(true);
    const database = createTestDatabase();
    cleanup = database.cleanup;
    const owner = createUser({ username: 'schedule-owner', password: 'password1' });
    const other = createUser({ username: 'schedule-other', password: 'password2' });
    const admin = createUser({ username: 'schedule-admin', password: 'password3', role: 'admin' });
    ownerId = owner.id;
    otherId = other.id;
    cookie = `agentmanager_session=${createAuthSession(owner.id)}`;
    getDb().prepare('INSERT INTO projects (id, name, path, owner_id) VALUES (?, ?, ?, ?)')
      .run('project-1', 'Project', database.dir, admin.id);
    setProjectToolAccess({
      projectId: 'project-1', userId: owner.id, canSession: true, canAgent: true,
      canTerminal: true, canClaude: true, canCodex: true, grantedBy: admin.id,
    });
    setProjectToolAccess({
      projectId: 'project-1', userId: other.id, canSession: true, canAgent: true,
      canTerminal: true, canClaude: true, canCodex: true, grantedBy: admin.id,
    });
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(scheduledTaskRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('creates, pauses, lists, and deletes a project schedule', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Morning review', prompt: 'Review open changes',
        schedule_kind: 'daily', schedule_value: '09:30', timezone: 'Asia/Taipei',
        target_type: 'new', new_mode: 'session', new_cli_type: 'codex', enabled: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    expect(created.json().task).toMatchObject({
      user_id: ownerId,
      name: 'Morning review',
      enabled: 1,
      new_cli_type: 'codex',
    });
    expect(created.json().task.next_run_at).toEqual(expect.any(String));

    const paused = await app.inject({
      method: 'PATCH', url: `/api/scheduled-tasks/${taskId}`, headers: { cookie }, payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().task).toMatchObject({ enabled: 0, next_run_at: null });

    const listed = await app.inject({
      method: 'GET', url: '/api/scheduled-tasks?project_id=project-1', headers: { cookie },
    });
    expect(listed.json().tasks.map((task: { id: string }) => task.id)).toEqual([taskId]);

    expect((await app.inject({
      method: 'DELETE', url: `/api/scheduled-tasks/${taskId}`, headers: { cookie },
    })).statusCode).toBe(200);
  });

  it('rejects another user\'s tab and sends a manual run only to the owner tab', async () => {
    const insert = getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES (?, 'project-1', 'Terminal', 'running', 'terminal', 'claude', ?)
    `);
    insert.run('owner-tab', ownerId);
    insert.run('other-tab', otherId);

    const denied = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Bad target', prompt: 'hello', schedule_kind: 'interval',
        schedule_value: '60', timezone: 'UTC', target_type: 'existing', target_session_id: 'other-tab',
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toMatch(/不属于当前用户/);

    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Ping tab', prompt: 'run the checks', schedule_kind: 'interval',
        schedule_value: '60', timezone: 'UTC', target_type: 'existing', target_session_id: 'owner-tab',
        inactive_policy: 'resume',
      },
    });
    const taskId = created.json().task.id as string;
    manager.getSession.mockReturnValue({
      id: 'owner-tab', project_id: 'project-1', created_by_user_id: ownerId,
      status: 'running', mode: 'terminal', cli_type: 'claude',
    });

    const run = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${taskId}/run`, headers: { cookie } });
    expect(run.statusCode).toBe(200);
    expect(run.json().run).toMatchObject({ status: 'success', sessionId: 'owner-tab' });
    expect(manager.writeToSession.mock.calls).toEqual([
      ['owner-tab', 'run the checks', true],
      ['owner-tab', '\r'],
    ]);

    const history = await app.inject({
      method: 'GET', url: `/api/scheduled-tasks/${taskId}/runs`, headers: { cookie },
    });
    expect(history.json().runs[0]).toMatchObject({ status: 'success', session_id: 'owner-tab', trigger: 'manual' });
  });

  it('claims a due occurrence once and advances its next run before executing', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('scheduled-tab', 'project-1', 'Work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Due task', prompt: 'continue', schedule_kind: 'interval',
        schedule_value: '10', timezone: 'UTC', target_type: 'existing', target_session_id: 'scheduled-tab',
      },
    });
    const taskId = created.json().task.id as string;
    getDb().prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?')
      .run('2026-08-13T00:00:00.000Z', taskId);
    manager.getSession.mockReturnValue({
      id: 'scheduled-tab', project_id: 'project-1', created_by_user_id: ownerId,
      status: 'running', mode: 'session', cli_type: 'claude',
    });

    await tickScheduledTasks(Date.parse('2026-08-13T00:01:00Z'));
    await vi.waitFor(() => expect(manager.writeToSession).toHaveBeenCalledWith('scheduled-tab', 'continue', true));
    await vi.waitFor(() => expect(
      (getDb().prepare('SELECT last_status FROM scheduled_tasks WHERE id = ?').get(taskId) as any).last_status,
    ).toBe('success'));

    const row = getDb().prepare('SELECT next_run_at, last_status FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
    expect(row.next_run_at).toBe('2026-08-13T00:11:00.000Z');
    expect(row.last_status).toBe('success');
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ?').get(taskId) as any).count).toBe(1);
  });
});
