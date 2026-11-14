import {getDb} from '../../../db/index.js';
import {saveNativeSessionTitle} from '../../native-session-titles.js';
/** Thread identities are scoped to the environment that produced the metadata. */
export function rememberCodexTitle(threadId:unknown,title:unknown,environmentId='native'){
 if(typeof threadId!=='string'||typeof title!=='string'||!title.trim())return;
 const sessions=getDb().prepare("SELECT id FROM sessions WHERE COALESCE(agent_id,cli_type)='codex' AND COALESCE(native_session_id,codex_session_id)=? AND COALESCE(agent_environment_id,'native')=?").all(threadId,environmentId) as {id:string}[];
 for(const session of sessions)saveNativeSessionTitle(session.id,title);
}
