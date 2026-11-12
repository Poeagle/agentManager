import type {ConversationMessage} from './api';

export interface TimelineMessage extends ConversationMessage {
  optimistic?: {afterSequence:number;accepted?:boolean};
}

/** Merge only identities guaranteed by the transport contract.
 * Native messages use their public ID; local sends use client_id until the
 * native user item arrives. Text and timestamps never decide identity/order. */
export function mergeConversationTimeline(previous:TimelineMessage[],incoming:ConversationMessage[],placement:'append'|'prepend'='append'):TimelineMessage[] {
  const result=[...previous];
  for(let position=0;position<incoming.length;position++){
    const message=incoming[position];
    if(message.queued&&message.client_id&&result.some(item=>item.role==='user'&&item.client_id===message.client_id&&!item.queued&&!item.optimistic))continue;
    let index=result.findIndex(item=>item.id===message.id);
    if(index<0&&message.role==='user'&&message.client_id){
      index=result.findIndex(item=>item.role==='user'&&(item.client_id===message.client_id||item.native_client_id===message.client_id||!!message.native_client_id&&(item.client_id===message.native_client_id||item.native_client_id===message.native_client_id)));
    }
    if(index>=0){
      const old=result[index];
      // A verified durable terminal echo wins over a later replay of the live
      // native identity; the latter must not replace its sequence or client ID.
      if(old.role==='user'&&message.role==='user'&&old.id!==message.id&&old.sequence!==undefined&&message.sequence===undefined)continue;
      // A reconnect/history frame can contain an older snapshot of the same
      // live message. Never replace already streamed text with a shorter
      // non-sequenced projection; the next authoritative sequenced history
      // frame will still be allowed to settle it.
      if(old.role==='assistant'&&message.role==='assistant'&&old.text.length>message.text.length
        &&message.phase!=='error'){
        // A native assistant item is append-only from the UI's perspective.
        // History/reconnect projections may lag the live stream even when they
        // carry a sequence number; never regress visible text.
        result[index]={...old,...message,text:old.text,content_blocks:old.content_blocks?.length?old.content_blocks:message.content_blocks,
          streaming:message.streaming??(message.sequence!==undefined?false:old.streaming),optimistic:message.queued?old.optimistic:undefined,queued:message.queued??false};
        continue;
      }
      result[index]={...old,...message,streaming:message.streaming??(message.sequence!==undefined?false:old.streaming),optimistic:message.queued?old.optimistic:undefined,queued:message.queued??false};
      continue;
    }
    const nextId=incoming.slice(position+1).map(item=>item.id).find(id=>result.some(item=>item.id===id));
    const next=nextId?result.findIndex(item=>item.id===nextId):-1;
    const previous=position>0?result.findIndex(item=>item.id===incoming[position-1].id):-1;
    const later=message.sequence===undefined?-1:result.findIndex(item=>item.sequence!==undefined&&item.sequence>message.sequence!);
    const at=next>=0?next:later>=0?later:placement==='prepend'?previous+1:result.length;
    result.splice(at,0,message);
  }
  const byClient=new Map<string,number>(),remove=new Set<number>();
  result.forEach((item,index)=>{
    if(item.role!=='user'||!item.client_id)return;
    const identities=[item.client_id,...item.native_client_id?[item.native_client_id]:[]];
    const old=identities.map(id=>byClient.get(id)).find(value=>value!==undefined);
    if(old===undefined){for(const id of identities)byClient.set(id,index);return;}
    const oldItem=result[old];
    const keep=oldItem.optimistic&&!item.optimistic?index:!oldItem.optimistic&&item.optimistic?old:item.sequence!==undefined&&oldItem.sequence===undefined?index:old;
    remove.add(keep===old?index:old);for(const id of identities)byClient.set(id,keep);
  });
  const settled=result.filter((_item,index)=>!remove.has(index));
  // Live events can arrive before their durable sequence. Once history supplies
  // sequence numbers, repair the relative order of those known identities.
  // Keep unsequenced optimistic/live entries in their existing slots.
  const ordered=settled.filter(item=>!item.queued);
  const sequenced=ordered.filter(item=>item.sequence!==undefined).sort((a,b)=>a.sequence!-b.sequence!);
  let next=0;
  return [...ordered.map(item=>item.sequence===undefined?item:sequenced[next++]),...settled.filter(item=>item.queued)];
}

export function conversationClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
