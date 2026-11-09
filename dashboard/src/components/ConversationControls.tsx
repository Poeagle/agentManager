import type {AgentFeature} from '../lib/agents';
import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ChevronDown,Info,RefreshCw,Minimize2,Plus,Loader2,Zap} from 'lucide-react';
import {api,type ConversationControlsData,type ConversationUsageUpdate} from '../lib/api';
import {Dialog} from './Dialog';
import {ConversationUsagePanel} from './ConversationUsagePanel';

const effortNames:Record<string,string>={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'};
const compact=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const choiceKey=(value:{provider?:string;model:string})=>value.provider?JSON.stringify([value.provider,value.model]):value.model;
const stamp=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未提供';
const permissions:Record<string,string>={'danger-full-access':'完整访问','workspace-write':'工作区可写','read-only':'只读'};
export function ConversationControls({sessionId,active,busy=false,compacting=false,onCompact,onNewConversation}:{sessionId:string;active:boolean;busy?:boolean;compacting?:boolean;onCompact?:()=>Promise<void>;onNewConversation?:(preference?:import('../lib/api').AgentModelPreference)=>Promise<void>}) {
  const queryClient=useQueryClient(),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[applied,setApplied]=useState(false),[error,setError]=useState('');
  const [operation,setOperation]=useState<'compact'|'new'|null>(null),[newOpen,setNewOpen]=useState(false),[notice,setNotice]=useState('');
  const [freshPreference,setFreshPreference]=useState<import('../lib/api').AgentModelPreference>();
  const operationLock=useRef(false);
    const forceRefresh=useRef(false);
  const query=useQuery({queryKey:['conversation-controls',sessionId],queryFn:()=>{const force=forceRefresh.current;forceRefresh.current=false;return api.agent.controls(sessionId,force);},enabled:active,refetchInterval:active?300000:false,staleTime:300000,refetchOnWindowFocus:false,retry:false});
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
  const data=baseline&&update&&update.native_id===baseline.native_id&&(!baseline.usage_observed_at||Date.parse(update.observed_at)>=Date.parse(baseline.usage_observed_at))
    ?{...baseline,usage:update.usage,usage_observed_at:update.observed_at}:baseline;
  const selected=data?.pending||{model:data?.model||'',effort:data?.effort||'',provider:data?.provider||undefined};
  const model=data?.models.find(m=>m.model===selected.model&&(!m.provider||!selected.provider||m.provider===selected.provider)),usage=data?.usage;
  const context=usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
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
  return <div className="conversation-controls-wrap">
    <div className="conversation-controls" aria-label="模型和会话信息">
      {data?<>
        <label className="conversation-control-select"><span>模型</span><select aria-label="选择模型" value={model?choiceKey(model):selected.model} disabled={!data.can_edit||saving||!!operation} title={model?.description||(!data.can_edit?'此会话暂不可切换模型，可查看原始终端':undefined)} onChange={event=>{const next=data.models.find(m=>choiceKey(m)===event.target.value);if(next){const preference={model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.efforts.some(e=>e.value===selected.effort)?selected.effort:next.defaultEffort};if(next.provider&&data.provider&&next.provider!==data.provider){if(!onNewConversation){setError('切换模型服务需要从标签页新开会话');return;}setFreshPreference(preference);setNewOpen(true);}else void save(preference);}}}>
          {!model&&<option value={model?choiceKey(model):selected.model}>{selected.model||'未提供'}</option>}{data.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{m.provider?`${m.provider} · `:''}{m.name}</option>)}
        </select><ChevronDown size={12}/></label>
        <label className="conversation-control-select"><span>强度</span><select aria-label="选择推理强度" value={selected.effort} disabled={!canEdit('effort')||!model||saving||!!operation} onChange={event=>void save({model:selected.model,...(model?.provider?{provider:model.provider}:{}),effort:event.target.value})}>
          {!model?.efforts.some(e=>e.value===selected.effort)&&<option value={selected.effort}>{selected.effort||'未提供'}</option>}{model?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}（{e.value}）</option>)}
        </select><ChevronDown size={12}/></label>
        {data.agent?.capabilities.serviceTier&&<button type="button" aria-label={fastEnabled?'关闭 Fast 模式':'开启 Fast 模式'} aria-pressed={fastEnabled} disabled={!canEdit('serviceTier')||!fastTier||saving||!!operation} title={!fastTier?'当前模型目录未提供 Fast 档位':`Fast ${fastEnabled?'已开启，点击恢复默认档位':'已关闭，点击开启'}；对后续模型请求生效`} style={{color:fastEnabled?'var(--accent)':undefined}} onClick={()=>void save({model:selected.model,effort:selected.effort,...model?.provider?{provider:model.provider}:{},service_tier:fastEnabled?'default':fastTier!.id})}><Zap size={12}/>{fastEnabled?'Fast 开':'Fast 关'}</button>}
        {data.pending&&<span className="conversation-control-pending">{data.pending_status==='submitted'?'已提交，等待原生模型确认':'恢复或重载时应用'} {data.pending_status!=='submitted'&&<button type="button" disabled={saving} onClick={()=>void save(data.pending)}>应用</button>}<button type="button" disabled={saving} onClick={()=>void save(null)}>取消</button></span>}
        {applied&&!data.pending&&<span className="conversation-control-pending" role="status">已应用</span>}
        {context!==null&&<span className="conversation-control-context" title="最近一次模型请求的 Token 数占上下文窗口的比例，下一次请求可能变化。"><i><b style={{width:`${context}%`}}/></i>上下文 {context}%</span>}
        <button type="button" disabled={!canEdit('compact')||busy||compacting||saving||!!operation} title={compactReason} onClick={()=>void perform('compact')}>{compacting||operation==='compact'?<Loader2 size={12} className="animate-spin"/>:<Minimize2 size={12}/>} {compacting||operation==='compact'?'压缩中…':'压缩'}</button>
        {onNewConversation&&<button type="button" disabled={!canEdit('newConversation')||saving||!!operation} title="在当前标签页新开会话，保留旧记录并停止旧会话" onClick={()=>{let rawDraft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{rawDraft ||= value;}}}));if(rawDraft){setError('原始终端还有未发送内容，请先发送或清空。');return;}setError('');setFreshPreference(model?{model:model.model,effort:selected.effort,provider:model.provider}:undefined);setNewOpen(true);}}><Plus size={12}/>{operation==='new'?'新开中…':'新开'}</button>}
        {weekly&&<span title={weekly.resets_at?`重置时间：${new Date(weekly.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:undefined}>周额度剩余 {Math.round(100-weekly.used_percent)}%</span>}
        <span className="conversation-control-environment" aria-label="会话运行信息">
          {data.cwd&&<span className="conversation-control-directory" title={`工作目录：${data.cwd}`}>{data.cwd}</span>}
          {data.git&&<><span title="当前 Git 分支">{data.git.branch}</span><span title="工作区状态，每 5 分钟刷新，也可手动刷新">{data.git.changes?`${data.git.changes} 项变更`:'无变更'}</span></>}
          <span title="会话运行状态">{compacting?'压缩中':busy?'执行中':data.loaded?'等待输入':'未接入实时控制'}</span>
          {data.permission&&<span title="当前会话访问权限">{permissions[data.permission]||data.permission}</span>}
          {data.engine_version&&<span title={`当前连接的 ${data.agent?.label||'Agent'} 服务版本`}>{data.agent?.label||'Agent'} {data.engine_version}</span>}
          {usage?.window!=null&&<span title={`上下文窗口容量：${usage.window.toLocaleString()} Token`}>窗口 {compact(usage.window)}</span>}
          {usage?.total.total_tokens!=null&&<span title={`会话累计用量：${usage.total.total_tokens.toLocaleString()} Token，包含重复上下文输入和缓存命中；不是当前上下文占用或金额`}>累计 {compact(usage.total.total_tokens)} Token</span>}
          {usage?.total.input_tokens!=null&&<span title={`会话累计输入：${usage.total.input_tokens.toLocaleString()} Token，包含缓存命中`}>输入 {compact(usage.total.input_tokens)}</span>}
          {usage?.total.output_tokens!=null&&<span title={`会话累计输出：${usage.total.output_tokens.toLocaleString()} Token，包含推理输出`}>输出 {compact(usage.total.output_tokens)}</span>}
        </span>
        {(error&&!newOpen||notice)&&<span className="conversation-control-message" role={error&&!newOpen?'alert':'status'} title={error&&!newOpen?error:notice}>{error&&!newOpen?error:notice}</span>}
        <button className="conversation-control-details" type="button" onClick={()=>setExpanded(true)}><Info size={13}/>详情</button>
        <button type="button" aria-label="刷新会话信息" title="用量随会话事件实时更新，其他信息每 5 分钟刷新，也可手动刷新" disabled={query.isFetching} onClick={refresh}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>刷新</button>
      </>:<><span>{query.isPending?'读取会话信息…':'会话信息暂不可用'}</span>{query.isError&&<button type="button" onClick={refresh}><RefreshCw size={13}/>重试</button>}</>}
    </div>
    {newOpen&&<Dialog title="在当前标签页新开会话" busy={operation==='new'} onClose={()=>setNewOpen(false)}>
      <p className="text-sm leading-relaxed">{data?.supports_fresh_model?'请确认新会话使用的模型服务、模型和推理强度。':'新会话将使用当前 Agent 的默认模型设置。'}当前任务会停止，旧会话的后台终端会回收，历史消息可从“项目会话记录”重新打开。当前输入框中未发送的文字和附件会保留。</p>
      {data?.supports_fresh_model&&<><label className="mt-3 flex items-center gap-2 text-sm">新会话模型<select aria-label="新会话模型" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?choiceKey(freshPreference):''} onChange={event=>{const next=data?.models.find(m=>choiceKey(m)===event.target.value);if(next)setFreshPreference({model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.defaultEffort});}}><option value="" disabled>请选择可用模型</option>{data?.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{m.provider?`${m.provider} · `:''}{m.name}</option>)}</select></label>
      <label className="mt-3 flex items-center gap-2 text-sm">推理强度<select aria-label="新会话推理强度" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?.effort||''} onChange={event=>setFreshPreference(previous=>previous?{...previous,effort:event.target.value}:previous)}>{data?.models.find(m=>m.model===freshPreference?.model&&m.provider===freshPreference?.provider)?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}</option>)}</select></label></>}
      {error&&<p role="alert" className="session-chat-error">{error}</p>}
      <footer className="mt-4 flex justify-end gap-3 text-sm"><button type="button" disabled={!!operation} onClick={()=>setNewOpen(false)}>取消</button><button type="button" disabled={!!operation||!!data?.supports_fresh_model&&!freshPreference} onClick={()=>void perform('new')}>{operation==='new'?'正在新开…':'停止旧会话并新开'}</button></footer>
    </Dialog>}
    {expanded&&data&&<ControlDetails data={{...data,state:data.loaded?(busy||compacting?'active':'idle'):data.state}} onClose={()=>setExpanded(false)} onRefresh={refresh} refreshing={query.isFetching}/>}
  </div>;
}
function ControlDetails({data,onClose,onRefresh,refreshing}:{data:ConversationControlsData;onClose:()=>void;onRefresh:()=>void;refreshing:boolean}) {
  const fields=[['当前模型',data.model],['当前推理强度',data.effort?`${effortNames[data.effort]||data.effort}（${data.effort}）`:null],['模型服务',data.provider],['访问权限',data.permission?permissions[data.permission]||data.permission:null],['执行确认',data.approval==='never'?'无需逐次确认':data.approval],['服务层级',data.service_tier],['工作目录',data.cwd],['当前分支',data.git?.branch],['工作区状态',data.git?data.git.changes?`${data.git.changes} 项变更`:'无变更':null],['会话状态',data.state==='active'?'执行中':data.state==='idle'?'等待输入':data.state==='notLoaded'?'未接入实时控制':data.state],[`当前运行的 ${data.agent?.label||'Agent'} 服务版本`,data.engine_version]];
  return <Dialog title="会话详情" size="lg" onClose={onClose} actions={<button className="conversation-preview-dock" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing?'animate-spin':''}/>刷新</button>}>
    {data.pending&&<p className="conversation-controls-note">{data.pending_status==='submitted'?'等待原生请求确认：':'恢复或重载时应用：'}{data.pending.model} · {data.pending.effort}。</p>}
    {data.warning&&<p role="status" className="conversation-controls-note">{data.warning}</p>}
    {!data.can_edit&&<p className="conversation-controls-note">当前显示只读信息。可在原始终端查看或修改该会话支持的设置。</p>}
    <ConversationUsagePanel usage={data.usage} observedAt={data.usage_observed_at}/>
    <details className="conversation-usage-details" open><summary>模型与运行环境详情</summary>
    <dl className="conversation-controls-details">{fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'未提供'}</dd></div>)}</dl>
    </details>
    <p className="conversation-controls-note">原生会话编号：{data.native_id}</p>
    {data.limits.length>0&&<><h4 className="conversation-controls-heading">可用额度</h4><ul className="conversation-controls-limits">{data.limits.map((limit,index)=><li key={index}><strong>{limit.minutes>=6*24*60?'周额度':limit.minutes>=60?`${compact(limit.minutes/60)} 小时额度`:`${limit.minutes} 分钟额度`}</strong><span>剩余 {Math.round(100-limit.used_percent)}%</span><span>{limit.resets_at?`重置：${new Date(limit.resets_at*1000).toLocaleString('zh-CN',{hour12:false})}`:'未提供重置时间'}</span></li>)}</ul></>}
    <p className="conversation-controls-note">模型目录与账号额度每 5 分钟刷新，用量随本地事件更新。信息读取时间：{stamp(data.checked_at)}。未提供的数据不作估算。</p>
  </Dialog>;
}
