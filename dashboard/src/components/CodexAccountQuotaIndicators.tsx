import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';
import type {AgentDescriptor} from '../lib/agents';
import {AgentQuotaIndicator} from './AgentQuotaIndicator';
import {useState} from 'react';
import {CodexAccountInsights} from './CodexAccountInsights';

export function CodexAccountQuotaIndicators({agent}:{agent:AgentDescriptor}) {
  const [selected,setSelected]=useState<{id:string;name:string}|null>(null);
  const accounts=useQuery({queryKey:['codex-environments'],queryFn:api.codexEnvironments.list,staleTime:30000,refetchInterval:300000,retry:false});
  return <>{accounts.data?.environments.filter(account=>(account.kind==='account'||account.kind==='native')&&account.enabled).map(account=><AgentQuotaIndicator
    key={account.id} agent={agent} hideWhenNotApplicable={account.kind==='native'} label={`${agent.label} · ${account.name}`}
    queryKey={['agent-weekly-quota',agent.id,account.id]}
    read={()=>api.codexEnvironments.quota(account.id)}
    onOpen={()=>setSelected(account)}
  />)}{selected&&<CodexAccountInsights id={selected.id} name={selected.name} onClose={()=>setSelected(null)}/>}</>;
}
