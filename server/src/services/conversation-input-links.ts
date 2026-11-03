import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {getDb} from '../db/index.js';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import type {ConversationMessage} from './conversation-reader.js';

function inputHash(text:string){return createHash('sha256').update(text.replace(/\r\n?/g,'\n').trim()).digest('hex');}

/** Terminal-backed engines do not echo the browser's client ID. Record only a
 * fingerprint and file boundary before writing, then bind the new native user
 * record once. No extra log scan, prompt copy or model message is needed. */
export async function rememberConversationInput(sessionId:string,binding:PromptContextSession,clientId:string,text:string){
  const nativeId=binding.cli_type==='codex'?binding.codex_session_id:binding.claude_session_id;
  if(!nativeId)return;
  const file=await nativeConversationFile(binding);if(!file)return;
  const boundary=(await stat(file.path)).size,db=getDb();
  db.prepare(`INSERT INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id,native_id,client_id) DO NOTHING`).run(sessionId,nativeId,clientId,inputHash(text),boundary);
  db.prepare(`DELETE FROM conversation_input_links WHERE session_id=? AND rowid NOT IN
    (SELECT rowid FROM conversation_input_links WHERE session_id=? ORDER BY rowid DESC LIMIT 256)`).run(sessionId,sessionId);
}

/** The native record remains authoritative. Repeated user sends are matched
 * one for one, scoped to the platform session and native conversation. */
export function linkConversationInputs(sessionId:string,nativeId:string|null|undefined,messages:ConversationMessage[]):ConversationMessage[]{
  if(!nativeId||!messages.some(message=>message.role==='user'&&message.sequence!==undefined&&!message.client_id))return messages;
  const db=getDb();
  const find=db.prepare(`SELECT client_id,message_id FROM conversation_input_links WHERE session_id=? AND native_id=?
    AND (message_id=? OR (message_id IS NULL AND input_hash=? AND after_offset<=?))
    ORDER BY message_id IS NULL,after_offset DESC,rowid ASC LIMIT 1`);
  const bind=db.prepare('UPDATE conversation_input_links SET message_id=? WHERE session_id=? AND native_id=? AND client_id=? AND message_id IS NULL');
  return db.transaction(()=>messages.map(message=>{
    if(message.role!=='user'||message.sequence===undefined||message.client_id)return message;
    const row=find.get(sessionId,nativeId,message.id,inputHash(message.text),message.sequence) as {client_id:string;message_id:string|null}|undefined;
    if(!row)return message;
    if(!row.message_id)bind.run(message.id,sessionId,nativeId,row.client_id);
    return {...message,client_id:row.client_id};
  }))();
}
