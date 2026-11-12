import {createPortal} from 'react-dom';
import {ConversationEnvironmentSelector} from './ConversationEnvironmentSelector';
import type {AgentFeature} from '../lib/agents';
import {useEffect,useId,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ChevronDown,Info,RefreshCw,Minimize2,Plus,Loader2,Zap} from 'lucide-react';
import {api,type ConversationControlsData,type ConversationUsageUpdate} from '../lib/api';
import {Dialog} from './Dialog';
import {ConversationDetailsPanel,type ConversationDetailRuntimeRow} from './ConversationDetailsPanel';
import {ConversationContextUsage} from './ConversationContextUsage';

const effortNames:Record<string,string>={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'};
const compact=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const choiceKey=(value:{provider?:string;model:string})=>value.provider?JSON.stringify([value.provider,value.model]):value.model;
const permissions:Record<string,string>={'danger-full-access':'完整访问','workspace-write':'工作区可写','read-only':'只读'};
const permissionsEn:Record<string,string>={'danger-full-access':'Full access','workspace-write':'Workspace write','read-only':'Read only'};
export function ConversationControls({sessionId,active,busy=false,compacting=false,onCompact,onNewConversation,toolbarTarget}:{toolbarTarget?:HTMLElement|null;sessionId:string;active:boolean;busy?:boolean;compacting?:boolean;onCompact?:()=>Promise<void>;onNewConversation?:(preference?:import('../lib/api').AgentModelPreference)=>Promise<void>}) {
  const queryClient=useQueryClient(),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[applied,setApplied]=useState(false),[error,setError]=useState('');
  const [operation,setOperation]=useState<'compact'|'new'|null>(null),[newOpen,setNewOpen]=useState(false),[notice,setNotice]=useState('');
  const [freshPreference,setFreshPreference]=useState<import('../lib/api').AgentModelPreference>();
  const [contextOpen,setContextOpen]=useState(false);
  const tooltipId=useId(),[modelInfo,setModelInfo]=useState<{left:number;top?:number;bottom?:number}|null>(null);
  function showModelInfo(node:HTMLElement){const rect=node.getBoundingClientRect(),left=Math.max(8,Math.min(rect.left,window.innerWidth-328));setModelInfo(rect.top>230?{left,bottom:window.innerHeight-rect.top+8}:{left,top:rect.bottom+8});}
  const [environmentRequest,setEnvironmentRequest]=useState<{provider:string;model:string;effort:string}>();
  const operationLock=useRef(false);
    const forceRefresh=useRef(false);
  const query=useQuery({queryKey:['conversation-controls',sessionId],queryFn:()=>{const force=forceRefresh.current;forceRefresh.current=false;return api.agent.controls(sessionId,force);},enabled:active,refetchInterval:active?300000:false,staleTime:300000,refetchOnWindowFocus:false,retry:false});
  const environments=useQuery({queryKey:['session-environments',sessionId],queryFn:()=>api.codexEnvironments.forSession(sessionId),enabled:active&&query.data?.agent?.id==='codex',retry:false,staleTime:30000});
  // Cache-only subscription: usage events never trigger a model/catalog/quota request.
  const liveUsage=useQuery<ConversationUsageUpdate|null>({queryKey:['conversation-usage',sessionId],queryFn:async()=>null,enabled:false});
  const refresh=()=>{forceRefresh.current=true;void query.refetch();};
  useEffect(()=>{if(!active){setExpanded(false);if(!operation)setNewOpen(false);}},[active,operation]);
  async function perform(action:'compact'|'new') {
    if(operationLock.current)return;
    if(action==='new'){let draft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{draft ||= value;}}}));if(draft){setError('原始终端还有未发送内容，请先发送或清空。');return;}}
    operationLock.current=true;setOperation(action);setError('');setNotice('');
    try{if(action==='new'){await onNewConversation?.(query.data?.supports_fresh_model?freshPreference:undefined);setNewOpen(false);setNotice('新会话已打开，原会话保留在项目会话记录中。');}else{await (onCompact?onCompact():api.sessions.compactConversation(sessionId));}if(action==='new')void queryClient.invalidateQueries({queryKey:['conversation-controls',sessionId]});}
    catch(failure){if(action!=='compact'||!onCompact)setError(failure instanceof Error?failure.message:'操作失败，请重试');}
    finally{operationLock.current=false;setOperation(null);}
  }
  const baseline=query.data,update=liveUsage.data;
  useEffect(()=>{setContextOpen(false);},[sessionId,baseline?.native_id,active]);
  const data=baseline&&update&&update.native_id===baseline.native_id&&(!baseline.usage_observed_at||Date.parse(update.observed_at)>=Date.parse(baseline.usage_observed_at))
    ?{...baseline,usage:update.usage,usage_observed_at:update.observed_at}:baseline;
  const selected=data?.pending||{model:data?.model||'',effort:data?.effort||'',provider:data?.provider||undefined};
  const modelLabel=(m:ConversationControlsData['models'][number])=>{
    const envs=environments.data?.environments||[],current=envs.find(e=>e.id===environments.data?.current);
    const target=(!m.provider||m.provider===data?.provider)?current:envs.find(e=>e.provider===m.provider);
    return target?.auth_mode==='api'?m.name:`${m.provider?`${m.provider} · `:''}${m.name}`;
  };
  const model=data?.models.find(m=>m.model===selected.model&&(!m.provider||!selected.provider||m.provider===selected.provider)),usage=data?.usage;
  const context=usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
  const currentEnvironment=environments.data?.environments.find(e=>e.id===environments.data?.current);
  const modelEnvironment=(!model?.provider||model.provider===data?.provider)?currentEnvironment:environments.data?.environments.find(e=>e.provider===model?.provider);
  const referenceCredits=modelEnvironment?.auth_mode==='account'?model?.reference_credits:null;
  const modelContext=model?.context_window??(model?.model===data?.model&&(!model?.provider||model.provider===data?.provider)?usage?.window:null);
  const fastTier=model?.service_tiers?.find(tier=>tier.name.trim().toLowerCase()==='fast');
  const fastEnabled=!!fastTier&&(data?.pending?.service_tier??data?.service_tier??model?.default_service_tier)===fastTier.id;
  const weekly=data?.limits.find(limit=>limit.minutes>=6*24*60);
  const canEdit=(feature:AgentFeature)=>data?.can_edit_features?.[feature]??data?.can_edit??false;
  const compactReason=compacting?'上下文正在压缩中，请等待完成':!data?.can_edit?'此会话尚未接入实时控制，请先重载标签页':busy?'当前任务完成后可压缩':saving?'正在保存设置':operation?'正在处理会话操作':'压缩当前会话上下文，保留对话记录';
  async function save(value:import('../lib/api').AgentModelPreference|null) {
    if(saving)return;setSaving(true);setApplied(false);setError('');
    try {const result=await api.agent.setControls(sessionId,value);queryClient.setQueryData<ConversationControlsData>(['conversation-controls',sessionId],previous=>previous?{...previous,pending:result.pending,pending_status:result.pending_status,...!result.pending&&result.model?{model:result.model,effort:result.effort||null,...result.service_tier!==undefined?{service_tier:result.service_tier}:{}}:{}}:previous);setApplied(!!value&&!result.pending);}
    catch(failure){setError(failure instanceof Error?failure.message:'设置失败，请重试');}
    finally{setSaving(false);}
  }
  useEffect(()=>{if(!applied)return;const timer=setTimeout(()=>setApplied(false),4000);return()=>clearTimeout(timer);},[applied]);
  const toolbar=data?<div className="conversation-controls conversation-toolbar" aria-label="会话操作">
        {data.agent?.id==='codex'&&<ConversationEnvironmentSelector sessionId={sessionId} busy={busy||saving||!!operation} requested={environmentRequest} onRequestHandled={()=>setEnvironmentRequest(undefined)}/>}
        <label className="conversation-control-select conversation-control-model" onMouseEnter={event=>showModelInfo(event.currentTarget)} onMouseLeave={()=>setModelInfo(null)} onFocus={event=>showModelInfo(event.currentTarget)} onBlur={()=>setModelInfo(null)}><span>模型</span><select aria-label="选择模型" aria-describedby={modelInfo&&model?tooltipId:undefined} value={model?choiceKey(model):selected.model} disabled={!data.can_edit||saving||!!operation} title={model?`${modelLabel(model)}${model.description?` · ${model.description}`:''}`:(!data.can_edit?'此会话暂不可切换模型，可查看原始终端':undefined)} onChange={event=>{const next=data.models.find(m=>choiceKey(m)===event.target.value);if(next){const preference={model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.efforts.some(e=>e.value===selected.effort)?selected.effort:next.defaultEffort};if(next.provider&&data.provider&&next.provider!==data.provider){if(data.agent?.id==='codex'){setEnvironmentRequest({...preference,provider:next.provider});return;}if(!onNewConversation){setError('切换模型服务需要从标签页新开会话');return;}setFreshPreference(preference);setNewOpen(true);}else void save(preference);}}}>
          {!model&&<option value={model?choiceKey(model):selected.model}>{selected.model||'未提供'}</option>}{data.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{modelLabel(m)}</option>)}
        </select><ChevronDown size={12}/></label>
        <label className="conversation-control-select"><span>强度</span><select aria-label="选择推理强度" value={selected.effort} disabled={!canEdit('effort')||!model||saving||!!operation} onChange={event=>void save({model:selected.model,...(model?.provider?{provider:model.provider}:{}),effort:event.target.value})}>
          {!model?.efforts.some(e=>e.value===selected.effort)&&<option value={selected.effort}>{selected.effort||'未提供'}</option>}{model?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}（{e.value}）</option>)}
        </select><ChevronDown size={12}/></label>
        {data.agent?.capabilities.serviceTier&&<button type="button" aria-label={fastEnabled?'关闭 Fast 模式':'开启 Fast 模式'} aria-pressed={fastEnabled} disabled={!canEdit('serviceTier')||!fastTier||saving||!!operation} title={!fastTier?'当前模型目录未提供 Fast 档位':`Fast ${fastEnabled?'已开启，点击恢复默认档位':'已关闭，点击开启'}；对后续模型请求生效`} style={{color:fastEnabled?'var(--accent)':undefined}} onClick={()=>void save({model:selected.model,effort:selected.effort,...model?.provider?{provider:model.provider}:{},service_tier:fastEnabled?'default':fastTier!.id})}><Zap size={12}/>{fastEnabled?'Fast 开':'Fast 关'}</button>}
        {data.pending&&<span className="conversation-control-pending">{data.pending_status==='submitted'?'已提交，等待原生模型确认':'恢复或重载时应用'} {data.pending_status!=='submitted'&&<button type="button" disabled={saving} onClick={()=>void save(data.pending)}>应用</button>}<button type="button" disabled={saving} onClick={()=>void save(null)}>取消</button></span>}
        {applied&&!data.pending&&<span className="conversation-control-pending" role="status">已应用</span>}
        <button type="button" disabled={!canEdit('compact')||busy||compacting||saving||!!operation} title={compactReason} onClick={()=>void perform('compact')}>{compacting||operation==='compact'?<Loader2 size={12} className="animate-spin"/>:<Minimize2 size={12}/>} {compacting||operation==='compact'?'压缩中…':'压缩'}</button>
        {onNewConversation&&<button type="button" disabled={!canEdit('newConversation')||saving||!!operation} title="在当前标签页新开会话，保留旧记录并停止旧会话" onClick={()=>{let rawDraft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{rawDraft ||= value;}}}));if(rawDraft){setError('原始终端还有未发送内容，请先发送或清空。');return;}setError('');setFreshPreference(model?{model:model.model,effort:selected.effort,provider:model.provider}:undefined);setNewOpen(true);}}><Plus size={12}/>{operation==='new'?'新开中…':'新开'}</button>}
  </div>:null;
  return <div className="conversation-controls-wrap">
    <div className="conversation-controls" aria-label="Model and session status">
      {data?<>
        {toolbarTarget?createPortal(toolbar,toolbarTarget):toolbar}
        {data.native_id&&<button type="button" className="conversation-control-context" aria-label="View context token details" aria-haspopup="dialog" title="Context used by the latest request; click for details." onClick={()=>setContextOpen(true)}><i aria-hidden="true" style={{background:context===null?'var(--border)':`conic-gradient(var(--accent) ${context}%, var(--border) 0)`}}/>Context {context===null?'Unavailable':`${context}%`}</button>}
        {weekly&&<span title={weekly.resets_at?`Resets: ${new Date(weekly.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:undefined}>Weekly remaining {Math.round(100-weekly.used_percent)}%</span>}
        <span className="conversation-control-environment" aria-label="Session information">
          {data.cwd&&<span className="conversation-control-directory" title={`Working directory: ${data.cwd}`}>{data.cwd}</span>}
          {data.git&&<><span title="Git branch">{data.git.branch}</span><span title="Working tree status">{data.git.changes?`${data.git.changes} changes`:'Clean'}</span></>}
          <span title="Session status">{compacting?'Compacting':busy?'Running':data.loaded?'Waiting':'Disconnected'}</span>
          {data.permission&&<span title="Access permissions">{permissionsEn[data.permission]||data.permission}</span>}
          {usage?.window!=null&&<span title={`Context window: ${usage.window.toLocaleString()} Token`}>Window {compact(usage.window)}</span>}
          {usage?.total.total_tokens!=null&&<span title={`Total usage: ${usage.total.total_tokens.toLocaleString()} tokens including cached and repeated context`}>Total {compact(usage.total.total_tokens)}</span>}
          {usage?.total.input_tokens!=null&&<span title={`Total input: ${usage.total.input_tokens.toLocaleString()} tokens including cache`}>Input {compact(usage.total.input_tokens)}</span>}
          {usage?.total.cached_input_tokens!=null&&<span title="Cached input tokens">Cache {compact(usage.total.cached_input_tokens)}</span>}
          {usage?.total.reasoning_output_tokens!=null&&<span title="Reasoning output tokens">Reasoning {compact(usage.total.reasoning_output_tokens)}</span>}
          {usage?.total.output_tokens!=null&&<span title={`Total output: ${usage.total.output_tokens.toLocaleString()} tokens including reasoning`}>Output {compact(usage.total.output_tokens)}</span>}
        </span>
        {(error&&!newOpen||notice)&&<span className="conversation-control-message" role={error&&!newOpen?'alert':'status'} title={error&&!newOpen?error:notice}>{error&&!newOpen?error:notice}</span>}
        <button className="conversation-control-details" type="button" onClick={()=>setExpanded(true)}><Info size={13}/>Details</button>
        <button type="button" aria-label="Refresh session status" title="Usage updates live; other details refresh every 5 minutes" disabled={query.isFetching} onClick={refresh}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>Refresh</button>
      </>:<><span>{query.isPending?'Loading session…':'Session status unavailable'}</span>{query.isError&&<button type="button" onClick={refresh}><RefreshCw size={13}/>Retry</button>}</>}
    </div>
    {modelInfo&&model&&createPortal(<div id={tooltipId} role="tooltip" className="conversation-model-tooltip" style={{left:modelInfo.left,top:modelInfo.top,bottom:modelInfo.bottom}}>
      <strong>{modelLabel(model)}</strong>
      <dl>
        <dt>发布时间</dt><dd>{model.release_date||'未提供'}</dd>
        <dt>计费标准</dt><dd>{referenceCredits?<>Credits / 1M：输入 {referenceCredits.input} · 缓存 {referenceCredits.cached} · 输出 {referenceCredits.output}<br/><small>参考费率 {referenceCredits.as_of}，非实际账单</small></>:'未提供'}</dd>
        <dt>上下文长度</dt><dd>{modelContext!=null?`${modelContext.toLocaleString()} tokens`:'未提供'}</dd>
        <dt>输入类型</dt><dd>{model.input_modalities?.length?model.input_modalities.join('、'):'未提供'}</dd>
        <dt>推理强度</dt><dd>{model.efforts.length?model.efforts.map(e=>e.value||'默认').join('、'):'未提供'}</dd>
        <dt>服务档位</dt><dd>{model.service_tiers?.length?model.service_tiers.map(t=>t.name).join('、'):'未提供'}</dd>
        {model.description&&<><dt>说明</dt><dd>{model.description.length>180?`${model.description.slice(0,180)}…`:model.description}</dd></>}
      </dl>
    </div>,document.body)}
    {newOpen&&<Dialog title="在当前标签页新开会话" busy={operation==='new'} onClose={()=>setNewOpen(false)}>
      <p className="text-sm leading-relaxed">{data?.supports_fresh_model?'请确认新会话使用的模型服务、模型和推理强度。':'新会话将使用当前 Agent 的默认模型设置。'}当前任务会停止，旧会话的后台终端会回收，历史消息可从“项目会话记录”重新打开。当前输入框中未发送的文字和附件会保留。</p>
      {data?.supports_fresh_model&&<><label className="mt-3 flex items-center gap-2 text-sm">新会话模型<select aria-label="新会话模型" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?choiceKey(freshPreference):''} onChange={event=>{const next=data?.models.find(m=>choiceKey(m)===event.target.value);if(next)setFreshPreference({model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.defaultEffort});}}><option value="" disabled>请选择可用模型</option>{data?.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{modelLabel(m)}</option>)}</select></label>
      <label className="mt-3 flex items-center gap-2 text-sm">推理强度<select aria-label="新会话推理强度" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?.effort||''} onChange={event=>setFreshPreference(previous=>previous?{...previous,effort:event.target.value}:previous)}>{data?.models.find(m=>m.model===freshPreference?.model&&m.provider===freshPreference?.provider)?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}</option>)}</select></label></>}
      {error&&<p role="alert" className="session-chat-error">{error}</p>}
      <footer className="mt-4 flex justify-end gap-3 text-sm"><button type="button" disabled={!!operation} onClick={()=>setNewOpen(false)}>取消</button><button type="button" disabled={!!operation||!!data?.supports_fresh_model&&!freshPreference} onClick={()=>void perform('new')}>{operation==='new'?'正在新开…':'停止旧会话并新开'}</button></footer>
    </Dialog>}
    {expanded&&data&&<ControlDetails data={{...data,state:data.loaded?(busy||compacting?'active':'idle'):data.state}} onClose={()=>setExpanded(false)} onRefresh={refresh} refreshing={query.isFetching}/>}
    {contextOpen&&active&&data?.native_id&&<ConversationContextUsage key={`${sessionId}:${data.native_id}`} sessionId={sessionId} nativeId={data.native_id} usage={data.usage} observedAt={data.usage_observed_at} model={data.model} onClose={()=>setContextOpen(false)}/>}
  </div>;
}
function ControlDetails({data,onClose,onRefresh,refreshing}:{data:ConversationControlsData;onClose:()=>void;onRefresh:()=>void;refreshing:boolean}) {
  const runtime:ConversationDetailRuntimeRow[]=[
    {label:'当前模型',value:data.model,detail:data.provider?`服务 ${data.provider}`:null},
    {label:'当前推理强度',value:data.effort?`${effortNames[data.effort]||data.effort}（${data.effort}）`:null,detail:`服务层级 ${data.service_tier||'未提供'}`},
    {label:'访问权限',value:data.permission?permissions[data.permission]||data.permission:null,detail:`执行确认 ${data.approval==='never'?'无需逐次确认':data.approval||'未提供'}`},
    {label:'工作目录',value:data.cwd},
    {label:'当前分支',value:data.git?.branch,detail:data.git?data.git.changes?`工作区 ${data.git.changes} 项变更`:'工作区无变更':'未提供 Git 信息'},
    {label:'会话状态',value:data.state==='active'?'执行中':data.state==='idle'?'等待输入':data.state==='notLoaded'?'未接入实时控制':data.state},
  ];
  return <Dialog title="会话详情" size="lg" onClose={onClose} actions={<button className="conversation-preview-dock" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing?'animate-spin':''}/>刷新</button>}>
    {data.pending&&<p className="conversation-controls-note">{data.pending_status==='submitted'?'等待原生请求确认：':'恢复或重载时应用：'}{data.pending.model} · {data.pending.effort}。</p>}
    {data.warning&&<p role="status" className="conversation-controls-note">{data.warning}</p>}
    {!data.can_edit&&<p className="conversation-controls-note">当前显示只读信息。可在原始终端查看或修改该会话支持的设置。</p>}
    <ConversationDetailsPanel usage={data.usage} observedAt={data.usage_observed_at} runtime={runtime} nativeId={data.native_id} limits={data.limits} checkedAt={data.checked_at}/>
  </Dialog>;
}
