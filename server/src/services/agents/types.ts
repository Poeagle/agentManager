import type { ConversationAttachment } from '../conversation-attachments.js';
import type { AgentStreamFrame } from './events.js';
/** Provider identifiers are open strings; registering a provider does not
 * require changing a discriminated union in platform code. */
export type AgentId = string;
export const AGENT_FEATURES = ['history', 'runtime', 'input', 'stream', 'controls', 'model', 'effort', 'compact', 'newConversation', 'reload', 'interrupt', 'questions', 'usage', 'statistics', 'retry', 'launch', 'resume', 'attachments', 'sharedResources', 'quota'] as const;
export type AgentFeature = typeof AGENT_FEATURES[number];
export type AgentCapabilities = Record<AgentFeature, boolean>;
export interface AgentDescriptor {
    terminal?: {
        composer: boolean;
        repaintOnResize: boolean;
    };
    sessionHost: 'terminal' | 'managed';
    id: AgentId;
    label: string;
    capabilities: AgentCapabilities;
    presentation: {
        icon: string;
        color: string;
        order?: number;
    };
}
export interface AgentSession {
    id?: string;
    agent_id?: string | null;
    cli_type?: string | null;
    native_session_id?: string | null;
    codex_session_id?: string | null;
    claude_session_id?: string | null;
    project_path?: string | null;
    project_id?: string | null;
    created_by_user_id?: string | null;
    status?: string;
}
export interface AgentContext {
    session: AgentSession;
    nativeId: string | null;
    projectPath: string | null;
    sharedAccess?: boolean;
    force?: boolean;
    verifyProcess?: boolean;
}
export interface AgentAsyncQuestion {
    id?: string;
    title: string;
    options: string[] | null;
}
export interface AgentQuestionReply {
    question_id: string;
    question: string;
    answer: string;
}
export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: string | null;
    turn_id?: string;
    statistics?: AgentStatistics;
    streaming?: boolean;
    queued?: boolean;
    phase?: 'commentary' | 'final' | 'error';
    error?: {
        code?: string;
        will_retry: boolean;
    };
    client_id?: string;
    sequence?: number;
    attachments?: ConversationAttachment[];
    image_paths?: string[];
    async_questions?: AgentAsyncQuestion[];
    question_replies?: AgentQuestionReply[];
}
export interface AgentTextMessage {
    role: 'user' | 'assistant';
    phase: 'user' | 'commentary' | 'final';
    text: string;
    timestamp: string | null;
    task_reference?: string | null;
}
export interface ModelPreference {
    model: string;
    effort: string;
}
export interface AgentRuntime {
    source: string;
    session_id: string | null;
    state: 'ready' | 'running' | 'idle' | 'waiting_for_input' | 'interrupted' | 'failed' | 'unknown';
    last_activity_at: string | null;
    observed_at: string;
    reason: string;
    completed_turn_id?: string;
    compaction?: import('./events.js').AgentCompaction | null;
    pending_question_count?: number;
    submitted_question_ids?: string[];
    queued_answer_count?: number;
    pending_questions?: Array<{
        id: string;
        questions: Array<{
            id?: string;
            title: string;
            options: string[] | null;
        }>;
        timestamp: string | null;
        turn_id?: string;
    }>;
}
export interface AgentModel {
    model: string;
    name: string;
    description: string;
    efforts: Array<{
        value: string;
        description: string;
    }>;
    defaultEffort: string;
}
export interface AgentStatisticsInterval {
    tokens: Record<string, number | null> | null;
    requests: number;
    tool_calls: number;
    tool_rounds: number;
    complete: boolean;
    shared_messages: number;
}
export interface AgentStatistics {
    sequence: number;
    message_id?: string;
    turn_id: string;
    tokens: Record<string, number | null> | null;
    requests: number;
    tool_calls: number;
    tool_rounds: number;
    complete: boolean;
    interval?: AgentStatisticsInterval;
    conclusion?: (AgentStatisticsInterval & {
        start_at: string | null;
        end_at: string | null;
        elapsed_ms: number | null;
    });
}
export interface AgentControls {
    model_observed_at?: string | null;
    model: string | null;
    effort: string | null;
    provider: string | null;
    cwd: string | null;
    cli_version: string | null;
    engine_version: string | null;
    installed_cli_version: string | null;
    git: {
        branch: string;
        changes: number;
    } | null;
    state: string | null;
    permission: string | null;
    approval: string | null;
    service_tier: string | null;
    usage: {
        total: Record<string, number | null>;
        last: Record<string, number | null>;
        window: number | null;
    } | null;
    limits: Array<{
        used_percent: number;
        minutes: number;
        resets_at: number | null;
    }>;
    usage_observed_at: string | null;
    models: AgentModel[];
    loaded: boolean;
    warning: string | null;
    native_id: string;
    checked_at: string;
}
export interface AgentCommandOptions {
    task: string;
    direct?: boolean;
    command?: string;
    resumeId?: string;
    assignId?: string;
    bindingPath?: string;
    streamSocket?: string | null;
}
export interface AgentHistoryQuery {
    after?: string;
    before?: string;
    limit?: number;
}
export interface AgentHistoryPage {
    messages: AgentMessage[];
    statistics?: AgentStatistics[];
    has_more: boolean;
    reset: boolean;
    available: boolean;
    generation: string | null;
}
export interface AgentHistoryRecord {
    message: {
        role: 'user' | 'assistant';
        phase?: 'user' | 'commentary' | 'final' | 'error';
        text: string;
        timestamp: string | null;
    };
    failure?: AgentMessage | null;
    itemId?: string;
    turnId?: string;
    recordType: string;
    asyncQuestions?: AgentMessage['async_questions'];
    questionReplies?: AgentMessage['question_replies'];
    imagePaths: string[];
}
/** File codecs are an optional persistence strategy, never a requirement for
 * an HTTP/SDK agent. Only the generic bounded file reader consumes this port. */
