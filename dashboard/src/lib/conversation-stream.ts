import type {ConversationMessage} from './api';
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
  if(!index){index=new Map();messages.forEach((message,i)=>{index!.set(message.id,i);for(const alias of message.aliases||[])index!.set(alias,i);});}
  for(const delta of patch.deltas){const i=index.get(delta.id);if(i===undefined){needsSync=true;continue;}const message=messages[i];
   if(!delta.text.length)continue;
   if(message.text.length!==delta.offset){if(delta.offset<message.text.length&&message.text.slice(delta.offset,delta.offset+delta.text.length)===delta.text)continue;needsSync=true;continue;}
   if(!copied){messages=[...messages];copied=true;}messages[i]={...message,text:message.text+delta.text,streaming:true};
  }
 }
 return {messages,needsSync};
}
