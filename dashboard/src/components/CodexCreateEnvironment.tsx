import {useEffect,useState} from 'react';
import {ChevronDown, Loader2, ShieldCheck} from 'lucide-react';
import {useQuery} from '@tanstack/react-query';
import {api,type EnvironmentCheck} from '../lib/api';
import {EnvironmentChecks} from './CodexEnvironmentPanel';
export function CodexCreateEnvironment({projectId,onChange,onReady}:{projectId:string;onChange:(id:string|undefined)=>void;onReady:(ready:boolean)=>void}) {
 const query=useQuery({queryKey:['codex-environments'],queryFn:()=>api.codexEnvironments.list(),retry:false});
 const [chosen,setChosen]=useState(''),[checking,setChecking]=useState(false),[checks,setChecks]=useState<EnvironmentCheck[]>([]),[error,setError]=useState('');
 const selected=chosen||query.data?.environments.find(e=>e.enabled)?.id||'';
 useEffect(()=>{onChange(selected||undefined);onReady(!!selected&&!query.isError);},[selected,query.isError,onChange,onReady]);
 async function check(){setChecking(true);setChecks([]);setError('');try{const result=await api.codexEnvironments.preflight(selected,projectId);setChecks(result.checks);}catch(e){setError(e instanceof Error?e.message:'预检失败');}finally{setChecking(false);}}
 return <div className="project-open-environment">
  <label className="project-open-environment-label" htmlFor="project-open-environment">Codex 账号 / 接入</label>
  <div className="project-open-environment-controls"><div className="project-open-select-wrap"><select id="project-open-environment" aria-label="新标签页 Codex 环境" value={selected} disabled={checking||query.isPending} onChange={e=>{setChosen(e.target.value);setChecks([]);setError('');}}>{!selected&&<option value="">{query.isPending?'读取可用账号…':'暂无可用账号'}</option>}{query.data?.environments.map(e=><option key={e.id} value={e.id} disabled={!e.enabled}>{e.name}</option>)}</select><ChevronDown size={15} aria-hidden="true"/></div>
  <button className="project-open-preflight" type="button" disabled={!selected||checking} onClick={()=>void check()}>{checking?<Loader2 size={14} className="animate-spin"/>:<ShieldCheck size={14}/>} {checking?'正在预检…':'预检'}</button></div>
  {query.isError&&<p role="alert" className="project-open-error">读取 Codex 环境失败，请刷新后重试。</p>}{query.isSuccess&&!selected&&<p role="alert" className="project-open-error">你没有可使用的 Codex 环境，请联系管理员授权。</p>}
  <p className="project-open-hint">预检账号、模型和项目权限</p>
  {checks.length>0&&<EnvironmentChecks checks={checks}/>} {error&&<p role="alert" className="project-open-error">{error}</p>}
 </div>;
}
