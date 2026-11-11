import {assertEnvironmentUse} from '../services/agents/environment-access.js';
import {readEngineModelsForEnvironment} from '../services/agents/codex/controls.js';
import type {ModelPreference} from '../services/agents/types.js';
import {sendAgentQuota} from '../services/agents/quota-response.js';
import {agentDescriptors,getAgent} from '../services/agents/index.js';
import {targetSupportsQuota} from '../services/agents/scheduling.js';
import {FastifyPluginAsync} from 'fastify';
import {nanoid} from 'nanoid';
import {getDb} from '../db/index.js';
import {userCanUseToolForProject,userOwnsProject} from '../auth.js';
import {nextScheduledAt,validateSchedule,validateDailyWindow,type ScheduleKind} from '../services/schedule.js';
import {readCodexWeeklyQuota} from '../services/agents/codex/quota.js';
import {flattenTaskConditions,parseTaskConditions,validateTaskConditions,type TaskConditionGroup} from '../services/scheduled-task-conditions.js';
import {runScheduledTask,type ScheduledInactivePolicy,type ScheduledNewMode,type ScheduledTargetType,type ScheduledTaskRow,} from '../services/scheduled-task-runner.js';

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
  new_cli_type?: string | null;
  new_environment_id?: string | null;
  new_model_preference?: ModelPreference | null;
  inactive_policy?: ScheduledInactivePolicy;
  stop_at?: string | null;
  daily_stop_time?: string | null;
  daily_start_time?: string | null;
  daily_end_time?: string | null;
  start_conditions?: TaskConditionGroup | null;
  daily_stop_conditions?: TaskConditionGroup | null;
  condition_unmet_policy?: 'wait' | 'skip';
  max_successful_runs?: number | null;
  quota_remaining_below?: number | null;
  max_consecutive_failures?: number | null;
  stop_on_target_unavailable?: boolean;
  enabled?: boolean;
}

const scheduleKinds = new Set(['interval', 'daily', 'weekly', 'cron']);
const targetTypes = new Set(['existing', 'new']);
const newModes = new Set(['session', 'terminal']);


function validateRawInput(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '请求内容必须是对象';
  const value = raw as Record<string, unknown>;
  for (const key of ['project_id', 'name', 'prompt', 'schedule_kind', 'schedule_value', 'timezone', 'target_type', 'inactive_policy', 'condition_unmet_policy']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return `${key} 必须是字符串`;
  }
  for (const key of ['target_session_id', 'new_mode', 'new_cli_type', 'new_environment_id', 'stop_at', 'daily_stop_time', 'daily_start_time', 'daily_end_time']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return `${key} 必须是字符串或 null`;
  }
  for (const key of ['max_successful_runs', 'quota_remaining_below', 'max_consecutive_failures']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'number') return `${key} 必须是数字或 null`;
  }
  for (const key of ['enabled', 'stop_on_target_unavailable']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return `${key} 必须是布尔值`;
  }
  const pref = value.new_model_preference;
  if (pref !== undefined && pref !== null) {
    if (typeof pref !== 'object' || Array.isArray(pref)) return '模型参数无效';
    const p = pref as Record<string, unknown>;
    if (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200 || typeof p.effort !== 'string' || p.effort.length > 100 || (p.provider !== undefined && (typeof p.provider !== 'string' || p.provider.length > 200)) || (p.service_tier !== undefined && (typeof p.service_tier !== 'string' || p.service_tier.length > 100))) return '模型参数无效';
  }
  return null;
}

function taskForUser(id: string, userId: string): ScheduledTaskRow | undefined {
  return getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?').get(id, userId) as ScheduledTaskRow | undefined;
}

