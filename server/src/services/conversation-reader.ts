import {conversationAsyncQuestions,type ConversationAsyncQuestion} from './conversation-interactions.js';
import {open} from 'fs/promises';
import {createHash} from 'crypto';
import {extractAgentMessages,nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import type {CliType} from './session-identity.js';
import {conversationImagePaths,type ConversationAttachment} from './conversation-attachments.js';
import {conversationErrorMessage} from './conversation-error.js';

export interface ConversationMessage {id:string;role:'user'|'assistant';text:string;timestamp:string|null;turn_id?:string;streaming?:boolean;phase?:'commentary'|'final'|'error';error?:{code?:string;will_retry:boolean};client_id?:string;sequence?:number;attachments?:ConversationAttachment[];image_paths?:string[];async_questions?:ConversationAsyncQuestion[]}
interface IndexedMessage extends Omit<ConversationMessage,'text'> {offset:number;length:number;hash:string;recordType:string;nativeItem:boolean}
interface Index {inode:number;mtime:number;start:number;offset:number;partial:Buffer;messages:IndexedMessage[];generation:string;skipPartial:boolean;anchor:Buffer}
const WINDOW=2*1024*1024;
const MAX_RECORD=512*1024;
const MAX_INPUT_RECORD=16*1024*1024;
function inputRecordPrefix(buffer:Buffer,kind:CliType) {
  const header=buffer.subarray(0,4096).toString('utf8');
  if(kind==='codex') {
    const position=header.indexOf('"payload"');const payload=header.slice(position);
    return position>=0 && /^"payload"\s*:\s*\{\s*"type"\s*:\s*"message"/.test(payload) && /"role"\s*:\s*"([^"]+)"/.exec(payload)?.[1]==='user';
  }
  return /"type"\s*:\s*"([^"]+)"/.exec(header)?.[1]==='user' && !/"type"\s*:\s*"tool_result"/.test(header);
}
function recordLimit(buffer:Buffer,kind:CliType) {return inputRecordPrefix(buffer,kind)?MAX_INPUT_RECORD:MAX_RECORD;}
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

function publicMessage(line:Buffer,kind:CliType) {
  if(line.length>recordLimit(line,kind)) return null;
  let text=line.toString('utf8');
  if(line.length>MAX_RECORD)text=text.replace(/"image_url"\s*:\s*"data:[^"]*"/g,'"image_url":""');
  // Do not parse or retain tool results/reasoning. The extractor also checks
  // the actual JSON structure so quoted records in tool output cannot leak.
  const header=text.slice(0,400);
  const agentItem=/"type"\s*:\s*"item_completed"/.test(header)&&/"type"\s*:\s*"AgentMessage"/.test(header);
  if(!agentItem && !/"(?:type|role)"\s*:\s*"(?:user|assistant|message|user_message|agent_message|task_complete|error)"/.test(text.slice(0,400))) return null;
  try {
    const entry=JSON.parse(text);
    const turnId=entry.payload?.turn_id || entry.payload?.internal_chat_message_metadata_passthrough?.turn_id;
    const failure=kind==='codex' && entry.type==='event_msg' && ['task_complete','error'].includes(entry.payload?.type)
      ? conversationErrorMessage(typeof turnId==='string'?turnId:`event:${entry.timestamp}`,entry.payload.error??(entry.payload.type==='error'?entry.payload:null),entry.payload.will_retry===true || entry.payload.willRetry===true,typeof entry.timestamp==='string'?entry.timestamp:null):null;
    const asyncItem=kind==='codex' && entry.type==='event_msg' && entry.payload?.type==='item_completed' && entry.payload.item?.type==='AgentMessage'?entry.payload.item
      :kind==='codex' && entry.type==='response_item' && entry.payload?.type==='message' && entry.payload.role==='assistant'?entry.payload:null;
    const asyncQuestions=conversationAsyncQuestions(asyncItem);
    const asyncMessage=asyncQuestions?{role:'assistant' as const,phase:'final' as const,text:(asyncItem.content||[]).filter((part:any)=>['Text','output_text'].includes(part.type)&&typeof part.text==='string').map((part:any)=>part.text).join('\n').slice(0,128*1024)||asyncQuestions.map(q=>q.title).join('\n'),timestamp:typeof entry.timestamp==='string'?entry.timestamp:null}:null;
    const message=failure||asyncMessage||extractAgentMessages([entry],kind,128*1024).find(message=>message.role==='user'||message.role==='assistant');
    const itemId=asyncQuestions&&typeof asyncItem?.id==='string'?asyncItem.id:kind==='codex' && entry.type==='response_item' && typeof entry.payload?.id==='string'?entry.payload.id:undefined;
    return message ? {message,failure,itemId,asyncQuestions,imagePaths:message.role==='user'?conversationImagePaths(entry.payload?.content):[],turnId:typeof turnId==='string'?turnId:undefined,recordType:asyncQuestions?'async_question':entry.type==='event_msg' ? entry.payload?.type : entry.type} : null;
  } catch {return null;}
}
function scan(buffer:Buffer,base:number,kind:CliType):IndexedMessage[] {
  const result:IndexedMessage[]=[];
  let start=0;
  for(let end=buffer.indexOf(10);end>=0;end=buffer.indexOf(10,start)) {
    const parsed=publicMessage(buffer.subarray(start,end),kind);
    if(parsed) {
      const {message,failure,recordType,turnId,itemId}=parsed;
      const hash=createHash('sha256').update(message.text).digest('hex');
      const offset=base+start;
      result.push({id:failure?.id || (turnId && (message.role==='assistant' || itemId)?conversationMessageId(turnId,message.role,itemId || (recordType==='task_complete'?undefined:String(offset))):createHash('sha256').update(`${offset}:${message.role}:${hash}`).digest('hex').slice(0,32)),role:message.role,timestamp:message.timestamp,turn_id:turnId,...(message.role==='assistant'?{phase:message.phase==='error'?'error' as const:message.phase==='final'?'final' as const:'commentary' as const}:{}),...(failure?{error:failure.error}:{}),offset,length:end-start,hash,recordType,nativeItem:!!itemId});
    }
    start=end+1;
  }
  return result;
}
function dedupe(messages:IndexedMessage[]):IndexedMessage[] {
  const result:IndexedMessage[]=[];
  for(const message of messages) {
    if(message.phase==='error') {
      const existing=result.findIndex(item=>item.id===message.id);if(existing>=0)result.splice(existing,1);
      result.push(message);continue;
    }
    const previous=result.at(-1);
    if(previous?.id===message.id)continue;
    if(previous?.hash===message.hash && previous.role===message.role
      && (!previous.turn_id || !message.turn_id || previous.turn_id===message.turn_id)
      && ((message.role==='user' && previous.recordType!==message.recordType)
        || (message.role==='assistant' && previous.phase!=='error' && previous.recordType!==message.recordType))) {
      if(message.recordType==='response_item' && message.nativeItem && previous.recordType!=='async_question') result[result.length-1]=message;
      continue;
    }
    result.push(message);
  }
  return result;
}

