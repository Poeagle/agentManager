import '../components/SettingsPanel.css';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,ApiError,type SendGuardCheck,type SendGuardPayload,type AgentModelPreference} from './api';
import type {CompactionPresentation} from './use-conversation-compaction';
import {estimatedServerNow,formatDisplayTimestamp} from './display-clock';
import {Dialog} from '../components/Dialog';
import {parseBriefContext,prepareBriefSend} from './conversation-brief-context';
import {BriefOptions} from '../components/ConversationBriefOptions';
import {SEND_GUARD_ACTION_LABELS,type SendGuardAction} from '../../../server/src/shared/send-guard';
const estimateAmount = new Intl.NumberFormat('en', {maximumSignificantDigits:3});
const estimateTokens = new Intl.NumberFormat('en');
const billingUnits:Record<string,string> = {USD:'美元',CNY:'元',credits:'Credits'};

function cacheMissWarning(estimate: SendGuardCheck['cache_miss_estimate']) {
 if(!estimate)return '原样发送的额外消耗暂无法量化，实际费用取决于本次缓存命中。';
 const {tokens,cost}=estimate;
 const amount=cost
  ? `按上次费率约多 ${estimateAmount.format(cost.amount)} ${billingUnits[cost.unit]??cost.unit}`
  : '金额暂无法估算';
 return `原样发送时，若上次命中的缓存这次全部失效，约有 ${estimateTokens.format(tokens)} 个输入 Token 改按普通输入计费，${amount}。`;
}

