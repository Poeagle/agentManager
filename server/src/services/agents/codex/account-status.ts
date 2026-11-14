import {getDb} from '../../../db/index.js';
import {getCodexEnvironment,engineForEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
import {codexWeeklyQuotaFromResponse} from './quota.js';

const pending=new Map<string,Promise<void>>();
const identity=(id:string)=>{const e=getCodexEnvironment(id);return JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:['native',localHome(e)]);};
export function initAccountStatus(){getDb().exec(`CREATE TABLE IF NOT EXISTS codex_account_status(account TEXT PRIMARY KEY,identity TEXT NOT NULL,data TEXT,checked_at TEXT,error TEXT); CREATE TABLE IF NOT EXISTS codex_quota_samples(account TEXT NOT NULL,identity TEXT NOT NULL,email TEXT NOT NULL,checked_at TEXT NOT NULL,reset_at REAL NOT NULL,used REAL NOT NULL,PRIMARY KEY(account,checked_at)); CREATE INDEX IF NOT EXISTS codex_quota_samples_account ON codex_quota_samples(account,identity,checked_at);`);}
/** Only the scheduler contacts account APIs. Both HTTP views read this snapshot. */
export async function collectAccountStatus(id:string,collectionStartedAt=new Date().toISOString()):Promise<void>{
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const e=getCodexEnvironment(id);if(!e.enabled||e.kind==='provider')return;
  const source=identity(id),db=getDb();
  try{
   const data=await runInCodexEngine(await engineForEnvironment(id),()=>withCodexConnection(async request=>{
    const auth=await request('account/read',{});
    if(!auth.account||auth.account.type==='apiKey')return {account:{email:null,plan:null},windows:[],resets:null,quota:null,reason:'not_applicable'};
    const limits=await request('account/rateLimits/read',{}),raw=limits.rateLimitResetCredits,snapshot=limits.rateLimitsByLimitId?.codex??limits.rateLimits;
    let quota=null;try{quota=codexWeeklyQuotaFromResponse(limits);}catch{/* Reset cards may be available without a weekly window. */}
    const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
    return {account:{email:typeof auth.account.email==='string'?auth.account.email:null,plan:typeof auth.account.planType==='string'?auth.account.planType:typeof snapshot?.planType==='string'?snapshot.planType:null},quota,windows:[snapshot?.primary,snapshot?.secondary].filter(w=>w&&Number.isFinite(w.usedPercent)).map(w=>({usedPercent:w.usedPercent,windowDurationMins:finite(w.windowDurationMins),resetsAt:finite(w.resetsAt)})),resets:raw&&Number.isInteger(raw.availableCount)&&raw.availableCount>=0?{availableCount:raw.availableCount,credits:Array.isArray(raw.credits)?raw.credits.slice(0,100).map((c:any)=>({expiresAt:finite(c.expiresAt),grantedAt:finite(c.grantedAt),status:typeof c.status==='string'?c.status:null})):null}:null};
   }));
   if(identity(id)!==source||!getCodexEnvironment(id).enabled)return;
   const checkedAt=new Date().toISOString();
   if(data.quota)data.quota.checkedAt=checkedAt;
   db.transaction(()=>{
    db.prepare('INSERT OR REPLACE INTO codex_account_status VALUES(?,?,?,?,NULL)').run(id,source,JSON.stringify({...data,collection_started_at:collectionStartedAt}),checkedAt);
    const weekly=data.windows.find(w=>w.windowDurationMins===10080);
    if(data.account.email&&weekly&&weekly.resetsAt!=null&&weekly.resetsAt*1000>Date.parse(checkedAt)&&weekly.usedPercent>=0&&weekly.usedPercent<=100)
     db.prepare('INSERT OR IGNORE INTO codex_quota_samples VALUES(?,?,?,?,?,?)').run(id,source,data.account.email,checkedAt,weekly.resetsAt,weekly.usedPercent);
    db.prepare('DELETE FROM codex_quota_samples WHERE checked_at < ?').run(new Date(Date.parse(checkedAt)-90*86400000).toISOString());
   })();
  }catch{
   db.prepare("INSERT INTO codex_account_status(account,identity,error) VALUES(?,?,'账号状态采集失败，保留上次成功数据') ON CONFLICT(account) DO UPDATE SET data=CASE WHEN identity=excluded.identity THEN data ELSE NULL END,checked_at=CASE WHEN identity=excluded.identity THEN checked_at ELSE NULL END,identity=excluded.identity,error=excluded.error").run(id,source);
  }
 })();pending.set(id,task);try{await task;}finally{pending.delete(id);}
}
export function cachedAccountStatus(id:string){
 const row=getDb().prepare('SELECT data,checked_at,error FROM codex_account_status WHERE account=? AND identity=?').get(id,identity(id)) as {data:string|null;checked_at:string|null;error:string|null}|undefined;
 const data=row?.data?JSON.parse(row.data):{account:{email:null,plan:null},windows:[],resets:null,quota:null};
 const stale=!!row?.error||!!row?.checked_at&&Date.now()-Date.parse(row.checked_at)>600000;
 return {...data,quota:data.quota?{...data.quota,...stale?{stale:true}:{}}:null,checked_at:row?.checked_at??null,error:row?.error??null,stale,pending:!row?.data};
}
export function quotaSamples(id:string){
 const db=getDb();
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_quota_samples'").get())return [];
 return db.prepare('SELECT checked_at,reset_at,used,email FROM codex_quota_samples WHERE account=? AND identity=? ORDER BY checked_at').all(id,identity(id)) as Array<{checked_at:string;reset_at:number;used:number;email:string}>;
}
export async function stopAccountStatus(){await Promise.allSettled([...pending.values()]);}
