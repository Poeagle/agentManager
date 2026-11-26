import {decorateBatches} from './conversation-batches.js';
import {nativeConversationId} from './session-identity.js';
import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {getDb} from '../db/index.js';
import {nativeConversationFile,type PromptContextSession} from './prompt-context.js';
import {formatConversationInput,nativeConversationInput,type ConversationAttachment} from './conversation-attachments.js';
import {conversationQuestionReply} from './conversation-question-reply.js';
import {readConversation,type ConversationMessage} from './conversation-reader.js';
import {automaticConversationContext} from '../shared/conversation-context.js';

function inputHash(text:string){return createHash('sha256').update(text.replace(/\r\n?/g,'\n').trim()).digest('hex');}

export function isConversationInput(message:ConversationMessage):boolean {
  return message.role==='user'&&!message.queued&&!message.streaming&&
    (!!message.input_source||!automaticConversationContext(message.text));
}

export function hasScheduledConversationInput(sessionId:string):boolean {
  return !!getDb().prepare("SELECT 1 FROM conversation_input_sources WHERE session_id=? AND kind='scheduled' LIMIT 1").get(sessionId);
}

/** Resolve attribution by the exact outcome cursor, with bounded history reads. */
export async function precedingScheduledInput(session:PromptContextSession&{id:string},nativeId:string,before:string):Promise<boolean|undefined> {
  let generation:string|null|undefined;
  for(let i=0;i<4;i++){
    const page=await readConversation(session,{before,limit:80});
    if(!page.available||page.reset||(generation!==undefined&&page.generation!==generation))return;
    const previous=linkConversationInputs(session.id,nativeId,page.messages).reverse().find(isConversationInput);
    if(previous)return previous.input_source?.kind==='scheduled';
    if(!page.has_more)return false;
    const cursor=page.messages[0]?.id;
    if(!cursor||cursor===before)return;
    before=cursor;generation=page.generation;
  }
}

export function rememberInputSource(sessionId:string,clientId:string,source:{kind:string;label:string}) {
  getDb().prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label) VALUES(?,?,?,?)').run(sessionId,clientId,source.kind,source.label);
}
export function bindInputSourceMessage(sessionId:string,clientId:string,messageId:string) {
  getDb().prepare('UPDATE conversation_input_sources SET message_id=? WHERE session_id=? AND client_id=?').run(messageId,sessionId,clientId);
}
/** Managed adapters can expose the identity before their file boundary exists.
 * Keep it on the same journal used by terminal input reconciliation. */
export function rememberConversationInputMessage(sessionId:string,nativeId:string,clientId:string,messageId:string) {
  const afterOffset=Number.MAX_SAFE_INTEGER;
  getDb().prepare(`INSERT INTO conversation_input_links(session_id,native_id,client_id,message_id,input_hash,after_offset)
    VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,native_id,client_id)
    DO UPDATE SET message_id=excluded.message_id,after_offset=excluded.after_offset`
  ).run(sessionId,nativeId,clientId,messageId,'',afterOffset);
}

function decorateInputSources(sessionId:string,messages:ConversationMessage[]):ConversationMessage[] {
  const lookup=getDb().prepare('SELECT kind,label FROM conversation_input_sources WHERE session_id=? AND (client_id=? OR message_id=?) LIMIT 1');
  const bind=getDb().prepare('UPDATE conversation_input_sources SET message_id=? WHERE session_id=? AND client_id=? AND message_id IS NULL');
  return decorateBatches(sessionId,messages.map(message=>{
    const {input_source:_source,...visible}=message;
    if(message.role!=='user')return visible;
    const source=lookup.get(sessionId,message.client_id||'',message.id) as {kind:string;label:string}|undefined;
    // Keep the native record and input fingerprint intact for correlation.
    let suffix=message.client_id?.startsWith('quoted_')?`\n\n[Platform task reference: ${message.client_id}]`:null;
    const run=source?.kind==='scheduled'?/\n\n\[Platform task reference: ([a-zA-Z0-9_-]{12})\]$/.exec(visible.text):null;
    if(run&&getDb().prepare(`SELECT 1 FROM platform_ai_schedule_receipts receipt
      JOIN scheduled_task_runs r ON r.id=receipt.run_id JOIN scheduled_tasks t ON t.id=r.task_id
      WHERE r.id=? AND r.session_id=? AND t.name=?`).get(run[1],sessionId,source!.label))suffix=run[0];
    const projected=suffix&&visible.text.endsWith(suffix)?{...visible,text:visible.text.slice(0,-suffix.length),
      ...(visible.content_blocks?{content_blocks:visible.content_blocks.map(block=>block.type==='text'&&block.text.endsWith(suffix)?{...block,text:block.text.slice(0,-suffix.length)}:block)}:{})}:visible;
    if(source&&message.client_id&&!message.queued)bind.run(message.id,sessionId,message.client_id);
    if(source?.kind==='agent_handoff'){
      const prefix=/^\[Agent Manager handoff · source_tab_id=[\w-]+(?: · message_id=[\w-]+(?: · reply_to=[\w-]+)?)?(?: · child_tab=[^\r\n]+?)?(?: · closeout=[^\r\n]+?)?\]\n/.exec(projected.text)?.[0];
      if(prefix)return {...projected,text:projected.text.slice(prefix.length),input_source:source,
        ...(projected.content_blocks?{content_blocks:projected.content_blocks.map(block=>block.type==='text'&&block.text.startsWith(prefix)?{...block,text:block.text.slice(prefix.length)}:block)}:{})};
    }
    return source?{...projected,input_source:source}:projected;
  }));
}

