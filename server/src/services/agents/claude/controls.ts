import { NATIVE_SESSION_ID_RE } from '../native-identifiers.js';
import { getDb } from '../../../db/index.js';
import { open } from 'fs/promises';
import { join } from 'path';
import { resolveClaudeDir } from './archive.js';
import { publicTokenCounters } from '../../conversation-usage.js';
import type { AgentCompaction } from '../events.js';
import type { AgentContext, AgentControls, AgentRuntime, ModelPreference } from '../types.js';
import { managedEnv } from '../environment-store.js';
import { readClaudeRuntimeProvider } from './providers.js';
import { providerModelMetadata } from '../provider-pricing.js';
const cache = new Map<string, {
    size: number;
    inode: number;
    mtime: number;
    partial: Buffer;
    model: string | null;
    modelAt: string | null;
    requestCount: number;
    lastUsage: {input_tokens:number;cached_input_tokens:number;output_tokens:number;total_tokens:number};
    totalUsage: {input_tokens:number;cached_input_tokens:number;output_tokens:number;total_tokens:number};
    endedAt:string|null;
    last: string | null;
    state: AgentRuntime['state'];
    usage: AgentControls['usage'];
    compaction: AgentCompaction | null;
    compactionAt:string|null;
}>();
const sessionModelKey = (sessionId: string) =>
    `claude_session_model:${sessionId}`;
