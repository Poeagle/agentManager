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
      index=result.findIndex(item=>item.role==='user'&&item.client_id===message.client_id);
    }
    if(index>=0){
      const old=result[index];
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
    const old=byClient.get(item.client_id);
    if(old===undefined){byClient.set(item.client_id,index);return;}
    const oldItem=result[old];
    const keep=oldItem.optimistic&&!item.optimistic?index:!oldItem.optimistic&&item.optimistic?old:item.sequence!==undefined&&oldItem.sequence===undefined?index:old;
    remove.add(keep===old?index:old);byClient.set(item.client_id,keep);
  });
  const settled=result.filter((_item,index)=>!remove.has(index));
  return [...settled.filter(item=>!item.queued),...settled.filter(item=>item.queued)];
}

export function conversationClientId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
