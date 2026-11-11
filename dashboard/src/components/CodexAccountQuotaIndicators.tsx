import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';
import type {AgentDescriptor} from '../lib/agents';
import {AgentQuotaIndicator} from './AgentQuotaIndicator';
import {useState} from 'react';
import {CodexAccountInsights} from './CodexAccountInsights';
import {CodexEngineBalanceGroup,CodexEngineBalanceIndicator} from './CodexEngineBalance';

export function CodexAccountQuotaIndicators({agent,isAdmin=false}:{agent:AgentDescriptor;isAdmin?:boolean}) {
  const [selected,setSelected]=useState<{id:string;name:string}|null>(null);
  const accounts=useQuery({queryKey:['codex-environments'],queryFn:api.codexEnvironments.list,staleTime:30000,refetchInterval:query=>query.state.data?.environments.some(e=>e.enabled&&!e.auth_mode)?10000:300000,retry:false});
  const groups=new Map<string,NonNullable<typeof accounts.data>['environments']>();
  for(const e of accounts.data?.environments||[]){if(e.enabled&&e.auth_mode==='api'){const key=e.balance_group||e.id;groups.set(key,[...groups.get(key)||[],e]);}}
  return <>{accounts.data?.environments.filter(e=>e.enabled&&!e.auth_mode).map(e=><span key={e.id} className="workspace-indicator workspace-engine-chip workspace-quota flex h-6 shrink-0 items-center gap-1 rounded border px-1.5">codex · {e.name} · 认证待检测</span>)}{[...groups.entries()].map(([key,members])=>isAdmin?members[0].balance_group?<CodexEngineBalanceGroup key={key} group={key} members={members}/>:<CodexEngineBalanceIndicator key={key} id={members[0].id} name={members[0].name}/>:<span key={key} className="workspace-indicator workspace-engine-chip workspace-quota flex h-6 shrink-0 items-center gap-1 rounded border px-1.5" title="余额仅管理员可查看">codex · {members[0].name} · API</span>)}{accounts.data?.environments.filter(account=>account.auth_mode==='account'&&account.enabled).map(account=><AgentQuotaIndicator
    key={account.id} agent={agent} hideWhenNotApplicable={account.kind==='native'} label={`codex · ${account.name}`}
    queryKey={['agent-weekly-quota',agent.id,account.id]}
    read={()=>api.codexEnvironments.quota(account.id)}
    canRefresh={isAdmin} display="engine-chip"
    onOpen={isAdmin?()=>setSelected(account):undefined}
  />)}{isAdmin&&selected&&<CodexAccountInsights id={selected.id} name={selected.name} onClose={()=>setSelected(null)}/>}</>;
}
