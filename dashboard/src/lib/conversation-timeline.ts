import type {ConversationMessage} from './api';

export interface TimelineMessage extends ConversationMessage {
  /** A local send reserves its position before either HTTP or native echo. */
  optimistic?: {afterSequence:number};
  /** Codex assigns different user IDs to stream items and rollout records. */
  aliases?: string[];
}

/** Reconcile ordered native batches. Timestamps are display data, never order
 * keys: client clocks, item-start times and durable completion times differ. */
export function mergeConversationTimeline(previous:TimelineMessage[],incoming:ConversationMessage[],placement:'append'|'prepend'='append'):TimelineMessage[] {
  const result=[...previous];
  const batch:TimelineMessage[]=[];
  const matched=new Set<number>();
  for(const message of incoming) {
    let index=result.findIndex(item=>item.id===message.id || item.aliases?.includes(message.id));
    if(index<0 && message.role==='user') {
      index=result.findIndex(item=>item.optimistic && (message.client_id
        ? item.client_id===message.client_id
        : message.sequence!==undefined && message.sequence>item.optimistic.afterSequence && item.text.trim()===message.text.trim()));
    }
    if(index<0 && message.role==='user' && message.turn_id) {
      // Native stream/rollout user IDs differ. Reconcile their ordered
      // occurrences within the same turn, including identical followups.
      index=result.findIndex((item,index)=>!matched.has(index) && !item.optimistic && item.role==='user' && item.turn_id===message.turn_id && item.text===message.text && (!item.client_id || !message.client_id || item.client_id===message.client_id) && (item.sequence===undefined)!==(message.sequence===undefined));
    }
    if(index>=0) {
      matched.add(index);
      const old=result[index];
      // A stale live snapshot must not turn a persisted answer back into an
      // incomplete stream. Keep native order/identity and local correlation.
      const value=old.sequence!==undefined && message.sequence===undefined
        ? {...message,...old,client_id:message.client_id??old.client_id}
        : {...old,...message,streaming:message.streaming??false,optimistic:undefined};
      if(old.id!==message.id) value.aliases=[...new Set([...(old.aliases||[]),old.id,message.id])];
      result[index]=value;batch.push(value);
    } else batch.push(message);
  }
  for(let i=0;i<batch.length;i++) {
    const message=batch[i];
    if(result.some(item=>item.id===message.id)) continue;
    const next=batch.slice(i+1).map(item=>result.findIndex(value=>value.id===item.id)).find(index=>index>=0);
    const later=message.sequence===undefined?-1:result.findIndex(item=>item.sequence!==undefined && item.sequence>message.sequence!);
    const previousIndex=i?result.findIndex(item=>item.id===batch[i-1].id):-1;
    const index=next!==undefined?next:later>=0?later:placement==='prepend'?previousIndex+1:result.length;
    result.splice(index,0,message);
  }
  // A native batch can fill a gap between already visible items (for example
  // raw-terminal input discovered after its answer). Its causal order wins.
  for(let i=1;i<batch.length;i++) {
    const before=result.findIndex(item=>item.id===batch[i-1].id);
    const current=result.findIndex(item=>item.id===batch[i].id);
    if(current<before) {const [message]=result.splice(current,1);result.splice(before,0,message);}
  }
  return result;
}

/** crypto.randomUUID is unavailable on HTTP LAN previews; getRandomValues is
 * also available in those contexts. Correlation is separate from native IDs. */
export function conversationClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
