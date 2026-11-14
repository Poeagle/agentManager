import {AgentQuotaNotApplicable} from '../quota-response.js';

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

export interface CodexWeeklyQuota {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
  planType: string | null;
  checkedAt: string;
  stale?: boolean;
}

function chooseWeeklyWindow(snapshot: RateLimitSnapshot): RateLimitWindow {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow => !!window && Number.isFinite(window.usedPercent));
  const exact = windows.find((window) => window.windowDurationMins === 10_080);
  if (exact) return exact;
  const longest = windows
    .filter((window) => (window.windowDurationMins ?? 0) >= 6 * 24 * 60)
    .sort((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0))[0];
  if (!longest) throw new Error('Codex 未返回周额度窗口');
  return longest;
}

export function codexWeeklyQuotaFromResponse(result: any, checkedAt = new Date().toISOString()): CodexWeeklyQuota {
  const snapshot = (result?.rateLimitsByLimitId?.codex ?? result?.rateLimits) as RateLimitSnapshot | undefined;
  if (!snapshot) throw new Error('Codex 未返回额度信息');
  const weekly = chooseWeeklyWindow(snapshot);
  const usedPercent = Math.max(0, Math.min(100, Math.round(weekly.usedPercent)));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: weekly.windowDurationMins!,
    resetsAt: weekly.resetsAt,
    planType: snapshot.planType ?? null,
    checkedAt,
  };
}

/** Every consumer reads the scheduler's persisted snapshot. Even an explicit
 * UI refresh must never create another upstream request. */
export async function readCodexWeeklyQuota(_options?: { force?: boolean }): Promise<CodexWeeklyQuota> {
  const {cachedAccountStatus}=await import('./account-status.js');
  const {currentCodexEngine}=await import('./engine-context.js');
  const status=cachedAccountStatus(currentCodexEngine().environmentId??'native');
  if(status.reason==='not_applicable')throw new AgentQuotaNotApplicable();
  if(!status.quota)throw new Error('后台尚未取得周额度采样');
  return status.quota;
}
