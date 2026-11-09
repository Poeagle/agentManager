import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {publicTokenCounters,tokenFields} from '../../conversation-usage.js';

export type ConversationInterval=import('../types.js').AgentStatisticsInterval;
export type ConversationConclusion=NonNullable<import('../types.js').AgentStatistics['conclusion']>;
export type ConversationStatistics=import('../types.js').AgentStatistics;

interface Turn {checkpoint?:{tokens:ReturnType<typeof publicTokenCounters>;requests:number;calls:number;rounds:number};intervalIntact?:boolean;id:string;complete:boolean;tokens:ReturnType<typeof publicTokenCounters>;requests:number;calls:Set<string>;rounds:number;pendingTools:boolean;waiting:Array<{sequence:number;message_id?:string;final:boolean;timestamp:string|null;hash?:string;implicit?:boolean}>}
interface Conclusion {tokens:ReturnType<typeof publicTokenCounters>;requests:number;calls:number;rounds:number;complete:boolean;start:string|null;initial:boolean}
interface State {offset:number;inode:number;mtime:number;partial:Buffer;turn:Turn|null;conclusion:Conclusion;fingerprint:string|null;stats:Map<number,ConversationStatistics>}
const cache=new Map<string,State>(),WINDOW=2*1024*1024;
const callTypes=new Set(['function_call','custom_tool_call','tool_search_call','web_search_call','local_shell_call']);
const zeroTokens=()=>Object.fromEntries(tokenFields.map(field=>[field,0])) as Turn['tokens'];
function conclusion(start:string|null,complete:boolean,initial=false):Conclusion{return {start,complete,tokens:zeroTokens(),requests:0,calls:0,rounds:0,initial};}
const timestamp=(value:unknown):string|null=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
function incomplete(state:State){state.conclusion.complete=false;if(state.turn){state.turn.complete=false;state.turn.intervalIntact=false;}}
function turn(id:string,complete:boolean):Turn{return {id,complete,tokens:Object.fromEntries(tokenFields.map(field=>[field,0])) as Turn['tokens'],requests:0,calls:new Set(),rounds:0,pendingTools:false,waiting:[]};}
function settleImplicit(state:State,text:string){
  // Older records omit phase on an assistant item. task_complete names the
  // exact final text, so only the matching tail is promoted to a conclusion.
  const current=state.turn,tail=current?.waiting.at(-1),hash=text?createHash('sha256').update(text).digest('hex'):undefined;
  if(!current||!tail||!tail.implicit||tail.hash!==hash)return;
  tail.final=true;
  const snapshot=state.stats.get(tail.sequence);
  if(!snapshot)return;
  const end=tail.timestamp,start=state.conclusion.start,elapsed=start&&end?Date.parse(end)-Date.parse(start):null;
  snapshot.conclusion={tokens:state.conclusion.requests?{...state.conclusion.tokens}:null,requests:state.conclusion.requests,tool_calls:state.conclusion.calls,tool_rounds:state.conclusion.rounds,complete:state.conclusion.complete&&!!snapshot.interval?.complete,shared_messages:1,start_at:start,end_at:end,elapsed_ms:elapsed!==null&&elapsed>=0?elapsed:null};
  state.conclusion=conclusion(end,true);
}
function finish(state:State,hasUsage:boolean,retainTail=0){
  const current=state.turn;if(!current||!current.waiting.length)return;
  const retained=retainTail&&current.waiting.at(-1)?.implicit?current.waiting.slice(-1):[];
  const settled=current.waiting.slice(0,current.waiting.length-retained.length);if(!settled.length)return;
  const previous=current.checkpoint;
  const interval:ConversationInterval={
    tokens:hasUsage?Object.fromEntries(tokenFields.map(field=>{const end=current.tokens[field],start=previous?previous.tokens[field]:0;return [field,end===null||start===null?null:Math.max(0,end-start)];})) as Turn['tokens']:null,
    requests:current.requests-(previous?.requests??0),tool_calls:current.calls.size-(previous?.calls??0),tool_rounds:current.rounds-(previous?.rounds??0),
    complete:(current.intervalIntact??current.complete)&&hasUsage,shared_messages:settled.length,
  };
  const finals=settled.filter(message=>message.final),summary=state.conclusion;
  let conclusionStart=summary.start;
  for(const message of settled){
    state.stats.set(message.sequence,{sequence:message.sequence,...message.message_id?{message_id:message.message_id}:{},turn_id:current.id,tokens:hasUsage?{...current.tokens}:null,requests:current.requests,tool_calls:current.calls.size,tool_rounds:current.rounds,complete:current.complete});
    state.stats.get(message.sequence)!.interval={...interval,tokens:interval.tokens?{...interval.tokens}:null};
    if(message.final){
      const end=message.timestamp,start=conclusionStart,elapsed=start&&end?Date.parse(end)-Date.parse(start):null;
      state.stats.get(message.sequence)!.conclusion={tokens:summary.requests?{...summary.tokens}:null,requests:summary.requests,tool_calls:summary.calls,tool_rounds:summary.rounds,complete:summary.complete&&hasUsage,shared_messages:finals.length,start_at:start,end_at:end,elapsed_ms:elapsed!==null&&elapsed>=0?elapsed:null};
      conclusionStart=end;
    }
  }
  // The conclusion boundary belongs to the native transcript, not the current
  // turn or the retained page. Follow-ups and retries must not reset it.
  if(finals.length)state.conclusion=conclusion(finals.at(-1)!.timestamp,true);
  current.checkpoint={tokens:{...current.tokens},requests:current.requests,calls:current.calls.size,rounds:current.rounds};current.intervalIntact=true;
  current.waiting=retained;while(state.stats.size>80)state.stats.delete(state.stats.keys().next().value!);
}
function consume(state:State,line:Buffer,sequence:number){
  // Only parse relevant records; never retain arguments, outputs or reasoning.
  const header=line.subarray(0,600).toString();
  if(!/"type"\s*:\s*"(?:task_started|task_complete|turn_context|token_count|message|item_completed|AgentMessage|function_call|custom_tool_call|tool_search_call|web_search_call|local_shell_call)"/.test(header))return;
  if(line.length>256*1024){incomplete(state);return;}
  let record:any;try{record=JSON.parse(line.toString());}catch{incomplete(state);return;}
  const p=record.payload;if(!p)return;
  const id=p.turn_id||p.internal_chat_message_metadata_passthrough?.turn_id||(record.type==='response_item'?state.turn?.id:undefined);
  if(record.type==='event_msg'&&p.type==='task_started'&&typeof id==='string'){
    if(state.conclusion.initial)state.conclusion.start ||= timestamp(record.timestamp);
    if(state.turn?.id!==id){finish(state,false);state.turn=turn(id,true);}return;
  }
  if(record.type==='turn_context'&&typeof id==='string'&&state.turn?.id!==id){finish(state,false);state.turn=turn(id,false);return;}
  const assistantItem=record.type==='event_msg'&&p.type==='item_completed'&&p.item?.type==='AgentMessage'?p.item
    :record.type==='response_item'&&p.type==='message'&&p.role==='assistant'?p:undefined;
  if(assistantItem&&typeof id==='string'){
    if(state.turn?.id!==id){finish(state,false);state.turn=turn(id,false);}
    const message_id=typeof assistantItem.id==='string'?createHash('sha256').update(`item:assistant:${assistantItem.id}`).digest('hex').slice(0,32):undefined;
    const text=Array.isArray(assistantItem.content)?assistantItem.content.filter((part:any)=>['Text','output_text','text'].includes(part?.type)&&typeof part.text==='string').map((part:any)=>part.text.trim()).filter(Boolean).join('\n').trim():'';
    const final=['final_answer','final'].includes(assistantItem.phase)&&assistantItem.delivery!=='async'&&!assistantItem.questions?.length&&!!text;
    const implicit=!assistantItem.phase||assistantItem.phase==='unknown';
    const current=state.turn!;
    // Codex records the same item in item_completed and response_item. Merge
    // by native ID before assigning a request interval or conclusion boundary.
    if(message_id){
      const prior=current.waiting.find(item=>item.message_id===message_id);
      if(prior){
        prior.final ||= !!final;
        prior.timestamp=timestamp(record.timestamp)??prior.timestamp;
        if(text)prior.hash=createHash('sha256').update(text).digest('hex');
        if(!implicit)prior.implicit=false;
        return;
      }
      if([...state.stats.values()].some(item=>item.message_id===message_id))return;
    }
    const firstVisible=!state.stats.size&&!current.waiting.some(message=>!message.implicit);
    if(!state.conclusion.start)state.conclusion.complete=false;
    if(firstVisible)state.conclusion.complete=current.complete;
    state.conclusion.initial=false;
    current.waiting.push({sequence,...message_id?{message_id}:{},final:!!final,timestamp:timestamp(record.timestamp),...(text?{hash:createHash('sha256').update(text).digest('hex')}:{}),...(implicit?{implicit:true}:{})});return;
  }
  if(record.type==='response_item'&&callTypes.has(p.type)&&state.turn){
    if(typeof id==='string'&&id!==state.turn.id){finish(state,false);state.turn=turn(id,false);}
    const key=typeof p.call_id==='string'?p.call_id:typeof p.id==='string'?p.id:`offset:${sequence}`;
    if(!state.turn.calls.has(key)){if(state.turn.calls.size>=8192){incomplete(state);}else {state.turn.calls.add(key);state.conclusion.calls++;}state.turn.pendingTools=true;}
    return;
  }
  if(record.type==='event_msg'&&p.type==='token_count'&&p.info){
    const total=publicTokenCounters(p.info.total_token_usage),last=publicTokenCounters(p.info.last_token_usage);
    if(total.total_tokens===null||last.total_tokens===null){incomplete(state);return;}
    const fingerprint=JSON.stringify(total);if(fingerprint===state.fingerprint)return;
    state.fingerprint=fingerprint;
    const current=state.turn;if(!current)return;
    current.requests++;state.conclusion.requests++;if(current.pendingTools){current.rounds++;state.conclusion.rounds++;current.pendingTools=false;}
    for(const field of tokenFields){current.tokens[field]=current.tokens[field]===null||last[field]===null?null:current.tokens[field]!+last[field]!;state.conclusion.tokens[field]=state.conclusion.tokens[field]===null||last[field]===null?null:state.conclusion.tokens[field]!+last[field]!;}
    // Keep the exact answer pending until task_complete can identify it.
    const tail=current.waiting.at(-1);
    if(tail?.implicit && !tail.final){finish(state,true,1);return;}
    finish(state,true);return;
  }
  if(record.type==='event_msg'&&p.type==='task_complete'&&state.turn?.id===id&&state.turn){
    const text=typeof p.last_agent_message==='string'?p.last_agent_message.trim():'';
    settleImplicit(state,text);
    finish(state,false);
  }
}
/** One bounded cold read, then append-only reads shared by HTTP and existing
 * file notifications. Missing turn starts produce explicitly partial counts. */
