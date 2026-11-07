import {getAgent,agentContext,agentForSession} from './agents/index.js';
import {type ConversationAsyncQuestion,type ConversationQuestionReply} from './conversation-interactions.js';
import {open} from 'fs/promises';
import {createHash} from 'crypto';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import type {CliType} from './session-identity.js';
import {type ConversationAttachment} from './conversation-attachments.js';

import type {AgentStatistics as ConversationStatistics} from './agents/types.js';

export type ConversationMessage=import('./agents/types.js').AgentMessage;

interface IndexedMessage extends Omit<ConversationMessage,'text'|'phase'> {offset:number;length:number;hash:string;recordType:string;nativeItem:boolean;itemId?:string;declaredTurnId?:string;questionSignature?:string;questionCallId?:string;phase?:'unknown'|'commentary'|'final'|'error'}
interface NativeQuestionCall {offset:number;id:string;turnId?:string;signature:string}
interface TurnBoundary {offset:number;kind:'start'|'end';turnId:string}
function questionSignature(questions:ConversationAsyncQuestion[]) {return createHash('sha256').update(JSON.stringify(questions.map(q=>({title:q.title,options:q.options})))).digest('hex');}
interface Index {inode:number;mtime:number;start:number;offset:number;partial:Buffer;messages:IndexedMessage[];generation:string;skipPartial:boolean;anchor:Buffer;questionCalls:NativeQuestionCall[];turnBoundaries:TurnBoundary[]}
const WINDOW=2*1024*1024;
const MAX_RECORD=512*1024;
const MAX_INPUT_RECORD=16*1024*1024;
function recordLimit(buffer:Buffer,kind:CliType){return getAgent(kind).history.file!.recordLimit(buffer);}
async function previousWindow(handle:Awaited<ReturnType<typeof open>>,end:number) {
  let length=Math.min(WINDOW,end);
  while(true) {
    const start=Math.max(0,end-length),buffer=Buffer.alloc(end-start);await handle.read(buffer,0,buffer.length,start);
    const newline=buffer.indexOf(10),skip=start?newline+1:0;
    if(start===0 || newline>=0 && newline<buffer.length-1 || length>=MAX_INPUT_RECORD+WINDOW)return {start,buffer,skip,nextStart:start+(skip>=buffer.length?0:skip)};
    length=Math.min(MAX_INPUT_RECORD+WINDOW,length+WINDOW,end);
  }
}
const indexes=new Map<string,Index>();
const locks=new Map<string,Promise<unknown>>();

export function conversationMessageId(turnId:string,role:string,itemId?:string) {
  return createHash('sha256').update(`${turnId}:${role}${itemId?`:${itemId}`:''}`).digest('hex').slice(0,32);
}

function publicMessage(line:Buffer,kind:CliType,questionCallId?:string){return getAgent(kind).history.file!.project(line,questionCallId);}