export function captureClaudeFreshRollback(context: AgentContext): () => void {
    const sessionId=context.session.id;
    if(!sessionId)return ()=>{};
    const key=sessionModelKey(sessionId),row=getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined;
    return ()=>{if(row)getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,row.value);
      else getDb().prepare('DELETE FROM settings WHERE key=?').run(key);};
}
export function readClaudeSessionModelPreference(
    context: AgentContext,
): ModelPreference | null {
    const sessionId = context.session.id;
    if (!sessionId) return null;
    let row: { value: string } | undefined;
    try {
        row = getDb()
            .prepare('SELECT value FROM settings WHERE key=?')
            .get(sessionModelKey(sessionId)) as { value: string } | undefined;
    } catch {
        return null;
    }
    try {
        const value = JSON.parse(row?.value || 'null');
        return value &&
            typeof value.model === 'string' &&
            value.model &&
            value.effort === ''
            ? { model: value.model, effort: '' }
            : null;
    } catch {
        return null;
    }
}
export function saveClaudeSessionModelPreference(
    context: AgentContext,
    value: ModelPreference,
) {
    const sessionId = context.session.id;
    if (!sessionId) return;
    try {
        getDb()
            .prepare(
                "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(
                sessionModelKey(sessionId),
                JSON.stringify({ model: value.model, effort: '' }),
            );
    } catch {
        // File-only adapter fixtures do not have a database.
    }
}
async function metadata(context: AgentContext) {
    const directory = context.projectPath ? resolveClaudeDir(context.projectPath) : null;
    const empty = { endedAt:null as string|null, compaction: null as AgentCompaction | null, compactionAt:null as string|null, model: null as string | null, modelAt: null as string | null, requestCount:0, lastUsage:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0}, totalUsage:{input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0}, last: null as string | null, state: 'unknown' as AgentRuntime['state'], usage: null as AgentControls['usage'] };
    if (!directory || !context.nativeId || !NATIVE_SESSION_ID_RE.test(context.nativeId))
        return empty;
    const path = join(directory, `${context.nativeId}.jsonl`);
    const file = await open(path, 'r').catch(() => null);
    if (!file)
        return empty;
    try {
        const stat = await file.stat(), previous = cache.get(path);
        if (previous?.size === stat.size && previous.inode === stat.ino && previous.mtime === stat.mtimeMs)
            return previous;
        const resume = previous && previous.inode === stat.ino && previous.size < stat.size;
        const start = resume ? Math.max(previous.size, stat.size - 2 * 1024 * 1024) : Math.max(0, stat.size - 2 * 1024 * 1024);
        const state = resume ? { ...previous } : { ...empty };
        const bytes = Buffer.alloc(stat.size - start);
        await file.read(bytes, 0, bytes.length, start);
        const combined = resume && start === previous.size ? Buffer.concat([previous.partial, bytes]) : bytes;
        const first = start === 0 || resume && start === previous.size ? 0 : combined.indexOf(10) + 1, last = combined.lastIndexOf(10) + 1;
        for (const line of combined.subarray(first, last).toString('utf8').split('\n')) {
            if (line.length > 512 * 1024)
                continue;
            let record: any;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof record.timestamp === 'string')
                state.last = record.timestamp;
            if (record.type === 'assistant') {
                // Claude Code writes synthetic bookkeeping records (model ===
                // '<synthetic>') for errors and internal turns. They are not real
                // model selections and must never become the observed model.
                const model = record.message?.model;
                if (typeof model === 'string' && model && !model.startsWith('<')) {
                    state.model = model;
                    state.modelAt = record.timestamp || null;
                }
                const usage = record.message?.usage;
                if (usage) {
                    const input = Number(usage.input_tokens) || 0, read = Number(usage.cache_read_input_tokens) || 0, write = Number(usage.cache_creation_input_tokens) || 0, output = Number(usage.output_tokens) || 0;
                    state.requestCount++;
                    state.lastUsage = {input_tokens: input + read + write, cached_input_tokens: read, output_tokens: output, total_tokens: input + read + write + output};
                    state.totalUsage.input_tokens += input + read + write;
                    state.totalUsage.cached_input_tokens += read;
                    state.totalUsage.output_tokens += output;
                    state.totalUsage.total_tokens += input + read + write + output;
                }
                state.state = record.message?.stop_reason === 'end_turn' ? 'idle' : 'running';
                state.endedAt=state.state==='idle'&&typeof record.timestamp==='string'?record.timestamp:null;
            }
            else if (record.type === 'user' && typeof record.message?.content === 'string'){state.state='running';state.endedAt=null;}
            else if (record.type === 'system' && record.subtype === 'turn_duration'){state.state='idle';state.endedAt=typeof record.timestamp==='string'?record.timestamp:null;}
            else if (record.type === 'system' && record.subtype === 'compact_boundary') {
                state.state = 'idle';
                const duration=Number(record.compactMetadata?.durationMs),ended=typeof record.timestamp==='string'?record.timestamp:null;
                state.compaction = { id: record.uuid || `compact:${record.timestamp}`, status: 'completed', started_at: ended&&Number.isFinite(duration)?new Date(Date.parse(ended)-duration).toISOString():ended, completed_at:ended, duration_ms: Number.isFinite(duration)?duration:null };
                state.compactionAt = record.timestamp || null;
            }
        }
        state.usage = state.requestCount ? {
            total: publicTokenCounters(state.totalUsage),
            last: publicTokenCounters(state.lastUsage),
            window: null as number | null,
        } : null;
        const value = { ...state, size: stat.size, inode: stat.ino, mtime: stat.mtimeMs, partial: Buffer.from(combined.subarray(last)) };
        cache.set(path, value);
        if (cache.size > 64)
            cache.delete(cache.keys().next().value!);
        return value;
    }
    finally {
        await file.close();
    }
}
export async function readClaudeRuntime(context: AgentContext): Promise<AgentRuntime> {
    const value = await metadata(context);
    // A managed SDK session has no PTY. Only a detached native transcript may be
    // augmented by terminal prompt detection; a stale tracker cannot keep a
    // completed managed turn running.
    const { getTracker } = await import('../../session-state.js');
    const tracker = context.session.id ? getTracker(context.session.id)?.state : null;
    const state =
      value.state === 'unknown' && tracker?.processState === 'waiting_for_input'
        ? 'waiting_for_input'
        : value.state === 'unknown' && tracker?.processState === 'busy'
          ? 'running'
          : value.state;
    return { source: 'claude_history', session_id: context.nativeId, state, last_activity_at: value.last, last_turn_ended_at:value.endedAt, observed_at: new Date().toISOString(), reason: '依据 Claude 原生历史', pending_question_count: 0, pending_questions: [], compaction: value.compaction };
}
/** Claude Code's built-in aliases. */
const aliases = ['default', 'sonnet', 'opus', 'haiku'];
/** Custom models reach Claude Code through the ANTHROPIC_* model env vars (a
 * gateway deployment) instead of an alias, so they must be offered explicitly
 * or the dashboard cannot select them at all. */
