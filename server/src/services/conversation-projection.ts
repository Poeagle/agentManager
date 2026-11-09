import type {AgentMessage} from './agents/types.js';
import type {AgentStreamFrame} from './agents/events.js';

export interface DurableConversationFrame {
  type:'history';
  messages:AgentMessage[];
  runtime:unknown;
}

type MessageFrame = AgentStreamFrame|DurableConversationFrame;

/** Exact-identity projection shared by live protocol and durable history.
 * Adapters must publish the same public ID for the same native item. This
 * layer deliberately performs no text, phase, timestamp or turn guessing. */
export class ConversationProjection {
  private messages:AgentMessage[]=[];
  private byId=new Map<string,number>();
  private runtimeFingerprint='';

  private merge(incoming:AgentMessage[]){
    const changed:AgentMessage[]=[];
    for(const message of incoming){
      const index=this.byId.get(message.id);
      if(index===undefined){
        this.byId.set(message.id,this.messages.length);
        this.messages.push(message);
        changed.push(message);
        continue;
      }
      const old=this.messages[index];
      const value={...old,...message,id:old.id,streaming:message.streaming??(message.sequence!==undefined?false:old.streaming)};
      if(JSON.stringify(old)!==JSON.stringify(value)){
        this.messages[index]=value;
        changed.push(value);
      }
    }
    // History supplies durable ordering after live items have been projected.
    // Reorder only sequenced slots so pending live items keep their positions.
    if(incoming.some(item=>item.sequence!==undefined)) {
      const sequenced=this.messages.filter(item=>item.sequence!==undefined).sort((a,b)=>a.sequence!-b.sequence!);
      let next=0;
      this.messages=this.messages.map(item=>item.sequence===undefined?item:sequenced[next++]);
      this.byId=new Map(this.messages.map((item,index)=>[item.id,index]));
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
      this.merge(frame.messages);
      return {...frame,messages:this.messages};
    }
    if(frame.type==='patch'){
      const changed=this.merge(frame.upserts);
      for(const delta of frame.deltas){
        const index=this.byId.get(delta.id);
        if(index===undefined)continue;
        const current=this.messages[index];
        if(current.text.length===delta.offset)this.messages[index]={...current,text:current.text+delta.text,streaming:true};
      }
      return {...frame,upserts:changed};
    }
    return frame;
  }
}
