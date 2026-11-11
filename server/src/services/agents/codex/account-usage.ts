import {getDb} from '../../../db/index.js';
import {allCodexEnvironments,environmentConnection,getCodexEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {USAGE_SCAN} from './usage-scanner.js';
import {tokenFields} from '../../conversation-usage.js';
import {CREDIT_RATE_DATE,estimateUsageCredits} from './usage-credits.js';
let timer:ReturnType<typeof setTimeout>|undefined;
let stopped=true;
const pending=new Map<string,Promise<void>>();
const controllers=new Map<string,AbortController>();
const usageIdentity=(e:ReturnType<typeof getCodexEnvironment>)=>JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:['native',localHome(e)]);
export function initAccountUsage(){getDb().exec(`
 DROP TABLE IF EXISTS codex_usage_cursors;
 CREATE TABLE IF NOT EXISTS codex_usage_snapshots(account TEXT PRIMARY KEY,initialized INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE INDEX IF NOT EXISTS codex_usage_days ON codex_usage_events(account,day);
 CREATE TABLE IF NOT EXISTS codex_usage_status(account TEXT PRIMARY KEY,checked_at TEXT,error TEXT,partial INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS codex_usage_sources(account TEXT PRIMARY KEY,identity TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS codex_usage_progress(account TEXT PRIMARY KEY,data TEXT NOT NULL);
`);}
export async function collectAccountUsage(id:string):Promise<void>{
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const db=getDb(),e=getCodexEnvironment(id);if(!e.enabled||e.kind==='provider')return;
  const identity=usageIdentity(e);
  const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
  if(source?.identity!==identity)db.transaction(()=>{
   for(const table of ['codex_usage_snapshots','codex_usage_events','codex_usage_status','codex_usage_progress'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);
   db.prepare('INSERT OR REPLACE INTO codex_usage_sources VALUES(?,?)').run(id,identity);
  })();
  const initialized=!!db.prepare('SELECT initialized FROM codex_usage_snapshots WHERE account=? AND initialized=1').get(id);
  const mode=initialized?'daily':'full',day=new Date().toISOString().slice(0,10);
  const controller=new AbortController();controllers.set(id,controller);
  try{
   const home=e.kind==='account'?e.connection?.codexHome:localHome(e);
   const input=JSON.stringify({home,mode,day});
   const options={timeoutMs:mode==='full'?300000:120000,maxOutputBytes:32*1024*1024,signal:controller.signal};
   const result=JSON.parse(await (e.kind==='account'?accountCommandInput(environmentConnection(e),USAGE_SCAN,input,options):localCommandInput(USAGE_SCAN,input,options)));
   if(!Array.isArray(result.rows)||result.rows.length>50000||result.mode!==mode||result.day!==day)throw Error('Invalid usage response');
   for(const row of result.rows){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||mode==='daily'&&row.day!==day||typeof row.cwd!=='string'||row.cwd.length>4096||!Number.isSafeInteger(row.requests)||row.requests<1||!row.tokens||tokenFields.some(k=>row.tokens[k]!==null&&(!Number.isFinite(row.tokens[k])||row.tokens[k]<0)))throw Error('Invalid usage row');
   }
   const current=getCodexEnvironment(id);if(!current.enabled||usageIdentity(current)!==identity)return;
   db.transaction(()=>{
    // Publish one complete snapshot: historical days remain untouched on daily scans.
    if(mode==='full')db.prepare('DELETE FROM codex_usage_events WHERE account=?').run(id);
    else db.prepare('DELETE FROM codex_usage_events WHERE account=? AND day=?').run(id,day);
    const insert=db.prepare('INSERT INTO codex_usage_events VALUES(?,?,?,?,?,?,?)');
    for(const row of result.rows)insert.run(id,JSON.stringify([row.day,row.cwd,row.model,row.tier]),row.day,row.cwd,row.model||null,row.tier||null,JSON.stringify({...row.tokens,requests:row.requests}));
    db.prepare('INSERT OR REPLACE INTO codex_usage_snapshots VALUES(?,1)').run(id);
    db.prepare('INSERT OR REPLACE INTO codex_usage_status VALUES(?,?,?,?)').run(id,new Date().toISOString(),result.errors?'部分记录不可读取或缺少统计字段':null,result.partial||result.errors?1:0);
    if(result.progress)db.prepare('INSERT OR REPLACE INTO codex_usage_progress VALUES(?,?)').run(id,JSON.stringify(result.progress));
   })();
  }catch{db.prepare(`INSERT INTO codex_usage_status(account,error,partial) VALUES(?,'采集失败，保留上次成功数据',1) ON CONFLICT(account) DO UPDATE SET error=excluded.error,partial=1`).run(id);}
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
export function startAccountUsage(){initAccountUsage();stopped=false;const tick=async()=>{try{for(const e of allCodexEnvironments()){if(stopped)break;if(e.enabled&&e.kind!=='provider')await collectAccountUsage(e.id);}}catch{/* Configuration may be changing; retry on the next scheduled pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),300000);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopAccountUsage(){stopped=true;clearTimeout(timer);for(const controller of controllers.values())controller.abort();await Promise.allSettled([...pending.values()]);}
