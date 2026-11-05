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
