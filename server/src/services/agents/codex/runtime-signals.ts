import {currentCodexEngine} from './engine-context.js';
import type {CodexRuntime,CodexState} from './runtime.js';
import {conversationQuestionReply} from '../../conversation-interactions.js';

// Reuse existing native subscriptions and submission acknowledgements. Never
// infer delivery from a browser optimistic message or add a polling connection.
const listeners=new Set<(nativeId:string)=>void>();
const executions=new Map<string,Map<string,{state:CodexState;order:number}>>();
const replies=new Map<string,{native:string;client:string;ids:string[];queued:boolean;at:number}>();
let order=0;
const changed=(native:string)=>{for(const listener of listeners)listener(native);};
export function subscribeCodexRuntimeSignals(listener:(nativeId:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function setLiveCodexRuntime(native:string,source:string,state:CodexState){
 const sources=executions.get(native)||new Map();if(sources.get(source)?.state===state)return;
 sources.set(source,{state,order:++order});executions.set(native,sources);changed(native);
}
export function clearLiveCodexRuntime(native:string,source:string){
 for(const [key,value] of inputStates)if(value.source===source)inputStates.delete(key);
 const sources=executions.get(native);if(!sources?.delete(source))return;
 if(!sources.size)executions.delete(native);changed(native);
}
export function rememberCodexQuestionReply(native:string,client:string,text:string,queued:boolean){
 const answer=conversationQuestionReply(text);if(!answer)return;
 const key=JSON.stringify([native,client]),ids=answer.answers.map(item=>item.question_id),previous=replies.get(key);
 if(previous&&previous.queued===queued&&JSON.stringify(previous.ids)===JSON.stringify(ids))return;
 replies.set(key,{native,client,ids,queued,at:Date.now()});
 while(replies.size>512)replies.delete(replies.keys().next().value!);changed(native);
}
export function syncQueuedCodexQuestionReplies(native:string,messages:Array<{client_id?:string;question_replies?:Array<{question_id:string}>}>){
 const clients=new Set(messages.map(message=>message.client_id));let updated=false;
 for(const [key,reply] of replies)if(reply.native===native&&reply.queued&&!clients.has(reply.client)){replies.delete(key);updated=true;}
 for(const message of messages){
  if(!message.client_id||!message.question_replies?.length)continue;
  const key=JSON.stringify([native,message.client_id]),ids=message.question_replies.map(answer=>answer.question_id),previous=replies.get(key);
  if(previous?.queued&&JSON.stringify(previous.ids)===JSON.stringify(ids))continue;
  replies.set(key,{native,client:message.client_id,ids,queued:true,at:Date.now()});updated=true;
 }
 while(replies.size>512)replies.delete(replies.keys().next().value!);
 if(updated)changed(native);
}
export function projectCodexRuntime(runtime:CodexRuntime):CodexRuntime {
 const native=runtime.session_id;if(!native)return runtime;
 const accepted=new Set<string>(),queued=new Set<string>();
 for(const [key,reply] of replies){
  if(Date.now()-reply.at>30*60*1000){replies.delete(key);continue;}
  if(reply.native===native)for(const id of reply.ids){accepted.add(id);if(reply.queued)queued.add(id);}
 }
 const groups=(runtime.pending_questions||[]).map(group=>({...group,questions:group.questions.filter(question=>!question.id||!accepted.has(question.id))})).filter(group=>group.questions.length);
 let latest:{state:CodexState;order:number}|undefined;
 for(const signal of executions.get(native)?.values()||[])if(!latest||signal.order>latest.order)latest=signal;
 const state=runtime.state==='ready'&&latest?.state==='idle'&&!runtime.completed_turn_id?'ready':latest?.state??runtime.state;
 return {...runtime,state,...latest?{source:'codex_stream' as const,reason:'依据 Codex 实时执行事件及原生记录'}:{},pending_questions:groups,pending_question_count:groups.reduce((count,group)=>count+group.questions.length,0),submitted_question_ids:[...accepted],queued_answer_count:queued.size};
}

const inputStates=new Map<string,{source:string;turnId:string|null;clients:Set<string>}>();
/** Receipt/turn metadata from the existing native subscription lets ordinary
 * follow-ups bypass history reads. Closing the source invalidates its turn. */
export function rememberLiveCodexInput(native:string,source:string,turnId:string|null,client?:string){
 const key=JSON.stringify([currentCodexEngine().socket,native]);
 const prior=inputStates.get(key),clients=prior?.clients||new Set<string>();if(client)clients.add(client);
 while(clients.size>512)clients.delete(clients.values().next().value!);
 inputStates.delete(key);inputStates.set(key,{source,turnId,clients});while(inputStates.size>512)inputStates.delete(inputStates.keys().next().value!);
}
export function liveCodexInput(native:string){return inputStates.get(JSON.stringify([currentCodexEngine().socket,native]));}
