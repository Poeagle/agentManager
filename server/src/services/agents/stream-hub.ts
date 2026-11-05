import {randomUUID} from 'crypto';
import type {AgentContext,AgentConnection,AgentStreamPort} from './types.js';
import type {AgentStreamFrame,AgentStreamSnapshot,AgentStreamPatch} from './events.js';

type Listener={emit:(frame:AgentStreamFrame)=>void;failure?:Parameters<AgentStreamPort['observe']>[2];format:AgentContext['streamFormat']};
type Entry={id:string;seq:number;version:number;attempt:number;context:AgentContext;listeners:Set<Listener>;connection?:AgentConnection;timer?:ReturnType<typeof setTimeout>;snapshot?:AgentStreamSnapshot;cached:Map<string,AgentStreamFrame>};
const MAX_MESSAGES=128,MAX_TEXT=256*1024;
/** One native subscription per provider, native conversation and credential scope.
 * User-specific authorization and reminder preferences stay at the API boundary. */
export function sharedAgentStream(source:AgentStreamPort):AgentStreamPort {
  const entries=new Map<string,Entry>();
  const key=(c:AgentContext)=>JSON.stringify([c.nativeId??`unbound:${c.session.id}`,source.scope?.(c)??[c.session.created_by_user_id??null,c.projectPath]]);
  function bound(snapshot:AgentStreamSnapshot):AgentStreamSnapshot{
    const keep=new Set(snapshot.messages.filter(message=>message.streaming).map(message=>message.id));
    let bytes=snapshot.messages.filter(message=>keep.has(message.id)).reduce((sum,message)=>sum+message.text.length,0);
    for(let i=snapshot.messages.length-1;i>=0&&keep.size<MAX_MESSAGES;i--){const message=snapshot.messages[i];if(keep.has(message.id))continue;if(bytes+message.text.length>MAX_TEXT&&keep.size)break;keep.add(message.id);bytes+=message.text.length;}
    return {...snapshot,messages:snapshot.messages.filter(message=>keep.has(message.id))};
  }
  function apply(entry:Entry,patch:AgentStreamPatch){
    if(!entry.snapshot&&!patch.state)return;
    const previous=entry.snapshot?.messages||[],byId=new Map(previous.map(message=>[message.id,message]));
    for(const message of patch.upserts)byId.set(message.id,message);
    for(const delta of patch.deltas){const message=byId.get(delta.id);if(message&&message.text.length===delta.offset)byId.set(delta.id,{...message,text:message.text+delta.text,streaming:true});}
    entry.snapshot=bound({...entry.snapshot!,...patch.state,type:'snapshot',messages:[...byId.values()]});
  }
  function deliver(entry:Entry,frame:AgentStreamFrame){
    if(frame.type==='snapshot'){entry.snapshot=bound(frame);frame=entry.snapshot;}
    else if(frame.type==='patch')apply(entry,frame);
    else entry.cached.set(frame.type,frame);
    if(frame.type==='snapshot'||frame.type==='patch')entry.cached.delete('unavailable');
    const tagged={...frame,stream_id:entry.id,stream_seq:++entry.seq};
    for(const listener of entry.listeners){
      if(frame.type==='patch'&&listener.format!=='incremental'){
        if(listener.format==='state'&&!frame.state&&!frame.upserts.length)continue;
        if(entry.snapshot)listener.emit({...entry.snapshot,stream_id:entry.id,stream_seq:entry.seq});
      }else listener.emit(tagged);
    }
  }
  function disconnect(entry:Entry){entry.version++;const connection=entry.connection;entry.connection=undefined;connection?.();}
  function reconnect(entry:Entry,reason:string){
    if(entry.timer||!entry.listeners.size)return;
    disconnect(entry);
    const delay=Math.min(10000,500*2**Math.min(entry.attempt++,5))+Math.floor(Math.random()*200);
    deliver(entry,{type:'unavailable',reason,retrying:true,reconnect:false});
    entry.timer=setTimeout(()=>{entry.timer=undefined;connect(entry);},delay);entry.timer.unref?.();
  }
  function connect(entry:Entry){
    const version=++entry.version;
    try{
      const connection=source.observe({...entry.context,streamFormat:'incremental'},frame=>{
        if(version!==entry.version||!entry.listeners.size)return;
        if(frame.type==='unavailable'&&frame.reconnect){reconnect(entry,frame.reason);return;}
        if(frame.type==='snapshot')entry.attempt=0;
        deliver(entry,frame);
      },(turn,error,willRetry)=>{if(version===entry.version)for(const listener of entry.listeners)listener.failure?.(turn,error,willRetry);});
      if(version===entry.version)entry.connection=connection;else connection();
    }catch{reconnect(entry,'实时连接暂不可用，正在自动恢复');}
  }
  return {...source,observe:(context,emit,failure)=>{
    const id=key(context);let entry=entries.get(id);const listener:Listener={emit,failure,format:context.streamFormat};
    if(!entry){entry={id:randomUUID(),seq:0,version:0,attempt:0,context,listeners:new Set(),cached:new Map()};entries.set(id,entry);entry.listeners.add(listener);connect(entry);}
    else{
      entry.listeners.add(listener);
      if(entry.snapshot)emit({...entry.snapshot,stream_id:entry.id,stream_seq:entry.seq,baseline:true});
      for(const frame of entry.cached.values())emit({...frame,stream_id:entry.id,stream_seq:entry.seq,baseline:true});
    }
    const current=entry;let stopped=false;
    return Object.assign(()=>{if(stopped)return;stopped=true;current.listeners.delete(listener);if(!current.listeners.size){clearTimeout(current.timer);disconnect(current);entries.delete(id);}},{respond:(request:string,answer:unknown)=>{if(!current.connection)throw Error('实时连接正在恢复，请稍后处理');return current.connection.respond(request,answer);}});
  },shutdown:async()=>{for(const entry of entries.values()){clearTimeout(entry.timer);disconnect(entry);entry.listeners.clear();}entries.clear();await source.shutdown?.();}};
}
