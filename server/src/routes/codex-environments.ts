import {accountConfigFiles} from '../services/agents/codex/account-config-files.js';
import {cachedAccountUsage,cachedGroupUsage,collectAccountUsage,initAccountUsage} from '../services/agents/codex/account-usage.js';
import {cachedAccountStatus,initAccountStatus} from '../services/agents/codex/account-status.js';
import {cachedEngineBalance,initEngineBalance} from '../services/agents/codex/engine-balance.js';
import {readCodexAccountDetails} from '../services/agents/codex/account-details.js';
import {environmentUsage,closeEnvironmentTabs} from '../services/agents/codex/environment-usage.js';
import type {FastifyPluginAsync} from 'fastify';
import {getDb} from '../db/index.js';
import {requirePermission,userHasPermission,userRoleIds} from '../services/rbac.js';
import {userCanUseSessionTool,userCanUseToolForProject} from '../auth.js';
import {allCodexEnvironments,getCodexEnvironment,environmentConnection,visibleCodexEnvironments,saveCodexEnvironment,deleteCodexEnvironment,preflightEnvironment,sessionEnvironmentId} from '../services/agents/codex/environments.js';
import {assertEnvironmentUse,canControlEnvironment,canUseEnvironment,environmentUserOverride,environmentAccessChanged} from '../services/agents/environment-access.js';
import {readEngineModelsForEnvironment} from '../services/agents/codex/controls.js';
import {getSession} from '../services/session-manager.js';
import {transferCodexEnvironment} from '../services/agents/codex/environment-transfer.js';
import {validateAccountConnection,probeAccountConnection} from '../services/agents/codex/account-transport.js';

