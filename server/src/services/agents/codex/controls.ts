import {rememberCodexSettings,codexSettings} from './settings-state.js';
import {currentCodexEngine,defaultCodexEngine,configuredCodexEngines,runInCodexEngine,rememberCodexProvider,engineForProvider} from './engine-context.js';
import type {ModelPreference} from '../types.js';
import {open} from 'fs/promises';

import {findCodexRollout} from '../../prompt-context.js';
import {withCodexConnection} from './stream.js';
import {installedCodexVersion} from './version.js';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {publicTokenCounters} from '../../conversation-usage.js';
const execute=promisify(execFile);

export interface ModelChoice {default_service_tier?:string|null;service_tiers?:Array<{id:string;name:string;description:string}>;provider?:string;model:string;name:string;description:string;efforts:Array<{value:string;description:string}>;defaultEffort:string}
export type {ModelPreference} from '../types.js';
const finite=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const tokens=publicTokenCounters;
function windows(value:any,camel=false) {return [value?.primary,value?.secondary].flatMap(window=>{
  const used=finite(camel?window?.usedPercent:window?.used_percent),minutes=finite(camel?window?.windowDurationMins:window?.window_minutes);
  return used===null||minutes===null?[]:[{used_percent:Math.min(100,used),minutes,resets_at:finite(camel?window?.resetsAt:window?.resets_at)}];
});}
interface Telemetry {model:string|null;effort:string|null;permission:string|null;approval:string|null;service_tier:string|null;usage:{total:ReturnType<typeof tokens>;last:ReturnType<typeof tokens>;window:number|null}|null;limits:ReturnType<typeof windows>;observed_at:string|null}
const empty=():Telemetry=>({model:null,effort:null,permission:null,approval:null,service_tier:null,usage:null,limits:[],observed_at:null});
const telemetryCache=new Map<string,{size:number;inode:number;mtime:number;partial:Buffer;data:Telemetry}>();
/** Only allowlisted public counters and settings are retained. No tool output,
 * credentials, prompts or reasoning text is sent to the browser. */
