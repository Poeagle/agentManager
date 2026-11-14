import {rememberCodexTitle} from './thread-title.js';
import {submissionFailure} from '../submission.js';
import {rememberCodexSettings} from './settings-state.js';
import {currentCodexEngine,rememberCodexThread} from './engine-context.js';
import {readCodexBaseline,markOversizedBaseline} from './baseline.js';
import {readCodexQueue,ownCodexQueuedInput,startOwnedCodexQueue} from './queue.js';
import WebSocket from 'ws';
import {nativeInteraction,nativeInteractionAnswer,conversationAsyncQuestions,conversationQuestionReply,type ConversationInteraction} from '../../conversation-interactions.js';
import {homedir} from 'os';
import {join} from 'path';
import {randomUUID,createHash} from 'crypto';
import {conversationImagePaths,nativeConversationInput,type ConversationAttachment} from '../../conversation-attachments.js';
import {extractAgentMessages} from '../../prompt-context.js';
import {conversationMessageId,type ConversationMessage} from '../../conversation-reader.js';
import {conversationErrorMessage} from '../../conversation-error.js';
import {conversationActivity,type ConversationActivity} from '../../conversation-activity.js';
import {nativeUsageFrame} from '../../conversation-usage.js';
import {getDb} from '../../../db/index.js';
import {setLiveCodexRuntime,clearLiveCodexRuntime,rememberLiveCodexInput,liveCodexInput,rememberCodexQuestionReply,syncQueuedCodexQuestionReplies} from './runtime-signals.js';
import type {CodexState} from './runtime.js';

import type {AgentCompaction as ConversationCompaction,AgentStreamFrame as ConversationStreamFrame} from '../events.js';
export type {AgentCompaction as ConversationCompaction,AgentStreamFrame as ConversationStreamFrame} from '../events.js';

