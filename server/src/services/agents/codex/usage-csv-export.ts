import {usageAggregates} from './usage-aggregates.js';
import {pruneUsageCsvDuplicates} from './usage-csv-prune.js';
import {getDb} from '../../../db/index.js';
import {quotaHours} from './quota-periods.js';
import {readUsageCsv,publishUsageCsv} from './usage-csv.js';
import {usageDay,usageTimezone} from './usage-time.js';
import {tokenFields} from '../../conversation-usage.js';

/** SQLite remains the acquisition/deduplication index during migration. Publish
 * only a complete account snapshot, and never remove its historical source. */
export function exportUsageCsv(account:string,options:{rebuild?:boolean}={}){
 const db=getDb(),timezone=usageTimezone(),today=usageDay(),groups=new Map<string,any[]>();
 let prior:ReturnType<typeof readUsageCsv>=null;try{prior=readUsageCsv(account);}catch{try{prior=readUsageCsv(account,true);}catch{}}
 const source=(db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(account) as {identity:string}|undefined)?.identity??null;
 const from=prior&&(prior.source??null)===source&&prior.timezone===timezone&&prior.day<=today&&!options.rebuild?prior.day:null;
 // Revisit the previous local day for intervals that close after midnight.
 // One more day supplies context on both sides of its opening boundary.
 const quotaFrom=from?new Date(Date.parse(from+'T00:00:00Z')-86400000).toISOString().slice(0,10):null;
 const detailFrom=quotaFrom?new Date(Date.parse(quotaFrom+'T00:00:00Z')-86400000).toISOString().slice(0,10):null;
 const rows=db.prepare('SELECT day,hour,at,cwd,model,tier,provider,tokens FROM codex_usage_dedup_events WHERE account=? AND (? IS NULL OR day>=?)').all(account,detailFrom,detailFrom) as Array<{day:string;hour:string|null;at:string|null;cwd:string;model:string|null;tier:string|null;provider?:string|null;tokens:string}>;
 for(const row of rows){const tokens=JSON.parse(row.tokens);if(from&&row.day<from||tokens._timezone&&tokens._timezone!==timezone)continue;const session=tokens._session??null,bucket=row.day===today?row.at:row.hour,key=JSON.stringify([row.day,bucket,row.cwd,row.model,row.tier,session,row.provider??null,tokenFields.map(k=>tokens[k]==null?0:1)]);let entry=groups.get(key);
  if(!entry){entry=[row.day,bucket,row.cwd,row.model,row.tier,Object.fromEntries(tokenFields.map(k=>[k,tokens[k]??null])),1,session,row.provider??null];groups.set(key,entry);}
  else{entry[6]++;for(const field of tokenFields)entry[5][field]=entry[5][field]==null||tokens[field]==null?null:entry[5][field]+tokens[field];}
 }
 const current:unknown[][]=[],history:unknown[][]=from?(prior?.history??[]).filter(r=>typeof r[0]==='string'&&r[0]<from):[];
 for(const entry of groups.values())(entry[0]===today?current:history).push(entry);
 // Preserve legacy daily totals when detailed projections cannot represent them.
 const aggregates=usageAggregates(account,from);
 const detailed=new Map<string,Record<string,number|null>>();
 for(const entry of groups.values()){const key=JSON.stringify([entry[0],entry[2],entry[3],entry[4]]),old=detailed.get(key);if(!old)detailed.set(key,{...entry[5],requests:entry[6]});else{old.requests=(old.requests??0)+entry[6];for(const k of tokenFields)old[k]=old[k]==null||entry[5][k]==null?null:old[k]!+entry[5][k];}}
 const fallback=new Set<string>(),aggregateTotals=new Map<string,Record<string,number|null>>();
 for(const row of aggregates){const key=JSON.stringify([row.day,row.cwd,row.model,row.tier]),tokens=JSON.parse(row.tokens),old=aggregateTotals.get(key);if(!old)aggregateTotals.set(key,{...tokens,requests:tokens.requests??1});else{old.requests=(old.requests??0)+(tokens.requests??1);for(const k of tokenFields)old[k]=old[k]==null||tokens[k]==null?null:old[k]!+tokens[k];}}
 for(const [key,value] of aggregateTotals){const detail=detailed.get(key);if(!detail||[...tokenFields,'requests'].some(k=>detail[k]!==value[k]))fallback.add(key);}

 for(const entries of [current,history])for(let i=entries.length-1;i>=0;i--)if(fallback.has(JSON.stringify([entries[i][0],entries[i][2],entries[i][3],entries[i][4]])))entries.splice(i,1);
 for(const row of aggregates)if(fallback.has(JSON.stringify([row.day,row.cwd,row.model,row.tier]))){const tokens=JSON.parse(row.tokens);(row.day===today?current:history).push([row.day,null,row.cwd,row.model,row.tier,Object.fromEntries(tokenFields.map(k=>[k,tokens[k]??null])),tokens.requests??1,null,null]);}

 const quota=(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_quota_samples'").get()?db.prepare('SELECT checked_at,used,reset_at,email FROM codex_quota_samples WHERE account=? AND (identity=(SELECT identity FROM codex_account_status WHERE account=?) OR NOT EXISTS(SELECT 1 FROM codex_account_status WHERE account=?)) ORDER BY checked_at').all(account,account,account):[]) as Array<{checked_at:string;used:number;reset_at:number;email:string}>;
 const boundary=db.prepare('SELECT started_at FROM codex_usage_scan_boundary WHERE account=?').get(account) as {started_at:string}|undefined;
 const first=quotaFrom?quota.findIndex(q=>usageDay(Date.parse(q.checked_at),timezone)>=quotaFrom):-1,selected=quotaFrom?(first<0?quota.slice(-1):quota.slice(Math.max(0,first-1))):quota;
 const observed=quotaHours(selected,rows.filter(r=>r.at).map(r=>({...r,at:r.at!})),boundary?.started_at??null,timezone);
 const hours=new Map<string,number>();
 const firstSample=quota[0]?Date.parse(quota[0].checked_at):Infinity;
 if(prior?.timezone===timezone&&(prior.source??null)===source)for(const [hour,value] of prior.observed??[])if(typeof hour==='string'&&typeof value==='number'&&(quotaFrom?hour.slice(0,10)<quotaFrom:Date.parse(hour)<firstSample))hours.set(hour,value);
 for(const row of observed.hours)if((!quotaFrom||row.hour.slice(0,10)>=quotaFrom)&&!hours.has(row.hour))hours.set(row.hour,row.quota);
 const checkpoint=(db.prepare('SELECT checked_at FROM codex_usage_status WHERE account=?').get(account) as {checked_at:string|null}|undefined)?.checked_at??null;
 publishUsageCsv(account,{day:today,timezone,checkpoint,source,current,history,quota:quota.filter(r=>usageDay(Date.parse(r.checked_at),timezone)===today).map(r=>[r.checked_at,r.used,r.reset_at,r.email]),observed:[...hours]});
 pruneUsageCsvDuplicates(account);
}