export async function readConversationTelemetry(threadId:string):Promise<Telemetry> {
  const path=await findCodexRollout(threadId);if(!path)return empty();
  const handle=await open(path,'r');
  try {
    const stat=await handle.stat(),saved=telemetryCache.get(path);
    if(saved&&saved.size===stat.size&&saved.inode===stat.ino&&saved.mtime===stat.mtimeMs)return saved.data;
    const resumed=!!saved&&saved.inode===stat.ino&&saved.size<stat.size;
    const data:Telemetry=resumed?{...saved.data}:empty();
    const start=resumed?Math.max(saved.size,stat.size-2*1024*1024):Math.max(0,stat.size-2*1024*1024);
    const buffer=Buffer.alloc(stat.size-start);await handle.read(buffer,0,buffer.length,start);
    const continued=resumed&&start===saved.size;
    const bytes=continued?Buffer.concat([saved.partial,buffer]):buffer;
    const first=continued||start===0?0:bytes.indexOf(10)+1;
    const end=bytes.lastIndexOf(10)+1;
    const partial=bytes.subarray(Math.max(first,end));
    const lines=end>first?bytes.subarray(first,end).toString('utf8').split('\n'):[];
    for(const line of lines) {
      if(line.length>256*1024||!/^\s*\{/.test(line))continue;
      const header=line.slice(0,400);if(!/"type"\s*:\s*"(?:turn_context|token_count)"/.test(header))continue;
      let record:any;try{record=JSON.parse(line);}catch{continue;}const p=record.payload;
      if(record.type==='turn_context'&&p) {
        data.model=typeof p.model==='string'?p.model:null;data.effort=typeof p.effort==='string'?p.effort:null;
        data.permission=typeof p.sandbox_policy?.type==='string'?p.sandbox_policy.type:null;
        data.approval=typeof p.approval_policy==='string'?p.approval_policy:null;
        data.service_tier=typeof p.service_tier==='string'?p.service_tier:null;
      } else if(record.type==='event_msg'&&p?.type==='token_count') {
        if(p.info){data.usage={total:tokens(p.info.total_token_usage),last:tokens(p.info.last_token_usage),window:finite(p.info.model_context_window)};if(typeof record.timestamp==='string')data.observed_at=record.timestamp;}
        if(p.rate_limits)data.limits=windows(p.rate_limits);
      }
    }
    telemetryCache.delete(path);telemetryCache.set(path,{size:stat.size,inode:stat.ino,mtime:stat.mtimeMs,partial:partial.length<=256*1024?Buffer.from(partial):Buffer.alloc(0),data});
    if(telemetryCache.size>64)telemetryCache.delete(telemetryCache.keys().next().value!);
    return data;
  }finally{await handle.close();}
}

const catalogs=new Map<string,{until:number;data:ModelChoice[]}>();
const loadingCatalogs=new Map<string,Promise<ModelChoice[]>>();
const catalogFailures=new Map<string,{until:number;error:unknown}>();
async function readEngineModels(force=false):Promise<ModelChoice[]> {
  const engine=currentCodexEngine(),key=JSON.stringify([engine.socket,engine.models]);
  const catalog=catalogs.get(key);if(!force&&catalog&&catalog.until>Date.now())return catalog.data;
  const loading=loadingCatalogs.get(key);if(loading)return loading;
  const failure=catalogFailures.get(key);if(!force&&failure&&failure.until>Date.now())throw failure.error;
  const promise=withCodexConnection(async request=>{
    const config=await request('config/read',{}).then(r=>r.config??{}).catch(()=>({}));
    rememberCodexProvider(config.model_provider);
    const provider=engine.provider??config.model_provider;
    if(engine.provider&&config.model_provider&&engine.provider!==config.model_provider)throw Error(`模型服务 ${engine.provider} 的引擎实际配置为 ${config.model_provider}，请修正独立引擎配置`);
    const data:ModelChoice[]=[];let cursor:string|undefined;
    for(let i=0;i<4;i++) {
      const response=await request('model/list',{includeHidden:false,limit:100,...cursor?{cursor}:{}});
      for(const item of response.data||[]) {
        if(engine.models&&!engine.models.includes(item.model))continue;
        if(item.hidden||typeof item.model!=='string'||typeof item.displayName!=='string'||!Array.isArray(item.supportedReasoningEfforts))continue;
        const efforts=item.supportedReasoningEfforts.filter((e:any)=>typeof e.reasoningEffort==='string').map((e:any)=>({value:e.reasoningEffort,description:typeof e.description==='string'?e.description:''}));
        if(efforts.length)data.push({...typeof provider==='string'?{provider}:{},model:item.model,name:item.displayName,default_service_tier:typeof item.defaultServiceTier==='string'?item.defaultServiceTier:null,service_tiers:(Array.isArray(item.serviceTiers)?item.serviceTiers:[]).filter((tier:any)=>typeof tier.id==='string'&&typeof tier.name==='string').map((tier:any)=>({id:tier.id,name:tier.name,description:typeof tier.description==='string'?tier.description:''})),description:typeof item.description==='string'?item.description:'',efforts,defaultEffort:item.defaultReasoningEffort});
      }
      if(!response.nextCursor)break;cursor=response.nextCursor;
    }
    if(!data.length)throw Error('Codex 未返回可用模型，请稍后刷新');
    catalogs.set(key,{until:Date.now()+300000,data});if(catalogs.size>17)catalogs.delete(catalogs.keys().next().value!);return data;
  });loadingCatalogs.set(key,promise);try{const result=await promise;catalogFailures.delete(key);return result;}catch(error){if(!(error instanceof Error&&error.message.includes('未返回可用模型')))catalogFailures.set(key,{until:Date.now()+30000,error});if(catalogFailures.size>17)catalogFailures.delete(catalogFailures.keys().next().value!);throw error;}finally{if(loadingCatalogs.get(key)===promise)loadingCatalogs.delete(key);}
}

/** Probe one explicit engine. Provider isolation is preserved; callers that
 * intentionally want a combined catalog use readCodexModels(). */
export async function readEngineModelsForProvider(providerId?: string, force=false): Promise<ModelChoice[]> {
  const engine = providerId && providerId !== 'native'
    ? configuredCodexEngines().find(item => item.provider === providerId)
    : (currentCodexEngine().provider ? currentCodexEngine() : defaultCodexEngine());
  if (!engine) throw Error(`模型服务 ${providerId} 尚未配置独立引擎`);
  // Provider status discovery also repairs daemon-redirected sockets. Make the
  // same route visible to the connection layer before the first RPC.
  if (providerId && providerId !== 'native') {
    const state = await import('./management.js').then(module => module.inspectManagedCodexProvider(providerId));
    if (state?.socket && state.status === 'ready') engine.socket = state.socket;
  }
  return runInCodexEngine(engine, () => readEngineModels(force));
}

/** Provider catalogs remain isolated. Alternate engines are explicit deployment
 * routes, not inferred from descriptions or gateway names. */
export async function readCodexModels(force=false):Promise<ModelChoice[]> {
 const current=currentCodexEngine(),all=[current,...[defaultCodexEngine(),...configuredCodexEngines()].filter((e,i,list)=>e.socket!==current.socket&&list.findIndex(item=>item.socket===e.socket)===i)];
 const results=await Promise.allSettled(all.map(engine=>runInCodexEngine(engine,()=>readEngineModels(force))));
 if(results[0].status==='rejected')throw results[0].reason;
 return results.flatMap(result=>result.status==='fulfilled'?result.value:[]);
}

export {readModelPreference,saveModelPreference} from '../model-preferences.js';
export async function validateModelPreference(value:unknown):Promise<ModelPreference> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['model','effort','provider','service_tier'].includes(k)))throw Error('请选择模型和推理强度');
  const p=value as ModelPreference,models=await readCodexModels(),model=models.find(m=>m.model===p.model&&(!p.provider||m.provider===p.provider));
  if(!model||!model.efforts.some(e=>e.value===p.effort))throw Error('该模型或推理强度当前不可用，请刷新后重新选择');
  if(p.service_tier!==undefined&&(typeof p.service_tier!=='string'||p.service_tier!=='default'&&!model.service_tiers?.some(tier=>tier.id===p.service_tier)))throw Error('当前模型不支持所选服务档位');
  if(p.provider)engineForProvider(p.provider);
  return {model:p.model,effort:p.effort,...model.provider?{provider:model.provider}:{},...p.service_tier!==undefined?{service_tier:p.service_tier}:{}};
}
const settingWrites=new Map<string,Promise<ModelPreference>>();
/** The same settings-only RPC used by Codex TUI /model. Never starts a turn,
 * sends user input, changes permissions or interrupts an in-flight request. */
