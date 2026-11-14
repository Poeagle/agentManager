import {getDb} from '../../../db/index.js';
import {tokenFields} from '../../conversation-usage.js';

export type UsageAggregate={event_key:string;day:string;cwd:string;model:string|null;tier:string|null;tokens:string};
export const aggregateKey=(row:{day:string;cwd:string;model:string|null;tier:string|null},tokens:Record<string,number|null>)=>JSON.stringify([row.day,row.cwd,row.model,row.tier,tokenFields.map(k=>tokens[k]==null?0:1).join('')]);

/** Retained request projections are still needed for cross-Engine deduplication.
 * Reconstruct removable daily summaries from those identities only on fallback
 * or rebuild; normal report reads use the verified CSV generation. */
export function projectedUsageAggregates(account:string,from:string|null=null,before:string|null=null):UsageAggregate[]{
 const columns=tokenFields.map(k=>`CASE WHEN COUNT(json_extract(tokens,'$.${k}'))=COUNT(*) THEN SUM(json_extract(tokens,'$.${k}')) ELSE NULL END AS ${k}`).join(',');
 const masks=tokenFields.map(k=>`json_extract(tokens,'$.${k}') IS NULL`).join(',');
 const rows=getDb().prepare(`SELECT day,cwd,model,tier,COUNT(*) requests,${columns} FROM codex_usage_dedup_events WHERE account=? AND COALESCE(json_extract(tokens,'$._timezone'),'UTC')=COALESCE((SELECT timezone FROM codex_usage_ledger WHERE account=?),'UTC') AND (? IS NULL OR day>=?) AND (? IS NULL OR day<?) GROUP BY day,cwd,model,tier,${masks}`).all(account,account,from,from,before,before) as Array<{day:string;cwd:string;model:string|null;tier:string|null;requests:number}&Record<(typeof tokenFields)[number],number|null>>;
 return rows.map(row=>{const tokens={...Object.fromEntries(tokenFields.map(k=>[k,row[k]])),requests:row.requests};return {event_key:aggregateKey(row,tokens),day:row.day,cwd:row.cwd,model:row.model,tier:row.tier,tokens:JSON.stringify(tokens)};});
}

export function usageAggregates(account:string,from:string|null=null):UsageAggregate[]{
 const stored=getDb().prepare('SELECT event_key,day,cwd,model,tier,tokens FROM codex_usage_events WHERE account=? AND (? IS NULL OR day>=?)').all(account,from,from) as UsageAggregate[];
 const archived=new Set((getDb().prepare('SELECT event_key FROM codex_usage_archived_aggregates WHERE account=?').all(account) as {event_key:string}[]).map(row=>row.event_key));
 if(!archived.size)return stored;
 const existing=new Set(stored.map(row=>aggregateKey(row,JSON.parse(row.tokens))));
 return [...stored,...projectedUsageAggregates(account,from).filter(row=>archived.has(row.event_key)&&!existing.has(row.event_key))];
}
