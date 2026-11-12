import {mkdirSync,lstatSync,chmodSync,writeFileSync} from 'fs';
import {createHash} from 'crypto';
import {join,dirname} from 'path';
import {tmpdir} from 'os';
import {config} from '../../../config.js';
import {assertSessionEnvironment,engineForEnvironment} from './environments.js';
import {canControlEnvironment} from '../environment-access.js';
import {runInCodexEngine,inCodexThread,engineForThread,currentCodexEngine} from './engine-context.js';
import {retryableConversationError} from '../../conversation-retry.js';
import { unlinkSync } from 'fs';
import { codexBindingFile, purgeCodexHistory } from './identity.js';
import { discoverCodexTerminal } from './terminal.js';
import { ingestAllCodexSessionBindings, backfillLegacyCodexSessionIds } from './binding.js';
import { extractCodexPromptContext } from './prompt-context.js';
import { decodeCodexText } from './text.js';
import { parseCodexMessage, codexRecordLimitWithCompaction, codexQuestionCall,codexTurnBoundary,codexHistoryReplacementIndexes } from './history.js';
import { subscribeCodexRuntimeSignals } from './runtime-signals.js';
import { shellSingleQuote } from '../shell.js';
import { codexCommand, codexPermissions, codexResources } from './commands.js';
import { capabilities, requireNative, type AgentAdapter } from '../types.js';
import { findCodexRollout } from '../../prompt-context.js';
import {ensureCodexTerminalBridge} from './terminal-bridge.js';
import {codexManagement} from './management.js';
import {applyManagedCommandDefaults} from '../management-store.js';
export const codexAdapter: AgentAdapter = {
    descriptor: { launchCommand: 'codex --dangerously-bypass-approvals-and-sandbox', terminal: { composer: true, repaintOnResize: true }, sessionHost: 'terminal', id: 'codex', label: 'Codex', presentation: { icon: 'codex', order: 20, color: '#60a5fa' }, capabilities: capabilities(['history', 'runtime', 'input', 'cancelQueuedInput', 'stream', 'controls', 'serviceTier', 'model', 'effort', 'compact', 'newConversation', 'reload', 'interrupt', 'questions', 'usage', 'statistics', 'retry', 'launch', 'resume', 'attachments', 'sharedResources', 'quota']) },
    identity: { read: session => session.codex_session_id ?? null, legacyField: 'codex_session_id', purgeHistory: purgeCodexHistory, purge: context => { if (context.session.id)
            try {
                unlinkSync(codexBindingFile(context.session.id));
            }
            catch { } }, discoverTerminal: discoverCodexTerminal, recover: () => { ingestAllCodexSessionBindings(); backfillLegacyCodexSessionIds(); } },
    history: { file: { turns: extractCodexPromptContext, relevant: line => /"type"\s*:\s*"(?:user_message|agent_message|task_complete|message|compacted)"/.test(line), locate: async context => { if(!context.nativeId)return null;const account=await (await import('./account-files.js')).environmentRollout(context);return account||findCodexRollout(context.nativeId); }, decode: decodeCodexText, project: parseCodexMessage, replacementHistory: codexHistoryReplacementIndexes, recordLimit: codexRecordLimitWithCompaction, questionCall: codexQuestionCall,turnBoundary:codexTurnBoundary }, read: async () => null },
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
        read: async (context) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).readConversationControls(requireNative(context), !!context.sharedAccess, context.force, context.actorUserId||context.session.created_by_user_id||undefined,context.projectPath)),
        validate: async (context, value) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).validateModelPreference(value)),
        apply: async (context, value) => inCodexThread(requireNative(context),async()=>(await import('./controls.js')).applyCodexModelSettings(requireNative(context), value)),
    },
    telemetry: { read: async (context) => (await import('./controls.js')).readConversationTelemetry(requireNative(context)),contextBreakdown:async context=>inCodexThread(requireNative(context),async()=>(await import('./context-breakdown.js')).readCodexContextBreakdown(context)) },
    statistics: { read: async (_context, path) => (await import('./statistics.js')).readConversationStatistics(path),readProgress:async (_context,path)=>(await import('./statistics.js')).readConversationProgress(path) },
    quota: { shutdown: async () => { await (await import('./quota.js')).shutdownCodexQuotaReader(); }, read: async (force) => (await import('./quota.js')).readCodexWeeklyQuota({ force }) },
    retry: { retryable:retryableConversationError,inspect: async (id) => inCodexThread(id,async()=>(await import('./retry.js')).inspectCodexRetry(id)), start: async (id, failed, client) => inCodexThread(id,async()=>(await import('./retry.js')).startRetryTurn(id, failed, client)) },
    input: {
        cancelQueued: async(context,clientId)=>inCodexThread(requireNative(context),async()=>(await import('./queue.js')).cancelCodexQueuedInput(requireNative(context),clientId)),
        submit: async (context, text, clientId, attachments) => {
            assertSessionEnvironment(context.session,context.actorUserId);
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
            assertSessionEnvironment(context.session);
            const owner=context.session.created_by_user_id;
            if(context.session.agent_environment_id&&owner&&canControlEnvironment(context.session.agent_environment_id,owner))context={...context,sharedAccess:true};
            if(context.session.agent_environment_id)return runInCodexEngine(await engineForEnvironment(context.session.agent_environment_id),()=>prepareCodexLaunch(context,task,instructions,resume));
            return prepareCodexLaunch(context,task,instructions,resume);
        }, ready: async (context) => { if (context.session.id)
            (await import('../../session-manager.js')).watchCodexSessionBinding(context.session.id); } },
    commands: { configure: (command, projectPath, streamSocket) => {
        const configured=applyManagedCommandDefaults('codex',command);
        return streamSocket && projectPath ? configured.replace(/(?:^|\s)(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?=\s|$)/g, ' ').trim() + ` --cd ${shellSingleQuote(projectPath)}` : codexPermissions(configured);
    }, build: codexCommand, permissions: codexPermissions, sharedResources: codexResources },
    management: codexManagement({ launchCommand: 'codex --dangerously-bypass-approvals-and-sandbox', terminal: { composer: true, repaintOnResize: true }, sessionHost: 'terminal', id: 'codex', label: 'Codex', presentation: { icon: 'codex', order: 20, color: '#60a5fa' }, capabilities: capabilities(['history', 'runtime', 'input', 'cancelQueuedInput', 'stream', 'controls', 'serviceTier', 'model', 'effort', 'compact', 'newConversation', 'reload', 'interrupt', 'questions', 'usage', 'statistics', 'retry', 'launch', 'resume', 'attachments', 'sharedResources', 'quota']) }),

};
async function prepareCodexLaunch(context:import('../types.js').AgentContext,task:string,instructions:string|undefined,resume?:boolean) {
            const streamSocket = context.sharedAccess ? (resume&&context.nativeId?(await engineForThread(context.nativeId)).socket:currentCodexEngine().socket)||null : null;
            const terminalSocket=streamSocket?await ensureCodexTerminalBridge(streamSocket):null;
            const module = await import('./stream.js');
            let nativeId = resume ? context.nativeId || undefined : undefined;
            if (streamSocket) {
                if(resume && nativeId) try {await inCodexThread(nativeId,async()=>{
                    const controls=await import('./controls.js');
                    const preference=context.session.created_by_user_id&&context.session.id?controls.readModelPreference(context.session.created_by_user_id,context.session.id):null;
                    await controls.prepareCodexModelRecovery(nativeId!,preference);
                    if(instructions)await module.configureStreamingSharedResources(nativeId!,instructions);
                });} catch(error){
                    if(error instanceof Error&&/already has an active writer/i.test(error.message)){
                        let name='当前 Engine';try{name=(await import('./environments.js')).getCodexEnvironment(context.session.agent_environment_id||'native').name;}catch{/* Retain a useful error if configuration is unavailable. */}
                        throw Error(`会话绑定的 Engine（${name}）无法恢复：原生会话已被其他 Codex 进程占用。请回到原会话继续，或先在原位置停止该会话后重试。`);
                    }
                    throw error;
                }
                else if (!resume) {
                    const preference=context.session.created_by_user_id&&context.session.id?(await import('./controls.js')).readModelPreference(context.session.created_by_user_id,context.session.id):null;
                    nativeId = await module.createStreamingCodexThread(context.projectPath!, task, instructions, preference);
                }
            }
            if (!streamSocket && !resume && context.session.created_by_user_id && context.session.id && (await import('./controls.js')).readModelPreference(context.session.created_by_user_id,context.session.id)) throw Error('所选模型无法在当前 Engine 启动');
            let terminalProfile:import('../types.js').AgentTerminalProfile|undefined;
            if(context.session.agent_environment_id&&terminalSocket){
                const tag=createHash('sha256').update(JSON.stringify([config.dbPath,context.session.created_by_user_id,context.session.agent_environment_id])).digest('hex').slice(0,16);
                const home=join(tmpdir(),`octo-client-${process.getuid?.()??'user'}-${tag}`);
                mkdirSync(home,{recursive:true,mode:0o700});const info=lstatSync(home);
                if(!info.isDirectory()||info.isSymbolicLink()||process.getuid&&info.uid!==process.getuid())throw Error('账号终端客户端目录不可用');chmodSync(home,0o700);mkdirSync(join(home,'.codex'),{recursive:true,mode:0o700});
                try{writeFileSync(join(home,'.zshrc'),'',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
                terminalProfile={home,readOnlyPaths:[dirname(terminalSocket)]};
            }
            const manager = await import('../../session-manager.js');
            return { nativeId,terminalProfile, freshMode: 'resume' as const, streamSocket:terminalSocket, bindingPath: context.session.id ? manager.codexBindingPath(context.session.id) : undefined };

}
