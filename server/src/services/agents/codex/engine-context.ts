import {AsyncLocalStorage} from 'async_hooks';
import {open} from 'fs/promises';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {findCodexRollout} from '../../prompt-context.js';
import {config} from '../../../config.js';
import {managedCodexEngines} from './provider-config.js';

export interface CodexEngine {socket:string;provider?:string;models?:string[]}
const scope=new AsyncLocalStorage<CodexEngine>();
const threads=new Map<string,CodexEngine>();
let defaultProvider:{socket:string;provider:string}|undefined;
let configured:{raw:string;engines:CodexEngine[]}|undefined;
const persistedRoutes = new Map<string,string>();
let persistedRoutesLoaded = false;
const threadKey=(id:string)=>JSON.stringify([process.env.CODEX_HOME,process.env.AGENTMANAGER_CODEX_STREAM_SOCKET,id]);
const routeFile=()=>join(dirname(config.dbPath),'codex-thread-routes.json');
function loadPersistedRoutes():void {
 if(persistedRoutesLoaded||process.env.NODE_ENV!=='production')return;
 persistedRoutesLoaded=true;
 try {
  const parsed=JSON.parse(readFileSync(routeFile(),'utf8')) as Record<string,unknown>;
  for(const [threadId,provider] of Object.entries(parsed))if(typeof provider==='string'&&provider.length<=100)persistedRoutes.set(threadId,provider);
 } catch {/* Rollout metadata remains the fallback when the route journal is absent. */}
}
function persistRoute(threadId:string,provider:string):void {
 if(process.env.NODE_ENV!=='production')return;
 loadPersistedRoutes();persistedRoutes.set(threadId,provider);
 while(persistedRoutes.size>2048)persistedRoutes.delete(persistedRoutes.keys().next().value!);
 try {
  const path=routeFile(),tmp=`${path}.new`;
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(tmp,JSON.stringify(Object.fromEntries(persistedRoutes)),'utf8');
  renameSync(tmp,path);
 } catch {/* In-memory routing remains available until the next restart. */}
}
export function defaultCodexEngine():CodexEngine {
 return configuredCodexEngines().find(e=>e.socket===process.env.AGENTMANAGER_CODEX_STREAM_SOCKET) ?? {socket:process.env.AGENTMANAGER_CODEX_STREAM_SOCKET||'',
  ...(defaultProvider&&defaultProvider.socket===process.env.AGENTMANAGER_CODEX_STREAM_SOCKET?{provider:defaultProvider.provider}:{})};
}
export function currentCodexEngine():CodexEngine {
 const current=scope.getStore();
 return current?{...current,...!current.provider&&defaultProvider?.socket===current.socket?{provider:defaultProvider.provider}:{}}:defaultCodexEngine();
}
/** Explicit engine routes, never guess a credential/provider from a model name
 * or description. Each engine must be started with its provider override. */
