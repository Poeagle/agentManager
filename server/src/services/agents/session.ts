import { getDb } from '../../db/index.js';
import { agentContext, agentForSession } from './index.js';
import { canUseSessionEnvironment } from './environment-access.js';
import type { AgentSession, AgentContext, AgentRuntime } from './types.js';
export function sessionAgentContext(session: AgentSession, options: Partial<AgentContext> = {}): AgentContext {
    let projectPath = session.project_path ?? null;
    if (!projectPath && session.project_id)
        try {
            projectPath = (getDb().prepare('SELECT path FROM projects WHERE id=?').get(session.project_id) as {
                path: string;
            } | undefined)?.path ?? null;
        }
        catch { /* File-only adapter callers need no application database. */ }
    const actor=options.actorUserId||session.created_by_user_id||undefined;
    return agentContext(session, {
        projectPath,
        ...options,
        ...(actor?{environmentAccess:(environmentId:string)=>canUseSessionEnvironment({...session,agent_environment_id:environmentId},actor)}:{}),
    });
}
export function presentAgentSession(session: AgentSession) { const adapter = agentForSession(session); return { agent: adapter.descriptor, agent_id: adapter.descriptor.id, native_session_id: session.native_session_id ?? adapter.identity.read(session) }; }
export async function readAgentRuntime(session: AgentSession, verifyProcess = false) { return agentForSession(session).runtime.read(sessionAgentContext(session, { verifyProcess })); }

export function canReplaceAgentConversation(runtime: AgentRuntime | null): boolean {
    return !!runtime && ['ready', 'idle', 'interrupted', 'failed'].includes(runtime.state);
}
