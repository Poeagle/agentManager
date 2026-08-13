import { describe, expect, it } from 'vitest';
import { nextScheduledAt, validateSchedule } from '../src/services/schedule.js';

describe('scheduled task recurrence', () => {
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
