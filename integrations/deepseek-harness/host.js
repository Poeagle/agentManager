import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  parentOrigins: z.array(z.string()).default([]),
});

export function apply(ctx, config) {
  const origins = config.parentOrigins.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
      throw new Error('OctoAlly parentOrigins must contain exact HTTP(S) origins without a trailing slash.');
    }
    return url.origin;
  });
  ctx.on('webserver/index-inject', (table, peer) => {
    if (peer?.principal?.kind === 'owner') {
      table.push({ kind: 'global', name: '__OCTOALLY_HARNESS_PARENT_ORIGINS__', value: origins });
    }
  });
}
