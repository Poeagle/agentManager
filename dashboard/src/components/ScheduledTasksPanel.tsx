import { TableActions, TableActionButton } from './table/TableActions';
import { useTableModel } from './table/use-table-model';
import { DataTable } from './table/DataTable';
import { RowActionsMenu } from './table/RowActionsMenu';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Gauge,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  TerminalSquare,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  api,
  type ScheduleKind,
  type ScheduledNewMode,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledConditionGroup,
  type Session,
} from '../lib/api';
import type { TerminalInstance } from '../lib/project-session-state';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { ScheduleConditionsEditor } from './ScheduleConditionsEditor';
import './ScheduledTasksPanel.css';

const DAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];

type StopConditionType = 'absolute_time' | 'success_count' | 'quota_floor' | 'failure_count' | 'target_unavailable';

interface StopCondition {
  id: string;
  type: StopConditionType;
  value: string;
}

const STOP_CONDITION_OPTIONS: Array<{ value: StopConditionType; label: string }> = [
  { value: 'absolute_time', label: '到指定日期时间' },
  { value: 'success_count', label: '成功执行达到' },
  { value: 'failure_count', label: '连续失败达到' },
  { value: 'quota_floor', label: 'Codex 周额度低于' },
  { value: 'target_unavailable', label: '目标标签页不可用' },
];

let stopConditionSequence = 0;

function newStopCondition(type: StopConditionType): StopCondition {
  const defaults: Record<StopConditionType, string> = {
    absolute_time: '',
    success_count: '1',
    failure_count: '3',
    quota_floor: '20',
    target_unavailable: 'stop',
  };
  stopConditionSequence += 1;
  return { id: `stop-condition-${stopConditionSequence}`, type, value: defaults[type] };
}

interface EditorState {
  id: string | null;
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  weeklyDays: number[];
  weeklyTime: string;
  timezone: string;
  startConditions: ScheduledConditionGroup;
  dailyStopConditions: ScheduledConditionGroup;
  conditionUnmetPolicy: 'wait' | 'skip';
  targetType: 'existing' | 'new';
  targetSessionId: string;
  newMode: ScheduledNewMode;
  newCliType: 'claude' | 'codex';
  inactivePolicy: 'resume' | 'fail';
  stopConditions: StopCondition[];
  enabled: boolean;
}

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function emptyEditor(): EditorState {
  return {
    id: null,
    name: '',
    prompt: '',
    scheduleKind: 'interval',
    scheduleValue: '60',
    weeklyDays: [1, 2, 3, 4, 5],
    weeklyTime: '09:00',
    timezone: localTimezone(),
    startConditions: { operator: 'and', conditions: [{ type: 'time_after', value: '09:00' }] },
    dailyStopConditions: { operator: 'or', conditions: [{ type: 'time_after', value: '18:00' }] },
    conditionUnmetPolicy: 'skip',
    targetType: 'new',
    targetSessionId: '',
    newMode: 'session',
    newCliType: 'claude',
    inactivePolicy: 'resume',
    stopConditions: [],
    enabled: true,
  };
}

function isoToLocalInput(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function editorFromTask(task: ScheduledTask): EditorState {
  const weekly = task.schedule_kind === 'weekly'
    ? /^([0-6](?:,[0-6])*)@(\d{2}:\d{2})$/.exec(task.schedule_value)
    : null;
  const stopConditions: StopCondition[] = [];
  if (task.stop_at) stopConditions.push({ ...newStopCondition('absolute_time'), value: isoToLocalInput(task.stop_at) });
  if (task.max_successful_runs) stopConditions.push({ ...newStopCondition('success_count'), value: task.max_successful_runs.toString() });
  if (task.max_consecutive_failures) stopConditions.push({ ...newStopCondition('failure_count'), value: task.max_consecutive_failures.toString() });
  if (task.quota_remaining_below) stopConditions.push({ ...newStopCondition('quota_floor'), value: task.quota_remaining_below.toString() });
  if (task.stop_on_target_unavailable) stopConditions.push(newStopCondition('target_unavailable'));
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    scheduleKind: task.schedule_kind,
    scheduleValue: task.schedule_value,
    weeklyDays: weekly ? weekly[1].split(',').map(Number) : [1, 2, 3, 4, 5],
    weeklyTime: weekly?.[2] ?? '09:00',
    timezone: task.timezone,
    startConditions: task.start_conditions ?? { operator: 'and', conditions: task.daily_start_time && task.daily_end_time ? [{ type: 'time_range', value: { start: task.daily_start_time, end: task.daily_end_time } }] : [] },
    dailyStopConditions: task.daily_stop_conditions ?? { operator: 'or', conditions: task.daily_stop_time ? [{ type: 'time_after', value: task.daily_stop_time }] : [] },
    conditionUnmetPolicy: 'skip',
    targetType: task.target_type,
    targetSessionId: task.target_session_id ?? '',
    newMode: task.new_mode ?? 'session',
    newCliType: task.new_cli_type ?? 'claude',
    inactivePolicy: task.inactive_policy ?? 'resume',
    stopConditions,
    enabled: !!task.enabled,
  };
}

