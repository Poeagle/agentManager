import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {api,type AgentQuotaResponse} from '../lib/api';
import {builtinAgentDescriptors,type AgentDescriptor} from '../lib/agents';
import {CodexAccountQuotaIndicators} from './CodexAccountQuotaIndicators';
import {AgentIcon} from './AgentIcon';

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

export function AgentQuotaIndicator({agent,read,label=agent.label,hideWhenNotApplicable=false,queryKey=['agent-weekly-quota',agent.id,'global']}:{agent:AgentDescriptor;label?:string;hideWhenNotApplicable?:boolean;read?:(force?:boolean)=>Promise<AgentQuotaResponse>;queryKey?:string[]}) {
  const readQuota=read??((force=false)=>api.agentQuota.read(agent.id,force));
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => readQuota(true),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  const quotaQuery = useQuery({
    queryKey: queryKey,
    queryFn: () => readQuota(),
    refetchInterval: QUOTA_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: QUOTA_REFRESH_MS,
    retry: false,
  });
  const quota = quotaQuery.data?.quota;
  const notApplicable = quotaQuery.data?.reason === 'not_applicable';
  const resetTitle = formatResetTime(quota?.resetsAt) ?? '周额度重置时间未知';
  const refreshFailed = refresh.isError || quotaQuery.isError || !!quota?.stale;
  const color = quota ? quotaColor(quota.remainingPercent) : 'var(--text-muted)';
  const title = quota
    ? [`${label} 周额度剩余 ${quota.remainingPercent}% · 已用 ${quota.usedPercent}%`, resetTitle,
      `${quota.stale ? '上次成功检测时间' : '检测时间'} ${new Date(quota.checkedAt).toLocaleString()}`,
      '每 5 分钟刷新', ...(refreshFailed ? ['刷新失败，显示上次成功数据'] : [])].join('\n')
    : notApplicable ? (quotaQuery.data?.message ?? '当前认证方式不提供账号额度') : quotaQuery.isError
      ? `${label} 周额度读取失败 · 每 5 分钟重试`
      : `正在读取 ${label} 周额度`;

  if (hideWhenNotApplicable && notApplicable && !quota) return null;

  return (
    <div
      aria-label={quota ? `${label} 周额度剩余 ${quota.remainingPercent}%` : `${label} 周额度`}
      title={title}
      className="workspace-indicator workspace-quota relative flex h-6 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded border px-1.5"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg-tertiary)',
        color: 'var(--text-secondary)',
      }}
    >
      <AgentIcon session={{agent}} className="h-3.5 w-3.5 shrink-0"/>
      <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <strong className="font-mono text-[11px] tabular-nums" style={{ color }}>
        {quota ? `${quota.remainingPercent}%` : notApplicable ? '不适用' : quotaQuery.isError ? '不可用' : '读取中'}
      </strong>
      <button type="button" aria-label={`刷新 ${label} 额度`} title="刷新额度"
        disabled={refresh.isPending || quotaQuery.isFetching}
        onClick={() => refresh.mutate()}
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:opacity-75 disabled:opacity-40"
        style={{ color: refreshFailed ? 'var(--error)' : 'var(--text-muted)' }}
      >
        <RefreshCw aria-hidden="true" className={`h-3 w-3 ${refresh.isPending || quotaQuery.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />
      </button>
      {refreshFailed && <span role="status" className="sr-only">刷新失败</span>}
      <span aria-hidden="true" className="workspace-quota-progress absolute inset-x-0 bottom-0 h-px" style={{ background: 'var(--border)' }}>
        <span className="block h-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${quota?.remainingPercent ?? 0}%`, background: color }} />
      </span>
    </div>
  );
}

export function AgentQuotaIndicators({agents}:{agents?:AgentDescriptor[]}){return <>{(agents??builtinAgentDescriptors()).filter(agent=>agent.capabilities.quota).map(agent=>agent.id==='codex'?<CodexAccountQuotaIndicators key={agent.id} agent={agent}/>:<AgentQuotaIndicator key={agent.id} agent={agent}/>)}</>;}