export function configuredCodexEngines():CodexEngine[] {
 const raw=process.env.AGENTMANAGER_CODEX_PROVIDER_ENGINES;
 const managed=managedCodexEngines();
 if(!raw)return managed;
 if(configured?.raw===raw)return [...managed,...configured.engines.filter(item=>!managed.some(existing=>existing.provider===item.provider))];
 let value:unknown;try{value=JSON.parse(raw);}catch{throw Error('CODEX_PROVIDER_ENGINES 必须是 JSON 数组');}
 if(!Array.isArray(value)||value.length>16)throw Error('CODEX_PROVIDER_ENGINES 配置无效');
 const seen=new Set<string>();
 const engines:CodexEngine[]=value.map(item=>{
  if(!item||typeof item.provider!=='string'||!/^[-\w.]{1,100}$/.test(item.provider)||typeof item.socket!=='string'||!item.socket.startsWith('/')||seen.has(item.provider)||!Array.isArray(item.models)||!item.models.length||item.models.some((m:unknown)=>typeof m!=='string'||m.length>200))throw Error('每个 provider 必须指定独立 socket 和明确的 models 列表');
  seen.add(item.provider);return {provider:item.provider,socket:item.socket,models:item.models};
 });
 configured={raw,engines};
 // Stored Providers are owned by AgentManager. Environment routes remain
 // supported for externally provisioned Agents, but cannot override a managed
 // Provider and send requests back to its legacy launchd socket.
 return [...managed,...engines.filter(item=>!managed.some(existing=>existing.provider===item.provider))];
}
export function rememberCodexProvider(provider:unknown):void {
 const engine=currentCodexEngine();
 if(typeof provider==='string'&&provider&&!scope.getStore()?.provider)defaultProvider={socket:engine.socket,provider};
}
export function rememberCodexThread(thread:any):void {
 if(typeof thread?.id!=='string')return;
 const engine=currentCodexEngine();
 const provider=typeof thread.modelProvider==='string'?thread.modelProvider:engine.provider;
 const route=configuredCodexEngines().find(item=>item.provider===provider);
 threads.set(threadKey(thread.id),route??{...engine,provider});
 if(typeof provider==='string'&&provider)persistRoute(thread.id,provider);
 while(threads.size>1024)threads.delete(threads.keys().next().value!);
}
export function runInCodexEngine<T>(engine:CodexEngine,action:()=>T):T{return scope.run(engine,action);}
export function engineForProvider(provider?:string):CodexEngine {
 const current=currentCodexEngine();
 if(!provider||provider===current.provider)return current;
 const route=configuredCodexEngines().find(item=>item.provider===provider);
 if(!route)throw Error(`模型服务 ${provider} 尚未接入独立引擎；请配置 provider engine，原会话已保留`);
 return route;
}
export async function engineForThread(threadId:string):Promise<CodexEngine> {
 const saved=threads.get(threadKey(threadId));if(saved)return {...saved,...configuredCodexEngines().find(e=>e.provider===saved.provider)};
 loadPersistedRoutes();
 const persisted=persistedRoutes.get(threadId);
 if(persisted){
  const route=configuredCodexEngines().find(item=>item.provider===persisted);
  if(route){threads.set(threadKey(threadId),route);return route;}
 }
 // Only needed after restart and only when alternate engines are configured.
 const routes=configuredCodexEngines();
 if(!routes.length)return currentCodexEngine();
 const file=await findCodexRollout(threadId);
 // Provider-specific CODEX_HOME directories are intentionally not assumed by
 // the main server. If the rollout is not visible there, ask each configured
 // engine which one owns the thread; this repairs cold starts after restart.
 if(!file){
  for(const route of routes){
   try {
    const result=await runInCodexEngine(route,async()=>{
     const {withCodexConnection}=await import('./stream.js');
     return withCodexConnection(request=>request('thread/read',{threadId}));
    });
    if(result?.thread?.id===threadId){
     threads.set(threadKey(threadId),route);
     if(route.provider)persistRoute(threadId,route.provider);
     return route;
    }
   } catch {/* Try the next configured provider engine. */}
  }
  return currentCodexEngine();
 }
 const handle=await open(file,'r');
 try {
  const buffer=Buffer.alloc(64*1024),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
  const first=buffer.subarray(0,bytesRead).toString('utf8').split('\n')[0];
  const entry=JSON.parse(first),provider=entry.type==='session_meta'?entry.payload?.model_provider:undefined;
  const route=configuredCodexEngines().find(item=>item.provider===provider);
  if(route){threads.set(threadKey(threadId),route);return route;}
 }catch{/* Ordinary controls will provide an actionable native mismatch error. */}finally{await handle.close();}
 return currentCodexEngine();
}
export async function inCodexThread<T>(threadId:string,action:()=>T):Promise<Awaited<T>> {
 return await runInCodexEngine(await engineForThread(threadId),action);
}
