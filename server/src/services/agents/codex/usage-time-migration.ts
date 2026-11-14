import {getDb} from '../../../db/index.js';
import {tokenFields} from '../../conversation-usage.js';
import {estimateUsageCredits} from './usage-credits.js';
import {usageTimezone} from './usage-time.js';

type Counters=Record<string,number|null>;
export interface MatchedUsage {day:string;cwd:string;model:string|null;tier:string|null;legacy:boolean;requests:number;tokens:Counters}
export const usageAggregateKey=(row:Omit<MatchedUsage,'legacy'>,legacy=false)=>JSON.stringify([row.day,row.cwd,row.model,row.tier,...legacy?[]:[tokenFields.map(k=>row.tokens[k]===null?0:1).join('')]]);
export function initUsageTimeStorage(){
 const db=getDb();
 for(const table of ['codex_usage_ledger','codex_usage_event_ids']){
  const columns=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
  if(!columns.some(c=>c.name==='timezone'))db.exec(`ALTER TABLE ${table} ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
 }
 db.exec('CREATE TABLE IF NOT EXISTS codex_usage_unassigned(account TEXT NOT NULL,event_key TEXT NOT NULL,timezone TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key))');
}
export function usageStoredTimezone(account:string){
 const db=getDb(),row=db.prepare('SELECT timezone FROM codex_usage_ledger WHERE account=?').get(account) as {timezone:string}|undefined;
 return row?.timezone??(db.prepare('SELECT 1 FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(account)?'UTC':usageTimezone());
}
/** Called inside the publication transaction. Only recovered, previously
 * recorded requests are removed from the old buckets. Missing history stays
 * explicit instead of being guessed into one of two possible local dates. */
export function retainUnassignedUsage(account:string,timezone:string,matches:MatchedUsage[]){
 const db=getDb(),byKey=new Map(matches.map(row=>[usageAggregateKey(row,row.legacy),row]));
 const rows=db.prepare('SELECT event_key,day,cwd,model,tier,tokens FROM codex_usage_events WHERE account=?').all(account) as {event_key:string;day:string;cwd:string;model:string|null;tier:string|null;tokens:string}[];
 const insert=db.prepare('INSERT OR IGNORE INTO codex_usage_unassigned VALUES(?,?,?,?,?,?,?,?)');
 for(const row of rows){
  const old=JSON.parse(row.tokens) as Counters&{requests:number},matched=byKey.get(row.event_key);
  const inconsistent=!!matched&&(matched.requests>old.requests||tokenFields.some(k=>old[k]!=null&&matched.tokens[k]!=null&&matched.tokens[k]!>old[k]!));
  const requests=matched&&!inconsistent?old.requests-matched.requests:old.requests;
  const tokens=!matched||inconsistent?old:Object.fromEntries(tokenFields.map(k=>[k,old[k]==null||matched.tokens[k]==null?null:old[k]!-matched.tokens[k]!]));
  if(requests>0||(tokens.total_tokens??0)>0)insert.run(account,JSON.stringify([timezone,row.event_key]),timezone,row.day,row.cwd,row.model,row.tier,JSON.stringify({...tokens,requests}));
 }
}
export function unassignedUsage(account:string,basis:import('./usage-credits.js').UsageEstimateBasis='credits'){
 const rows=getDb().prepare('SELECT model,tier,tokens FROM codex_usage_unassigned WHERE account=?').all(account) as {model:string|null;tier:string|null;tokens:string}[];
 if(!rows.length)return null;
 const tokens:Counters=Object.fromEntries(tokenFields.map(k=>[k,0]));let requests=0,credits:number|null=null;
 for(const row of rows){const value=JSON.parse(row.tokens);requests+=value.requests;for(const k of tokenFields)tokens[k]=tokens[k]===null||value[k]===null?null:tokens[k]!+value[k];const amount=estimateUsageCredits(row.model,row.tier,value,basis);if(amount!==null)credits=(credits??0)+amount;}
 return {tokens,requests,estimated_credits:credits};
}
