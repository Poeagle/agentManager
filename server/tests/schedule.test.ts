import { describe, expect, it } from 'vitest';
import { isWithinDailyWindow, nextScheduledAt, validateDailyWindow, validateSchedule } from '../src/services/schedule.js';

describe('scheduled task recurrence', () => {
  const window = { daily_start_time: '09:00', daily_end_time: '18:00' };
  it('anchors interval times to the daily start rather than drifting from save or tick time', () => {
    const next = (from: string) => nextScheduledAt('interval', '30', 'Asia/Taipei', Date.parse(from), window);
    expect(next('2026-10-13T00:10:15Z')).toBe('2026-10-13T01:00:00.000Z');
    expect(next('2026-10-13T01:00:15Z')).toBe('2026-10-13T01:30:00.000Z');
    expect(next('2026-10-13T09:30:15Z')).toBe('2026-10-14T01:00:00.000Z');
    expect(next('2026-10-13T10:00:00Z')).toBe('2026-10-14T01:00:00.000Z');
    expect(isWithinDailyWindow(window, 'Asia/Taipei', Date.parse('2026-10-13T01:00:00Z'))).toBe(true);
    expect(isWithinDailyWindow(window, 'Asia/Taipei', Date.parse('2026-10-13T10:00:00Z'))).toBe(false);
  });

  it('supports cross-midnight windows and intervals longer than a window', () => {
    const overnight = { daily_start_time: '22:00', daily_end_time: '02:00' };
    expect(nextScheduledAt('interval', '90', 'UTC', Date.parse('2026-10-13T23:30:15Z'), overnight)).toBe('2026-10-14T01:00:00.000Z');
    expect(nextScheduledAt('interval', '90', 'UTC', Date.parse('2026-10-14T01:00:15Z'), overnight)).toBe('2026-10-14T22:00:00.000Z');
    expect(isWithinDailyWindow(overnight, 'UTC', Date.parse('2026-10-14T01:59:59Z'))).toBe(true);
    expect(isWithinDailyWindow(overnight, 'UTC', Date.parse('2026-10-14T02:00:00Z'))).toBe(false);
    expect(nextScheduledAt('interval', '1000', 'UTC', Date.parse('2026-10-13T09:00:01Z'), window)).toBe('2026-10-14T09:00:00.000Z');
  });

  it('uses the selected timezone across DST changes', () => {
    expect(nextScheduledAt('interval', '30', 'America/New_York', Date.parse('2026-03-07T23:00:00Z'), window)).toBe('2026-03-08T13:00:00.000Z');
    expect(nextScheduledAt('interval', '30', 'America/New_York', Date.parse('2026-10-31T22:00:00Z'), window)).toBe('2026-11-01T14:00:00.000Z');
  });

  it('rejects incomplete, equal, malformed and incompatible windows', () => {
    expect(() => validateDailyWindow('interval', { daily_start_time: '09:00' })).toThrow(/同时设置/);
    expect(() => validateDailyWindow('interval', { daily_start_time: '09:00', daily_end_time: '09:00' })).toThrow(/不能相同/);
    expect(() => validateDailyWindow('interval', { daily_start_time: '25:00', daily_end_time: '18:00' })).toThrow(/HH:mm/);
    expect(() => validateDailyWindow('daily', window)).toThrow(/仅适用于/);
  });
  it('calculates intervals without depending on a browser timezone', () => {
    expect(nextScheduledAt('interval', '15', 'Asia/Taipei', Date.parse('2026-08-13T00:00:00Z')))
      .toBe('2026-08-13T00:15:00.000Z');
  });

  it('calculates daily and weekly wall-clock times in the selected timezone', () => {
    expect(nextScheduledAt('daily', '09:30', 'Asia/Taipei', Date.parse('2026-08-13T00:00:00Z')))
      .toBe('2026-08-13T01:30:00.000Z');
    // 2026-08-13 is Thursday (4); the next Monday at 09:00 Taipei time.
    expect(nextScheduledAt('weekly', '1@09:00', 'Asia/Taipei', Date.parse('2026-08-13T02:00:00Z')))
      .toBe('2026-08-17T01:00:00.000Z');
  });

  it('supports five-field cron lists, ranges, and steps', () => {
    expect(nextScheduledAt('cron', '*/15 9-10 * * 1-5', 'UTC', Date.parse('2026-08-13T08:59:30Z')))
      .toBe('2026-08-13T09:00:00.000Z');
    expect(() => validateSchedule('cron', 'not cron', 'UTC')).toThrow(/5 个字段/);
    expect(() => validateSchedule('daily', '25:00', 'UTC')).toThrow(/HH:mm/);
    expect(() => validateSchedule('interval', '0', 'UTC')).toThrow(/1–525600/);
  });
});
