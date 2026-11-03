import {watch} from 'node:fs';
import {basename,dirname} from 'node:path';
import {isAdmin} from '../auth.js';
import {findCodexRollout} from './prompt-context.js';
import {readCodexRuntime} from './codex-runtime.js';
import {getSession,ensureCodexConversationStreaming} from './session-manager.js';
import {withCodexConnection} from './conversation-stream.js';

const jobs=new Map<string,{native:string;stop:()=>void}>();
/** A requested legacy upgrade waits for a quiet, completed turn. Observe file
 * notifications, never poll the model or interrupt an active embedded engine. */
export async function scheduleCodexStreamingUpgrade(sessionId:string):Promise<boolean>{
  const session=getSession(sessionId),native=session?.codex_session_id;
  if(!session||session.status!=='running'||session.cli_type!=='codex'||!native||!process.env.AGENTMANAGER_CODEX_STREAM_SOCKET||session.created_by_user_id&&!isAdmin(session.created_by_user_id))return false;
  if(jobs.get(sessionId)?.native===native)return true;
  jobs.get(sessionId)?.stop();
  const path=await findCodexRollout(native);if(!path)return false;
  if(getSession(sessionId)?.codex_session_id!==native)return false;
  if(jobs.get(sessionId)?.native===native)return true;
  let closed=false,checking=false,timer:ReturnType<typeof setTimeout>|undefined;
  const observer=watch(dirname(path),(_event,name)=>{if(!name||name.toString()===basename(path))changed();});observer.unref();
  const expiry=setTimeout(()=>stop(),30*60000);expiry.unref();
  function stop(){if(closed)return;closed=true;clearTimeout(timer);clearTimeout(expiry);observer.close();if(jobs.get(sessionId)?.stop===stop)jobs.delete(sessionId);}
  function changed(){if(closed)return;clearTimeout(timer);timer=setTimeout(()=>void check(),750);timer.unref();}
  async function check(){
    if(closed||checking)return;checking=true;
    try{
      const current=getSession(sessionId);
      if(!current||current.codex_session_id!==native||current.status!=='running'){stop();return;}
      if((await readCodexRuntime(native)).state!=='idle')return;
      const loaded=await withCodexConnection(async request=>(await request('thread/read',{threadId:native})).thread?.status?.type);
      if(closed)return;
      if(loaded==='notLoaded'&&!await ensureCodexConversationStreaming(sessionId))return;
      stop();
    }catch(error){console.warn(`[streaming-upgrade] ${sessionId}: ${error instanceof Error?error.message:'upgrade failed'}`);stop();}
    finally{checking=false;}
  }
  observer.on('error',stop);jobs.set(sessionId,{native,stop});changed();return true;
}
export function stopCodexStreamingUpgrades(){for(const job of jobs.values())job.stop();}
