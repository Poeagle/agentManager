import { getSession, reloadCodexSessionById } from '../../session-manager.js';
import { isAdmin } from '../../../auth.js';
import { readCodexRuntime } from './runtime.js';
import { withCodexConnection } from './stream.js';
export class CodexStreamingUpgradeError extends Error {
    readonly submission = 'rejected';
}
export async function ensureCodexConversationStreaming(sessionId: string): Promise<boolean> {
    const session = getSession(sessionId);
    if (!session || session.cli_type !== 'codex' || !session.codex_session_id || !(process.env.AGENTMANAGER_CODEX_STREAM_SOCKET && (!session.created_by_user_id || isAdmin(session.created_by_user_id))))
        return false;
    if ((await readCodexRuntime(session.codex_session_id)).state !== 'idle')
        return false;
    const result = await reloadCodexSessionById(sessionId, { idleOnly: true });
    if (!result.ok)
        throw new CodexStreamingUpgradeError(result.error || '接入实时输出失败，消息尚未提交');
    try {
        await withCodexConnection(async (request) => {
            // The wrapper may become ready before its terminal client attaches. The
            // legacy engine has exited, so resuming this exact thread is now safe.
            const current = await request('thread/read', { threadId: session.codex_session_id });
            if (current.thread?.status?.type === 'notLoaded')
                await request('thread/resume', { threadId: session.codex_session_id, excludeTurns: true });
        });
    }
    catch {
        throw new CodexStreamingUpgradeError('实时输出通道尚未连接，消息尚未提交，请稍后重试');
    }
    return true;
}
