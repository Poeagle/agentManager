import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
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
  type Session,
} from '../lib/api';
import type { TerminalInstance } from '../lib/project-session-state';
import { ClaudeIcon, CodexIcon } from './CliIcons';

const DAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];

type StopConditionType = 'absolute_time' | 'daily_time' | 'success_count' | 'quota_floor' | 'failure_count' | 'target_unavailable';

interface StopCondition {
  id: string;
  type: StopConditionType;
  value: string;
}

const STOP_CONDITION_OPTIONS: Array<{ value: StopConditionType; label: string }> = [
  { value: 'absolute_time', label: '到指定日期时间' },
  { value: 'daily_time', label: '每天到指定时间' },
  { value: 'success_count', label: '成功执行达到' },
  { value: 'failure_count', label: '连续失败达到' },
  { value: 'quota_floor', label: 'Codex 周额度低于' },
  { value: 'target_unavailable', label: '目标标签页不可用' },
];

let stopConditionSequence = 0;

function newStopCondition(type: StopConditionType): StopCondition {
  const defaults: Record<StopConditionType, string> = {
    absolute_time: '',
    daily_time: '18:00',
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
  targetType: 'existing' | 'new';
  targetSessionId: string;
  newMode: ScheduledNewMode;
  newCliType: 'claude' | 'codex';
  newAgentType: string;
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
    scheduleKind: 'daily',
    scheduleValue: '09:00',
    weeklyDays: [1, 2, 3, 4, 5],
    weeklyTime: '09:00',
    timezone: localTimezone(),
    targetType: 'new',
    targetSessionId: '',
    newMode: 'session',
    newCliType: 'claude',
    newAgentType: 'coder',
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
  if (task.daily_stop_time) stopConditions.push({ ...newStopCondition('daily_time'), value: task.daily_stop_time });
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
    targetType: task.target_type,
    targetSessionId: task.target_session_id ?? '',
    newMode: task.new_mode ?? 'session',
    newCliType: task.new_cli_type ?? 'claude',
    newAgentType: task.new_agent_type ?? 'coder',
    inactivePolicy: task.inactive_policy ?? 'resume',
    stopConditions,
    enabled: !!task.enabled,
  };
}

function scheduleDescription(task: Pick<ScheduledTask, 'schedule_kind' | 'schedule_value' | 'timezone'>): string {
  if (task.schedule_kind === 'interval') return `每 ${task.schedule_value} 分钟`;
  if (task.schedule_kind === 'daily') return `每天 ${task.schedule_value}`;
  if (task.schedule_kind === 'weekly') {
    const match = /^([0-6](?:,[0-6])*)@(\d{2}:\d{2})$/.exec(task.schedule_value);
    if (!match) return task.schedule_value;
    const labels = match[1].split(',').map((value) => DAYS.find((day) => day.value === Number(value))?.label).filter(Boolean);
    return `每周${labels.join('、')} ${match[2]}`;
  }
  return `Cron · ${task.schedule_value}`;
}

function formatDate(value: string | null, timezone: string): string {
  if (!value) return '未安排';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
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
  const kind = session.mode === 'agent' ? 'Agent' : session.mode === 'terminal' || session.task === 'Terminal' ? 'Terminal' : 'Session';
  const name = tabName?.trim();
  if (name) return `${name} · ${kind} · ${session.status}`;
  const description = session.task && session.task !== 'Terminal' ? session.task : kind;
  return `${description} · ${sessionDateLabel(session.created_at)} · #${session.id.slice(-6)} · ${session.status}`;
}

