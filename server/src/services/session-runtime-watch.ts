import {watch} from 'fs';
import {basename,dirname} from 'path';
import {findCodexRollout} from './prompt-context.js';
import {readCodexRuntime} from './codex-runtime.js';
import {broadcastEphemeral} from './event-store.js';

type Binding={id:string;project_id:string|null;codex_session_id?:string|null};
const watches=new Map<string,{native:string;seen:number;stop:()=>void}>();
const attaching=new Map<string,Promise<void>>();
const targets=new Map<string,string>();

/** Observe only native file changes; terminal redraws cannot drive this state.
 * Share one watcher per platform session across all dashboard subscribers. */
export function watchSessionRuntime(session:Binding):Promise<void> {
  if(session.codex_session_id)targets.set(session.id,session.codex_session_id);else targets.delete(session.id);
  const previous=watches.get(session.id);
  if(previous&&previous.native===session.codex_session_id){previous.seen=Date.now();return Promise.resolve();}
  previous?.stop();watches.delete(session.id);
  if(!session.codex_session_id)return Promise.resolve();
  const key=`${session.id}:${session.codex_session_id}`,pending=attaching.get(key);if(pending)return pending;
  const work=(async()=>{
    const path=await findCodexRollout(session.codex_session_id!);
    if(targets.get(session.id)!==session.codex_session_id)return;
    if(!path){targets.delete(session.id);return;}
    for(const [id,entry] of watches)if(Date.now()-entry.seen>120000||watches.size>=256){entry.stop();watches.delete(id);targets.delete(id);}
    let closed=false,reading=false,again=false,timer:ReturnType<typeof setTimeout>|undefined,last='',live=false,checked=0;
    async function refresh(){timer=undefined;if(closed)return;reading=true;again=false;
      try{
        const runtime={...await readCodexRuntime(session.codex_session_id)};if(closed)return;
        if(['running','waiting_for_input'].includes(runtime.state)){
          if(!live||Date.now()-checked>5000){const {getLiveWorkAgent}=await import('./session-manager.js');live=await getLiveWorkAgent(session.id)==='codex';checked=Date.now();}
          if(!live){runtime.state='unknown';runtime.reason='原生记录中的执行尚未结束，但未确认到对应 Codex 进程，当前状态待确认';}
        }
        if(closed)return;
        const fingerprint=JSON.stringify([runtime.state,runtime.last_activity_at,runtime.completed_turn_id,runtime.pending_questions]);
        if(last!==fingerprint){last=fingerprint;broadcastEphemeral({type:'session.runtime',session_id:session.id,...session.project_id?{project_id:session.project_id}:{},data:{runtime}});}
      }catch{/* A later native change or the polling fallback retries. */}
      finally{reading=false;if(again)changed();}
    }
    function changed(){if(closed)return;again=true;if(!reading&&!timer)timer=setTimeout(()=>void refresh(),80);}
    const observer=watch(dirname(path),(_event,name)=>{if(!name||name.toString()===basename(path))changed();});observer.unref();
    const stop=()=>{closed=true;clearTimeout(timer);observer.close();};
    observer.on('error',()=>{stop();if(watches.get(session.id)?.stop===stop){watches.delete(session.id);targets.delete(session.id);}});
    watches.set(session.id,{native:session.codex_session_id!,seen:Date.now(),stop});changed();
  })().catch(()=>{}).finally(()=>attaching.delete(key));attaching.set(key,work);return work;
}
export function stopSessionRuntimeWatches(){targets.clear();for(const entry of watches.values())entry.stop();watches.clear();}
