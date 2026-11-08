import { NATIVE_SESSION_ID_RE } from '../native-identifiers.js';
import { open } from 'fs/promises';
import { join } from 'path';
import { resolveClaudeDir } from './archive.js';
import { publicTokenCounters } from '../../conversation-usage.js';
import type { AgentCompaction } from '../events.js';
import type { AgentContext, AgentControls, AgentRuntime, ModelPreference } from '../types.js';
const cache = new Map<string, {
    size: number;
    inode: number;
    mtime: number;
    partial: Buffer;
    model: string | null;
    modelAt: string | null;
    last: string | null;
    state: AgentRuntime['state'];
    usage: AgentControls['usage'];
    compaction: AgentCompaction | null;
}>();
async function metadata(context: AgentContext) {
    const directory = context.projectPath ? resolveClaudeDir(context.projectPath) : null;
    const empty = { compaction: null as AgentCompaction | null, model: null as string | null, modelAt: null as string | null, last: null as string | null, state: 'unknown' as AgentRuntime['state'], usage: null as AgentControls['usage'] };
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
                    state.usage = { total: publicTokenCounters(null), last: publicTokenCounters({ input_tokens: input + read + write, cached_input_tokens: read, output_tokens: output, total_tokens: input + read + write + output }), window: null };
                }
                state.state = record.message?.stop_reason === 'end_turn' ? 'idle' : 'running';
            }
            else if (record.type === 'user' && typeof record.message?.content === 'string')
                state.state = 'running';
            else if (record.type === 'system' && record.subtype === 'turn_duration')
                state.state = 'idle';
            else if (record.type === 'system' && record.subtype === 'compact_boundary') {
                state.state = 'idle';
                state.compaction = { id: record.uuid || `compact:${record.timestamp}`, status: 'completed', started_at: null, completed_at: record.timestamp || null, duration_ms: null };
            }
        }
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
    const { getTracker } = await import('../../session-state.js');
    const tracker = context.session.id ? getTracker(context.session.id)?.state : null;
    const state = tracker?.processState === 'waiting_for_input' ? 'waiting_for_input' : tracker?.processState === 'busy' ? 'running' : value.state;
    return { source: 'claude_history', session_id: context.nativeId, state, last_activity_at: value.last, observed_at: new Date().toISOString(), reason: '依据 Claude 原生历史和当前客户端状态', pending_question_count: 0, pending_questions: [], compaction: value.compaction };
}
/** Claude Code's built-in aliases. */
const aliases = ['default', 'sonnet', 'opus', 'haiku'];
/** Custom models reach Claude Code through the ANTHROPIC_* model env vars (a
 * gateway deployment) instead of an alias, so they must be offered explicitly
 * or the dashboard cannot select them at all. */
function configuredModels(): string[] {
    return [...new Set(['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']
        .map(key => process.env[key]?.trim())
        .filter((value): value is string => !!value && !value.startsWith('<') && !aliases.includes(value)))];
}
export async function readClaudeControls(context: AgentContext): Promise<AgentControls> {
    const value = await metadata(context);
    const runtime=context.nativeId?(await import('./sdk-runtime.js')).claudeRuntime(context.nativeId):undefined;
    const loaded=!!runtime;
    const seen = new Set<string>();
    const models = [...configuredModels(), ...aliases]
        .filter(model => !seen.has(model) && (seen.add(model), true))
        .map(model => ({ model, name: model, description: aliases.includes(model) ? 'Claude 原生模型别名' : '网关配置的模型', efforts: [{ value: '', description: '由原生客户端决定' }], defaultEffort: '' }));
    if (value.model && !models.some(model => model.model === value.model))
        models.unshift({ model: value.model, name: value.model, description: '当前原生模型', efforts: [{ value: '', description: '由原生客户端决定' }], defaultEffort: '' });
    return { model_observed_at: value.modelAt, model: value.model, effort: null, provider: 'anthropic', cwd: context.projectPath, cli_version: null, engine_version: null, installed_cli_version: null, git: null, state: loaded ? runtime!.runtime().state : 'notLoaded', permission: 'bypassPermissions', approval: null, service_tier: null, usage: value.usage, limits: [], usage_observed_at: value.last, models, loaded, warning: loaded ? null : 'Claude managed runtime is not connected; durable history remains available.', native_id: context.nativeId || '', checked_at: new Date().toISOString() };
}
export async function validateClaudeControls(_context: AgentContext, value: unknown): Promise<ModelPreference> {
    const p = value as ModelPreference;
    const allowed = new Set([...aliases, ...configuredModels()]);
    if (!p || typeof p !== 'object' || Object.keys(p).some(key => !['model', 'effort'].includes(key)) || typeof p.model !== 'string' || !allowed.has(p.model) || p.effort !== '')
        throw Error('请选择 Claude 支持的模型；推理强度由原生客户端管理');
    return { model: p.model, effort: '' };
}
export async function applyClaudeControls(context: AgentContext, value: ModelPreference) {
    if(!context.nativeId)throw Error('会话尚未连接');
    const runtime=(await import('./sdk-runtime.js')).claudeRuntime(context.nativeId);
    if(!runtime)throw Error('Claude managed runtime is not connected');
    if(runtime.runtime().state==='running')throw Error('请等待 Claude 空闲后再切换模型');
    runtime.setModel(value);
    return {...value,pending:false};
}
export async function compactClaudeConversation() { throw Error('Claude managed runtime does not expose manual compaction'); }
/** Usage events only read the bounded native metadata cache; no process-tree scan. */
export async function readClaudeTelemetry(context: AgentContext) { const value = await metadata(context); return { usage: value.usage, observed_at: value.last }; }
export function confirmedClaudeControls(_context: AgentContext, value: ModelPreference, controls: AgentControls, submittedAt: string): boolean {
    if (!controls.model_observed_at || Date.parse(controls.model_observed_at) < Date.parse(submittedAt))
        return false;
    return controls.model === value.model || ['sonnet', 'opus', 'haiku'].includes(value.model) && !!controls.model?.split('-').includes(value.model);
}
