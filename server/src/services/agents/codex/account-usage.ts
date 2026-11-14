import {getDb} from '../../../db/index.js';
import {assertUsageRebuildPreserves} from './usage-rule-guard.js';
// Increment when persisted interpretation of native usage records changes.
export const USAGE_RULE_VERSION=3;
import {quotaSamples} from './account-status.js';
import {allocateQuota} from './quota-allocation.js';
import {allCodexEnvironments,environmentConnection,getCodexEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {USAGE_EVENT_LIMIT,USAGE_SCAN} from './usage-scanner.js';
import {tokenFields} from '../../conversation-usage.js';
import {CREDIT_RATE_DATE,estimateUsageCredits} from './usage-credits.js';
import {initUsageProvenance,usageOrigins} from './usage-provenance.js';
import {realpathSync} from 'fs';
import {resolve,join} from 'path';
import {homedir,userInfo} from 'os';
import {readAgentManagement} from '../management-store.js';
import {externalProviderCodexHome} from './management.js';
import {cachedEngineBalance} from './engine-balance.js';
import {usageTimezone,usageDay} from './usage-time.js';
import {initUsageTimeStorage,usageStoredTimezone,retainUnassignedUsage,unassignedUsage,type MatchedUsage} from './usage-time-migration.js';
let timer:ReturnType<typeof setTimeout>|undefined;
let stopped=true;
const pending=new Map<string,Promise<void>>();
const hourlyPending=new Map<string,Promise<void>>();
const controllers=new Map<string,AbortController>();
function usageHome(e:ReturnType<typeof getCodexEnvironment>){if(e.kind!=='provider')return localHome(e);const provider=readAgentManagement('codex').providers.find(p=>p.id===e.provider);return provider?externalProviderCodexHome(provider):'';}
const balanceGroup=(id:string)=>{try{return cachedEngineBalance(id).groupKey??null;}catch{return null;}};
const usageIdentity=(e:ReturnType<typeof getCodexEnvironment>)=>JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:e.kind==='provider'?[e.kind,usageHome(e),balanceGroup(e.id)]:[e.kind,usageHome(e)]);
function providerHistoryIsShared(id:string,home:string):boolean {
 const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
 const target=canonical(home);
 const group=balanceGroup(id);
 return allCodexEnvironments().some(e=>e.id!==id&&e.enabled&&e.kind!=='account'&&!!usageHome(e)&&canonical(usageHome(e))===target&&(!group||balanceGroup(e.id)!==group));
}
export function initAccountUsage(){initUsageProvenance();getDb().exec(`
 DROP TABLE IF EXISTS codex_usage_cursors;
 CREATE TABLE IF NOT EXISTS codex_usage_snapshots(account TEXT PRIMARY KEY,initialized INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE INDEX IF NOT EXISTS codex_usage_days ON codex_usage_events(account,day);
 CREATE TABLE IF NOT EXISTS codex_usage_status(account TEXT PRIMARY KEY,checked_at TEXT,error TEXT,partial INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS codex_usage_rule_versions(account TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,retry_at TEXT);
 CREATE TABLE IF NOT EXISTS codex_usage_scan_boundary(account TEXT PRIMARY KEY,started_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_sources(account TEXT PRIMARY KEY,identity TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_progress(account TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_event_ids(account TEXT NOT NULL,event_id BLOB NOT NULL,day TEXT NOT NULL,PRIMARY KEY(account,event_id));
 CREATE INDEX IF NOT EXISTS codex_usage_event_id_days ON codex_usage_event_ids(account,day);
 CREATE TABLE IF NOT EXISTS codex_usage_ledger(account TEXT PRIMARY KEY,baseline_at TEXT,last_day TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_dedup_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,provider TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE TABLE IF NOT EXISTS codex_usage_dedup_status(account TEXT PRIMARY KEY,ready INTEGER NOT NULL);
`);
 initUsageTimeStorage();
 const db=getDb();
 if(!(db.prepare('PRAGMA table_info(codex_usage_dedup_events)').all() as {name:string}[]).some(column=>column.name==='hour'))db.exec('ALTER TABLE codex_usage_dedup_events ADD COLUMN hour TEXT');
 if(!(db.prepare('PRAGMA table_info(codex_usage_dedup_events)').all() as {name:string}[]).some(column=>column.name==='at'))db.exec('ALTER TABLE codex_usage_dedup_events ADD COLUMN at TEXT');
 if(!(db.prepare('PRAGMA table_info(codex_usage_dedup_status)').all() as {name:string}[]).some(column=>column.name==='hour_backfilled'))db.exec('ALTER TABLE codex_usage_dedup_status ADD COLUMN hour_backfilled INTEGER NOT NULL DEFAULT 0');
}
export async function collectAccountUsage(id:string,options:{rebuild?:boolean;preserveExisting?:boolean}={}):Promise<void>{
 if(!options.rebuild&&pending.has(id))return pending.get(id)!;
 while(pending.has(id))await pending.get(id);
 if(options.rebuild&&hourlyPending.has(id)){controllers.get('hourly:'+id)?.abort();await hourlyPending.get(id);}
 const task=(async()=>{
  const db=getDb(),e=getCodexEnvironment(id);if(!e.enabled&&!options.rebuild)return;
  const identity=usageIdentity(e);
  let source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
  if(source&&e.kind==='provider'){
   try{const old=JSON.parse(source.identity),current=JSON.parse(identity);if(Array.isArray(old[2])&&old[0]===current[0]&&old[1]===current[1]&&old[2].some((r:unknown)=>Array.isArray(r)&&r[0]===id&&r[1]===current[1]&&r[2]===current[2])){db.prepare('UPDATE codex_usage_sources SET identity=? WHERE account=?').run(identity,id);source={identity};}}catch{/* An incompatible source requires a fresh baseline. */}
  }
  if(!options.rebuild&&source?.identity!==identity)db.transaction(()=>{
   for(const table of ['codex_usage_snapshots','codex_usage_events','codex_usage_status','codex_usage_scan_boundary','codex_usage_progress','codex_usage_event_ids','codex_usage_ledger','codex_usage_dedup_events','codex_usage_dedup_status','codex_usage_unassigned'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);
   if(source)db.prepare('DELETE FROM codex_usage_origins WHERE account=?').run(id);
   db.prepare('INSERT OR REPLACE INTO codex_usage_sources VALUES(?,?)').run(id,identity);
  })();
  const initialized=!options.rebuild&&!!db.prepare('SELECT initialized FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(id);
  const dedupStatus=options.rebuild?undefined:db.prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get(id) as {ready:number}|undefined;
  const timezone=usageTimezone(),previousTimezone=usageStoredTimezone(id),rebin=initialized&&previousTimezone!==timezone;
  const mode=initialized&&dedupStatus?.ready===1&&!rebin?'daily':'full',day=usageDay(Date.now(),timezone);
  const controller=new AbortController();controllers.set(id,controller);
  try{
   const home=e.kind==='account'?e.connection?.codexHome:usageHome(e);
   if(e.kind==='provider'&&(!home||providerHistoryIsShared(id,home)))throw Error('历史目录无法独立归属');
   const ledger=options.rebuild?undefined:db.prepare('SELECT baseline_at,last_day FROM codex_usage_ledger WHERE account=?').get(id) as {baseline_at:string|null;last_day:string}|undefined;
   const prior=db.prepare('SELECT checked_at,error,partial FROM codex_usage_status WHERE account=?').get(id) as {checked_at:string|null;error:string|null;partial:number}|undefined;
   const baseline=ledger?.baseline_at??(!ledger&&initialized?prior?.checked_at:null)??null;
   if(initialized&&!ledger&&(!baseline||!Number.isFinite(Date.parse(baseline))))throw Error('Legacy usage baseline unavailable');
   const yesterday=new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10);
   const lastDay=ledger?.last_day??prior?.checked_at?.slice(0,10);
   const days=mode==='daily'&&lastDay&&lastDay<day?[yesterday,day]:[day];
   const known=options.rebuild?[]:db.prepare('SELECT event_id FROM codex_usage_event_ids WHERE account=? AND (? OR timezone!=? OR day IN (?,?)) LIMIT 2000001').all(id,rebin||mode==='full'?1:0,timezone,days[0],day) as {event_id:Buffer}[];
   if(known.length>2000000)throw Error('Usage identity limit exceeded');
   const input=JSON.stringify({home,mode,day,days,timezone,previous_timezone:previousTimezone,rebin,baseline_at:baseline,known_events:Buffer.concat(known.map(r=>r.event_id)).toString('base64'),origins:usageOrigins(id),includeEvents:true,rebuildEvents:initialized&&dedupStatus?.ready!==1});
   const commandOptions={timeoutMs:mode==='full'?300000:120000,maxOutputBytes:256*1024*1024,signal:controller.signal};
   const scanStartedAt=new Date().toISOString();
   const result=JSON.parse(await (e.kind==='account'?accountCommandInput(environmentConnection(e),USAGE_SCAN,input,commandOptions):localCommandInput(USAGE_SCAN,input,commandOptions)));
   if(!Array.isArray(result.rows)||result.rows.length>50000||result.mode!==mode||result.day!==day)throw Error('Invalid usage response');
   const requestsPerDay=new Map<string,number>();
   for(const row of result.rows){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||mode==='daily'&&!days.includes(row.day)||typeof row.cwd!=='string'||row.cwd.length>4096||!Number.isSafeInteger(row.requests)||row.requests<1||!row.tokens||tokenFields.some(k=>row.tokens[k]!==null&&(!Number.isFinite(row.tokens[k])||row.tokens[k]<0)))throw Error('Invalid usage row');
    requestsPerDay.set(row.day,(requestsPerDay.get(row.day)??0)+row.requests);
   }
   if(!result.event_keys||typeof result.event_keys!=='object'||Array.isArray(result.event_keys))throw Error('Usage identities unavailable');
   const events:Array<{day:string;keys:Buffer}>=[];let count=0;
   for(const [eventDay,encoded]of Object.entries(result.event_keys)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(eventDay)||mode==='daily'&&!days.includes(eventDay)||typeof encoded!=='string')throw Error('Invalid usage identities');
    const keys=Buffer.from(encoded,'base64');
    if(keys.length%32||keys.toString('base64')!==encoded)throw Error('Invalid usage identities');
    count+=keys.length/32;if(count>2000000)throw Error('Usage identity limit exceeded');
    if((requestsPerDay.get(eventDay)??0)!==keys.length/32)throw Error('Usage identity count mismatch');
    events.push({day:eventDay,keys});
   }
   if(result.rows.reduce((n:number,r:any)=>n+r.requests,0)!==count)throw Error('Usage identity count mismatch');
   if(rebin&&(!Array.isArray(result.matched_rows)||result.matched_rows.length>50000||result.matched_rows.some((r:MatchedUsage)=>typeof r.legacy!=='boolean'||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||typeof r.cwd!=='string'||r.cwd.length>4096||!Number.isSafeInteger(r.requests)||r.requests<1||!r.tokens||tokenFields.some(k=>r.tokens[k]!==null&&(!Number.isFinite(r.tokens[k])||r.tokens[k]!<0)))))throw Error('Invalid timezone reconciliation');
   if(!Array.isArray(result.events)||result.events.length>USAGE_EVENT_LIMIT||result.events.some((event:any)=>!/^\w{64}$/.test(event.key)||event.legacy_key!=null&&!/^[a-f0-9]{64}$/.test(event.legacy_key)||!/^\d{4}-\d{2}-\d{2}$/.test(event.day)||event.at!=null&&(typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at)))||event.hour!=null&&(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00:00(?:Z|[+-]\d{2}:\d{2})$/.test(event.hour)||!event.hour.startsWith(event.day))||mode==='daily'&&!days.includes(event.day)||typeof event.cwd!=='string'||event.cwd.length>4096||[event.provider,event.model,event.tier].some(v=>v!=null&&(typeof v!=='string'||v.length>120))||!event.tokens||tokenFields.some(k=>event.tokens[k]!==null&&(!Number.isFinite(event.tokens[k])||event.tokens[k]<0))))throw Error('Invalid deduplication response');
   if(options.preserveExisting&&(result.events_truncated||result.events.length!==count||result.events.some((event:any)=>!event.hour)||previousTimezone!==timezone))throw Error('历史重读不完整');
   if(options.rebuild&&(result.events_truncated||result.events.length!==count||result.events.some((event:any)=>!event.hour)||(result.errors&&count===0)))throw Error('Rebuild incomplete');
   const current=getCodexEnvironment(id);if((!current.enabled&&!options.rebuild)||usageIdentity(current)!==identity){if(options.rebuild)throw Error('Environment changed');return;}
   db.transaction(()=>{
    if(options.preserveExisting)assertUsageRebuildPreserves(db,id,result.events,USAGE_EVENT_LIMIT);
    if(options.rebuild){
     for(const table of ['codex_usage_snapshots','codex_usage_events','codex_usage_status','codex_usage_scan_boundary','codex_usage_progress','codex_usage_event_ids','codex_usage_ledger','codex_usage_dedup_events','codex_usage_dedup_status','codex_usage_unassigned'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);
     db.prepare('INSERT OR REPLACE INTO codex_usage_sources VALUES(?,?)').run(id,identity);
    }
    // Request identities and aggregates commit together. Missing/truncated files
    // never retract recorded consumption; repeated/forked records cannot add it.
    if(rebin){retainUnassignedUsage(id,previousTimezone,result.matched_rows);db.prepare('DELETE FROM codex_usage_events WHERE account=?').run(id);}
    const record=db.prepare(rebin?'INSERT INTO codex_usage_event_ids(account,event_id,day,timezone) VALUES(?,?,?,?) ON CONFLICT(account,event_id) DO UPDATE SET day=excluded.day,timezone=excluded.timezone':'INSERT INTO codex_usage_event_ids(account,event_id,day,timezone) VALUES(?,?,?,?)');
    for(const event of events)for(let i=0;i<event.keys.length;i+=32)record.run(id,event.keys.subarray(i,i+32),event.day,timezone);
    const lookup=db.prepare('SELECT tokens FROM codex_usage_events WHERE account=? AND event_key=?');
    const insert=db.prepare('INSERT OR REPLACE INTO codex_usage_events VALUES(?,?,?,?,?,?,?)');
    for(const row of result.rows){
     const key=JSON.stringify([row.day,row.cwd,row.model,row.tier,tokenFields.map(k=>row.tokens[k]===null?0:1).join('')]);
     const previous=lookup.get(id,key) as {tokens:string}|undefined,old=previous?JSON.parse(previous.tokens):null;
     const tokens=old?Object.fromEntries(tokenFields.map(k=>[k,old[k]==null||row.tokens[k]===null?null:old[k]+row.tokens[k]])):row.tokens;
     insert.run(id,key,row.day,row.cwd,row.model||null,row.tier||null,JSON.stringify({...tokens,requests:row.requests+(old?.requests??0)}));
    }
    const eventInsert=db.prepare('INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,provider,tokens,hour,at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account,event_key) DO UPDATE SET day=excluded.day,cwd=excluded.cwd,model=excluded.model,tier=excluded.tier,provider=excluded.provider,tokens=excluded.tokens,hour=COALESCE(excluded.hour,hour),at=COALESCE(excluded.at,at)');
    for(const event of result.events)eventInsert.run(id,event.key,event.day,event.cwd,event.model||null,event.tier||null,event.provider||null,JSON.stringify({...event.tokens,_timezone:timezone,...event.legacy_key?{_legacy_key:event.legacy_key}:{}}),event.hour||null,event.at||null);
    db.prepare('INSERT INTO codex_usage_dedup_status(account,ready) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET ready=excluded.ready').run(id,!result.events_truncated&&(mode==='full'||dedupStatus?.ready===1)?1:0);
    if(options.rebuild)db.prepare('UPDATE codex_usage_dedup_status SET hour_backfilled=1 WHERE account=?').run(id);
    db.prepare('INSERT INTO codex_usage_ledger(account,baseline_at,last_day,timezone) VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET last_day=excluded.last_day,timezone=excluded.timezone').run(id,baseline,day,timezone);
    db.prepare('INSERT OR REPLACE INTO codex_usage_snapshots VALUES(?,1)').run(id);
    if(options.rebuild||!initialized)db.prepare("INSERT OR REPLACE INTO codex_usage_rule_versions VALUES(?,?,'ready',NULL)").run(id,USAGE_RULE_VERSION);
    const historicalIncomplete=mode==='daily'&&prior?.error==='部分记录不可读取或缺少统计字段';
    db.prepare('INSERT OR REPLACE INTO codex_usage_status VALUES(?,?,?,?)').run(id,new Date().toISOString(),result.errors||historicalIncomplete?'部分记录不可读取或缺少统计字段':null,result.partial||result.errors||historicalIncomplete?1:0);
    db.prepare('INSERT OR REPLACE INTO codex_usage_scan_boundary VALUES(?,?)').run(id,scanStartedAt);
    if(result.progress)db.prepare('INSERT OR REPLACE INTO codex_usage_progress VALUES(?,?)').run(id,JSON.stringify(result.progress));
   })();
  }catch(error){const message=error instanceof Error&&error.message==='历史目录无法独立归属'?'历史目录与其他 Engine 共用或无法确认，未统计以避免重复':'采集失败，保留上次成功数据';if(options.rebuild)throw Object.assign(Error(message),{statusCode:409});db.prepare('INSERT INTO codex_usage_status(account,error,partial) VALUES(?,?,1) ON CONFLICT(account) DO UPDATE SET error=excluded.error,partial=1').run(id,message);}
  finally{controllers.delete(id);}
 })();pending.set(id,task);try{await task;}finally{pending.delete(id);}
}
function allocatedQuota(id:string){
 const db=getDb(),samples=quotaSamples(id);
 if(samples.length<2)return new Map<string,number>();
 const status=db.prepare('SELECT checked_at,partial FROM codex_usage_status WHERE account=?').get(id) as {checked_at:string|null;partial:number}|undefined;
 const ready=db.prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get(id) as {ready:number}|undefined;
 if(!ready?.ready||!status||status.partial)return new Map<string,number>();
 const events=db.prepare('SELECT at,day,hour,cwd,model,tier,tokens FROM codex_usage_dedup_events WHERE account=? AND at IS NOT NULL AND julianday(at)>julianday(?) AND julianday(at)<=julianday(?) ORDER BY at LIMIT ?').all(id,samples[0].checked_at,samples[samples.length-1].checked_at,USAGE_EVENT_LIMIT+1) as Array<{at:string;day:string;hour:string|null;cwd:string;model:string|null;tier:string|null;tokens:string}>;
 if(events.length>USAGE_EVENT_LIMIT)return new Map<string,number>();
 const boundary=db.prepare('SELECT started_at FROM codex_usage_scan_boundary WHERE account=?').get(id) as {started_at:string}|undefined;
 const hourly=allocateQuota(samples,events,boundary?.started_at??null),result=new Map(hourly);
 for(const [key,value] of hourly){const [day,,cwd,model]=JSON.parse(key);const daily=JSON.stringify([day,null,cwd,model]);result.set(daily,(result.get(daily)??0)+value);}
 return result;
}
function quotaByModel(allocation:Map<string,number>,day:string,cwd:string,model:string|null,hour?:string|null){
 return allocation.get(JSON.stringify([day,hour??null,cwd,model]))??null;
}
export function cachedAccountUsage(id:string){
 const db=getDb(),timezone=usageStoredTimezone(id),timezone_pending=timezone!==usageTimezone()?usageTimezone():null,unassigned=unassignedUsage(id);
 const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
 if(source&&source.identity!==usageIdentity(getCodexEnvironment(id)))return {initialized:false,checked_at:null,error:null,partial:true,progress:null,timezone,credit_rate_date:CREDIT_RATE_DATE,rows:[]};
 const environment=getCodexEnvironment(id);
 if(environment.kind==='provider'&&(!usageHome(environment)||providerHistoryIsShared(id,usageHome(environment))))return {initialized:false,checked_at:null,error:'历史目录与其他 Engine 共用或无法确认，未统计以避免重复',partial:true,progress:null,timezone,credit_rate_date:CREDIT_RATE_DATE,rows:[]};
 const status=db.prepare('SELECT checked_at,error,partial FROM codex_usage_status WHERE account=?').get(id) as {checked_at:string|null;error:string|null;partial:number}|undefined;
 const rule=db.prepare('SELECT version,state FROM codex_usage_rule_versions WHERE account=?').get(id) as {version:number;state:string}|undefined;
 const ruleWarning=!rule||rule.version!==USAGE_RULE_VERSION?'统计规则已更新，历史缓存等待校验':rule.state==='blocked'?'历史缓存无法完整核对，已保留旧数据；部分估算可能使用旧规则':rule.state==='pending'?'正在校验统计规则和历史缓存':null;
 const sums=tokenFields.map(k=>`CASE WHEN COUNT(json_extract(tokens,'$.${k}'))=COUNT(*) THEN SUM(json_extract(tokens,'$.${k}')) ELSE NULL END AS ${k}`).join(',');
 const rows=db.prepare(`SELECT day,cwd,${sums} FROM codex_usage_events WHERE account=? GROUP BY day,cwd ORDER BY day DESC,cwd LIMIT 5001`).all(id) as Array<Record<string,any>>;
 const estimates=new Map<string,{value:number;covered:number;requests:number}>();
 const models=new Map<string,Map<string,{model:string|null;tokens:Record<string,number|null>;estimated_credits:number|null;credit_coverage:{covered:number;total:number}}>>();
 const counterColumns=tokenFields.map(k=>`json_extract(tokens,'$.${k}') AS ${k}`).join(',');
 const breakdown=db.prepare(`SELECT day,cwd,model,tier,COALESCE(json_extract(tokens,'$.requests'),1) requests,${counterColumns} FROM codex_usage_events WHERE account=?`).all(id) as Array<Record<string,any>>;
 for(const row of breakdown){
  const key=JSON.stringify([row.day,row.cwd]),group=estimates.get(key)||{value:0,covered:0,requests:0};const value=estimateUsageCredits(row.model,row.tier,row);group.requests+=row.requests;if(value!==null){group.value+=value;group.covered+=row.requests;}estimates.set(key,group);
  const byModel=models.get(key)||new Map(),modelKey=JSON.stringify(row.model),model=byModel.get(modelKey)||{model:row.model,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),estimated_credits:null,credit_coverage:{covered:0,total:0}};
  for(const field of tokenFields)model.tokens[field]=model.tokens[field]===null||row[field]===null?null:model.tokens[field]!+row[field];
  model.credit_coverage.total+=row.requests;if(value!==null){model.estimated_credits=(model.estimated_credits??0)+value;model.credit_coverage.covered+=row.requests;}
  byModel.set(modelKey,model);models.set(key,byModel);
 }
 const allocation=allocatedQuota(id);
 const projects=db.prepare('SELECT name,path FROM projects').all() as {name:string;path:string}[];
 const progress=db.prepare('SELECT data FROM codex_usage_progress WHERE account=?').get(id) as {data:string}|undefined;
 const initialized=!!db.prepare('SELECT account FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(id);
 return {initialized,checked_at:status?.checked_at??null,error:ruleWarning??status?.error??(timezone_pending?'正在按本地时间重建历史统计':unassigned?'部分历史原始日志缺失，已保留用量但无法按本地日期归属':null),partial:!!ruleWarning||status?.partial!==0||rows.length>5000||!!timezone_pending||!!unassigned,timezone_pending,unassigned,progress:progress?JSON.parse(progress.data):null,timezone,credit_rate_date:CREDIT_RATE_DATE,rows:rows.slice(0,5000).map(row=>{
  const match=projects.filter(p=>row.cwd===p.path||row.cwd.startsWith(p.path.replace(/\/$/,'')+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
  const estimate=estimates.get(JSON.stringify([row.day,row.cwd]));
  return {date:row.day,cwd:row.cwd,project_name:match?.name??(row.cwd.split('/').filter(Boolean).pop()||'未归属'),tokens:Object.fromEntries(tokenFields.map(k=>[k,row[k]])),estimated_credits:estimate?.covered?estimate.value:null,credit_coverage:estimate?{covered:estimate.covered,total:estimate.requests}:null,models:[...(models.get(JSON.stringify([row.day,row.cwd]))?.values()||[])].map(model=>({...model,actual_quota:quotaByModel(allocation,row.day,row.cwd,model.model)})).sort((a,b)=>(b.tokens.total_tokens??0)-(a.tokens.total_tokens??0))};
 })};
}
/** Populate timestamps only for previously recorded event identities. Existing
 * totals remain authoritative even when a history file has been deleted. */
export async function backfillUsageHours(id:string):Promise<void>{
 if(pending.has(id))return;
 if(hourlyPending.has(id))return hourlyPending.get(id)!;
 const task=(async()=>{
  const db=getDb(),status=db.prepare('SELECT hour_backfilled FROM codex_usage_dedup_status WHERE account=?').get(id) as {hour_backfilled:number}|undefined;
  if(!status||status.hour_backfilled)return;
  if(!db.prepare('SELECT 1 FROM codex_usage_dedup_events WHERE account=? AND hour IS NULL LIMIT 1').get(id)){db.prepare('UPDATE codex_usage_dedup_status SET hour_backfilled=1 WHERE account=?').run(id);return;}
  const e=getCodexEnvironment(id),identity=usageIdentity(e);if(!e.enabled)return;
  const home=e.kind==='account'?e.connection?.codexHome:usageHome(e);
  if(e.kind==='provider'&&(!home||providerHistoryIsShared(id,home)))return;
  const controller=new AbortController();controllers.set('hourly:'+id,controller);
  try{
   const timezone=usageTimezone();if(usageStoredTimezone(id)!==timezone)return;
   const day=usageDay(Date.now(),timezone),input=JSON.stringify({home,mode:'full',day,days:[day],timezone,baseline_at:new Date().toISOString(),known_events:'',origins:usageOrigins(id),includeEvents:true,rebuildEvents:true});
   const options={timeoutMs:300000,maxOutputBytes:256*1024*1024,signal:controller.signal};
   const raw=await(e.kind==='account'?accountCommandInput(environmentConnection(e),USAGE_SCAN,input,options):localCommandInput(USAGE_SCAN,input,options));
   const data=JSON.parse(raw);if(!Array.isArray(data.events)||data.events.length>USAGE_EVENT_LIMIT)throw Error('Invalid hourly backfill');
   if(usageIdentity(getCodexEnvironment(id))!==identity)return;
   db.transaction(()=>{
    const update=db.prepare('UPDATE codex_usage_dedup_events SET hour=? WHERE account=? AND event_key=? AND day=? AND hour IS NULL');
    for(const event of data.events){if(typeof event.key==='string'&&/^[a-f0-9]{64}$/.test(event.key)&&typeof event.day==='string'&&typeof event.hour==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00:00(?:Z|[+-]\d{2}:\d{2})$/.test(event.hour)&&event.hour.startsWith(event.day))update.run(event.hour,id,event.key,event.day);}
    db.prepare('UPDATE codex_usage_dedup_status SET hour_backfilled=1 WHERE account=?').run(id);
   })();
  }catch{/* Keep original totals; a later scheduled pass may retry. */}
  finally{controllers.delete('hourly:'+id);}
 })();hourlyPending.set(id,task);try{await task;}finally{hourlyPending.delete(id);}
}
/** Combine per-request snapshots using their content fingerprints. Conflicting
 * copies are excluded and marked partial rather than counted twice. */
export function cachedGroupUsage(ids:string[],granularity:'day'|'hour'='day',single=false){
 type GroupEvent={day:string;hour:string|null;cwd:string;model:string|null;tier:string|null;provider:string|null;tokens:string};
 const db=getDb(),events=new Map<string,GroupEvent|null>(),legacy:Array<{key:string;event:GroupEvent;unassigned?:boolean}>=[],aliases=new Map<string,string|null>();let partial=false,processed=0;const checked:string[]=[],timezone=usageTimezone(),unassignedEvents=new Map<string,GroupEvent|null>();
 const merge=(key:string,event:GroupEvent)=>{if(!events.has(key)){events.set(key,event);return;}const current=events.get(key);if(!current)return;const {hour:a,...left}=current,{hour:b,...right}=event;if(JSON.stringify(left)!==JSON.stringify(right)||a&&b&&a!==b){events.set(key,null);partial=true;}else if(!a&&b)current.hour=b;};
 const all=allCodexEnvironments().filter(e=>e.enabled);
 const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
 const homeFor=(e:ReturnType<typeof getCodexEnvironment>)=>e.kind==='account'?(e.connection?.codexHome||((e.connection?.username===userInfo().username)?join(homedir(),'.codex'):'')):usageHome(e);
 for(const id of ids){
  const environment=getCodexEnvironment(id),home=homeFor(environment),group=balanceGroup(id),providerId=single?undefined:cachedEngineBalance(id).providerId;
  if(!single&&!providerId){partial=true;continue;}
  if(!single&&(!home||all.some(other=>{const otherHome=homeFor(other);return other.id!==id&&!!otherHome&&canonical(otherHome)===canonical(home)&&(!group||balanceGroup(other.id)!==group);}))){partial=true;continue;}
  const snapshot=cachedAccountUsage(id);
  const ready=db.prepare('SELECT ready FROM codex_usage_dedup_status WHERE account=?').get(id) as {ready:number}|undefined;
  if(!snapshot.initialized||!ready?.ready||snapshot.timezone!==timezone){partial=true;continue;}if(snapshot.partial)partial=true;if(snapshot.checked_at)checked.push(snapshot.checked_at);
  const rows=db.prepare(`SELECT event_key,day,hour,cwd,model,tier,provider,tokens FROM codex_usage_dedup_events WHERE account=? LIMIT ${USAGE_EVENT_LIMIT+1}`).all(id) as Array<{event_key:string;day:string;hour:string|null;cwd:string;model:string|null;tier:string|null;provider:string|null;tokens:string}>;
  if(rows.length>USAGE_EVENT_LIMIT){partial=true;continue;}
  for(const {event_key,...raw} of rows){
   if(!single&&!raw.provider){partial=true;continue;}if(!single&&raw.provider!==providerId)continue;
   if(++processed>USAGE_EVENT_LIMIT)return {partial:true,error:'统计记录过多，无法安全合并',rows:[]};
   const parsed=JSON.parse(raw.tokens),legacyKey=typeof parsed._legacy_key==='string'?parsed._legacy_key:null;
   const event={...raw,tokens:JSON.stringify(Object.fromEntries(tokenFields.map(k=>[k,parsed[k]??null])))};
   const unassigned=(parsed._timezone??'UTC')!==timezone;
   if(legacyKey){if(!aliases.has(legacyKey))aliases.set(legacyKey,event_key);else if(aliases.get(legacyKey)!==event_key)aliases.set(legacyKey,null);}
   if(unassigned||!legacyKey)legacy.push({key:event_key,event,unassigned});else merge(event_key,event);
  }
 }
 // Old caches used timestamp-based identities. Bridge only unambiguous aliases;
 // two verified native turns remain separate even at identical timestamps.
 for(const {key,event,unassigned} of legacy){
  const alias=aliases.get(key);if(alias===null){partial=true;continue;}const resolved=alias??key;
  if(!unassigned){merge(resolved,event);continue;}
  const recovered=events.get(resolved);
  if(recovered&&JSON.stringify({...recovered,day:'',hour:null})===JSON.stringify({...event,day:'',hour:null}))continue;
  partial=true;if(!unassignedEvents.has(resolved))unassignedEvents.set(resolved,event);else if(JSON.stringify(unassignedEvents.get(resolved))!==JSON.stringify(event))unassignedEvents.set(resolved,null);
 }
 const retained={tokens:Object.fromEntries(tokenFields.map(k=>[k,0])) as Record<string,number|null>,requests:0,estimated_credits:null as number|null};
 for(const event of unassignedEvents.values())if(event){const counters=JSON.parse(event.tokens);retained.requests++;for(const k of tokenFields)retained.tokens[k]=retained.tokens[k]===null||counters[k]===null?null:retained.tokens[k]!+counters[k];const amount=estimateUsageCredits(event.model,event.tier,counters);if(amount!==null)retained.estimated_credits=(retained.estimated_credits??0)+amount;}
 const grouped=new Map<string,{date:string;hour?:string|null;cwd:string;tokens:Record<string,number|null>;requests:number;models:Map<string,{model:string|null;tokens:Record<string,number|null>;estimated_credits:number|null;credit_coverage:{covered:number;total:number}}>}>();
 for(const event of events.values()){
  if(!event)continue;const hour=granularity==='hour'?event.hour:null;if(granularity==='hour'&&!hour)partial=true;const key=JSON.stringify([event.day,hour,event.cwd]);let row=grouped.get(key);
  if(!row){row={date:event.day,...granularity==='hour'?{hour}:{},cwd:event.cwd,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),requests:0,models:new Map()};grouped.set(key,row);}
  const tokens=JSON.parse(event.tokens);row.requests++;
  const modelKey=JSON.stringify(event.model);let model=row.models.get(modelKey);
  if(!model){model={model:event.model,tokens:Object.fromEntries(tokenFields.map(k=>[k,0])),estimated_credits:null,credit_coverage:{covered:0,total:0}};row.models.set(modelKey,model);}
  model.credit_coverage.total++;const estimate=estimateUsageCredits(event.model,event.tier,tokens);if(estimate!==null){model.estimated_credits=(model.estimated_credits??0)+estimate;model.credit_coverage.covered++;}
  for(const field of tokenFields){row.tokens[field]=row.tokens[field]===null||tokens[field]===null?null:row.tokens[field]!+tokens[field];model.tokens[field]=model.tokens[field]===null||tokens[field]===null?null:model.tokens[field]!+tokens[field];}
 }
 if(grouped.size>5000)partial=true;
 if(single&&granularity==='hour'){
  const daily=cachedAccountUsage(ids[0]);
  const knownDaily=daily.rows.reduce((sum,row)=>sum+(row.tokens.total_tokens??0),0);
  const knownHourly=[...grouped.values()].reduce((sum,row)=>sum+(row.tokens.total_tokens??0),0);
  if(knownDaily!==knownHourly||daily.rows.some(row=>row.tokens.total_tokens==null))partial=true;
 }
 const allocation=single?allocatedQuota(ids[0]):new Map<string,number>();
 const projects=db.prepare('SELECT name,path FROM projects').all() as {name:string;path:string}[];
 return {initialized:checked.length>0,checked_at:checked.sort()[0]??null,timezone,unassigned:single?unassignedUsage(ids[0]):retained.requests?retained:null,credit_rate_date:CREDIT_RATE_DATE,partial,error:partial?(granularity==='hour'?'小时统计尚未完整：部分历史记录不可读取或时间未知；按日统计不受影响。':'部分环境尚未完成采集或存在无法去重的记录'):null,rows:[...grouped.values()].sort((a,b)=>b.date.localeCompare(a.date)||(b.hour||'').localeCompare(a.hour||'')).slice(0,5000).map(({models,...row})=>{const entries=[...models.values()].map(model=>({...model,actual_quota:quotaByModel(allocation,row.date,row.cwd,model.model,row.hour)})),known=entries.filter(m=>m.estimated_credits!==null),match=projects.filter(p=>row.cwd===p.path||row.cwd.startsWith(p.path.replace(/\/$/,'')+'/')).sort((a,b)=>b.path.length-a.path.length)[0];return {...row,project_name:match?.name??(row.cwd.split('/').filter(Boolean).pop()||'未归属'),models:entries,estimated_credits:known.length?known.reduce((s,m)=>s+m.estimated_credits!,0):null,credit_coverage:{covered:entries.reduce((s,m)=>s+m.credit_coverage.covered,0),total:entries.reduce((s,m)=>s+m.credit_coverage.total,0)}};})};
}
/** Re-read with the current rule version, replacing only a proven superset of
 * the existing cache. A failed check retains all old data and retries later. */
export async function refreshUsageRules(id:string):Promise<void>{
 const db=getDb();
 const current=db.prepare('SELECT version,state,retry_at FROM codex_usage_rule_versions WHERE account=?').get(id) as {version:number;state:string;retry_at:string|null}|undefined;
 if(current?.version===USAGE_RULE_VERSION&&(current.state==='ready'||current.state==='blocked'&&current.retry_at&&Date.parse(current.retry_at)>Date.now()))return;
 db.prepare("INSERT OR REPLACE INTO codex_usage_rule_versions VALUES(?,?,'pending',NULL)").run(id,USAGE_RULE_VERSION);
 try{await collectAccountUsage(id,{rebuild:true,preserveExisting:true});}
 catch{db.prepare("INSERT OR REPLACE INTO codex_usage_rule_versions VALUES(?,?,'blocked',?)").run(id,USAGE_RULE_VERSION,new Date(Date.now()+86400000).toISOString());}
}
export function startAccountUsage(){initAccountUsage();stopped=false;const tick=async()=>{try{const environments=allCodexEnvironments();for(const e of environments){if(stopped)break;if(e.enabled){await collectAccountUsage(e.id);await refreshUsageRules(e.id);}}for(const e of environments){if(stopped)break;if(e.enabled)await backfillUsageHours(e.id);}}catch{/* Configuration may be changing; retry on the next scheduled pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),300000);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopAccountUsage(){stopped=true;clearTimeout(timer);for(const controller of controllers.values())controller.abort();await Promise.allSettled([...pending.values(),...hourlyPending.values()]);}
