import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { CodexIcon } from './CliIcons';

const QUOTA_REFRESH_MS = 5_000;

function quotaColor(remaining: number): string {
  if (remaining <= 10) return 'var(--error)';
  if (remaining <= 25) return '#f59e0b';
  return '#7A9DFF';
}

export function CodexQuotaIndicator() {
  const quotaQuery = useQuery({
    queryKey: ['codex-weekly-quota', 'global'],
    queryFn: () => api.codexQuota.read(),
    refetchInterval: QUOTA_REFRESH_MS,
    refetchIntervalInBackground: true,
    staleTime: 0,
    retry: false,
  });
  const quota = quotaQuery.data?.quota;
  const color = quota ? quotaColor(quota.remainingPercent) : 'var(--text-muted)';
  const title = quota
    ? `Codex 周额度剩余 ${quota.remainingPercent}% · 已用 ${quota.usedPercent}% · 每 5 秒刷新`
    : quotaQuery.isError
      ? `Codex 周额度读取失败 · 每 5 秒重试`
      : '正在读取 Codex 周额度';

  return (
    <div
      aria-label={quota ? `Codex 周额度剩余 ${quota.remainingPercent}%` : 'Codex 周额度'}
      title={title}
      className="relative flex h-8 min-w-[74px] items-center gap-2 overflow-hidden rounded-md border px-2.5 sm:min-w-[116px]"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-tertiary)',
        color: 'var(--text-secondary)',
      }}
    >
      <CodexIcon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <div className="min-w-0 leading-none">
        <span className="hidden text-[9px] font-medium sm:block" style={{ color: 'var(--text-muted)' }}>Codex 周额度</span>
        <strong className="font-mono text-[11px] tabular-nums" style={{ color }}>
          {quota ? `${quota.remainingPercent}%` : quotaQuery.isError ? '不可用' : '读取中'}
        </strong>
      </div>
      <span
        aria-hidden="true"
        className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${quotaQuery.isFetching ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        style={{ background: quotaQuery.isError ? 'var(--error)' : color }}
      />
      <span className="absolute inset-x-0 bottom-0 h-px" style={{ background: 'var(--border)' }}>
        <span className="block h-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${quota?.remainingPercent ?? 0}%`, background: color }} />
      </span>
    </div>
  );
}
