import {ChevronDown,ListChecks,Loader2} from 'lucide-react';
import {useEffect,useId,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api,type EnvironmentCheck,type ConversationControlsData,type Session} from '../lib/api';
import {Dialog} from './Dialog';
import {EnvironmentChecks,EnvironmentDiagnostic} from './CodexEnvironmentPanel';
type Model=ConversationControlsData['models'][number];
export function ConversationEnvironmentSelector({sessionId,busy,active=true,onTransferred,requested,onRequestHandled}:{sessionId:string;busy:boolean;active?:boolean;onTransferred?:()=>void;requested?:{provider:string;model:string;effort:string};onRequestHandled?:()=>void}) {
 const client=useQueryClient();const query=useQuery({queryKey:['session-environments',sessionId],queryFn:()=>api.codexEnvironments.forSession(sessionId),enabled:active,retry:false,staleTime:30000});
 const [target,setTarget]=useState(''),[models,setModels]=useState<Model[]>([]),[selection,setSelection]=useState(''),[effort,setEffort]=useState(''),[checks,setChecks]=useState<EnvironmentCheck[]>([]),[operation,setOperation]=useState<'preflight'|'transfer'|null>(null),[error,setError]=useState('');
 const working=operation!==null;
 const preflightButton=useRef<HTMLButtonElement>(null);
 const fieldId=useId();
 const modelKey=(m:Model)=>JSON.stringify([m.provider||'',m.model]);const model=models.find(m=>modelKey(m)===selection);
 useEffect(()=>{if(!requested||!query.data)return;const destination=query.data.environments.find(e=>e.kind==='provider'&&e.provider===requested.provider)||query.data.environments.find(e=>e.kind==='native');if(!destination||!destination.can_control){setError('目标模型服务尚未授权，请联系管理员');return;}setTarget(destination.id);setModels([]);setSelection('');setChecks([]);setError('');},[requested,query.data]);
 const close=()=>{setTarget('');onRequestHandled?.();};
 const isClaude=query.data?.environments.some(e=>e.id==='anthropic'||e.id==='claude-provider:anthropic');
 async function preflight(){setOperation('preflight');setError('');setModels([]);setChecks([]);try{const r=await api.codexEnvironments.sessionPreflight(sessionId,target,isClaude&&requested?{model:requested.model}:{});setChecks(r.checks);if(r.ok){setModels(r.models||[]);const m=requested?r.models?.find(m=>m.model===requested.model&&m.provider===requested.provider):r.models?.[0];setSelection(m?modelKey(m):'');setEffort(m&&requested&&m.efforts.some(e=>e.value===requested.effort)?requested.effort:m?.defaultEffort||'');if(!m)setError('目标环境没有所选模型，请重新选择');}}catch(e){setError(e instanceof Error?e.message:'预检失败');}finally{setOperation(null);}}
 async function transfer(){
  if(!model||working)return;
  let draft=false;
  window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{draft ||= value;}}}));
  if(draft){setError('原始终端还有未发送内容，请先发送或清空。');return;}
  setOperation('transfer');setError('');
  try{
   if(isClaude){
    const result=await api.codexEnvironments.sessionPreflight(sessionId,target,{model:model.model});
    if(!result.ok||!result.models?.some(choice=>choice.model===model.model))throw Error(result.checks.find(check=>!check.ok)?.message||'无法确认所选模型');
   }
   const {session}=await api.codexEnvironments.transfer(sessionId,{environment_id:target,model:model.model,effort:isClaude?'':effort,...!isClaude&&model.provider?{provider:model.provider}:{}});
   const environmentKey=['session-environments',sessionId];
   void client.cancelQueries({queryKey:environmentKey,exact:true});
   client.setQueryData<typeof query.data>(environmentKey,data=>data?{...data,current:target}:data);
   const sessionKeys=[['sessions'],...(session?.project_id?[['project-sessions',session.project_id]]:[])];
   if(session){
    for(const queryKey of sessionKeys){
     void client.cancelQueries({queryKey,exact:true});
     client.setQueryData<{sessions:Session[]}>(queryKey,data=>data?{...data,sessions:data.sessions.map(row=>row.id===sessionId?session:row)}:data);
    }
   }
   close();
   for(const queryKey of [...sessionKeys,environmentKey,['conversation-controls',sessionId],['conversation',sessionId]]){
    void client.invalidateQueries({queryKey,exact:true});
   }
   window.dispatchEvent(new CustomEvent('agentmanager:environment-transferred',{detail:{sessionId}}));
   onTransferred?.();
  }catch(e){
   setError(e instanceof Error?e.message:'切换失败，原会话已保留');
  }finally{setOperation(null);}
 }
 if(!query.data)return null;
 const environments=query.data.environments.filter(environment=>environment.can_control);
 const destination=query.data.environments.find(environment=>environment.id===target);
 return <><label className="conversation-control-select"><span>{isClaude?'Provider':'账号'}</span><select aria-label={isClaude?'选择 Claude Provider':'选择 Codex 账号环境'} disabled={busy||working||environments.length<2} value={query.data.current} onChange={e=>{setTarget(e.target.value);setModels([]);setSelection('');setChecks([]);setError('');}}>{environments.map(e=><option key={e.id} value={e.id} disabled={!e.enabled}>{e.name}</option>)}</select><ChevronDown size={12}/></label>
 {target&&<Dialog title={isClaude?'切换 Claude Provider':'保留上下文切换 Codex 环境'}
  busy={working} onClose={close} initialFocus={preflightButton}>
  <div className="conversation-environment-form">
   <p>{isClaude?'会保留当前对话记录，并在当前标签页以新模型、新凭据开始会话。运行中的任务须先完成。':<>将完整原生历史复制到「{destination?.name}」，验证恢复成功后切换当前标签页。原会话保留；运行中的任务须先完成。已清理的历史附件保留引用，但不会恢复文件，也不阻止切换。</>}</p>
   <button ref={preflightButton} type="button" className="conversation-action-button"
    disabled={working||busy} aria-busy={operation==='preflight'} onClick={()=>void preflight()}>
    {operation==='preflight'?<Loader2 size={15} className="motion-safe:animate-spin" aria-hidden/>:<ListChecks size={15} aria-hidden/>}
    <span>{operation==='preflight'?'正在预检…':isClaude?'读取 Provider 模型':'预检连接、登录、模型与项目权限'}</span>
   </button>
   {operation==='transfer'&&<p role="status">正在切换{isClaude?' Provider…':'账号并恢复会话…'}</p>}
   {checks.length>0&&<EnvironmentChecks checks={checks}/>}
   {models.length>0&&<div className="conversation-environment-fields">
    <label htmlFor={`${fieldId}-model`}>目标模型</label>
    <select id={`${fieldId}-model`} aria-label="目标环境模型" value={selection} disabled={working} onChange={event=>{
     const value=event.target.value;
     setSelection(value);
     setEffort(models.find(candidate=>modelKey(candidate)===value)?.defaultEffort||'');
    }}>
     {models.map(candidate=><option key={modelKey(candidate)} value={modelKey(candidate)}>
      {destination?.auth_mode==='api'||!candidate.provider?candidate.name:`${candidate.provider} · ${candidate.name}`}
     </option>)}
    </select>
    {!isClaude&&<>
     <label htmlFor={`${fieldId}-effort`}>推理强度</label>
     <select id={`${fieldId}-effort`} aria-label="目标环境推理强度" value={effort} disabled={working} onChange={event=>setEffort(event.target.value)}>
      {model?.efforts.map(option=><option key={option.value} value={option.value}>{option.description||option.value||'默认'}</option>)}
     </select>
    </>}
   </div>}
   {error&&<p role="alert"><EnvironmentDiagnostic message={error}/></p>}
   <footer className="conversation-dialog-actions">
    <button type="button" className="conversation-action-button" disabled={working} onClick={close}>取消</button>
    <button type="button" className="conversation-action-button conversation-action-button--primary"
     disabled={working||busy||!model||!checks.length||checks.some(check=>!check.ok)} onClick={()=>void transfer()}>
     {isClaude?'切换 Provider':'复制历史并切换'}
    </button>
   </footer>
  </div>
 </Dialog>}{!target&&error&&<span role="alert"><EnvironmentDiagnostic message={error}/></span>}</>;
}