function taskResponse(task: ScheduledTaskRow | undefined) {
  return task && { ...task, new_model_preference: task.new_model_preference ? JSON.parse(task.new_model_preference) : null, start_conditions: parseTaskConditions(task.start_conditions), daily_stop_conditions: parseTaskConditions(task.daily_stop_conditions) };
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
  if (mode === 'session' && input.new_cli_type === 'codex') {
    try { assertEnvironmentUse('codex', input.new_environment_id || 'native', userId); } catch { return '无权使用该 Codex Engine'; }
    if (input.new_model_preference && !input.new_environment_id) return '请选择 Engine';
  } else if (input.new_environment_id || input.new_model_preference) return 'Engine 和模型配置仅适用于 Codex Session';
  const cliType = input.new_cli_type||'claude';
  if (!newModes.has(mode)) return '新标签页类型无效';
  if (input.new_cli_type && !agentDescriptors().some(agent=>agent.id===input.new_cli_type)) return 'CLI 类型无效';
  if (!userCanUseToolForProject(userId, input.project_id, mode, mode === 'terminal' ? 'claude' : cliType)) {
    return '无权在该项目创建此类标签页';
  }
  return null;
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
    new_environment_id: raw.new_environment_id !== undefined ? raw.new_environment_id : base?.new_environment_id,
    new_model_preference: raw.new_model_preference !== undefined ? raw.new_model_preference : base?.new_model_preference ? JSON.parse(base.new_model_preference) : null,
    inactive_policy: raw.inactive_policy ?? base?.inactive_policy ?? 'resume',
    stop_at: raw.stop_at !== undefined ? raw.stop_at : base?.stop_at,
    daily_stop_time: raw.daily_stop_time !== undefined ? raw.daily_stop_time : base?.daily_stop_time,
    daily_start_time: raw.daily_start_time !== undefined ? raw.daily_start_time : base?.daily_start_time,
    daily_end_time: raw.daily_end_time !== undefined ? raw.daily_end_time : base?.daily_end_time,
    start_conditions: raw.start_conditions !== undefined ? raw.start_conditions : parseTaskConditions(base?.start_conditions),
    daily_stop_conditions: raw.daily_stop_conditions !== undefined ? raw.daily_stop_conditions : parseTaskConditions(base?.daily_stop_conditions),
    condition_unmet_policy: raw.condition_unmet_policy ?? base?.condition_unmet_policy ?? 'skip',
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
    validateDailyWindow(input.schedule_kind, input);
    validateTaskConditions(input.start_conditions, input.timezone, 'start', input.target_type === 'existing');
    validateTaskConditions(input.daily_stop_conditions, input.timezone, 'stop', input.target_type === 'existing');
    if (!['wait', 'skip'].includes(input.condition_unmet_policy ?? 'wait')) throw new Error('请选择等待条件满足或跳过本次执行');
  } catch (error) {
    return error instanceof Error ? error.message : '周期设置无效';
  }
  const targetError = validateTarget(userId, input);
  if (targetError) return targetError;
  if (flattenTaskConditions(input.daily_stop_conditions ?? null).some((condition) => condition.type === 'quota_below') && !targetSupportsQuota(input)) return '所选 Agent 不支持额度条件';
  if (input.stop_at != null) {
    const stopAt = Date.parse(input.stop_at);
    if (!Number.isFinite(stopAt)) return '截止时间无效';
    if (input.enabled && stopAt <= Date.now()) return '启用任务时，截止时间必须晚于当前时间';
  }
  if (input.daily_stop_time != null) {
    try {
      validateSchedule('daily', input.daily_stop_time, input.timezone);
    } catch {
      return '每日停止时间必须是有效的 HH:mm 时间';
    }
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
    if (!targetSupportsQuota(input)) return '所选 Agent 不支持额度条件';
  }
  if (input.stop_on_target_unavailable && input.target_type !== 'existing') {
    return '目标标签页不可用停止条件仅适用于现有标签页';
  }
  return null;
}