export async function readConversationStatistics(path:string):Promise<ConversationStatistics[]> {
  const handle=await open(path,'r');
  try {
    const info=await handle.stat();let state=cache.get(path),skipFirst=false;
    if(state&&state.inode===info.ino&&state.offset===info.size&&state.mtime===info.mtimeMs)return [...state.stats.values()];
    if(!state||state.inode!==info.ino||info.size<state.offset||info.size===state.offset&&info.mtimeMs!==state.mtime){state={offset:Math.max(0,info.size-WINDOW),inode:info.ino,mtime:info.mtimeMs,partial:Buffer.alloc(0),turn:null,conclusion:conclusion(null,info.size<=WINDOW,info.size<=WINDOW),fingerprint:null,stats:new Map()};cache.set(path,state);if(cache.size>32)cache.delete(cache.keys().next().value!);
      skipFirst=state.offset>0;
    }
    while(state.offset<info.size){
      const buffer=Buffer.alloc(Math.min(WINDOW,info.size-state.offset)),{bytesRead}=await handle.read(buffer,0,buffer.length,state.offset);if(!bytesRead)break;
      const base=state.offset-state.partial.length,data=Buffer.concat([state.partial,buffer.subarray(0,bytesRead)]);let start=skipFirst?data.indexOf(10)+1:0;if(skipFirst&&!start){state.offset+=bytesRead;continue;}skipFirst=false;
      for(let end=data.indexOf(10,start);end>=0;end=data.indexOf(10,start)){consume(state,data.subarray(start,end),base+start);start=end+1;}
      state.partial=Buffer.from(data.subarray(start));state.offset+=bytesRead;
      if(state.partial.length>WINDOW){state.partial=Buffer.alloc(0);incomplete(state);}
    }
    state.mtime=info.mtimeMs;return [...state.stats.values()];
  }finally{await handle.close();}
}
