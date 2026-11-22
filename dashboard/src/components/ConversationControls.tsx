import {Fragment} from 'react';
import {createPortal} from 'react-dom';
import {ConversationEnvironmentSelector} from './ConversationEnvironmentSelector';
import type {AgentFeature} from '../lib/agents';
import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ChevronDown,Info,RefreshCw,Minimize2,Plus,Loader2,Zap,Layers3} from 'lucide-react';
import {api,type ConversationControlsData,type ConversationUsageUpdate} from '../lib/api';
import {Dialog} from './Dialog';
import {ConversationDetailsPanel} from './ConversationDetailsPanel';
import {ConversationContextUsage} from './ConversationContextUsage';
import {quotaColor} from '../lib/quota-color';
import {coverageReason,intervalCoverageText,creditsLabel,recordedCachePercent,uncachedInputTokens,type SessionMetadata} from '../lib/session-metadata';
import {ConversationCacheHistory,ConversationUsageHistory} from './ConversationUsageHistory';

const effortNames:Record<string,string>={none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'};
const compact=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const choiceKey=(value:{provider?:string;model:string})=>value.provider?JSON.stringify([value.provider,value.model]):value.model;
const cacheRateFromCounters=(input:number|null|undefined,cache:number|null|undefined)=>
  input!=null&&cache!=null&&input>0&&cache>=0&&cache<=input?100*cache/input:null;
const permissionsEn:Record<string,string>={'danger-full-access':'Full access','workspace-write':'Workspace write','read-only':'Read only'};
const tokenMetricDescriptions:Record<string,string>={Total:'会话累计 Token，包含重复上下文',Input:'累计未缓存输入 Token',Cache:'累计命中缓存的输入 Token',Reasoning:'累计推理 Token，包含在输出中',Output:'累计输出 Token，包含推理 Token'};
export function ConversationControls({sessionId,active,busy=false,compacting=false,onCompact,onBrief,briefDisabled=false,onNewConversation,toolbarTarget,metadata}:{toolbarTarget?:HTMLElement|null;sessionId:string;active:boolean;busy?:boolean;compacting?:boolean;onCompact?:()=>Promise<void>;onBrief?:()=>void;briefDisabled?:boolean;onNewConversation?:(preference?:import('../lib/api').AgentModelPreference)=>Promise<unknown>;metadata?:SessionMetadata|null}) {
  const queryClient=useQueryClient(),[expanded,setExpanded]=useState(false),[saving,setSaving]=useState(false),[applied,setApplied]=useState(false),[error,setError]=useState('');
  const [operation,setOperation]=useState<'compact'|'new'|null>(null),[newOpen,setNewOpen]=useState(false),[notice,setNotice]=useState('');
  const [freshPreference,setFreshPreference]=useState<import('../lib/api').AgentModelPreference>();
  const [contextOpen,setContextOpen]=useState(false);
  const tooltipId=useId(),tooltipRef=useRef<HTMLDivElement>(null),[modelInfo,setModelInfo]=useState<{left:number;top?:number;bottom?:number}|null>(null);
  const tooltipDismissed=useRef(false);
  function showModelInfo(node:HTMLElement){if(tooltipDismissed.current)return;const rect=node.getBoundingClientRect(),left=Math.max(8,Math.min(rect.left,window.innerWidth-328));setModelInfo(rect.top>230?{left,bottom:window.innerHeight-rect.top+8}:{left,top:rect.bottom+8});}
  const [environmentRequest,setEnvironmentRequest]=useState<{provider:string;model:string;effort:string}>();
  const operationLock=useRef(false);
    const forceRefresh=useRef(false);
  const query=useQuery({queryKey:['conversation-controls',sessionId],queryFn:()=>{const force=forceRefresh.current;forceRefresh.current=false;return api.agent.controls(sessionId,force);},enabled:active,refetchInterval:active?300000:false,staleTime:300000,refetchOnWindowFocus:false,retry:false});
  const environments=useQuery({queryKey:['session-environments',sessionId],queryFn:()=>api.codexEnvironments.forSession(sessionId),enabled:active&&(query.data?.agent?.id==='codex'||query.data?.agent?.id==='claude'),retry:false,staleTime:30000});
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
  const summary=metadata&&metadata.native_id===data?.native_id?metadata:null;
  const cumulative=summary?summary.totals?.tokens:usage?.total;
  const credits=summary?.totals?.cost;
  const countersConsistent=!summary?.reasons.includes('counter_mismatch');
  const tokenMetrics=cumulative?([['Total',cumulative.total_tokens],['Input',countersConsistent?uncachedInputTokens(cumulative):null],['Cache',cumulative.cached_input_tokens],['Reasoning',cumulative.reasoning_output_tokens],['Output',cumulative.output_tokens]] as Array<[string,number|null|undefined]>).filter((entry):entry is [string,number]=>entry[1]!=null):[];
  const recordedRate=countersConsistent?recordedCachePercent(cumulative):null;
  const usageRate=cacheRateFromCounters(cumulative?.input_tokens,cumulative?.cached_input_tokens);
  const cacheRate=summary?(recordedRate===null?null:Number(recordedRate.toFixed(1))):usageRate===null?null:Number(usageRate.toFixed(1));
  const cacheColor=cacheRate===null?'var(--text-muted)':quotaColor(cacheRate);
  const context=usage?.window&&usage.last.total_tokens!=null?Math.min(100,Math.round(100*usage.last.total_tokens/usage.window)):null;
  const currentEnvironment=environments.data?.environments.find(e=>e.id===environments.data?.current);
  const modelEnvironment=(!model?.provider||model.provider===data?.provider)?currentEnvironment:environments.data?.environments.find(e=>e.provider===model?.provider);
  const referenceCredits=modelEnvironment?.auth_mode==='account'?model?.reference_credits:null;
  const apiPricing=model?.api_pricing;
  const providerMultiplier=apiPricing?.provider_multiplier;
  const standardRates=apiPricing?.bands?.length===1?apiPricing.bands[0].rates:undefined;
  const modelContext=model?.context_window??(model?.model===data?.model&&(!model?.provider||model.provider===data?.provider)?usage?.window:null);
  useLayoutEffect(()=>{const node=tooltipRef.current;if(!node||!modelInfo)return;const rect=node.getBoundingClientRect();if(rect.bottom>window.innerHeight-8){node.style.bottom='auto';node.style.top=`${Math.max(8,window.innerHeight-8-rect.height)}px`;}if(rect.top<8){node.style.bottom='auto';node.style.top='8px';}},[modelInfo,model]);
  const fastTier=model?.service_tiers?.find(tier=>tier.name.trim().toLowerCase()==='fast');
  const fastEnabled=!!fastTier&&(data?.pending?.service_tier??data?.service_tier??model?.default_service_tier)===fastTier.id;
  const limits=data?.agent?.id==='codex'&&currentEnvironment?.auth_mode!=='account'?[]:data?.limits||[];
  const weekly=limits.find(limit=>limit.minutes>=6*24*60);
  const weeklyRemaining=weekly?Math.round(100-weekly.used_percent):null;
  const shortLimit=limits.find(limit=>limit.minutes>0&&limit.minutes<6*24*60);
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
        {(data.agent?.id==='codex'||data.agent?.id==='claude')&&<ConversationEnvironmentSelector sessionId={sessionId} busy={busy||saving||!!operation} requested={environmentRequest} onRequestHandled={()=>setEnvironmentRequest(undefined)}/>}
        <label className="conversation-control-select conversation-control-model" onMouseEnter={event=>showModelInfo(event.currentTarget)} onMouseLeave={()=>setModelInfo(null)} onFocus={event=>showModelInfo(event.currentTarget)} onBlur={()=>{tooltipDismissed.current=false;setModelInfo(null);}} onPointerDown={()=>{tooltipDismissed.current=true;setModelInfo(null);}} onKeyDown={event=>{if(['Enter',' ','ArrowDown','ArrowUp','Escape'].includes(event.key)){tooltipDismissed.current=true;setModelInfo(null);}}}><span>模型</span><select aria-label="选择模型" aria-describedby={modelInfo&&model?tooltipId:undefined} value={model?choiceKey(model):selected.model} disabled={!data.can_edit||saving||!!operation} title={model?`${modelLabel(model)}${model.description?` · ${model.description}`:''}`:(!data.can_edit?'此会话暂不可切换模型，可查看原始终端':undefined)} onChange={event=>{const next=data.models.find(m=>choiceKey(m)===event.target.value);if(next){const preference={model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.efforts.some(e=>e.value===selected.effort)?selected.effort:next.defaultEffort};if(next.provider&&data.provider&&next.provider!==data.provider){if(data.agent?.id==='codex'){setEnvironmentRequest({...preference,provider:next.provider});return;}if(!onNewConversation){setError('切换模型服务需要从标签页新开会话');return;}setFreshPreference(preference);setNewOpen(true);}else void save(preference);}}}>
          {!model&&<option value={model?choiceKey(model):selected.model}>{selected.model||'未提供'}</option>}{data.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{modelLabel(m)}</option>)}
        </select><ChevronDown size={12}/></label>
        <label className="conversation-control-select"><span>强度</span><select aria-label="选择推理强度" value={selected.effort} disabled={!canEdit('effort')||!model||saving||!!operation} onChange={event=>void save({model:selected.model,...(model?.provider?{provider:model.provider}:{}),effort:event.target.value})}>
          {!model?.efforts.some(e=>e.value===selected.effort)&&<option value={selected.effort}>{selected.effort||'未提供'}</option>}{model?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}（{e.value}）</option>)}
        </select><ChevronDown size={12}/></label>
        {data.agent?.capabilities.serviceTier&&<button type="button" aria-label={fastEnabled?'关闭 Fast 模式':'开启 Fast 模式'} aria-pressed={fastEnabled} disabled={!canEdit('serviceTier')||!fastTier||saving||!!operation} title={!fastTier?'当前模型目录未提供 Fast 档位':`Fast ${fastEnabled?'已开启，点击恢复默认档位':'已关闭，点击开启'}；对后续模型请求生效`} style={{color:fastEnabled?'var(--accent)':undefined}} onClick={()=>void save({model:selected.model,effort:selected.effort,...model?.provider?{provider:model.provider}:{},service_tier:fastEnabled?'default':fastTier!.id})}><Zap size={12}/>{fastEnabled?'Fast 开':'Fast 关'}</button>}
        {data.pending&&<span className="conversation-control-pending">{data.pending_status==='submitted'?'已提交，等待原生模型确认':'恢复或重载时应用'} {data.pending_status!=='submitted'&&<button type="button" disabled={saving} onClick={()=>void save(data.pending)}>应用</button>}<button type="button" disabled={saving} onClick={()=>void save(null)}>取消</button></span>}
        {applied&&!data.pending&&<span className="conversation-control-pending" role="status">已应用</span>}
        {canEdit('compact')&&<button type="button" disabled={busy||compacting||saving||!!operation} title={compactReason} onClick={()=>void perform('compact')}>{compacting||operation==='compact'?<Loader2 size={12} className="animate-spin"/>:<Minimize2 size={12}/>} {compacting||operation==='compact'?'压缩中…':'压缩'}</button>}
        {onBrief&&<button type="button" disabled={!canEdit('newConversation')||busy||compacting||saving||!!operation||briefDisabled} title="整理已有对话并在新会话中发送" onClick={onBrief}><Layers3 size={12}/>简要压缩</button>}
        {onNewConversation&&<button type="button" disabled={!canEdit('newConversation')||saving||!!operation} title="在当前标签页新开会话，保留旧记录并停止旧会话" onClick={()=>{let rawDraft=false;window.dispatchEvent(new CustomEvent('agentmanager:check-terminal-draft',{detail:{sessionId,respond:(value:boolean)=>{rawDraft ||= value;}}}));if(rawDraft){setError('原始终端还有未发送内容，请先发送或清空。');return;}setError('');setFreshPreference(model?{model:model.model,effort:selected.effort,provider:model.provider}:undefined);setNewOpen(true);}}><Plus size={12}/>{operation==='new'?'新开中…':'新开'}</button>}
  </div>:null;
  return <div className="conversation-controls-wrap">
    <div className="conversation-controls" aria-label="Model and session status">
      {data?<>
        {toolbarTarget?createPortal(toolbar,toolbarTarget):toolbar}
        {data.native_id&&cacheRate!==null&&<span className="conversation-control-cache" aria-label={`Cache hit rate ${cacheRate}%`} title="Cumulative cached input tokens divided by cumulative input tokens"><i aria-hidden="true" style={{background:`conic-gradient(${cacheColor} ${cacheRate}%, var(--border) 0)`}}/>Cache <strong style={{color:cacheColor,font:'inherit'}}>{cacheRate}%</strong></span>}
        {data.native_id&&context!==null&&<button type="button" className="conversation-control-context" aria-label="View context token details" aria-haspopup="dialog" title={`Context window: ${usage?.window?.toLocaleString()} tokens; latest request: ${usage?.last.total_tokens?.toLocaleString()} tokens (${context}% used). Click for details.`} onClick={()=>setContextOpen(true)}><i aria-hidden="true" style={{background:`conic-gradient(var(--accent) ${context}%, var(--border) 0)`}}/>Context {compact(usage!.window!)} | {context}%</button>}
        {weekly&&weeklyRemaining!==null&&<span className="conversation-control-weekly" aria-label={`Weekly remaining ${weeklyRemaining}%`} title={weekly.resets_at?`Resets: ${new Date(weekly.resets_at*1000).toLocaleString('en',{hour12:false})}`:undefined}><i aria-hidden="true" style={{background:`conic-gradient(${quotaColor(weeklyRemaining)} ${weeklyRemaining}%, var(--border) 0)`}}/>Weekly remaining <strong style={{color:quotaColor(weeklyRemaining),font:'inherit'}}>{weeklyRemaining}%</strong></span>}
        {shortLimit&&<span title={shortLimit.resets_at?`Resets: ${new Date(shortLimit.resets_at*1000).toLocaleString('en',{hour12:false})}`:undefined}>{shortLimit.minutes%60===0?`${shortLimit.minutes/60}h`:`${shortLimit.minutes}m`} remaining {Math.round(100-shortLimit.used_percent)}%</span>}
        <span className="conversation-control-environment" aria-label="Session information">
          {data.git&&<span title="Git branch and changed entries">Git {data.git.branch} · {data.git.changes?`${data.git.changes} changed`:'clean'}</span>}
          {data.cwd&&<span className="conversation-control-directory" title={`Working directory: ${data.cwd}`}>{data.cwd}</span>}
          <span title="Session status">{compacting?'Compacting':busy?'Running':data.loaded?'Waiting':'Disconnected'}</span>
          {data.permission&&<span title="Access permissions">{permissionsEn[data.permission]||data.permission}</span>}
          {data.approval&&<span title="Approval policy">Approval: {data.approval}</span>}
          {data.engine_version&&<span title="Running engine version">Engine {data.engine_version}</span>}
          {tokenMetrics.length>0&&<span aria-label="Cumulative token usage">Tokens {tokenMetrics.map(([name,value],index)=><Fragment key={name}>{index>0&&'｜'}<span title={`${tokenMetricDescriptions[name]}（${value.toLocaleString()}）`}>{name}</span></Fragment>)} : {tokenMetrics.map(([name,value],index)=><Fragment key={name}>{index>0&&'｜'}<span title={`${tokenMetricDescriptions[name]}（${value.toLocaleString()}）`}>{compact(value)}</span></Fragment>)}</span>}
          {credits?.amount!=null&&<span className="session-chat-estimated-cost conversation-total-credits" title={`按原生请求的模型和速度估算 · 费率 ${credits.rate_date??'未知'}${credits.complete?'':' · * 费率或用量覆盖不完整'}`}>Est. Cr {creditsLabel(credits)}</span>}
          {summary&&summary.status!=='complete'&&<span title={summary.reasons.map(reason=>coverageReason[reason]).join('、')||undefined}>{intervalCoverageText(summary.status,summary.reasons)}</span>}
        </span>
        {(error&&!newOpen||notice)&&<span className="conversation-control-message" role={error&&!newOpen?'alert':'status'} title={error&&!newOpen?error:notice}>{error&&!newOpen?error:notice}</span>}
        <button className="conversation-control-details" type="button" onClick={()=>setExpanded(true)}><Info size={13}/>Details</button>
        <button type="button" aria-label="Refresh session status" title="Usage updates live; other details refresh every 5 minutes" disabled={query.isFetching} onClick={refresh}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>Refresh</button>
      </>:<><span>{query.isPending?'Loading session…':'Session status unavailable'}</span>{query.isError&&<button type="button" onClick={refresh}><RefreshCw size={13}/>Retry</button>}</>}
    </div>
    {modelInfo&&model&&createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" className="conversation-model-tooltip" style={{left:modelInfo.left,top:modelInfo.top,bottom:modelInfo.bottom}}>
      <strong>{modelLabel(model)}</strong>
      <dl>
        <dt>发布时间</dt><dd>{model.release_date||'未提供'}</dd>
        <dt>{apiPricing?.reference_only?'官方 API 参考价':'计费标准'}</dt><dd>{apiPricing?.peak&&apiPricing.off_peak?<>
          {apiPricing.currency} / 百万 Token<br/><small>缓存命中 · 未命中 · 输出</small><br/>
          高峰 {apiPricing.peak.cached} · {apiPricing.peak.input} · {apiPricing.peak.output}<br/>
          空闲 {apiPricing.off_peak.cached} · {apiPricing.off_peak.input} · {apiPricing.off_peak.output}<br/>
          <small>北京时间工作日 {apiPricing.peak_hours?.map(hours=>hours.map(hour=>`${String(hour).padStart(2,'0')}:00`).join('–')).join('、')}，节假日除外</small>
        </>:apiPricing?.bands?.length?<>
          {apiPricing.currency} / 百万 Token
          {apiPricing.bands.map(({label,rates},i)=><div key={label??i}>{label&&<small>{label}<br/></small>}输入 {rates.input} · 缓存命中 {rates.cached??'未提供'} · 输出 {rates.output}{rates.cache_write_5m!==undefined&&<><br/><small>缓存写入 5 分钟 {rates.cache_write_5m} · 1 小时 {rates.cache_write_1h}</small></>}</div>)}
        </>:referenceCredits?<>Credits 每百万 Token：输入 {referenceCredits.input} · 缓存 {referenceCredits.cached} · 输出 {referenceCredits.output}<br/><small>参考费率 {referenceCredits.as_of}，非实际账单</small></>:'未提供'}</dd>
        {apiPricing?.reference_only&&<><dt>服务商倍率</dt><dd>{providerMultiplier==null?'未提供':`${providerMultiplier.toLocaleString()}×`}</dd></>}
        {providerMultiplier!=null&&standardRates&&<><dt>折算单价</dt><dd>{apiPricing?.currency} / 百万 Token<br/>
          {([['输入',standardRates.input],['缓存命中',standardRates.cached],['输出',standardRates.output],['缓存写入 5 分钟',standardRates.cache_write_5m],['缓存写入 1 小时',standardRates.cache_write_1h]] as const)
            .flatMap(([label,rate])=>rate==null?[]:[`${label} ${(rate*providerMultiplier).toLocaleString(undefined,{maximumFractionDigits:6})}`]).join(' · ')}</dd></>}
        <dt>上下文长度</dt><dd>{modelContext!=null?`${modelContext.toLocaleString()} tokens`:'未提供'}</dd>
        {model.max_output_tokens!=null&&<><dt>最大输出</dt><dd>{model.max_output_tokens.toLocaleString()} tokens</dd></>}
        {model.description&&<><dt>模型说明</dt><dd>{model.description}</dd></>}
        <dt>输入类型</dt><dd>{model.input_modalities?.length?model.input_modalities.join('、'):'未提供'}</dd>
        <dt>推理强度</dt><dd>{model.efforts.length?model.efforts.map(e=>e.value||'默认').join('、'):'未提供'}</dd>
        <dt>服务档位</dt><dd>{model.service_tiers?.length?model.service_tiers.map(t=>t.name).join('、'):'未提供'}</dd>
      </dl>
    </div>,document.body)}
    {newOpen&&<Dialog title="在当前标签页新开会话" busy={operation==='new'} onClose={()=>setNewOpen(false)}>
      <p className="text-sm leading-relaxed">{data?.supports_fresh_model?'请确认新会话使用的模型服务、模型和推理强度。':'新会话将使用当前 Agent 的默认模型设置。'}当前任务会停止，旧会话的后台终端会回收，历史消息可从“项目会话记录”重新打开。当前输入框中未发送的文字和附件会保留。</p>
      {data?.supports_fresh_model&&<><label className="mt-3 flex items-center gap-2 text-sm">新会话模型<select aria-label="新会话模型" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?choiceKey(freshPreference):''} onChange={event=>{const next=data?.models.find(m=>choiceKey(m)===event.target.value);if(next)setFreshPreference({model:next.model,...(next.provider?{provider:next.provider}:{}),effort:next.defaultEffort});}}><option value="" disabled>请选择可用模型</option>{data?.models.map(m=><option key={choiceKey(m)} value={choiceKey(m)}>{modelLabel(m)}</option>)}</select></label>
      <label className="mt-3 flex items-center gap-2 text-sm">推理强度<select aria-label="新会话推理强度" className="min-w-0 flex-1 rounded border px-2 py-1" style={{background:'var(--bg-tertiary)',borderColor:'var(--border)',color:'var(--text-primary)'}} value={freshPreference?.effort||''} onChange={event=>setFreshPreference(previous=>previous?{...previous,effort:event.target.value}:previous)}>{data?.models.find(m=>m.model===freshPreference?.model&&m.provider===freshPreference?.provider)?.efforts.map(e=><option key={e.value} value={e.value}>{effortNames[e.value]||e.value}</option>)}</select></label></>}
      {error&&<p role="alert" className="session-chat-error">{error}</p>}
      <footer className="mt-4 flex justify-end gap-3 text-sm"><button type="button" disabled={!!operation} onClick={()=>setNewOpen(false)}>取消</button><button type="button" disabled={!!operation||!!data?.supports_fresh_model&&!freshPreference} onClick={()=>void perform('new')}>{operation==='new'?'正在新开…':'停止旧会话并新开'}</button></footer>
    </Dialog>}
    {expanded&&data&&<ControlDetails key={JSON.stringify([sessionId,data.native_id])} sessionId={sessionId} metadata={summary} data={{...data,state:data.loaded?(busy||compacting?'active':'idle'):data.state}} onClose={()=>setExpanded(false)} onRefresh={refresh} refreshing={query.isFetching}/>}
    {contextOpen&&active&&data?.native_id&&<ConversationContextUsage key={`${sessionId}:${data.native_id}`} sessionId={sessionId} nativeId={data.native_id} usage={data.usage} observedAt={data.usage_observed_at} model={data.model} onClose={()=>setContextOpen(false)}/>}
  </div>;
}