export const scheduledTaskRoutes: FastifyPluginAsync = async (app) => {
  app.get<{Querystring:{project_id?:string;environment_id?:string}}>('/scheduled-tasks/codex-models',async(req,reply)=>{
    const {project_id,environment_id}=req.query;
    if (!project_id || !environment_id || !userOwnsProject(req.user!.id,project_id) || !userCanUseToolForProject(req.user!.id,project_id,'session','codex')) return reply.code(403).send({error:'无权使用该项目'});
    try { assertEnvironmentUse('codex',environment_id,req.user!.id); return {models:await readEngineModelsForEnvironment(environment_id)}; } catch(e) { return reply.code((e as {statusCode?:number}).statusCode || 503).send({error:e instanceof Error?e.message:'读取模型失败'}); }
  });
  app.get<{Params:{agent:string};Querystring:{refresh?:string}}>('/agent-quota/:agent',async(req,reply)=>sendAgentQuota(reply,()=>getAgent(req.params.agent).quota.read(req.query.refresh==='true')));
  app.get<{ Querystring: { refresh?: string } }>('/codex-quota', async (req, reply) => {
    return sendAgentQuota(reply,()=>readCodexWeeklyQuota({force:req.query.refresh === 'true'}));
  });

  app.get<{Querystring:{project_id?:string;agent_id?:string}}>('/scheduled-tasks/agent-quota',async(req,reply)=>{
    const {project_id:project,agent_id:agent}=req.query;if(!project||!agent||!userOwnsProject(req.user!.id,project))return reply.code(404).send({error:'项目不存在或无权访问'});
    if(!userCanUseToolForProject(req.user!.id,project,'session',agent))return reply.code(403).send({error:'当前项目未授权使用此 Agent'});
    return sendAgentQuota(reply,()=>getAgent(agent).quota.read());
  });
  app.get<{ Querystring: { project_id?: string } }>('/scheduled-tasks/codex-quota', async (req, reply) => {
    const projectId = req.query.project_id;
    if (!projectId || !userOwnsProject(req.user!.id, projectId)) {
      return reply.status(404).send({ error: '项目不存在或无权访问' });
    }
    const canUseCodex = userCanUseToolForProject(req.user!.id, projectId, 'session', 'codex');
    if (!canUseCodex) return reply.status(403).send({ error: '当前项目未授权使用 Codex' });
    return sendAgentQuota(reply,()=>readCodexWeeklyQuota());
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
    `).all(...params) as ScheduledTaskRow[];
    return { tasks: tasks.map(taskResponse) };
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
      ? nextScheduledAt(input.schedule_kind, input.schedule_value, input.timezone, Date.now(), input)
      : null;
    const dailyStopAt = input.enabled && input.daily_stop_time
      ? nextScheduledAt('daily', input.daily_stop_time, input.timezone)
      : null;
    getDb().prepare(`
      INSERT INTO scheduled_tasks (
        id, user_id, project_id, name, prompt, schedule_kind, schedule_value, timezone,
        target_type, target_session_id, new_mode, new_cli_type, new_environment_id, new_model_preference,
        inactive_policy, stop_at, daily_stop_time, daily_stop_at, daily_start_time, daily_end_time, start_conditions, daily_stop_conditions, condition_unmet_policy, max_successful_runs, quota_remaining_below,
        max_consecutive_failures, stop_on_target_unavailable, enabled, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.target_type === 'new' && input.new_mode !== 'terminal' && input.new_cli_type === 'codex' ? input.new_environment_id ?? null : null,
      input.target_type === 'new' && input.new_mode !== 'terminal' && input.new_cli_type === 'codex' && input.new_model_preference ? JSON.stringify(input.new_model_preference) : null,
      input.inactive_policy ?? 'resume',
      input.stop_at ?? null,
      input.daily_stop_time ?? null,
      dailyStopAt,
      input.daily_start_time ?? null,
      input.daily_end_time ?? null,
      input.start_conditions ? JSON.stringify(input.start_conditions) : null,
      input.daily_stop_conditions ? JSON.stringify(input.daily_stop_conditions) : null,
      input.condition_unmet_policy ?? 'skip',
      input.max_successful_runs ?? null,
      input.quota_remaining_below ?? null,
      input.max_consecutive_failures ?? null,
      input.target_type === 'existing' && input.stop_on_target_unavailable ? 1 : 0,
      input.enabled ? 1 : 0,
      nextRun,
    );
    return { ok: true, task: taskResponse(taskForUser(id, req.user!.id)) };
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
      || (input.daily_start_time ?? null) !== current.daily_start_time
      || (input.daily_end_time ?? null) !== current.daily_end_time
      || JSON.stringify(input.start_conditions ?? null) !== (current.start_conditions ?? 'null')
      || JSON.stringify(input.daily_stop_conditions ?? null) !== (current.daily_stop_conditions ?? 'null')
      || input.condition_unmet_policy !== current.condition_unmet_policy
      || (!!input.enabled !== !!current.enabled);
    const nextRun = !input.enabled
      ? null
      : scheduleChanged || !current.next_run_at
        ? nextScheduledAt(input.schedule_kind, input.schedule_value, input.timezone, Date.now(), input)
        : current.next_run_at;
    const dailyStopChanged = input.daily_stop_time !== current.daily_stop_time
      || input.timezone !== current.timezone
      || (!!input.enabled !== !!current.enabled);
    const dailyStopAt = !input.enabled || !input.daily_stop_time
      ? null
      : dailyStopChanged || !current.daily_stop_at
        ? nextScheduledAt('daily', input.daily_stop_time, input.timezone)
        : current.daily_stop_at;
    const restartingStoppedTask = !!input.enabled && !current.enabled && !!current.stopped_at;
    getDb().prepare(`
      UPDATE scheduled_tasks SET
        project_id = ?, name = ?, prompt = ?, schedule_kind = ?, schedule_value = ?, timezone = ?,
        target_type = ?, target_session_id = ?, new_mode = ?, new_cli_type = ?, new_environment_id = ?, new_model_preference = ?,
        inactive_policy = ?, stop_at = ?, daily_stop_time = ?, daily_stop_at = ?, daily_start_time = ?, daily_end_time = ?,
        start_conditions = ?, daily_stop_conditions = ?, condition_unmet_policy = ?,
        max_successful_runs = ?, quota_remaining_below = ?,
        max_consecutive_failures = ?, stop_on_target_unavailable = ?, enabled = ?, next_run_at = ?,
        successful_runs = ?, consecutive_failures = ?, stopped_at = ?, stop_reason = ?,
        daily_paused_until = ?, daily_pause_reason = ?, waiting_reason = ?,
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
      input.target_type === 'new' && input.new_mode !== 'terminal' && input.new_cli_type === 'codex' ? input.new_environment_id ?? null : null,
      input.target_type === 'new' && input.new_mode !== 'terminal' && input.new_cli_type === 'codex' && input.new_model_preference ? JSON.stringify(input.new_model_preference) : null,
      input.inactive_policy ?? 'resume',
      input.stop_at ?? null,
      input.daily_stop_time ?? null,
      dailyStopAt,
      input.daily_start_time ?? null,
      input.daily_end_time ?? null,
      input.start_conditions ? JSON.stringify(input.start_conditions) : null,
      input.daily_stop_conditions ? JSON.stringify(input.daily_stop_conditions) : null,
      input.condition_unmet_policy ?? 'skip',
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
      scheduleChanged ? null : current.daily_paused_until,
      scheduleChanged ? null : current.daily_pause_reason,
      scheduleChanged ? null : current.waiting_reason,
      req.params.id,
      req.user!.id,
    );
    return { ok: true, task: taskResponse(taskForUser(req.params.id, req.user!.id)) };
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
