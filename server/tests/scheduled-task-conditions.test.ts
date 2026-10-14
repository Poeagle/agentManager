import { describe, expect, it } from 'vitest';
import { evaluateTaskConditions, flattenTaskConditions, localDateKey, nextConditionDay, validateTaskConditions, type ConditionContext, type TaskConditionGroup } from '../src/services/scheduled-task-conditions.js';

const context: ConditionContext = {
  now: Date.parse('2026-10-13T02:00:00Z'), timezone: 'Asia/Shanghai', targetIdle: true,
  quotaRemaining: 65, successesToday: 2, failuresToday: 0,
};
const mixed: TaskConditionGroup = { operator: 'and', conditions: [
  { type: 'target_idle', value: true },
  { operator: 'or', conditions: [{ type: 'weekday', value: 'workday' }, { type: 'time_after', value: '16:00' }] },
] };

describe('scheduled condition groups', () => {
  it('supports mixed AND/OR and nested parenthesized groups', () => {
    validateTaskConditions(mixed, context.timezone, 'start', true);
    expect(evaluateTaskConditions(mixed, context, true)).toBe(true);
    expect(evaluateTaskConditions(mixed, { ...context, targetIdle: false }, true)).toBe(false);
    expect(evaluateTaskConditions(mixed, { ...context, now: Date.parse('2026-10-17T02:00:00Z') }, true)).toBe(false);
    expect(evaluateTaskConditions(mixed, { ...context, now: Date.parse('2026-10-17T09:00:00Z') }, true)).toBe(true);
    expect(flattenTaskConditions(mixed).map((item) => item.type)).toEqual(['target_idle', 'weekday', 'time_after']);
  });

  it('does not infer unknown terminal/CLI state or stale quota', () => {
    expect(evaluateTaskConditions(mixed, { ...context, targetIdle: null }, true)).toBeNull();
    const stop: TaskConditionGroup = { operator: 'or', conditions: [
      { type: 'quota_below', value: 20 }, { type: 'time_after', value: '18:00' },
    ] };
    expect(evaluateTaskConditions(stop, { ...context, quotaRemaining: null }, false)).toBeNull();
    expect(evaluateTaskConditions(stop, { ...context, quotaRemaining: null, now: Date.parse('2026-10-13T10:00:00Z') }, false)).toBe(true);
    expect(evaluateTaskConditions({ operator: 'and', conditions: stop.conditions }, { ...context, quotaRemaining: null }, false)).toBe(false);
  });

  it('uses start-inclusive, end-exclusive time windows including overnight', () => {
    const range: TaskConditionGroup = { operator: 'and', conditions: [{ type: 'time_range', value: { start: '22:00', end: '06:00' } }] };
    for (const [clock, expected] of [['14:00', true], ['21:59', true], ['22:00', false], ['13:59', false]] as const) {
      expect(evaluateTaskConditions(range, { ...context, now: Date.parse(`2026-10-13T${clock}:00Z`) }, true)).toBe(expected);
    }
  });

  it('uses local dates for daily counters and resumes at local midnight', () => {
    expect(localDateKey(Date.parse('2026-10-13T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-14');
    expect(nextConditionDay('Asia/Shanghai', context.now)).toBe('2026-10-13T16:00:00.000Z');
    expect(evaluateTaskConditions({ operator: 'or', conditions: [{ type: 'successes_today', value: 2 }] }, context, false)).toBe(true);
    expect(evaluateTaskConditions({ operator: 'and', conditions: [] }, context, true)).toBe(true);
    expect(evaluateTaskConditions(null, context, false)).toBe(false);
  });

  it('rejects invalid types, unsupported target conditions and empty/deep groups', () => {
    const validate = (raw: unknown, phase: 'start' | 'stop' = 'start', existing = true) => validateTaskConditions(raw, context.timezone, phase, existing);
    expect(() => validate({ operator: 'and', conditions: [{ operator: 'or', conditions: [] }] })).toThrow('不能为空');
    expect(() => validate(mixed, 'start', false)).toThrow('现有标签页');
    expect(() => validate({ operator: 'and', conditions: [{ type: 'quota_below', value: 20 }] })).toThrow('每天停止');
    expect(() => validate({ operator: 'and', conditions: [{ type: 'time_after', value: '24:00' }] })).toThrow();
    expect(() => validate({ operator: 'and', conditions: [{ type: 'weekday', value: 'holiday' }] })).toThrow();
    let deep: TaskConditionGroup = mixed;
    for (let i = 0; i < 4; i++) deep = { operator: 'and', conditions: [deep] };
    expect(() => validate(deep)).toThrow('4 层');
    expect(() => validate({ operator: 'and', conditions: [{ type: 'quota_below', value: 0 }] }, 'stop')).toThrow('1–100');
  });
});
