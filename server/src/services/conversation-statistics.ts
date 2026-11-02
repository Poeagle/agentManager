import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {publicTokenCounters,tokenFields} from './conversation-usage.js';

export interface ConversationStatistics {
  sequence:number;message_id?:string;turn_id:string;
  tokens:ReturnType<typeof publicTokenCounters>|null;
  requests:number;tool_calls:number;tool_rounds:number;complete:boolean;
}
interface Turn {id:string;complete:boolean;tokens:ReturnType<typeof publicTokenCounters>;requests:number;calls:Set<string>;rounds:number;pendingTools:boolean;waiting:Array<{sequence:number;message_id?:string}>}
interface State {offset:number;inode:number;mtime:number;partial:Buffer;turn:Turn|null;fingerprint:string|null;stats:Map<number,ConversationStatistics>}
const cache=new Map<string,State>(),WINDOW=2*1024*1024;
const callTypes=new Set(['function_call','custom_tool_call','tool_search_call','web_search_call','local_shell_call']);
function turn(id:string,complete:boolean):Turn{return {id,complete,tokens:Object.fromEntries(tokenFields.map(field=>[field,0])) as Turn['tokens'],requests:0,calls:new Set(),rounds:0,pendingTools:false,waiting:[]};}
function finish(state:State,hasUsage:boolean){
  const current=state.turn;if(!current)return;
  for(const message of current.waiting){
    state.stats.set(message.sequence,{...message,turn_id:current.id,tokens:current.complete&&hasUsage?{...current.tokens}:null,requests:current.requests,tool_calls:current.calls.size,tool_rounds:current.rounds,complete:current.complete});
  }
  current.waiting=[];while(state.stats.size>80)state.stats.delete(state.stats.keys().next().value!);
}
function consume(state:State,line:Buffer,sequence:number){
  // Only parse relevant records; never retain arguments, outputs or reasoning.
  const header=line.subarray(0,600).toString();
  if(!/"type"\s*:\s*"(?:task_started|task_complete|turn_context|token_count|message|function_call|custom_tool_call|tool_search_call|web_search_call|local_shell_call)"/.test(header))return;
  if(line.length>256*1024){if(state.turn)state.turn.complete=false;return;}
  let record:any;try{record=JSON.parse(line.toString());}catch{return;}
  const p=record.payload;if(!p)return;
  const id=p.turn_id||p.internal_chat_message_metadata_passthrough?.turn_id;
  if(record.type==='event_msg'&&p.type==='task_started'&&typeof id==='string'){
    if(state.turn?.id!==id){finish(state,false);state.turn=turn(id,true);}return;
  }
  if(record.type==='turn_context'&&typeof id==='string'&&state.turn?.id!==id){finish(state,false);state.turn=turn(id,false);return;}
  if(record.type==='response_item'&&p.type==='message'&&p.role==='assistant'&&typeof id==='string'){
    if(state.turn?.id!==id){finish(state,false);state.turn=turn(id,false);}
    const message_id=typeof p.id==='string'?createHash('sha256').update(`${id}:assistant:${p.id}`).digest('hex').slice(0,32):undefined;
    state.turn!.waiting.push({sequence,...message_id?{message_id}:{}});return;
  }
  if(record.type==='response_item'&&callTypes.has(p.type)&&state.turn){
    if(typeof id==='string'&&id!==state.turn.id){finish(state,false);state.turn=turn(id,false);}
    const key=typeof p.call_id==='string'?p.call_id:typeof p.id==='string'?p.id:`offset:${sequence}`;
    if(!state.turn.calls.has(key)){if(state.turn.calls.size>=8192)state.turn.complete=false;else state.turn.calls.add(key);state.turn.pendingTools=true;}
    return;
  }
  if(record.type==='event_msg'&&p.type==='token_count'&&p.info){
    const total=publicTokenCounters(p.info.total_token_usage),last=publicTokenCounters(p.info.last_token_usage);
    if(total.total_tokens===null||last.total_tokens===null)return;
    const fingerprint=JSON.stringify(total);if(fingerprint===state.fingerprint)return;
    state.fingerprint=fingerprint;
    const current=state.turn;if(!current)return;
    current.requests++;if(current.pendingTools){current.rounds++;current.pendingTools=false;}
    for(const field of tokenFields)current.tokens[field]=current.tokens[field]===null||last[field]===null?null:current.tokens[field]!+last[field]!;
    finish(state,true);return;
  }
  if(record.type==='event_msg'&&p.type==='task_complete'&&state.turn?.id===id)finish(state,false);
}
/** One bounded cold read, then append-only reads shared by HTTP and existing
 * file notifications. Missing turn starts produce explicitly partial counts. */
export async function readConversationStatistics(path:string):Promise<ConversationStatistics[]> {
  const handle=await open(path,'r');
  try {
    const info=await handle.stat();let state=cache.get(path),skipFirst=false;
    if(state&&state.inode===info.ino&&state.offset===info.size&&state.mtime===info.mtimeMs)return [...state.stats.values()];
    if(!state||state.inode!==info.ino||info.size<state.offset||info.size===state.offset&&info.mtimeMs!==state.mtime){state={offset:Math.max(0,info.size-WINDOW),inode:info.ino,mtime:info.mtimeMs,partial:Buffer.alloc(0),turn:null,fingerprint:null,stats:new Map()};cache.set(path,state);if(cache.size>32)cache.delete(cache.keys().next().value!);
      skipFirst=state.offset>0;
    }
    while(state.offset<info.size){
      const buffer=Buffer.alloc(Math.min(WINDOW,info.size-state.offset)),{bytesRead}=await handle.read(buffer,0,buffer.length,state.offset);if(!bytesRead)break;
      const base=state.offset-state.partial.length,data=Buffer.concat([state.partial,buffer.subarray(0,bytesRead)]);let start=skipFirst?data.indexOf(10)+1:0;if(skipFirst&&!start){state.offset+=bytesRead;continue;}skipFirst=false;
      for(let end=data.indexOf(10,start);end>=0;end=data.indexOf(10,start)){consume(state,data.subarray(start,end),base+start);start=end+1;}
      state.partial=Buffer.from(data.subarray(start));state.offset+=bytesRead;
      if(state.partial.length>WINDOW){state.partial=Buffer.alloc(0);if(state.turn)state.turn.complete=false;}
    }
    state.mtime=info.mtimeMs;return [...state.stats.values()];
  }finally{await handle.close();}
}