/** Terminal-backed engines do not echo the browser's client ID. Record only a
 * fingerprint and file boundary before writing, then bind the new native user
 * record once. No extra log scan, prompt copy or model message is needed. */
export async function rememberConversationInput(sessionId:string,binding:PromptContextSession,clientId:string,text:string,previousFormat?:string){
  const nativeId=nativeConversationId(binding);
  if(!nativeId)return false;
  const file=await nativeConversationFile(binding);if(!file)return false;
  const boundary=(await stat(file.path)).size,db=getDb();
  db.prepare(`INSERT INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id,native_id,client_id) DO UPDATE SET input_hash=excluded.input_hash
    WHERE conversation_input_links.message_id IS NULL AND conversation_input_links.input_hash=?`).run(sessionId,nativeId,clientId,inputHash(text),boundary,previousFormat===undefined?'':inputHash(previousFormat));
  db.prepare(`DELETE FROM conversation_input_links WHERE session_id=? AND rowid NOT IN
    (SELECT rowid FROM conversation_input_links WHERE session_id=? ORDER BY rowid DESC LIMIT 256)
    AND NOT EXISTS (SELECT 1 FROM conversation_batches b WHERE b.session_id=conversation_input_links.session_id AND b.client_id=conversation_input_links.client_id)
    AND NOT EXISTS (SELECT 1 FROM conversation_attachments a WHERE a.session_id=conversation_input_links.session_id AND a.client_id=conversation_input_links.client_id)
    AND NOT EXISTS (SELECT 1 FROM conversation_input_sources s WHERE s.session_id=conversation_input_links.session_id AND s.client_id=conversation_input_links.client_id)`).run(sessionId,sessionId);
  return true;
}

/** The native record remains authoritative. Repeated user sends are matched
 * one for one, scoped to the platform session and native conversation. */
export function linkConversationInputs(sessionId:string,nativeId:string|null|undefined,messages:ConversationMessage[]):ConversationMessage[]{
  if(!nativeId||!messages.some(message=>message.role==='user'&&message.sequence!==undefined))return decorateInputSources(sessionId,messages);
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
  return decorateInputSources(sessionId,db.transaction(()=>messages.map(message=>{
    if(message.role!=='user'||message.sequence===undefined)return message;
    // A browser identity from a different submission is authoritative even if
    // two intentionally repeated prompts have identical content.
    const existing=message.client_id?known.get(sessionId,nativeId,message.client_id) as {message_id:string|null;after_offset:number}|undefined:undefined;
    if(existing){
      if(!existing.message_id&&existing.after_offset<=message.sequence)bind.run(message.id,sessionId,nativeId,message.client_id);
      if(existing.message_id!==message.id)return {...message,client_id:message.client_id,native_client_id:message.client_id};
      return message;
    }
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
  }))());
}

/** Forward only records already bound to an actual browser submission. */
export function boundConversationInputs(sessionId:string,nativeId:string,messages:ConversationMessage[]):ConversationMessage[]{
  const linked=linkConversationInputs(sessionId,nativeId,messages);
  const bound=getDb().prepare('SELECT 1 FROM conversation_input_links WHERE session_id=? AND native_id=? AND client_id=? AND message_id=?');
  return linked.filter(message=>message.role==='user'&&message.client_id&&bound.get(sessionId,nativeId,message.client_id,message.id));
}
