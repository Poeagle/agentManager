import {watch,type FSWatcher} from 'fs';
import {dirname,basename} from 'path';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import {readConversation,type ConversationMessage} from './conversation-reader.js';
import {readCodexRuntime,type CodexRuntime} from './codex-runtime.js';
export interface ConversationHistoryFrame {type:'history';messages:ConversationMessage[];runtime:CodexRuntime}
/** Legacy CLIs have no observable RPC owner. Push newly persisted public
 * messages on file changes instead of waiting for a browser polling tick. */
export function observeConversationFile(binding:PromptContextSession,emit:(frame:ConversationHistoryFrame)=>void) {
  let closed=false,watcher:FSWatcher|undefined,timer:ReturnType<typeof setTimeout>|undefined,reading=false,again=false,cursor:string|undefined,lastState:string|undefined;
  function changed(){if(closed)return;again=true;if(!reading&&!timer)timer=setTimeout(()=>void refresh(),50);}
  async function refresh(){timer=undefined;if(closed)return;reading=true;again=false;
    try {const page=await readConversation(binding,cursor?{after:cursor,limit:20}:{limit:8}),runtime=await readCodexRuntime(binding.codex_session_id);
      if(closed)return;if(page.messages.length||lastState!==runtime.state){emit({type:'history',messages:page.messages,runtime});lastState=runtime.state;}cursor=page.messages.at(-1)?.id||cursor;
      if(page.messages.length===20)again=true;
    }catch{/* Native engine may be rotating a rollout; a later change retries. */}
    finally{reading=false;if(again)changed();}
  }
  void nativeConversationFile(binding).then(file=>{if(!file||closed)return;watcher=watch(dirname(file.path),(_event,name)=>{if(!name||name.toString()===basename(file.path))changed();});watcher.on('error',()=>{watcher?.close();});changed();}).catch(()=>{});
  return ()=>{closed=true;clearTimeout(timer);watcher?.close();};
}
