import { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { userCanUseToolForProject, userOwnsProject } from '../auth.js';
import { nextScheduledAt, validateSchedule, type ScheduleKind } from '../services/schedule.js';
import { readCodexWeeklyQuota } from '../services/codex-quota.js';
import {
  runScheduledTask,
  type ScheduledInactivePolicy,
  type ScheduledNewMode,
  type ScheduledTargetType,
  type ScheduledTaskRow,
} from '../services/scheduled-task-runner.js';

interface ScheduledTaskInput {
  project_id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  schedule_value: string;
  timezone: string;
  target_type: ScheduledTargetType;
  target_session_id?: string | null;
  new_mode?: ScheduledNewMode | null;
  new_cli_type?: 'claude' | 'codex' | null;
  new_agent_type?: string | null;
  inactive_policy?: ScheduledInactivePolicy;
  stop_at?: string | null;
  max_successful_runs?: number | null;
  quota_remaining_below?: number | null;
  max_consecutive_failures?: number | null;
  stop_on_target_unavailable?: boolean;
  enabled?: boolean;
}

const scheduleKinds = new Set(['interval', 'daily', 'weekly', 'cron']);
const targetTypes = new Set(['existing', 'new']);
const newModes = new Set(['session', 'agent', 'terminal']);
const cliTypes = new Set(['claude', 'codex']);

function validateRawInput(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '请求内容必须是对象';
  const value = raw as Record<string, unknown>;
  for (const key of ['project_id', 'name', 'prompt', 'schedule_kind', 'schedule_value', 'timezone', 'target_type', 'inactive_policy']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return `${key} 必须是字符串`;
  }
  for (const key of ['target_session_id', 'new_mode', 'new_cli_type', 'new_agent_type', 'stop_at']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return `${key} 必须是字符串或 null`;
  }
  for (const key of ['max_successful_runs', 'quota_remaining_below', 'max_consecutive_failures']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'number') return `${key} 必须是数字或 null`;
  }
  for (const key of ['enabled', 'stop_on_target_unavailable']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return `${key} 必须是布尔值`;
  }
  return null;
}

function taskForUser(id: string, userId: string): ScheduledTaskRow | undefined {
  return getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?').get(id, userId) as ScheduledTaskRow | undefined;
}

function validateTarget(userId: string, input: ScheduledTaskInput): string | null {
  if (!userOwnsProject(userId, input.project_id)) return '项目不存在或无权访问';
  if (!targetTypes.has(input.target_type)) return '目标类型无效';

  if (input.target_type === 'existing') {
    if (!input.target_session_id) return '请选择目标标签页';
    const session = getDb().prepare(`
      SELECT project_id, created_by_user_id FROM sessions WHERE id = ?
    `).get(input.target_session_id) as { project_id: string | null; created_by_user_id: string | null } | undefined;
    if (!session || session.project_id !== input.project_id || session.created_by_user_id !== userId) {
      return '目标标签页不存在或不属于当前用户';
    }
    return null;
  }

  const mode = input.new_mode ?? 'session';
  const cliType = input.new_cli_type === 'codex' ? 'codex' : 'claude';
  if (!newModes.has(mode)) return '新标签页类型无效';
  if (input.new_cli_type && !cliTypes.has(input.new_cli_type)) return 'CLI 类型无效';
  if (mode === 'agent' && !input.new_agent_type?.trim()) return 'Agent 类型不能为空';
  if (!userCanUseToolForProject(userId, input.project_id, mode, mode === 'terminal' ? 'claude' : cliType)) {
    return '无权在该项目创建此类标签页';
  }
  return null;
}

function targetUsesCodex(input: ScheduledTaskInput): boolean {
  if (input.target_type === 'new') return input.new_mode !== 'terminal' && input.new_cli_type === 'codex';
  if (!input.target_session_id) return false;
  const session = getDb().prepare('SELECT mode, cli_type FROM sessions WHERE id = ?')
    .get(input.target_session_id) as { mode: string | null; cli_type: string | null } | undefined;
  return !!session && session.mode !== 'terminal' && session.cli_type === 'codex';
}

