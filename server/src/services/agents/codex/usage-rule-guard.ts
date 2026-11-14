import type Database from 'better-sqlite3';
import {tokenFields} from '../../conversation-usage.js';

type Event={key:string;day:string;cwd:string;model:string|null;tokens:Record<string,number|null>};
/** A parser upgrade can replace old aggregates only when the retained request
 * projection proves that every old identity and counter is still present. */
export function assertUsageRebuildPreserves(db:Database.Database,account:string,events:Event[],limit:number):void {
 const unassigned=db.prepare('SELECT 1 FROM codex_usage_unassigned WHERE account=? LIMIT 1').get(account);
 if(unassigned)throw Error('历史记录存在未归属数据');
 const original=db.prepare('SELECT COUNT(*) n FROM codex_usage_event_ids WHERE account=?').get(account) as {n:number};
 const projected=db.prepare('SELECT COUNT(*) n FROM codex_usage_dedup_events WHERE account=?').get(account) as {n:number};
 if(original.n!==projected.n||original.n>limit)throw Error('历史请求身份不完整');
 const fresh=new Map(events.map(event=>[event.key,event]));
 if(fresh.size!==events.length)throw Error('重读请求身份重复');
 const oldIds=new Set<string>();
 const groups=new Map<string,{requests:number;tokens:Record<string,number|null>}>();
 const keyFor=(day:string,cwd:string,model:string|null,tokens:Record<string,number|null>)=>JSON.stringify([day,cwd,model,tokenFields.map(k=>tokens[k]===null?0:1).join('')]);
 for(const row of db.prepare('SELECT event_key,day,cwd,model,tokens FROM codex_usage_dedup_events WHERE account=?').iterate(account) as Iterable<{event_key:string;day:string;cwd:string;model:string|null;tokens:string}>){
  oldIds.add(row.event_key);
  const prior=JSON.parse(row.tokens) as Record<string,number|null>,next=fresh.get(row.event_key);
  if(!next)throw Error('部分历史请求无法从原始文件中找到');
  if(next.day!==row.day||next.cwd!==row.cwd||next.model!==row.model||tokenFields.some(k=>next.tokens[k]!==prior[k]))throw Error('历史请求的归属或 Token 与缓存不一致');
  const key=keyFor(row.day,row.cwd,row.model,prior),group=groups.get(key)||{requests:0,tokens:Object.fromEntries(tokenFields.map(k=>[k,prior[k]===null?null:0]))};
  group.requests++;
  for(const field of tokenFields){if(group.tokens[field]!==null){const value=prior[field];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('历史计数不可验证');group.tokens[field]!+=value;if(!Number.isSafeInteger(group.tokens[field]))throw Error('历史计数超限');}}
  groups.set(key,group);
 }
 const originals=new Set<string>();
 for(const row of db.prepare('SELECT event_id FROM codex_usage_event_ids WHERE account=?').iterate(account) as Iterable<{event_id:Buffer}>){const id=row.event_id.toString('hex');if(!oldIds.has(id))throw Error('历史请求身份缺失');originals.add(id);}
 if(originals.size!==original.n)throw Error('历史请求身份不完整');
 for(const row of db.prepare('SELECT day,cwd,model,tokens FROM codex_usage_events WHERE account=?').iterate(account) as Iterable<{day:string;cwd:string;model:string|null;tokens:string}>){
  const prior=JSON.parse(row.tokens) as Record<string,number|null>,key=keyFor(row.day,row.cwd,row.model,prior),group=groups.get(key),requests=prior.requests??1;
  if(!group||!Number.isSafeInteger(requests)||requests!<0||requests!>group.requests)throw Error('历史聚合无法核对');
  group.requests-=requests!;
  for(const field of tokenFields){if(group.tokens[field]!==null){const value=prior[field];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>group.tokens[field]!)throw Error('历史聚合无法核对');group.tokens[field]!-=value;}}
 }
 if([...groups.values()].some(group=>group.requests!==0||tokenFields.some(field=>group.tokens[field]!==null&&group.tokens[field]!==0)))throw Error('历史聚合无法核对');
}
