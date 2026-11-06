import { AGENT_FEATURES } from './types.js';
import { resolveAgent } from './define.js';
import type { AgentDefinition, AgentAdapter, AgentContext, AgentDescriptor, AgentSession } from './types.js';
const adapters = new Map<string, AgentAdapter>();
export function registerAgent(definition: AgentDefinition): () => void {
    const adapter = resolveAgent(definition);
    const id = adapter.descriptor.id;
    if (!['terminal', 'managed'].includes(adapter.descriptor.sessionHost))
        throw Error(`Invalid session host: ${id}`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id))
        throw Error('Invalid agent identifier');
    for (const feature of ['input', 'history', 'stream', 'runtime'] as const)
        if (!adapter.descriptor.capabilities[feature])
            throw Error(`Agent must implement conversation capability ${feature}: ${id}`);
    if (adapters.has(id))
        throw Error(`Agent already registered: ${id}`);
    for (const feature of AGENT_FEATURES)
        if (typeof adapter.descriptor.capabilities[feature] !== 'boolean')
            throw Error(`Missing capability ${feature}: ${id}`);
    const required = (value: unknown, port: string) => { if (typeof value !== 'function')
        throw Error(`Missing agent implementation ${id}.${port}`); };
    required(definition.runtime?.read, 'runtime.read');
    required(definition.input?.submit, 'input.submit');
    required(definition.stream?.observe, 'stream.observe');
    if (!definition.history?.file && !definition.history?.read)
        throw Error(`Missing agent implementation ${id}.history`);
    if(definition.history?.file)for(const method of ['locate','decode','project','recordLimit','questionCall','relevant','turns'] as const)required(definition.history.file[method],`history.file.${method}`);
    else required(definition.history?.read,'history.read');
    const features: Array<[
        import('./types.js').AgentFeature,
        unknown,
        string
    ]> = [
        ['controls', definition.controls?.read, 'controls.read'], ['serviceTier', definition.controls?.validate, 'controls.validate'], ['serviceTier', definition.controls?.apply, 'controls.apply'], ['model', definition.controls?.validate, 'controls.validate'], ['model', definition.controls?.apply, 'controls.apply'],
        ['usage', definition.telemetry?.read, 'telemetry.read'], ['statistics', definition.statistics?.read, 'statistics.read'], ['quota', definition.quota?.read, 'quota.read'],
        ['retry',definition.retry?.retryable,'retry.retryable'],['retry', definition.retry?.inspect, 'retry.inspect'], ['retry', definition.retry?.start, 'retry.start'], ['compact', definition.lifecycle?.compact, 'lifecycle.compact'],
        ['newConversation', definition.lifecycle?.prepareFresh, 'lifecycle.prepareFresh'], ['interrupt', definition.lifecycle?.interrupt, 'lifecycle.interrupt'], ['launch', definition.launch?.prepare, 'launch.prepare'], ['resume', definition.launch?.prepare, 'launch.prepare'],
    ];
    for (const [feature, implementation, port] of features)
        if (adapter.descriptor.capabilities[feature])
            required(implementation, port);
    if (adapter.descriptor.sessionHost === 'terminal')
        required(definition.commands?.build, 'commands.build');
    adapters.set(id, adapter);
    return () => { if (adapters.get(id) === adapter)
        {adapters.delete(id);void adapter.stream.shutdown?.();} };
}
export function getAgent(id: string): AgentAdapter { const adapter = adapters.get(id); if (!adapter)
    throw Object.assign(Error(`Unknown agent: ${id}`), { statusCode: 400 }); return adapter; }
export function agentForSession(session: AgentSession): AgentAdapter { return getAgent(session.agent_id || session.cli_type || (session.codex_session_id && !session.claude_session_id ? 'codex' : 'claude')); }
export function agentContext(session: AgentSession, options: Partial<Omit<AgentContext, 'session' | 'nativeId'>> = {}): AgentContext {
    const adapter = agentForSession(session);
    return { session, nativeId: session.native_session_id ?? adapter.identity.read(session), projectPath: session.project_path ?? null, ...options };
}
export function agentDescriptors(): AgentDescriptor[] { return [...adapters.values()].map(adapter => adapter.descriptor); }