/** A bounded incremental byte index. Cached metadata never contains message
 * bodies or tool output; only the requested page's public text is read. */
export async function readConversation(session:PromptContextSession,query:{after?:string;before?:string;limit?:number}={}) {
  const file=await nativeConversationFile(session);
  const empty={messages:[] as ConversationMessage[],has_more:false,reset:false,available:false,generation:null as string|null};
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
        index={inode:stats.ino,mtime:stats.mtimeMs,start:nextStart,offset:stats.size,partial:Buffer.from(data.subarray(end)),messages:scan(data.subarray(0,end),start+skip,file.kind),generation:`${stats.ino}:${stats.birthtimeMs}`,skipPartial:false,anchor:Buffer.alloc(0)};
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
          index.messages.push(...scan(data.subarray(0,end),base,file.kind));
          index.partial=Buffer.from(data.subarray(end));
          if(index.partial.length>recordLimit(index.partial,file.kind)) {index.partial=Buffer.alloc(0);index.skipPartial=true;}
          index.offset+=bytesRead;
        }
        index.mtime=stats.mtimeMs;
      }
      index.anchor=Buffer.alloc(Math.min(128,index.offset));await handle.read(index.anchor,0,index.anchor.length,index.offset-index.anchor.length);
      index.messages=dedupe(index.messages);
      const prependWindow=async()=>{
        const {start,buffer,skip,nextStart}=await previousWindow(handle,index!.start);
        index!.messages=dedupe([...scan(buffer.subarray(skip),start+skip,file.kind),...index!.messages]);
        index!.start=nextStart;
      };
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
      for(const item of selected) {
        const buffer=Buffer.alloc(item.length);await handle.read(buffer,0,buffer.length,item.offset);
        const parsed=publicMessage(buffer,file.kind);
        if(parsed) messages.push({id:item.id,role:item.role,text:parsed.message.text,timestamp:item.timestamp,turn_id:item.turn_id,phase:item.phase,...(parsed.asyncQuestions?{async_questions:parsed.asyncQuestions}:{}),...(item.error?{error:item.error}:{}),sequence:item.offset,...(parsed.imagePaths.length?{image_paths:parsed.imagePaths}:{})});
      }
      const first=selected[0];
      return {messages,has_more:index.start>0 || (!!first && index.messages[0]?.id!==first.id),reset,available:true,generation:index.generation};
    } finally {await handle.close();}
  }).catch(()=>empty);
  locks.set(file.path,work);
  try{return await work;}finally{if(locks.get(file.path)===work) locks.delete(file.path);}
}
