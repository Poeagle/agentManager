import {inCodexThread,engineForThread,currentCodexEngine} from './engine-context.js';
import {retryableConversationError} from '../../conversation-retry.js';
import { unlinkSync } from 'fs';
import { codexBindingFile } from './identity.js';
import { discoverCodexTerminal } from './terminal.js';
import { ingestAllCodexSessionBindings, backfillLegacyCodexSessionIds } from './binding.js';
import { extractCodexPromptContext } from './prompt-context.js';
import { decodeCodexText } from './text.js';
import { parseCodexMessage, codexRecordLimit, codexQuestionCall,codexTurnBoundary } from './history.js';
import { subscribeCodexRuntimeSignals } from './runtime-signals.js';
import { shellSingleQuote } from '../shell.js';
import { codexCommand, codexPermissions, codexResources } from './commands.js';
import { capabilities, requireNative, type AgentAdapter } from '../types.js';
import { findCodexRollout } from '../../prompt-context.js';
import {ensureCodexTerminalBridge} from './terminal-bridge.js';
export const codexAdapter: AgentAdapter = {
    descriptor: { terminal: { composer: true, repaintOnResize: true }, sessionHost: 'terminal', id: 'codex', label: 'Codex', presentation: { icon: 'codex', order: 20, color: '#60a5fa' }, capabilities: capabilities(['history', 'runtime', 'input', 'cancelQueuedInput', 'stream', 'controls', 'serviceTier', 'model', 'effort', 'compact', 'newConversation', 'reload', 'interrupt', 'questions', 'usage', 'statistics', 'retry', 'launch', 'resume', 'attachments', 'sharedResources', 'quota']) },
    identity: { read: session => session.codex_session_id ?? null, legacyField: 'codex_session_id', purge: context => { if (context.session.id)
            try {
                unlinkSync(codexBindingFile(context.session.id));
            }
            catch { } }, discoverTerminal: discoverCodexTerminal, recover: () => { ingestAllCodexSessionBindings(); backfillLegacyCodexSessionIds(); } },
    history: { file: { turns: extractCodexPromptContext, relevant: line => /"type"\s*:\s*"(?:user_message|agent_message|task_complete|message)"/.test(line), locate: context => context.nativeId ? findCodexRollout(context.nativeId) : Promise.resolve(null), decode: decodeCodexText, project: parseCodexMessage, recordLimit: codexRecordLimit, questionCall: codexQuestionCall,turnBoundary:codexTurnBoundary }, read: async () => null },
    runtime: { subscribe: (context, changed) => subscribeCodexRuntimeSignals(id => { if (id === context.nativeId)
            changed(); }), read: async (context) => {
            const module=await import('./runtime.js');
            const tracker=context.session.id?(await import('../../session-state.js')).getTracker(context.session.id)?.state:undefined;
            if(tracker?.processState==='waiting_for_input'&&module.codexStartupConflict(tracker.choices))return {source:'codex_terminal',session_id:context.nativeId,state:'waiting_for_input',last_activity_at:new Date(tracker.lastActivity).toISOString(),observed_at:new Date().toISOString(),reason:'Codex 启动配置与后台服务冲突，请在原始终端选择不使用 daemon；平台不会自动重启共享服务'};
            const runtime = await module.readCodexRuntime(context.nativeId);
            if (context.verifyProcess && context.session.id && runtime.source === 'codex_rollout' && ['running', 'waiting_for_input'].includes(runtime.state) && await (await import('../../session-manager.js')).getLiveWorkAgent(context.session.id) !== 'codex')
                return { ...runtime, state: 'unknown', reason: '原生记录尚未结束，但未确认到对应 Codex 进程' };
            return runtime;
        } },
    controls: {
        confirmed: (_context,value,data) => data.loaded&&data.model===value.model&&data.effort===value.effort&&(!value.provider||value.provider===data.provider)&&(value.service_tier===undefined||value.service_tier===(data.service_tier||'default')),
        read: async (context) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).readConversationControls(requireNative(context), !!context.sharedAccess, context.force)),
        validate: async (context, value) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).validateModelPreference(value)),
        apply: async (context, value) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).applyCodexModelSettings(requireNative(context), value)),
    },
    telemetry: { read: async (context) => (await import('./controls.js')).readConversationTelemetry(requireNative(context)) },
    statistics: { read: async (_context, path) => (await import('./statistics.js')).readConversationStatistics(path) },
    quota: { shutdown: async () => { await (await import('./quota.js')).shutdownCodexQuotaReader(); }, read: async (force) => (await import('./quota.js')).readCodexWeeklyQuota({ force }) },
    retry: { retryable:retryableConversationError,inspect: async (id) => inCodexThread(id,async()=>(await import('./retry.js')).inspectCodexRetry(id)), start: async (id, failed, client) => inCodexThread(id,async()=>(await import('./retry.js')).startRetryTurn(id, failed, client)) },
    input: {
        cancelQueued: async(context,clientId)=>inCodexThread(requireNative(context),async()=>(await import('./queue.js')).cancelCodexQueuedInput(requireNative(context),clientId)),
        submit: async (context, text, clientId, attachments) => {
            const stream = await import('./stream.js');
            const submit = () => inCodexThread(requireNative(context),()=>attachments?.length ? stream.submitStreamingCodexInput(requireNative(context), text, clientId, attachments) : clientId ? stream.submitStreamingCodexInput(requireNative(context), text, clientId) : stream.submitStreamingCodexInput(requireNative(context), text));
            let result = process.env.AGENTMANAGER_CODEX_STREAM_SOCKET ? await submit() : false;
            if (!result && context.session.id && (await import('../../session-manager.js')).ensureCodexConversationStreaming && await (await import('../../session-manager.js')).ensureCodexConversationStreaming(context.session.id))
                result = await submit();
            return result;
        },
        afterTerminalSubmit: async (context) => { if (context.session.id)
            await (await import('./streaming-upgrade.js')).scheduleCodexStreamingUpgrade(context.session.id); },
    },
    stream: { enable: async (context) => !!context.session.id && await (await import('./streaming-upgrade.js')).scheduleCodexStreamingUpgrade(context.session.id), shutdown: async () => { (await import('./streaming-upgrade.js')).stopCodexStreamingUpgrades(); }, observe: (context, emit, onFailure) => {
            let stopped = false, stop: ({
                (): void;
                respond(id: string, answer: unknown): unknown;
            }) | undefined;
            void inCodexThread(requireNative(context),async()=>{const module=await import('./stream.js');if(!stopped)stop=module.observeCodexConversation(requireNative(context),emit,onFailure,{incremental:true});}).catch(()=>{if(!stopped)emit({type:'unavailable',reason:'对应模型服务的实时引擎暂不可用',retrying:true});});
            return Object.assign(() => { stopped = true; stop?.(); }, { respond: (id: string, answer: unknown) => { if (!stop)
                    throw Error('实时连接尚未就绪'); return stop.respond(id, answer); } });
        } },
    lifecycle: {
        bind: async (context, nativeId) => { if (context.session.id)
            (await import('./identity.js')).persistCodexBinding(context.session.id, nativeId); },
        preflight: async (context) => context.nativeId?inCodexThread(context.nativeId,async()=>(await import('./version.js')).prepareCodexReload(!!context.sharedAccess && !!currentCodexEngine().socket)):(await import('./version.js')).prepareCodexReload(!!context.sharedAccess && !!currentCodexEngine().socket),
        compact: async (context) => inCodexThread(requireNative(context),async()=>(await import('./actions.js')).compactCodexConversation(requireNative(context))),
        prepareFresh: async (context, instructions, preference) => inCodexThread(requireNative(context),async()=>(await import('./actions.js')).prepareFreshCodexConversation(requireNative(context), context.projectPath!, instructions,preference)),
        release: async (context) => inCodexThread(requireNative(context),async()=>(await import('./actions.js')).releaseCodexConversation(requireNative(context))),
        interrupt: async (context) => { if (context.nativeId && process.env.AGENTMANAGER_CODEX_STREAM_SOCKET)
            await inCodexThread(context.nativeId,async()=>(await import('./stream.js')).interruptStreamingCodexThread(context.nativeId!)); },
    },
    launch: { prepare: async (context, task, instructions, resume) => {
            const streamSocket = context.sharedAccess ? (resume&&context.nativeId?(await engineForThread(context.nativeId)).socket:currentCodexEngine().socket)||null : null;
            const terminalSocket=streamSocket?await ensureCodexTerminalBridge(streamSocket):null;
            const module = await import('./stream.js');
            let nativeId = resume ? context.nativeId || undefined : undefined;
            if (streamSocket) {
                if(resume && nativeId) await inCodexThread(nativeId,async()=>{
                    const controls=await import('./controls.js');
                    const preference=context.session.created_by_user_id&&context.session.id?controls.readModelPreference(context.session.created_by_user_id,context.session.id):null;
                    await controls.prepareCodexModelRecovery(nativeId!,preference);
                    if(instructions)await module.configureStreamingSharedResources(nativeId!,instructions);
                });
                else if (!resume)
                    nativeId = await module.createStreamingCodexThread(context.projectPath!, task, instructions);
            }
            const manager = await import('../../session-manager.js');
            return { nativeId, freshMode: 'resume', streamSocket:terminalSocket, bindingPath: context.session.id ? manager.codexBindingPath(context.session.id) : undefined };
        }, ready: async (context) => { if (context.session.id)
            (await import('../../session-manager.js')).watchCodexSessionBinding(context.session.id); } },
    commands: { configure: (command, projectPath, streamSocket) => streamSocket && projectPath ? command.replace(/(?:^|\s)(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?=\s|$)/g, ' ').trim() + ` --cd ${shellSingleQuote(projectPath)}` : codexPermissions(command), build: codexCommand, permissions: codexPermissions, sharedResources: codexResources },
};