const fieldClass = 'w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1';
const fieldStyle = { background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

export function ScheduledTasksPanel({
  projectId,
  sessionTabs = [],
}: {
  projectId: string;
  sessionTabs?: readonly TerminalInstance[];
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
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
    enabled: usesCodexQuota,
    refetchInterval: usesCodexQuota ? 60_000 : false,
    staleTime: 30_000,
    retry: false,
  });
  const selectedTask = editor.id ? tasks.find((task) => task.id === editor.id) : undefined;
  const runsQuery = useQuery({
    queryKey: ['scheduled-task-runs', editor.id],
    queryFn: () => api.scheduledTasks.runs(editor.id!),
    enabled: !!editor.id,
    refetchInterval: editor.id ? 15_000 : false,
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
        if (!usesCodexQuota) throw new Error('Codex 周额度条件只能用于 Codex Session 或 Agent');
        quotaRemainingBelow = parseOptionalInteger(conditions.get('quota_floor')!, 'Codex 周额度下限', 100);
      }
      let stopAt: string | null = null;
      if (conditions.has('absolute_time')) {
        const date = new Date(conditions.get('absolute_time')!);
        if (Number.isNaN(date.getTime())) throw new Error('截止时间无效');
        stopAt = date.toISOString();
      }
      const dailyStopTime = conditions.get('daily_time') ?? null;
      if (dailyStopTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyStopTime)) throw new Error('每日停止时间无效');
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
        new_agent_type: editor.targetType === 'new' && editor.newMode === 'agent' ? editor.newAgentType : null,
        inactive_policy: editor.inactivePolicy,
        stop_at: stopAt,
        daily_stop_time: dailyStopTime,
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

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="mx-auto w-full max-w-[1480px] p-4 sm:p-6">
        <header className="mb-5 flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between" style={{ borderColor: 'var(--border)' }}>
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: 'var(--accent)' }}>
              <Clock3 className="h-3.5 w-3.5" /> Project automation
            </div>
            <h1 className="text-xl font-semibold tracking-tight">定时任务</h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              按项目时区唤醒现有标签页，或创建新的 Session、Agent、Terminal 并发送提示词。浏览器关闭后仍会执行。
            </p>
          </div>
          <button
            onClick={() => { setEditor(emptyEditor()); setFormError(''); }}
            className="flex items-center gap-1.5 self-start rounded-lg px-3 py-2 text-xs font-semibold sm:self-auto"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            <Plus className="h-3.5 w-3.5" /> 新建任务
          </button>
        </header>

        {formError && (
          <div className="mb-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--error) 35%, var(--border))', color: 'var(--error)', background: 'color-mix(in srgb, var(--error) 8%, transparent)' }}>
            {formError}
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(300px,0.82fr)_minmax(460px,1.18fr)]">
          <section className="min-w-0">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>任务时间轴</h2>
              <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{tasks.length} 个任务</span>
            </div>
            {tasksQuery.isLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--accent)' }} /></div>
            ) : tasks.length === 0 ? (
              <button
                onClick={() => setEditor(emptyEditor())}
                className="w-full rounded-xl border border-dashed px-6 py-14 text-center"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                <CalendarClock className="mx-auto mb-3 h-8 w-8 opacity-45" />
                <span className="block text-sm font-medium">还没有定时任务</span>
                <span className="mt-1 block text-xs opacity-70">创建第一个自动执行计划</span>
              </button>
            ) : (
              <div className="relative space-y-2 before:absolute before:bottom-4 before:left-[11px] before:top-4 before:w-px before:bg-[var(--border)]">
                {tasks.map((task) => {
                  const selected = editor.id === task.id;
                  const failed = task.last_status === 'failed';
                  const stopped = !!task.stop_reason;
                  return (
                    <article
                      key={task.id}
                      className="relative ml-5 rounded-xl border p-3 transition-colors"
                      style={{
                        borderColor: selected ? 'var(--accent)' : 'var(--border)',
                        background: selected ? 'color-mix(in srgb, var(--accent) 7%, var(--bg-secondary))' : 'var(--bg-secondary)',
                      }}
                    >
                      <span className="absolute -left-[15px] top-4 h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: 'var(--bg-primary)', background: task.enabled ? failed ? 'var(--error)' : 'var(--accent)' : stopped ? '#f59e0b' : 'var(--text-muted)' }} />
                      <button onClick={() => { setEditor(editorFromTask(task)); setFormError(''); }} className="block w-full text-left">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="truncate text-sm font-semibold">{task.name}</h3>
                            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{scheduleDescription(task)} · {task.timezone}</p>
                          </div>
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ color: task.enabled ? 'var(--success)' : stopped ? '#f59e0b' : 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                            {task.enabled ? '运行中' : stopped ? '已停止' : '已暂停'}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>下次</span>
                          <time className="font-mono text-[11px] tabular-nums" style={{ color: task.enabled ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {formatDate(task.next_run_at, task.timezone)}
                          </time>
                        </div>
                        {task.stop_reason && <p className="mt-2 line-clamp-2 text-[10px]" style={{ color: '#f59e0b' }}>{task.stop_reason}</p>}
                        {!task.stop_reason && task.last_error && <p className="mt-2 line-clamp-2 text-[10px]" style={{ color: 'var(--error)' }}>{task.last_error}</p>}
                      </button>
                      <div className="mt-2 flex items-center justify-end gap-1">
                        <button onClick={() => void runNow(task)} disabled={runningId === task.id || stopped} className="rounded p-1.5 hover:bg-white/5 disabled:opacity-40" title={stopped ? '请先重新启用任务' : '立即执行'} style={{ color: 'var(--accent)' }}>
                          {runningId === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => void toggleTask(task)} className="rounded p-1.5 hover:bg-white/5" title={task.enabled ? '暂停' : stopped ? '重新启用' : '启用'} style={{ color: 'var(--text-secondary)' }}>
                          {task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={() => setEditor(editorFromTask(task))} className="rounded p-1.5 hover:bg-white/5" title="编辑" style={{ color: 'var(--text-secondary)' }}><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => void deleteTask(task)} className="rounded p-1.5 hover:bg-white/5" title="删除" style={{ color: 'var(--error)' }}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <div>
                <h2 className="text-sm font-semibold">{editor.id ? '编辑任务' : '新建任务'}</h2>
                <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>保存后由服务器计算并持久化下一次执行时间</p>
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} className="accent-orange-500" />
                启用
              </label>
            </div>

            <div className="space-y-5 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>任务名称</span>
                  <input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} maxLength={120} placeholder="例如：每日代码巡检" className={fieldClass} style={fieldStyle} />
                </label>
                <label className="space-y-1.5 text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>时区</span>
                  <input value={editor.timezone} onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} list="schedule-timezones" className={fieldClass} style={fieldStyle} />
                  <datalist id="schedule-timezones"><option value="Asia/Taipei" /><option value="Asia/Shanghai" /><option value="UTC" /><option value="America/Los_Angeles" /><option value="Europe/London" /></datalist>
                </label>
              </div>

              <div>
                <span className="mb-2 block text-xs" style={{ color: 'var(--text-secondary)' }}>执行周期</span>
                <div className="grid grid-cols-4 gap-1 rounded-lg p-1" style={{ background: 'var(--bg-tertiary)' }}>
                  {([
                    ['interval', '间隔'], ['daily', '每天'], ['weekly', '每周'], ['cron', 'Cron'],
                  ] as Array<[ScheduleKind, string]>).map(([kind, label]) => (
                    <button key={kind} onClick={() => setEditor({ ...editor, scheduleKind: kind, scheduleValue: kind === 'interval' ? '60' : kind === 'cron' ? '0 9 * * 1-5' : '09:00' })} className="rounded-md px-2 py-1.5 text-xs font-medium" style={{ background: editor.scheduleKind === kind ? 'var(--bg-primary)' : 'transparent', color: editor.scheduleKind === kind ? 'var(--accent)' : 'var(--text-secondary)' }}>{label}</button>
                  ))}
                </div>
                <div className="mt-2">
                  {editor.scheduleKind === 'interval' && <div className="flex items-center gap-2"><input type="number" min={1} max={525600} value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} className={fieldClass} style={fieldStyle} /><span className="shrink-0 text-xs" style={{ color: 'var(--text-secondary)' }}>分钟</span></div>}
                  {editor.scheduleKind === 'daily' && <input type="time" value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} className={fieldClass} style={fieldStyle} />}
                  {editor.scheduleKind === 'weekly' && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex flex-wrap gap-1">
                        {DAYS.map((day) => {
                          const active = editor.weeklyDays.includes(day.value);
                          return <button key={day.value} onClick={() => setEditor({ ...editor, weeklyDays: active ? editor.weeklyDays.filter((value) => value !== day.value) : [...editor.weeklyDays, day.value] })} className="h-8 w-8 rounded-full text-xs" style={{ background: active ? 'var(--accent)' : 'var(--bg-tertiary)', color: active ? 'white' : 'var(--text-secondary)' }}>{day.label}</button>;
                        })}
                      </div>
                      <input type="time" value={editor.weeklyTime} onChange={(event) => setEditor({ ...editor, weeklyTime: event.target.value })} className={`${fieldClass} sm:ml-auto sm:w-36`} style={fieldStyle} />
                    </div>
                  )}
                  {editor.scheduleKind === 'cron' && <><input value={editor.scheduleValue} onChange={(event) => setEditor({ ...editor, scheduleValue: event.target.value })} placeholder="0 9 * * 1-5" className={`${fieldClass} font-mono`} style={fieldStyle} /><p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>5 个字段：分 时 日 月 星期；支持 *、列表、范围和 */步长</p></>}
                </div>
              </div>

              <div>
                <span className="mb-2 block text-xs" style={{ color: 'var(--text-secondary)' }}>发送到</span>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setEditor({ ...editor, targetType: 'existing' })} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left" style={{ borderColor: editor.targetType === 'existing' ? 'var(--accent)' : 'var(--border)', background: editor.targetType === 'existing' ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent' }}><TerminalSquare className="h-4 w-4" style={{ color: 'var(--accent)' }} /><span><strong className="block text-xs">现有标签页</strong><small style={{ color: 'var(--text-muted)' }}>按策略恢复后发送</small></span></button>
                  <button onClick={() => setEditor({ ...editor, targetType: 'new' })} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-left" style={{ borderColor: editor.targetType === 'new' ? 'var(--accent)' : 'var(--border)', background: editor.targetType === 'new' ? 'color-mix(in srgb, var(--accent) 7%, transparent)' : 'transparent' }}><Plus className="h-4 w-4" style={{ color: 'var(--accent)' }} /><span><strong className="block text-xs">新建标签页</strong><small style={{ color: 'var(--text-muted)' }}>每次创建一个新会话</small></span></button>
                </div>

                {editor.targetType === 'existing' ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>目标标签页</span><select value={editor.targetSessionId} onChange={(event) => setEditor({ ...editor, targetSessionId: event.target.value })} className={fieldClass} style={fieldStyle}><option value="">选择标签页</option>{projectSessions.map((session) => <option key={session.id} value={session.id}>{sessionLabel(session, tabNames.get(session.id))}</option>)}</select></label>
                    <label className="space-y-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>标签页未运行时</span><select value={editor.inactivePolicy} onChange={(event) => setEditor({ ...editor, inactivePolicy: event.target.value as 'resume' | 'fail' })} className={fieldClass} style={fieldStyle}><option value="resume">自动恢复后发送</option><option value="fail">本次执行失败</option></select></label>
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['session', Zap, 'Session'], ['agent', Bot, 'Agent'], ['terminal', TerminalSquare, 'Terminal'],
                      ] as Array<[ScheduledNewMode, typeof Zap, string]>).map(([mode, Icon, label]) => <button key={mode} onClick={() => setEditor({ ...editor, newMode: mode })} className="flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs" style={{ borderColor: editor.newMode === mode ? 'var(--accent)' : 'var(--border)', color: editor.newMode === mode ? 'var(--accent)' : 'var(--text-secondary)' }}><Icon className="h-3.5 w-3.5" />{label}</button>)}
                    </div>
                    {editor.newMode !== 'terminal' && <div className="grid grid-cols-2 gap-2"><button onClick={() => setEditor({ ...editor, newCliType: 'claude' })} className="flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: editor.newCliType === 'claude' ? 'var(--accent)' : 'var(--border)', color: editor.newCliType === 'claude' ? 'var(--text-primary)' : 'var(--text-secondary)' }}><ClaudeIcon className="h-4 w-4" />Claude</button><button onClick={() => setEditor({ ...editor, newCliType: 'codex' })} className="flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: editor.newCliType === 'codex' ? 'var(--accent)' : 'var(--border)', color: editor.newCliType === 'codex' ? 'var(--text-primary)' : 'var(--text-secondary)' }}><CodexIcon className="h-4 w-4" />Codex</button></div>}
                    {editor.newMode === 'agent' && <label className="block space-y-1.5 text-xs"><span style={{ color: 'var(--text-secondary)' }}>Agent 类型</span><input value={editor.newAgentType} onChange={(event) => setEditor({ ...editor, newAgentType: event.target.value })} placeholder="coder" className={fieldClass} style={fieldStyle} /></label>}
                    {editor.newMode === 'terminal' && <p className="rounded-lg px-3 py-2 text-[10px] leading-relaxed" style={{ background: 'color-mix(in srgb, #f59e0b 9%, transparent)', color: '#f59e0b' }}>Terminal 会把提示词作为终端输入提交；如果标签页处于 Shell，这段文字会被当作命令执行。</p>}
                  </div>
                )}
              </div>

              <label className="block space-y-1.5 text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>提示词</span>
                <textarea value={editor.prompt} onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} rows={7} maxLength={100000} placeholder="到时间后发送给标签页的完整指令…" className={`${fieldClass} resize-y leading-relaxed`} style={fieldStyle} />
              </label>

              <section className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg-tertiary) 44%, transparent)' }}>
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
                          {condition.type === 'daily_time' && <div className="flex items-center gap-2"><input aria-label="每日停止时间" type="time" value={condition.value} onChange={(event) => updateStopCondition(condition.id, { value: event.target.value })} className={fieldClass} style={fieldStyle} /><span className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>{editor.timezone}</span></div>}
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

              <div className="flex items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedTask?.last_run_at ? `上次执行：${formatDate(selectedTask.last_run_at, selectedTask.timezone)}` : '尚未执行'}
                </div>
                <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
                  {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
                  {editor.id ? '保存更改' : '创建任务'}
                </button>
              </div>
            </div>

            {editor.id && (
              <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                <div className="mb-2 flex items-center gap-2"><History className="h-3.5 w-3.5" style={{ color: 'var(--text-secondary)' }} /><h3 className="text-xs font-semibold">最近执行</h3></div>
                <div className="max-h-44 space-y-1 overflow-y-auto">
                  {runsQuery.isLoading ? <Loader2 className="mx-auto my-4 h-4 w-4 animate-spin" /> : (runsQuery.data?.runs.length ?? 0) === 0 ? <p className="py-3 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>还没有执行记录</p> : runsQuery.data?.runs.map((run) => (
                    <div key={run.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[10px]" style={{ background: 'var(--bg-tertiary)' }}>
                      {run.status === 'success' ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--success)' }} /> : run.status === 'failed' ? <XCircle className="mt-0.5 h-3 w-3 shrink-0" style={{ color: 'var(--error)' }} /> : run.status === 'stopped' ? <Pause className="mt-0.5 h-3 w-3 shrink-0" style={{ color: '#f59e0b' }} /> : <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />}
                      <div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><span>{run.trigger === 'manual' ? '手动执行' : '计划执行'}</span><time className="font-mono" style={{ color: 'var(--text-muted)' }}>{formatDate(run.started_at, editor.timezone)}</time></div>{run.error && <p className="mt-0.5 truncate" title={run.error} style={{ color: 'var(--error)' }}>{run.error}</p>}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
