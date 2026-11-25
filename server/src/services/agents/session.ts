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
export function sessionAccountLabels() {
    const labels = new Map<string, string | undefined>();
    // Callers authorize access to the session environment before reading its name.
    return (session: AgentSession): { agent_account_label?: string } => {
        try {
            const { descriptor, identity } = agentForSession(session);
            if (!identity.accountLabel) return {};
            if (session.mode === 'terminal' && !session.agent_environment_id && !(session.native_session_id ?? identity.read(session))) return {};
            const key = JSON.stringify([descriptor.id, session.agent_environment_id ?? null]);
            if (!labels.has(key)) labels.set(key, identity.accountLabel(session)?.trim() || undefined);
            const label = labels.get(key);
            return label ? { agent_account_label: label } : {};
        } catch {
            // A missing or outdated configuration leaves the account unknown.
            return {};
        }
    };
}

export async function readAgentRuntime(session: AgentSession, verifyProcess = false) { return agentForSession(session).runtime.read(sessionAgentContext(session, { verifyProcess })); }

export function canReplaceAgentConversation(runtime: AgentRuntime | null): boolean {
    return !!runtime && ['ready', 'idle', 'interrupted', 'failed'].includes(runtime.state);
}
