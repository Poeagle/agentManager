import WebSocket from 'ws';
import {nativeInteraction,nativeInteractionAnswer,conversationAsyncQuestions,conversationQuestionReply,type ConversationInteraction} from './conversation-interactions.js';
import {homedir} from 'os';
import {join} from 'path';
import {randomUUID} from 'crypto';
import {conversationImagePaths,formatConversationInput,type ConversationAttachment} from './conversation-attachments.js';
import {extractAgentMessages} from './prompt-context.js';
import {conversationMessageId,type ConversationMessage} from './conversation-reader.js';
import {conversationErrorMessage} from './conversation-error.js';
import {conversationActivity,type ConversationActivity} from './conversation-activity.js';

export type ConversationStreamFrame =
  | {type:'settings';model:string;effort:string|null}
  | {type:'snapshot';messages:ConversationMessage[];interactions:ConversationInteraction[];activities:ConversationActivity[];busy:boolean;connected:true;turn_id:string|null;started_at:string|null;completed_at:string|null;stage:'waiting'|'tools'|'answering'|'finishing'|'idle'}
  | {type:'unavailable';reason:string;reconnect?:boolean};

type CodexRequest = (method:string,params:unknown)=>Promise<any>;

export async function withCodexConnection<T>(action:(request:CodexRequest,server:{userAgent:string|null})=>Promise<T>):Promise<T> {
  const path=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET;
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
    if(frame.error) waiting.reject(new Error('Codex 会话请求失败'));else waiting.resolve(frame.result);
  });
  const rejectPending=()=>{for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('Codex 连接已关闭'));}pending.clear();};
  socket.on('close',rejectPending);socket.on('error',rejectPending);
  try {
    await opened;
    const initialized=await request('initialize',{clientInfo:{name:'octoally-terminal',version:'1.0.0'},capabilities:{experimentalApi:true}});
    socket.send(JSON.stringify({method:'initialized'}));
    return await action(request,{userAgent:typeof initialized?.userAgent==='string'?initialized.userAgent:null});
  } finally {rejectPending();if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close();}
}

/** Submit the initial turn once. The terminal attaches to this exact thread
 * without resubmitting input. An empty thread has no resumable rollout yet. */
