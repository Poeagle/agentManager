import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';
import type {AgentDescriptor} from '../lib/agents';
import {AgentQuotaIndicator} from './AgentQuotaIndicator';

export function CodexAccountQuotaIndicators({agent}:{agent:AgentDescriptor}) {
  const accounts=useQuery({queryKey:['codex-environments'],queryFn:api.codexEnvironments.list,staleTime:30000,refetchInterval:300000,retry:false});
  return <>{accounts.data?.environments.filter(account=>account.kind==='account'&&account.enabled).map(account=><AgentQuotaIndicator
    key={account.id} agent={agent} label={`${agent.label} · ${account.name}`}
    queryKey={['agent-weekly-quota',agent.id,account.id]}
    read={()=>api.codexEnvironments.quota(account.id)}
  />)}</>;
}
