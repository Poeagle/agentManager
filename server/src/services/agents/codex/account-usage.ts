import {getDb} from '../../../db/index.js';
import {allCodexEnvironments,environmentConnection,getCodexEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {USAGE_SCAN} from './usage-scanner.js';
import {tokenFields} from '../../conversation-usage.js';
let timer:ReturnType<typeof setTimeout>|undefined;
let stopped=true;
const pending=new Map<string,Promise<void>>();
export function initAccountUsage(){getDb().exec(`
 CREATE TABLE IF NOT EXISTS codex_usage_cursors(account TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(account,path));
 CREATE TABLE IF NOT EXISTS codex_usage_events(account TEXT NOT NULL,event_key TEXT NOT NULL,day TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,tier TEXT,tokens TEXT NOT NULL,PRIMARY KEY(account,event_key));
 CREATE INDEX IF NOT EXISTS codex_usage_days ON codex_usage_events(account,day);
 CREATE TABLE IF NOT EXISTS codex_usage_status(account TEXT PRIMARY KEY,checked_at TEXT,error TEXT,partial INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS codex_usage_sources(account TEXT PRIMARY KEY,identity TEXT NOT NULL);
`);}
export async function collectAccountUsage(id:string):Promise<void>{
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const db=getDb(),e=getCodexEnvironment(id);if(!e.enabled||e.kind==='provider')return;
  const identity=JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:['native',localHome(e)]);
  const source=db.prepare('SELECT identity FROM codex_usage_sources WHERE account=?').get(id) as {identity:string}|undefined;
  if(source?.identity!==identity)db.transaction(()=>{
   for(const table of ['codex_usage_cursors','codex_usage_events','codex_usage_status'])db.prepare(`DELETE FROM ${table} WHERE account=?`).run(id);
   db.prepare('INSERT OR REPLACE INTO codex_usage_sources VALUES(?,?)').run(id,identity);
  })();
  const cursors=Object.fromEntries((db.prepare('SELECT path,state FROM codex_usage_cursors WHERE account=?').all(id) as {path:string;state:string}[]).map(row=>[row.path,JSON.parse(row.state)]));
  try{
   const home=e.kind==='account'?e.connection?.codexHome:localHome(e);
   const input=JSON.stringify({home,cursors});
   const result=JSON.parse(await (e.kind==='account'?accountCommandInput(environmentConnection(e),USAGE_SCAN,input):localCommandInput(USAGE_SCAN,input)));
   if(!Array.isArray(result.events)||!Array.isArray(result.changes))throw Error('Invalid usage response');
   db.transaction(()=>{
    const insert=db.prepare('INSERT OR IGNORE INTO codex_usage_events VALUES(?,?,?,?,?,?,?)');
    for(const event of result.events){const time=Date.parse(event.timestamp);if(!Number.isFinite(time))continue;insert.run(id,event.key,new Date(time).toISOString().slice(0,10),event.cwd||'',event.model||null,event.tier||null,JSON.stringify(event.tokens));}
    const cursor=db.prepare('INSERT OR REPLACE INTO codex_usage_cursors VALUES(?,?,?)');
    for(const [path,state] of result.changes)cursor.run(id,path,JSON.stringify(state));
    db.prepare('INSERT OR REPLACE INTO codex_usage_status VALUES(?,?,?,?)').run(id,new Date().toISOString(),result.errors?'部分记录不可读取或缺少统计字段':null,result.partial||result.errors?1:0);
   })();
  }catch{db.prepare(`INSERT INTO codex_usage_status(account,error,partial) VALUES(?,'采集失败，保留上次成功数据',1) ON CONFLICT(account) DO UPDATE SET error=excluded.error,partial=1`).run(id);}
 })();pending.set(id,task);try{await task;}finally{pending.delete(id);}
}
export function cachedAccountUsage(id:string){
 const db=getDb();const status=db.prepare('SELECT checked_at,error,partial FROM codex_usage_status WHERE account=?').get(id) as {checked_at:string|null;error:string|null;partial:number}|undefined;
 const sums=tokenFields.map(k=>`CASE WHEN COUNT(json_extract(tokens,'$.${k}'))=COUNT(*) THEN SUM(json_extract(tokens,'$.${k}')) ELSE NULL END AS ${k}`).join(',');
 const rows=db.prepare(`SELECT day,cwd,${sums} FROM codex_usage_events WHERE account=? GROUP BY day,cwd ORDER BY day DESC,cwd LIMIT 5001`).all(id) as Array<Record<string,any>>;
 return {checked_at:status?.checked_at??null,error:status?.error??null,partial:status?.partial!==0||rows.length>5000,timezone:'UTC',rows:rows.slice(0,5000).map(row=>({date:row.day,cwd:row.cwd,tokens:Object.fromEntries(tokenFields.map(k=>[k,row[k]]))}))};
}
export function startAccountUsage(){initAccountUsage();stopped=false;const tick=async()=>{try{for(const e of allCodexEnvironments()){if(stopped)break;if(e.enabled&&e.kind!=='provider')await collectAccountUsage(e.id).catch(()=>{});}}catch{/* Configuration may be changing; retry on the next scheduled pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),300000);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopAccountUsage(){stopped=true;clearTimeout(timer);await Promise.allSettled([...pending.values()]);}