function configuredModels(context?:Pick<AgentContext,'session'|'environmentAccess'>): string[] {
    const providerModels=context?.session?readClaudeRuntimeProvider(context.session,context.environmentAccess)?.models:undefined;
    if(providerModels?.length)return providerModels;
    return [...new Set(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']
        .map(key => managedEnv(key).trim())
        .filter((value): value is string => !!value && !value.startsWith('<') && !aliases.includes(value)))];
}
export async function readClaudeControls(context: AgentContext): Promise<AgentControls> {
    let value = await metadata(context);
    const runtime=context.nativeId?(await import('./sdk-runtime.js')).claudeRuntime(context.nativeId):undefined;
    const loaded=!!runtime;
    const provider=readClaudeRuntimeProvider(context.session,context.environmentAccess);
    if(value.usage&&value.usage.window==null&&provider?.contextWindow){
        value={...value,usage:{total:value.usage.total,last:value.usage.last,window:provider.contextWindow}};
    }
    const seen = new Set<string>();
    const providerModels=provider?.models||[];
    const models:AgentControls['models'] = [...providerModels, ...(provider?[]:aliases)]
        .filter(model => !seen.has(model) && (seen.add(model), true))
        .map(model => ({ model, name: model, description: provider ? `${provider.name} · Provider 模型` : aliases.includes(model) ? 'Claude 原生模型别名' : '网关配置的模型', context_window:provider?.contextWindow??null, max_output_tokens:provider?.maxOutputTokens??null, input_modalities:['text','image'], efforts: [{ value: '', description: '由原生客户端决定' }], defaultEffort: '' }));
    if (!provider&&value.model && !models.some(model => model.model === value.model))
        models.unshift({ model: value.model, name: value.model, description: '当前原生模型', context_window:null, max_output_tokens:null, input_modalities:['text','image'], efforts: [{ value: '', description: '由原生客户端决定' }], defaultEffort: '' });
    for(const model of models){
        const details=providerModelMetadata(model.model,provider?.baseUrl,provider?.billingFields);
        Object.assign(model,details,{context_window:model.context_window??details.context_window,input_modalities:details.input_modalities??(!provider?['text','image']:undefined)});
    }
    const persisted=readClaudeSessionModelPreference(context);
    const selected=persisted&&(!provider||provider.models.includes(persisted.model))?persisted.model:runtime?.selectedModel()||provider?.defaultModel||value.model;
    return { supports_fresh_model:true, model_observed_at: value.modelAt, model: selected, effort: '', provider: provider?.id||'anthropic', cwd: context.projectPath, cli_version: null, engine_version: null, installed_cli_version: null, git: null, state: loaded ? runtime!.runtime().state : 'notLoaded', permission: 'bypassPermissions', approval: null, service_tier: null, usage: value.usage, limits: [], usage_observed_at: value.last, models, loaded, warning: loaded ? null : 'Claude managed runtime is not connected; durable history remains available.', native_id: context.nativeId || '', checked_at: new Date().toISOString() };
}
export async function validateClaudeControls(context: AgentContext, value: unknown): Promise<ModelPreference> {
    const p = value && typeof value === 'object' ? value as Partial<ModelPreference> : null;
    const provider=readClaudeRuntimeProvider(context.session,context.environmentAccess);
    const allowed = new Set([...(provider?[]:aliases), ...configuredModels(context)]);
    if(provider)return {model:typeof p?.model==='string'?p.model:provider.defaultModel||'',effort:''};
    if (!p || typeof p !== 'object' || !Object.keys(p).every(key => ['model', 'effort'].includes(key)) || typeof p.model !== 'string' || !allowed.has(p.model) || p.effort !== '')
        throw Error('请选择 Claude 支持的模型；推理强度由原生客户端管理');
    return { model: p.model, effort: '' };
}
export async function applyClaudeControls(context: AgentContext, value: ModelPreference, options?: { nextTurn?: boolean }) {
    if(!context.nativeId)throw Error('会话尚未连接');
    const runtime=(await import('./sdk-runtime.js')).claudeRuntime(context.nativeId);
    if(!runtime)throw Error('Claude managed runtime is not connected');
    const provider=readClaudeRuntimeProvider(context.session,context.environmentAccess);
    (await import('./providers.js')).assertClaudeSelectedModel(provider,value.model);
    runtime.setModel(value, options?.nextTurn);
    saveClaudeSessionModelPreference(context,value);
    return {...value,pending:false};
}
export async function compactClaudeConversation(context: AgentContext) {
    if(!context.nativeId) throw Error('会话尚未连接');
    const runtime=(await import('./sdk-runtime.js')).claudeRuntime(context.nativeId);
    if(!runtime) throw Error('Claude managed runtime is not connected');
    await runtime.compact();
}
/** Usage events only read the bounded native metadata cache; no process-tree scan. */
export async function readClaudeTelemetry(context: AgentContext) { const value = await metadata(context); return { usage: value.usage, observed_at: value.last }; }
export function confirmedClaudeControls(_context: AgentContext, value: ModelPreference, controls: AgentControls, submittedAt: string): boolean {
    if (!controls.model_observed_at || Date.parse(controls.model_observed_at) < Date.parse(submittedAt))
        return false;
    return controls.model === value.model || ['sonnet', 'opus', 'haiku'].includes(value.model) && !!controls.model?.split('-').includes(value.model);
}
