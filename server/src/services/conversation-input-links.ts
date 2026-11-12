import {nativeConversationId} from './session-identity.js';
import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {getDb} from '../db/index.js';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import {formatConversationInput,nativeConversationInput,type ConversationAttachment} from './conversation-attachments.js';
import {conversationQuestionReply} from './conversation-question-reply.js';
import type {ConversationMessage} from './conversation-reader.js';

function inputHash(text:string){return createHash('sha256').update(text.replace(/\r\n?/g,'\n').trim()).digest('hex');}

/** Terminal-backed engines do not echo the browser's client ID. Record only a
 * fingerprint and file boundary before writing, then bind the new native user
 * record once. No extra log scan, prompt copy or model message is needed. */
export async function rememberConversationInput(sessionId:string,binding:PromptContextSession,clientId:string,text:string,previousFormat?:string){
  const nativeId=nativeConversationId(binding);
  if(!nativeId)return;
  const file=await nativeConversationFile(binding);if(!file)return;
  const boundary=(await stat(file.path)).size,db=getDb();
  db.prepare(`INSERT INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id,native_id,client_id) DO UPDATE SET input_hash=excluded.input_hash
    WHERE conversation_input_links.message_id IS NULL AND conversation_input_links.input_hash=?`).run(sessionId,nativeId,clientId,inputHash(text),boundary,previousFormat===undefined?'':inputHash(previousFormat));
  db.prepare(`DELETE FROM conversation_input_links WHERE session_id=? AND rowid NOT IN
    (SELECT rowid FROM conversation_input_links WHERE session_id=? ORDER BY rowid DESC LIMIT 256)`).run(sessionId,sessionId);
}

/** The native record remains authoritative. Repeated user sends are matched
 * one for one, scoped to the platform session and native conversation. */
export function linkConversationInputs(sessionId:string,nativeId:string|null|undefined,messages:ConversationMessage[]):ConversationMessage[]{
  if(!nativeId||!messages.some(message=>message.role==='user'&&message.sequence!==undefined))return messages;
  const db=getDb();
  const find=db.prepare(`SELECT client_id,message_id FROM conversation_input_links WHERE session_id=? AND native_id=?
    AND (message_id=? OR (message_id IS NULL AND input_hash=? AND after_offset<=?))
    ORDER BY message_id IS NULL,after_offset DESC,rowid ASC LIMIT 1`);
  const bind=db.prepare('UPDATE conversation_input_links SET message_id=? WHERE session_id=? AND native_id=? AND client_id=? AND message_id IS NULL');
  const known=db.prepare('SELECT message_id,after_offset FROM conversation_input_links WHERE session_id=? AND native_id=? AND client_id=?');
  const legacy=db.prepare(`SELECT l.client_id,l.input_hash,a.input_text,a.attachments FROM conversation_input_links l
    JOIN conversation_attachments a ON a.session_id=l.session_id AND a.client_id=l.client_id
    WHERE l.session_id=? AND l.native_id=? AND l.message_id IS NULL AND l.after_offset<=?
    ORDER BY l.after_offset DESC,l.rowid ASC LIMIT 256`);
  return db.transaction(()=>messages.map(message=>{
    if(message.role!=='user'||message.sequence===undefined)return message;
    // A browser identity from a different submission is authoritative even if
    // two intentionally repeated prompts have identical content.
    const existing=message.client_id?known.get(sessionId,nativeId,message.client_id) as {message_id:string|null;after_offset:number}|undefined:undefined;
    if(existing){if(!existing.message_id&&existing.after_offset<=message.sequence)bind.run(message.id,sessionId,nativeId,message.client_id);return message;}
    let row=find.get(sessionId,nativeId,message.id,inputHash(message.text),message.sequence) as {client_id:string;message_id:string|null}|undefined;
    if(!row){
      // Old fallback submissions journalled the native attachment format before
      // switching to terminal input. Recognize only the exact persisted draft,
      // scoped to the same session, native thread and original file boundary.
      for(const item of legacy.all(sessionId,nativeId,message.sequence) as Array<{client_id:string;input_hash:string;input_text:string;attachments:string}>){
        try {const attachments=JSON.parse(item.attachments) as ConversationAttachment[];if(!Array.isArray(attachments)||attachments.length>8)continue;
          const native=nativeConversationInput(item.input_text,attachments)[0].text,visible=conversationQuestionReply(native)?.text??native;
          const terminal=formatConversationInput(item.input_text,attachments,true),display=conversationQuestionReply(terminal)?.text??terminal;
          if(inputHash(visible)===item.input_hash&&inputHash(display)===inputHash(message.text)){row={client_id:item.client_id,message_id:null};break;}
        }catch{/* Corrupt legacy metadata cannot establish identity. */}
      }
    }
    if(!row)return message;
    if(!row.message_id)bind.run(message.id,sessionId,nativeId,row.client_id);
    return {...message,client_id:row.client_id,...message.client_id&&message.client_id!==row.client_id?{native_client_id:message.client_id}:{}};
  }))();
}

/** Forward only records already bound to an actual browser submission. */
export function boundConversationInputs(sessionId:string,nativeId:string,messages:ConversationMessage[]):ConversationMessage[]{
  const linked=linkConversationInputs(sessionId,nativeId,messages);
  const bound=getDb().prepare('SELECT 1 FROM conversation_input_links WHERE session_id=? AND native_id=? AND client_id=? AND message_id=?');
  return linked.filter(message=>message.role==='user'&&message.client_id&&bound.get(sessionId,nativeId,message.client_id,message.id));
}
