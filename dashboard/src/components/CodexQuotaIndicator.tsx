import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { CodexIcon } from './CliIcons';

const QUOTA_REFRESH_MS = 5 * 60_000;

function quotaColor(remaining: number): string {
  if (remaining <= 10) return 'var(--error)';
  if (remaining <= 25) return '#f59e0b';
  return '#7A9DFF';
}

function formatResetTime(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // The quota API supplies Unix seconds, not milliseconds.
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return `周额度重置时间（本地时间）：${date.toLocaleString(undefined, { timeZoneName: 'short' })}`;
}

export function CodexQuotaIndicator() {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.codexQuota.read(true),
    onSuccess: (data) => queryClient.setQueryData(['codex-weekly-quota', 'global'], data),
  });
  const quotaQuery = useQuery({
    queryKey: ['codex-weekly-quota', 'global'],
    queryFn: () => api.codexQuota.read(),
    refetchInterval: QUOTA_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: QUOTA_REFRESH_MS,
    retry: false,
  });
  const quota = quotaQuery.data?.quota;
  const resetTitle = formatResetTime(quota?.resetsAt) ?? '周额度重置时间未知';
  const refreshFailed = refresh.isError || quotaQuery.isError || !!quota?.stale;
  const color = quota ? quotaColor(quota.remainingPercent) : 'var(--text-muted)';
  const title = quota
    ? [`Codex 周额度剩余 ${quota.remainingPercent}% · 已用 ${quota.usedPercent}%`, resetTitle,
      `${quota.stale ? '上次成功检测时间' : '检测时间'} ${new Date(quota.checkedAt).toLocaleString()}`,
      '每 5 分钟刷新', ...(refreshFailed ? ['刷新失败，显示上次成功数据'] : [])].join('\n')
    : quotaQuery.isError
      ? `Codex 周额度读取失败 · 每 5 分钟重试`
      : '正在读取 Codex 周额度';

  return (
    <div
      aria-label={quota ? `Codex 周额度剩余 ${quota.remainingPercent}%` : 'Codex 周额度'}
      title={title}
      className="relative flex h-7 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-tertiary)',
        color: 'var(--text-secondary)',
      }}
    >
      <CodexIcon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Codex</span>
      <strong className="font-mono text-[11px] tabular-nums" style={{ color }}>
        {quota ? `${quota.remainingPercent}%` : quotaQuery.isError ? '不可用' : '读取中'}
      </strong>
      <button type="button" aria-label="刷新 Codex 额度" title="刷新额度"
        disabled={refresh.isPending || quotaQuery.isFetching}
        onClick={() => refresh.mutate()}
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:opacity-75 disabled:opacity-40"
        style={{ color: refreshFailed ? 'var(--error)' : 'var(--text-muted)' }}
      >
        <RefreshCw aria-hidden="true" className={`h-3 w-3 ${refresh.isPending || quotaQuery.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      </button>
      {refreshFailed && <span role="status" className="sr-only">刷新失败</span>}
      <span className="absolute inset-x-0 bottom-0 h-px" style={{ background: 'var(--border)' }}>
        <span className="block h-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${quota?.remainingPercent ?? 0}%`, background: color }} />
      </span>
    </div>
  );
}