function scheduleDescription(task: Pick<ScheduledTask, 'schedule_kind' | 'schedule_value' | 'timezone' | 'daily_start_time' | 'daily_end_time' | 'start_conditions' | 'daily_stop_conditions'>): string {
  if (task.schedule_kind === 'interval' && (task.start_conditions || task.daily_stop_conditions)) return `每 ${task.schedule_value} 分钟 · 按条件执行`;
  if (task.schedule_kind === 'interval') return task.daily_start_time && task.daily_end_time
    ? `每天 ${task.daily_start_time}–${task.daily_end_time}${task.daily_end_time < task.daily_start_time ? '（次日）' : ''} · 每 ${task.schedule_value} 分钟`
    : `每 ${task.schedule_value} 分钟 · 全天`;
  if (task.schedule_kind === 'daily') return `每天 ${task.schedule_value}`;
  if (task.schedule_kind === 'weekly') {
    const match = /^([0-6](?:,[0-6])*)@(\d{2}:\d{2})$/.exec(task.schedule_value);
    if (!match) return task.schedule_value;
    const labels = match[1].split(',').map((value) => DAYS.find((day) => day.value === Number(value))?.label).filter(Boolean);
    return `每周${labels.join('、')} ${match[2]}`;
  }
  return `Cron · ${task.schedule_value}`;
}

function formatDate(value: string | null, timezone: string, precise = false): string {
  if (!value) return '未安排';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    ...(precise ? { year: 'numeric' as const, second: '2-digit' as const } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatEpochSeconds(value: number | null): string {
  if (!value) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value * 1000));
}

