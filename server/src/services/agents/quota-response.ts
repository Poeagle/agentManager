import type {FastifyReply} from 'fastify';
/** A working agent may have no account-level quota API (e.g. API key billing). */
export class AgentQuotaNotApplicable extends Error {
  readonly reason = 'not_applicable';
  constructor(message = '当前认证方式不提供账号额度，请在服务商后台查看用量') { super(message); }
}
export async function sendAgentQuota(reply:FastifyReply, read:()=>Promise<unknown>) {
  reply.header('Cache-Control','private, no-store');
  try { return {quota:await read()}; }
  catch(error) {
    if(error instanceof AgentQuotaNotApplicable) return {quota:null,reason:error.reason,message:error.message};
    return reply.code(503).send({quota:null,reason:'unavailable',error:'额度服务暂不可用，请稍后重试'});
  }
}