function normalizeInput(raw: Partial<ScheduledTaskInput>, base?: ScheduledTaskRow): ScheduledTaskInput {
  return {
    project_id: raw.project_id ?? base?.project_id ?? '',
    name: raw.name ?? base?.name ?? '',
    prompt: raw.prompt ?? base?.prompt ?? '',
    schedule_kind: raw.schedule_kind ?? base?.schedule_kind ?? 'daily',
    schedule_value: raw.schedule_value ?? base?.schedule_value ?? '09:00',
    timezone: raw.timezone ?? base?.timezone ?? 'UTC',
    target_type: raw.target_type ?? base?.target_type ?? 'new',
    target_session_id: raw.target_session_id !== undefined ? raw.target_session_id : base?.target_session_id,
    new_mode: raw.new_mode !== undefined ? raw.new_mode : base?.new_mode,
    new_cli_type: raw.new_cli_type !== undefined ? raw.new_cli_type : base?.new_cli_type,
    new_agent_type: raw.new_agent_type !== undefined ? raw.new_agent_type : base?.new_agent_type,
    inactive_policy: raw.inactive_policy ?? base?.inactive_policy ?? 'resume',
    stop_at: raw.stop_at !== undefined ? raw.stop_at : base?.stop_at,
    max_successful_runs: raw.max_successful_runs !== undefined ? raw.max_successful_runs : base?.max_successful_runs,
    quota_remaining_below: raw.quota_remaining_below !== undefined ? raw.quota_remaining_below : base?.quota_remaining_below,
    max_consecutive_failures: raw.max_consecutive_failures !== undefined ? raw.max_consecutive_failures : base?.max_consecutive_failures,
    stop_on_target_unavailable: raw.stop_on_target_unavailable !== undefined
      ? raw.stop_on_target_unavailable
      : base ? !!base.stop_on_target_unavailable : false,
    enabled: raw.enabled !== undefined ? raw.enabled : base ? !!base.enabled : true,
  };
}

function validateInput(userId: string, input: ScheduledTaskInput): string | null {
  if (!input.name.trim() || input.name.trim().length > 120) return '任务名称必须为 1–120 个字符';
  if (!input.prompt.trim() || input.prompt.length > 100_000) return '提示词必须为 1–100000 个字符';
  if (!scheduleKinds.has(input.schedule_kind)) return '周期类型无效';
  if (input.inactive_policy !== 'resume' && input.inactive_policy !== 'fail') return '标签失效策略无效';
  try {
    validateSchedule(input.schedule_kind, input.schedule_value, input.timezone);
  } catch (error) {
    return error instanceof Error ? error.message : '周期设置无效';
  }
  const targetError = validateTarget(userId, input);
  if (targetError) return targetError;
  if (input.stop_at != null) {
    const stopAt = Date.parse(input.stop_at);
    if (!Number.isFinite(stopAt)) return '截止时间无效';
    if (input.enabled && stopAt <= Date.now()) return '启用任务时，截止时间必须晚于当前时间';
  }
  for (const [value, label] of [
    [input.max_successful_runs, '成功执行次数'],
    [input.max_consecutive_failures, '连续失败次数'],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value < 1 || value > 1_000_000)) return `${label}必须为 1–1000000 的整数`;
  }
  if (input.quota_remaining_below != null) {
    if (!Number.isInteger(input.quota_remaining_below) || input.quota_remaining_below < 1 || input.quota_remaining_below > 100) {
      return 'Codex 周额度下限必须为 1–100 的整数';
    }
    if (!targetUsesCodex(input)) return 'Codex 周额度停止条件仅适用于 Codex Session 或 Agent';
  }
  if (input.stop_on_target_unavailable && input.target_type !== 'existing') {
    return '目标标签页不可用停止条件仅适用于现有标签页';
  }
  return null;
}