/** Native public reason only; strip common credential forms and URL queries. */
export function publicCodexRpcMessage(value:string):string {
 return (value.replace(/(?:Bearer\s+)[^\s"']+/gi,'Bearer [redacted]')
  .replace(/((?:api[_-]?key|token|password|authorization)\s*[:=]\s*)[^\s,;"']+/gi,'$1[redacted]')
  .replace(/https?:\/\/[^\s"']+/g,url=>{try{const u=new URL(url);u.username='';u.password='';u.search='';u.hash='';return u.toString();}catch{return '[URL]';}})
  .replace(/sk-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,1000)) || '原生 Codex 暂未接受此操作，请稍后重试';
}
export class CodexRpcError extends Error {readonly submission='rejected';constructor(readonly nativeMessage:string){super(publicCodexRpcMessage(nativeMessage));}}
type CodexRequest = (method:string,params:unknown)=>Promise<any>;

export async function withCodexConnection<T>(action:(request:CodexRequest,server:{userAgent:string|null})=>Promise<T>):Promise<T> {
  const path=currentCodexEngine().socket;
  if(!path) throw new Error('Codex stream socket is not configured');
  const socket=new WebSocket(`ws+unix://${path}:/`,{maxPayload:2*1024*1024,handshakeTimeout:4000});
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let next=0;
  const request:CodexRequest=(method,params)=>new Promise((resolve,reject)=>{
    const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex 会话请求超时'));},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const opened=new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',()=>reject(new Error('无法连接独立 Codex 服务')));});
  socket.on('message',bytes=>{
    let frame:any;try{frame=JSON.parse(bytes.toString());}catch{return;}
    const waiting=!frame.method?pending.get(frame.id):undefined;if(!waiting)return;pending.delete(frame.id);clearTimeout(waiting.timer);
    if(frame.error) waiting.reject(new CodexRpcError(typeof frame.error.message==='string'?frame.error.message.slice(0,1000):''));else {if(frame.result?.thread)rememberCodexThread(frame.result.thread);waiting.resolve(frame.result);}
  });
  const rejectPending=()=>{for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Codex 连接已关闭'));}pending.clear();};
  socket.on('close',rejectPending);socket.on('error',rejectPending);
  try {
    await opened;
    const initialized=await request('initialize',{clientInfo:{name:'octoally-terminal',version:'1.0.0'},capabilities:{experimentalApi:true,optOutNotificationMethods:['item/commandExecution/outputDelta','item/fileChange/outputDelta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded']}});
    socket.send(JSON.stringify({method:'initialized'}));
    return await action(request,{userAgent:typeof initialized?.userAgent==='string'?initialized.userAgent:null});
  } finally {rejectPending();if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close();}
}

/** Flush native storage without a user message or a model turn so the TUI
 * can resume the otherwise empty thread after this RPC connection closes. */
export async function persistIdleCodexThread(request:CodexRequest,id:string):Promise<void> {
  await request('thread/inject_items',{threadId:id,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'A fresh conversation was opened in this platform tab. Wait for the user to provide a task. Previous conversation history has not been carried over.'}]}]});
  const verified=await request('thread/resume',{threadId:id,excludeTurns:true});
  if(verified.thread?.id!==id||verified.thread?.status?.type==='notLoaded')throw Error('新会话尚不可恢复');
}

/** Create the thread without a model turn when no initial task was supplied.
 * The terminal attaches to the same native identity. */
export async function createStreamingCodexThread(cwd:string,task:string,sharedInstructions?:string,preference?:import('../types.js').ModelPreference|null,initialClientId?:string):Promise<string> {
  return withCodexConnection(async request=>{
    if (!preference) await (await import('./controls.js')).assertCodexLaunchModel(request);
    const result=await request('thread/start',{cwd,approvalPolicy:'never',sandbox:'danger-full-access',...(sharedInstructions?{developerInstructions:sharedInstructions}:{}),...(preference?{model:preference.model,...preference.provider?{modelProvider:preference.provider}:{},config:{model_reasoning_effort:preference.effort},...preference.service_tier?{serviceTier:preference.service_tier}:{}}:{})});
    const id=result.thread?.id;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Codex 未返回原生会话标识');
    if(!task.trim()){
      try{await persistIdleCodexThread(request,id);}catch(error){await request('thread/archive',{threadId:id}).catch(()=>{});throw error;}
    }else await request('turn/start',{threadId:id,...initialClientId?{clientUserMessageId:initialClientId}:{},input:[{type:'text',text:task,text_elements:[]}],...(preference?{model:preference.model,effort:preference.effort,...preference.service_tier?{serviceTier:preference.service_tier}:{}}:{})});
    if(sharedInstructions)rememberStreamingSharedResources(id,sharedInstructions);
    return id;
  });
}

/** Refresh discovery configuration on an explicit reload, without a model turn. */
const sharedContextFingerprints = new Map<string, string>();
const sharedContextUpdates=new Map<string,Promise<void>>();
export function rememberStreamingSharedResources(threadId:string,instructions:string){
  const key=`${currentCodexEngine().socket}:${threadId}`,hash=createHash('sha256').update(instructions).digest('hex');
  sharedContextFingerprints.set(key,hash);
  if(sharedContextFingerprints.size>1000)sharedContextFingerprints.delete(sharedContextFingerprints.keys().next().value!);
  try{getDb().prepare(`INSERT INTO shared_resource_injections(scope_key,content_hash) VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET content_hash=excluded.content_hash`).run(key,hash);}catch{/* The native context remains valid even when its local dedup journal is unavailable. */}
}
export async function configureStreamingSharedResources(threadId: string, instructions: string): Promise<void> {
  const key = `${currentCodexEngine().socket}:${threadId}`;
  const fingerprint = createHash('sha256').update(instructions).digest('hex');
  const work=(sharedContextUpdates.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
  let known=sharedContextFingerprints.get(key);
  if(!known)try{known=(getDb().prepare('SELECT content_hash FROM shared_resource_injections WHERE scope_key=?').get(key) as {content_hash:string}|undefined)?.content_hash;}catch{/* In-memory dedup remains available without a journal. */}
  if (known === fingerprint) return;
  await withCodexConnection(async request => {
    await request('thread/resume', { threadId, excludeTurns: true });
    // A loaded thread can ignore configuration overrides on resume. Append
    // developer context explicitly; it is durable and never a user message.
    await request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }] });
  });
  rememberStreamingSharedResources(threadId,instructions);
  });sharedContextUpdates.set(key,work);
  try{await work;}finally{if(sharedContextUpdates.get(key)===work)sharedContextUpdates.delete(key);}
}

/** Closing a terminal client leaves its remote engine alive; explicit session
 * cancellation must interrupt that engine before detaching the terminal. */
export async function interruptStreamingCodexThread(threadId:string) {
  await withCodexConnection(async request=>{
    const current=await request('thread/read',{threadId});
    if(current.thread?.status?.type!=='active')return;
    const turns=await request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
    const turn=turns.data?.find((item:any)=>item.status==='inProgress');
    if(turn) await request('turn/interrupt',{threadId,turnId:turn.id});
  });
}

