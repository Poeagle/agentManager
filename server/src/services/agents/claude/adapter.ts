import { discoverClaudeTerminal, watchClaudeTerminal, captureClaudeTerminal, purgeClaudeIdentity } from './identity.js';
import { extractClaudePromptContext } from './prompt-context.js';
import { decodeClaudeText } from './text.js';
import { parseClaudeMessage, claudeRecordLimit } from './history.js';
import { NATIVE_SESSION_ID_RE } from '../native-identifiers.js';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { resolveClaudeDir } from './archive.js';
import { claudeCommand, claudePermissions, claudeResources } from './commands.js';
import { capabilities, UnsupportedAgentFeature, type AgentDefinition } from '../types.js';
import { readClaudeControls, readClaudeRuntime, applyClaudeControls, validateClaudeControls, compactClaudeConversation, readClaudeTelemetry, confirmedClaudeControls } from './controls.js';
const unsupported = (feature: ConstructorParameters<typeof UnsupportedAgentFeature>[1]) => { throw new UnsupportedAgentFeature('claude', feature); };
export const claudeAdapter: AgentDefinition = {
    descriptor: { terminal: { composer: true, repaintOnResize: false }, sessionHost: 'terminal', id: 'claude', label: 'Claude', presentation: { icon: 'claude', order: 10, color: '#D97757' }, capabilities: capabilities(['history', 'runtime', 'input', 'stream', 'controls', 'model', 'compact', 'newConversation', 'reload', 'interrupt', 'usage', 'launch', 'resume', 'attachments', 'sharedResources']) },
    identity: { read: session => session.claude_session_id ?? null, legacyField: 'claude_session_id', purge: purgeClaudeIdentity, discoverTerminal: discoverClaudeTerminal, watchTerminal: watchClaudeTerminal, captureTerminal: captureClaudeTerminal },
    history: { file: { turns: extractClaudePromptContext, relevant: line => /"type"\s*:\s*"(?:user|assistant|system)"/.test(line), locate: async (context) => { if (!context.nativeId || !NATIVE_SESSION_ID_RE.test(context.nativeId) || !context.projectPath)
                return null; const directory = resolveClaudeDir(context.projectPath); return directory ? join(directory, `${context.nativeId}.jsonl`) : null; }, decode: decodeClaudeText, project: parseClaudeMessage, recordLimit: claudeRecordLimit, questionCall: () => null }, read: async () => null },
    runtime: { read: readClaudeRuntime, subscribe: () => () => { } },
    controls: { confirmed: confirmedClaudeControls, read: readClaudeControls, validate: validateClaudeControls, apply: applyClaudeControls },
    telemetry: { read: readClaudeTelemetry },
    input: { submit: async () => false, afterTerminalSubmit: async () => { } },
    stream: { observe: (_context, emit) => { emit({ type: 'unavailable', reason: '当前客户端通过原生历史事件同步；已完成消息会自动更新' }); return Object.assign(() => { }, { respond: () => unsupported('questions') }); } },
    lifecycle: { bind: async () => { }, preflight: async (context) => { const agent = await (await import('../../platform-ai/agents.js')).detectWorkAgent('claude', context.projectPath || undefined, true); if (agent.status === 'unavailable')
            throw Error(agent.reason); return null; }, compact: compactClaudeConversation, prepareFresh: async () => randomUUID(), release: async () => { }, interrupt: async (context) => { if (context.session.id)
            (await import('../../session-manager.js')).writeToSession(context.session.id, '\u0003', false); } },
    launch: { prepare: async (context, _task, _instructions, resume) => ({ nativeId: resume ? context.nativeId || undefined : randomUUID(), preSpawnFiles: context.projectPath ? (await import('../../session-manager.js')).snapshotClaudeSessionFiles(context.projectPath) : undefined }), ready: async () => { } },
    commands: { configure: claudePermissions, build: claudeCommand, permissions: claudePermissions, sharedResources: claudeResources },
};
