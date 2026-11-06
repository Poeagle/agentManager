import {getDb} from '../../../db/index.js';
import {currentCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
type Request=(method:string,params:unknown)=>Promise<any>;
const PAGE_SIZE=4,MAX_ITEMS=100,MAX_PAGES=MAX_ITEMS/PAGE_SIZE;
/** Keep the existing 100-entry view, but bound each native response. The
 * common stream hub owns sharing/recovery; pagination is provider protocol. */
export async function readCodexQueue(request:Request,threadId:string){
 const data:any[]=[],seen=new Set<string>();let cursor:string|undefined;
 for(let index=0;index<MAX_PAGES;index++){
  const page=await request('thread/queue/list',{threadId,limit:Math.min(PAGE_SIZE,MAX_ITEMS-data.length),...cursor?{cursor}:{}});
  if(Array.isArray(page.data))data.push(...page.data.slice(0,MAX_ITEMS-data.length));
  cursor=typeof page.nextCursor==='string'&&page.nextCursor?page.nextCursor:undefined;
  if(cursor&&seen.has(cursor))throw Error('原生队列分页未前进');if(cursor)seen.add(cursor);
  if(!cursor||data.length>=MAX_ITEMS)return {data,nextCursor:cursor};
 }
 throw Error('原生队列分页未完成');
}

/** Delete only a still-pending native submission. A consumed message cannot be
 * cancelled by deleting its visual echo. Never interrupts or submits a turn. */
export async function cancelCodexQueuedInput(threadId:string,clientId:string):Promise<void> {
 await withCodexConnection(async request=>{
  const page=await readCodexQueue(request,threadId);
  const matches=page.data.filter(item=>item.clientUserMessageId===clientId);
  if(matches.length!==1||typeof matches[0].id!=='string')throw Error('这条消息已开始执行或已取消，请刷新队列');
  const result=await request('thread/queue/delete',{threadId,queuedSubmissionId:matches[0].id});
  if(result.deleted!==true)throw Error('这条消息已开始执行或已取消，请刷新队列');
  ownCodexQueuedInput(threadId,clientId,true);
 });
}

const owned=new Map<string,Set<string>>(),draining=new Map<string,Promise<string|null>>();
const ownershipKey=(thread:string)=>JSON.stringify([currentCodexEngine().socket,thread]);
/** Store only native identities, never prompts. Native queue remains the source
 * of truth and atomically claims an item when starting it. */
export function ownCodexQueuedInput(thread:string,client:string,remove=false){
 const key=ownershipKey(thread),set=owned.get(key)||new Set<string>();remove?set.delete(client):set.add(client);
 owned.delete(key);if(set.size)owned.set(key,set);while(owned.size>512)owned.delete(owned.keys().next().value!);
 try{const db=getDb();if(remove)db.prepare('DELETE FROM agent_queued_inputs WHERE agent_id=? AND scope_key=? AND native_id=? AND client_id=?').run('codex',currentCodexEngine().socket,thread,client);
 else db.prepare('INSERT OR IGNORE INTO agent_queued_inputs(agent_id,scope_key,native_id,client_id) VALUES(?,?,?,?)').run('codex',currentCodexEngine().socket,thread,client);}catch{/* File-only adapter callers have no platform database. */}
}
export function startOwnedCodexQueue(request:Request,thread:string):Promise<string|null>{
 const key=ownershipKey(thread),prior=draining.get(key);if(prior)return prior;
 const work=(async()=>{
  const clients=new Set(owned.get(key));
  try{for(const row of getDb().prepare('SELECT client_id FROM agent_queued_inputs WHERE agent_id=? AND scope_key=? AND native_id=?').all('codex',currentCodexEngine().socket,thread) as {client_id:string}[])clients.add(row.client_id);}catch{}
  if(!clients.size)return null;
  const page=await readCodexQueue(request,thread),nativeClients=new Set(page.data.map(item=>item.clientUserMessageId));
  for(const client of clients)if(!page.nextCursor&&!nativeClients.has(client))ownCodexQueuedInput(thread,client,true);
  const next=page.data[0];if(!next||!clients.has(next.clientUserMessageId))return null;
  const current=await request('thread/read',{threadId:thread});if(current.thread?.status?.type!=='idle')return null;
  // Never replay text with turn/start. Native queue/start atomically consumes
  // this exact entry, including when a TUI client races the same operation.
  const receipt=await request('thread/queue/start',{threadId:thread,queuedSubmissionId:next.id});
  if(typeof receipt.turn?.id!=='string')throw Error('排队消息的启动结果尚未确认');
  ownCodexQueuedInput(thread,next.clientUserMessageId,true);return next.clientUserMessageId as string;
 })().finally(()=>draining.delete(key));draining.set(key,work);return work;
}
