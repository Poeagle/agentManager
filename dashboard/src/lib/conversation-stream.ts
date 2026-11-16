import type {ConversationMessage,ConversationUsageUpdate} from './api';
import {mergeConversationTimeline,type TimelineMessage} from './conversation-timeline';
export interface ConversationPatch {type:'patch';upserts:ConversationMessage[];deltas:Array<{id:string;offset:number;text:string}>}
/** Display timestamps are never delivery cursors. Reconnects replay a bounded
 * baseline; gaps in live sequence numbers request a fresh baseline. */
export class ConversationStreamCursor {
 private id:string|null=null;private sequence=0;
 observe(frame:{stream_id?:string;stream_seq?:number;baseline?:boolean;type:string}):'accept'|'ignore'|'resync'{
  if(!frame.stream_id||!Number.isSafeInteger(frame.stream_seq))return 'accept';
  const sequence=frame.stream_seq!;
  if(this.id===null){this.id=frame.stream_id;this.sequence=sequence;return 'accept';}
  if(frame.baseline||frame.type==='snapshot'&&this.id!==frame.stream_id){this.id=frame.stream_id;this.sequence=sequence;return 'accept';}
  if(this.id!==frame.stream_id)return 'resync';
  if(sequence<=this.sequence)return 'ignore';
  if(sequence!==this.sequence+1)return 'resync';
  this.sequence=sequence;return 'accept';
 }
}
export function applyConversationPatches(previous:TimelineMessage[],patches:ConversationPatch[]):{messages:TimelineMessage[];needsSync:boolean}{
 let messages=previous,needsSync=false,index:Map<string,number>|undefined,copied=false;
 for(const patch of patches){
  if(patch.upserts.length){messages=mergeConversationTimeline(messages,patch.upserts);index=undefined;copied=true;}
  if(!patch.deltas.length)continue;
  if(!index){index=new Map();messages.forEach((message,i)=>index!.set(message.id,i));}
  for(const delta of patch.deltas){const i=index.get(delta.id);if(i===undefined){needsSync=true;continue;}const message=messages[i];
   if(!delta.text.length)continue;
   if(message.text.length!==delta.offset){if(delta.offset<message.text.length&&message.text.slice(delta.offset,delta.offset+delta.text.length)===delta.text)continue;needsSync=true;continue;}
   if(!copied){messages=[...messages];copied=true;}messages[i]={...message,text:message.text+delta.text,streaming:true};
  }
 }
 return {messages,needsSync};
}

/** JSONL may price the same counters after an RPC usage event. Enrich only a
 * matching snapshot; never attach a stale estimate to newer token totals. */
export function mergeConversationUsage(previous:ConversationUsageUpdate|undefined,next:ConversationUsageUpdate):ConversationUsageUpdate {
 if(!previous||previous.native_id!==next.native_id)return next;
 const same=(['total','last'] as const).every(part=>['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'].every(field=>(previous.usage[part][field]??null)===(next.usage[part][field]??null)));
 const older=Date.parse(previous.observed_at)>Date.parse(next.observed_at);
 if(older)return same&&next.usage.cost!==undefined?{...previous,usage:{...previous.usage,cost:next.usage.cost}}:previous;
 return same&&next.usage.cost===undefined&&previous.usage.cost!==undefined?{...next,usage:{...next.usage,cost:previous.usage.cost}}:next;
}
