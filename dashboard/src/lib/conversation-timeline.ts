import type {ConversationMessage} from './api';

export interface TimelineMessage extends ConversationMessage {
  /** A local send reserves its position before either HTTP or native echo. */
  optimistic?: {afterSequence:number};
  /** Codex assigns different user IDs to stream items and rollout records. */
  aliases?: string[];
}

function sameInput(a:ConversationMessage,b:ConversationMessage) {
  const normalize=(text:string)=>text.replace(/\r\n?/g,'\n').trim();
  return normalize(a.text)===normalize(b.text) && (!a.attachments || !b.attachments || JSON.stringify(a.attachments.map(item=>item.path))===JSON.stringify(b.attachments.map(item=>item.path)));
}

/** Reconcile ordered native batches. Timestamps are display data, never order
 * keys: client clocks, item-start times and durable completion times differ. */
export function mergeConversationTimeline(previous:TimelineMessage[],incoming:ConversationMessage[],placement:'append'|'prepend'='append'):TimelineMessage[] {
  const result=[...previous];
  const batch:TimelineMessage[]=[];
  const matched=new Set<number>();
  for(const message of incoming) {
    if(message.queued&&message.client_id&&result.some(item=>item.role==='user'&&item.client_id===message.client_id&&!item.queued&&!item.optimistic))continue;
    let index=result.findIndex(item=>item.id===message.id || item.aliases?.includes(message.id));
    if(index<0&&message.role==='user'&&message.client_id)index=result.findIndex((item,i)=>!matched.has(i)&&item.role==='user'&&item.client_id===message.client_id);
    if(index<0 && message.role==='user') {
      index=result.findIndex(item=>(item.optimistic||item.queued) && (message.client_id
        ? item.client_id===message.client_id
        : message.sequence!==undefined && !!item.optimistic && message.sequence>item.optimistic.afterSequence && sameInput(item,message)));
    }
    if(index<0 && message.turn_id) {
      // Native stream/rollout item IDs can differ after resume. Reconcile ordered
      // occurrences within the same turn, including identical followups.
      index=result.findIndex((item,index)=>!matched.has(index) && !item.optimistic && item.role===message.role && item.turn_id===message.turn_id && sameInput(item,message) && (message.role==='user' || item.phase===message.phase) && (!item.client_id || !message.client_id || item.client_id===message.client_id) && (item.sequence===undefined)!==(message.sequence===undefined));
    }
    if(index>=0) {
      matched.add(index);
      const old=result[index];
      // A stale live snapshot must not turn a persisted answer back into an
      // incomplete stream. Keep native order/identity and local correlation.
      const value=old.sequence!==undefined && message.sequence===undefined
        ? {...message,...old,client_id:message.client_id??old.client_id}
        : {...old,...message,streaming:message.streaming??false,optimistic:message.queued?old.optimistic:undefined,queued:message.queued??false};
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
  // A native ID can be learned after both the optimistic and durable copies
  // already exist. Once the client ID is available, settle that pair too.
  const correlated=new Map<string,number>(),removed=new Set<number>();
  const rank=(item:TimelineMessage)=>item.sequence!==undefined?3:!item.optimistic&&!item.queued?2:item.queued?1:0;
  result.forEach((item,index)=>{
    if(item.role!=='user'||!item.client_id)return;
    const previous=correlated.get(item.client_id);
    if(previous===undefined){correlated.set(item.client_id,index);return;}
    const keep=rank(item)>rank(result[previous])?index:previous,drop=keep===index?previous:index;
    result[keep]={...result[drop],...result[keep],aliases:[...new Set([...(result[keep].aliases||[]),...(result[drop].aliases||[]),result[drop].id])],queued:rank(result[keep])>=2?false:result[keep].queued,optimistic:rank(result[keep])>=2?undefined:result[keep].optimistic};
    removed.add(drop);correlated.set(item.client_id,keep);
  });
  const settled=result.filter((_item,index)=>!removed.has(index));
  return [...settled.filter(item=>!item.queued),...settled.filter(item=>item.queued)];
}

/** crypto.randomUUID is unavailable on HTTP LAN previews; getRandomValues is
 * also available in those contexts. Correlation is separate from native IDs. */
export function conversationClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
