import {estimateUsageCredits} from './usage-credits.js';

export type QuotaSample={checked_at:string;reset_at:number;used:number;email:string};
export type QuotaEvent={at:string;day:string;hour:string|null;cwd:string;model:string|null;tier:string|null;tokens:string};
/** Allocate observed weekly percentage-point changes only within short, intact
 * sampling intervals. An unknown credit rate makes that interval unallocatable. */
export function allocateQuota(samples:QuotaSample[],events:QuotaEvent[],checkedAt:string|null){
 const result=new Map<string,number>();
 const ordered=[...events].filter(e=>Number.isFinite(Date.parse(e.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 let cursor=0;
 for(let i=1;i<samples.length;i++){
  const before=samples[i-1],after=samples[i],start=Date.parse(before.checked_at),end=Date.parse(after.checked_at);
  while(cursor<ordered.length&&Date.parse(ordered[cursor].at)<=start)cursor++;
  let next=cursor;while(next<ordered.length&&Date.parse(ordered[next].at)<=end)next++;
  const batch=ordered.slice(cursor,next);cursor=next;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>900000||!checkedAt||Date.parse(checkedAt)<end||before.email!==after.email||before.reset_at!==after.reset_at||end>=after.reset_at*1000||after.used<before.used)continue;
  const amounts=batch.map(e=>{try{return estimateUsageCredits(e.model,e.tier,JSON.parse(e.tokens));}catch{return null;}});
  if(!batch.length||amounts.some(v=>v===null))continue;
  const total=amounts.reduce<number>((n,v)=>n+v!,0);if(total<=0)continue;
  for(let j=0;j<batch.length;j++){
   const e=batch[j],key=JSON.stringify([e.day,e.hour,e.cwd,e.model]);
   result.set(key,(result.get(key)??0)+(after.used-before.used)*amounts[j]!/total);
  }
 }
 return result;
}
