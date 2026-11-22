import type {FileHandle} from 'node:fs/promises';

export function recordedPricingSettings(record:any):Record<string,unknown>|null {
 const payload=record?.payload;
 const settings=record?.type==='session_meta'||record?.type==='turn_context'?payload
  :record?.type==='event_msg'&&payload?.type==='thread_settings_applied'?payload.thread_settings:null;
 return settings&&typeof settings==='object'&&!Array.isArray(settings)?settings:null;
}

/** Seed a cold tail from preceding receipts, never from the current UI setting
 * or a later record. Read backwards in bounded chunks and stop per field at its
 * nearest receipt. No transcript counters or messages are replayed here. */
export async function precedingPricingSettings(handle:FileHandle,end:number) {
 const result:{model:string|null;tier:string|null;provider:string|null}={model:null,tier:null,provider:null};
 const found=new Set<string>(),floor=Math.max(0,end-16*1024*1024),chunk=256*1024;
 let cursor=end,carry=Buffer.alloc(0),skipTail=true;
 const consume=(line:Buffer)=>{
  if(line.length>chunk||!/^\s*\{/.test(line.subarray(0,8).toString())||!/"type"\s*:\s*"(?:session_meta|turn_context|thread_settings_applied)"/.test(line.subarray(0,600).toString()))return;
  let record:any;try{record=JSON.parse(line.toString());}catch{return;}
  const settings=recordedPricingSettings(record);if(!settings)return;
  for(const [field,target] of [['model','model'],['service_tier','tier'],['model_provider','provider']] as const){
   if(found.has(field)||!Object.hasOwn(settings,field))continue;
   found.add(field);result[target]=typeof settings[field]==='string'?(settings[field] as string).slice(0,120):null;
  }
 };
 while(cursor>floor&&found.size<3){
  const start=Math.max(floor,cursor-chunk),buffer=Buffer.alloc(cursor-start);
  const {bytesRead}=await handle.read(buffer,0,buffer.length,start);if(bytesRead!==buffer.length)break;
  cursor=start;let data=Buffer.concat([buffer,carry]);
  // The statistics window may begin inside a JSONL record. Exclude that
  // incomplete suffix so a receipt after the boundary cannot leak backwards.
  if(skipTail){const last=data.lastIndexOf(10);if(last<0)continue;data=data.subarray(0,last);skipTail=false;}
  let lineEnd=data.length;
  for(let previous=data.lastIndexOf(10,lineEnd-1);previous>=0;previous=data.lastIndexOf(10,lineEnd-1)){
   consume(data.subarray(previous+1,lineEnd));lineEnd=previous;if(found.size===3)break;
   if(lineEnd===0)break;
  }
  carry=lineEnd<=chunk?Buffer.from(data.subarray(0,lineEnd)):Buffer.alloc(0);
  if(cursor===0&&found.size<3)consume(carry);
 }
 return result;
}
