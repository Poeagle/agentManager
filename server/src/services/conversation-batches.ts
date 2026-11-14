import {getDb} from '../db/index.js';
import type {ConversationAttachment} from './conversation-attachments.js';
import type {AgentMessage} from './agents/types.js';
export interface BatchSegment {length:number;attachments:number}
export interface BatchPart {text:string;attachments:ConversationAttachment[]}
/** Boundaries describe the exact input, never an independently supplied prompt. */
export function validateBatch(value:unknown,text:string,attachments:ConversationAttachment[]):BatchPart[]|undefined {
 if(value===undefined)return;
 if(!Array.isArray(value)||!value.length||value.length>100)throw Error('Invalid batch segments');
 let cursor=0,file=0;
 const parts=value.map((segment,index)=>{
  if(!segment||!Number.isSafeInteger(segment.length)||segment.length<0||!Number.isSafeInteger(segment.attachments)||segment.attachments<0)throw Error('Invalid batch segments');
  if(index){if(text.slice(cursor,cursor+2)!=='\n\n')throw Error('Batch boundaries do not match input');cursor+=2;}
  const start=cursor;cursor+=segment.length;
  const files=attachments.slice(file,file+segment.attachments);file+=segment.attachments;
  if(cursor>text.length||file>attachments.length||(!segment.length&&!files.length))throw Error('Invalid batch segments');
  return {text:text.slice(start,cursor),attachments:files.map(a=>{const offset=a.offset===undefined?segment.length:a.offset-start;if(offset<0||offset>segment.length)throw Error('Invalid batch attachment offset');return {...a,offset};})};
 });
 if(cursor!==text.length||file!==attachments.length)throw Error('Batch boundaries do not match input');
 return parts;
}
export function rememberBatch(sessionId:string,clientId:string,parts:BatchPart[]){
 const data=JSON.stringify(parts),db=getDb();
 const prior=db.prepare('SELECT parts FROM conversation_batches WHERE session_id=? AND client_id=?').get(sessionId,clientId) as {parts:string}|undefined;
 if(prior&&prior.parts!==data)throw Object.assign(Error('Batch identity already used'),{submission:'rejected'});
 db.prepare('INSERT OR IGNORE INTO conversation_batches(session_id,client_id,parts) VALUES(?,?,?)').run(sessionId,clientId,data);
}
export function decorateBatches(sessionId:string,messages:AgentMessage[]):AgentMessage[]{
 const lookup=getDb().prepare('SELECT parts FROM conversation_batches WHERE session_id=? AND (client_id=? OR message_id=?) LIMIT 1');
 const bind=getDb().prepare('UPDATE conversation_batches SET message_id=? WHERE session_id=? AND client_id=? AND message_id IS NULL');
 return messages.map(message=>{
  const {batch:_batch,...visible}=message;
  if(message.role!=='user')return visible;
  const row=lookup.get(sessionId,message.client_id||'',message.id) as {parts:string}|undefined;if(!row)return visible;
  if(message.client_id&&!message.queued)bind.run(message.id,sessionId,message.client_id);
  try{return {...visible,batch:JSON.parse(row.parts)};}catch{return visible;}
 });
}