export const scheduledTaskRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { project_id?: string } }>('/scheduled-tasks/codex-quota', async (req, reply) => {
    const projectId = req.query.project_id;
    if (!projectId || !userOwnsProject(req.user!.id, projectId)) {
      return reply.status(404).send({ error: '项目不存在或无权访问' });
    }
    const canUseCodex = userCanUseToolForProject(req.user!.id, projectId, 'session', 'codex')
      || userCanUseToolForProject(req.user!.id, projectId, 'agent', 'codex');
    if (!canUseCodex) return reply.status(403).send({ error: '当前项目未授权使用 Codex' });
    try {
      return { quota: await readCodexWeeklyQuota() };
    } catch (error) {
      return reply.status(503).send({ error: error instanceof Error ? error.message : 'Codex 周额度不可用' });
    }
  });

  app.get<{ Querystring: { project_id?: string } }>('/scheduled-tasks', async (req, reply) => {
    if (req.query.project_id && !userOwnsProject(req.user!.id, req.query.project_id)) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    const params: unknown[] = [req.user!.id];
    let projectFilter = '';
    if (req.query.project_id) {
      projectFilter = ' AND project_id = ?';
      params.push(req.query.project_id);
    }
    const tasks = getDb().prepare(`
      SELECT * FROM scheduled_tasks
      WHERE user_id = ?${projectFilter}
      ORDER BY enabled DESC, next_run_at ASC, created_at DESC
    `).all(...params);
    return { tasks };
  });

  app.get<{ Params: { id: string } }>('/scheduled-tasks/:id/runs', async (req, reply) => {
    if (!taskForUser(req.params.id, req.user!.id)) return reply.status(404).send({ error: '定时任务不存在' });
    const runs = getDb().prepare(`
      SELECT * FROM scheduled_task_runs WHERE task_id = ?
      ORDER BY started_at DESC LIMIT 50
    `).all(req.params.id);
    return { runs };
  });

  app.post<{ Body: ScheduledTaskInput }>('/scheduled-tasks', async (req, reply) => {
    const rawError = validateRawInput(req.body);
    if (rawError) return reply.status(400).send({ error: rawError });
    const input = normalizeInput(req.body || {});
    const error = validateInput(req.user!.id, input);
    if (error) return reply.status(400).send({ error });
    const id = nanoid(12);
    const nextRun = input.enabled
      ? nextScheduledAt(input.schedule_kind, input.schedule_value, input.timezone)
      : null;
    getDb().prepare(`
      INSERT INTO scheduled_tasks (
        id, user_id, project_id, name, prompt, schedule_kind, schedule_value, timezone,
        target_type, target_session_id, new_mode, new_cli_type, new_agent_type,
        inactive_policy, stop_at, max_successful_runs, quota_remaining_below,
        max_consecutive_failures, stop_on_target_unavailable, enabled, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.user!.id,
      input.project_id,
      input.name.trim(),
      input.prompt,
      input.schedule_kind,
      input.schedule_value,
      input.timezone,
      input.target_type,
      input.target_type === 'existing' ? input.target_session_id : null,
      input.target_type === 'new' ? (input.new_mode ?? 'session') : null,
      input.target_type === 'new' ? (input.new_cli_type ?? 'claude') : null,
      input.target_type === 'new' && input.new_mode === 'agent' ? input.new_agent_type?.trim() : null,
      input.inactive_policy ?? 'resume',
      input.stop_at ?? null,
      input.max_successful_runs ?? null,
      input.quota_remaining_below ?? null,
      input.max_consecutive_failures ?? null,
      input.target_type === 'existing' && input.stop_on_target_unavailable ? 1 : 0,
      input.enabled ? 1 : 0,
      nextRun,
    );
    return { ok: true, task: taskForUser(id, req.user!.id) };
  });

  app.patch<{ Params: { id: string }; Body: Partial<ScheduledTaskInput> }>('/scheduled-tasks/:id', async (req, reply) => {
    const current = taskForUser(req.params.id, req.user!.id);
    if (!current) return reply.status(404).send({ error: '定时任务不存在' });
    const rawError = validateRawInput(req.body);
    if (rawError) return reply.status(400).send({ error: rawError });
    const input = normalizeInput(req.body || {}, current);
    const error = validateInput(req.user!.id, input);
    if (error) return reply.status(400).send({ error });
    const scheduleChanged = input.schedule_kind !== current.schedule_kind
      || input.schedule_value !== current.schedule_value
      || input.timezone !== current.timezone
      || (!!input.enabled !== !!current.enabled);
    const nextRun = !input.enabled
      ? null
      : scheduleChanged || !current.next_run_at
        ? nextScheduledAt(input.schedule_kind, input.schedule_value, input.timezone)
        : current.next_run_at;
    const restartingStoppedTask = !!input.enabled && !current.enabled && !!current.stopped_at;
    getDb().prepare(`
      UPDATE scheduled_tasks SET
        project_id = ?, name = ?, prompt = ?, schedule_kind = ?, schedule_value = ?, timezone = ?,
        target_type = ?, target_session_id = ?, new_mode = ?, new_cli_type = ?, new_agent_type = ?,
        inactive_policy = ?, stop_at = ?, max_successful_runs = ?, quota_remaining_below = ?,
        max_consecutive_failures = ?, stop_on_target_unavailable = ?, enabled = ?, next_run_at = ?,
        successful_runs = ?, consecutive_failures = ?, stopped_at = ?, stop_reason = ?,
        updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(
      input.project_id,
      input.name.trim(),
      input.prompt,
      input.schedule_kind,
      input.schedule_value,
      input.timezone,
      input.target_type,
      input.target_type === 'existing' ? input.target_session_id : null,
      input.target_type === 'new' ? (input.new_mode ?? 'session') : null,
      input.target_type === 'new' ? (input.new_cli_type ?? 'claude') : null,
      input.target_type === 'new' && input.new_mode === 'agent' ? input.new_agent_type?.trim() : null,
      input.inactive_policy ?? 'resume',
      input.stop_at ?? null,
      input.max_successful_runs ?? null,
      input.quota_remaining_below ?? null,
      input.max_consecutive_failures ?? null,
      input.target_type === 'existing' && input.stop_on_target_unavailable ? 1 : 0,
      input.enabled ? 1 : 0,
      nextRun,
      restartingStoppedTask ? 0 : current.successful_runs,
      restartingStoppedTask ? 0 : current.consecutive_failures,
      input.enabled ? null : current.stopped_at,
      input.enabled ? null : current.stop_reason,
      req.params.id,
      req.user!.id,
    );
    return { ok: true, task: taskForUser(req.params.id, req.user!.id) };
  });

  app.delete<{ Params: { id: string } }>('/scheduled-tasks/:id', async (req, reply) => {
    const result = getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.user!.id);
    if (!result.changes) return reply.status(404).send({ error: '定时任务不存在' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/scheduled-tasks/:id/run', async (req, reply) => {
    if (!taskForUser(req.params.id, req.user!.id)) return reply.status(404).send({ error: '定时任务不存在' });
    const run = await runScheduledTask(req.params.id, 'manual');
    if (run.status !== 'success') return reply.status(409).send({ error: run.error, run });
    return { ok: true, run };
  });
};
