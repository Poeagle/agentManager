import { withCodexConnection } from './stream.js';
import { disqualified, RetrySuperseded, instruction,retryableConversationError } from '../../conversation-retry.js';
export async function inspectRetryThread(nativeId: string): Promise<{state:string;turn:any;queued:boolean}> {
    return withCodexConnection(async (request) => {
        const current = await request('thread/read', { threadId: nativeId });
        const state = current.thread?.status?.type;
        if (state === 'notLoaded')
            return { state, turn: null, queued: false };
        const [turns, queue] = await Promise.all([
            request('thread/turns/list', { threadId: nativeId, limit: 1, itemsView: 'summary' }),
            request('thread/queue/list', { threadId: nativeId, limit: 1 }),
        ]);
        return { state, turn: turns.data?.[0] ?? null, queued: !!queue.data?.length };
    });
}
/** Recheck immediately before submitting on the same connection. There is no
 * transport retry: losing the response leaves the outcome explicitly unknown. */
export async function startRetryTurn(nativeId: string, failedTurnId: string, clientId: string): Promise<string> {
    return withCodexConnection(async (request) => {
        const current = await request('thread/read', { threadId: nativeId });
        const turns = await request('thread/turns/list', { threadId: nativeId, limit: 1, itemsView: 'summary' });
        const queue = await request('thread/queue/list', { threadId: nativeId, limit: 1 });
        const reason = disqualified(normalizeCodexRetry({ state: current.thread?.status?.type, turn: turns.data?.[0], queued: !!queue.data?.length }), failedTurnId);
        if (reason)
            throw new RetrySuperseded(reason);
        const result = await request('turn/start', { threadId: nativeId, clientUserMessageId: clientId, input: [{ type: 'text', text: instruction, text_elements: [] }], turnTrigger: 'auto', parentTurnId: failedTurnId, rootTurnId: turns.data[0].rootTurnId ?? failedTurnId });
        if (typeof result.turn?.id !== 'string')
            throw new Error('Retry acceptance was not confirmed');
        return result.turn.id;
    });
}

/** Convert protocol fields once at the native boundary. */
export function normalizeCodexRetry(snapshot:{state:string;turn:any;queued:boolean}):import('../types.js').AgentRetrySnapshot{
 const turn=snapshot.turn;
 return {state:['idle','systemError'].includes(snapshot.state)?'idle':snapshot.state==='active'?'busy':'unavailable',queued:snapshot.queued,turn:turn?{
  id:turn.id,status:turn.status==='inProgress'?'running':['completed','failed','interrupted'].includes(turn.status)?turn.status:'unknown',
  retryable:retryableConversationError(turn.error),
  has_final:!!turn.items?.some((item:any)=>item.type==='agentMessage'&&item.phase==='final_answer'&&item.delivery!=='async'&&!(Array.isArray(item.questions)&&item.questions.length)&&item.text?.trim()),
  user_client_ids:(turn.items||[]).filter((item:any)=>item.type==='userMessage').map((item:any)=>item.clientId??null),
 }:null};
}
export async function inspectCodexRetry(nativeId:string){return normalizeCodexRetry(await inspectRetryThread(nativeId));}