/** Interrupt only the native turn observed by the caller. */
export async function stopStreamingCodexTurn(threadId:string,turnId:string):Promise<boolean> {
  return withCodexConnection(async request=>{
    const current=await request('thread/read',{threadId});
    if(current.thread?.status?.type!=='active')return false;
    const turns=await request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
    if(!turns.data?.some((turn:any)=>turn.id===turnId&&turn.status==='inProgress'))return false;
    await request('turn/interrupt',{threadId,turnId});
    return true;
  });
}

/** Conversation text goes to the same engine, independently of terminal UI
 * menus, focus, and transport suspension. Embedded CLIs retain their PTY path. */
type SubmissionResult=boolean|'queued';
const acceptedInputs=new Map<string,{promise:Promise<SubmissionResult>;fingerprint:string}>();
export function submitStreamingCodexInput(threadId:string,text:string,clientId?:string,attachments:ConversationAttachment[]=[]):Promise<SubmissionResult> {
  const identity=clientId||randomUUID(),key=JSON.stringify([currentCodexEngine().socket,threadId,identity]),fingerprint=JSON.stringify([text,attachments]);
  const existing=acceptedInputs.get(key);if(existing)return existing.fingerprint===fingerprint?existing.promise:Promise.reject(new CodexRpcError('Client input identity has different contents'));
  let dispatched=false;
  const operation=withCodexConnection(async request=>{
    const live=liveCodexInput(threadId);
    if(live?.clients.has(identity))return true;
    const current=live?.turnId?{thread:{status:{type:'active'}}}:await request('thread/read',{threadId});
    if(current.thread?.status?.type==='notLoaded')return false;
    const input=nativeConversationInput(text,attachments);
    const queue=async()=>{
      const existing=await readCodexQueue(request,threadId);
      if(existing.data?.some((entry:any)=>entry.clientUserMessageId===identity))return 'queued' as const;
      ownCodexQueuedInput(threadId,identity);
      dispatched=true;
      try{await request('thread/queue/add',{threadId,clientUserMessageId:identity,input});}
      catch(error){if(error instanceof CodexRpcError)ownCodexQueuedInput(threadId,identity,true);throw error;}
      ownCodexQueuedInput(threadId,identity);
      const started=await startOwnedCodexQueue(request,threadId).catch(()=>null);
      return started===identity?true:'queued' as const;
    };
    const submit=async()=>{dispatched=true;await request('turn/start',{threadId,clientUserMessageId:identity,input});return true;};
    try {
      if(current.thread?.status?.type==='active'){
        // A summary retains user receipts but excludes unbounded tool output.
        // Full histories can exceed the transport limit before any input is sent.
        const latest=live?.turnId?{data:[{id:live.turnId,status:'inProgress',items:[]}]}:await request('thread/turns/list',{threadId,limit:1,itemsView:'summary'});
        const turn=latest.data?.[0];
        if(turn?.items?.some((item:any)=>item.type==='userMessage'&&item.clientId===identity))return true;
        if(turn?.status==='inProgress'&&typeof turn.id==='string'){
          dispatched=true;
          try{const receipt=await request('turn/steer',{threadId,expectedTurnId:turn.id,clientUserMessageId:identity,input});if(typeof receipt.turnId!=='string')throw Error('原生追加结果尚未确认');return true;}
          catch(error){
            if(!(error instanceof CodexRpcError))throw error;
            dispatched=false;
            // Native precondition rejection is definitive; starting now is safe
            // if the observed turn finished/changed while preparing the input.
            if(/no active turn to steer|expected active turn id/i.test(error.nativeMessage))return submit();
            throw error;
          }
        }
      }
      return await submit();
    }catch(error){
      // Only an explicit rejection permits a second delivery path. Ordinary
      // running work is steered immediately, never put behind the whole turn.
      if(error instanceof CodexRpcError&&/cannot steer a compact turn|busy compacting|compact.*(?:active|running|progress)|already.*(?:turn|running|processing)|(?:turn|thread).*(?:active|running|busy)/i.test(error.nativeMessage)){
        dispatched=false;return queue();
      }
      throw error;
    }
  }).catch(error=>{throw submissionFailure(error,dispatched);});
  acceptedInputs.set(key,{promise:operation,fingerprint});
  void operation.then(result=>{if(!result)acceptedInputs.delete(key);else rememberCodexQuestionReply(threadId,identity,text,result==='queued');},()=>acceptedInputs.delete(key));
  if(acceptedInputs.size>512)acceptedInputs.delete(acceptedInputs.keys().next().value!);
  return operation;
}

