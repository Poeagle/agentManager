import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, protectedProcedure } from './index.js';
import { getDb } from '../db/index.js';
import { getEvents } from '../services/event-store.js';
import * as sessionManager from '../services/session-manager.js';
import { nanoid } from 'nanoid';
import { getUserTabUsage, isAdmin as isAdminUser, setProjectToolAccess, userCanUseSessionTool, userCanUseToolForProject, userProjectIds, userOwnsProject, userOwnsProjectPath, userOwnsSession } from '../auth.js';

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' | 'agent' {
  if (mode === 'terminal' || mode === 'agent') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): 'claude' | 'codex' {
  return cliType === 'codex' ? 'codex' : 'claude';
}

function canAccessSessionById(userId: string, sessionId: string): boolean {
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  return userCanUseSessionTool(userId, sessionId, normalizeCliType(session.cli_type), normalizeMode(session.mode));
}

export const appRouter = router({
  // Projects — scoped to the logged-in user.
  projects: router({
    list: protectedProcedure.query(({ ctx }) => {
      const db = getDb();
      const isAdmin = isAdminUser(ctx.user.id);
      const ids = [...userProjectIds(ctx.user.id)];
      if (!isAdmin && ids.length === 0) return [];
      return isAdmin
        ? db.prepare('SELECT * FROM projects ORDER BY name').all()
        : db.prepare(`SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids);
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
      }))
      .mutation(({ input, ctx }) => {
        if (!isAdminUser(ctx.user.id)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin only' });
        const db = getDb();
        const id = nanoid(12);
        db.prepare('INSERT INTO projects (id, name, path, description, owner_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, input.name, input.path, input.description || null, ctx.user.id);
        setProjectToolAccess({
          projectId: id,
          userId: ctx.user.id,
          canSession: true,
          canAgent: true,
          canTerminal: true,
          canClaude: true,
          canCodex: true,
          grantedBy: ctx.user.id,
        });
        return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input, ctx }) => {
        const db = getDb();
        const project = db.prepare('SELECT owner_id FROM projects WHERE id = ?').get(input.id) as { owner_id: string | null } | undefined;
        if (!project || !(isAdminUser(ctx.user.id) || project.owner_id === ctx.user.id)) {
          return { deleted: false };
        }
        const result = db.prepare('DELETE FROM projects WHERE id = ?').run(input.id);
        return { deleted: result.changes > 0 };
      }),
  }),

  // Sessions — scoped to the user's projects.
  sessions: router({
    list: protectedProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(({ input, ctx }) => {
        const sessions = sessionManager.listSessionsForUser(ctx.user.id, input?.status);
        return sessions.filter((s: any) => canAccessSessionById(ctx.user.id, s.id));
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input, ctx }) => {
        if (!canAccessSessionById(ctx.user.id, input.id)) return null;
        return sessionManager.getSession(input.id);
      }),

    create: protectedProcedure
      .input(z.object({
        projectPath: z.string(),
        task: z.string().min(1),
        projectId: z.string().optional(),
        mode: z.enum(['session', 'terminal', 'agent']).optional(),
        agentType: z.string().optional(),
        cliType: z.enum(['claude', 'codex']).optional(),
      }))
      .mutation(({ input, ctx }) => {
        const usage = getUserTabUsage(ctx.user.id);
        if (!usage.allowed) {
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `已达到活动标签页上限（${usage.limit}）` });
        }
        const mode = input.mode || 'session';
        const cliType = input.cliType || 'claude';

        const hasAccess = userOwnsProject(ctx.user.id, input.projectId) || userOwnsProjectPath(ctx.user.id, input.projectPath);
        if (!hasAccess) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Project not found or not yours' });
        }
        const project = input.projectId
          ? getDb().prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as { id: string } | undefined
          : getDb().prepare('SELECT id FROM projects WHERE path = ?').get(input.projectPath) as { id: string } | undefined;
        const projectId = project?.id || undefined;
        if (!userCanUseToolForProject(ctx.user.id, projectId, mode, cliType)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Project not found or not yours' });
        }

        if (mode === 'agent' && !input.agentType) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'agentType is required for agent mode' });
        }

        const session = sessionManager.createSession(input.projectPath, input.task, projectId, cliType, ctx.user.id, mode, input.agentType);
        if (mode === 'terminal') {
          sessionManager.spawnTerminal(session.id, input.projectPath);
        } else if (mode === 'agent') {
          sessionManager.spawnAgent(session.id, input.projectPath, input.task, input.agentType!, 180, 40, cliType);
        } else {
          sessionManager.spawnSession(session.id, input.projectPath, input.task, 180, 40, cliType);
        }
        return session;
      }),

    kill: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input, ctx }) => {
        if (!canAccessSessionById(ctx.user.id, input.id)) throw new TRPCError({ code: 'NOT_FOUND' });
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
        if (input?.sessionId && !canAccessSessionById(ctx.user.id, input.sessionId)) return [];
        const events = getEvents({
          session_id: input?.sessionId,
          type: input?.type,
          limit: input?.limit,
          since: input?.since,
        });
        if (isAdminUser(ctx.user.id)) return events;
        return events.filter((e: any) => e.session_id && userOwnsSession(ctx.user.id, e.session_id));
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