function sessionDateLabel(value: string | null | undefined): string {
  if (!value) return '未知时间';
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function sessionLabel(session: Session, tabName?: string): string {
  const kind = session.mode === 'terminal' || session.task === 'Terminal' ? 'Terminal' : 'Session';
  const name = tabName?.trim();
  if (name) return `${name} · ${kind} · ${session.status}`;
  const description = session.task && session.task !== 'Terminal' ? session.task : kind;
  return `${description} · ${sessionDateLabel(session.created_at)} · #${session.id.slice(-6)} · ${session.status}`;
}

const fieldClass = 'w-full min-w-0 rounded-md border px-2.5 py-1.5 text-[13px] outline-none focus:ring-1';
const fieldStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

export function ScheduledTasksPanel({
  projectId,
  sessionTabs = [],
}: {
  projectId: string;
  sessionTabs?: readonly TerminalInstance[];
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
  const [page, setPage] = useState<'list' | 'edit'>('list');
  const [formError, setFormError] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ['scheduled-tasks', projectId],
    queryFn: () => api.scheduledTasks.list(projectId),
    refetchInterval: 15_000,
  });
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const tasks = tasksQuery.data?.tasks ?? [];
  const tabNames = useMemo(() => new Map(
    sessionTabs.map((tab) => [tab.id, tab.customLabel?.trim() || tab.label]),
  ), [sessionTabs]);
  const projectSessions = useMemo(() => (
    (sessionsQuery.data?.sessions ?? [])
      .filter((session) => session.project_id === projectId && tabNames.has(session.id))
      .sort((a, b) => {
        const aIndex = sessionTabs.findIndex((tab) => tab.id === a.id);
        const bIndex = sessionTabs.findIndex((tab) => tab.id === b.id);
        return aIndex - bIndex;
      })
  ), [projectId, sessionTabs, sessionsQuery.data?.sessions, tabNames]);
  const selectedTargetSession = projectSessions.find((session) => session.id === editor.targetSessionId);
  const usesCodexQuota = editor.targetType === 'new'
    ? editor.newMode !== 'terminal' && editor.newCliType === 'codex'
    : selectedTargetSession?.mode !== 'terminal' && selectedTargetSession?.cli_type === 'codex';
  const quotaQuery = useQuery({
    queryKey: ['codex-weekly-quota', projectId],
    queryFn: () => api.scheduledTasks.codexQuota(projectId),
    enabled: page === 'edit' && usesCodexQuota,
    refetchInterval: usesCodexQuota ? 60_000 : false,
    staleTime: 30_000,
    retry: false,
  });
  const selectedTask = editor.id ? tasks.find((task) => task.id === editor.id) : undefined;
  const runsQuery = useQuery({
    queryKey: ['scheduled-task-runs', editor.id],
    queryFn: () => api.scheduledTasks.runs(editor.id!),
    enabled: page === 'edit' && !!editor.id,
    refetchInterval: page === 'edit' && editor.id ? 15_000 : false,
  });

  useEffect(() => {
    if (editor.targetType === 'existing' && !editor.targetSessionId && projectSessions[0]) {
      setEditor((current) => ({ ...current, targetSessionId: projectSessions[0].id }));
    }
  }, [editor.targetSessionId, editor.targetType, projectSessions]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['scheduled-tasks', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['scheduled-task-runs'] }),
      queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!editor.name.trim()) throw new Error('请输入任务名称');
      if (!editor.prompt.trim()) throw new Error('请输入提示词');
      if (editor.targetType === 'existing' && !editor.targetSessionId) throw new Error('请选择目标标签页');
      if (editor.scheduleKind === 'weekly' && editor.weeklyDays.length === 0) throw new Error('请至少选择一天');
      const parseOptionalInteger = (value: string, label: string, max: number) => {
        if (!value.trim()) throw new Error(`请输入${label}`);
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须为 1–${max} 的整数`);
        return parsed;
      };
      const conditions = new Map(editor.stopConditions.map((condition) => [condition.type, condition.value]));
      if (conditions.size !== editor.stopConditions.length) throw new Error('同一种停止条件只能添加一次');
      const maxSuccessfulRuns = conditions.has('success_count')
        ? parseOptionalInteger(conditions.get('success_count')!, '成功执行次数', 1_000_000)
        : null;
      const maxConsecutiveFailures = conditions.has('failure_count')
        ? parseOptionalInteger(conditions.get('failure_count')!, '连续失败次数', 1_000_000)
        : null;
      let quotaRemainingBelow: number | null = null;
      if (conditions.has('quota_floor')) {
        if (!usesCodexQuota) throw new Error('Codex 周额度条件只能用于 Codex Session');
        quotaRemainingBelow = parseOptionalInteger(conditions.get('quota_floor')!, 'Codex 周额度下限', 100);
      }
      let stopAt: string | null = null;
      if (conditions.has('absolute_time')) {
        const date = new Date(conditions.get('absolute_time')!);
        if (Number.isNaN(date.getTime())) throw new Error('截止时间无效');
        stopAt = date.toISOString();
      }
      const stopOnTargetUnavailable = conditions.has('target_unavailable');
      if (stopOnTargetUnavailable && editor.targetType !== 'existing') throw new Error('目标不可用条件只能用于现有标签页');
      const scheduleValue = editor.scheduleKind === 'weekly'
        ? `${[...editor.weeklyDays].sort((a, b) => a - b).join(',')}@${editor.weeklyTime}`
        : editor.scheduleValue;
      const payload: ScheduledTaskInput = {
        project_id: projectId,
        name: editor.name.trim(),
        prompt: editor.prompt,
        schedule_kind: editor.scheduleKind,
        schedule_value: scheduleValue,
        timezone: editor.timezone,
        target_type: editor.targetType,
        target_session_id: editor.targetType === 'existing' ? editor.targetSessionId : null,
        new_mode: editor.targetType === 'new' ? editor.newMode : null,
        new_cli_type: editor.targetType === 'new' ? editor.newCliType : null,
        inactive_policy: editor.inactivePolicy,
        stop_at: stopAt,
        daily_stop_time: null,
        daily_start_time: null,
        daily_end_time: null,
        start_conditions: editor.startConditions,
        daily_stop_conditions: editor.dailyStopConditions,
        condition_unmet_policy: editor.conditionUnmetPolicy,
        max_successful_runs: maxSuccessfulRuns,
        quota_remaining_below: quotaRemainingBelow,
        max_consecutive_failures: maxConsecutiveFailures,
        stop_on_target_unavailable: stopOnTargetUnavailable,
        enabled: editor.enabled,
      };
      return editor.id
        ? api.scheduledTasks.update(editor.id, payload)
        : api.scheduledTasks.create(payload);
    },
    onSuccess: async (data) => {
      setFormError('');
      await refresh();
      setEditor(editorFromTask(data.task));
      setPage('list');
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '保存失败'),
  });

  const toggleTask = async (task: ScheduledTask) => {
    try {
      await api.scheduledTasks.update(task.id, { enabled: !task.enabled });
      await refresh();
      if (editor.id === task.id) setEditor((current) => ({ ...current, enabled: !task.enabled }));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '更新失败');
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setRunningId(task.id);
    setFormError('');
    try {
      await api.scheduledTasks.run(task.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '执行失败');
    } finally {
      setRunningId(null);
      await refresh();
    }
  };

  const deleteTask = async (task: ScheduledTask) => {
    if (!window.confirm(`删除定时任务“${task.name}”？执行历史也会一并删除。`)) return;
    try {
      await api.scheduledTasks.delete(task.id);
      if (editor.id === task.id) setEditor(emptyEditor());
      await refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '删除失败');
    }
  };

  const addStopCondition = () => {
    const used = new Set(editor.stopConditions.map((condition) => condition.type));
    const available = STOP_CONDITION_OPTIONS.find((option) => !used.has(option.value)
      && (option.value !== 'quota_floor' || usesCodexQuota)
      && (option.value !== 'target_unavailable' || editor.targetType === 'existing'));
    if (!available) return;
    setEditor((current) => ({ ...current, stopConditions: [...current.stopConditions, newStopCondition(available.value)] }));
  };

  const updateStopCondition = (id: string, update: Partial<Pick<StopCondition, 'type' | 'value'>>) => {
    setEditor((current) => ({
      ...current,
      stopConditions: current.stopConditions.map((condition) => {
        if (condition.id !== id) return condition;
        if (update.type && update.type !== condition.type) return newStopCondition(update.type);
        return { ...condition, ...update };
      }),
    }));
  };

  const removeStopCondition = (id: string) => {
    setEditor((current) => ({
      ...current,
      stopConditions: current.stopConditions.filter((condition) => condition.id !== id),
    }));
  };

  const openEditor = (task?: ScheduledTask) => {
    setEditor(task ? editorFromTask(task) : emptyEditor());
    setFormError('');
    setPage('edit');
  };

  const taskTable = useTableModel(tasks, [
    { key: 'name', title: '任务名称', value: (task) => task.name },
    { key: 'schedule', title: '执行计划', value: (task) => `${scheduleDescription(task)} ${task.timezone}` },
    { key: 'target', title: '目标标签页', value: (task) => task.target_type === 'existing' ? tabNames.get(task.target_session_id ?? '') ?? '现有标签页' : `新建 ${task.new_mode === 'terminal' ? 'Terminal' : 'Session'}` },
    { key: 'state', title: '状态', value: (task) => task.enabled ? task.daily_paused_until && Date.parse(task.daily_paused_until) > Date.now() ? '今日暂停' : task.waiting_reason ? '等待条件' : task.last_status === 'failed' ? '执行失败' : '已启用' : task.stop_reason ? '已停止' : '已暂停' },
    { key: 'next', title: '下次执行', value: (task) => task.next_run_at, kind: 'date', format: (value) => formatDate(value == null ? null : String(value), editor.timezone) },
  ]);
  const runTable = useTableModel(runsQuery.data?.runs ?? [], [
    { key: 'started', title: '执行时间', value: (run) => run.started_at, kind: 'date', format: (value) => formatDate(value == null ? null : String(value), selectedTask?.timezone ?? editor.timezone) },
    { key: 'trigger', title: '触发方式', value: (run) => run.trigger === 'manual' ? '手动执行' : '计划执行' },
    { key: 'status', title: '执行状态', value: (run) => ({ running: '执行中', success: '已发送', failed: '失败', stopped: '已停止', skipped: '已跳过' })[run.status] },
    { key: 'session', title: '目标标签页', value: (run) => run.session_id ? tabNames.get(run.session_id) || (sessionsQuery.data?.sessions ?? []).find((session) => session.id === run.session_id)?.task || '会话标签页' : null },
    { key: 'content', title: '执行情况', value: (run) => run.error || (run.status === 'success' ? '提示词已成功发送' : run.status === 'running' ? '正在发送提示词' : '未发送提示词') },
  ]);

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="page-content py-3">
        <header className="schedule-page-header mb-3 flex flex-wrap items-center justify-between gap-2 border-b py-2" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h1 className="text-base font-semibold">{page === 'list' ? '定时任务' : editor.id ? '编辑定时任务' : '新建定时任务'}</h1>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              服务端按任务时区执行，浏览器关闭后仍生效。
            </p>
          </div>
          {page === 'list' ? <button
            onClick={() => openEditor()}
            className="flex items-center gap-1.5 self-start rounded-lg px-3 py-2 text-xs font-semibold sm:self-auto"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            <Plus className="h-3.5 w-3.5" /> 新建任务
          </button> : <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => { setPage('list'); setFormError(''); }} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}><ArrowLeft className="h-3.5 w-3.5" />返回任务列表</button>
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} className="accent-[var(--accent)]" />启用</label>
            <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
              {saveMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {editor.id ? '保存更改' : '创建任务'}
            </button>
          </div>}
        </header>

        {formError && (
          <div role="alert" className="mb-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--error) 35%, var(--border))', color: 'var(--error)', background: 'color-mix(in srgb, var(--error) 8%, transparent)' }}>
            {formError}
          </div>
        )}

        <div className="space-y-3">
          {page === 'list' && <section className="min-w-0" aria-label="定时任务展示">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>任务列表</h2>
              <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{tasks.length} 个任务</span>
            </div>
              <DataTable label="定时任务列表" model={taskTable} minWidth={850} actions columnWidths={['w-[22%]', '', 'w-[14%]', 'w-28', 'w-44']}
                loading={tasksQuery.isLoading} error={tasksQuery.error?.message} onRetry={() => { void tasksQuery.refetch(); }}
                empty={taskTable.rows.length === 0} emptyMessage={tasks.length ? '没有匹配的任务' : '还没有定时任务'}>
                {taskTable.rows.map((task) => {
                  const failed = task.last_status === 'failed';
                  const stopped = !!task.stop_reason;
                  const dailyPaused = !!task.daily_paused_until && Date.parse(task.daily_paused_until) > Date.now();
                  const targetLabel = task.target_type === 'existing'
                    ? tabNames.get(task.target_session_id ?? '') ?? '现有标签页'
                    : `新建 ${task.new_mode === 'terminal' ? 'Terminal' : 'Session'}`;
                  return (
                    <tr key={task.id}  >
                      <td >
                        <button onClick={() => openEditor(task)} className="block max-w-full truncate text-left font-medium hover:underline" style={{ color: 'var(--accent)' }} title={task.name} aria-label={`查看任务 ${task.name}`}>{task.name}</button>
                        {(task.stop_reason || task.last_error || task.waiting_reason || dailyPaused) && <p className="mt-1 truncate text-[10px]" title={task.stop_reason || task.last_error || task.waiting_reason || task.daily_pause_reason || ''} style={{ color: stopped || dailyPaused ? '#f59e0b' : task.last_error ? 'var(--error)' : 'var(--text-muted)' }}>{task.stop_reason || task.last_error || task.waiting_reason || task.daily_pause_reason}</p>}
                      </td>
                      <td ><div className="text-[11px] leading-relaxed">{scheduleDescription(task)}</div><div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{task.timezone}</div></td>
                      <td ><div className="truncate text-[11px]" title={targetLabel}>{targetLabel}</div></td>
                      <td >
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ color: task.enabled ? failed ? 'var(--error)' : 'var(--success)' : stopped ? '#f59e0b' : 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                            {task.enabled ? dailyPaused ? '今日暂停' : task.waiting_reason ? '条件未满足' : failed ? '执行失败' : '已启用' : stopped ? '已停止' : '已暂停'}
                          </span>
                      </td>
                      <td ><time className="whitespace-nowrap font-mono text-[11px] tabular-nums" style={{ color: task.enabled ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {formatDate(task.next_run_at, task.timezone)}
                      </time></td>
                      <td ><TableActions>
                        <TableActionButton onClick={() => void runNow(task)} disabled={runningId === task.id || stopped}  title={stopped ? '请先重新启用任务' : '立即执行'} style={{ color: 'var(--accent)' }}>
                          {runningId === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        </TableActionButton>
                        <RowActionsMenu label={`${task.name} 的更多操作`} actions={[
                          { label: task.enabled ? '暂停' : stopped ? '重新启用' : '启用', icon: task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />, onClick: () => { void toggleTask(task); } },
                          { label: '编辑', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => openEditor(task) },
                          { label: '删除', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => { void deleteTask(task); } },
                        ]} />
                      </TableActions></td>
                    </tr>
                  );
                })}
                  </DataTable>

          </section>}

          {page === 'edit' && <section aria-label="定时任务设置" className="schedule-editor min-w-0">
            <div className="compact-form space-y-3 p-3">
              <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="w-[360px] max-w-full space-y-1 text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>任务名称</span>
                  <input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} maxLength={120} placeholder="例如：每日代码巡检" className={fieldClass} style={fieldStyle} />
                </label>
                <label className="w-56 max-w-full space-y-1 text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>时区</span>
                  <input value={editor.timezone} onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} list="schedule-timezones" className={fieldClass} style={fieldStyle} />
                  <datalist id="schedule-timezones"><option value="Asia/Taipei" /><option value="Asia/Shanghai" /><option value="UTC" /><option value="America/Los_Angeles" /><option value="Europe/London" /></datalist>
                </label>

                  <label className="block w-40 space-y-1 text-xs"><span style={{ color: 'var(--text-secondary)' }}>执行周期</span>
                    <select aria-label="执行周期" value={editor.scheduleKind} onChange={(event) => {
                      const kind = event.target.value as ScheduleKind;
                      setEditor({ ...editor, scheduleKind: kind, scheduleValue: kind === 'interval' ? '60' : kind === 'cron' ? '0 9 * * 1-5' : '09:00' });
                    }} className={fieldClass} style={fieldStyle}><option value="interval">按间隔</option><option value="daily">每天</option><option value="weekly">每周</option><option value="cron">Cron</option></select>
                  </label>
                  {editor.scheduleKind === 'interval' && <label className="block space-y-1 text-xs"><span style={{ color: 'var(--text-secondary)' }}>执行间隔</span><div className="flex items-center gap-2"><input aria-label="执行间隔" type="number" min={1} max={525600} value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} className={`${fieldClass} !w-24`} style={fieldStyle} /><span>分钟</span></div></label>}
                  {editor.scheduleKind === 'daily' && <label className="block w-36 space-y-1 text-xs"><span>执行时间</span><input aria-label="执行时间" type="time" value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} className={fieldClass} style={fieldStyle} /></label>}
                  {editor.scheduleKind === 'weekly' && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex flex-wrap gap-1">
                        {DAYS.map((day) => {
                          const active = editor.weeklyDays.includes(day.value);
                          return <button key={day.value} onClick={() => setEditor({ ...editor, weeklyDays: active ? editor.weeklyDays.filter((value) => value !== day.value) : [...editor.weeklyDays, day.value] })} className="h-8 w-8 rounded-full text-xs" style={{ background: active ? 'var(--accent)' : 'var(--bg-tertiary)', color: active ? 'white' : 'var(--text-secondary)' }}>{day.label}</button>;
                        })}
                      </div>
                      <input aria-label="每周执行时间" type="time" value={editor.weeklyTime} onChange={(event) => setEditor({ ...editor, weeklyTime: event.target.value })} className={`${fieldClass} sm:w-36`} style={fieldStyle} />
                    </div>
                  )}
                  {editor.scheduleKind === 'cron' && <label className="block w-64 space-y-1 text-xs"><span>Cron 表达式</span><input value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} placeholder="0 9 * * 1-5" className={`${fieldClass} font-mono`} style={fieldStyle} /></label>}
              </div>

              <div className="schedule-target">
                <span className="mb-2 block text-xs" style={{ color: 'var(--text-secondary)' }}>发送到</span>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setEditor({ ...editor, targetType: 'existing' })} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left" style={{ borderColor: editor.targetType === 'existing' ? 'var(--accent)' : 'var(--border)', background: editor.targetType === 'existing' ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent' }}><TerminalSquare className="h-4 w-4" style={{ color: 'var(--accent)' }} /><span><strong className="text-[13px] font-medium">现有标签页</strong></span></button>
                  <button onClick={() => setEditor({ ...editor, targetType: 'new' })} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left" style={{ borderColor: editor.targetType === 'new' ? 'var(--accent)' : 'var(--border)', background: editor.targetType === 'new' ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent' }}><Plus className="h-4 w-4" style={{ color: 'var(--accent)' }} /><span><strong className="text-[13px] font-medium">新建标签页</strong></span></button>
                </div>

                {editor.targetType === 'existing' ? (
                  <div className="field-grid mt-2">
                    <label className="space-y-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>目标标签页</span><select value={editor.targetSessionId} onChange={(event) => setEditor({ ...editor, targetSessionId: event.target.value })} className={fieldClass} style={fieldStyle}><option value="">选择标签页</option>{projectSessions.map((session) => <option key={session.id} value={session.id}>{sessionLabel(session, tabNames.get(session.id))}</option>)}</select></label>
                    <label className="space-y-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>标签页未运行时</span><select value={editor.inactivePolicy} onChange={(event) => setEditor({ ...editor, inactivePolicy: event.target.value as 'resume' | 'fail' })} className={fieldClass} style={fieldStyle}><option value="resume">自动恢复后发送</option><option value="fail">本次执行失败</option></select></label>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <div className="flex gap-2">
                      {([
                        ['session', Zap, 'Session'], ['terminal', TerminalSquare, 'Terminal'],
                      ] as Array<[ScheduledNewMode, typeof Zap, string]>).map(([mode, Icon, label]) => <button key={mode} onClick={() => setEditor({ ...editor, newMode: mode })} className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs" style={{ borderColor: editor.newMode === mode ? 'var(--accent)' : 'var(--border)', color: editor.newMode === mode ? 'var(--accent)' : 'var(--text-secondary)' }}><Icon className="h-3.5 w-3.5" />{label}</button>)}
                    </div>
                    {editor.newMode !== 'terminal' && <div className="grid grid-cols-2 gap-2"><button onClick={() => setEditor({ ...editor, newCliType: 'claude' })} className="flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: editor.newCliType === 'claude' ? 'var(--accent)' : 'var(--border)', color: editor.newCliType === 'claude' ? 'var(--text-primary)' : 'var(--text-secondary)' }}><ClaudeIcon className="h-4 w-4" />Claude</button><button onClick={() => setEditor({ ...editor, newCliType: 'codex' })} className="flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: editor.newCliType === 'codex' ? 'var(--accent)' : 'var(--border)', color: editor.newCliType === 'codex' ? 'var(--text-primary)' : 'var(--text-secondary)' }}><CodexIcon className="h-4 w-4" />Codex</button></div>}
                    {editor.newMode === 'terminal' && <p className="rounded-lg px-3 py-2 text-[10px] leading-relaxed" style={{ background: 'color-mix(in srgb, #f59e0b 9%, transparent)', color: '#f59e0b' }}>Terminal 会把提示词作为终端输入提交；如果标签页处于 Shell，这段文字会被当作命令执行。</p>}
                  </div>
                )}
              </div>

              <section aria-label="执行配置" className="space-y-2">
                <div className="condition-workspace">
                  <ScheduleConditionsEditor phase="start" group={editor.startConditions} onChange={(startConditions) => setEditor({ ...editor, startConditions })} existingTarget={editor.targetType === 'existing'} usesCodex={usesCodexQuota} />
                  <ScheduleConditionsEditor phase="stop" group={editor.dailyStopConditions} onChange={(dailyStopConditions) => setEditor({ ...editor, dailyStopConditions })} existingTarget={editor.targetType === 'existing'} usesCodex={usesCodexQuota} />
                </div>
              </section>

              <details className="schedule-cutoffs" style={{ borderColor: 'var(--border)' }}>
                <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>任务截止限制（可选，到期后需手动重新启用）</summary>
              <section className="mt-2" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold">停止条件</h3>
                    <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>满足任意一条即永久停止任务，不会关闭标签页。</p>
                  </div>
                  <button type="button" onClick={addStopCondition} disabled={editor.stopConditions.length >= STOP_CONDITION_OPTIONS.length} className="flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border))', color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}>
                    <Plus className="h-3.5 w-3.5" />添加停止条件
                  </button>
                </div>

                {editor.stopConditions.length === 0 ? (
                  <button type="button" onClick={addStopCondition} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-3 text-[11px] transition-colors hover:border-orange-500/50" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                    <Plus className="h-3.5 w-3.5" />未设置停止条件
                  </button>
                ) : (
                  <div className="space-y-2">
                    {editor.stopConditions.map((condition, index) => {
                      const usedTypes = new Set(editor.stopConditions.filter((item) => item.id !== condition.id).map((item) => item.type));
                      const numeric = condition.type === 'success_count' || condition.type === 'failure_count' || condition.type === 'quota_floor';
                      return (
                        <div key={condition.id} className="grid grid-cols-[minmax(138px,0.9fr)_minmax(150px,1.1fr)_32px] items-center gap-2 rounded-lg border p-2" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
                          <select aria-label={`停止条件 ${index + 1}`} value={condition.type} onChange={(event) => updateStopCondition(condition.id, { type: event.target.value as StopConditionType })} className={fieldClass} style={fieldStyle}>
                            {STOP_CONDITION_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value} disabled={usedTypes.has(option.value) || (option.value === 'quota_floor' && !usesCodexQuota) || (option.value === 'target_unavailable' && editor.targetType !== 'existing')}>
                                {option.label}
                              </option>
                            ))}
                          </select>

                          {condition.type === 'absolute_time' && <input aria-label="指定停止日期时间" type="datetime-local" value={condition.value} onChange={(event) => updateStopCondition(condition.id, { value: event.target.value })} className={fieldClass} style={fieldStyle} />}
                          {numeric && <div className="flex items-center gap-2"><input aria-label={condition.type === 'quota_floor' ? 'Codex 周额度下限' : condition.type === 'success_count' ? '成功执行次数' : '连续失败次数'} type="number" min={1} max={condition.type === 'quota_floor' ? 100 : 1000000} value={condition.value} onChange={(event) => updateStopCondition(condition.id, { value: event.target.value })} className={fieldClass} style={fieldStyle} /><span className="w-5 shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>{condition.type === 'quota_floor' ? '%' : '次'}</span></div>}
                          {condition.type === 'target_unavailable' && <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>立即停止任务</div>}

                          <button type="button" aria-label={`删除停止条件 ${index + 1}`} onClick={() => removeStopCondition(condition.id)} className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-red-500/10" style={{ color: 'var(--text-muted)' }}><XCircle className="h-4 w-4" /></button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {editor.stopConditions.some((condition) => condition.type === 'quota_floor') && usesCodexQuota && (
                  <div className="mt-2 flex items-center gap-3 rounded-lg border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--accent) 25%, var(--border))', background: 'color-mix(in srgb, var(--accent) 5%, transparent)' }}>
                    <Gauge className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                    {quotaQuery.isLoading ? <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>正在读取 Codex 周额度…</span> : quotaQuery.data?.quota ? <><span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>当前剩余</span><strong className="font-mono text-xs tabular-nums" style={{ color: quotaQuery.data.quota.remainingPercent < 20 ? 'var(--error)' : 'var(--accent)' }}>{quotaQuery.data.quota.remainingPercent}%</strong><span className="ml-auto text-[9px]" style={{ color: 'var(--text-muted)' }}>重置 {formatEpochSeconds(quotaQuery.data.quota.resetsAt)}</span></> : <span className="text-[10px]" style={{ color: 'var(--error)' }}>{quotaQuery.error instanceof Error ? quotaQuery.error.message : '无法读取额度'}</span>}
                  </div>
                )}

                {selectedTask && (selectedTask.successful_runs > 0 || selectedTask.consecutive_failures > 0) && <p className="mt-2 font-mono text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>累计成功 {selectedTask.successful_runs} 次 · 当前连续失败 {selectedTask.consecutive_failures} 次</p>}
              </section>
              </details>
              </div>
              <div className="min-w-0 space-y-5">
              <label className="block space-y-1.5 text-xs">
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>发送内容</span>
                <textarea aria-label="提示词" value={editor.prompt} onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} rows={7} maxLength={100000} placeholder="到时间后发送给标签页的完整指令…" className={`${fieldClass} min-h-36 resize-y leading-relaxed`} style={fieldStyle} />
              </label>

              </div>

            </div>

          </section>}

            {page === 'edit' && selectedTask && (
              <section aria-label="任务运行情况" className="rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                <div className="space-y-1 px-3 py-2">
                  <h2 className="text-sm font-semibold">运行情况</h2>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>下次触发：{formatDate(selectedTask.next_run_at, selectedTask.timezone)} · 上次执行：{selectedTask.last_run_at ? formatDate(selectedTask.last_run_at, selectedTask.timezone) : '尚未执行'} · 已发送 {selectedTask.successful_runs} 次 · 连续失败 {selectedTask.consecutive_failures} 次</p>
                  {(selectedTask.stop_reason || selectedTask.last_error || selectedTask.daily_pause_reason || selectedTask.waiting_reason) && <p className="text-xs" style={{ color: selectedTask.last_error ? 'var(--error)' : 'var(--text-secondary)' }}>{selectedTask.stop_reason || selectedTask.last_error || selectedTask.daily_pause_reason || selectedTask.waiting_reason}</p>}
                </div>
              <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-2 flex items-center gap-2"><History className="h-3.5 w-3.5" style={{ color: 'var(--text-secondary)' }} /><h3 className="text-xs font-semibold">最近执行</h3></div>
                <DataTable label="定时任务执行记录" model={runTable} minWidth={760} columnWidths={['w-[20%]', 'w-[13%]', 'w-[13%]', 'w-[18%]', 'w-[36%]']} className="max-h-80" loading={runsQuery.isLoading} error={runsQuery.isError ? '执行记录加载失败' : undefined}
                  onRetry={() => { void runsQuery.refetch(); }} empty={runTable.rows.length === 0} emptyMessage={runTable.active ? '没有匹配的执行记录' : '还没有执行记录'}>
                      {runTable.rows.map((run) => <tr key={run.id}  >
                          <td className="font-mono tabular-nums">{formatDate(run.started_at, selectedTask.timezone, true)}</td>
                          <td >{run.trigger === 'manual' ? '手动执行' : '计划执行'}</td>
                          <td  style={{ color: run.status === 'success' ? 'var(--success)' : run.status === 'failed' ? 'var(--error)' : 'var(--text-secondary)' }}>{({ running: '执行中', success: '已发送', failed: '失败', stopped: '已停止', skipped: '已跳过' } as const)[run.status]}</td>
                          <td className="truncate">{run.session_id ? tabNames.get(run.session_id) || (sessionsQuery.data?.sessions ?? []).find((session) => session.id === run.session_id)?.task || '会话标签页' : '—'}</td>
                          <td className="break-words leading-relaxed">{run.error || (run.status === 'success' ? '提示词已成功发送' : run.status === 'running' ? '正在发送提示词' : '未发送提示词')}</td>
                        </tr>)}
                    </DataTable>
              </div>
              </section>
            )}
        </div>
      </div>
    </div>
  );
}
