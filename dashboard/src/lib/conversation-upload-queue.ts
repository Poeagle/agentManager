const queues=new Map<string,Promise<void>>();
/** All composers belonging to one session share a queue. Multiple question
 * fields must not each read/zip a large directory into memory concurrently. */
export function scheduleConversationUpload(sessionId:string,work:()=>Promise<void>):Promise<void>{
 const task=(queues.get(sessionId)||Promise.resolve()).then(work);
 const tail=task.then(()=>{},()=>{});queues.set(sessionId,tail);
 void tail.then(()=>{if(queues.get(sessionId)===tail)queues.delete(sessionId);});
 return task;
}
