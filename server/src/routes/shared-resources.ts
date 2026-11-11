import type { FastifyPluginAsync } from 'fastify';
import { realpathSync, readdirSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { getDb } from '../db/index.js';
import { isAdmin, userOwnsProject, userOwnsFilesystemPath } from '../auth.js';
import { canonicalDirectory, canonicalEnvFile, createSharedEnv, deleteSharedResources, getSharedResources, openSharedEnv, writeSharedEnv, saveSharedResources, SharedResourceError, sharedResourcesSchema, withinDirectory } from '../services/shared-resources/store.js';
import { z } from 'zod';

function projectsInScope(userId: string, scope: string) {
  const root = canonicalDirectory(scope);
  return (getDb().prepare('SELECT id, name, path FROM projects').all() as Array<{ id: string; name: string; path: string }>)
    .filter(project => {
      if (!userOwnsProject(userId, project.id)) return false;
      try { return withinDirectory(root, realpathSync(project.path)); } catch { return false; }
    });
}

export const sharedResourceRoutes: FastifyPluginAsync = async app => {
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof SharedResourceError) return reply.code(error.status).send({ error: error.message });
    // Filesystem errors and validation input must never reach logs
    // or the response: they can contain resource values.
    return reply.code(503).send({ error: '共享资源操作失败，请检查目录权限后重试' });
  });

  app.get('/me/shared-resources', async req => ({ resources: getSharedResources(req.user!.id) }));
  const assertCurrentDirectory=(userId:string)=>{
    const resource=getSharedResources(userId);if(!resource.directory)throw new SharedResourceError('请先选择共享工作目录');
    const directory=canonicalDirectory(resource.directory);
    if(!isAdmin(userId)&&!projectsInScope(userId,directory).length)throw new SharedResourceError('该目录未获授权或无访问权限',403);
    const file=canonicalEnvFile(resource.env_file,directory);
    const owner=(getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>).flatMap(p=>{try{const root=realpathSync(p.path);return withinDirectory(root,file)?[{id:p.id,path:root}]:[];}catch{return [];}}).sort((a,b)=>b.path.length-a.path.length)[0];
    if(owner&&!userOwnsProject(userId,owner.id))throw new SharedResourceError('该目录未获授权或无访问权限',403);
  };
  app.get<{Querystring:{path?:string}}>('/me/shared-resources/browse',async(req,reply)=>{
    const roots=(getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>).filter(p=>userOwnsProject(req.user!.id,p.id)).flatMap(p=>{try{return [realpathSync(p.path)];}catch{return [];}});
    const requested=req.query.path||(isAdmin(req.user!.id)?homedir():roots[0]?dirname(roots[0]):homedir());if(!isAbsolute(requested))return reply.code(400).send({error:'请填写有效的绝对目录路径'});
    let path:string;try{path=realpathSync(requested);}catch{return reply.code(400).send({error:'该目录未获授权或无访问权限'});}
    const allowed=(p:string)=>isAdmin(req.user!.id)||roots.some(root=>withinDirectory(p,root))||userOwnsFilesystemPath(req.user!.id,p);
    if(!allowed(path))return reply.code(403).send({error:'该目录未获授权或无访问权限'});
    try{const dirs=readdirSync(path,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='node_modules').flatMap(e=>{try{const child=realpathSync(join(path,e.name));return allowed(child)?[{name:e.name,path:child,hasChildren:true}]:[];}catch{return [];}}).sort((a,b)=>a.name.localeCompare(b.name));return {path,parent:path==='/'?null:dirname(path),folderName:basename(path),dirs};}catch{return reply.code(403).send({error:'该目录未获授权或无访问权限'});}
  });

  app.post<{ Body: { scope_path: string } }>('/me/shared-resources/preview', async (req, reply) => {
    if (typeof req.body?.scope_path !== 'string') return reply.code(400).send({ error: '请填写生效范围' });
    return { projects: projectsInScope(req.user!.id, req.body.scope_path) };
  });

  app.put('/me/shared-resources', async (req, reply) => {
    const parsed = sharedResourcesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '请检查共享目录、凭据文件和使用提示词' });
    const input = parsed.data;
    const directory = canonicalDirectory(input.directory);
    const scope = canonicalDirectory(input.scope_path || directory);
    if (!isAdmin(req.user!.id) && (!userOwnsFilesystemPath(req.user!.id,directory)||!projectsInScope(req.user!.id, directory).length || !projectsInScope(req.user!.id, scope).length)) {
      return reply.code(403).send({ error: '该目录未获授权或无访问权限' });
    }
    const file = canonicalEnvFile(input.env_file || join(directory,'.env'), directory);
    const containing = (getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>)
      .flatMap(project => { try { const path=realpathSync(project.path); return withinDirectory(path,file)?[{id:project.id,path}]:[]; } catch { return []; } })
      .sort((a,b)=>b.path.length-a.path.length)[0];
    if (containing && !userOwnsProject(req.user!.id, containing.id)) return reply.code(403).send({error:'凭据文件位于未获授权的项目中'});
    const resources = saveSharedResources(req.user!.id, { ...input, directory, scope_path: scope, env_file:file });
    return { resources, projects: projectsInScope(req.user!.id, scope) };
  });

  app.delete('/me/shared-resources', async req => { deleteSharedResources(req.user!.id); return { ok: true }; });

  app.post('/me/shared-resources/env/open', async req => {assertCurrentDirectory(req.user!.id);return openSharedEnv(req.user!.id);});
  app.post('/me/shared-resources/env/create', async req => {assertCurrentDirectory(req.user!.id);return createSharedEnv(req.user!.id);});

  app.put('/me/shared-resources/env', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = z.object({ content: z.string(), expected_hash: z.string().length(64).nullable(), revision: z.number().int().positive() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '凭据文件保存参数无效' });
    assertCurrentDirectory(req.user!.id);
    return writeSharedEnv(req.user!.id, parsed.data);
  });
};
