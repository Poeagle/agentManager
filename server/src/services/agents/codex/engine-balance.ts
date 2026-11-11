import {createHash} from 'crypto';
import {statSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';
import {getDb} from '../../../db/index.js';
import {readAgentManagement} from '../management-store.js';
import {allCodexEnvironments,environmentConnection,engineForEnvironment,getCodexEnvironment} from './environments.js';
import {accountCommandInput,localCommandInput} from './account-transport.js';
import {runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
import {providerApiKey} from './management.js';
import {readWallet,type BalanceFailure} from './balance-protocol.js';

type AuthMode='account'|'api';
type Cached={auth_mode:AuthMode|null;providerId?:string;groupKey?:string;origin?:string;status:'available'|'unavailable'|'unsupported'|'stale';amount?:number;currency?:string;mode?:string|null;todayActualCost?:number|null;todayRequests?:number|null;totalActualCost?:number|null;checkedAt?:string|null;error?:BalanceFailure|'auth_unknown'};
const pending=new Map<string,Promise<void>>();
let timer:ReturnType<typeof setTimeout>|undefined,stopped=true;
function sourceIdentity(id:string):string {
 const e=getCodexEnvironment(id);
 const p=e.kind==='provider'?readAgentManagement('codex').providers.find(p=>p.id===e.provider):undefined;
 const sealed=e.provider?(getDb().prepare('SELECT value FROM settings WHERE key=?').get(`agent_management_codex_provider_secret:${e.provider}`) as {value:string}|undefined)?.value:'';
 const env=typeof p?.fields.envKey==='string'?process.env[p.fields.envKey]||'':'';
 const home=process.env.CODEX_HOME||join(homedir(),'.codex');
 const files=e.kind==='native'?['config.toml','auth.json'].map(file=>{try{const stat=statSync(join(home,file));return [stat.mtimeMs,stat.size];}catch{return null;}}):null;
 return createHash('sha256').update(JSON.stringify([e.kind,e.connection,p?.fields,sealed,env,home,files])).digest('hex');
}
export function initEngineBalance(){getDb().exec('CREATE TABLE IF NOT EXISTS codex_engine_balance (id TEXT PRIMARY KEY, identity TEXT NOT NULL, data TEXT NOT NULL)');}
const script=`import json,os,pathlib,sys
try:
 p=json.load(sys.stdin); home=pathlib.Path(p['home']) if p.get('home') else pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home()/'.codex')
 config={}
 if not p.get('runtime_provider'):
  try:
   import tomllib
   config=tomllib.loads((home/'config.toml').read_text())
  except Exception:pass
 provider=config.get('model_providers',{}).get(config.get('model_provider',''),{})
 try:auth=json.loads((home/'auth.json').read_text()) if (home/'auth.json').exists() else {}
 except Exception:auth={}
 envkey=p.get('envkey') or provider.get('env_key','')
 print(json.dumps({'base':provider.get('base_url',''),'provider':config.get('model_provider',''),'key':os.environ.get(envkey,'') or auth.get('OPENAI_API_KEY',''),'envkey':envkey}))
except Exception: print('{}')`;
async function apiConfig(id:string,runtime?:{providerId:string;base:string;envkey:string}):Promise<{base:string;key:string;providerId:string}>{
 const e=getCodexEnvironment(id);
 if(e.kind==='provider'){
  const p=readAgentManagement('codex').providers.find(p=>p.id===e.provider);
  const env=typeof p?.fields.envKey==='string'?p.fields.envKey:'';
  return {base:typeof p?.fields.baseUrl==='string'?p.fields.baseUrl:'',providerId:e.provider||'',key:providerApiKey(e.provider!)||(env?process.env[env]||'':'')};
 }
 const home=e.connection?.codexHome||'';
 const input=JSON.stringify({home,runtime_provider:runtime?.providerId||'',envkey:runtime?.envkey||''});
 const raw=e.kind==='account'?await accountCommandInput(environmentConnection(e),script,input):await localCommandInput(script,input);
 const result=JSON.parse(raw) as {base?:unknown;key?:unknown;envkey?:unknown;provider?:unknown};
 const env=e.kind==='native'&&typeof result.envkey==='string'?process.env[result.envkey]||'':'';
 return {base:runtime?.base||(typeof result.base==='string'?result.base:''),providerId:runtime?.providerId||(typeof result.provider==='string'?result.provider:''),key:env||(typeof result.key==='string'?result.key:'')};
}
export async function collectEngineBalance(id:string):Promise<void>{
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const e=getCodexEnvironment(id);if(!e.enabled)return;const sourceKey=sourceIdentity(id);
  let auth:AuthMode|null=null,runtimeProviderId:string|null=null,runtimeConfig:{providerId:string;base:string;envkey:string}|undefined;
  try{
   const {result,config}=await runInCodexEngine(await engineForEnvironment(id),()=>withCodexConnection(async request=>({result:await request('account/read',{}),config:await request('config/read',{}).catch(()=>null)})));
   const settings=config?.config as Record<string,any>|undefined,provider=settings?.model_providers?.[settings?.model_provider];
   if(typeof settings?.model_provider==='string'&&settings.model_provider)runtimeProviderId=settings.model_provider;
   if(runtimeProviderId&&provider)runtimeConfig={providerId:runtimeProviderId,base:typeof provider.base_url==='string'?provider.base_url:'',envkey:typeof provider.env_key==='string'?provider.env_key:''};
   if(provider&&(typeof provider.env_key==='string'&&provider.env_key||provider.requires_openai_auth===false)||result.account?.type==='apiKey'||!result.account&&result.requiresOpenaiAuth===false)auth='api';
   else if(result.account?.type==='chatgpt'||result.account?.type==='chatgptAuthTokens')auth='account';
  }catch{/* Keep unknown separate from both authentication modes. */}
  if(auth!=='api'){
   const current=cachedEngineBalance(id);
   if(sourceIdentity(id)!==sourceKey)return;
   if(auth==='account')getDb().prepare('INSERT OR REPLACE INTO codex_engine_balance VALUES(?,?,?)').run(id,sourceKey,JSON.stringify({auth_mode:'account',status:'unsupported'}));
   else getDb().prepare('INSERT OR REPLACE INTO codex_engine_balance VALUES(?,?,?)').run(id,sourceKey,JSON.stringify(current.auth_mode?{...current,status:current.amount!==undefined?'stale':'unavailable',error:'auth_unknown'}:{auth_mode:null,status:'unavailable',error:'auth_unknown'}));
   return;
  }
  let cfg:{base:string;key:string;providerId:string};try{cfg=await apiConfig(id,runtimeConfig);}catch{cfg={base:runtimeConfig?.base||'',key:'',providerId:runtimeConfig?.providerId||''};}
  if(runtimeProviderId&&cfg.providerId&&runtimeProviderId!==cfg.providerId)cfg={base:'',key:'',providerId:runtimeProviderId};
  const identity=sourceKey;
  const row=getDb().prepare('SELECT identity,data FROM codex_engine_balance WHERE id=?').get(id) as {identity:string;data:string}|undefined;
  const previous:Cached|undefined=row?.identity===identity?JSON.parse(row.data):undefined;
  const result=await readWallet(cfg.base,cfg.key);
  let groupKey:string|undefined,origin:string|undefined;
  try{const url=new URL(cfg.base);origin=url.origin;const path=url.pathname.replace(/\/+$/,'').replace(/\/v1$/,'');groupKey=createHash('sha256').update(origin+path).digest('hex');}catch{/* No valid upstream URL. */}
  let next:Cached;
  if(result.status==='available')next={auth_mode:'api',providerId:cfg.providerId,groupKey,origin,...result,checkedAt:new Date().toISOString()};
  else if(previous?.amount!==undefined)next={...previous,status:'stale',error:result.error};
  else next={auth_mode:'api',providerId:cfg.providerId,groupKey,origin,...result};
  if(getCodexEnvironment(id).enabled&&sourceIdentity(id)===sourceKey)getDb().prepare('INSERT OR REPLACE INTO codex_engine_balance VALUES(?,?,?)').run(id,identity,JSON.stringify(next));
 })();pending.set(id,task);try{await task;}finally{pending.delete(id);}
}
export function cachedEngineBalance(id:string):Cached{
 const row=getDb().prepare('SELECT data FROM codex_engine_balance WHERE id=? AND identity=?').get(id,sourceIdentity(id)) as {data:string}|undefined;
 if(!row)return {auth_mode:null,status:'unavailable',error:'auth_unknown'};
 const data:Cached=JSON.parse(row.data);
 if(data.status==='available'&&data.checkedAt&&Date.now()-Date.parse(data.checkedAt)>600000)return {...data,status:'stale'};
 return data;
}
export function startEngineBalance(){initEngineBalance();stopped=false;const configured=Number(process.env.AGENTMANAGER_CODEX_BALANCE_INTERVAL_MS);const interval=Number.isSafeInteger(configured)&&configured>=60000&&configured<=86400000?configured:300000;const tick=async()=>{try{for(const e of allCodexEnvironments()){if(stopped)break;if(e.enabled)await collectEngineBalance(e.id).catch(()=>{});}}catch{/* Retry on the next pass. */}finally{if(!stopped){timer=setTimeout(()=>void tick(),interval);timer.unref();}}};timer=setTimeout(()=>void tick(),1000);timer.unref();}
export async function stopEngineBalance(){stopped=true;clearTimeout(timer);await Promise.allSettled([...pending.values()]);}