function scan(buffer:Buffer,base:number,kind:CliType,questionCalls:NativeQuestionCall[],turnBoundaries:TurnBoundary[],context?:{nativeId?:string|null}):IndexedMessage[] {
  const result:IndexedMessage[]=[],codec=getAgent(kind).history.file!;
  const boundaryOffsets=new Set(turnBoundaries.map(item=>item.offset));
  let start=0;
  for(let end=buffer.indexOf(10);end>=0;end=buffer.indexOf(10,start)) {
    const record=buffer.subarray(start,end);
    const boundary=codec.turnBoundary?.(record);
    if(boundary&&!boundaryOffsets.has(base+start)){turnBoundaries.push({...boundary,offset:base+start});boundaryOffsets.add(base+start);}
    // Older native rollouts put async metadata on agent_message without an ID.
    // Bind it to the actual preceding request call, never infer from prose or
    // parse quoted tool results as interactive input.
    const call=codec.questionCall(record);
    if(call&&!questionCalls.some(item=>item.offset===base+start))questionCalls.push({...call,offset:base+start});
    const parsed=codec.project(record,undefined,context);
    if(parsed) {
      const {message,failure,recordType,turnId,itemId}=parsed;
      const hash=createHash('sha256').update(message.text).digest('hex');
      const offset=base+start;
      result.push({id:failure?.id || (turnId && (message.role==='assistant' || itemId)?conversationMessageId(turnId,message.role,itemId || (recordType==='completion_echo'?undefined:String(offset))):createHash('sha256').update(`${offset}:${message.role}:${hash}`).digest('hex').slice(0,32)),role:message.role,timestamp:message.timestamp,turn_id:turnId,...(message.role==='assistant'?{phase:message.phase==='error'?'error' as const:message.phase==='final'?'final' as const:message.phase==='commentary'?'commentary' as const:'unknown' as const}:{}),...(failure?{error:failure.error}:{}),offset,length:end-start,hash,recordType,nativeItem:!!itemId,itemId,declaredTurnId:turnId,...(parsed.asyncQuestions?{questionSignature:questionSignature(parsed.asyncQuestions)}:{})});
    }
    start=end+1;
  }
  return result;
}
function bindTurnBoundaries(messages:IndexedMessage[],boundaries:TurnBoundary[]) {
  boundaries.sort((a,b)=>a.offset-b.offset);
  let cursor=0,active:string|undefined;
  for(const message of messages) {
    while(cursor<boundaries.length&&boundaries[cursor].offset<=message.offset){const boundary=boundaries[cursor++];active=boundary.kind==='start'?boundary.turnId:undefined;}
    const at=boundaries[cursor-1];
    if(message.declaredTurnId&&!(at?.kind==='end'&&at.offset===message.offset))active=message.declaredTurnId;
    // A bounded cold window may start inside a completed turn. Its closing
    // boundary still identifies that prefix without reading the whole rollout.
    const next=boundaries[cursor];
    if(!message.turn_id){
      message.turn_id=active || (next?.kind==='end'?next.turnId:undefined);
      if(message.turn_id&&message.phase!=='error'&&(message.role==='assistant'||message.itemId))message.id=conversationMessageId(message.turn_id,message.role,message.questionCallId||message.itemId||(message.recordType==='completion_echo'?undefined:String(message.offset)));
    }
  }
  return messages;
}
function bindQuestionCalls(messages:IndexedMessage[],calls:NativeQuestionCall[]) {
  calls.sort((a,b)=>a.offset-b.offset);
  for(const message of messages) {
    if(!message.questionSignature||message.nativeItem)continue;
    let source:NativeQuestionCall|undefined;
    for(let i=calls.length-1;i>=0;i--){const call=calls[i];if(call.offset<message.offset&&call.signature===message.questionSignature&&(!message.turn_id||!call.turnId||message.turn_id===call.turnId)){source=call;break;}}
    if(source){message.questionCallId=source.id;message.turn_id ||= source.turnId;message.id=conversationMessageId(message.turn_id||'async',message.role,source.id);message.nativeItem=true;}
  }
  return messages;
}
function dedupe(messages:IndexedMessage[]):IndexedMessage[] {
  const result:IndexedMessage[]=[];
  for(const message of messages) {
    if(message.phase==='error') {
      const existing=result.findIndex(item=>item.id===message.id);if(existing>=0)result.splice(existing,1);
      result.push(message);continue;
    }
    // `task_complete.last_agent_message` is a lifecycle echo of the final
    // assistant item, not a second answer.  It is not always adjacent to the
    // native item (an activity/progress record may be interleaved), so the
    // adjacent-only check below can leak the same answer twice.
    if(message.recordType==='completion_echo') {
      let echoed=-1;
      // Some Codex versions stamp the response item with an internal turn ID
      // while task_complete uses the public lifecycle turn ID. Walk backward
      // only within the current user turn, so an identical answer from an
      // earlier turn is still preserved.
      for(let i=result.length-1;i>=0;i--) {
        const item=result[i];
        if(item.role==='user')break;
        if(item.role==='assistant'&&item.hash===message.hash&&item.recordType!=='completion_echo') {
          echoed=i;break;
        }
      }
      if(echoed>=0) {
        if(result[echoed].phase==='unknown')result[echoed]={...result[echoed],phase:'final'};
        continue;
      }
    }
    const previous=result.at(-1);
    if(previous?.id===message.id)continue;
    // Codex writes the same assistant item twice: an event_msg lifecycle
    // notification and a response_item durable message.  Their metadata
    // turn IDs are often different (the former is the native turn, the latter
    // is an internal UUID), so identity matching cannot be used here.  They
    // are adjacent and separated from a real later reply by a user record.
    const lifecycleDuplicate=message.role==='assistant'&&previous?.role==='assistant'
      && previous.hash===message.hash
      && previous.recordType!==message.recordType
      && new Set([previous.recordType,message.recordType]).has('event_message')
      && new Set([previous.recordType,message.recordType]).has('native_message');
    if(previous?.hash===message.hash && previous.role===message.role
      && (lifecycleDuplicate || !previous.turn_id || !message.turn_id || previous.turn_id===message.turn_id)
      && ((message.role==='user' && previous.recordType!==message.recordType)
        || (message.role==='assistant' && previous.phase!=='error' && previous.recordType!==message.recordType))) {
      if(message.recordType==='async_question' || (message.recordType==='native_message' && message.nativeItem && previous.recordType!=='async_question')) result[result.length-1]=message;
      continue;
    }
    result.push(message);
  }
  return result;
}