export interface AgentFileHistoryPort {
    locate(context: AgentContext): Promise<string | null>;
    decode(entries: Iterable<unknown>, limit?: number): AgentTextMessage[];
    project(record: Buffer, questionCallId?: string): AgentHistoryRecord | null;
    recordLimit(prefix: Buffer): number;
    questionCall(record: Buffer): {
        id: string;
        turnId?: string;
        signature: string;
    } | null;
    relevant(line: string): boolean;
    turns(entries: Iterable<unknown>, rounds: number): Array<{
        user: string;
        assistant: string;
    }>;
}
export interface AgentHistoryPort {
    read(context: AgentContext, query: AgentHistoryQuery): Promise<AgentHistoryPage | null>;
    file?: AgentFileHistoryPort;
    context?(context: AgentContext, rounds: number): Promise<Array<{
        user: string;
        assistant: string;
    }>>;
}
export interface AgentRuntimePort {
    read(context: AgentContext): Promise<AgentRuntime>;
    subscribe(context: AgentContext, changed: () => void): () => void;
}
export interface AgentControlsPort {
    confirmed?(context: AgentContext, value: ModelPreference, controls: AgentControls, submittedAt: string): boolean;
    read(context: AgentContext): Promise<AgentControls>;
    validate(context: AgentContext, value: unknown): Promise<ModelPreference>;
    apply(context: AgentContext, value: ModelPreference): Promise<AgentControlResult>;
}
export interface AgentTelemetryPort {
    read(context: AgentContext): Promise<{
        usage: AgentControls['usage'];
        observed_at: string | null;
    }>;
}
export interface AgentStatisticsPort {
    read(context: AgentContext, path: string): Promise<AgentStatistics[]>;
}
export interface AgentQuotaPort {
    shutdown?(): void | Promise<void>;
    read(force?: boolean): Promise<{
        usedPercent: number;
        remainingPercent: number;
        windowDurationMins: number;
        resetsAt: number | null;
        planType: string | null;
        checkedAt: string;
        stale?: boolean;
    }>;
}
/** Retry policy consumes normalized execution facts, never native item syntax. */
export interface AgentRetrySnapshot {
 state:'idle'|'busy'|'unavailable';queued:boolean;
 turn:{id:string;status:'running'|'completed'|'failed'|'interrupted'|'unknown';retryable:boolean;has_final:boolean;user_client_ids:Array<string|null>}|null;
}
export interface AgentRetryPort {
 retryable(error:unknown):boolean;
 inspect(nativeId:string):Promise<AgentRetrySnapshot>;
 start(nativeId:string,failedTurnId:string,clientId:string):Promise<string>;
}
export interface AgentControlResult extends ModelPreference {pending?:boolean}
export interface AgentInputPort {
    submit(context: AgentContext, text: string, clientId?: string, attachments?: ConversationAttachment[]): Promise<boolean | 'queued'>;
    afterTerminalSubmit(context: AgentContext): Promise<void>;
}
export interface AgentConnection {
    (): void;
    respond(id: string, answer: unknown): unknown;
}
export interface AgentStreamPort {
    enable?(context: AgentContext): Promise<boolean>;
    shutdown?(): void | Promise<void>;
    observe(context: AgentContext, emit: (frame: AgentStreamFrame) => void, onFailure?: (turnId: string, error: unknown, willRetry: boolean) => void): AgentConnection;
}
export interface AgentLifecyclePort {
    preflight(context: AgentContext): Promise<string | null>;
    bind(context: AgentContext, nativeId: string): Promise<void>;
    compact(context: AgentContext): Promise<void>;
    prepareFresh(context: AgentContext, instructions?: string): Promise<string>;
    release(context: AgentContext): Promise<void>;
    interrupt(context: AgentContext): Promise<void>;
}
export interface AgentLaunchPlan {
    nativeId?: string;
    freshMode?: 'resume' | 'new';
    streamSocket?: string | null;
    bindingPath?: string;
    preSpawnFiles?: Set<string>;
}
export interface AgentLaunchPort {
    prepare(context: AgentContext, task: string, instructions?: string, resume?: boolean): Promise<AgentLaunchPlan>;
    ready(context: AgentContext): Promise<void>;
}
export interface AgentCommandPort {
    configure(command: string, projectPath?: string, streamSocket?: string | null): string;
    build(options: AgentCommandOptions): string;
    permissions(command: string): string;
    sharedResources(command: string, instructions: string): string;
}
export interface AgentIdentityPort {
    read(session: AgentSession): string | null;
    matchesProcess?(args: string[]): boolean;
    legacyField?: 'codex_session_id' | 'claude_session_id';
    discoverTerminal?(context: AgentContext, pid: number, args: string[]): string | null | Promise<string | null>;
    watchTerminal?(context: AgentContext, preSpawnFiles?: Set<string>): void;
    captureTerminal?(context: AgentContext): void;
    recover?(): void;
    purge?(context: AgentContext): void;
}
/** Resolved ports used by the platform. Unsupported optional operations have
 * one shared implementation that reports an explicit capability error. */
