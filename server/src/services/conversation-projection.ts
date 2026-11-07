import type {AgentMessage} from './agents/types.js';
import type {AgentStreamFrame,AgentStreamPatch,AgentStreamSnapshot} from './agents/events.js';

export interface DurableConversationFrame {
  type:'history';
  messages:AgentMessage[];
  runtime:unknown;
}

type MessageFrame = AgentStreamFrame|DurableConversationFrame;

function text(value:string){return value.replace(/\r\n?/g,'\n').trim();}
function semantic(message:AgentMessage){
  return `${message.role}|${message.turn_id||''}|${message.phase||''}|${text(message.text)}`;
}
function compatible(a:AgentMessage,b:AgentMessage){
  if(a.role!==b.role)return false;
  // Native and rollout records may expose different internal turn UUIDs.
  // Assistant text is still safe to reconcile inside the current user turn;
  // user boundaries are enforced by locate().
  if(a.turn_id&&b.turn_id&&a.turn_id!==b.turn_id && a.role!=='assistant')return false;
  if(a.role==='assistant' && a.phase && b.phase && a.phase!==b.phase && a.phase!=='commentary' && b.phase!=='commentary')return false;
  const left=text(a.text),right=text(b.text);
  return left===right || a.role==='assistant' && (left.startsWith(right)||right.startsWith(left));
}
function richer(old:AgentMessage,next:AgentMessage):AgentMessage {
  const final=old.phase==='final'||next.phase==='final'?'final':old.phase||next.phase;
  const picked=next.text.length>=old.text.length?next:old;
  // Keep the first public ID as the canonical identity. Durable rollout
  // records frequently use a different item ID for the same native message.
  return {...old,...picked,id:old.id,...final?{phase:final}:{},streaming:next.streaming===false||old.streaming===false?false:(next.streaming??old.streaming)};
}

/** Server-side projection of native events and durable rollout history.
 * The browser receives only the result of this projection, so a rollout
 * replay cannot append a second copy of a live item. */
export class ConversationProjection {
  private messages:AgentMessage[]=[];
  private aliases=new Map<string,string>();
  private seenNative=false;
  private runtimeFingerprint='';

  private locate(message:AgentMessage){
    const direct=this.messages.findIndex(item=>item.id===message.id||this.aliases.get(message.id)===item.id);
    if(direct>=0)return direct;
    const lastUser=this.messages.map((item,index)=>item.role==='user'?index:-1).reduce((max,index)=>Math.max(max,index),-1);
    const start=message.role==='user'?Math.max(0,lastUser):lastUser+1;
    for(let index=this.messages.length-1;index>=start;index--)if(compatible(this.messages[index],message))return index;
    return -1;
  }

  private merge(incoming:AgentMessage[]){
    const changed:AgentMessage[]=[];
    for(const message of incoming){
      const index=this.locate(message);
      if(index<0){this.messages.push(message);changed.push(message);continue;}
      const old=this.messages[index],value=richer(old,message);
      if(old.id!==value.id)this.aliases.set(value.id,old.id);
      if(JSON.stringify(old)!==JSON.stringify(value)){this.messages[index]=value;changed.push(value);}
    }
    return changed;
  }

  accept(frame:MessageFrame):MessageFrame|null {
    if(frame.type==='history'){
      const changed=this.merge(frame.messages);
      const runtime=JSON.stringify(frame.runtime);
      const runtimeChanged=runtime!==this.runtimeFingerprint;
      this.runtimeFingerprint=runtime;
      return changed.length||runtimeChanged?{...frame,messages:changed}:null;
    }
    if(frame.type==='snapshot'){
      this.seenNative=true;
      this.merge(frame.messages);
      return {...frame,messages:this.messages};
    }
    if(frame.type==='patch'){
      this.seenNative=true;
      const changed=this.merge(frame.upserts);
      for(const delta of frame.deltas){
        const canonical=this.aliases.get(delta.id)||delta.id;
        const index=this.messages.findIndex(item=>item.id===canonical);
        if(index<0)continue;
        const current=this.messages[index];
        if(current.text.length===delta.offset){
          const value={...current,text:current.text+delta.text,streaming:true};
          this.messages[index]=value;
        }
      }
      const deltas=frame.deltas.map(delta=>{
        const canonical=this.aliases.get(delta.id)||delta.id;
        return canonical===delta.id?delta:{...delta,id:canonical};
      });
      // The internal projection applies deltas to keep its recovery state
      // current; the browser must still receive the delta against its own
      // previous text, not an already-expanded upsert.
      return {...frame,upserts:changed,deltas};
    }
    return frame;
  }

  get hasNative(){return this.seenNative;}
}
