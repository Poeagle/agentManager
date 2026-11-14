import {estimateUsageCredits} from './usage-credits.js';
import type {QuotaEvent,QuotaSample} from './quota-allocation.js';

/** Observed changes per local hour. Splitting across an hour is an estimate;
 * within one hour no token data is needed to observe the account change. */
export function quotaHours(samples:QuotaSample[],events:QuotaEvent[],checkedAt:string|null,timezone:string){
 const result=new Map<string,number>();let startRange:string|null=null,endRange:string|null=null,gaps=0;
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
 const hourAt=(ms:number)=>{const parts=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value]));const offset=parts.timeZoneName==='GMT'?'+00:00':parts.timeZoneName.replace('GMT','');return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00${offset}`;};
 const ordered=events.filter(e=>Number.isFinite(Date.parse(e.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));let cursor=0;
 for(let i=1;i<samples.length;i++){
  const before=samples[i-1],after=samples[i],start=Date.parse(before.checked_at),end=Date.parse(after.checked_at);
  while(cursor<ordered.length&&Date.parse(ordered[cursor].at)<=start)cursor++;
  let next=cursor;while(next<ordered.length&&Date.parse(ordered[next].at)<=end)next++;const batch=ordered.slice(cursor,next);cursor=next;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>900000||!checkedAt||Date.parse(checkedAt)<end||before.email!==after.email||after.used<before.used){gaps++;continue;}
  const first=hourAt(start+1),last=hourAt(end),change=after.used-before.used;
  if(first===last){result.set(first,(result.get(first)??0)+change);}
  else{
   const weights=new Map<string,number>();let unknown=false;
   for(const event of batch){let value:number|null=null;try{value=estimateUsageCredits(event.model,event.tier,JSON.parse(event.tokens),'subscription');}catch{}if(value===null){unknown=true;break;}const hour=hourAt(Date.parse(event.at));weights.set(hour,(weights.get(hour)??0)+value);}
   const total=[...weights.values()].reduce((a,b)=>a+b,0);if(unknown||total<=0){gaps++;continue;}
   for(const [hour,weight] of weights)result.set(hour,(result.get(hour)??0)+change*weight/total);
  }
  startRange??=before.checked_at;endRange=after.checked_at;
 }
 return {hours:[...result].map(([hour,quota])=>({hour,quota})),range:{start:startRange,end:endRange},gaps};
}
