import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { User } from '../auth.js';

export interface Context {
  user?: User;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a logged-in user; narrows ctx.user to non-null for downstream resolvers. */
export const protectedProcedure = t.procedure.use((opts) => {
  if (!opts.ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return opts.next({ ctx: { user: opts.ctx.user } });
});
