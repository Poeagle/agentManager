import {open} from 'fs/promises';
import {getDb} from '../db/index.js';
import {findCodexRollout} from './prompt-context.js';
import {withCodexConnection} from './conversation-stream.js';
import {installedCodexVersion} from './codex-version.js';
import {execFile} from 'child_process';
import {promisify} from 'util';
const execute=promisify(execFile);

export interface ModelChoice {model:string;name:string;description:string;efforts:Array<{value:string;description:string}>;defaultEffort:string}
export interface ModelPreference {model:string;effort:string}
const finite=(n:unknown):number|null=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:null;
const tokenFields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
function tokens(value:any) {return Object.fromEntries(tokenFields.map(key=>[key,finite(value?.[key])])) as Record<typeof tokenFields[number],number|null>;}
function windows(value:any,camel=false) {return [value?.primary,value?.secondary].flatMap(window=>{
  const used=finite(camel?window?.usedPercent:window?.used_percent),minutes=finite(camel?window?.windowDurationMins:window?.window_minutes);
  return used===null||minutes===null?[]:[{used_percent:Math.min(100,used),minutes,resets_at:finite(camel?window?.resetsAt:window?.resets_at)}];
});}
interface Telemetry {model:string|null;effort:string|null;permission:string|null;approval:string|null;service_tier:string|null;usage:{total:ReturnType<typeof tokens>;last:ReturnType<typeof tokens>;window:number|null}|null;limits:ReturnType<typeof windows>;observed_at:string|null}
const empty=():Telemetry=>({model:null,effort:null,permission:null,approval:null,service_tier:null,usage:null,limits:[],observed_at:null});
const telemetryCache=new Map<string,{size:number;inode:number;mtime:number;data:Telemetry}>();
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
    const start=Math.max(0,stat.size-2*1024*1024),buffer=Buffer.alloc(stat.size-start);await handle.read(buffer,0,buffer.length,start);
    const content=buffer.toString('utf8'),lines=(start?content.slice(content.indexOf('\n')+1):content).split('\n');
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
    telemetryCache.delete(path);telemetryCache.set(path,{size:stat.size,inode:stat.ino,mtime:stat.mtimeMs,data});
    if(telemetryCache.size>64)telemetryCache.delete(telemetryCache.keys().next().value!);
    return data;
  }finally{await handle.close();}
}

let catalog:{key:string;until:number;data:ModelChoice[]}|undefined;
let loadingCatalog:{key:string;promise:Promise<ModelChoice[]>}|undefined;
export async function readCodexModels(force=false):Promise<ModelChoice[]> {
  const key=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET||'';
  if(!force&&catalog?.key===key&&catalog.until>Date.now())return catalog.data;
  if(loadingCatalog?.key===key)return loadingCatalog.promise;
  const promise=withCodexConnection(async request=>{
    const data:ModelChoice[]=[];let cursor:string|undefined;
    for(let i=0;i<4;i++) {
      const response=await request('model/list',{includeHidden:false,limit:100,...cursor?{cursor}:{}});
      for(const item of response.data||[]) {
        if(item.hidden||typeof item.model!=='string'||typeof item.displayName!=='string'||!Array.isArray(item.supportedReasoningEfforts))continue;
        const efforts=item.supportedReasoningEfforts.filter((e:any)=>typeof e.reasoningEffort==='string').map((e:any)=>({value:e.reasoningEffort,description:typeof e.description==='string'?e.description:''}));
        if(efforts.length)data.push({model:item.model,name:item.displayName,description:typeof item.description==='string'?item.description:'',efforts,defaultEffort:item.defaultReasoningEffort});
      }
      if(!response.nextCursor)break;cursor=response.nextCursor;
    }
    if(!data.length)throw Error('Codex 未返回可用模型，请稍后刷新');
    catalog={key,until:Date.now()+60000,data};return data;
  });loadingCatalog={key,promise};try{return await promise;}finally{if(loadingCatalog?.promise===promise)loadingCatalog=undefined;}
}

const preferenceKey=(id:string)=>`session-control:${id}`;
export function readModelPreference(userId:string,sessionId:string):ModelPreference|null {
  const row=getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId,preferenceKey(sessionId)) as {value:string}|undefined;
  try {const value=JSON.parse(row?.value||'null');return value&&typeof value.model==='string'&&typeof value.effort==='string'?{model:value.model,effort:value.effort}:null;}catch{return null;}
}
export async function validateModelPreference(value:unknown):Promise<ModelPreference> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['model','effort'].includes(k)))throw Error('请选择模型和推理强度');
  const p=value as ModelPreference,models=await readCodexModels(),model=models.find(m=>m.model===p.model);
  if(!model||!model.efforts.some(e=>e.value===p.effort))throw Error('该模型或推理强度当前不可用，请刷新后重新选择');
  return {model:p.model,effort:p.effort};
}
export function saveModelPreference(userId:string,sessionId:string,value:ModelPreference|null) {
  if(!value){getDb().prepare('DELETE FROM user_ui_state WHERE user_id=? AND key=?').run(userId,preferenceKey(sessionId));return;}
  getDb().prepare("INSERT INTO user_ui_state(user_id,key,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(userId,preferenceKey(sessionId),JSON.stringify(value));
}
const settingWrites=new Map<string,Promise<ModelPreference>>();
/** The same settings-only RPC used by Codex TUI /model. Never starts a turn,
 * sends user input, changes permissions or interrupts an in-flight request. */
export function applyCodexModelSettings(threadId:string,value:ModelPreference):Promise<ModelPreference> {
  const prior=settingWrites.get(threadId)||Promise.resolve();
  const work=prior.catch(()=>{}).then(()=>withCodexConnection(async request=>{
    const before=await request('thread/read',{threadId});
    if(!before.thread||before.thread.status?.type==='notLoaded')throw Error('会话未接入实时控制，请重载标签页后再试');
    await request('thread/settings/update',{threadId,model:value.model,effort:value.effort});
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
        return response.thread;
      });
      if(loaded) {
        models=await readCodexModels(force);
        const key=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET;
        if(!force&&quota?.key===key&&quota.until>Date.now())limits=quota.data;
        else try {const current=await withCodexConnection(async request=>{const response=await request('account/rateLimits/read',{});return windows(response.rateLimitsByLimitId?.codex??response.rateLimits,true);});if(current.length){limits=current;quota={key,until:Date.now()+60000,data:limits};}}catch{/* Last native usage still has timestamped limits. */}
      }
    }catch{warning='实时设置暂不可用，可稍后刷新';}
  }
  // Host account quotas are never exposed through an ordinary member session.
  if(!sharedAccess)limits=[];
  const cwd=typeof native?.cwd==='string'?native.cwd:null;
  const git=await readGitInfo(cwd,force);
  return {model:typeof native?.model==='string'?native.model:telemetry.model,effort:typeof native?.reasoningEffort==='string'?native.reasoningEffort:telemetry.effort,
    provider:typeof native?.modelProvider==='string'?native.modelProvider:null,cwd,cli_version:typeof native?.cliVersion==='string'?native.cliVersion:null,engine_version:engineVersion,installed_cli_version:await installedCodexVersion(force).catch(()=>null),git,state:typeof native?.status?.type==='string'?native.status.type:null,
    permission:telemetry.permission,approval:telemetry.approval,service_tier:telemetry.service_tier,usage:telemetry.usage,limits,usage_observed_at:telemetry.observed_at,
    models,loaded,warning,native_id:threadId,checked_at:new Date().toISOString()};
}
