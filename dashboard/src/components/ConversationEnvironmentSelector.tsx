import {ChevronDown} from 'lucide-react';
import {useEffect,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api,type EnvironmentCheck,type ConversationControlsData} from '../lib/api';
import {Dialog} from './Dialog';
import {EnvironmentChecks} from './CodexEnvironmentPanel';
type Model=ConversationControlsData['models'][number];
export function ConversationEnvironmentSelector({sessionId,busy,onTransferred,requested,onRequestHandled}:{sessionId:string;busy:boolean;onTransferred?:()=>void;requested?:{provider:string;model:string;effort:string};onRequestHandled?:()=>void}) {
 const client=useQueryClient();const query=useQuery({queryKey:['session-environments',sessionId],queryFn:()=>api.codexEnvironments.forSession(sessionId),retry:false,staleTime:30000});
 const [target,setTarget]=useState(''),[models,setModels]=useState<Model[]>([]),[selection,setSelection]=useState(''),[effort,setEffort]=useState(''),[checks,setChecks]=useState<EnvironmentCheck[]>([]),[working,setWorking]=useState(false),[error,setError]=useState('');
 const modelKey=(m:Model)=>JSON.stringify([m.provider||'',m.model]);const model=models.find(m=>modelKey(m)===selection);
 useEffect(()=>{if(!requested||!query.data)return;const destination=query.data.environments.find(e=>e.kind==='provider'&&e.provider===requested.provider)||query.data.environments.find(e=>e.kind==='native');if(!destination||!destination.can_control){setError('目标模型服务尚未授权，请联系管理员');return;}setTarget(destination.id);setModels([]);setSelection('');setChecks([]);setError('');},[requested,query.data]);
 const close=()=>{setTarget('');onRequestHandled?.();};
 async function preflight(){setWorking(true);setError('');setModels([]);setChecks([]);try{const r=await api.codexEnvironments.sessionPreflight(sessionId,target);setChecks(r.checks);if(r.ok){setModels(r.models||[]);const m=requested?r.models?.find(m=>m.model===requested.model&&m.provider===requested.provider):r.models?.[0];setSelection(m?modelKey(m):'');setEffort(m&&requested&&m.efforts.some(e=>e.value===requested.effort)?requested.effort:m?.defaultEffort||'');if(!m)setError('目标环境没有所选模型，请重新选择');}}catch(e){setError(e instanceof Error?e.message:'预检失败');}finally{setWorking(false);}}
 async function transfer(){if(!model)return;let draft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{draft ||= value;}}}));if(draft){setError('原始终端还有未发送内容，请先发送或清空。');return;}setWorking(true);setError('');try{await api.codexEnvironments.transfer(sessionId,{environment_id:target,model:model.model,effort,...model.provider?{provider:model.provider}:{}});close();await Promise.all([client.invalidateQueries({queryKey:['sessions']}),client.invalidateQueries({queryKey:['conversation-controls',sessionId]}),client.invalidateQueries({queryKey:['session-environments',sessionId]}),client.invalidateQueries({queryKey:['conversation',sessionId]}),client.invalidateQueries({queryKey:['project-sessions']})]);window.dispatchEvent(new CustomEvent('agentmanager:environment-transferred',{detail:{sessionId}}));onTransferred?.();}catch(e){setError(e instanceof Error?e.message:'切换失败，原会话已保留');}finally{setWorking(false);}}
 if(!query.data)return null;
 return <><label className="conversation-control-select"><span>账号</span><select aria-label="选择 Codex 账号环境" disabled={busy||working} value={query.data.current} onChange={e=>{setTarget(e.target.value);setModels([]);setSelection('');setChecks([]);setError('');}}>{query.data.environments.map(e=><option key={e.id} value={e.id} disabled={!e.enabled||!e.can_control}>{e.name}</option>)}</select><ChevronDown size={12}/></label>
 {target&&<Dialog title="保留上下文切换 Codex 环境" busy={working} onClose={close}>
  <p>将完整原生历史复制到“{query.data.environments.find(e=>e.id===target)?.name}”，验证恢复成功后切换当前标签页。原会话保留；运行中的任务须先完成。</p>
  <button type="button" disabled={working||busy} onClick={()=>void preflight()}>{working?'处理中…':'预检连接、登录、模型与项目权限'}</button>
  {checks.length>0&&<EnvironmentChecks checks={checks}/>}
  {models.length>0&&<><label className="mt-3 block">目标模型<select aria-label="目标环境模型" value={selection} disabled={working} onChange={e=>{setSelection(e.target.value);setEffort(models.find(m=>modelKey(m)===e.target.value)?.defaultEffort||'');}}>{models.map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.provider?m.provider+' · ':''}{m.name}</option>)}</select></label><label className="mt-3 block">推理强度<select aria-label="目标环境推理强度" value={effort} disabled={working} onChange={e=>setEffort(e.target.value)}>{model?.efforts.map(e=><option key={e.value} value={e.value}>{e.description||e.value||'默认'}</option>)}</select></label></>}
  {error&&<p role="alert">{error}</p>}
  <footer className="mt-4 flex justify-end gap-3"><button type="button" disabled={working} onClick={close}>取消</button><button type="button" disabled={working||busy||!model||!checks.length||checks.some(c=>!c.ok)} onClick={()=>void transfer()}>复制历史并切换</button></footer>
 </Dialog>}{!target&&error&&<span role="alert">{error}</span>}</>;
}
