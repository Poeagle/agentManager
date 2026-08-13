import { describe, expect, it } from 'vitest';
import { codexWeeklyQuotaFromResponse } from '../src/services/codex-quota.js';

describe('Codex weekly quota parsing', () => {
  it('selects the seven-day window and converts used percentage to remaining percentage', () => {
    const quota = codexWeeklyQuotaFromResponse({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          planType: 'pro',
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 },
          secondary: { usedPercent: 36, windowDurationMins: 10_080, resetsAt: 200 },
        },
      },
    }, '2026-08-13T10:00:00.000Z');

    expect(quota).toEqual({
      usedPercent: 36,
      remainingPercent: 64,
      windowDurationMins: 10_080,
      resetsAt: 200,
      planType: 'pro',
      checkedAt: '2026-08-13T10:00:00.000Z',
    });
  });

  it('fails closed when Codex does not provide a weekly-sized window', () => {
    expect(() => codexWeeklyQuotaFromResponse({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 } },
    })).toThrow(/周额度窗口/);
  });
});
