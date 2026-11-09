import {assertEnvironmentIdle,assertEnvironmentUnused} from './environment-usage.js';
import {randomUUID} from 'crypto';
import {getDb} from '../../../db/index.js';
import {config} from '../../../config.js';
import {readAgentManagement,sealAgentSecret,openAgentSecret} from '../management-store.js';
import {assertEnvironmentUse,canUseEnvironment,environmentRecord,validateEnvironmentUsers,environmentAccessChanged} from '../environment-access.js';
import {ensureAccountTransport,validateAccountConnection,closeAccountTransport,checkAccountProject,type AccountConnection} from './account-transport.js';
import {configuredCodexEngines,defaultCodexEngine,runInCodexEngine,type CodexEngine} from './engine-context.js';
export interface CodexEnvironment {id:string;name:string;kind:'native'|'provider'|'account';enabled:boolean;allowed_user_ids:string[]|null;connection?:AccountConnection;provider?:string;retired?:boolean}
function publicAccountConnection(value:Record<string,unknown>):AccountConnection {
 const {password:_,encryptedPassword,...connection}=value;
 return validateAccountConnection({...connection,passwordConfigured:!!encryptedPassword},{stored:true});
}
/** Hydrate a secret only for server-side transport use, never a management DTO. */
export function environmentConnection(environment:CodexEnvironment):AccountConnection {
 if(!environment.connection)throw Error('账号连接配置不存在');
 const value=environmentRecord(environment.id);const stored=value?JSON.parse(value.config):{};
 return {...environment.connection,...environment.connection.authMethod==='password'&&stored.encryptedPassword?{password:openAgentSecret(stored.encryptedPassword,'codex-ssh:'+environment.id)}:{}};
}
export function allCodexEnvironments():CodexEnvironment[] {
 const records=getDb().prepare("SELECT * FROM agent_environments WHERE agent_id='codex'").all() as import('../environment-access.js').EnvironmentRecord[];
 const overrides=new Map(records.map(r=>[r.id,r]));
 const permissions=(id:string)=>{const r=overrides.get(id);return {enabled:r?.enabled!==0,allowed_user_ids:r?.allowed_user_ids?JSON.parse(r.allowed_user_ids) as string[]:null};};
 const result:CodexEnvironment[]=[{id:'native',name:overrides.get('native')?.name||'本机默认 Codex',kind:'native',...permissions('native')}];
 for(const p of readAgentManagement('codex').providers)result.push({id:'provider:'+p.id,name:overrides.get('provider:'+p.id)?.name||p.name,kind:'provider',provider:p.id,...permissions('provider:'+p.id),enabled:p.enabled&&permissions('provider:'+p.id).enabled});
 for(const r of records.filter(r=>r.kind==='account'&&!JSON.parse(r.config).retired))result.push({id:r.id,name:r.name,kind:'account',enabled:!!r.enabled,allowed_user_ids:r.allowed_user_ids?JSON.parse(r.allowed_user_ids):[],connection:publicAccountConnection(JSON.parse(r.config))});
 return result;
}
export function visibleCodexEnvironments(userId:string):Array<Omit<CodexEnvironment,'connection'|'allowed_user_ids'>> {
 return allCodexEnvironments().filter(e=>canUseEnvironment('codex',e.id,userId)).map(({connection:_,allowed_user_ids:__,...e})=>e);
}
export function getCodexEnvironment(id:string):CodexEnvironment {
 const environment=allCodexEnvironments().find(e=>e.id===id);
 if(environment)return environment;
 const row=environmentRecord(id);if(row?.kind==='account'){const stored=JSON.parse(row.config);if(stored.retired)return {id,name:row.name,kind:'account',enabled:false,retired:true,allowed_user_ids:JSON.parse(row.allowed_user_ids||'[]'),connection:publicAccountConnection(stored)};}
 throw Object.assign(Error('Codex 环境不存在'),{statusCode:404});
}
export async function saveCodexEnvironment(input:unknown,id?:string):Promise<CodexEnvironment> {
 const p=input as Record<string,unknown>;if(!p||typeof p!=='object')throw Object.assign(Error('无效的环境配置'),{statusCode:400});
 const old=id?getCodexEnvironment(id):undefined;
 const environmentId=id||'account:'+randomUUID();
 const kind=old?.kind||'account';
 const allowed=validateEnvironmentUsers(p.allowed_user_ids===undefined?(old?.allowed_user_ids??[]):p.allowed_user_ids);
 if(kind==='account'&&allowed===null)throw Object.assign(Error('账号环境必须明确指定可使用的平台用户'),{statusCode:400});
 const name=typeof p.name==='string'?p.name.trim():old?.name||'';if(!name||name.length>120)throw Object.assign(Error('环境名称必须为 1–120 个字符'),{statusCode:400});
 if(p.enabled!==undefined&&typeof p.enabled!=='boolean')throw Object.assign(Error('启用状态必须为布尔值'),{statusCode:400});
 const connection=kind==='account'?validateAccountConnection(p.connection??old?.connection):undefined;
 if(old?.kind==='account'&&connection&&old.connection&&(connection.username!==old.connection.username||connection.codexHome!==old.connection.codexHome)&&getDb().prepare('SELECT 1 FROM sessions WHERE agent_environment_id=? LIMIT 1').get(environmentId))throw Object.assign(Error('已有会话绑定该环境，请新建环境以更换系统用户或 CODEX_HOME，避免改变原会话归属'),{statusCode:409});
 if(old?.kind==='account'&&(p.connection!==undefined||p.enabled===false))await assertEnvironmentIdle(environmentId);
 const priorConfig=old?JSON.parse(environmentRecord(environmentId)?.config||'{}'):{};
 const encryptedPassword=connection?.authMethod==='password'?(connection.password?sealAgentSecret(connection.password,'codex-ssh:'+environmentId):old?.connection?.username===connection.username&&old.connection.port===connection.port?priorConfig.encryptedPassword||'':''):'';
 if(connection?.authMethod==='password'&&!encryptedPassword)throw Object.assign(Error('请填写该系统用户的 SSH 登录密码'),{statusCode:400});
 const {password:_,passwordConfigured:__,...publicConnection}=connection||{};
 const storedConnection={...publicConnection,...encryptedPassword?{encryptedPassword}:{}};
 const enabled=p.enabled===undefined?(old?.enabled??true):p.enabled;
 getDb().prepare(`INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES(?,'codex',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,config=excluded.config,allowed_user_ids=excluded.allowed_user_ids`).run(environmentId,name,kind,enabled?1:0,JSON.stringify(storedConnection),allowed===null?null:JSON.stringify(allowed));
 environmentAccessChanged();
 if(kind==='account'&&(!old||JSON.stringify(priorConfig)!==JSON.stringify(storedConnection)||!enabled))await closeAccountTransport(environmentId);
 return getCodexEnvironment(environmentId);
}
export async function deleteCodexEnvironment(id:string):Promise<void>{
 const e=getCodexEnvironment(id);if(e.kind!=='account')throw Object.assign(Error('内置环境只能调整授权或停用，请在 Provider 管理中删除 API 接入'),{statusCode:409});
 assertEnvironmentUnused(id);await closeAccountTransport(id);
 if(getDb().prepare('SELECT 1 FROM sessions WHERE agent_environment_id=? LIMIT 1').get(id)){
  const stored=JSON.parse(environmentRecord(id)!.config);getDb().prepare('UPDATE agent_environments SET enabled=0,config=? WHERE id=?').run(JSON.stringify({...stored,retired:true}),id);
 }else getDb().prepare('DELETE FROM agent_environments WHERE id=?').run(id);
 environmentAccessChanged();
}
export async function engineForEnvironment(id:string,options:{history?:boolean}={}):Promise<CodexEngine> {
 const e=getCodexEnvironment(id);if(e.retired&&!options.history)throw Object.assign(Error('Provider 已删除，仅保留历史记录'),{statusCode:410});if(!e.enabled&&!e.retired)throw Object.assign(Error('Codex 环境已停用'),{statusCode:403});
 if(e.kind==='account'){const transport=await ensureAccountTransport(e.id,environmentConnection(e));return {socket:transport.socket,environmentId:id,accountHome:transport.home};}
 if(e.kind==='provider') {const engine=configuredCodexEngines().find(item=>item.provider===e.provider);if(!engine)throw Object.assign(Error('Provider 尚未配置引擎'),{statusCode:409});return {...engine,environmentId:id};}
 return {...defaultCodexEngine(),environmentId:'native'};
}
export function sessionEnvironmentId(session:{agent_environment_id?:string|null}):string{return session.agent_environment_id||'native';}
export function assertSessionEnvironment(session:{agent_environment_id?:string|null;created_by_user_id?:string|null},userId?:string):void {
 const actor=userId||session.created_by_user_id;if(actor)assertEnvironmentUse('codex',sessionEnvironmentId(session),actor);
}
export interface PreflightCheck {stage:string;ok:boolean;message:string}
export async function preflightEnvironment(id:string,projectPath?:string):Promise<{ok:boolean;checks:PreflightCheck[]}> {
 const checks:PreflightCheck[]=[];let stage='connection';
 try{
  const e=getCodexEnvironment(id);checks.push({stage:'configuration',ok:true,message:e.kind==='account'?`本机系统用户：${e.connection!.username}`:'使用已配置的本机 Codex 引擎'});
  stage=e.kind==='account'?'ssh_connection':'codex_socket';const engine=await engineForEnvironment(id);checks.push({stage,ok:true,message:'Codex 引擎连接成功'});
  await runInCodexEngine(engine,async()=>{
   const {withCodexConnection}=await import('./stream.js');
   stage='codex_authentication';const auth=await withCodexConnection(request=>request('account/read',{}));
   if(!auth.account&&auth.requiresOpenaiAuth!==false)throw Error('该环境尚未登录 Codex，请先以对应系统用户在终端运行 codex login');
   checks.push({stage,ok:true,message:auth.account?'Codex 已登录':'该 Provider 使用独立 API 认证'});
   stage='models';const {readEngineModelsForEnvironment}=await import('./controls.js');const models=await readEngineModelsForEnvironment(id,true);if(!models.length)throw Error('该环境未返回可用模型');checks.push({stage,ok:true,message:`检测到 ${models.length} 个可用模型`});
  });
  if(projectPath&&e.kind==='account'){stage='project_access';await checkAccountProject(environmentConnection(e),projectPath);checks.push({stage,ok:true,message:'目标系统用户可读写项目目录'});}
  return {ok:true,checks};
 }catch(error){checks.push({stage:(error as {stage?:string}).stage||stage,ok:false,message:error instanceof Error?error.message:'连接检查失败'});return {ok:false,checks};}
}
