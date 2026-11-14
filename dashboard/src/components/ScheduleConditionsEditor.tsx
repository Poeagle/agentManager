import {ConditionGroupEditor} from './ConditionGroupEditor';
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
  return <ConditionGroupEditor phase={phase} group={group} onChange={onChange} depth={depth} title={title} heading={phase==='start'?'什么时候发送':'什么时候当天停止'}
    makeCondition={()=>defaultCondition(phase==='start'&&existingTarget?'target_idle':'time_after',phase)}
    emptyText={phase==='start'?'不限制开始条件，按周期执行。':'不设置当日停止限制。'} help={phase==='start'?'不满足或状态未知时跳过本次，下个周期再检查。':'满足后仅停止当天发送，次日重判，不关闭标签页。'}
    renderCondition={(condition,change,label)=><>
          <select aria-label={label} value={condition.type} onChange={(event) => change( defaultCondition(event.target.value as ConditionType, phase))} className={fields} style={fieldStyle}>
            {options.filter((option) => phase === 'stop' || !option.stopOnly).map((option) => <option key={option.type} value={option.type} disabled={(option.type === 'target_idle' && !existingTarget) || (option.type === 'quota_below' && !usesCodex)}>{option.label}</option>)}
          </select>
          {condition.type === 'time_after' && <input aria-label={`${label}时间`} type="time" value={condition.value} onChange={(event) => change( { ...condition, value: event.target.value })} className={fields} style={fieldStyle} />}
          {condition.type === 'time_range' && <div className="flex min-w-0 items-center gap-1"><input aria-label={`${label}开始时间`} type="time" value={condition.value.start} onChange={(event) => change( { ...condition, value: { ...condition.value, start: event.target.value } })} className={fields} style={fieldStyle} /><span className="text-[10px]">至</span><input aria-label={`${label}结束时间`} type="time" value={condition.value.end} onChange={(event) => change( { ...condition, value: { ...condition.value, end: event.target.value } })} className={fields} style={fieldStyle} /></div>}
          {condition.type === 'weekday' && <select aria-label={`${label}日期类型`} value={condition.value} onChange={(event) => change( { ...condition, value: event.target.value as 'workday' | 'weekend' })} className={fields} style={fieldStyle}><option value="workday">工作日（周一至周五）</option><option value="weekend">非工作日（周六、周日）</option></select>}
          {condition.type === 'target_idle' && <select aria-label={`${label}运行状态`} value={String(condition.value)} onChange={(event) => change( { ...condition, value: event.target.value === 'true' })} className={fields} style={fieldStyle}><option value="true">没有任务运行（空闲）</option><option value="false">有任务运行（忙碌）</option></select>}
          {(condition.type === 'quota_below' || condition.type === 'successes_today' || condition.type === 'failures_today') && <div className="flex items-center gap-1"><input aria-label={`${label}数值`} type="number" min={1} max={condition.type === 'quota_below' ? 100 : 1_000_000} value={condition.value} onChange={(event) => change( { ...condition, value: Number(event.target.value) })} className={fields} style={fieldStyle} /><span className="text-[10px]">{condition.type === 'quota_below' ? '%' : '次'}</span></div>}
    </>}/>;
}
