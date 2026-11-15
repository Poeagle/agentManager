import type {Dimension} from './codex-usage-groups';

export type UsageDateRange={from:string;to:string};
const dateLabel=(date:Date)=>date.toISOString().slice(0,10);
function calendarBoundary(value:string,dimension:Dimension,end:boolean){
 if(!value||!['week','month'].includes(dimension))return value;
 const date=new Date(`${value}T00:00:00Z`);
 if(!Number.isFinite(date.getTime())||dateLabel(date)!==value)return value;
 if(dimension==='week')date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7+(end?6:0));
 else if(end)date.setUTCMonth(date.getUTCMonth()+1,0);
 else date.setUTCDate(1);
 return dateLabel(date);
}
/** Calendar arithmetic on already-local date labels, independent of browser TZ
 * and DST. Inverted selections stay empty instead of expanding into a period. */
export function usageDateRange(from:string,to:string,dimension:Dimension,availableDates:string[]=[]):UsageDateRange{
 if(from&&to&&from>to)return {from,to};
 let earliest='',latest='';
 for(const date of availableDates){if(!earliest||date<earliest)earliest=date;if(!latest||date>latest)latest=date;}
 return {from:calendarBoundary(from||earliest,dimension,false),to:calendarBoundary(to||latest,dimension,true)};
}
export function usageRangeLabel(range:UsageDateRange){return range.from===range.to?range.from:`${range.from||'起始'} ~ ${range.to||'至今'}`;}
