import { Plus, X } from 'lucide-react';
import type { ScheduledConditionGroup, ScheduledTaskCondition } from '../lib/api';

type ConditionType = ScheduledTaskCondition['type'];
const fields = 'min-w-0 w-full rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-1';
const fieldStyle = { borderColor: 'var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' };
const options: Array<{ type: ConditionType; label: string; stopOnly?: boolean }> = [
  { type: 'target_idle', label: '标签页运行状态' },
  { type: 'time_after', label: '当前时间不早于' },
  { type: 'time_range', label: '当前时间在时段内' },
  { type: 'weekday', label: '当天日期类型' },
  { type: 'quota_below', label: 'Codex 周额度低于', stopOnly: true },
  { type: 'successes_today', label: '今日成功发送次数达到', stopOnly: true },
  { type: 'failures_today', label: '今日发送失败次数达到', stopOnly: true },
];

function defaultCondition(type: ConditionType, phase: 'start' | 'stop'): ScheduledTaskCondition {
  if (type === 'target_idle') return { type, value: true };
  if (type === 'time_after') return { type, value: phase === 'start' ? '09:00' : '18:00' };
  if (type === 'time_range') return { type, value: { start: '09:00', end: '18:00' } };
  if (type === 'weekday') return { type, value: phase === 'start' ? 'workday' : 'weekend' };
  return { type, value: type === 'quota_below' ? 20 : 3 };
}

