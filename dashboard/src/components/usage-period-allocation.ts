import type {Dimension,UsageRow} from './codex-usage-groups';
export function usagePeriod(date:string,hour:string|null|undefined,dimension:Dimension){
 if(dimension==='hour')return hour&&Number.isFinite(Date.parse(hour))?new Date(hour).toISOString():`${date} unknown`;
 if(dimension==='day')return date;
 if(dimension==='month')return date.slice(0,7);
 if(dimension==='week'){const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()-(value.getUTCDay()+6)%7);return value.toISOString().slice(0,10);}
 return 'all';
}
/** Compute once for the selected period, before search or column filtering.
 * Largest-remainder rounding conserves the displayed four-decimal account total. */
export function allocateUsagePeriods(rows:UsageRow[],hours:Array<{hour:string;quota:number}>,dimension:Dimension):UsageRow[]{
 const totals=new Map<string,number>(),buckets=new Map<string,Array<{row:number;model:number;credit:number;key:string;units:number;remainder:number}>>();
 for(const sample of hours){const key=usagePeriod(sample.hour.slice(0,10),sample.hour,dimension);totals.set(key,(totals.get(key)??0)+sample.quota);}
 const result=rows.map(row=>({...row,actual_quota:null as number|null,models:row.models?.map(model=>({...model,actual_quota:null as number|null}))}));
 rows.forEach((row,r)=>{const key=usagePeriod(row.date,row.hour,dimension),entries=buckets.get(key)??[];
 (row.models?.length?row.models:[row]).forEach((model,m)=>{if(model.estimated_credits!=null&&Number.isFinite(model.estimated_credits)&&model.estimated_credits>=0)entries.push({row:r,model:row.models?.length?m:-1,credit:model.estimated_credits,key:JSON.stringify([row.date,row.hour,row.cwd,'model' in model?model.model:null]),units:0,remainder:0});});buckets.set(key,entries);});
 for(const [key,entries] of buckets){const observed=totals.get(key),weight=entries.reduce((n,e)=>n+e.credit,0);if(observed===undefined||weight<=0)continue;
  const units=Math.round(observed*10000);let assigned=0;
  for(const entry of entries){const exact=units*entry.credit/weight;entry.units=Math.floor(exact);entry.remainder=exact-entry.units;assigned+=entry.units;}
  const ranked=[...entries].sort((a,b)=>b.remainder-a.remainder||a.key.localeCompare(b.key));for(let i=0;i<units-assigned;i++)ranked[i%ranked.length].units++;
  for(const entry of entries){const row=result[entry.row],value=entry.units/10000;if(entry.model<0)row.actual_quota=value;else{row.models![entry.model].actual_quota=value;row.actual_quota=(row.actual_quota??0)+value;}}
 }
 return result;
}
