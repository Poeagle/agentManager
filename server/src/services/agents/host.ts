import { agentForSession } from './index.js';
import { sessionAgentContext } from './session.js';
import { getDb } from '../../db/index.js';
import { broadcastEphemeral } from '../event-store.js';
import type { AgentSession } from './types.js';
import type { AgentStreamFrame } from './events.js';
type Connection = {
    (): void;
    respond(id: string, answer: unknown): unknown;
};
type Failure = (turnId: string, error: unknown, willRetry: boolean) => void;
type Host = {
    agentId: string;
    failures: Set<Failure>;
    nativeId: string;
    stop: Connection;
    listeners: Set<(frame: AgentStreamFrame) => void>;
    latest: Map<string, AgentStreamFrame>;
};
const hosts = new Map<string, Host>();
export function isManagedAgentActive(sessionId: string) { return hosts.has(sessionId); }
/** Attach to an existing service/SDK runtime. This must not create a native
 * session or send a prompt; native execution belongs to launch.prepare. */
export function attachManagedAgent(session: AgentSession & {
    id: string;
}): void {
    const adapter = agentForSession(session), context = sessionAgentContext(session);
    if (adapter.descriptor.sessionHost !== 'managed' || !context.nativeId)
        throw Error('Agent service identity is unavailable');
    const current = hosts.get(session.id);
    if (current?.nativeId === context.nativeId && current.agentId === adapter.descriptor.id)
        return;
    detachManagedAgent(session.id);
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined, last = '', scheduled = '';
    const entry: Host = { agentId: adapter.descriptor.id, nativeId: context.nativeId, stop: Object.assign(() => { }, { respond: () => { throw Error('Agent service is connecting'); } }), listeners: new Set(), failures: new Set(), latest: new Map() };
    hosts.set(session.id, entry);
    async function publish() {
        timer = undefined;
        try {
            const runtime = await adapter.runtime.read(context);
            if (closed)
                return;
            const fingerprint = JSON.stringify([runtime.state, runtime.pending_questions, runtime.submitted_question_ids, runtime.queued_answer_count]);
            if (last === fingerprint)
                return;
            last = fingerprint;
            broadcastEphemeral({ type: 'session.runtime', session_id: session.id, ...session.project_id ? { project_id: session.project_id } : {}, data: { runtime } });
        }
        catch { /* The next native lifecycle event retries; no polling is added. */ }
    }
    const notify = (frame: AgentStreamFrame) => {
        if (closed)
            return;
        entry.latest.set(frame.type, frame);
        if (entry.latest.size > 4)
            entry.latest.delete(entry.latest.keys().next().value!);
        for (const listener of entry.listeners)
            listener(frame);
        const fingerprint = frame.type === 'snapshot' ? JSON.stringify([frame.busy, frame.interactions.map(request => [request.id, request.submitted])]) : frame.type === 'queue' ? JSON.stringify(frame.messages.map(message => message.client_id)) : null;
        if (fingerprint !== null && scheduled !== fingerprint) {
            scheduled = fingerprint;
            if (!timer)
                timer = setTimeout(() => void publish(), 80);
        }
    };
    let connection: Connection;
    try {
        connection = adapter.stream.observe(context, notify, (...args) => { if (!closed)
            for (const listener of entry.failures)
                listener(...args); });
    }
    catch (error) {
        hosts.delete(session.id);
        throw error;
    }
    entry.stop = Object.assign(() => { closed = true; clearTimeout(timer); connection(); }, { respond: connection.respond });
    try {
        getDb().prepare("UPDATE sessions SET status='running',pid=NULL,updated_at=datetime('now') WHERE id=?").run(session.id);
    }
    catch (error) {
        detachManagedAgent(session.id);
        throw error;
    }
    void publish();
}
export function observeAgentConversation(session: AgentSession & {
    id: string;
}, emit: (frame: AgentStreamFrame) => void, onFailure?: (turnId: string, error: unknown, willRetry: boolean) => void): Connection {
    const adapter = agentForSession(session);
    if (adapter.descriptor.sessionHost !== 'managed')
        return adapter.stream.observe(sessionAgentContext(session), emit, onFailure);
    attachManagedAgent(session);
    const entry = hosts.get(session.id)!;
    entry.listeners.add(emit);
    if (onFailure)
        entry.failures.add(onFailure);
    for (const frame of entry.latest.values())
        emit(frame);
    return Object.assign(() => { entry.listeners.delete(emit); if (onFailure)
        entry.failures.delete(onFailure); }, { respond: (id: string, answer: unknown) => entry.stop.respond(id, answer) });
}
export function detachManagedAgent(id: string) { const host = hosts.get(id); if (!host)
    return; hosts.delete(id); host.stop(); }
export function detachManagedAgents() { for (const id of hosts.keys())
    detachManagedAgent(id); }
