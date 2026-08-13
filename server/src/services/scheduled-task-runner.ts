import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { getUserTabUsage, userCanUseToolForProject } from '../auth.js';
import * as sessionManager from './session-manager.js';
import { nextScheduledAt, type ScheduleKind } from './schedule.js';
import { readCodexWeeklyQuota } from './codex-quota.js';

export type ScheduledTargetType = 'existing' | 'new';
export type ScheduledNewMode = 'session' | 'agent' | 'terminal';
export type ScheduledInactivePolicy = 'resume' | 'fail';

export interface ScheduledTaskRow {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule_value: string;
  timezone: string;
  target_type: ScheduledTargetType;
  target_session_id: string | null;
  new_mode: ScheduledNewMode | null;
  new_cli_type: 'claude' | 'codex' | null;
  new_agent_type: string | null;
  inactive_policy: ScheduledInactivePolicy;
  enabled: number;
  next_run_at: string | null;
  stop_at: string | null;
  daily_stop_time: string | null;
  daily_stop_at: string | null;
  max_successful_runs: number | null;
  quota_remaining_below: number | null;
  max_consecutive_failures: number | null;
  stop_on_target_unavailable: number;
  successful_runs: number;
  consecutive_failures: number;
  last_quota_remaining: number | null;
  stopped_at: string | null;
  stop_reason: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledRunResult {
  runId: string;
  status: 'success' | 'failed' | 'stopped';
  sessionId: string | null;
  error?: string;
}

const inFlight = new Set<string>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

class TargetUnavailableError extends Error {}

function stopTask(taskId: string, reason: string, now = new Date().toISOString()): void {
  getDb().prepare(`
    UPDATE scheduled_tasks
    SET enabled = 0, next_run_at = NULL, stopped_at = ?, stop_reason = ?,
      last_status = 'stopped', last_error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(now, reason, taskId);
}

function isCodexTarget(task: ScheduledTaskRow): boolean {
  if (task.target_type === 'new') {
    return task.new_mode !== 'terminal' && task.new_cli_type === 'codex';
  }
  if (!task.target_session_id) return false;
  const session = getDb().prepare('SELECT mode, cli_type FROM sessions WHERE id = ?')
    .get(task.target_session_id) as { mode: string | null; cli_type: string | null } | undefined;
  return !!session && session.mode !== 'terminal' && session.cli_type === 'codex';
}

async function stopReasonBeforeRun(task: ScheduledTaskRow, now = Date.now()): Promise<string | null> {
  if (task.stop_at && Date.parse(task.stop_at) <= now) {
    return `已到截止时间（${task.stop_at}）`;
  }
  if (task.daily_stop_at && Date.parse(task.daily_stop_at) <= now) {
    return `已到每日停止时间（${task.daily_stop_time}，${task.timezone}）`;
  }
  if (task.max_successful_runs != null && task.successful_runs >= task.max_successful_runs) {
    return `已完成 ${task.successful_runs} 次成功执行`;
  }
  if (task.max_consecutive_failures != null && task.consecutive_failures >= task.max_consecutive_failures) {
    return `已连续失败 ${task.consecutive_failures} 次`;
  }
  if (task.quota_remaining_below != null) {
    if (!isCodexTarget(task)) throw new Error('额度停止条件仅适用于 Codex Session 或 Agent');
    const quota = await readCodexWeeklyQuota();
    getDb().prepare(`
      UPDATE scheduled_tasks SET last_quota_remaining = ?, updated_at = datetime('now') WHERE id = ?
    `).run(quota.remainingPercent, task.id);
    if (quota.remainingPercent < task.quota_remaining_below) {
      return `Codex 周额度剩余 ${quota.remainingPercent}%，低于 ${task.quota_remaining_below}%`;
    }
  }
  // A live quota read can take a moment; honor a cutoff crossed during that
  // preflight rather than sending just after the configured stop time.
  if (task.stop_at && Date.parse(task.stop_at) <= Date.now()) {
    return `已到截止时间（${task.stop_at}）`;
  }
  if (task.daily_stop_at && Date.parse(task.daily_stop_at) <= Date.now()) {
    return `已到每日停止时间（${task.daily_stop_time}，${task.timezone}）`;
  }
  return null;
}

function failSessionSpawn(sessionId: string): void {
  try {
    getDb().prepare(`
      UPDATE sessions SET status = 'failed', exit_code = -1,
        completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'launching', 'running')
    `).run(sessionId);
  } catch { /* preserve the original scheduling error */ }
}

async function createScheduledSession(task: ScheduledTaskRow, projectPath: string): Promise<string> {
  const mode = task.new_mode ?? 'session';
  const cliType = task.new_cli_type === 'codex' ? 'codex' : 'claude';
  if (!userCanUseToolForProject(task.user_id, task.project_id, mode, mode === 'terminal' ? 'claude' : cliType)) {
    throw new Error('用户已无权在该项目创建此类标签页');
  }
  const usage = getUserTabUsage(task.user_id);
  if (!usage.allowed) throw new Error(`已达到活动标签页上限（${usage.limit}）`);

  const agentType = mode === 'agent' ? (task.new_agent_type || 'coder') : undefined;
  const label = mode === 'terminal'
    ? 'Terminal'
    : mode === 'agent'
      ? `Agent (${agentType}): ${task.prompt}`
      : task.prompt;
  const session = sessionManager.createSession(
    projectPath,
    label,
    task.project_id,
    cliType,
    task.user_id,
    mode,
    agentType,
  );

  try {
    if (mode === 'terminal') {
      await sessionManager.spawnTerminal(session.id, projectPath, 120, 40);
      if (!sessionManager.writeToSession(session.id, task.prompt, true)
        || !sessionManager.writeToSession(session.id, '\r')) {
        throw new Error('新终端已创建，但提示词发送失败');
      }
    } else if (mode === 'agent') {
      await sessionManager.spawnAgent(session.id, projectPath, task.prompt, agentType!, 120, 40, cliType);
    } else {
      await sessionManager.spawnSession(session.id, projectPath, task.prompt, 120, 40, cliType);
    }
    return session.id;
  } catch (error) {
    failSessionSpawn(session.id);
    throw error;
  }
}

async function restoreExistingSession(task: ScheduledTaskRow, session: sessionManager.Session): Promise<void> {
  if (sessionManager.isSessionActive(session.id)) return;
  if (task.inactive_policy === 'fail') throw new Error('目标标签页当前不在运行');

  let restored = false;
  if (session.status === 'released') {
    restored = await sessionManager.reconnectSession(session.id);
  } else if (['completed', 'failed', 'cancelled'].includes(session.status)) {
    const usage = getUserTabUsage(task.user_id);
    if (!usage.allowed) throw new Error(`已达到活动标签页上限（${usage.limit}）`);
    const result = await sessionManager.resumeSessionById(session.id);
    restored = result.ok;
    if (!result.ok) throw new Error(result.error || '目标标签页无法恢复');
  } else {
    restored = await sessionManager.recoverSessionOnAttach(session.id);
  }
  if (!restored || !sessionManager.isSessionActive(session.id)) throw new Error('目标标签页恢复失败');
}

async function sendToExistingSession(task: ScheduledTaskRow): Promise<string> {
  if (!task.target_session_id) throw new TargetUnavailableError('未设置目标标签页');
  const session = sessionManager.getSession(task.target_session_id);
  if (!session
    || session.created_by_user_id !== task.user_id
    || session.project_id !== task.project_id) {
    throw new TargetUnavailableError('目标标签页不存在或不属于任务创建者');
  }
  const mode = session.mode === 'agent' ? 'agent' : session.mode === 'terminal' ? 'terminal' : 'session';
  const cliType = session.cli_type === 'codex' ? 'codex' : 'claude';
  if (!userCanUseToolForProject(task.user_id, task.project_id, mode, mode === 'terminal' ? 'claude' : cliType)) {
    throw new Error('用户已无权操作该目标标签页');
  }
  try {
    await restoreExistingSession(task, session);
  } catch (error) {
    throw new TargetUnavailableError(error instanceof Error ? error.message : '目标标签页无法恢复');
  }
  if (!sessionManager.writeToSession(session.id, task.prompt, true)
    || !sessionManager.writeToSession(session.id, '\r')) {
    throw new TargetUnavailableError('目标标签页提示词发送失败');
  }
  return session.id;
}

async function executeTask(task: ScheduledTaskRow): Promise<string> {
  const project = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(task.project_id) as { path: string } | undefined;
  if (!project?.path) throw new Error('项目不存在');
  const user = getDb().prepare('SELECT disabled FROM users WHERE id = ?').get(task.user_id) as { disabled: number } | undefined;
  if (!user || user.disabled) throw new Error('任务创建者不存在或已停用');
  return task.target_type === 'existing'
    ? sendToExistingSession(task)
    : createScheduledSession(task, project.path);
}

export async function runScheduledTask(
  taskId: string,
  trigger: 'scheduled' | 'manual' = 'manual',
  scheduledFor = new Date().toISOString(),
): Promise<ScheduledRunResult> {
  if (inFlight.has(taskId)) {
    return { runId: '', status: 'failed', sessionId: null, error: '该任务已有一次执行正在进行' };
  }
  const task = getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId) as ScheduledTaskRow | undefined;
  if (!task) return { runId: '', status: 'failed', sessionId: null, error: '定时任务不存在' };
  if (trigger === 'scheduled' && !task.enabled) {
    return { runId: '', status: 'failed', sessionId: null, error: '定时任务已暂停' };
  }

  inFlight.add(taskId);
  const runId = nanoid(12);
  getDb().prepare(`
    INSERT INTO scheduled_task_runs (id, task_id, trigger, scheduled_for, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(runId, taskId, trigger, scheduledFor);

  try {
    const reason = await stopReasonBeforeRun(task);
    if (reason) {
      getDb().transaction(() => {
        getDb().prepare(`
          UPDATE scheduled_task_runs
          SET status = 'stopped', error = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(reason, runId);
        stopTask(taskId, reason);
      })();
      return { runId, status: 'stopped', sessionId: null, error: reason };
    }
    const sessionId = await executeTask(task);
    const successfulRuns = task.successful_runs + 1;
    const stopReason = task.max_successful_runs != null && successfulRuns >= task.max_successful_runs
      ? `已完成 ${successfulRuns} 次成功执行`
      : null;
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE scheduled_task_runs
        SET status = 'success', session_id = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(sessionId, runId);
      getDb().prepare(`
        UPDATE scheduled_tasks
        SET last_run_at = ?, last_status = 'success', last_error = NULL,
          successful_runs = ?, consecutive_failures = 0, updated_at = datetime('now')
        WHERE id = ?
      `).run(new Date().toISOString(), successfulRuns, taskId);
      if (stopReason) stopTask(taskId, stopReason);
    })();
    return { runId, status: 'success', sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const consecutiveFailures = task.consecutive_failures + 1;
    const stopReason = task.stop_on_target_unavailable && error instanceof TargetUnavailableError
      ? `目标标签页不可用：${message}`
      : task.max_consecutive_failures != null && consecutiveFailures >= task.max_consecutive_failures
        ? `已连续失败 ${consecutiveFailures} 次：${message}`
        : null;
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE scheduled_task_runs
        SET status = 'failed', error = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(message, runId);
      getDb().prepare(`
        UPDATE scheduled_tasks
        SET last_run_at = ?, last_status = 'failed', last_error = ?,
          consecutive_failures = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(new Date().toISOString(), message, consecutiveFailures, taskId);
      if (stopReason) stopTask(taskId, stopReason);
    })();
    return { runId, status: 'failed', sessionId: null, error: message };
  } finally {
    inFlight.delete(taskId);
  }
}

export async function tickScheduledTasks(now = Date.now()): Promise<void> {
  const nowIso = new Date(now).toISOString();
  const expired = getDb().prepare(`
    SELECT id, stop_at FROM scheduled_tasks
    WHERE enabled = 1 AND stop_at IS NOT NULL AND stop_at <= ?
  `).all(nowIso) as Array<{ id: string; stop_at: string }>;
  for (const task of expired) stopTask(task.id, `已到截止时间（${task.stop_at}）`, nowIso);
  const dailyExpired = getDb().prepare(`
    SELECT id, daily_stop_time, daily_stop_at, timezone FROM scheduled_tasks
    WHERE enabled = 1 AND daily_stop_at IS NOT NULL AND daily_stop_at <= ?
  `).all(nowIso) as Array<{ id: string; daily_stop_time: string; daily_stop_at: string; timezone: string }>;
  for (const task of dailyExpired) {
    stopTask(task.id, `已到每日停止时间（${task.daily_stop_time}，${task.timezone}）`, nowIso);
  }

  const due = getDb().prepare(`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC LIMIT 20
  `).all(nowIso) as ScheduledTaskRow[];

  for (const task of due) {
    if (inFlight.has(task.id) || !task.next_run_at) continue;
    let nextRun: string;
    try {
      // Missed occurrences are intentionally collapsed into one run. Compute
      // the next future occurrence from now so restarts never cause a storm.
      nextRun = nextScheduledAt(task.schedule_kind, task.schedule_value, task.timezone, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getDb().prepare(`
        UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL,
          last_status = 'stopped', last_error = NULL, stopped_at = ?, stop_reason = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(nowIso, `计划无效：${message}`, task.id);
      continue;
    }
    const claimed = getDb().prepare(`
      UPDATE scheduled_tasks SET next_run_at = ?, updated_at = datetime('now')
      WHERE id = ? AND enabled = 1 AND next_run_at = ?
    `).run(nextRun, task.id, task.next_run_at);
    if (claimed.changes === 0) continue;
    void runScheduledTask(task.id, 'scheduled', task.next_run_at).then((result) => {
      if (result.status === 'failed') console.error(`[SCHEDULE] ${task.id} failed: ${result.error}`);
    });
  }
}

export function startScheduledTaskScheduler(intervalMs = 15_000): () => void {
  if (schedulerTimer) return stopScheduledTaskScheduler;
  void tickScheduledTasks().catch((error) => console.error('[SCHEDULE] Tick failed:', error));
  schedulerTimer = setInterval(() => {
    void tickScheduledTasks().catch((error) => console.error('[SCHEDULE] Tick failed:', error));
  }, intervalMs);
  schedulerTimer.unref();
  return stopScheduledTaskScheduler;
}

export function stopScheduledTaskScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