export interface AgentAdapter {
    descriptor: AgentDescriptor;
    identity: AgentIdentityPort;
    history: AgentHistoryPort;
    runtime: AgentRuntimePort;
    input: AgentInputPort;
    stream: AgentStreamPort;
    controls: AgentControlsPort;
    telemetry: AgentTelemetryPort;
    statistics: AgentStatisticsPort;
    quota: AgentQuotaPort;
    retry: AgentRetryPort;
    lifecycle: AgentLifecyclePort;
    launch: AgentLaunchPort;
    commands: AgentCommandPort;
}
/** New providers implement conversation ports and only the optional features
 * they advertise. Managed providers need no CLI command or file codec. */
export interface AgentDefinition {
    descriptor: AgentDescriptor;
    identity?: AgentAdapter['identity'];
    history: Partial<AgentHistoryPort>;
    runtime: Pick<AgentRuntimePort, 'read'> & Partial<AgentRuntimePort>;
    input: Pick<AgentInputPort, 'submit'> & Partial<AgentInputPort>;
    stream: AgentStreamPort;
    controls?: Partial<AgentControlsPort>;
    telemetry?: AgentTelemetryPort;
    statistics?: AgentStatisticsPort;
    quota?: AgentQuotaPort;
    retry?: AgentRetryPort;
    lifecycle?: Partial<AgentLifecyclePort>;
    launch?: Partial<AgentLaunchPort>;
    commands?: Partial<AgentCommandPort>;
}
export class UnsupportedAgentFeature extends Error {
    readonly code = 'AGENT_FEATURE_UNSUPPORTED';
    readonly statusCode = 409;
    constructor(readonly agentId: string, readonly feature: AgentFeature, reason?: string) { super(reason || `${agentId} 不支持 ${feature}`); }
}
export function requireNative(context: AgentContext): string { if (!context.nativeId)
    throw Error('当前会话尚未绑定原生会话'); return context.nativeId; }
export function capabilities(features: AgentFeature[]): AgentCapabilities { return Object.fromEntries(AGENT_FEATURES.map(feature => [feature, features.includes(feature)])) as AgentCapabilities; }