interface Confirmation {token:string;nativeId:string|null;payload:SendGuardPayload}
interface Pending {sessionId:string;payload:SendGuardPayload;resolve:(result:Confirmation|null)=>void;reject:(error:unknown)=>void;controller:AbortController;check:SendGuardCheck|null;phase:'checking'|'choice'|'select'|'preparing'|'compacting'|'new'|'unknown';action?:SendGuardAction;automatic?:SendGuardAction;error?:string;startedAt?:number}
export function useConversationSendGuard(sessionId:string,active:boolean,compaction:{state:CompactionPresentation|null;start:(expectedNativeId?:string)=>Promise<void>},onNew?:(expectedNativeId?:string,preference?:AgentModelPreference,environmentId?:string)=>Promise<string|void>){
 const current=useRef<Pending|null>(null),[view,setView]=useState<Pending|null>(null);
 const publish=useCallback((p:Pending)=>{if(current.current===p)setView({...p});},[]);
 const finish=useCallback((p:Pending,token:string|null)=>{if(current.current!==p)return;current.current=null;setView(null);p.controller.abort();p.resolve(token===null?null:{token,nativeId:p.check?.native_id??null,payload:p.payload});},[]);
 async function confirm(payload:SendGuardPayload,preferredAction?:'brief'):Promise<Confirmation|null>{
  if(current.current)return null;
  return new Promise((resolve,reject)=>{
   const p:Pending={sessionId,payload,resolve,reject,controller:new AbortController(),check:null,phase:'checking'};current.current=p;publish(p);
   const timeout=setTimeout(()=>p.controller.abort(),15000);
   void api.agent.checkSend(sessionId,payload,p.controller.signal).then(check=>{if(current.current!==p)return;p.check=check;
    if(check.required_action){
     p.automatic=check.required_action;
     p.action=check.required_action;
     p.phase='choice';
     const canRun=p.automatic==='compact'?check.can_compact:check.can_new&&!!onNew;
     const missingAccount=check.switch_account&&!check.target_account;
     if(!canRun||!check.native_id||missingAccount){
      p.phase='unknown';
      const reason=canRun&&missingAccount?'当前账号额度已用尽，且没有可确认有剩余额度的其他账号':'当前会话暂不能执行该操作';
      p.error=`自动${SEND_GUARD_ACTION_LABELS[p.automatic]}未执行，${reason}，草稿已保留。`;
      publish(p);
      return;
     }
     void choose(p.automatic,{environmentId:check.target_account?.id});
     return;
    }
    // Disabled send protection does not collect runtime; the new-session
    // endpoint still checks identity, permissions and idle state itself.
    if(preferredAction==='brief'){if((check.enabled&&!check.can_new)||!check.native_id||!onNew)throw Error('当前会话暂不能简要压缩，请等待任务结束并确认权限。');p.phase='choice';publish(p);void choose('brief');return;}
    if(!check.needs_confirmation){finish(p,check.token);return;}p.phase='choice';publish(p);}).catch(error=>{if(current.current===p){current.current=null;setView(null);reject(error);}}).finally(()=>clearTimeout(timeout));
  });
 }
 const recheck=useCallback(async(p:Pending,fresh=false,expectedFreshId?:string)=>{
  if(current.current!==p)return;
  const timeout=setTimeout(()=>p.controller.abort(),15000);
  try{
   const check=await api.agent.checkSend(sessionId,p.payload,p.controller.signal);
   if(p.action&&!fresh&&check.native_id!==p.check?.native_id)
    throw Error('原生会话已变化，消息尚未发送，草稿已保留');
   if(fresh&&(!check.native_id||check.native_id===p.check?.native_id||expectedFreshId&&check.native_id!==expectedFreshId))
    throw Error('新会话身份尚未确认，消息未发送，请关闭后核对会话状态。');
   if(check.required_action)throw Error('处理后仍命中自动规则，消息尚未发送，草稿已保留。');
   if(p.check?.switch_account&&(check.account_remaining_percent===null||check.account_remaining_percent<=0))
    throw Error('无法确认新账号有剩余额度，消息尚未发送，草稿已保留。');
   if(!check.token)throw Error('发送确认未取得，草稿已保留。');
   p.check=check;
   finish(p,check.token);
  }catch(error){
   if(current.current!==p)return;
   p.phase='unknown';
   p.error=error instanceof Error?error.message:'会话状态未确认，消息尚未发送，草稿已保留';
   publish(p);
  }finally{clearTimeout(timeout);}
 },[sessionId,finish,publish]);
 async function choose(action:'continue'|'compact'|'new'|'brief',options?:{preference?:AgentModelPreference;environmentId?:string}){
  const p=current.current;if(!p||p.phase!=='choice'||!p.check)return;
  if(action==='continue'){finish(p,p.check.token);return;}
  if(action==='brief'&&!options){p.phase='select';publish(p);return;}
  const originalPayload=p.payload,originalNativeId=p.check.native_id;
  p.action=action;p.phase=action==='compact'?'compacting':action==='brief'?'preparing':'new';p.error=undefined;p.startedAt=estimatedServerNow();publish(p);
  try{
   if(action==='compact')await (p.automatic&&originalNativeId?compaction.start(originalNativeId):compaction.start());
   else {
    if(action==='brief'){
     if(!originalNativeId)throw Error('原生会话身份未知，无法读取历史。');
     if(parseBriefContext(p.payload.input))throw Error('草稿已有关联的简要历史，请移除后重试。');
     p.payload=await prepareBriefSend(sessionId,originalNativeId,p.payload,p.controller.signal);
     if(current.current!==p||p.phase!=='preparing')return;
     p.phase='new';publish(p);
    }
    const bindFresh=action==='brief'||!!p.automatic;
    const freshId=bindFresh
     ? options?.preference||options?.environmentId
      ? await onNew?.(originalNativeId??undefined,options.preference,options.environmentId)
      : await onNew?.(originalNativeId??undefined)
     : await onNew?.(originalNativeId??undefined);
    if(current.current===p&&p.phase==='new'){
     if(bindFresh&&!freshId)throw Error('新会话身份尚未确认，消息尚未发送，草稿已保留。');
     p.phase='checking';publish(p);
     await recheck(p,true,freshId||undefined);
    }
   }
  }catch(error){
   if(current.current!==p)return;
   const rejected=p.phase==='preparing'||error instanceof ApiError&&(error.submission==='rejected'||error.status>=400&&error.status<500);
   if(rejected){p.payload=originalPayload;if(p.controller.signal.aborted)p.controller=new AbortController();}
   p.phase=rejected?'choice':'unknown';p.error=error instanceof Error?error.message:'操作结果未确认，草稿已保留';publish(p);
  }
 }
 useEffect(()=>{
  const p=current.current,state=compaction.state;if(!p||p.phase!=='compacting'||!state)return;
  if(state.status==='completed'&&state.completed_at&&Date.parse(state.completed_at)>=(p.startedAt||0)){p.phase='checking';publish(p);void recheck(p);}
  else if(['unknown','rejected','failed','interrupted'].includes(state.status)){p.phase=state.status==='rejected'?'choice':'unknown';p.error=state.error||'压缩结果未确认，消息尚未发送，草稿已保留';publish(p);}
 },[compaction.state,recheck,publish]);
 useEffect(()=>{
  const p=current.current;if(!p||!['preparing','compacting','new'].includes(p.phase))return;
  const timer=setTimeout(()=>{if(current.current===p&&['preparing','compacting','new'].includes(p.phase)){p.phase='unknown';p.controller.abort();p.error='操作结果暂未确认，消息尚未发送，草稿已保留。请核对会话状态。';publish(p);}},120000);
  return()=>clearTimeout(timer);
 },[view?.phase,publish]);
 useEffect(()=>{if(!active&&current.current&&!current.current.action)finish(current.current,null);},[active,finish]);
 useEffect(()=>()=>{const p=current.current;current.current=null;if(p){p.controller.abort();p.resolve(null);}},[sessionId]);
 const check=view?.sessionId===sessionId?view.check:null;
 const showDialog=active&&view&&check&&!view.automatic&&(!view.action||view.action!=='compact'&&(view.phase==='choice'||view.phase==='select'));
 const checking=view?.phase==='checking';
 const createdStatus='新会话已创建，正在检查后发送…';
 const briefStatus=view?.phase==='preparing'?'正在整理已有对话记录…':checking?createdStatus:'正在创建新会话，确认完成后发送简要历史。';
 const newStatus=checking?createdStatus:'正在创建新会话，确认完成后发送。';
 const compactStatus=checking?'压缩完成，正在检查后发送…':'正在压缩，确认完成后自动发送。';
 const notice=view?.action&&check&&!showDialog?<div className="session-chat-guard-status" role={view.error?'alert':'status'}>
  <span>{view.error||<>
   {view.automatic&&`自动${SEND_GUARD_ACTION_LABELS[view.automatic]} · `}
   {check.target_account&&`${check.target_account.label} · `}
   {view.action==='brief'?briefStatus:view.action==='new'?newStatus:compactStatus}
  </>}</span>
  <button type="button" onClick={()=>{if(current.current)finish(current.current,null);}}>{view.error?'关闭提示':'取消后续发送'}</button>
 </div>:null;
 const dialog=showDialog?(view.phase==='select'?<BriefOptions sessionId={sessionId} onCancel={()=>{if(current.current)finish(current.current,null);}} onConfirm={options=>{const p=current.current;if(p&&p.phase==='select'){p.phase='choice';void choose('brief',options);}}}/>:<Dialog title="发送前检查" size="lg" onClose={()=>{if(current.current)finish(current.current,null);}}>
  <p className="text-sm" style={{color:'var(--text-secondary)'}}>{check.matched===null?'部分会话用量或闲置状态无法核实。':check.matched?'当前会话达到平台设置的发送提醒条件。':''}请选择如何发送；草稿会保留到实际提交。</p>
  <dl className="my-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs"><dt>当前上下文 / 窗口</dt><dd>{check.context_tokens??'未知'} / {check.context_window??'未知'} Token</dd><dt>窗口占用</dt><dd>{check.context_percent===null?'未知':`${check.context_percent.toFixed(1)}%`}</dd><dt>上轮结束后闲置</dt><dd>{check.idle_minutes===null?'未知':`${Math.floor(check.idle_minutes)} 分钟`}</dd><dt>用量采集时间</dt><dd>{formatDisplayTimestamp(check.observed_at)}</dd>{typeof check.account_remaining_percent==='number'&&<><dt>账号额度剩余</dt><dd>{check.account_remaining_percent}%</dd></>}</dl>
  {check.needs_confirmation&&<p className="text-sm font-medium" style={{color:'var(--error)'}}>
   {cacheMissWarning(check.cache_miss_estimate)}
  </p>}
  {check.can_new&&onNew&&<p className="text-xs" style={{color:'var(--text-muted)'}}>新会话就绪后，平台会永久删除旧会话记录和 Agent 原始对话文件。</p>}
  {view.error&&<p role="alert" className="my-3 text-xs" style={{color:'var(--error)'}}>{view.error}</p>}
  <div className="mt-4 flex flex-wrap justify-end gap-2"><button className="settings-panel-button" onClick={()=>{if(current.current)finish(current.current,null);}}>取消</button><button className="settings-panel-button" disabled={view.phase!=='choice'||!check.can_new||!onNew} onClick={()=>void choose('new')}>新开后发送</button><button className="settings-panel-button" title="整理已有输入、结论和少量过程，在新会话中发送" disabled={view.phase!=='choice'||!check.can_new||!onNew||!!parseBriefContext(view.payload.input)} onClick={()=>void choose('brief')}>简要压缩后发送</button><button className="settings-panel-button" disabled={view.phase!=='choice'||!check.can_compact} onClick={()=>void choose('compact')}>压缩后发送</button><button className="settings-panel-button settings-panel-button--primary" disabled={view.phase!=='choice'} onClick={()=>void choose('continue')}>原样发送</button></div>
  {(!check.can_compact||!check.can_new)&&<p className="mt-2 text-xs" style={{color:'var(--text-muted)'}}>压缩和新开沿用现有会话权限，并要求当前轮次已结束。</p>}
 </Dialog>):null;
 return {confirm,background:!!view&&view.sessionId===sessionId&&!!view.action&&['preparing','compacting','new','checking'].includes(view.phase),blocking:!!view&&view.sessionId===sessionId,checking:view?.sessionId===sessionId&&view.phase==='checking',dialog,notice};
}
