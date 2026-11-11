import {getDb} from '../../../db/index.js';
import {allCodexEnvironments,getCodexEnvironment,engineForEnvironment} from './environments.js';
import {localHome} from './account-files.js';
import {runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
import {codexWeeklyQuotaFromResponse} from './quota.js';

let timer:ReturnType<typeof setTimeout>|undefined,stopped=true;
const pending=new Map<string,Promise<void>>();
const identity=(id:string)=>{const e=getCodexEnvironment(id);return JSON.stringify(e.kind==='account'?[e.connection?.username,e.connection?.codexHome]:['native',localHome(e)]);};
export function initAccountStatus(){getDb().exec('CREATE TABLE IF NOT EXISTS codex_account_status(account TEXT PRIMARY KEY,identity TEXT NOT NULL,data TEXT,checked_at TEXT,error TEXT)');}
/** Only the scheduler contacts account APIs. Both HTTP views read this snapshot. */
export async function collectAccountStatus(id:string):Promise<void>{
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
   db.prepare('INSERT OR REPLACE INTO codex_account_status VALUES(?,?,?,?,NULL)').run(id,source,JSON.stringify(data),new Date().toISOString());
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
export function startAccountStatus(){initAccountStatus();stopped=false;const tick=async()=>{try{for(const e of allCodexEnvironments()){if(stopped)break;if(e.enabled&&e.kind!=='provider')await collectAccountStatus(e.id);}}catch{/* Retry on the next scheduled pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),300000);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopAccountStatus(){stopped=true;clearTimeout(timer);await Promise.allSettled([...pending.values()]);}
