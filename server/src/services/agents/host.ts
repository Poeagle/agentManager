import {agentForSession} from './index.js';
import {sessionAgentContext} from './session.js';
import {getDb} from '../../db/index.js';
import {broadcastEphemeral} from '../event-store.js';
import type {AgentSession,AgentConnection} from './types.js';
import type {AgentStreamFrame} from './events.js';
type Host={agentId:string;nativeId:string;stop:AgentConnection};
const hosts=new Map<string,Host>();
export function isManagedAgentActive(id:string){return hosts.has(id);}
/** Keep one state-only lease while the managed runtime is active. The shared
 * stream hub owns connection fan-out and replay for browsers and monitors. */
export function attachManagedAgent(session:AgentSession&{id:string}):void {
 const adapter=agentForSession(session),context=sessionAgentContext(session);
 if(adapter.descriptor.sessionHost!=='managed'||!context.nativeId)throw Error('Agent service identity is unavailable');
 const current=hosts.get(session.id);if(current?.nativeId===context.nativeId&&current.agentId===adapter.descriptor.id)return;
 detachManagedAgent(session.id);
 let closed=false,reading=false,again=false,timer:ReturnType<typeof setTimeout>|undefined,last='',scheduled='';
 async function publish(){timer=undefined;if(closed)return;if(reading){again=true;return;}reading=true;
  try{const runtime=await adapter.runtime.read(context);if(closed)return;const {observed_at,...facts}=runtime;const fingerprint=JSON.stringify(facts);if(last===fingerprint)return;last=fingerprint;
   broadcastEphemeral({type:'session.runtime',session_id:session.id,...session.project_id?{project_id:session.project_id}:{},data:{runtime}});
  }catch{/* Native lifecycle events retry without adding a polling loop. */}
  finally{reading=false;if(again&&!closed){again=false;changed();}}
 }
 function changed(){if(!closed&&!timer)timer=setTimeout(()=>void publish(),50);}
 function notify(frame:AgentStreamFrame){if(closed)return;
  const fingerprint=frame.type==='snapshot'?JSON.stringify([frame.busy,frame.turn_id,frame.stage,frame.interactions,frame.compaction]):frame.type==='queue'?JSON.stringify(frame.messages.map(message=>message.client_id)):null;
  if(fingerprint!==null&&scheduled!==fingerprint){scheduled=fingerprint;changed();}
 }
 const connection=adapter.stream.observe({...context,streamFormat:'state'},notify);
 const stop=Object.assign(()=>{closed=true;clearTimeout(timer);connection();},{respond:connection.respond});
 hosts.set(session.id,{agentId:adapter.descriptor.id,nativeId:context.nativeId,stop});
 try{getDb().prepare("UPDATE sessions SET status='running',pid=NULL,updated_at=datetime('now') WHERE id=?").run(session.id);}catch(error){detachManagedAgent(session.id);throw error;}
 void publish();
}
export function observeAgentConversation(session:AgentSession&{id:string},emit:(frame:AgentStreamFrame)=>void,onFailure?:Parameters<import('./types.js').AgentStreamPort['observe']>[2],format:'incremental'|'snapshot'='snapshot'):AgentConnection{
 const adapter=agentForSession(session);if(adapter.descriptor.sessionHost==='managed')attachManagedAgent(session);
 return adapter.stream.observe({...sessionAgentContext(session),streamFormat:format},emit,onFailure);
}
export function detachManagedAgent(id:string){const host=hosts.get(id);if(!host)return;hosts.delete(id);host.stop();}
export function detachManagedAgents(){for(const id of hosts.keys())detachManagedAgent(id);}