export function applyCodexModelSettings(threadId:string,value:ModelPreference):Promise<ModelPreference> {
  const prior=settingWrites.get(threadId)||Promise.resolve();
  const work=prior.catch(()=>{}).then(()=>withCodexConnection(async request=>{
    const before=await request('thread/read',{threadId});
    if(!before.thread||before.thread.status?.type==='notLoaded')throw Error('请保存模型选择后恢复或重载会话');
    if(value.provider&&before.thread.modelProvider&&value.provider!==before.thread.modelProvider)throw Error('切换模型服务需要新开会话；原会话已保留');
    await request('thread/settings/update',{threadId,model:value.model,effort:value.effort,...value.service_tier!==undefined?{serviceTier:value.service_tier}:{}});
    if(value.service_tier!==undefined){
      const settings=await request('thread/resume',{threadId,excludeTurns:true});rememberCodexSettings(threadId,settings);
      if((settings.serviceTier||'default')!==value.service_tier)throw Error('Fast 档位尚未确认，请刷新后重试');
    }
    const actual=await request('thread/read',{threadId});
    if(actual.thread?.model!==value.model||actual.thread?.reasoningEffort!==value.effort)throw Error('设置状态尚未确认，请手动刷新查看');
    return value;
  }));settingWrites.set(threadId,work);return work.finally(()=>{if(settingWrites.get(threadId)===work)settingWrites.delete(threadId);});
}

