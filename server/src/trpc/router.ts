import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from './index.js';
import { getDb } from '../db/index.js';
import { getEvents } from '../services/event-store.js';
import * as sessionManager from '../services/session-manager.js';
import { nanoid } from 'nanoid';
import { userProjectIds, userOwnsProject, userOwnsProjectPath, userOwnsSession } from '../auth.js';

export const appRouter = router({
  // Projects — scoped to the logged-in user.
  projects: router({
    list: protectedProcedure.query(({ ctx }) => {
      return getDb().prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY name').all(ctx.user.id);
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
      }))
      .mutation(({ input, ctx }) => {
        const db = getDb();
        const id = nanoid(12);
        db.prepare('INSERT INTO projects (id, name, path, description, owner_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, input.name, input.path, input.description || null, ctx.user.id);
        return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input, ctx }) => {
        const result = getDb().prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(input.id, ctx.user.id);
        return { deleted: result.changes > 0 };
      }),
  }),

  // Sessions — scoped to the user's projects.
  sessions: router({
    list: protectedProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(({ input, ctx }) => {
        const owned = userProjectIds(ctx.user.id);
        return sessionManager.listSessions(input?.status).filter((s: any) => s.project_id && owned.has(s.project_id));
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input, ctx }) => {
        if (!userOwnsSession(ctx.user.id, input.id)) return null;
        return sessionManager.getSession(input.id);
      }),

    create: protectedProcedure
      .input(z.object({
        projectPath: z.string(),
        task: z.string().min(1),
        projectId: z.string().optional(),
        cliType: z.enum(['claude', 'codex']).optional(),
      }))
      .mutation(({ input, ctx }) => {
        if (!userOwnsProject(ctx.user.id, input.projectId) && !userOwnsProjectPath(ctx.user.id, input.projectPath)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Project not found or not yours' });
        }
        const cliType = input.cliType || 'claude';
        const session = sessionManager.createSession(input.projectPath, input.task, input.projectId, cliType);
        sessionManager.spawnSession(session.id, input.projectPath, input.task, 180, 40, cliType);
        return session;
      }),

    kill: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input, ctx }) => {
        if (!userOwnsSession(ctx.user.id, input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
        return { killed: sessionManager.killSession(input.id) };
      }),
  }),

  // Events — scoped to the user's projects.
  events: router({
    list: protectedProcedure
      .input(z.object({
        sessionId: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().optional(),
        since: z.string().optional(),
      }).optional())
      .query(({ input, ctx }) => {
        const owned = userProjectIds(ctx.user.id);
        if (input?.sessionId && !userOwnsSession(ctx.user.id, input.sessionId)) return [];
        const events = getEvents({
          session_id: input?.sessionId,
          type: input?.type,
          limit: input?.limit,
          since: input?.since,
        });
        return input?.sessionId ? events : events.filter((e: any) => e.project_id && owned.has(e.project_id));
      }),
  }),

  // Health — public.
  health: publicProcedure.query(() => ({
    name: 'agentmanager',
    version: '0.1.0',
    status: 'running',
    uptime: process.uptime(),
  })),
});

export type AppRouter = typeof appRouter;
