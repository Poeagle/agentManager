/** Native summary + a bounded recent item page. Never hydrate an entire turn's
 * tool output merely to display its current activity. */
type Request=(method:string,params:unknown)=>Promise<any>;
const oversized=new Map<string,number>();
const key=(thread:string)=>`${process.env.AGENTMANAGER_CODEX_STREAM_SOCKET}:${thread}`;
export function markOversizedBaseline(thread:string){oversized.set(key(thread),Date.now());while(oversized.size>256)oversized.delete(oversized.keys().next().value!);}
export async function readCodexBaseline(request:Request,threadId:string){
 const metadataOnly=Date.now()-(oversized.get(key(threadId))??0)<5*60*1000;
 const result=await request('thread/turns/list',{threadId,limit:1,itemsView:metadataOnly?'notLoaded':'summary'});
 for(const turn of result.data||[]){
  if(metadataOnly){turn.items=[];continue;}
  if(turn.status==='inProgress'&&turn.itemsView==='summary'){
   try{const page=await request('thread/items/list',{threadId,turnId:turn.id,limit:8,sortDirection:'desc'});
    if(Array.isArray(page.data)&&page.data.length)turn.items=page.data.map((entry:any)=>entry.item??entry).reverse();
   }catch{/* Older native services retain the bounded summary and live events. */}
  }
 }
 return result;
}
