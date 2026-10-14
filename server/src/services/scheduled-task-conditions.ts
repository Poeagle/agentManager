import { isWithinDailyWindow, nextScheduledAt, validateSchedule } from './schedule.js';

export type TaskCondition =
  | { type: 'time_after'; value: string }
  | { type: 'time_range'; value: { start: string; end: string } }
  | { type: 'weekday'; value: 'workday' | 'weekend' }
  | { type: 'target_idle'; value: boolean }
  | { type: 'quota_below' | 'successes_today' | 'failures_today'; value: number };

export interface TaskConditionGroup {
  operator: 'and' | 'or';
  conditions: Array<TaskCondition | TaskConditionGroup>;
}

export interface ConditionContext {
  now: number;
  timezone: string;
  targetIdle: boolean | null;
  quotaRemaining: number | null;
  successesToday: number;
  failuresToday: number;
}

export function validateTaskConditions(raw: unknown, timezone: string, phase: 'start' | 'stop', existingTarget: boolean): void {
  if (raw == null) return;
  let count = 0;
  function validateGroup(raw: unknown, depth: number): void {
    if (depth > 4) throw new Error('条件分组最多支持 4 层');
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('条件组必须是对象');
    const group = raw as TaskConditionGroup;
    if (!group || (group.operator !== 'and' && group.operator !== 'or')) throw new Error('条件组合请选择「且」或「或」');
    if (!Array.isArray(group.conditions) || group.conditions.length > 20) throw new Error('每组最多设置 20 条条件');
    if (depth > 1 && group.conditions.length === 0) throw new Error('条件分组不能为空，请添加条件或删除该组');
    for (const node of group.conditions) {
      if (++count > 50) throw new Error('开始或停止条件最多设置 50 项（含分组）');
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('条件格式无效');
      if ('conditions' in node || 'operator' in node) { validateGroup(node, depth + 1); continue; }
      const condition = node as TaskCondition;
      if (condition.type === 'time_after') {
        if (typeof condition.value !== 'string') throw new Error('条件时间必须为 HH:mm');
        validateSchedule('daily', condition.value, timezone);
      } else if (condition.type === 'time_range') {
        if (!condition.value || typeof condition.value !== 'object') throw new Error('请设置条件的时间段');
        validateSchedule('daily', condition.value.start, timezone);
        validateSchedule('daily', condition.value.end, timezone);
        if (condition.value.start === condition.value.end) throw new Error('时段开始与结束时间不能相同');
      } else if (condition.type === 'weekday') {
        if (condition.value !== 'workday' && condition.value !== 'weekend') throw new Error('请选择工作日或非工作日');
      } else if (condition.type === 'target_idle') {
        if (!existingTarget) throw new Error('标签页空闲条件仅适用于现有标签页');
        if (typeof condition.value !== 'boolean') throw new Error('空闲条件无效');
      } else if (['quota_below', 'successes_today', 'failures_today'].includes(condition.type)) {
        if (phase === 'start') throw new Error('该条件仅适用于每天停止条件');
        const max = condition.type === 'quota_below' ? 100 : 1_000_000;
        if (!Number.isInteger(condition.value) || (condition.value as number) < 1 || (condition.value as number) > max) throw new Error(`条件值必须为 1–${max} 的整数`);
      } else throw new Error('不支持的条件类型');
    }
  }
  validateGroup(raw, 1);
}

export function flattenTaskConditions(group: TaskConditionGroup | null): TaskCondition[] {
  return group?.conditions.flatMap((node) => 'conditions' in node ? flattenTaskConditions(node) : [node]) ?? [];
}

export function parseTaskConditions(value: string | null | undefined): TaskConditionGroup | null {
  return value ? JSON.parse(value) as TaskConditionGroup : null;
}

export function localDateKey(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function matches(condition: TaskCondition, context: ConditionContext): boolean | null {
  if (condition.type === 'target_idle') return context.targetIdle == null ? null : context.targetIdle === condition.value;
  if (condition.type === 'quota_below') return context.quotaRemaining == null ? null : context.quotaRemaining < condition.value;
  if (condition.type === 'successes_today') return context.successesToday >= condition.value;
  if (condition.type === 'failures_today') return context.failuresToday >= condition.value;
  if (condition.type === 'time_range') {
    return isWithinDailyWindow({ daily_start_time: condition.value.start, daily_end_time: condition.value.end }, context.timezone, context.now);
  }
  if (condition.type === 'weekday') {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: context.timezone, weekday: 'short' }).format(new Date(context.now));
    const workday = !['Sat', 'Sun'].includes(weekday);
    return condition.value === 'workday' ? workday : !workday;
  }
  if (condition.type !== 'time_after') return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: context.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(context.now));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const [boundaryHour, boundaryMinute] = condition.value.split(':').map(Number);
  return hour * 60 + minute >= boundaryHour * 60 + boundaryMinute;
}

/** Unknown state blocks dispatch; it is never silently treated as a false stop guard. */
export function evaluateTaskConditions(group: TaskConditionGroup | null, context: ConditionContext, emptyResult: boolean): boolean | null {
  if (!group?.conditions.length) return emptyResult;
  const values = group.conditions.map((node) => 'conditions' in node ? evaluateTaskConditions(node, context, emptyResult) : matches(node, context));
  if (group.operator === 'and') return values.includes(false) ? false : values.includes(null) ? null : true;
  return values.includes(true) ? true : values.includes(null) ? null : false;
}

export function nextConditionDay(timezone: string, now: number): string {
  return nextScheduledAt('daily', '00:00', timezone, now);
}