/** Observe an already loaded Codex thread. Never start a thread or a turn. */
export function observeCodexConversation(threadId:string,emit:(frame:ConversationStreamFrame)=>void,onFailure?:(turnId:string,error:unknown,willRetry:boolean)=>void,options:{incremental?:boolean}={}) {
  const path=currentCodexEngine().socket
    || join(process.env.CODEX_HOME||join(homedir(),'.codex'),'app-server-control','app-server-control.sock');
  const socket=new WebSocket(`ws+unix://${path}:/`,{maxPayload:2*1024*1024,handshakeTimeout:4000});
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const items=new Map<string,{message:ConversationMessage;phase:string|null}>();
  const activities=new Map<string,ConversationActivity>();
  const interactions=new Map<string,{card:ConversationInteraction;nativeId:number|string;params:any}>();
  let next=0,closed=false,busy=false;
  const runtimeSource=randomUUID();let finishedState:CodexState='unknown';
  let turnId:string|null=null,startedAt:string|null=null,completedAt:string|null=null;
  let stage:'waiting'|'tools'|'answering'|'finishing'|'idle'='idle';
  let compaction:ConversationCompaction|null=null;
  let revision=0;
  let retry:ReturnType<typeof setTimeout>|undefined;
  let flush:ReturnType<typeof setTimeout>|undefined;
  let lastUsageFingerprint:string|undefined;
  let full=true,lastState='';const publicItems=new Map<string,string>();const dirty=new Set<string>(),deltas=new Map<string,{id:string;offset:number;text:string}>();
  function snapshot() {
    clearTimeout(flush);
    flush=undefined;
    if(!closed&&(busy||finishedState!=='unknown')){rememberLiveCodexInput(threadId,runtimeSource,busy?turnId:null);setLiveCodexRuntime(threadId,runtimeSource,[...interactions.values()].some(entry=>entry.card.blocking&&!entry.card.submitted)?'waiting_for_input':busy?'running':finishedState);}
    if(closed)return;
    const state={interactions:[...interactions.values()].map(entry=>entry.card),activities:[...activities.values()],compaction,busy,connected:true as const,turn_id:turnId,started_at:startedAt,completed_at:completedAt,stage};
    const fingerprint=JSON.stringify(state);
    if(!options.incremental||full){emit({type:'snapshot',...state,messages:[...items.values()].filter(item=>item.message.text.length>0).map(item=>item.message)});full=false;}
    else{
      const upserts=[...dirty].map(id=>items.get(publicItems.get(id)!)?.message).filter((message):message is ConversationMessage=>!!message&&message.text.length>0);
      const appended=[...deltas.values()].filter(delta=>!dirty.has(delta.id));
      if(upserts.length||appended.length||lastState!==fingerprint)emit({type:'patch',upserts,deltas:appended,...lastState!==fingerprint?{state}:{}});
    }
    dirty.clear();deltas.clear();lastState=fingerprint;
  }
  function changed(immediate=false){if(immediate){clearTimeout(flush);snapshot();}else if(!flush)flush=setTimeout(snapshot,25);}
  function applyNativeState(state:unknown) {
    if(!['idle','active','systemError'].includes(String(state)))return;
    busy=state==='active';
    if(state==='systemError')finishedState='failed';else if(state==='idle'&&finishedState==='unknown')finishedState='idle';
    if(!busy){if(compaction?.status==='running')compaction={...compaction,status:state==='systemError'?'failed':'interrupted',completed_at:new Date().toISOString()};stage='idle';for(const item of items.values())if(item.message.streaming){item.message={...item.message,timestamp:null,streaming:false};dirty.add(item.message.id);}}
    changed(true);
  }
  async function syncNativeState() {
    const before=revision;
    try {
      const response=await request('thread/read',{threadId});
      if(!closed&&before===revision)applyNativeState(response.thread?.status?.type);
    }catch{/* The state event stream or next reconnect can recover. */}
  }
  function request(method:string,params:unknown):Promise<any> {
    const id=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex 事件连接超时'));},6000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
  }
  function unavailable(reconnect=false) {if(!closed) emit({type:'unavailable',reconnect,reason:'当前会话尚未连接实时事件，已完成的回复仍会自动更新。'});}
  function reportError(id:string,error:unknown,willRetry:boolean,timestamp:string|null,live=false) {
    const message=conversationErrorMessage(id,error,willRetry,timestamp);if(!message)return;
    if(live)onFailure?.(id,error,willRetry);
    items.delete(`error:${message.id}`);items.set(`error:${message.id}`,{message,phase:'error'});dirty.add(message.id);publicItems.set(message.id,`error:${message.id}`);
    if(!willRetry)interactions.clear();
    if(!willRetry&&compaction?.status==='running')compaction={...compaction,status:'failed',completed_at:timestamp};
    busy=willRetry;finishedState=willRetry?'unknown':'failed';stage=willRetry?'waiting':'idle';
    for(const item of items.values())if(item.message.streaming){item.message={...item.message,timestamp,streaming:false};dirty.add(item.message.id);}
    changed(true);
  }
  function acceptActivity(item:any,completed:boolean,baseline=false) {
    const activity=conversationActivity(item,completed,activities.get(item?.id),baseline?null:Date.now());
    if(!activity)return;
    if(item.type==='contextCompaction')compaction={...activity};
    activities.set(activity.id,activity);
    if(activities.size>8)activities.delete(activities.keys().next().value!);
    changed();
  }
  let queueReading=false,queueAgain=false;
  async function readQueue(){
    if(queueReading){queueAgain=true;return;}queueReading=true;
    try{do{queueAgain=false;
    try{
      const result=await readCodexQueue(request,threadId);
      if(closed)return;if(queueAgain)continue;
      const messages:ConversationMessage[]=(result.data||[]).filter((item:any)=>typeof item.clientUserMessageId==='string'&&Array.isArray(item.input)).map((item:any)=>{
        const rawText=extractAgentMessages([{type:'response_item',payload:{type:'message',role:'user',content:item.input.filter((part:any)=>part.type==='text').map((part:any)=>({type:'input_text',text:part.text}))}}],'codex',128*1024)[0]?.text||'';
        const reply=conversationQuestionReply(rawText);
        return {id:`queued-${item.clientUserMessageId}`,role:'user' as const,client_id:item.clientUserMessageId,queued:true,timestamp:null,
          text:reply?.text??rawText,...reply?{question_replies:reply.answers}:{},image_paths:conversationImagePaths(item.input)};
      });
      syncQueuedCodexQuestionReplies(threadId,messages);emit({type:'queue',messages});
    }catch{/* Older native servers may not expose queued submissions. */}
    }while(queueAgain&&!closed);}finally{queueReading=false;}
  }
  function acceptItem(item:any,turnId:string,streaming:boolean,timestamp?:number|null) {
    if(!['agentMessage','userMessage'].includes(item?.type)||typeof item.id!=='string'||typeof turnId!=='string') return;
    const role=item.type==='userMessage'?'user':'assistant';
    const previous=items.get(item.id);
    const rawText=role==='user'?extractAgentMessages([{type:'response_item',payload:{type:'message',role:'user',content:(item.content||[]).filter((part:any)=>part.type==='text').map((part:any)=>({type:'input_text',text:part.text}))}}],'codex',128*1024)[0]?.text||'':typeof item.text==='string'?item.text:'';
    const reply=role==='user'?conversationQuestionReply(rawText):undefined;
    const text=reply?.text??rawText;
    // A reconnect baseline can arrive after fresh deltas on the same socket.
    if(previous && streaming && (previous.message.text.length>text.length || (!previous.message.streaming && previous.message.text.length>=text.length))) return;
    const nativePhase=item.phase==='final_answer'||item.phase==='final'?'final':item.phase==='commentary'?'commentary':previous?.phase??null;
    items.set(item.id,{phase:nativePhase,message:{
      id:conversationMessageId(turnId,role,item.id),role,turn_id:turnId,
      ...(role==='assistant'?{phase:nativePhase==='final'?'final' as const:'commentary' as const}:{}),
      ...(reply?{question_replies:reply.answers}:{}),
      ...(role==='assistant'&&conversationAsyncQuestions(item)?{async_questions:conversationAsyncQuestions(item)}:{}),
      ...(typeof item.clientId==='string'?{client_id:item.clientId}:{}),
      ...(role==='user'?{image_paths:conversationImagePaths(item.content)}:{}),
      text:text.slice(0,128*1024),timestamp:role==='assistant'&&!streaming?(timestamp===null?null:new Date(timestamp??Date.now()).toISOString()):previous?.message.timestamp || (timestamp===null?null:new Date(timestamp??Date.now()).toISOString()),streaming:role==='assistant' && streaming,
    }});
    if(role==='user'&&typeof item.clientId==='string')rememberLiveCodexInput(threadId,runtimeSource,busy?turnId:null,item.clientId);
    const publicId=conversationMessageId(turnId,role,item.id);dirty.add(publicId);publicItems.set(publicId,item.id);
    if(items.size>256){const oldest=[...items.entries()].find(([,value])=>!value.message.streaming);if(oldest){items.delete(oldest[0]);publicItems.delete(oldest[1].message.id);dirty.delete(oldest[1].message.id);deltas.delete(oldest[1].message.id);}}
    changed();
  }
  function finalizeImplicitAssistant() {
    // A normal turn completion is the lifecycle proof for releases that omit
    // `phase` on the last AgentMessage. Explicit commentary remains progress.
    const last=[...items.entries()].reverse().find(([,value])=>value.message.role==='assistant'&&value.message.phase!=='error');
    if(!last||last[1].phase!==null)return;
    items.set(last[0],{phase:'final',message:{...last[1].message,phase:'final'}});
    dirty.add(last[1].message.id);
  }
  async function attach() {
    try {
      const current=await request('thread/read',{threadId});
      if(closed) return;
      // Embedded CLI engines cannot be observed through a different daemon.
      // Do not load a second engine from their rollout just to obtain events.
      if(current.thread?.status?.type==='notLoaded') {unavailable();retry=setTimeout(()=>void attach(),2000);return;}
      const settings=await request('thread/resume',{threadId,excludeTurns:true});rememberCodexSettings(threadId,settings);
      if(closed) return;
      void readQueue();
      const baselineRevision=revision;
      const baseline=await readCodexBaseline(request,threadId);
      if(closed) return;
      for(const turn of baseline.data||[]) {
        const newer=revision!==baselineRevision;
        if(newer&&turnId&&turnId!==turn.id)continue;
        const sameTurn=turnId===turn.id;
        if(!newer){
          busy=turn.status==='inProgress';
          if(!busy)finishedState=turn.status==='failed'?'failed':turn.status==='interrupted'?'interrupted':'idle';
          turnId=turn.id;startedAt=typeof turn.startedAt==='number'?new Date(turn.startedAt*1000).toISOString():null;
          completedAt=typeof turn.completedAt==='number'?new Date(turn.completedAt*1000).toISOString():null;
          if(!busy)stage='idle';else if(!sameTurn || stage==='idle')stage='waiting';
        }
        // A recovery response is an older prefix. It may fill missing items,
        // but cannot replace text, activities or completion already seen live.
        if(busy||newer) for(const item of turn.items||[]) {
          if(newer&&(items.has(item.id)||activities.has(item.id)))continue;
          if(!newer||busy){
            // Recover missing activities even if unrelated live events arrived
            // during the baseline read; known live items were excluded above.
            acceptActivity(item.type==='contextCompaction'&&(turn.items||[]).length===1&&typeof turn.startedAt==='number'?{...item,startedAtMs:turn.startedAt*1000}:item,['completed','failed','declined'].includes(item.status) || typeof item.completedAtMs==='number' || item.type==='contextCompaction'&&item!==(turn.items||[]).at(-1),true);
          }
          const streaming=!newer&&item===(turn.items||[]).at(-1) && item.type==='agentMessage' && !item.completedAtMs;
          acceptItem(item,turn.id,streaming,!streaming&&item.type==='agentMessage'?(typeof item.completedAtMs==='number'?item.completedAtMs:null):typeof item.startedAtMs==='number'?item.startedAtMs:typeof item.completedAtMs==='number'?item.completedAtMs:null);
          if(newer)continue;
          if(item.type==='agentMessage' && item.text?.length) stage=streaming?'answering':item.phase==='final_answer'?'finishing':'tools';
          else if(['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','contextCompaction'].includes(item.type))stage='tools';
        }
        if(!busy&&!newer)for(const item of turn.items||[])if(item.type==='contextCompaction'){acceptActivity(item,true,true);if(compaction&&turn.status==='interrupted')compaction={...compaction,status:'interrupted'};}
        if(turn.error&&!newer)reportError(turn.id,turn.error,false,typeof turn.completedAt==='number'?new Date(turn.completedAt*1000).toISOString():null);
        // The baseline is an ordered prefix; fresh events may already have
        // inserted later items while the request was in flight.
        const ordered=new Map<string,{message:ConversationMessage;phase:string|null}>();
        for(const item of turn.items||[]) {const value=items.get(item.id);if(value)ordered.set(item.id,value);}
        for(const [id,value] of items)if(!ordered.has(id))ordered.set(id,value);
        items.clear();for(const [id,value] of ordered)items.set(id,value);
      }
      snapshot();
      void syncNativeState();
      if(!busy&&finishedState==='idle')void startOwnedCodexQueue(request,threadId).catch(()=>{});
    } catch {if(!closed){unavailable(true);socket.close();}}
  }
  socket.on('open',()=>{
    void request('initialize',{clientInfo:{name:'octoally-conversation',version:'1.0.0'},capabilities:{experimentalApi:true,optOutNotificationMethods:['item/commandExecution/outputDelta','item/fileChange/outputDelta','item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded']}}).then(()=>{
      if(closed) return;socket.send(JSON.stringify({method:'initialized'}));return attach();
    }).catch(()=>{unavailable(true);socket.close();});
  });
  socket.on('message',bytes=>{
    let frame:any;try{frame=JSON.parse(bytes.toString());}catch{return;}
    const waiting=!frame.method?pending.get(frame.id):undefined;
    if(waiting) {pending.delete(frame.id);clearTimeout(waiting.timer);if(frame.error) waiting.reject(new Error('Codex 事件接口不可用'));else {if(frame.result?.thread)rememberCodexThread(frame.result.thread);waiting.resolve(frame.result);}return;}
    const data=frame.params;
    if(data?.threadId!==threadId) return;
    if(frame.method==='thread/name/updated'){rememberCodexTitle(threadId,data.threadName,currentCodexEngine().environmentId??'native');return;}
    if(frame.method==='thread/queue/changed'){void readQueue();return;}
    if(frame.method==='thread/tokenUsage/updated') {
      const usage=nativeUsageFrame(threadId,data.tokenUsage);
      if(usage&&!closed) {
        const fingerprint=JSON.stringify(usage.usage);
        if(fingerprint!==lastUsageFingerprint){lastUsageFingerprint=fingerprint;emit(usage);}
      }
      return;
    }
    if(frame.method==='thread/status/changed') {revision++;applyNativeState(data.status?.type);if(data.status?.type==='idle')void startOwnedCodexQueue(request,threadId).catch(()=>{});return;}
    if(frame.method==='thread/compacted') {void syncNativeState();return;}
    if(frame.method==='thread/settings/updated'&&typeof data.threadSettings?.model==='string') {
      rememberCodexSettings(threadId,data.threadSettings);
      if(!closed)emit({type:'settings',model:data.threadSettings.model,effort:data.threadSettings.effort??null,...Object.hasOwn(data.threadSettings,'serviceTier')?{service_tier:data.threadSettings.serviceTier}:{}});return;
    }
    if(frame.method==='serverRequest/resolved') {interactions.delete(JSON.stringify(data.requestId));changed();return;}
    const card=nativeInteraction(frame,threadId);
    if(card) {if(!interactions.has(card.id))interactions.set(card.id,{card,nativeId:frame.id,params:data});changed();return;}
    if(!['turn/started','item/started','item/completed','item/agentMessage/delta','turn/completed','error'].includes(frame.method))return;
    revision++;
    if(frame.method==='turn/started') {
      // A queued next turn can start before the text batch is emitted. Flush
      // the prior turn first so its accepted user message cannot disappear.
      if(flush){clearTimeout(flush);snapshot();}
      items.clear();publicItems.clear();dirty.clear();deltas.clear();full=true;activities.clear();compaction=null;interactions.clear();busy=true;completedAt=null;turnId=data.turn?.id||null;
      finishedState='unknown';
      startedAt=typeof data.turn?.startedAt==='number'?new Date(data.turn.startedAt*1000).toISOString():new Date().toISOString();
      stage='waiting';changed(true);
    }
    else if(frame.method==='item/started'||frame.method==='item/completed') {
      if(data.item?.type==='contextCompaction'&&frame.method==='item/started'){busy=true;stage='tools';}
      acceptActivity({...data.item,...(typeof data.startedAtMs==='number'?{startedAtMs:data.startedAtMs}:{}),...(typeof data.completedAtMs==='number'?{completedAtMs:data.completedAtMs}:{})},frame.method==='item/completed');
      acceptItem(data.item,data.turnId,frame.method==='item/started',frame.method==='item/completed'?(data.completedAtMs??data.item?.completedAtMs??Date.now()):(data.startedAtMs??data.item?.startedAtMs));
      if(data.item?.type==='agentMessage' && data.item.text?.length) stage=frame.method==='item/completed'?(data.item.phase==='final_answer'?'finishing':'tools'):'answering';
      else if(frame.method==='item/started' && ['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','contextCompaction'].includes(data.item?.type)) {stage='tools';changed();}
      if(frame.method==='item/completed'&&data.item?.type==='contextCompaction')void syncNativeState();
    }
    else if(frame.method==='item/agentMessage/delta') {
      if(typeof data.itemId!=='string'||typeof data.delta!=='string')return;
      if(!items.has(data.itemId)&&typeof data.turnId==='string')acceptItem({type:'agentMessage',id:data.itemId,text:''},data.turnId,true);
      const item=items.get(data.itemId);
      if(item){const offset=item.message.text.length,text=data.delta.slice(0,Math.max(0,128*1024-offset));
        if(!text.length)return;
        item.message={...item.message,text:item.message.text+text,streaming:true};
        if(offset===0)dirty.add(item.message.id); // Empty starts are omitted from public frames; seed the first visible text.
        const pending=deltas.get(item.message.id);deltas.set(item.message.id,{id:item.message.id,offset:pending?.offset??offset,text:(pending?.text||'')+text});
        if(text.length)stage='answering';changed();}
    } else if(frame.method==='error') {
      if(typeof data.turnId==='string' && (!turnId || turnId===data.turnId))reportError(data.turnId,data.error,data.willRetry===true,new Date().toISOString(),true);
    } else if(frame.method==='turn/completed') {
      if(turnId && data.turn?.id && turnId!==data.turn.id)return;
      const completed=data.turn?.status===undefined||data.turn?.status==='completed';
      completedAt=typeof data.turn?.completedAt==='number'?new Date(data.turn.completedAt*1000).toISOString():new Date().toISOString();
      // A completed compaction is its own step. Later turn completion must not
      // extend its duration or make an old completion look newly finished.
      if(compaction?.status==='running'){const status=data.turn?.status==='interrupted'?'interrupted':data.turn?.status==='failed'?'failed':'completed';compaction={...compaction,status,completed_at:completedAt,duration_ms:compaction.started_at?Math.max(0,Date.parse(completedAt!)-Date.parse(compaction.started_at)):compaction.duration_ms};}
      interactions.clear();busy=false;stage='idle';
      if(completed)finalizeImplicitAssistant();
      for(const item of items.values())if(item.message.streaming){item.message={...item.message,timestamp:completedAt,streaming:false};dirty.add(item.message.id);}
      finishedState=data.turn?.status==='failed'?'failed':data.turn?.status==='interrupted'?'interrupted':'idle';
      if(finishedState==='idle')void startOwnedCodexQueue(request,threadId).catch(()=>{});
      if(data.turn?.error)reportError(data.turn.id,data.turn.error,false,typeof data.turn.completedAt==='number'?new Date(data.turn.completedAt*1000).toISOString():new Date().toISOString(),true);
      changed(true);
    }
    if(frame.method==='item/completed'||frame.method==='item/started')changed(true);
  });
  const lost=()=>{if(closed)return;clearTimeout(retry);clearTimeout(flush);for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('事件连接已关闭'));}pending.clear();unavailable(true);closed=true;clearLiveCodexRuntime(threadId,runtimeSource);};
  socket.on('error',(error:any)=>{if(error?.code==='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH')markOversizedBaseline(threadId);lost();});socket.on('close',code=>{if(code===1009)markOversizedBaseline(threadId);lost();});
  let alive=true;socket.on('pong',()=>{alive=true;});const heartbeat=setInterval(()=>{if(closed)return;if(!alive){socket.terminate();return;}if(socket.readyState===WebSocket.OPEN){alive=false;socket.ping();}},25000);heartbeat.unref?.();
  socket.once('close',()=>clearInterval(heartbeat));
  const stop=()=>{clearInterval(heartbeat);
    closed=true;clearTimeout(retry);clearTimeout(flush);clearLiveCodexRuntime(threadId,runtimeSource);
    for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('事件订阅已结束'));}pending.clear();
    if(socket.readyState===WebSocket.CONNECTING) socket.terminate();else socket.close();
  };
  return Object.assign(stop,{respond:(id:string,answer:unknown)=>{
    const entry=interactions.get(id);
    if(closed||socket.readyState!==WebSocket.OPEN)throw new Error('实时连接已断开，请重新连接后处理');
    if(!entry||entry.card.submitted)throw new Error('该请求已提交或已失效，请等待最新状态');
    const result=nativeInteractionAnswer(entry.card,entry.params,answer);
    entry.card={...entry.card,submitted:true};
    try {socket.send(JSON.stringify({id:entry.nativeId,result}));}catch {entry.card={...entry.card,submitted:false};throw new Error('提交失败，请检查连接');}
    changed();
  }});
}