export async function createStreamingCodexThread(cwd:string,task:string):Promise<string> {
  return withCodexConnection(async request=>{
    const result=await request('thread/start',{cwd,approvalPolicy:'never',sandbox:'danger-full-access'});
    const id=result.thread?.id;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Codex 未返回原生会话标识');
    await request('turn/start',{threadId:id,input:[{type:'text',text:task,text_elements:[]}]});
    return id;
  });
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

/** Conversation text goes to the same engine, independently of terminal UI
 * menus, focus, and transport suspension. Embedded CLIs retain their PTY path. */
export async function submitStreamingCodexInput(threadId:string,text:string,clientId?:string,attachments:ConversationAttachment[]=[]):Promise<boolean> {
  return withCodexConnection(async request=>{
    const current=await request('thread/read',{threadId});
    if(current.thread?.status?.type==='notLoaded') return false;
    await request('turn/start',{threadId,clientUserMessageId:clientId||randomUUID(),input:[{type:'text',text:formatConversationInput(text,attachments),text_elements:[]},...attachments.filter(item=>item.kind==='image').map(item=>({type:'localImage',path:item.path}))]});
    return true;
  });
}

/** Observe an already loaded Codex thread. Never start a thread or a turn. */
export function observeCodexConversation(threadId:string,emit:(frame:ConversationStreamFrame)=>void) {
  const path=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET
    || join(process.env.CODEX_HOME||join(homedir(),'.codex'),'app-server-control','app-server-control.sock');
  const socket=new WebSocket(`ws+unix://${path}:/`,{maxPayload:2*1024*1024,handshakeTimeout:4000});
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const items=new Map<string,{message:ConversationMessage;phase:string|null}>();
  const activities=new Map<string,ConversationActivity>();
  const interactions=new Map<string,{card:ConversationInteraction;nativeId:number|string;params:any}>();
  let next=0,closed=false,busy=false;
  let turnId:string|null=null,startedAt:string|null=null,completedAt:string|null=null;
  let stage:'waiting'|'tools'|'answering'|'finishing'|'idle'='idle';
  let revision=0;
  let retry:ReturnType<typeof setTimeout>|undefined;
  let flush:ReturnType<typeof setTimeout>|undefined;
  function snapshot() {
    flush=undefined;
    if(!closed) emit({type:'snapshot',interactions:[...interactions.values()].map(entry=>entry.card),messages:[...items.values()].filter(item=>item.message.text.length>0).map(item=>item.message),activities:[...activities.values()],busy,connected:true,turn_id:turnId,started_at:startedAt,completed_at:completedAt,stage});
  }
  function changed() {if(!flush) flush=setTimeout(snapshot,10);}
  function request(method:string,params:unknown):Promise<any> {
    const id=++next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex 事件连接超时'));},6000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
  }
  function unavailable(reconnect=false) {if(!closed) emit({type:'unavailable',reconnect,reason:'当前会话尚未连接实时事件，已完成的回复仍会自动更新。'});}
  function reportError(id:string,error:unknown,willRetry:boolean,timestamp:string|null) {
    const message=conversationErrorMessage(id,error,willRetry,timestamp);if(!message)return;
    items.delete(`error:${message.id}`);items.set(`error:${message.id}`,{message,phase:'error'});
    if(!willRetry)interactions.clear();
    busy=willRetry;stage=willRetry?'waiting':'idle';
    for(const item of items.values())if(item.message.streaming)item.message={...item.message,streaming:false};
    changed();
  }
  function acceptActivity(item:any,completed:boolean,baseline=false) {
    const activity=conversationActivity(item,completed,activities.get(item?.id),baseline?null:Date.now());
    if(!activity)return;
    activities.set(activity.id,activity);
    if(activities.size>8)activities.delete(activities.keys().next().value!);
    changed();
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
    items.set(item.id,{phase:item.phase??previous?.phase??null,message:{
      id:conversationMessageId(turnId,role,item.id),role,turn_id:turnId,
      ...(role==='assistant'?{phase:item.phase==='final_answer'?'final' as const:'commentary' as const}:{}),
      ...(reply?{question_replies:reply.answers}:{}),
      ...(role==='assistant'&&conversationAsyncQuestions(item)?{async_questions:conversationAsyncQuestions(item)}:{}),
      ...(typeof item.clientId==='string'?{client_id:item.clientId}:{}),
      ...(role==='user'?{image_paths:conversationImagePaths(item.content)}:{}),
      text:text.slice(0,128*1024),timestamp:previous?.message.timestamp || (timestamp===null?null:new Date(timestamp??Date.now()).toISOString()),streaming:role==='assistant' && streaming,
    }});
    changed();
  }
  async function attach() {
    try {
      const current=await request('thread/read',{threadId});
      if(closed) return;
      // Embedded CLI engines cannot be observed through a different daemon.
      // Do not load a second engine from their rollout just to obtain events.
      if(current.thread?.status?.type==='notLoaded') {unavailable();retry=setTimeout(()=>void attach(),2000);return;}
      await request('thread/resume',{threadId,excludeTurns:true});
      if(closed) return;
      const baselineRevision=revision;
      const baseline=await request('thread/turns/list',{threadId,limit:1,itemsView:'full'});
      if(closed) return;
      for(const turn of baseline.data||[]) {
        if(revision!==baselineRevision && ((turnId && turnId!==turn.id) || (busy && turn.status!=='inProgress'))) continue;
        const sameTurn=turnId===turn.id;
        busy=turn.status==='inProgress';
        turnId=turn.id;startedAt=typeof turn.startedAt==='number'?new Date(turn.startedAt*1000).toISOString():null;
        completedAt=typeof turn.completedAt==='number'?new Date(turn.completedAt*1000).toISOString():null;
        if(!busy)stage='idle';else if(!sameTurn || stage==='idle')stage='waiting';
        if(busy) for(const item of turn.items||[]) {
          acceptActivity(item,['completed','failed','declined'].includes(item.status) || typeof item.completedAtMs==='number',true);
          const streaming=item===(turn.items||[]).at(-1) && item.type==='agentMessage' && !item.completedAtMs;
          acceptItem(item,turn.id,streaming,typeof item.startedAtMs==='number'?item.startedAtMs:typeof item.completedAtMs==='number'?item.completedAtMs:null);
          if(item.type==='agentMessage' && item.text?.length) stage=streaming?'answering':item.phase==='final_answer'?'finishing':'tools';
          else if(['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','contextCompaction'].includes(item.type))stage='tools';
        }
        if(turn.error)reportError(turn.id,turn.error,false,typeof turn.completedAt==='number'?new Date(turn.completedAt*1000).toISOString():null);
        // The baseline is an ordered prefix; fresh events may already have
        // inserted later items while the request was in flight.
        const ordered=new Map<string,{message:ConversationMessage;phase:string|null}>();
        for(const item of turn.items||[]) {const value=items.get(item.id);if(value)ordered.set(item.id,value);}
        for(const [id,value] of items)if(!ordered.has(id))ordered.set(id,value);
        items.clear();for(const [id,value] of ordered)items.set(id,value);
      }
      snapshot();
    } catch {unavailable();if(!closed && socket.readyState===WebSocket.OPEN) retry=setTimeout(()=>void attach(),3000);}
  }
  socket.on('open',()=>{
    void request('initialize',{clientInfo:{name:'octoally-conversation',version:'1.0.0'},capabilities:{experimentalApi:true}}).then(()=>{
      if(closed) return;socket.send(JSON.stringify({method:'initialized'}));return attach();
    }).catch(()=>unavailable());
  });
  socket.on('message',bytes=>{
    let frame:any;try{frame=JSON.parse(bytes.toString());}catch{return;}
    const waiting=!frame.method?pending.get(frame.id):undefined;
    if(waiting) {pending.delete(frame.id);clearTimeout(waiting.timer);if(frame.error) waiting.reject(new Error('Codex 事件接口不可用'));else waiting.resolve(frame.result);return;}
    const data=frame.params;
    if(data?.threadId!==threadId) return;
    if(frame.method==='thread/settings/updated'&&typeof data.threadSettings?.model==='string') {
      if(!closed)emit({type:'settings',model:data.threadSettings.model,effort:data.threadSettings.effort??null});return;
    }
    if(frame.method==='serverRequest/resolved') {interactions.delete(JSON.stringify(data.requestId));changed();return;}
    const card=nativeInteraction(frame,threadId);
    if(card) {if(!interactions.has(card.id))interactions.set(card.id,{card,nativeId:frame.id,params:data});changed();return;}
    if(!['turn/started','item/started','item/completed','item/agentMessage/delta','turn/completed','error'].includes(frame.method))return;
    revision++;
    if(frame.method==='turn/started') {
      items.clear();activities.clear();interactions.clear();busy=true;completedAt=null;turnId=data.turn?.id||null;
      startedAt=typeof data.turn?.startedAt==='number'?new Date(data.turn.startedAt*1000).toISOString():new Date().toISOString();
      stage='waiting';changed();
    }
    else if(frame.method==='item/started'||frame.method==='item/completed') {
      acceptActivity({...data.item,...(typeof data.startedAtMs==='number'?{startedAtMs:data.startedAtMs}:{}),...(typeof data.completedAtMs==='number'?{completedAtMs:data.completedAtMs}:{})},frame.method==='item/completed');
      acceptItem(data.item,data.turnId,frame.method==='item/started',data.startedAtMs||data.completedAtMs);
      if(data.item?.type==='agentMessage' && data.item.text?.length) stage=frame.method==='item/completed'?(data.item.phase==='final_answer'?'finishing':'tools'):'answering';
      else if(frame.method==='item/started' && ['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','contextCompaction'].includes(data.item?.type)) {stage='tools';changed();}
    }
    else if(frame.method==='item/agentMessage/delta') {
      const item=items.get(data.itemId);
      if(item && typeof data.delta==='string') {item.message={...item.message,text:(item.message.text+data.delta).slice(0,128*1024),streaming:true};if(data.delta.length)stage='answering';changed();}
    } else if(frame.method==='error') {
      if(typeof data.turnId==='string' && (!turnId || turnId===data.turnId))reportError(data.turnId,data.error,data.willRetry===true,new Date().toISOString());
    } else if(frame.method==='turn/completed') {
      if(turnId && data.turn?.id && turnId!==data.turn.id)return;
      completedAt=typeof data.turn?.completedAt==='number'?new Date(data.turn.completedAt*1000).toISOString():new Date().toISOString();
      interactions.clear();busy=false;stage='idle';for(const item of items.values()) item.message={...item.message,streaming:false};
      if(data.turn?.error)reportError(data.turn.id,data.turn.error,false,typeof data.turn.completedAt==='number'?new Date(data.turn.completedAt*1000).toISOString():new Date().toISOString());
      changed();
    }
  });
  const lost=()=>{if(closed)return;clearTimeout(retry);clearTimeout(flush);for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(new Error('事件连接已关闭'));}pending.clear();unavailable(true);closed=true;};
  socket.on('error',lost);socket.on('close',lost);
  const stop=()=>{
    closed=true;clearTimeout(retry);clearTimeout(flush);
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