/** A bounded incremental byte index. Cached metadata never contains message
 * bodies or tool output; only the requested page's public text is read. */
export async function readConversation(session:PromptContextSession,query:{after?:string;before?:string;limit?:number}={}) {
  const nativePage=await agentForSession(session).history.read(agentContext(session),query);if(nativePage)return nativePage;
  const file=await nativeConversationFile(session);
  const empty={messages:[] as ConversationMessage[],statistics:[] as ConversationStatistics[],has_more:false,reset:false,available:false,generation:null as string|null};
  if(!file) return empty;
  const previous=locks.get(file.path)||Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{
    const handle=await open(file.path,'r');
    try {
      const stats=await handle.stat();
      let index=indexes.get(file.path);
      let reset=false;
      if(index && index.offset>0 && stats.size>=index.offset) {
        const anchor=Buffer.alloc(index.anchor.length);await handle.read(anchor,0,anchor.length,index.offset-anchor.length);
        if(!anchor.equals(index.anchor)) {index=undefined;reset=true;}
      }
      if(!index || index.inode!==stats.ino || stats.size<index.offset || (stats.size===index.offset && stats.mtimeMs!==index.mtime)) {
        reset ||= !!index;
        const {start,buffer,skip,nextStart}=await previousWindow(handle,stats.size);
        const data=buffer.subarray(skip);
        const end=data.lastIndexOf(10)+1;
        const questionCalls:NativeQuestionCall[]=[],turnBoundaries:TurnBoundary[]=[];
        index={inode:stats.ino,mtime:stats.mtimeMs,start:nextStart,offset:stats.size,partial:Buffer.from(data.subarray(end)),messages:scan(data.subarray(0,end),start+skip,file.kind,questionCalls,turnBoundaries,agentContext(session)),generation:`${stats.ino}:${stats.birthtimeMs}`,skipPartial:false,anchor:Buffer.alloc(0),questionCalls,turnBoundaries};
        if(index.partial.length>recordLimit(index.partial,file.kind)){index.partial=Buffer.alloc(0);index.skipPartial=true;}
        if(indexes.size>=32 && !indexes.has(file.path)) indexes.delete(indexes.keys().next().value!);
        indexes.set(file.path,index);
      } else if(stats.size>index.offset) {
        // Read append-only output in small chunks, dropping oversized tool lines.
        while(index.offset<stats.size) {
          const length=Math.min(WINDOW,stats.size-index.offset);
          const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,index.offset);
          if(!bytesRead) break;
          let data=Buffer.concat([index.partial,buffer.subarray(0,bytesRead)]);
          let base=index.offset-index.partial.length;
          if(index.skipPartial) {
            const newline=data.indexOf(10);
            if(newline<0) {index.partial=Buffer.alloc(0);index.offset+=bytesRead;continue;}
            base+=newline+1;data=data.subarray(newline+1);index.skipPartial=false;
          }
          const end=data.lastIndexOf(10)+1;
          index.messages.push(...scan(data.subarray(0,end),base,file.kind,index.questionCalls,index.turnBoundaries,agentContext(session)));
          index.partial=Buffer.from(data.subarray(end));
          if(index.partial.length>recordLimit(index.partial,file.kind)) {index.partial=Buffer.alloc(0);index.skipPartial=true;}
          index.offset+=bytesRead;
        }
        index.mtime=stats.mtimeMs;
      }
      index.anchor=Buffer.alloc(Math.min(128,index.offset));await handle.read(index.anchor,0,index.anchor.length,index.offset-index.anchor.length);
      const bind=(messages:IndexedMessage[])=>dedupe(bindQuestionCalls(bindTurnBoundaries(messages,index!.turnBoundaries),index!.questionCalls));
      index.messages=bind(index.messages);
      const prependWindow=async()=>{
        const {start,buffer,skip,nextStart}=await previousWindow(handle,index!.start);
        index!.messages=bind([...scan(buffer.subarray(skip),start+skip,file.kind,index!.questionCalls,index!.turnBoundaries,agentContext(session)),...index!.messages]);
        index!.start=nextStart;
      };
      // A cold window can begin between an async request and its message.
      // Fetch the preceding window before exposing a question without its ID.
      for(let scan=0;index.start>0&&scan<2&&index.messages.slice(-80).some(message=>message.questionSignature&&!message.nativeItem);scan++)await prependWindow();
      // A large trailing tool result must not hide the last real conversation.
      // Bound cold discovery; older pages can continue backwards on demand.
      const limit=Math.max(1,Math.min(80,query.limit||40));
      for(let scan=0;index.messages.length<limit && index.start>0 && scan<4;scan++) await prependWindow();
      let before=query.before ? index.messages.findIndex(message=>message.id===query.before) : index.messages.length;
      // Older pages expand the index backwards only on explicit demand.
      if(query.before && (before<limit) && index.start>0) {
        await prependWindow();
        before=index.messages.findIndex(message=>message.id===query.before);
      }
      let selected:IndexedMessage[];
      if(before<0) {before=index.messages.length;reset=true;}
      if(query.after) {
        const after=index.messages.findIndex(message=>message.id===query.after);
        reset ||= after<0;
        selected=after<0 ? index.messages.slice(-limit) : index.messages.slice(after+1,after+1+limit);
      } else {selected=index.messages.slice(Math.max(0,before-limit),before<0?undefined:before);}
      const messages:ConversationMessage[]=[];
      const statistics=await getAgent(file.kind).statistics.read(agentContext(session),file.path).catch(()=>[]);
      const byOffset=new Map(statistics.map(item=>[item.sequence,item]));
      for(const item of selected) {
        const buffer=Buffer.alloc(item.length);await handle.read(buffer,0,buffer.length,item.offset);
        const parsed=publicMessage(buffer,file.kind,item.questionCallId);
        if(parsed) messages.push({id:item.id,role:item.role,text:parsed.message.text,timestamp:item.timestamp,turn_id:item.turn_id,phase:item.phase==='unknown'?'commentary':item.phase,...(byOffset.has(item.offset)?{statistics:byOffset.get(item.offset)}:{}),...(parsed.questionReplies?{question_replies:parsed.questionReplies}:{}),...(parsed.asyncQuestions?{async_questions:parsed.asyncQuestions}:{}),...(item.error?{error:item.error}:{}),sequence:item.offset,...(parsed.imagePaths.length?{image_paths:parsed.imagePaths}:{})});
      }
      const first=selected[0];
      return {messages,statistics,has_more:index.start>0 || (!!first && index.messages[0]?.id!==first.id),reset,available:true,generation:index.generation};
    } finally {await handle.close();}
  }).catch(()=>empty);
  locks.set(file.path,work);
  try{return await work;}finally{if(locks.get(file.path)===work) locks.delete(file.path);}
}
