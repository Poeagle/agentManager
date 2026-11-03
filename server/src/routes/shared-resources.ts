import type { FastifyPluginAsync } from 'fastify';
import { realpathSync } from 'fs';
import { getDb } from '../db/index.js';
import { isAdmin, userOwnsProject } from '../auth.js';
import { canonicalDirectory, canonicalEnvFile, deleteSharedResources, getSharedResources, openSharedEnv, writeSharedEnv, saveSharedResources, SharedResourceError, sharedResourcesSchema, withinDirectory } from '../services/shared-resources/store.js';
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

  app.post<{ Body: { scope_path: string } }>('/me/shared-resources/preview', async (req, reply) => {
    if (typeof req.body?.scope_path !== 'string') return reply.code(400).send({ error: '请填写生效范围' });
    return { projects: projectsInScope(req.user!.id, req.body.scope_path) };
  });

  app.put('/me/shared-resources', async (req, reply) => {
    const parsed = sharedResourcesSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '请检查共享目录、凭据文件和使用提示词' });
    const input = parsed.data;
    const directory = canonicalDirectory(input.directory);
    const scope = canonicalDirectory(input.scope_path);
    if (!isAdmin(req.user!.id) && (!projectsInScope(req.user!.id, directory).length || !projectsInScope(req.user!.id, scope).length)) {
      return reply.code(403).send({ error: '共享目录和生效范围须包含你已获授权的项目' });
    }
    const file = canonicalEnvFile(input.env_file, directory);
    const containing = (getDb().prepare('SELECT id,path FROM projects').all() as Array<{id:string;path:string}>)
      .flatMap(project => { try { const path=realpathSync(project.path); return withinDirectory(path,file)?[{id:project.id,path}]:[]; } catch { return []; } })
      .sort((a,b)=>b.path.length-a.path.length)[0];
    if (containing && !userOwnsProject(req.user!.id, containing.id)) return reply.code(403).send({error:'凭据文件位于未获授权的项目中'});
    const resources = saveSharedResources(req.user!.id, { ...input, directory, scope_path: scope });
    return { resources, projects: projectsInScope(req.user!.id, scope) };
  });

  app.delete('/me/shared-resources', async req => { deleteSharedResources(req.user!.id); return { ok: true }; });

  app.post('/me/shared-resources/env/open', async req => openSharedEnv(req.user!.id));

  app.put('/me/shared-resources/env', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const parsed = z.object({ content: z.string(), expected_hash: z.string().length(64).nullable(), revision: z.number().int().positive() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '凭据文件保存参数无效' });
    return writeSharedEnv(req.user!.id, parsed.data);
  });
};
