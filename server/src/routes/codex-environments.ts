import {accountConfigFiles} from '../services/agents/codex/account-config-files.js';
import {runInCodexEngine} from '../services/agents/codex/engine-context.js';
import {withCodexConnection} from '../services/agents/codex/stream.js';
import {codexWeeklyQuotaFromResponse} from '../services/agents/codex/quota.js';
import {readCodexAccountDetails} from '../services/agents/codex/account-details.js';
import {environmentUsage,closeEnvironmentTabs} from '../services/agents/codex/environment-usage.js';
import type {FastifyPluginAsync} from 'fastify';
import {getDb} from '../db/index.js';
import {requirePermission,userHasPermission} from '../services/rbac.js';
import {userCanUseSessionTool,userCanUseToolForProject} from '../auth.js';
import {engineForEnvironment,allCodexEnvironments,getCodexEnvironment,environmentConnection,visibleCodexEnvironments,saveCodexEnvironment,deleteCodexEnvironment,preflightEnvironment,sessionEnvironmentId} from '../services/agents/codex/environments.js';
import {assertEnvironmentUse,canControlEnvironment} from '../services/agents/environment-access.js';
import {readEngineModelsForEnvironment} from '../services/agents/codex/controls.js';
import {getSession} from '../services/session-manager.js';
import {transferCodexEnvironment} from '../services/agents/codex/environment-transfer.js';
import {validateAccountConnection,probeAccountConnection} from '../services/agents/codex/account-transport.js';

const errorStatus=(e:unknown)=>Number((e as {statusCode?:number})?.statusCode)||409;
export const codexEnvironmentRoutes:FastifyPluginAsync=async app=>{
 app.get<{Querystring:{management?:string}}>('/codex/environments',async(req,reply)=>{
  if(req.query.management==='true'){
   if(!requirePermission(req,reply,'settings','write'))return;
   return {environments:allCodexEnvironments(),users:getDb().prepare('SELECT id,username,display_name,role FROM users WHERE disabled=0 ORDER BY username').all()};
  }
  if(!requirePermission(req,reply,'agent_api','read'))return;
  return {environments:visibleCodexEnvironments(req.user!.id)};
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/quota',async(req,reply)=>{
  if(!requirePermission(req,reply,'agent_api','read'))return;
  const account=visibleCodexEnvironments(req.user!.id).find(e=>e.id===req.params.id&&(e.kind==='account'||e.kind==='native')&&e.enabled);
  if(!account)return reply.code(404).send({error:'账号不存在或无权访问'});
  // The implicit host environment is visible for creation, but its account is private.
  if(account.kind==='native'&&!canControlEnvironment(account.id,req.user!.id))return {quota:null,reason:'not_applicable'};
  try {
   const engine=await engineForEnvironment(account.id);
   return await runInCodexEngine(engine,()=>withCodexConnection(async request=>{
    const auth=await request('account/read',{});
    if(!auth.account||auth.account.type==='apiKey')return {quota:null,reason:'not_applicable',message:'此账号未登录 ChatGPT，无法读取订阅额度'};
    return {quota:codexWeeklyQuotaFromResponse(await request('account/rateLimits/read',{}))};
   }));
  }catch{return reply.code(503).send({error:'账号额度暂不可用'});}
 });
 app.get<{Params:{id:string};Querystring:{file?:string}}>('/codex/environments/:id/config-files',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write'))return;
  reply.header('Cache-Control','private, no-store');try{return await accountConfigFiles(req.params.id,req.query.file?'read':'list',req.query.file);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'读取文件失败'});}
 });
 app.put<{Params:{id:string};Body:{file?:string;content?:unknown;revision?:unknown}}>('/codex/environments/:id/config-files',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write'))return;
  reply.header('Cache-Control','private, no-store');try{return await accountConfigFiles(req.params.id,'write',req.body?.file,req.body?.content,req.body?.revision);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存文件失败'});}
 });
 app.get<{Params:{id:string}}>('/codex/environments/:id/details',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{return {details:await readCodexAccountDetails(req.params.id)};}catch(error){return reply.code(errorStatus(error)).send({error:error instanceof Error?error.message:'无法读取该用户的 Codex 详情',stage:(error as {stage?:string}).stage||'account_details'});}});
 app.get<{Params:{id:string}}>('/codex/environments/:id/usage',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{getCodexEnvironment(req.params.id);return await environmentUsage(req.params.id);}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'读取占用情况失败'});}});
 app.post<{Params:{id:string};Body:{session_ids?:unknown}}>('/codex/environments/:id/close-tabs',async(req,reply)=>{
  if(!requirePermission(req,reply,'settings','write')||!requirePermission(req,reply,'monitor','delete'))return;
  const ids=req.body?.session_ids;if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>100))return reply.code(400).send({error:'请选择 1–100 个标签页'});
  try{return {results:await closeEnvironmentTabs(req.params.id,[...new Set(ids)])};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'删除标签页失败'});}
 });
 app.post('/codex/environments',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{return {environment:await saveCodexEnvironment(req.body)};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存失败'});}});
 app.put<{Params:{id:string}}>('/codex/environments/:id',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;try{return {environment:await saveCodexEnvironment(req.body,req.params.id)};}catch(e){return reply.code(errorStatus(e)).send({error:e instanceof Error?e.message:'保存失败'});}});
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
  return {current:sessionEnvironmentId(s),environments:visibleCodexEnvironments(req.user!.id).map(e=>({...e,can_control:canControlEnvironment(e.id,req.user!.id)}))};
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
