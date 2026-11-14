import '../components/SettingsPanel.css';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,ApiError,type SendGuardCheck,type SendGuardPayload} from './api';
import type {CompactionPresentation} from './use-conversation-compaction';
import {estimatedServerNow,formatDisplayTimestamp} from './display-clock';
import {Dialog} from '../components/Dialog';
interface Confirmation {token:string;nativeId:string|null}
interface Pending {sessionId:string;payload:SendGuardPayload;resolve:(result:Confirmation|null)=>void;reject:(error:unknown)=>void;controller:AbortController;check:SendGuardCheck|null;phase:'checking'|'choice'|'compacting'|'new'|'unknown';detached?:boolean;error?:string;startedAt?:number}
export function useConversationSendGuard(sessionId:string,active:boolean,compaction:{state:CompactionPresentation|null;start:()=>Promise<void>},onNew?:()=>Promise<void>){
 const current=useRef<Pending|null>(null),[view,setView]=useState<Pending|null>(null);
 const publish=useCallback((p:Pending)=>{if(current.current===p)setView({...p});},[]);
 const finish=useCallback((p:Pending,token:string|null)=>{if(current.current!==p)return;current.current=null;setView(null);p.controller.abort();p.resolve(token===null?null:{token,nativeId:p.check?.native_id??null});},[]);
 async function confirm(payload:SendGuardPayload):Promise<Confirmation|null>{
  if(current.current)return null;
  return new Promise((resolve,reject)=>{
   const p:Pending={sessionId,payload,resolve,reject,controller:new AbortController(),check:null,phase:'checking'};current.current=p;publish(p);
   const timeout=setTimeout(()=>p.controller.abort(),15000);
   void api.agent.checkSend(sessionId,payload,p.controller.signal).then(check=>{if(current.current!==p)return;p.check=check;if(!check.needs_confirmation){finish(p,check.token);return;}p.phase='choice';publish(p);}).catch(error=>{if(current.current===p){current.current=null;setView(null);reject(error);}}).finally(()=>clearTimeout(timeout));
  });
 }
 const recheck=useCallback(async(p:Pending,fresh=false)=>{if(current.current!==p)return;const timeout=setTimeout(()=>p.controller.abort(),15000);try{const check=await api.agent.checkSend(sessionId,p.payload,p.controller.signal);if(p.detached&&check.native_id!==p.check?.native_id)throw Error('原生会话已变化，消息尚未发送，草稿已保留');if(fresh&&(!check.native_id||check.native_id===p.check?.native_id))throw Error('新会话身份尚未确认，消息未发送，请关闭后核对会话状态。');p.check=check;finish(p,check.token);}catch(error){if(current.current===p){p.phase='unknown';p.error=error instanceof Error?error.message:'会话状态未确认，消息尚未发送，草稿已保留';publish(p);}}finally{clearTimeout(timeout);}},[sessionId,finish,publish]);
 async function choose(action:'continue'|'compact'|'new'){
  const p=current.current;if(!p||p.phase!=='choice'||!p.check)return;
  if(action==='continue'){finish(p,p.check.token);return;}
  p.detached=action==='compact';p.phase=action==='compact'?'compacting':'new';p.error=undefined;p.startedAt=estimatedServerNow();publish(p);
  try{if(action==='compact')await compaction.start();else{await onNew?.();if(p.phase==='new')await recheck(p,true);}}
  catch(error){if(current.current!==p)return;p.phase=error instanceof ApiError&&(error.submission==='rejected'||error.status>=400&&error.status<500)?'choice':'unknown';p.error=error instanceof Error?error.message:'操作结果未确认，草稿已保留';publish(p);}
 }
 useEffect(()=>{
  const p=current.current,state=compaction.state;if(!p||p.phase!=='compacting'||!state)return;
  if(state.status==='completed'&&state.completed_at&&Date.parse(state.completed_at)>=(p.startedAt||0)){p.phase='checking';publish(p);void recheck(p);}
  else if(['unknown','rejected','failed','interrupted'].includes(state.status)){p.phase=state.status==='rejected'?'choice':'unknown';p.error=state.error||'压缩结果未确认，消息尚未发送，草稿已保留';publish(p);}
 },[compaction.state,recheck,publish]);
 useEffect(()=>{
  const p=current.current;if(!p||!['compacting','new'].includes(p.phase))return;
  const timer=setTimeout(()=>{if(current.current===p&&['compacting','new'].includes(p.phase)){p.phase='unknown';p.error='操作结果暂未确认，消息尚未发送，草稿已保留。请核对会话状态。';publish(p);}},120000);
  return()=>clearTimeout(timer);
 },[view?.phase,publish]);
 useEffect(()=>{if(!active&&current.current&&!current.current.detached)finish(current.current,null);},[active,finish]);
 useEffect(()=>()=>{const p=current.current;current.current=null;if(p){p.controller.abort();p.resolve(null);}},[sessionId]);
 const check=view?.sessionId===sessionId?view.check:null;
 const notice=view?.detached&&check?<div className="session-chat-guard-status" role={view.error?'alert':'status'}><span>{view.error|| (view.phase==='checking'?'压缩完成，正在检查后发送…':'正在压缩，确认完成后自动发送。')}</span><button type="button" onClick={()=>{if(current.current)finish(current.current,null);}}>{view.error?'关闭提示':'取消后续发送'}</button></div>:null;
 const dialog=view&&!view.detached&&check?<Dialog title="发送前检查" size="lg" busy={view.phase==='new'} onClose={()=>{if(current.current)finish(current.current,null);}}>
  <p className="text-sm" style={{color:'var(--text-secondary)'}}>{check.matched===null?'部分会话用量或闲置状态无法核实。':'当前会话达到平台设置的上下文提醒条件。'}请选择如何发送；草稿会保留到实际提交。</p>
  <dl className="my-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs"><dt>当前上下文 / 窗口</dt><dd>{check.context_tokens??'未知'} / {check.context_window??'未知'} Token</dd><dt>窗口占用</dt><dd>{check.context_percent===null?'未知':`${check.context_percent.toFixed(1)}%`}</dd><dt>上轮结束后闲置</dt><dd>{check.idle_minutes===null?'未知':`${Math.floor(check.idle_minutes)} 分钟`}</dd><dt>用量采集时间</dt><dd>{formatDisplayTimestamp(check.observed_at)}</dd></dl>
  <p className="text-xs" style={{color:'var(--text-muted)'}}>这是发送风险提醒，缓存是否仍可复用无法由闲置时间准确判断。</p>
  {view.phase==='new'&&<p role="status" className="my-3 text-xs">正在创建新会话，确认成功后发送。</p>}
  {view.error&&<p role="alert" className="my-3 text-xs" style={{color:'var(--error)'}}>{view.error}</p>}
  <div className="mt-4 flex flex-wrap justify-end gap-2"><button className="settings-panel-button" disabled={view.phase==='new'} onClick={()=>{if(current.current)finish(current.current,null);}}>取消</button><button className="settings-panel-button" disabled={view.phase!=='choice'||!check.can_new||!onNew} onClick={()=>void choose('new')}>新开后发送</button><button className="settings-panel-button" disabled={view.phase!=='choice'||!check.can_compact} onClick={()=>void choose('compact')}>压缩后发送</button><button className="settings-panel-button settings-panel-button--primary" disabled={view.phase!=='choice'} onClick={()=>void choose('continue')}>原样发送</button></div>
  {(!check.can_compact||!check.can_new)&&<p className="mt-2 text-xs" style={{color:'var(--text-muted)'}}>压缩和新开沿用现有会话权限，并要求当前轮次已结束。</p>}
 </Dialog>:null;
 return {confirm,background:!!view&&view.sessionId===sessionId&&!!view.detached&&['compacting','checking'].includes(view.phase),blocking:!!view&&view.sessionId===sessionId,checking:view?.sessionId===sessionId&&view.phase==='checking',dialog,notice};
}
