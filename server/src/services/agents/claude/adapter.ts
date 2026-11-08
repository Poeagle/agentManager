import { purgeClaudeIdentity } from './identity.js';
import { extractClaudePromptContext } from './prompt-context.js';
import { decodeClaudeText } from './text.js';
import { parseClaudeMessage, claudeRecordLimit } from './history.js';
import { NATIVE_SESSION_ID_RE } from '../native-identifiers.js';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { resolveClaudeDir } from './archive.js';
import { claudeCommand, claudePermissions, claudeResources } from './commands.js';
import { capabilities, requireNative, type AgentDefinition } from '../types.js';
import { readClaudeControls, readClaudeRuntime, applyClaudeControls, validateClaudeControls, compactClaudeConversation, readClaudeTelemetry, confirmedClaudeControls } from './controls.js';
export const claudeAdapter: AgentDefinition = {
    descriptor: { sessionHost: 'managed', id: 'claude', label: 'Claude', presentation: { icon: 'claude', order: 10, color: '#D97757' }, capabilities: capabilities(['history', 'runtime', 'input', 'stream', 'controls', 'model', 'newConversation', 'reload', 'interrupt', 'usage', 'launch', 'resume', 'attachments', 'sharedResources']) },
    identity: {
        read: session => session.native_session_id ?? session.claude_session_id ?? null,
        legacyField: 'claude_session_id',
        purge: purgeClaudeIdentity,
        matchesProcess: args => ['claude', 'claude-code'].includes(args[0]?.split('/').at(-1)?.toLowerCase() || ''),
    },
    history: { file: { turns: extractClaudePromptContext, relevant: line => /"type"\s*:\s*"(?:user|assistant|system)"/.test(line), locate: async (context) => { if (!context.nativeId || !NATIVE_SESSION_ID_RE.test(context.nativeId) || !context.projectPath)
                return null; const directory = resolveClaudeDir(context.projectPath); return directory ? join(directory, `${context.nativeId}.jsonl`) : null; }, decode: decodeClaudeText, project: parseClaudeMessage, recordLimit: claudeRecordLimit, questionCall: () => null }, read: async () => null },
    runtime: { read: async context => (await import('./sdk-runtime.js')).claudeRuntime(requireNative(context))?.runtime()??readClaudeRuntime(context), subscribe: () => () => { } },
    controls: { confirmed: confirmedClaudeControls, read: readClaudeControls, validate: validateClaudeControls, apply: applyClaudeControls },
    telemetry: { read: readClaudeTelemetry },
    input: { submit: async (context,text,clientId,attachments) => {
        const runtime=(await import('./sdk-runtime.js')).ensureClaudeRuntime(requireNative(context),context.projectPath!,undefined,undefined,true);
        return runtime.submit(text,clientId,attachments);
    }, afterTerminalSubmit: async () => { } },
    stream: { observe: asyncObserve },
    lifecycle: { bind: async () => { }, preflight: async (context) => { const agent = await (await import('../../platform-ai/agents.js')).detectWorkAgent('claude', context.projectPath || undefined, true); if (agent.status === 'unavailable')
            throw Error(agent.reason); return null; }, compact: compactClaudeConversation, prepareFresh: async () => randomUUID(), release: async context => { if(context.nativeId)(await import('./sdk-runtime.js')).releaseClaudeRuntime(context.nativeId); }, interrupt: async context => { if(context.nativeId)await (await import('./sdk-runtime.js')).claudeRuntime(context.nativeId)?.interrupt(); } },
    launch: { prepare: async (context, task, instructions, resume) => {
        const nativeId=resume ? context.nativeId || undefined : randomUUID();
        if(!nativeId||!context.projectPath)throw Error('Claude managed session is missing project context');
        const runtime=(await import('./sdk-runtime.js')).ensureClaudeRuntime(nativeId,context.projectPath,instructions,undefined,!!resume);
        if(!resume)await runtime.submit(task);
        return {nativeId};
    }, ready: async () => { } },
    commands: { configure: claudePermissions, build: claudeCommand, permissions: claudePermissions, sharedResources: claudeResources },
};

function asyncObserve(context:Parameters<NonNullable<AgentDefinition['stream']['observe']>>[0],emit:Parameters<NonNullable<AgentDefinition['stream']['observe']>>[1]){
    let stop:ReturnType<typeof import('./sdk-runtime.js')['observeClaudeSDK']>|undefined,closed=false;
    void import('./sdk-runtime.js').then(module=>{if(!closed)stop=module.observeClaudeSDK(context,emit);});
    return Object.assign(()=>{closed=true;stop?.();},{respond:(id:string,answer:unknown)=>{if(!stop)throw Error('Claude 实时连接尚未就绪');return stop.respond(id,answer);}});
}
