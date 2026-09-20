import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { CodexIcon } from './CliIcons';

const QUOTA_REFRESH_MS = 5 * 60_000;

function quotaColor(remaining: number): string {
  if (remaining <= 10) return 'var(--error)';
  if (remaining <= 25) return '#f59e0b';
  return '#7A9DFF';
}

function formatCheckedTime(value: string): string {
  const checkedAt = new Date(value);
  if (Number.isNaN(checkedAt.getTime())) return '--:--:--';
  return [checkedAt.getHours(), checkedAt.getMinutes(), checkedAt.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
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
  const checkedTime = quota ? formatCheckedTime(quota.checkedAt) : '--:--:--';
  const color = quota ? quotaColor(quota.remainingPercent) : 'var(--text-muted)';
  const title = quota
    ? `Codex 周额度剩余 ${quota.remainingPercent}% · 已用 ${quota.usedPercent}% · 检测时间 ${new Date(quota.checkedAt).toLocaleString()} · 每 5 分钟刷新`
    : quotaQuery.isError
      ? `Codex 周额度读取失败 · 每 5 分钟重试`
      : '正在读取 Codex 周额度';

  return (
    <div
      aria-label={quota ? `Codex 周额度剩余 ${quota.remainingPercent}%` : 'Codex 周额度'}
      title={title}
      className="relative flex h-7 items-center gap-1.5 overflow-hidden rounded-md border px-2.5"
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
      <span aria-hidden="true" className="text-[9px]" style={{ color: 'var(--border)' }}>·</span>
      <time className="whitespace-nowrap font-mono text-[9px] tabular-nums" dateTime={quota?.checkedAt} style={{ color: 'var(--text-muted)' }}>
        {quota?.stale ? '上次成功' : '检测'} {checkedTime}
      </time>
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${quotaQuery.isFetching ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        style={{ background: quotaQuery.isError ? 'var(--error)' : color }}
      />
      <button type="button" aria-label="刷新 Codex 额度" title="刷新额度"
        disabled={refresh.isPending || quotaQuery.isFetching}
        onClick={() => refresh.mutate()}
        className="text-[10px] hover:opacity-75 disabled:opacity-40"
      >刷新</button>
      {refresh.isError && <span role="status" className="text-[10px]">刷新失败</span>}
      <span className="absolute inset-x-0 bottom-0 h-px" style={{ background: 'var(--border)' }}>
        <span className="block h-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${quota?.remainingPercent ?? 0}%`, background: color }} />
      </span>
    </div>
  );
}
