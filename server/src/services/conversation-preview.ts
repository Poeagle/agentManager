import {getDb} from '../db/index.js';
import {readConversation} from './conversation-reader.js';
import type {PromptContextSession} from './prompt-context.js';

interface PreviewSession {cli_type?:string|null;codex_session_id?:string|null;claude_session_id?:string|null;project_id?:string|null;project_path?:string|null}
interface ConversationPreview {text:string;timestamp:string|null;phase:string|null}
const cache=new Map<string,{until:number;value:ConversationPreview|null}>();
const pending=new Map<string,Promise<ConversationPreview|null>>();
const waiters:Array<()=>void>=[];let readers=0;
async function acquire(){if(readers>=2)await new Promise<void>(resolve=>waiters.push(resolve));else readers++;}
function release(){const next=waiters.shift();if(next)next();else readers--;}
export function humanSessionTask(task:string|null|undefined) {
  return (task||'').replace(/\s*\[Platform task reference: [A-Za-z0-9_-]+\]/g,'').replace(/\s+/g,' ').trim().slice(0,180)||'暂无对话内容';
}
/** Summaries use the same public native transcript as chat. Bound concurrent
 * reads and cache only a short excerpt, never PTY screens or tool results. */
export function readConversationPreview(session:PreviewSession):Promise<ConversationPreview|null> {
  const kind=session.cli_type==='codex'?'codex':'claude',id=kind==='codex'?session.codex_session_id:session.claude_session_id;
  if(!id)return Promise.resolve(null);
  const key=JSON.stringify([process.env.CODEX_HOME||'',process.env.HOME||'',kind,id,session.project_id,session.project_path]);
  const saved=cache.get(key);if(saved&&saved.until>Date.now())return Promise.resolve(saved.value);
  const running=pending.get(key);if(running)return running;
  const work=(async()=>{
    await acquire();
    try {
      const path=session.project_path??(kind==='claude'&&session.project_id?(getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined)?.path:null);
      const binding:PromptContextSession={cli_type:kind,codex_session_id:session.codex_session_id||null,claude_session_id:session.claude_session_id||null,project_path:path||null};
      const page=await readConversation(binding,{limit:12});
      const message=[...page.messages].reverse().find(message=>message.role==='assistant'&&message.text.trim());
      const text=message?.text.slice(0,2000).replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*#>`~]/g,'').replace(/\s+/g,' ').trim().slice(0,320);
      const value=text?{text,timestamp:message!.timestamp,phase:message!.async_questions?'question':message!.phase||null}:null;
      cache.delete(key);cache.set(key,{value,until:Date.now()+3000});if(cache.size>256)cache.delete(cache.keys().next().value!);
      return value;
    }catch{return null;}
    finally{release();pending.delete(key);}
  })();pending.set(key,work);return work;
}
