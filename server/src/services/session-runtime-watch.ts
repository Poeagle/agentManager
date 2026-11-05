import {agentForSession} from './agents/index.js';
import {sessionAgentContext,readAgentRuntime} from './agents/session.js';
import {nativeConversationId} from './session-identity.js';
import {watchNativeFile} from './agents/file-watch.js';
import type {AgentSession} from './agents/types.js';
import {broadcastEphemeral} from './event-store.js';
type Binding=AgentSession&{id:string;project_id:string|null};
const watches=new Map<string,{key:string;seen:number;stop:()=>void}>();
/** Runtime events are independent of rollout creation. A file observer is an
 * optional supplementary source, with recovery limited to observer failures. */
export function watchSessionRuntime(session:Binding):Promise<void>{
 const native=nativeConversationId(session),adapter=agentForSession(session),key=JSON.stringify([adapter.descriptor.id,native]);
 const previous=watches.get(session.id);if(previous?.key===key){previous.seen=Date.now();return Promise.resolve();}
 previous?.stop();watches.delete(session.id);if(!native)return Promise.resolve();
 for(const [id,entry] of watches)if(Date.now()-entry.seen>120000||watches.size>=256){entry.stop();watches.delete(id);}
 const context=sessionAgentContext(session);let closed=false,reading=false,again=false,last='',timer:ReturnType<typeof setTimeout>|undefined;
 function changed(){if(closed)return;again=true;if(!reading&&!timer)timer=setTimeout(()=>void refresh(),50);}
 async function refresh(){timer=undefined;if(closed)return;reading=true;again=false;
  try{const runtime=await readAgentRuntime(session,true);if(closed)return;const {observed_at,...facts}=runtime,fingerprint=JSON.stringify(facts);
   if(last!==fingerprint){last=fingerprint;broadcastEphemeral({type:'session.runtime',session_id:session.id,...session.project_id?{project_id:session.project_id}:{},data:{runtime}});}
  }catch{/* The next native event or recovered file observer retries. */}
  finally{reading=false;if(again)changed();}
 }
 const file=adapter.history.file?watchNativeFile(()=>adapter.history.file!.locate(context),changed):undefined;
 const unsubscribe=adapter.runtime.subscribe(context,()=>{file?.poke();changed();});
 const stop=()=>{closed=true;clearTimeout(timer);file?.stop();unsubscribe();};
 watches.set(session.id,{key,seen:Date.now(),stop});changed();return Promise.resolve();
}
export function stopSessionRuntimeWatches(){for(const entry of watches.values())entry.stop();watches.clear();}