export function ScheduleConditionsEditor({ phase, group, onChange, existingTarget, usesCodex, depth = 1, path }: {
  phase: 'start' | 'stop'; group: ScheduledConditionGroup; onChange: (group: ScheduledConditionGroup) => void;
  existingTarget: boolean; usesCodex: boolean; depth?: number; path?: string;
}) {
  const title = path ?? (phase === 'start' ? '每次开始条件' : '每天停止条件');
  const update = (index: number, condition: ScheduledTaskCondition | ScheduledConditionGroup) => onChange({ ...group, conditions: group.conditions.map((item, i) => i === index ? condition : item) });
  const makeCondition = () => defaultCondition(phase === 'start' && existingTarget ? 'target_idle' : 'time_after', phase);
  const add = () => onChange({ ...group, conditions: [...group.conditions, makeCondition()] });
  const addGroup = () => onChange({ ...group, conditions: [...group.conditions, { operator: group.operator === 'and' ? 'or' : 'and', conditions: [makeCondition()] }] });
  return <section aria-label={title} data-phase={phase} data-nested={depth > 1} className="schedule-condition-panel">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">{depth > 1 ? '条件组' : phase === 'start' ? '什么时候发送' : '什么时候当天停止'}</h3>
      <div className="flex items-center gap-2">
        <select aria-label={`${title}组合方式`} value={group.operator} onChange={(event) => onChange({ ...group, operator: event.target.value as 'and' | 'or' })} className="rounded-md border px-2 py-1.5 text-[11px]" style={fieldStyle}>
          <option value="and">全部满足（且）</option><option value="or">任一满足（或）</option>
        </select>
        <button type="button" aria-label={`${title}添加条件`} onClick={add} disabled={group.conditions.length >= 20} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs disabled:opacity-40" style={{ color: 'var(--accent)' }}><Plus className="h-3 w-3" />添加条件</button>
        <button type="button" title="将条件括在一组内，使用不同的且／或规则" aria-label={`${title}添加分组`} onClick={addGroup} disabled={depth >= 4 || group.conditions.length >= 20} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs disabled:opacity-40" style={{ color: 'var(--accent)' }}><Plus className="h-3 w-3" />分组</button>
      </div>
    </div>
    <div className="space-y-2">
      {group.conditions.length === 0 && <p className="py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{phase === 'start' ? '不限制开始条件，按周期执行。' : '不设置当日停止限制。'}</p>}
      {group.conditions.map((condition, index) => {
        const label = `${title} ${index + 1}`;
        if ('conditions' in condition) return <div key={`${index}-group`} className="grid grid-cols-[22px_minmax(0,1fr)_24px] items-start gap-1">
          <span className="rule-connector pt-2">{index === 0 ? '当' : group.operator === 'and' ? '且' : '或'}</span>
          <div className="min-w-0 flex-1"><ScheduleConditionsEditor phase={phase} group={condition} onChange={(value) => update(index, value)} existingTarget={existingTarget} usesCodex={usesCodex} depth={depth + 1} path={`${label}分组`} /></div>
          <button type="button" aria-label={`删除${label}分组`} onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })} className="p-1" style={{ color: 'var(--text-muted)' }}><X className="h-3.5 w-3.5" /></button>
        </div>;
        return <div key={`${index}-${condition.type}`} className="rule-row">
          <span className="rule-connector">{index === 0 ? '当' : group.operator === 'and' ? '且' : '或'}</span>
          <select aria-label={label} value={condition.type} onChange={(event) => update(index, defaultCondition(event.target.value as ConditionType, phase))} className={fields} style={fieldStyle}>
            {options.filter((option) => phase === 'stop' || !option.stopOnly).map((option) => <option key={option.type} value={option.type} disabled={(option.type === 'target_idle' && !existingTarget) || (option.type === 'quota_below' && !usesCodex)}>{option.label}</option>)}
          </select>
          {condition.type === 'time_after' && <input aria-label={`${label}时间`} type="time" value={condition.value} onChange={(event) => update(index, { ...condition, value: event.target.value })} className={fields} style={fieldStyle} />}
          {condition.type === 'time_range' && <div className="flex min-w-0 items-center gap-1"><input aria-label={`${label}开始时间`} type="time" value={condition.value.start} onChange={(event) => update(index, { ...condition, value: { ...condition.value, start: event.target.value } })} className={fields} style={fieldStyle} /><span className="text-[10px]">至</span><input aria-label={`${label}结束时间`} type="time" value={condition.value.end} onChange={(event) => update(index, { ...condition, value: { ...condition.value, end: event.target.value } })} className={fields} style={fieldStyle} /></div>}
          {condition.type === 'weekday' && <select aria-label={`${label}日期类型`} value={condition.value} onChange={(event) => update(index, { ...condition, value: event.target.value as 'workday' | 'weekend' })} className={fields} style={fieldStyle}><option value="workday">工作日（周一至周五）</option><option value="weekend">非工作日（周六、周日）</option></select>}
          {condition.type === 'target_idle' && <select aria-label={`${label}运行状态`} value={String(condition.value)} onChange={(event) => update(index, { ...condition, value: event.target.value === 'true' })} className={fields} style={fieldStyle}><option value="true">没有任务运行（空闲）</option><option value="false">有任务运行（忙碌）</option></select>}
          {(condition.type === 'quota_below' || condition.type === 'successes_today' || condition.type === 'failures_today') && <div className="flex items-center gap-1"><input aria-label={`${label}数值`} type="number" min={1} max={condition.type === 'quota_below' ? 100 : 1_000_000} value={condition.value} onChange={(event) => update(index, { ...condition, value: Number(event.target.value) })} className={fields} style={fieldStyle} /><span className="text-[10px]">{condition.type === 'quota_below' ? '%' : '次'}</span></div>}
          <button type="button" aria-label={`删除${label}`} onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })} className="flex h-7 w-7 items-center justify-center rounded hover:bg-red-500/10" style={{ color: 'var(--text-muted)' }}><X className="h-3.5 w-3.5" /></button>
        </div>;
      })}
    </div>
    {depth === 1 && <p className="rule-help">{phase === 'start' ? '不满足或状态未知时跳过本次，下个周期再检查。' : '满足后仅停止当天发送，次日重判，不关闭标签页。'}</p>}
  </section>;
}
