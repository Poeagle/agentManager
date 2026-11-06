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
 });
}