let quota:{key:string;until:number;data:ReturnType<typeof windows>}|undefined;
const gitCache=new Map<string,{until:number;data:{branch:string;changes:number}|null}>();
async function readGitInfo(cwd:string|null,force=false) {
  if(!cwd)return null;const cached=gitCache.get(cwd);if(!force&&cached&&cached.until>Date.now())return cached.data;
  let data:{branch:string;changes:number}|null=null;
  try {
    const {stdout}=await execute('git',['-c','core.fsmonitor=false','-C',cwd,'status','--porcelain=v1','--branch','--untracked-files=normal','--ignore-submodules=all'],{timeout:1500,maxBuffer:128*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
    const lines=stdout.trimEnd().split('\n'),header=lines.shift()||'';const branch=header.startsWith('## No commits yet on ')?header.slice(21):header.startsWith('## HEAD ')?'已分离':header.slice(3).split('...')[0].split(' [')[0];
    data={branch,changes:lines.filter(Boolean).length};
  }catch{/* Not every session directory is a Git repository. */}
  gitCache.set(cwd,{until:Date.now()+3000,data});if(gitCache.size>64)gitCache.delete(gitCache.keys().next().value!);return data;
}
export async function readConversationControls(threadId:string,sharedAccess:boolean,force=false) {
  const telemetry=await readConversationTelemetry(threadId).catch(()=>empty());
  let native:any=null,loaded=false,models:ModelChoice[]=[],warning:string|null=null,limits=telemetry.limits,engineVersion:string|null=null;
  if(sharedAccess&&process.env.AGENTMANAGER_CODEX_STREAM_SOCKET) {
    try {
      native=await withCodexConnection(async(request,server)=>{
        engineVersion=server.userAgent?.match(/\b(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/)?.[1]||null;
        const response=await request('thread/read',{threadId});
        loaded=!!response.thread&&response.thread.status?.type!=='notLoaded';
        if(!loaded)engineVersion=null;
        if(loaded&&(!codexSettings(threadId)||force)){const settings=await request('thread/resume',{threadId,excludeTurns:true});rememberCodexSettings(threadId,settings);}
        return response.thread;
      });
      models=await readCodexModels(force);
      if(loaded) {
        const key=currentCodexEngine().socket;
        if(!force&&quota?.key===key&&quota.until>Date.now())limits=quota.data;
        else try {const current=await withCodexConnection(async request=>{const response=await request('account/rateLimits/read',{});return windows(response.rateLimitsByLimitId?.codex??response.rateLimits,true);});if(current.length){limits=current;quota={key,until:Date.now()+300000,data:limits};}}catch{/* Last native usage still has timestamped limits. */}
      }
    }catch(error){warning=error instanceof Error?error.message:'实时设置暂不可用，可稍后刷新';}
  }
  // Host account quotas are never exposed through an ordinary member session.
  if(!sharedAccess)limits=[];
  const cwd=typeof native?.cwd==='string'?native.cwd:null;
  const git=await readGitInfo(cwd,force);
  const installed=await installedCodexVersion(force).catch(()=>null);
  if(!warning&&engineVersion&&installed&&engineVersion!==installed)warning=`客户端 ${installed} · 共享引擎 ${engineVersion}。重连保留当前引擎，不会重启其他会话。`;
  return {model:typeof native?.model==='string'?native.model:telemetry.model,effort:typeof native?.reasoningEffort==='string'?native.reasoningEffort:telemetry.effort,
    provider:typeof native?.modelProvider==='string'?native.modelProvider:null,cwd,cli_version:typeof native?.cliVersion==='string'?native.cliVersion:null,engine_version:engineVersion,installed_cli_version:installed,git,state:typeof native?.status?.type==='string'?native.status.type:null,
    permission:telemetry.permission,approval:telemetry.approval,service_tier:codexSettings(threadId)?codexSettings(threadId)!.tier:telemetry.service_tier,usage:telemetry.usage,limits,usage_observed_at:telemetry.observed_at,
    models,loaded,warning,supports_model_recovery:true,supports_fresh_model:true,native_id:threadId,checked_at:new Date().toISOString()};
}

/** Explicit recovery selection wins over persisted unavailable model. Never
 * silently swap models or replay a failed user turn. */
export async function prepareCodexModelRecovery(threadId:string,preference:ModelPreference|null) {
 const models=await readEngineModels();
 await withCodexConnection(async request=>{
  const {thread}=await request('thread/read',{threadId});
  const provider=currentCodexEngine().provider;
  if(thread?.modelProvider&&provider&&thread.modelProvider!==provider)throw Error(`此会话使用 ${thread.modelProvider}，引擎当前使用 ${provider}；请接入对应 provider 引擎或新开会话`);
  const value=preference?await validateModelPreference(preference):null;
  if(value?.provider&&thread?.modelProvider&&value.provider!==thread.modelProvider)throw Error('跨模型服务恢复需要新开会话，原会话已保留');
  if(!value&&thread?.model&&!models.some(m=>m.model===thread.model))throw Error(`原会话模型 ${thread.model} 当前不可用，请在模型选择器中保存可用模型后再恢复`);
  if(!value)return;
  if(thread?.status?.type==='notLoaded')await request('thread/resume',{threadId,model:value.model,...value.provider?{modelProvider:value.provider}:{},config:{model_reasoning_effort:value.effort},...value.service_tier!==undefined?{serviceTier:value.service_tier}:{},excludeTurns:true});
  await request('thread/settings/update',{threadId,model:value.model,effort:value.effort,...value.service_tier!==undefined?{serviceTier:value.service_tier}:{}});
    if(value.service_tier!==undefined){
      const settings=await request('thread/resume',{threadId,excludeTurns:true});rememberCodexSettings(threadId,settings);
      if((settings.serviceTier||'default')!==value.service_tier)throw Error('Fast 档位尚未确认，请刷新后重试');
    }
  const actual=(await request('thread/read',{threadId})).thread;
  if(actual?.model!==value.model||actual?.reasoningEffort!==value.effort)throw Error('恢复模型尚未确认，未提交任务，请刷新后重试');
 });
}
export async function assertCodexLaunchModel(request:(method:string,params:unknown)=>Promise<any>) {
 const result=await request('config/read',{}),config=result?.config;
 if(!config)return;
 rememberCodexProvider(config.model_provider);
 if(typeof config.model==='string'&&!(await readEngineModels()).some(m=>m.model===config.model))throw Error(`配置模型 ${config.model} 不在当前模型服务 ${config.model_provider||'默认'} 的可用目录中；请修正配置后新开会话`);
}
