import {getDb} from '../../../db/index.js';
import {tokenFields} from '../../conversation-usage.js';
import {readUsageCsv} from './usage-csv.js';
import {aggregateKey,projectedUsageAggregates,type UsageAggregate} from './usage-aggregates.js';

/** Remove only closed daily summaries that have two independently verified
 * representations: the published CSV and the retained request projection.
 * Keep today/yesterday writable for normal collection and midnight recovery. */
export function pruneUsageCsvDuplicates(account:string):number{
 const db=getDb();let snapshot:ReturnType<typeof readUsageCsv>;
 try{snapshot=readUsageCsv(account);}catch{return 0;}
 if(!snapshot)return 0;
 const status=db.prepare('SELECT checked_at FROM codex_usage_status WHERE account=?').get(account) as {checked_at:string|null}|undefined;
 const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(account) as {identity:string}|undefined;
 const ledger=db.prepare('SELECT timezone FROM codex_usage_ledger WHERE account=?').get(account) as {timezone:string}|undefined;
 if(!status?.checked_at||snapshot.checkpoint!==status.checked_at||(snapshot.source??null)!==(source?.identity??null)||ledger?.timezone!==snapshot.timezone)return 0;
 const cutoff=new Date(Date.parse(snapshot.day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const stored=db.prepare('SELECT event_key,day,cwd,model,tier,tokens FROM codex_usage_events WHERE account=? AND day<?').all(account,cutoff) as UsageAggregate[];
 if(!stored.length)return 0;
 const keys=new Set<string>();for(const row of stored){const tokens=JSON.parse(row.tokens);if(row.event_key===aggregateKey(row,tokens))keys.add(row.event_key);}
 if(!keys.size)return 0;
 const csv=new Map<string,Record<string,number|null>>();
 for(const [day,,cwd,model,tier,raw,requests] of [...snapshot.history,...snapshot.current]){
  if(typeof day!=='string'||day>=cutoff)continue;
  const tokens=raw as Record<string,number|null>,key=aggregateKey({day,cwd:cwd as string,model:model as string|null,tier:tier as string|null},tokens);
  if(!keys.has(key))continue;
  let sum=csv.get(key);if(!sum){sum={...Object.fromEntries(tokenFields.map(k=>[k,tokens[k]??null])),requests:requests as number};csv.set(key,sum);}else{sum.requests!+=requests as number;for(const k of tokenFields)sum[k]=sum[k]==null||tokens[k]==null?null:sum[k]!+tokens[k]!;}
 }
 const projected=new Map(projectedUsageAggregates(account,null,cutoff).map(row=>[row.event_key,JSON.parse(row.tokens) as Record<string,number|null>]));
 const fields=[...tokenFields,'requests'];
 const matches=(a:Record<string,number|null>,b:Record<string,number|null>|undefined)=>!!b&&fields.every(k=>(a[k]??null)===(b[k]??null));
 const removable=stored.filter(row=>{const tokens=JSON.parse(row.tokens);return keys.has(row.event_key)&&matches(tokens,csv.get(row.event_key))&&matches(tokens,projected.get(row.event_key));});
 return db.transaction(()=>{
  const current=db.prepare('SELECT checked_at FROM codex_usage_status WHERE account=?').get(account) as {checked_at:string|null}|undefined;
  const currentSource=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(account) as {identity:string}|undefined;
  if(current?.checked_at!==snapshot.checkpoint||(currentSource?.identity??null)!==(snapshot.source??null))return 0;
  let removed=0;const remember=db.prepare('INSERT OR IGNORE INTO codex_usage_archived_aggregates VALUES(?,?)');const remove=db.prepare('DELETE FROM codex_usage_events WHERE account=? AND event_key=? AND tokens=?');for(const row of removable){const count=remove.run(account,row.event_key,row.tokens).changes;if(count){remember.run(account,row.event_key);removed+=count;}}return removed;})();
}
