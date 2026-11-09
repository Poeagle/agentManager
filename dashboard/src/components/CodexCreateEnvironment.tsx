import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api,type EnvironmentCheck} from '../lib/api';
import {EnvironmentChecks} from './CodexEnvironmentPanel';
export function CodexCreateEnvironment({projectId,onChange,onReady}:{projectId:string;onChange:(id:string|undefined)=>void;onReady:(ready:boolean)=>void}) {
 const query=useQuery({queryKey:['codex-environments'],queryFn:()=>api.codexEnvironments.list(),retry:false});
 const [chosen,setChosen]=useState(''),[checking,setChecking]=useState(false),[checks,setChecks]=useState<EnvironmentCheck[]>([]),[error,setError]=useState('');
 const selected=chosen||query.data?.environments.find(e=>e.enabled)?.id||'';
 useEffect(()=>{onChange(selected||undefined);onReady(!!selected&&!query.isError);},[selected,query.isError,onChange,onReady]);
 async function check(){setChecking(true);setChecks([]);setError('');try{const result=await api.codexEnvironments.preflight(selected,projectId);setChecks(result.checks);}catch(e){setError(e instanceof Error?e.message:'预检失败');}finally{setChecking(false);}}
 return <div className="mt-3 space-y-2"><label>Codex 账号 / 接入<select aria-label="新标签页 Codex 环境" value={selected} disabled={checking||query.isPending} onChange={e=>{setChosen(e.target.value);setChecks([]);setError('');}}>{query.data?.environments.map(e=><option key={e.id} value={e.id} disabled={!e.enabled}>{e.name}</option>)}</select></label>
  {query.isPending&&<p>读取可用账号…</p>}{query.isError&&<p role="alert">读取 Codex 环境失败，请刷新后重试。</p>}{query.isSuccess&&!selected&&<p role="alert">你没有可使用的 Codex 环境，请联系管理员授权。</p>}
  <button type="button" disabled={!selected||checking} onClick={()=>void check()}>{checking?'正在预检…':'预检账号、模型和项目权限'}</button>
  {checks.length>0&&<EnvironmentChecks checks={checks}/>} {error&&<p role="alert">{error}</p>}
 </div>;
}
