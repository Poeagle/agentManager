import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({
  createSession: vi.fn(),
  spawnSession: vi.fn(),
  spawnTerminal: vi.fn(),
  getSession: vi.fn(),
  isSessionActive: vi.fn(() => true),
  writeToSession: vi.fn(() => true),
  reconnectSession: vi.fn(),
  recoverSessionOnAttach: vi.fn(),
  resumeSessionById: vi.fn(),
}));
const quota = vi.hoisted(() => ({
  readCodexWeeklyQuota: vi.fn(),
}));
const tracker = vi.hoisted(() => ({ getTracker: vi.fn() }));

vi.mock('../src/services/session-manager.js', () => manager);
vi.mock('../src/services/codex-quota.js', () => quota);
vi.mock('../src/services/session-state.js', () => tracker);

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
    tracker.getTracker.mockReturnValue({ state: { processState: 'idle', promptType: null, isPermission: false }, hasPendingExecute: false });
    quota.readCodexWeeklyQuota.mockResolvedValue({
      usedPercent: 35, remainingPercent: 65, windowDurationMins: 10_080,
      resetsAt: 1_787_196_804, planType: 'pro', checkedAt: '2026-08-13T08:00:00.000Z',
    });
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
      projectId: 'project-1', userId: owner.id, canSession: true,
      canTerminal: true, sessionClients: ['claude', 'codex'], grantedBy: admin.id,
    });
    setProjectToolAccess({
      projectId: 'project-1', userId: other.id, canSession: true,
      canTerminal: true, sessionClients: ['claude', 'codex'], grantedBy: admin.id,
    });
    app = Fastify({ logger: false });
    app.addHook('onRequest', authHook);
    await app.register(scheduledTaskRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    cleanup();
    vi.restoreAllMocks();
  });

  it('round trips mixed groups and rejects invalid nested conditions', async () => {
    const payload = {
      project_id: 'project-1', name: 'Grouped', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30',
      timezone: 'Asia/Shanghai', target_type: 'new', new_mode: 'session', new_cli_type: 'claude', enabled: false,
      start_conditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' },
        { operator: 'or', conditions: [{ type: 'weekday', value: 'workday' }, { type: 'time_range', value: { start: '10:00', end: '12:00' } }] },
      ] },
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
    };
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload });
    expect(created.statusCode).toBe(200);
    expect(created.json().task).toMatchObject({ start_conditions: payload.start_conditions, condition_unmet_policy: 'skip' });
    const listed = await app.inject({ method: 'GET', url: '/api/scheduled-tasks?project_id=project-1', headers: { cookie } });
    expect(listed.json().tasks[0].daily_stop_conditions).toEqual(payload.daily_stop_conditions);
    for (const daily_stop_conditions of [
      { operator: 'and', conditions: [{ operator: 'or', conditions: [] }] },
      { operator: 'and', conditions: [{ operator: 'or', conditions: [{ type: 'quota_below', value: 20 }] }] },
    ]) expect((await app.inject({ method: 'PATCH', url: `/api/scheduled-tasks/${created.json().task.id}`, headers: { cookie }, payload: { daily_stop_conditions } })).statusCode).toBe(400);
  });

  it('skips a busy target once, keeps the fixed interval, and never backfills on idle', async () => {
    const now = Date.parse('2026-10-13T10:00:05Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES ('busy-tab','project-1','Work','running','session','claude',?)`).run(ownerId);
    manager.getSession.mockReturnValue({ id: 'busy-tab', project_id: 'project-1', created_by_user_id: ownerId, status: 'running', mode: 'session', cli_type: 'claude' });
    tracker.getTracker.mockReturnValue({ state: { processState: 'busy' }, hasPendingExecute: false });
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Busy target', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30', timezone: 'UTC',
      target_type: 'existing', target_session_id: 'busy-tab', start_conditions: { operator: 'and', conditions: [{ type: 'target_idle', value: true }] },
    } });
    expect(created.statusCode).toBe(200);
    const id = created.json().task.id;
    getDb().prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run('2026-10-13T10:00:00.000Z', id);
    await tickScheduledTasks(now);
    expect(manager.writeToSession).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT next_run_at, enabled, consecutive_failures, last_status FROM scheduled_tasks WHERE id = ?').get(id))
      .toEqual({ next_run_at: '2026-10-13T10:30:00.000Z', enabled: 1, consecutive_failures: 0, last_status: 'skipped' });
    expect(getDb().prepare('SELECT status,scheduled_for FROM scheduled_task_runs WHERE task_id = ?').all(id)).toEqual([{ status: 'skipped', scheduled_for: '2026-10-13T10:00:00.000Z' }]);
    tracker.getTracker.mockReturnValue({ state: { processState: 'idle' }, hasPendingExecute: false });
    await tickScheduledTasks(now + 15_000);
    expect(manager.writeToSession).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-13T10:30:00Z'));
    await tickScheduledTasks(Date.now());
    await vi.waitFor(() => expect(manager.writeToSession).toHaveBeenCalledWith('busy-tab', 'inspect', true));
    await vi.waitFor(() => expect(getDb().prepare('SELECT last_status FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ last_status: 'success' }));
  });

  it('pauses only the current day and resumes the next day without re-enabling', async () => {
    const now = Date.parse('2026-10-13T10:00:00Z'); // 18:00 Shanghai
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Daily pause', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30', timezone: 'Asia/Shanghai',
      target_type: 'new', new_mode: 'session', new_cli_type: 'claude',
      start_conditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' }] },
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
    } });
    const id = created.json().task.id;
    await tickScheduledTasks(now);
    expect(getDb().prepare('SELECT enabled, daily_paused_until FROM scheduled_tasks WHERE id = ?').get(id))
      .toEqual({ enabled: 1, daily_paused_until: '2026-10-13T16:00:00.000Z' });
    expect(manager.createSession).not.toHaveBeenCalled();
    const morning = Date.parse('2026-10-14T01:00:00Z');
    vi.mocked(Date.now).mockReturnValue(morning);
    getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES ('daily-new','project-1','Work','running','session','claude',?)`).run(ownerId);
    manager.createSession.mockReturnValue({ id: 'daily-new' });
    await tickScheduledTasks(morning);
    await vi.waitFor(() => expect(manager.spawnSession).toHaveBeenCalled());
    await vi.waitFor(() => expect(getDb().prepare('SELECT last_status,enabled,daily_paused_until FROM scheduled_tasks WHERE id = ?').get(id))
      .toEqual({ last_status: 'success', enabled: 1, daily_paused_until: null }));
  });

  it('does not send on manual run when target state is unknown or quota is stale', async () => {
    getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES ('unknown-tab','project-1','Work','running','session','codex',?)`).run(ownerId);
    manager.getSession.mockReturnValue({ id: 'unknown-tab', project_id: 'project-1', created_by_user_id: ownerId, status: 'running', mode: 'session', cli_type: 'codex' });
    tracker.getTracker.mockReturnValue(undefined);
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Unknown target', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30', timezone: 'UTC',
      target_type: 'existing', target_session_id: 'unknown-tab', start_conditions: { operator: 'and', conditions: [{ type: 'target_idle', value: true }] },
      daily_stop_conditions: { operator: 'and', conditions: [{ operator: 'or', conditions: [{ type: 'quota_below', value: 20 }] }] },
    } });
    const id = created.json().task.id;
    let result = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${id}/run`, headers: { cookie } });
    expect(result.json().run.status).toBe('skipped');
    tracker.getTracker.mockReturnValue({ state: { processState: 'idle' }, hasPendingExecute: false });
    quota.readCodexWeeklyQuota.mockResolvedValue({ remainingPercent: 65, stale: true });
    result = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${id}/run`, headers: { cookie } });
    expect(result.json().run.status).toBe('skipped');
    expect(manager.writeToSession).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT enabled, consecutive_failures FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ enabled: 1, consecutive_failures: 0 });
  });

  it('counts daily successes by the task timezone and resets the guard the next day', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T15:30:00Z'));
    getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES ('count-tab','project-1','Work','running','session','claude',?)`).run(ownerId);
    manager.getSession.mockReturnValue({ id: 'count-tab', project_id: 'project-1', created_by_user_id: ownerId, status: 'running', mode: 'session', cli_type: 'claude' });
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Daily sends', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30', timezone: 'Asia/Shanghai',
      target_type: 'existing', target_session_id: 'count-tab',
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'successes_today', value: 2 }] },
    } });
    const id = created.json().task.id;
    const insert = getDb().prepare(`INSERT INTO scheduled_task_runs (id,task_id,trigger,scheduled_for,status,started_at) VALUES (?,?,'scheduled',?,'success',?)`);
    for (const [runId, at] of [['yesterday', '2026-10-12T15:59:00Z'], ['today-1', '2026-10-12T16:00:00Z'], ['today-2', '2026-10-13T10:00:00Z']]) insert.run(runId, id, at, at);
    await tickScheduledTasks(Date.now());
    expect(getDb().prepare('SELECT daily_paused_until,enabled FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ daily_paused_until: '2026-10-13T16:00:00.000Z', enabled: 1 });
    expect(manager.writeToSession).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-14T01:00:00Z'));
    const result = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${id}/run`, headers: { cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().run.status).toBe('success');
    expect(getDb().prepare('SELECT daily_paused_until FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ daily_paused_until: null });
  });

  it('rechecks a daily cutoff crossed while reading fresh quota before dispatch', async () => {
    let now = Date.parse('2026-10-13T09:59:59Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Cutoff race', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30', timezone: 'Asia/Shanghai',
      target_type: 'new', new_mode: 'session', new_cli_type: 'codex',
      daily_stop_conditions: { operator: 'or', conditions: [{ type: 'quota_below', value: 20 }, { type: 'time_after', value: '18:00' }] },
    } });
    expect(created.statusCode).toBe(200);
    quota.readCodexWeeklyQuota.mockImplementation(async () => { now += 2_000; return { remainingPercent: 65 }; });
    const result = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${created.json().task.id}/run`, headers: { cookie } });
    expect(result.json().run.status).toBe('skipped');
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT enabled,consecutive_failures,daily_paused_until FROM scheduled_tasks WHERE id = ?').get(created.json().task.id))
      .toEqual({ enabled: 1, consecutive_failures: 0, daily_paused_until: '2026-10-13T16:00:00.000Z' });
  });

  it('persists daily windows, validates them and recalculates the next run when edited', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Windowed', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30',
      timezone: 'UTC', target_type: 'new', new_mode: 'session', new_cli_type: 'claude',
      daily_start_time: '09:00', daily_end_time: '18:00',
    } });
    expect(created.statusCode).toBe(200);
    const task = created.json().task;
    expect(task).toMatchObject({ daily_start_time: '09:00', daily_end_time: '18:00', daily_stop_at: null });
    const next = new Date(task.next_run_at);
    expect(next.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(next.getUTCHours()).toBeLessThan(18);
    expect(next.getUTCMinutes() % 30).toBe(0);

    const changed = await app.inject({ method: 'PATCH', url: `/api/scheduled-tasks/${task.id}`, headers: { cookie }, payload: {
      daily_start_time: '20:00', daily_end_time: '22:00',
    } });
    expect(changed.statusCode).toBe(200);
    expect(new Date(changed.json().task.next_run_at).getUTCHours()).toBeGreaterThanOrEqual(20);
    expect(new Date(changed.json().task.next_run_at).getUTCHours()).toBeLessThan(22);

    for (const payload of [{ daily_end_time: null }, { daily_end_time: '20:00' }, { schedule_kind: 'daily', schedule_value: '09:00' }]) {
      expect((await app.inject({ method: 'PATCH', url: `/api/scheduled-tasks/${task.id}`, headers: { cookie }, payload })).statusCode).toBe(400);
    }
  });

  it('skips a missed run outside the window and resumes next day without disabling or counting failures', async () => {
    getDb().prepare(`INSERT INTO sessions (id,project_id,task,status,mode,created_by_user_id) VALUES ('window-tab','project-1','Work','running','session',?)`).run(ownerId);
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Windowed', prompt: 'inspect', schedule_kind: 'interval', schedule_value: '30',
      timezone: 'UTC', target_type: 'existing', target_session_id: 'window-tab',
      daily_start_time: '09:00', daily_end_time: '18:00', max_consecutive_failures: 1,
    } });
    const id = created.json().task.id;
    const day = new Date().toISOString().slice(0, 10);
    const afterEnd = Date.parse(`${day}T18:01:00Z`);
    const tomorrow = new Date(afterEnd + 24 * 60 * 60_000).toISOString().slice(0, 10);
    const nextMorning = `${tomorrow}T09:00:00.000Z`;
    getDb().prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(`${day}T17:30:00.000Z`, id);
    vi.spyOn(Date, 'now').mockReturnValue(afterEnd);
    await tickScheduledTasks(afterEnd);
    expect(manager.writeToSession).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT enabled,next_run_at,consecutive_failures FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ enabled: 1, next_run_at: nextMorning, consecutive_failures: 0 });

    manager.getSession.mockReturnValue({ id: 'window-tab', project_id: 'project-1', created_by_user_id: ownerId, status: 'running', mode: 'session', cli_type: 'claude' });
    vi.mocked(Date.now).mockReturnValue(Date.parse(nextMorning) + 15000);
    await tickScheduledTasks(Date.now());
    await vi.waitFor(() => expect(manager.writeToSession).toHaveBeenCalledWith('window-tab', 'inspect', true));
    await vi.waitFor(() => expect(getDb().prepare('SELECT last_status FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ last_status: 'success' }));
    expect(getDb().prepare('SELECT enabled,next_run_at FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ enabled: 1, next_run_at: `${tomorrow}T09:30:00.000Z` });
  });

  it('does not dispatch or count a failure when quota preflight crosses the daily end', async () => {
    const day = new Date().toISOString().slice(0, 10);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(`${day}T17:59:55Z`));
    const created = await app.inject({ method: 'POST', url: '/api/scheduled-tasks', headers: { cookie }, payload: {
      project_id: 'project-1', name: 'Window guard', prompt: 'work', schedule_kind: 'interval', schedule_value: '30',
      timezone: 'UTC', target_type: 'new', new_mode: 'session', new_cli_type: 'codex',
      daily_start_time: '09:00', daily_end_time: '18:00', quota_remaining_below: 20, max_consecutive_failures: 1,
    } });
    expect(created.statusCode).toBe(200);
    quota.readCodexWeeklyQuota.mockImplementationOnce(async () => {
      vi.mocked(Date.now).mockReturnValue(Date.parse(`${day}T18:00:00Z`));
      return { remainingPercent: 65 };
    });
    const id = created.json().task.id;
    const result = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${id}/run`, headers: { cookie } });
    expect(result.statusCode).toBe(409);
    expect(result.json().run.status).toBe('skipped');
    expect(manager.createSession).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT enabled,consecutive_failures FROM scheduled_tasks WHERE id = ?').get(id)).toEqual({ enabled: 1, consecutive_failures: 0 });
  });

  it('creates, pauses, lists, and deletes a project schedule', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Morning review', prompt: 'Review open changes',
        schedule_kind: 'daily', schedule_value: '09:30', timezone: 'Asia/Taipei',
        target_type: 'new', new_mode: 'session', new_cli_type: 'codex', enabled: true,
        max_successful_runs: 10, quota_remaining_below: 20,
        max_consecutive_failures: 3, stop_at: '2099-08-20T03:00:00.000Z', daily_stop_time: '18:30',
      },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    expect(created.json().task).toMatchObject({
      user_id: ownerId,
      name: 'Morning review',
      enabled: 1,
      new_cli_type: 'codex',
      max_successful_runs: 10,
      quota_remaining_below: 20,
      max_consecutive_failures: 3,
      daily_stop_time: '18:30',
    });
    expect(created.json().task.next_run_at).toEqual(expect.any(String));
    expect(created.json().task.daily_stop_at).toEqual(expect.any(String));

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

  it('returns the live Codex weekly quota and rejects quota guards for Claude targets', async () => {
    const globalResponse = await app.inject({
      method: 'GET', url: '/api/codex-quota', headers: { cookie },
    });
    expect(globalResponse.statusCode).toBe(200);
    expect(globalResponse.json().quota).toMatchObject({ remainingPercent: 65, windowDurationMins: 10_080 });

    const response = await app.inject({
      method: 'GET', url: '/api/scheduled-tasks/codex-quota?project_id=project-1', headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().quota).toMatchObject({ remainingPercent: 65, windowDurationMins: 10_080 });

    const rejected = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Claude guarded', prompt: 'work', schedule_kind: 'daily',
        schedule_value: '09:00', timezone: 'UTC', target_type: 'new', new_mode: 'session',
        new_cli_type: 'claude', quota_remaining_below: 20,
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/仅适用于 Codex/);
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
    expect(row.next_run_at).toBe('2026-08-13T00:10:00.000Z');
    expect(row.last_status).toBe('success');
    expect((getDb().prepare('SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ?').get(taskId) as any).count).toBe(1);
  });

  it('stops before sending when weekly Codex quota is below the configured floor', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('codex-tab', 'project-1', 'Work', 'running', 'session', 'codex', ?)
    `).run(ownerId);
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Quota guarded', prompt: 'continue', schedule_kind: 'interval',
        schedule_value: '10', timezone: 'UTC', target_type: 'existing', target_session_id: 'codex-tab',
        quota_remaining_below: 70,
      },
    });
    const taskId = created.json().task.id as string;

    const run = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${taskId}/run`, headers: { cookie } });
    expect(run.statusCode).toBe(409);
    expect(run.json().run).toMatchObject({ status: 'stopped' });
    expect(manager.writeToSession).not.toHaveBeenCalled();
    const row = getDb().prepare(`
      SELECT enabled, next_run_at, last_quota_remaining, stop_reason FROM scheduled_tasks WHERE id = ?
    `).get(taskId) as any;
    expect(row).toMatchObject({ enabled: 0, next_run_at: null, last_quota_remaining: 65 });
    expect(row.stop_reason).toMatch(/低于 70%/);
  });

  it('stops after the configured successful-run and failure thresholds', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('limit-tab', 'project-1', 'Work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    manager.getSession.mockReturnValue({
      id: 'limit-tab', project_id: 'project-1', created_by_user_id: ownerId,
      status: 'running', mode: 'session', cli_type: 'claude',
    });
    const successTask = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'One shot', prompt: 'continue', schedule_kind: 'daily',
        schedule_value: '09:00', timezone: 'UTC', target_type: 'existing', target_session_id: 'limit-tab',
        max_successful_runs: 1,
      },
    });
    const successId = successTask.json().task.id as string;
    expect((await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${successId}/run`, headers: { cookie } })).statusCode).toBe(200);
    expect(getDb().prepare('SELECT enabled, successful_runs, stop_reason FROM scheduled_tasks WHERE id = ?').get(successId))
      .toMatchObject({ enabled: 0, successful_runs: 1, stop_reason: '已完成 1 次成功执行' });

    manager.writeToSession.mockReturnValue(false);
    const failureTask = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Fail once', prompt: 'continue', schedule_kind: 'daily',
        schedule_value: '09:00', timezone: 'UTC', target_type: 'existing', target_session_id: 'limit-tab',
        max_consecutive_failures: 1,
      },
    });
    const failureId = failureTask.json().task.id as string;
    expect((await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${failureId}/run`, headers: { cookie } })).statusCode).toBe(409);
    const failed = getDb().prepare('SELECT enabled, consecutive_failures, stop_reason FROM scheduled_tasks WHERE id = ?').get(failureId) as any;
    expect(failed).toMatchObject({ enabled: 0, consecutive_failures: 1 });
    expect(failed.stop_reason).toMatch(/连续失败 1 次/);
  });

  it('expires an enabled task at its absolute stop time without sending', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Deadline', prompt: 'continue', schedule_kind: 'daily',
        schedule_value: '09:00', timezone: 'UTC', target_type: 'new', new_mode: 'session',
        new_cli_type: 'claude', stop_at: '2099-01-01T00:00:00.000Z',
      },
    });
    const taskId = created.json().task.id as string;
    getDb().prepare('UPDATE scheduled_tasks SET stop_at = ? WHERE id = ?')
      .run('2026-08-13T00:00:00.000Z', taskId);

    await tickScheduledTasks(Date.parse('2026-08-13T00:01:00.000Z'));
    const row = getDb().prepare('SELECT enabled, next_run_at, stopped_at, stop_reason FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
    expect(row).toMatchObject({ enabled: 0, next_run_at: null, stopped_at: '2026-08-13T00:01:00.000Z' });
    expect(row.stop_reason).toMatch(/截止时间/);
    expect(manager.createSession).not.toHaveBeenCalled();
  });

  it('stops an enabled task at its next daily stop time without sending', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Daily cutoff', prompt: 'continue', schedule_kind: 'interval',
        schedule_value: '10', timezone: 'Asia/Taipei', target_type: 'new', new_mode: 'session',
        new_cli_type: 'claude', daily_stop_time: '18:30',
      },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    expect(created.json().task.daily_stop_at).toEqual(expect.any(String));
    getDb().prepare('UPDATE scheduled_tasks SET daily_stop_at = ? WHERE id = ?')
      .run('2026-08-13T00:00:00.000Z', taskId);

    await tickScheduledTasks(Date.parse('2026-08-13T00:01:00.000Z'));
    const row = getDb().prepare('SELECT enabled, next_run_at, stopped_at, stop_reason FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
    expect(row).toMatchObject({ enabled: 0, next_run_at: null, stopped_at: '2026-08-13T00:01:00.000Z' });
    expect(row.stop_reason).toMatch(/每日停止时间（18:30，Asia\/Taipei）/);
    expect(manager.createSession).not.toHaveBeenCalled();
  });

  it('stops permanently when an existing target is unavailable and the guard is enabled', async () => {
    getDb().prepare(`
      INSERT INTO sessions (id, project_id, task, status, mode, cli_type, created_by_user_id)
      VALUES ('missing-tab', 'project-1', 'Work', 'running', 'session', 'claude', ?)
    `).run(ownerId);
    const created = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: { cookie },
      payload: {
        project_id: 'project-1', name: 'Target guarded', prompt: 'continue', schedule_kind: 'daily',
        schedule_value: '09:00', timezone: 'UTC', target_type: 'existing', target_session_id: 'missing-tab',
        stop_on_target_unavailable: true,
      },
    });
    const taskId = created.json().task.id as string;
    manager.getSession.mockReturnValue(null);

    const run = await app.inject({ method: 'POST', url: `/api/scheduled-tasks/${taskId}/run`, headers: { cookie } });
    expect(run.statusCode).toBe(409);
    const stopped = getDb().prepare('SELECT enabled, stop_reason FROM scheduled_tasks WHERE id = ?').get(taskId) as any;
    expect(stopped.enabled).toBe(0);
    expect(stopped.stop_reason).toMatch(/目标标签页不可用/);
  });
});
