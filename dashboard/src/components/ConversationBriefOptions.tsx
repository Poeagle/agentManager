import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api,type AgentModelPreference} from '../lib/api';
import {Dialog} from './Dialog';

export function BriefOptions({sessionId,onCancel,onConfirm}:{sessionId:string;onCancel:()=>void;onConfirm:(options:{preference?:AgentModelPreference;environmentId?:string})=>void}) {
 const [environmentId,setEnvironmentId]=useState(''),[modelKey,setModelKey]=useState('');
 const controlsQuery=useQuery({queryKey:['conversation-controls',sessionId],queryFn:()=>api.agent.controls(sessionId),staleTime:300000,retry:false});
 const environmentsQuery=useQuery({queryKey:['session-environments',sessionId],queryFn:()=>api.codexEnvironments.forSession(sessionId),staleTime:30000,retry:false});
 const controls=controlsQuery.data,environments=environmentsQuery.data;
 const catalogFailed=controlsQuery.isError||environmentsQuery.isError;
 const [target,setTarget]=useState<{id:string;result?:Awaited<ReturnType<typeof api.codexEnvironments.sessionPreflight>>;failed?:boolean}>();
 useEffect(()=>{let live=true;if(environmentId)void api.codexEnvironments.sessionPreflight(sessionId,environmentId).then(v=>{if(live)setTarget({id:environmentId,result:v});}).catch(()=>{if(live)setTarget({id:environmentId,failed:true});});return()=>{live=false;};},[sessionId,environmentId]);
 const loading=!!environmentId&&target?.id!==environmentId;
 const models=environmentId?(target?.id===environmentId?target.result?.models||[]:[]):controls?.models?.filter(m=>!m.provider||m.provider===controls?.provider)||[];
 const key=(m:typeof models[number])=>JSON.stringify([m.provider||'',m.model]);
 const selected=models.find(m=>key(m)===modelKey);
 const validTarget=!environmentId||target?.id===environmentId&&!!target.result?.ok;
 return <Dialog title="简要压缩设置" onClose={onCancel}>
  <p className="text-sm">默认使用当前账号和模型。新会话接收整理后的历史。确认新会话可用后，平台会永久删除旧会话记录和 Agent 原始对话文件。</p>
  {catalogFailed&&<p role="status" className="text-xs">部分账号或模型列表暂不可用，仍可使用当前配置。</p>}
  <label className="mt-3 flex items-center gap-2 text-sm">账号<select aria-label="简要压缩账号" value={environmentId} onChange={e=>{setTarget(undefined);setEnvironmentId(e.target.value);setModelKey('');}} className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}}>
   <option value="">当前账号{environments?.environments.find(e=>e.id===environments.current)?.name?`（${environments.environments.find(e=>e.id===environments.current)!.name}）`:''}</option>{environments?.environments.filter(e=>e.id!==environments.current&&e.can_control&&e.enabled).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
  </select></label>
  <label className="mt-3 flex items-center gap-2 text-sm">模型<select aria-label="简要压缩模型" value={modelKey} onChange={e=>setModelKey(e.target.value)} disabled={!!environmentId&&!validTarget||!!controls&&!controls.supports_fresh_model} className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}}>
   <option value="">当前模型{controls?.model?`（${controls.model}）`:''}</option>{models.map(m=><option key={key(m)} value={key(m)}>{m.name}</option>)}
  </select></label>
  {environmentId&&loading&&<p role="status">正在检查目标账号…</p>}
  {environmentId&&target?.id===environmentId&&(target.failed||target.result&&!target.result.ok)&&<p role="alert">目标账号不可用，请检查连接和权限。</p>}
  <footer className="conversation-dialog-actions">
   <button type="button" className="conversation-action-button" onClick={onCancel}>取消</button>
   <button type="button" className="conversation-action-button conversation-action-button--primary conversation-action-button--danger"
    disabled={!validTarget||loading} onClick={()=>onConfirm({...(environmentId?{environmentId}:{}),...(selected?{preference:{model:selected.model,effort:selected.defaultEffort,...selected.provider?{provider:selected.provider}:{}}}:{})})}>开始简要压缩</button>
  </footer>
 </Dialog>;
}