const detailTabs = [
  {id:'overview',label:'概览'},
  {id:'cache',label:'缓存异常'},
  {id:'usage',label:'会话详情'},
] as const;

function ControlDetails({sessionId,metadata,data,onClose,onRefresh,refreshing}:{sessionId:string;metadata:SessionMetadata|null;data:ConversationControlsData;onClose:()=>void;onRefresh:()=>void;refreshing:boolean}) {
  const [tab,setTab]=useState<(typeof detailTabs)[number]['id']>('overview');
  const id=useId();
  const initialTab=useRef<HTMLButtonElement>(null);
  const queryClient=useQueryClient();
  const supported=!!data.agent?.capabilities.statistics;
  const query=useQuery({
    queryKey:['conversation-metadata-details',sessionId,data.native_id],
    queryFn:({signal})=>api.agent.conversationMetadata(sessionId,{},signal),
    enabled:supported,retry:false,
  });
  const result=query.data?.metadata;
  const details=result?.summary.native_id===data.native_id&&(!metadata?.generation||metadata.generation===result.summary.generation)?result:null;
  const summary=details&&(!metadata||details.summary.revision>metadata.revision)?details.summary:metadata;
  useEffect(()=>{
    if(!metadata||!result||metadata.revision<=result.summary.revision)return;
    const timer=setTimeout(()=>void query.refetch(),500);
    return()=>clearTimeout(timer);
  },[metadata?.revision,result?.summary.revision,query.refetch]);
  const state=data.state==='active'?'执行中':data.state==='idle'?'等待输入':data.state==='notLoaded'?'未接入实时控制':data.state;
  const loading=supported&&query.isFetching&&!details;
  const error=query.isError&&!details?'无法读取会话统计':undefined;
  const retry=()=>void query.refetch();
  const pages = {
    overview: <ConversationDetailsPanel usage={data.usage} model={data.model} state={state} statusTitle={data.warning} metadata={summary}/>,
    cache: <ConversationCacheHistory key={details?.summary.generation??data.native_id} sessionId={sessionId}
      details={details} loading={loading} error={error} onRetry={retry}/>,
    usage: <ConversationUsageHistory sessionId={sessionId} nativeId={data.native_id} details={details}
      generation={summary?.generation} revision={summary?.revision}
      active={tab==='usage'} supported={supported} loading={loading} error={error} onRetry={retry}/>,
  };
  function navigateTabs(event:KeyboardEvent<HTMLDivElement>) {
    const current=detailTabs.findIndex(option=>option.id===tab);
    const next=event.key==='Home'?0:event.key==='End'?detailTabs.length-1
      :event.key==='ArrowRight'?(current+1)%detailTabs.length
      :event.key==='ArrowLeft'?(current+detailTabs.length-1)%detailTabs.length:-1;
    if(next<0)return;
    event.preventDefault();
    setTab(detailTabs[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  function refreshDetails() {
    onRefresh();
    if(!supported)return;
    retry();
    void queryClient.invalidateQueries({queryKey:['conversation-usage-intervals',sessionId,data.native_id]});
  }
  const refreshingDetails=refreshing||query.isFetching;
  return <Dialog title="会话详情" size="image" width={1120} maxWidth="calc(100vw - 32px)"
    className={`conversation-details-dialog${tab==='usage'?' conversation-usage-dialog':''}`} initialFocus={initialTab} onClose={onClose}
    actions={<button className="conversation-preview-dock" type="button" onClick={refreshDetails} disabled={refreshingDetails}><RefreshCw size={14} className={refreshingDetails?'animate-spin':''}/>刷新</button>}>
    <div className="conversation-detail-tabs" role="tablist" aria-label="会话详情分类" onKeyDown={navigateTabs}>
      {detailTabs.map(option=><button type="button" role="tab" id={`${id}-${option.id}-tab`} key={option.id}
        aria-controls={`${id}-${option.id}-panel`} aria-selected={tab===option.id} tabIndex={tab===option.id?0:-1}
        ref={option.id==='overview'?initialTab:undefined} onClick={()=>setTab(option.id)}>
        {option.label}{option.id==='cache'&&summary&&<span className="conversation-cache-count" aria-hidden="true">{summary.cache_drop_count}</span>}
      </button>)}
    </div>
    {detailTabs.map(option=><section className="conversation-detail-page" role="tabpanel" key={option.id}
      id={`${id}-${option.id}-panel`} aria-labelledby={`${id}-${option.id}-tab`} hidden={tab!==option.id} tabIndex={0}>
      {pages[option.id]}
    </section>)}
  </Dialog>;
}
