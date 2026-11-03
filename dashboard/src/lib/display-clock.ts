import {useSyncExternalStore} from 'react';

export const browserTimeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
interface Sample {server:number;browser:number;monotonic:number;roundTrip:number}
let sample:Sample|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const offset=()=>sample?sample.browser-sample.server:0;
export function useDisplayClock(){useSyncExternalStore(subscribe,offset,offset);return browserTimeZone;}
/** Reuse a normal settings response to measure clock skew. No polling or
 * external time service is needed. Half the round trip estimates return latency. */
export function calibrateBrowserClock(serverTime:number,browserTime:number,roundTrip:number){
  if(!Number.isFinite(serverTime)||!Number.isFinite(browserTime)||!Number.isFinite(roundTrip)||roundTrip<0||roundTrip>10000)return;
  const monotonic=performance.now();
  if(sample&&monotonic-sample.monotonic<60000&&roundTrip>sample.roundTrip)return;
  sample={server:serverTime+roundTrip/2,browser:browserTime,monotonic,roundTrip};
  for(const listener of listeners)listener();
}
/** Native timestamps stay in their original clock domain for ordering and
 * differences; ongoing durations advance with a monotonic clock. */
export function estimatedServerNow(){return sample?sample.server+performance.now()-sample.monotonic:Date.now();}
export function resetBrowserClock(){sample=null;for(const listener of listeners)listener();}
export function browserTimestamp(value:string|number|Date|null|undefined):number {
  const time=value==null?NaN:value instanceof Date?value.getTime():typeof value==='number'?value:Date.parse(value);
  return time+offset();
}
const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:browserTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function formatDisplayTimestamp(value:string|number|Date|null|undefined):string {
  const time=browserTimestamp(value);
  return Number.isFinite(time)&&Math.abs(time)<=8.64e15?formatter.format(time):'时间未知';
}
