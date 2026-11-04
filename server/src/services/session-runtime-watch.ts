import {agentForSession} from './agents/index.js';
import {sessionAgentContext,readAgentRuntime} from './agents/session.js';
import {nativeConversationId} from './session-identity.js';
import type {AgentSession} from './agents/types.js';
import {watch} from 'fs';
import {basename,dirname} from 'path';


import {broadcastEphemeral} from './event-store.js';


type Binding=AgentSession&{id:string;project_id:string|null};
const watches=new Map<string,{native:string;seen:number;stop:()=>void}>();
const attaching=new Map<string,Promise<void>>();
const targets=new Map<string,string>();

/** Observe only native file changes; terminal redraws cannot drive this state.
 * Share one watcher per platform session across all dashboard subscribers. */
export function watchSessionRuntime(session:Binding):Promise<void> {
  const nativeId=nativeConversationId(session),adapter=agentForSession(session);
  if(nativeId)targets.set(session.id,nativeId);else targets.delete(session.id);
  const previous=watches.get(session.id);
  if(previous&&previous.native===nativeId){previous.seen=Date.now();return Promise.resolve();}
  previous?.stop();watches.delete(session.id);
  if(!nativeId)return Promise.resolve();
  const key=`${session.id}:${nativeId}`,pending=attaching.get(key);if(pending)return pending;
  const work=(async()=>{
    const path=await adapter.history.file?.locate(sessionAgentContext(session));
    if(targets.get(session.id)!==nativeId)return;
    if(!path){targets.delete(session.id);return;}
    for(const [id,entry] of watches)if(Date.now()-entry.seen>120000||watches.size>=256){entry.stop();watches.delete(id);targets.delete(id);}
    let closed=false,reading=false,again=false,timer:ReturnType<typeof setTimeout>|undefined,last='';
    async function refresh(){timer=undefined;if(closed)return;reading=true;again=false;
      try{
        const runtime={...await readAgentRuntime(session,true)};if(closed)return;

        if(closed)return;
        const fingerprint=JSON.stringify([runtime.state,runtime.last_activity_at,runtime.completed_turn_id,runtime.pending_questions,runtime.submitted_question_ids,runtime.queued_answer_count]);
        if(last!==fingerprint){last=fingerprint;broadcastEphemeral({type:'session.runtime',session_id:session.id,...session.project_id?{project_id:session.project_id}:{},data:{runtime}});}
      }catch{/* A later native change or the polling fallback retries. */}
      finally{reading=false;if(again)changed();}
    }
    function changed(){if(closed)return;again=true;if(!reading&&!timer)timer=setTimeout(()=>void refresh(),80);}
    const observer=watch(dirname(path),(_event,name)=>{if(!name||name.toString()===basename(path))changed();});observer.unref();
    const unsubscribe=adapter.runtime.subscribe(sessionAgentContext(session),changed);
    const stop=()=>{closed=true;clearTimeout(timer);observer.close();unsubscribe();};
    observer.on('error',()=>{stop();if(watches.get(session.id)?.stop===stop){watches.delete(session.id);targets.delete(session.id);}});
    watches.set(session.id,{native:nativeId!,seen:Date.now(),stop});changed();
  })().catch(()=>{}).finally(()=>attaching.delete(key));attaching.set(key,work);return work;
}
export function stopSessionRuntimeWatches(){targets.clear();for(const entry of watches.values())entry.stop();watches.clear();}
