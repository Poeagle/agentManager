import {getDb} from '../../../db/index.js';
import {allCodexEnvironments,environmentConnection,getCodexEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {USAGE_SCAN} from './usage-scanner.js';
import {tokenFields} from '../../conversation-usage.js';
import {CREDIT_RATE_DATE,estimateUsageCredits} from './usage-credits.js';
import {realpathSync} from 'fs';
import {resolve,join} from 'path';
import {homedir,userInfo} from 'os';
import {readAgentManagement} from '../management-store.js';
import {externalProviderCodexHome} from './management.js';
import {cachedEngineBalance} from './engine-balance.js';
let timer:ReturnType<typeof setTimeout>|undefined;
let stopped=true;
const pending=new Map<string,Promise<void>>();
const controllers=new Map<string,AbortController>();
function usageHome(e:ReturnType<typeof getCodexEnvironment>){if(e.kind!=='provider')return localHome(e);const provider=readAgentManagement('codex').providers.find(p=>p.id===e.provider);return provider?externalProviderCodexHome(provider):'';}
const balanceGroup=(id:string)=>{try{return cachedEngineBalance(id).groupKey??null;}catch{return null;}};
const usageIdentity=(e:ReturnType<typeof getCodexEnvironment>)=>JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:e.kind==='provider'?[e.kind,usageHome(e),allCodexEnvironments().filter(other=>other.enabled&&other.kind!=='account').map(other=>[other.id,usageHome(other),balanceGroup(other.id)]).sort()]:[e.kind,usageHome(e)]);
function providerHistoryIsShared(id:string,home:string):boolean {
 const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
 const target=canonical(home);
 const group=balanceGroup(id);
 return allCodexEnvironments().some(e=>e.id!==id&&e.enabled&&e.kind!=='account'&&!!usageHome(e)&&canonical(usageHome(e))===target&&(!group||balanceGroup(e.id)!==group));
}
export function initAccountUsage(){getDb().exec(`
 DROP TABLE IF EXISTS codex_usage_cursors;
 CREATE TABLE IF NOT EXISTS codex_usage_snapshots(account TEXT PRIMARY KEY,initialized INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE INDEX IF NOT EXISTS codex_usage_days ON codex_usage_events(account,day);
 CREATE TABLE IF NOT EXISTS codex_usage_status(account TEXT PRIMARY KEY,checked_at TEXT,error TEXT,partial INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS codex_usage_sources(account TEXT PRIMARY KEY,identity TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_progress(account TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_dedup_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,provider TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE TABLE IF NOT EXISTS codex_usage_dedup_status(account TEXT PRIMARY KEY,ready INTEGER NOT NULL);
`);}
export async function collectAccountUsage(id:string):Promise<void>{
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const db=getDb(),e=getCodexEnvironment(id);if(!e.enabled)return;
  const identity=usageIdentity(e);
  const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
  if(source?.identity!==identity)db.transaction(()=>{
   for(const table of ['codex_usage_snapshots','codex_usage_events','codex_usage_status','codex_usage_progress','codex_usage_dedup_events','codex_usage_dedup_status'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);
   db.prepare('INSERT OR REPLACE INTO codex_usage_sources VALUES(?,?)').run(id,identity);
  })();
  const initialized=!!db.prepare('SELECT initialized FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(id);
  const dedupStatus=db.prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get(id) as {ready:number}|undefined;
  const mode=initialized&&dedupStatus?'daily':'full',day=new Date().toISOString().slice(0,10);
  const controller=new AbortController();controllers.set(id,controller);
  try{
   const home=e.kind==='account'?e.connection?.codexHome:usageHome(e);
   if(e.kind==='provider'&&(!home||providerHistoryIsShared(id,home)))throw Error('历史目录无法独立归属');
   const input=JSON.stringify({home,mode,day,includeEvents:true});
   const options={timeoutMs:mode==='full'?300000:120000,maxOutputBytes:32*1024*1024,signal:controller.signal};
   const result=JSON.parse(await (e.kind==='account'?accountCommandInput(environmentConnection(e),USAGE_SCAN,input,options):localCommandInput(USAGE_SCAN,input,options)));
   if(!Array.isArray(result.rows)||result.rows.length>50000||result.mode!==mode||result.day!==day)throw Error('Invalid usage response');
   for(const row of result.rows){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||mode==='daily'&&row.day!==day||typeof row.cwd!=='string'||row.cwd.length>4096||!Number.isSafeInteger(row.requests)||row.requests<1||!row.tokens||tokenFields.some(k=>row.tokens[k]!==null&&(!Number.isFinite(row.tokens[k])||row.tokens[k]<0)))throw Error('Invalid usage row');
   }
   if(!Array.isArray(result.events)||result.events.length>50000||result.events.some((event:any)=>!/^\w{64}$/.test(event.key)||!/^\d{4}-\d{2}-\d{2}$/.test(event.day)||mode==='daily'&&event.day!==day||typeof event.cwd!=='string'||event.cwd.length>4096||[event.provider,event.model,event.tier].some(v=>v!=null&&(typeof v!=='string'||v.length>120))||!event.tokens||tokenFields.some(k=>event.tokens[k]!==null&&(!Number.isFinite(event.tokens[k])||event.tokens[k]<0))))throw Error('Invalid deduplication response');
   const current=getCodexEnvironment(id);if(!current.enabled||usageIdentity(current)!==identity)return;
   db.transaction(()=>{
    // Publish one complete snapshot: historical days remain untouched on daily scans.
    if(mode==='full')db.prepare('DELETE FROM codex_usage_events WHERE account=?').run(id);
    else db.prepare('DELETE FROM codex_usage_events WHERE account=? AND day=?').run(id,day);
    const insert=db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)');
    for(const row of result.rows)insert.run(id,JSON.stringify([row.day,row.cwd,row.model,row.tier]),row.day,row.cwd,row.model||null,row.tier||null,JSON.stringify({...row.tokens,requests:row.requests}));
    if(mode==='full')db.prepare('DELETE FROM codex_usage_dedup_events WHERE account=?').run(id);
    else db.prepare('DELETE FROM codex_usage_dedup_events WHERE account=? AND day=?').run(id,day);
    const eventInsert=db.prepare('INSERT OR REPLACE INTO codex_usage_dedup_events VALUES(?,?,?,?,?,?,?,?)');
    for(const event of result.events)eventInsert.run(id,event.key,event.day,event.cwd,event.model||null,event.tier||null,event.provider||null,JSON.stringify(event.tokens));
    db.prepare('INSERT OR REPLACE INTO codex_usage_dedup_status VALUES(?,?)').run(id,!result.events_truncated&&(mode==='full'||dedupStatus?.ready===1)?1:0);
    db.prepare('INSERT OR REPLACE INTO codex_usage_snapshots VALUES(?,1)').run(id);
    db.prepare('INSERT OR REPLACE INTO codex_usage_status VALUES(?,?,?,?)').run(id,new Date().toISOString(),result.errors?'部分记录不可读取或缺少统计字段':null,result.partial||result.errors?1:0);
    if(result.progress)db.prepare('INSERT OR REPLACE INTO codex_usage_progress VALUES(?,?)').run(id,JSON.stringify(result.progress));
   })();
  }catch(error){const shared=error instanceof Error&&error.message==='历史目录无法独立归属';if(shared)db.transaction(()=>{for(const table of ['codex_usage_events','codex_usage_snapshots','codex_usage_progress','codex_usage_dedup_events','codex_usage_dedup_status'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);})();const message=shared?'历史目录与其他 Engine 共用或无法确认，未统计以避免重复':'采集失败，保留上次成功数据';db.prepare(`INSERT INTO codex_usage_status(account,error,partial) VALUES(?,?,1) ON CONFLICT(account) DO UPDATE SET error=excluded.error,partial=1`).run(id,message);}
  finally{controllers.delete(id);}
 })();pending.set(id,task);try{await task;}finally{pending.delete(id);}
}
export function cachedAccountUsage(id:string){
 const db=getDb();
 const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
 if(source&&source.identity!==usageIdentity(getCodexEnvironment(id)))return {initialized:false,checked_at:null,error:null,partial:true,progress:null,timezone:'UTC',credit_rate_date:CREDIT_RATE_DATE,rows:[]};
 const status=db.prepare('SELECT checked_at,error,partial FROM codex_usage_status WHERE account=?').get(id) as {checked_at:string|null;error:string|null;partial:number}|undefined;
 const sums=tokenFields.map(k=>`CASE WHEN COUNT(json_extract(tokens,'$.${k}'))=COUNT(*) THEN SUM(json_extract(tokens,'$.${k}')) ELSE NULL END AS ${k}`).join(',');
 const rows=db.prepare(`SELECT day,cwd,${sums} FROM codex_usage_events WHERE account=? GROUP BY day,cwd ORDER BY day DESC,cwd LIMIT 5001`).all(id) as Array<Record<string,any>>;
 const estimates=new Map<string,{value:number;covered:number;requests:number}>();
 const models=new Map<string,Map<string,{model:string|null;tokens:Record<string,number|null>;estimated_credits:number|null;credit_coverage:{covered:number;total:number}}>>();
 const breakdown=db.prepare(`SELECT day,cwd,model,tier,SUM(COALESCE(json_extract(tokens,'$.requests'),1)) requests,${sums} FROM codex_usage_events WHERE account=? GROUP BY day,cwd,model,tier`).all(id) as Array<Record<string,any>>;
 for(const row of breakdown){
  const key=JSON.stringify([row.day,row.cwd]),group=estimates.get(key)||{value:0,covered:0,requests:0};const value=estimateUsageCredits(row.model,row.tier,row);group.requests+=row.requests;if(value!==null){group.value+=value;group.covered+=row.requests;}estimates.set(key,group);
  const byModel=models.get(key)||new Map(),modelKey=JSON.stringify(row.model),model=byModel.get(modelKey)||{model:row.model,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),estimated_credits:null,credit_coverage:{covered:0,total:0}};
  for(const field of tokenFields)model.tokens[field]=model.tokens[field]===null||row[field]===null?null:model.tokens[field]!+row[field];
  model.credit_coverage.total+=row.requests;if(value!==null){model.estimated_credits=(model.estimated_credits??0)+value;model.credit_coverage.covered+=row.requests;}
  byModel.set(modelKey,model);models.set(key,byModel);
 }
 const projects=db.prepare('SELECT name,path FROM projects').all() as {name:string;path:string}[];
 const progress=db.prepare('SELECT data FROM codex_usage_progress WHERE account=?').get(id) as {data:string}|undefined;
 const initialized=!!db.prepare('SELECT account FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(id);
 return {initialized,checked_at:status?.checked_at??null,error:status?.error??null,partial:status?.partial!==0||rows.length>5000,progress:progress?JSON.parse(progress.data):null,timezone:'UTC',credit_rate_date:CREDIT_RATE_DATE,rows:rows.slice(0,5000).map(row=>{
  const match=projects.filter(p=>row.cwd===p.path||row.cwd.startsWith(p.path.replace(/\/$/,'')+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
  const estimate=estimates.get(JSON.stringify([row.day,row.cwd]));
  return {date:row.day,cwd:row.cwd,project_name:match?.name??(row.cwd.split('/').filter(Boolean).pop()||'未归属'),tokens:Object.fromEntries(tokenFields.map(k=>[k,row[k]])),estimated_credits:estimate?.covered?estimate.value:null,credit_coverage:estimate?{covered:estimate.covered,total:estimate.requests}:null,models:[...(models.get(JSON.stringify([row.day,row.cwd]))?.values()||[])].sort((a,b)=>(b.tokens.total_tokens??0)-(a.tokens.total_tokens??0))};
 })};
}
/** Combine per-request snapshots using their content fingerprints. Conflicting
 * copies are excluded and marked partial rather than counted twice. */
export function cachedGroupUsage(ids:string[]){
 const db=getDb(),events=new Map<string,{day:string;cwd:string;model:string|null;tier:string|null;provider:string|null;tokens:string}|null>();let partial=false;const checked:string[]=[];
 const all=allCodexEnvironments().filter(e=>e.enabled);
 const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
 const homeFor=(e:ReturnType<typeof getCodexEnvironment>)=>e.kind==='account'?(e.connection?.codexHome||((e.connection?.username===userInfo().username)?join(homedir(),'.codex'):'')):usageHome(e);
 for(const id of ids){
  const environment=getCodexEnvironment(id),home=homeFor(environment),group=balanceGroup(id),providerId=cachedEngineBalance(id).providerId;
  if(!providerId){partial=true;continue;}
  if(!home||all.some(other=>{const otherHome=homeFor(other);return other.id!==id&&!!otherHome&&canonical(otherHome)===canonical(home)&&(!group||balanceGroup(other.id)!==group);})){partial=true;continue;}
  const snapshot=cachedAccountUsage(id);
  const ready=db.prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get(id) as {ready:number}|undefined;
  if(!snapshot.initialized||!ready?.ready){partial=true;continue;}if(snapshot.partial)partial=true;if(snapshot.checked_at)checked.push(snapshot.checked_at);
  const rows=db.prepare('SELECT event_key,day,cwd,model,tier,provider,tokens FROM codex_usage_dedup_events WHERE account=? LIMIT 50001').all(id) as Array<{event_key:string;day:string;cwd:string;model:string|null;tier:string|null;provider:string|null;tokens:string}>;
  if(rows.length>50000){partial=true;continue;}
  for(const {event_key,...event} of rows){
   if(!event.provider){partial=true;continue;}if(event.provider!==providerId)continue;
   if(!events.has(event_key))events.set(event_key,event);
   else if(JSON.stringify(events.get(event_key))!==JSON.stringify(event)){events.set(event_key,null);partial=true;}
   if(events.size>200000)return {partial:true,error:'统计记录过多，无法安全合并',rows:[]};
  }
 }
 const grouped=new Map<string,{date:string;cwd:string;tokens:Record<string,number|null>;requests:number;models:Map<string,{model:string|null;tokens:Record<string,number|null>;estimated_credits:number|null;credit_coverage:{covered:number;total:number}}>}>();
 for(const event of events.values()){
  if(!event)continue;const key=JSON.stringify([event.day,event.cwd]);let row=grouped.get(key);
  if(!row){row={date:event.day,cwd:event.cwd,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),requests:0,models:new Map()};grouped.set(key,row);}
  const tokens=JSON.parse(event.tokens);row.requests++;
  const modelKey=JSON.stringify(event.model);let model=row.models.get(modelKey);
  if(!model){model={model:event.model,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),estimated_credits:null,credit_coverage:{covered:0,total:0}};row.models.set(modelKey,model);}
  model.credit_coverage.total++;const estimate=estimateUsageCredits(event.model,event.tier,tokens);if(estimate!==null){model.estimated_credits=(model.estimated_credits??0)+estimate;model.credit_coverage.covered++;}
  for(const field of tokenFields){row.tokens[field]=row.tokens[field]===null||tokens[field]===null?null:row.tokens[field]!+tokens[field];model.tokens[field]=model.tokens[field]===null||tokens[field]===null?null:model.tokens[field]!+tokens[field];}
 }
 if(grouped.size>5000)partial=true;
 const projects=db.prepare('SELECT name,path FROM projects').all() as {name:string;path:string}[];
 return {initialized:checked.length>0,checked_at:checked.sort()[0]??null,timezone:'UTC',credit_rate_date:CREDIT_RATE_DATE,partial,error:partial?'部分环境尚未完成采集或存在无法去重的记录':null,rows:[...grouped.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5000).map(({models,...row})=>{const entries=[...models.values()],known=entries.filter(m=>m.estimated_credits!==null),match=projects.filter(p=>row.cwd===p.path||row.cwd.startsWith(p.path.replace(/\/$/,'')+'/')).sort((a,b)=>b.path.length-a.path.length)[0];return {...row,project_name:match?.name??(row.cwd.split('/').filter(Boolean).pop()||'未归属'),models:entries,estimated_credits:known.length?known.reduce((s,m)=>s+m.estimated_credits!,0):null,credit_coverage:{covered:entries.reduce((s,m)=>s+m.credit_coverage.covered,0),total:entries.reduce((s,m)=>s+m.credit_coverage.total,0)}};})};
}
export function startAccountUsage(){initAccountUsage();stopped=false;const tick=async()=>{try{for(const e of allCodexEnvironments()){if(stopped)break;if(e.enabled)await collectAccountUsage(e.id);}}catch{/* Configuration may be changing; retry on the next scheduled pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),300000);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopAccountUsage(){stopped=true;clearTimeout(timer);for(const controller of controllers.values())controller.abort();await Promise.allSettled([...pending.values()]);}