const errorStatus=(e:unknown)=>Number((e as {statusCode?:number})?.statusCode)||409;
export const codexEnvironmentRoutes:FastifyPluginAsync=async app=>{
 initAccountUsage();
 initAccountStatus();
 initEngineBalance();
 const describe=(e:ReturnType<typeof allCodexEnvironments>[number])=>({...e,auth_mode:cachedEngineBalance(e.id).auth_mode,balance_group:cachedEngineBalance(e.id).groupKey??null,source:e.kind==='native'?'managed_host':e.kind==='provider'?'managed_provider':'system_user'});
 app.get<{Params:{id:string};Querystring:{granularity?:string}}>('/codex/environments/:id/insights',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  const account=visibleCodexEnvironments(req.user!.id).find(e=>e.id===req.params.id&&e.enabled);
  if(!account||account.kind==='native'&&!canControlEnvironment(account.id,req.user!.id))return reply.code(404).send({error:'账号不存在或无权访问'});
  if(req.user!.role!=='admin')return reply.code(403).send({error:'仅管理员可查看账号详情'});
  reply.header('Cache-Control','private, no-store');
  return {usage:req.query.granularity==='hour'?cachedGroupUsage([account.id],'hour',true):cachedAccountUsage(account.id)};
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/reset-credits',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  const account=visibleCodexEnvironments(req.user!.id).find(e=>e.id===req.params.id&&e.enabled&&e.kind!=='provider');
  if(!account||account.kind==='native'&&!canControlEnvironment(account.id,req.user!.id))return reply.code(404).send({error:'账号不存在或无权访问'});
  if(req.user!.role!=='admin')return reply.code(403).send({error:'仅管理员可查看账号详情'});
  reply.header('Cache-Control','private, no-store');
  const {quota:_,reason:__,...status}=cachedAccountStatus(account.id);return status;
 });
 app.get<{Params:{id:string}}>('/users/:id/codex-environments',async(req,reply)=>{
  if(!requirePermission(req,reply,'users','read')||!requirePermission(req,reply,'settings','read'))return;
  const user=getDb().prepare('SELECT id,role,disabled FROM users WHERE id=?').get(req.params.id) as {id:string;role:string;disabled:number}|undefined;
  if(!user)return reply.code(404).send({error:'用户不存在'});
  return {environments:allCodexEnvironments().map(e=>({id:e.id,name:e.name,enabled:e.enabled,kind:e.kind,access:environmentUserOverride(e.id,user.id)===null?'inherit':environmentUserOverride(e.id,user.id)?'allow':'deny',effective:!user.disabled&&e.enabled&&canUseEnvironment('codex',e.id,user.id)})),administrator:user.role==='admin'};
 });
 app.put<{Params:{id:string};Body:{entries?:unknown}}>('/users/:id/codex-environments',async(req,reply)=>{
  if(!requirePermission(req,reply,'users','write')||!requirePermission(req,reply,'settings','write'))return;
  const user=getDb().prepare('SELECT id,role FROM users WHERE id=?').get(req.params.id) as {id:string;role:string}|undefined;
  if(!user)return reply.code(404).send({error:'用户不存在'});
  if(user.role==='admin')return reply.code(400).send({error:'管理员始终可以使用已配置的 Engine'});
  if(userRoleIds(user.id).some(id=>id!=='member')&&!requirePermission(req,reply,'roles','write'))return;
  const entries=req.body?.entries, valid=new Set(allCodexEnvironments().map(e=>e.id));
  if(!Array.isArray(entries)||entries.length>200||entries.some(e=>!e||typeof e!=='object'||typeof e.id!=='string'||!valid.has(e.id)||!['inherit','allow','deny'].includes(e.access))||new Set(entries.map(e=>e.id)).size!==entries.length)return reply.code(400).send({error:'Engine 授权无效'});
  getDb().transaction(()=>{for(const e of entries){if(e.access==='inherit')getDb().prepare('DELETE FROM agent_environment_user_access WHERE environment_id=? AND user_id=?').run(e.id,user.id);else getDb().prepare('INSERT INTO agent_environment_user_access(environment_id,user_id,allowed) VALUES(?,?,?) ON CONFLICT(environment_id,user_id) DO UPDATE SET allowed=excluded.allowed').run(e.id,user.id,e.access==='allow'?1:0);}})();
  environmentAccessChanged();return {ok:true};
 });
 app.get<{Querystring:{management?:string}}>('/codex/environments',async(req,reply)=>{
  if(req.query.management==='true'){
   if(!requirePermission(req,reply,'settings','write'))return;
   return {environments:allCodexEnvironments().map(describe),users:getDb().prepare('SELECT id,username,display_name,role FROM users WHERE disabled=0 ORDER BY username').all()};
  }
  if(!requirePermission(req,reply,'agent_api','read'))return;
  return {environments:visibleCodexEnvironments(req.user!.id).map(e=>({...e,auth_mode:cachedEngineBalance(e.id).auth_mode,balance_group:cachedEngineBalance(e.id).groupKey??null,source:e.kind==='native'?'managed_host':e.kind==='provider'?'managed_provider':'system_user'}))};
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/balance',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  const e=visibleCodexEnvironments(req.user!.id).find(e=>e.id===req.params.id&&e.enabled);
  if(!e||e.kind==='native'&&!canControlEnvironment(e.id,req.user!.id))return reply.code(404).send({error:'环境不存在或无权访问'});
  if(req.user!.role!=='admin')return reply.code(403).send({error:'仅管理员可查看余额'});
  reply.header('Cache-Control','private, no-store');return cachedEngineBalance(e.id);
 });
 app.get<{Params:{group:string};Querystring:{granularity?:string}}>('/codex/balance-groups/:group/insights',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  if(req.user!.role!=='admin')return reply.code(403).send({error:'仅管理员可查看余额详情'});
  if(!/^[a-f0-9]{64}$/.test(req.params.group))return reply.code(404).send({error:'上游不存在或无权访问'});
  const members=visibleCodexEnvironments(req.user!.id).filter(e=>e.enabled&&cachedEngineBalance(e.id).auth_mode==='api'&&cachedEngineBalance(e.id).groupKey===req.params.group);
  if(!members.length||members.length>100)return reply.code(404).send({error:'上游不存在或无权访问'});
  reply.header('Cache-Control','private, no-store');return {usage:cachedGroupUsage(members.map(e=>e.id),req.query.granularity==='hour'?'hour':'day')};
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/quota',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  const account=visibleCodexEnvironments(req.user!.id).find(e=>e.id===req.params.id&&(e.kind==='account'||e.kind==='native')&&e.enabled);
  if(!account)return reply.code(404).send({error:'账号不存在或无权访问'});
  // The implicit host environment is visible for creation, but its account is private.
  if(account.kind==='native'&&!canControlEnvironment(account.id,req.user!.id))return {quota:null,reason:'not_applicable'};
  reply.header('Cache-Control','private, no-store');
  const status=cachedAccountStatus(account.id);
  if(status.reason==='not_applicable')return {quota:null,reason:'not_applicable',message:'此账号未登录 ChatGPT，无法读取订阅额度'};
  if(status.quota)return {quota:status.quota};
  return reply.code(503).send({quota:null,reason:'unavailable',error:status.error||'等待后台每 5 分钟采集账号额度'});
 });
 app.get<{Params:{id:string};Querystring:{file?:string}}>('/codex/environments/:id/config-files',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings',req.params.id==='native'?'read':'write'))return;
  if(req.params.id==='native'&&req.query.file&&!canControlEnvironment('native',req.user!.id))return reply.code(403).send({error:'无权查看该账号配置文件'});
  reply.header('Cache-Control','private, no-store');try{return await accountConfigFiles(req.params.id,req.query.file?'read':'list',req.query.file);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'读取文件失败'});}
 });
 app.put<{Params:{id:string};Body:{file?:string;content?:unknown;revision?:unknown}}>('/codex/environments/:id/config-files',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write'))return;
  reply.header('Cache-Control','private, no-store');try{return await accountConfigFiles(req.params.id,'write',req.body?.file,req.body?.content,req.body?.revision);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存文件失败'});}
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/details',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings',req.params.id==='native'?'read':'write'))return;
  try {
   const details=await readCodexAccountDetails(req.params.id);
   if(req.params.id==='native'&&!canControlEnvironment('native',req.user!.id))details.authentication={...details.authentication,email:null,plan:null};
   reply.header('Cache-Control','private, no-store');return {details};
  }catch(error){return reply.code(errorStatus(error)).send({error:error instanceof Error?error.message:'无法读取该用户的 Codex 详情',stage:(error as {stage?:string}).stage||'account_details'});}
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/usage',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{getCodexEnvironment(req.params.id);return await environmentUsage(req.params.id);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'读取占用情况失败'});}});
 app.post<{Params:{id:string}}>('/codex/environments/:id/insights/rebuild',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write')||!requirePermission(req,reply,'agent_api','write'))return;
  if(req.user!.role!=='admin')return reply.code(403).send({error:'仅管理员可重建用量统计'});
  try{getCodexEnvironment(req.params.id);await collectAccountUsage(req.params.id,{rebuild:true});reply.header('Cache-Control','private, no-store');return {ok:true};}
  catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'重建失败，原统计已保留'});}
 });
 app.post<{Params:{id:string};Body:{session_ids?:unknown}}>('/codex/environments/:id/close-tabs',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write')||!requirePermission(req,reply,'monitor','delete'))return;
  const ids=req.body?.session_ids;if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>100))return reply.code(400).send({error:'请选择 1–100 个标签页'});
  try{return {results:await closeEnvironmentTabs(req.params.id,[...new Set(ids)])};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'删除标签页失败'});}
 });
 app.post('/codex/environments',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{return {environment:describe(await saveCodexEnvironment(req.body))};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存失败'});}});
 app.put<{Params:{id:string}}>('/codex/environments/:id',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{return {environment:describe(await saveCodexEnvironment(req.body,req.params.id))};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存失败'});}});
 app.delete<{Params:{id:string}}>('/codex/environments/:id',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{await deleteCodexEnvironment(req.params.id);return {ok:true};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'删除失败'});}});
 app.post('/codex/environments/check-connection',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write'))return;
  try {
   const c=validateAccountConnection(req.body);
   const id=(req.body as {environment_id?:unknown})?.environment_id;
   if(c.authMethod==='password'&&!c.password&&typeof id==='string'){const prior=getCodexEnvironment(id);if(prior.connection?.username===c.username&&prior.connection.port===c.port)c.password=environmentConnection(prior).password;}
   const projectId=(req.body as {project_id?:unknown})?.project_id;
   const projectPath=typeof projectId==='string'?(getDb().prepare('SELECT path FROM projects WHERE id=?').get(projectId) as {path:string}|undefined)?.path:undefined;
   if(projectId&&!projectPath)return reply.code(400).send({error:'测试项目不存在'});
   const result=await probeAccountConnection(c,projectPath);return {ok:true,models:result.models,checks:[{stage:'ssh_connection',ok:true,message:'本机 SSH 认证成功'},{stage:'codex_authentication',ok:true,message:'已复用目标系统用户的 Codex 登录状态'},{stage:'models',ok:true,message:`检测到 ${result.models.length} 个可用模型`},...projectPath?[{stage:'project_access',ok:true,message:'目标系统用户可读写测试项目'}]:[]]};
  }catch(e){return {ok:false,checks:[{stage:(e as {stage?:string}).stage||'configuration',ok:false,message:e instanceof Error?e.message:'预检失败'}]};}
 });
 app.post<{Params:{id:string};Body:{project_id?:string}}>('/codex/environments/:id/preflight',async(req,reply)=>{
  if(req.body?.project_id){
   if(!userCanUseToolForProject(req.user!.id,req.body.project_id,'session','codex'))return reply.code(403).send({error:'无权使用该项目'});
   try{assertEnvironmentUse('codex',req.params.id,req.user!.id);}catch{return reply.code(403).send({error:'无权使用该 Codex 环境'});}
  }else if(!requirePermission(req,reply,'settings','write'))return;
  const path=req.body?.project_id?(getDb().prepare('SELECT path FROM projects WHERE id=?').get(req.body.project_id) as {path:string}|undefined)?.path:undefined;
  if(req.body?.project_id&&!path)return reply.code(404).send({error:'项目不存在'});
  return preflightEnvironment(req.params.id,path);
 });
 const own=(id:string,userId:string)=>{const s=getSession(id);return s?.cli_type==='codex'&&s.created_by_user_id===userId&&userCanUseSessionTool(userId,id,'codex',s.mode==='terminal'?'terminal':'session')?s:null;};
 app.get<{Params:{id:string}}>('/sessions/:id/environments',async(req,reply)=>{
  const s=own(req.params.id,req.user!.id);if(!s)return reply.code(404).send({error:'Session not found'});
  return {current:sessionEnvironmentId(s),environments:visibleCodexEnvironments(req.user!.id).map(e=>({...e,auth_mode:cachedEngineBalance(e.id).auth_mode,source:e.kind==='native'?'managed_host':e.kind==='provider'?'managed_provider':'system_user',can_control:canControlEnvironment(e.id,req.user!.id)}))};
 });
 app.get<{Params:{id:string;environment:string}}>('/sessions/:id/environments/:environment/models',async(req,reply)=>{
  if(!own(req.params.id,req.user!.id))return reply.code(404).send({error:'Session not found'});
  if(!requirePermission(req,reply,'agent_api','read'))return;
  try{assertEnvironmentUse('codex',req.params.environment,req.user!.id);return {models:await readEngineModelsForEnvironment(req.params.environment,true)};}
  catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'模型预检失败'});}
 });
 app.post<{Params:{id:string;environment:string}}>('/sessions/:id/environments/:environment/preflight',async(req,reply)=>{
  const session=own(req.params.id,req.user!.id);if(!session)return reply.code(404).send({error:'Session not found'});
  if(!requirePermission(req,reply,'agent_api','write'))return;
  try{
   assertEnvironmentUse('codex',req.params.environment,req.user!.id);
   const path=session.project_id?(getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {path:string}|undefined)?.path:undefined;
   const result=await preflightEnvironment(req.params.environment,path);
   return {...result,...result.ok?{models:await readEngineModelsForEnvironment(req.params.environment)}:{}};
  }catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'预检失败'});}
 });
 app.post<{Params:{id:string};Body:{environment_id:string;model:string;effort:string;provider?:string}}>('/sessions/:id/environment',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','write'))return;
  if(!own(req.params.id,req.user!.id))return reply.code(404).send({error:'Session not found'});
  const p=req.body;if(!p||typeof p.environment_id!=='string'||typeof p.model!=='string'||typeof p.effort!=='string'||p.model.length>200||p.effort.length>30||p.provider!==undefined&&typeof p.provider!=='string')return reply.code(400).send({error:'请选择 Codex 环境、模型和推理强度'});
  try{const result=await transferCodexEnvironment(req.params.id,req.user!.id,p.environment_id,p);if(!result.ok)return reply.code(409).send({error:result.error});return {...result,session:getSession(req.params.id)};}
  catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'环境切换失败，原会话已保留'});}
 });
};
