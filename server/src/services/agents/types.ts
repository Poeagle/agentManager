import type { ConversationAttachment } from "../conversation-attachments.js";
import type { AgentStreamFrame } from "./events.js";
/** Provider identifiers are open strings; registering a provider does not
 * require changing a discriminated union in platform code. */
export type AgentId = string;
export const AGENT_FEATURES = [
  "history",
  "runtime",
  "input",
  "cancelQueuedInput",
  "stream",
  "controls",
  "serviceTier",
  "model",
  "effort",
  "compact",
  "newConversation",
  "reload",
  "interrupt",
  "stopTurn",
  "questions",
  "usage",
  "statistics",
  "retry",
  "launch",
  "resume",
  "attachments",
  "sharedResources",
  "quota",
] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];
export type AgentCapabilities = Record<AgentFeature, boolean>;
export interface AgentDescriptor {
  launchCommand?: string;
  terminal?: {
    composer: boolean;
    repaintOnResize: boolean;
  };
  sessionHost: "terminal" | "managed";
  id: AgentId;
  label: string;
  capabilities: AgentCapabilities;
  presentation: {
    icon: string;
    color: string;
    order?: number;
  };
}
export type AgentManagementStatus =
  "ready" | "warning" | "error" | "unavailable" | "unknown";
export interface AgentManagementField {
  key: string;
  label: string;
  type: "text" | "password" | "select" | "toggle" | "string-list";
  value?: string | boolean | string[] | null;
  configured?: boolean;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}
export interface AgentConfigFile {
  path: string;
  exists: boolean;
  format: string;
  description: string;
  writable?: boolean;
  sensitive?: boolean;
  purpose?: string;
}
export interface AgentEnvironmentVariable {
  name: string;
  value: string;
  configured: boolean;
  secret?: boolean;
  description: string;
  source: string;
  editable: boolean;
}
export interface AgentEnvironmentUpdate {
  values?: Record<string, string>;
  clear?: string[];
  restart?: boolean;
}
export interface AgentConfigFileInput {
  path: string;
  content: string;
  expectedContent?: string | null;
  revealSensitive?: boolean;
}
export interface AgentConfigFileResult {
  path: string;
  content: string;
  exists: boolean;
  format: string;
  restarted?: boolean;
}
export interface AgentModelConfig {
  provider?: string;
  model: string;
  name: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
  effectiveContextWindowPercent: number | null;
  inputModalities: string[];
  supportsImages: boolean;
  sourceFile: string | null;
}
export interface AgentModelConfigUpdate {
  provider?: string;
  model: string;
  contextWindow?: number | null;
  maxContextWindow?: number | null;
  effectiveContextWindowPercent?: number | null;
  supportsImages?: boolean;
}
export interface AgentProviderState {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  managed: boolean;
  status: AgentManagementStatus;
  statusText: string;
  authentication: {
    status: "authenticated" | "missing" | "unknown";
    method: string;
  };
  models: string[];
  defaultModel: string | null;
  fields: AgentManagementField[];
  /** Runtime and file locations are provider-scoped for Codex engines. */
  socket?: string | null;
  pid?: number | null;
  codexHome?: string | null;
  /** Fully resolved argv used to launch this Engine. */
  launchCommand?: string;
  launchArgs?: string[];
  authenticationConfigured?: boolean;
  configFiles?: AgentConfigFile[];
}
export interface AgentManagementState {
  agent: AgentDescriptor;
  installation: {
    status: AgentManagementStatus;
    executable: string | null;
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    installCommand: string;
    updateCommand: string;
    requirement?: string | null;
  };
  authentication: {
    status: "authenticated" | "missing" | "unknown" | "not_applicable";
    method: string;
    detail: string;
  };
  defaults: AgentManagementField[];
  providers: AgentProviderState[];
  configFiles: AgentConfigFile[];
  environment?: AgentEnvironmentVariable[];
  diagnostics: Array<{
    id: string;
    status: AgentManagementStatus;
    label: string;
    detail: string;
  }>;
  actions: Array<{
    id: string;
    label: string;
    kind?: "primary" | "secondary" | "danger";
    confirm?: string;
    available: boolean;
  }>;
  providerManagement: {
    create: boolean;
    update: boolean;
    delete: boolean;
    actions: string[];
    fields: AgentManagementField[];
  };
  applySemantics: {
    settings: "immediate" | "new_session" | "restart";
    providers: "immediate" | "new_session" | "restart";
    detail: string;
  };
  checkedAt: string;
}
export interface AgentManagementUpdate {
  defaults?: Record<string, string | boolean | string[] | null>;
}
export interface AgentOperationProgress {
  stage: string;
  message: string;
  progress: number;
}
export type AgentOperationReporter = (progress: AgentOperationProgress) => void;
export interface AgentProviderInput {
  id?: string;
  name?: string;
  kind?: string;
  enabled?: boolean;
  fields?: Record<string, string | boolean | string[] | null>;
  /** Write-only secret; implementations must never return it. */
  apiKey?: string;
}
export interface AgentModelDetectionInput {
  endpoint?: string;
  apiKey?: string;
  providerId?: string;
  useEncrypted?: boolean;
}
export interface AgentManagementPort {
  inspect(force?: boolean): Promise<AgentManagementState>;
  inspectProvider?(providerId: string): Promise<AgentProviderState | null>;
  update(input: AgentManagementUpdate): Promise<AgentManagementState>;
  action(action: string): Promise<AgentManagementState>;
  createProvider(input: AgentProviderInput): Promise<AgentManagementState>;
  updateProvider(
    providerId: string,
    input: AgentProviderInput,
    onProgress?: AgentOperationReporter,
  ): Promise<AgentManagementState>;
  deleteProvider(providerId: string): Promise<AgentManagementState>;
  providerAction(
    providerId: string,
    action: string,
    onProgress?: AgentOperationReporter,
  ): Promise<AgentManagementState>;
  detectModels?(input?: AgentModelDetectionInput): Promise<
    Array<{
      provider?: string;
      model: string;
      name: string;
      description?: string;
      efforts?: Array<{ value: string; description: string }>;
    }>
  >;
  readModelConfigs?(): Promise<AgentModelConfig[]>;
  updateModelConfigs?(
    updates: AgentModelConfigUpdate[],
  ): Promise<AgentModelConfig[]>;
  updateEnvironment?(
    input: AgentEnvironmentUpdate,
  ): Promise<AgentEnvironmentVariable[]>;
  saveSelectedModels?(
    models: string[],
    defaultModel: string | null,
  ): Promise<AgentEnvironmentVariable[]>;
  readConfigFile?(file: AgentConfigFileInput): Promise<AgentConfigFileResult>;
  writeConfigFile?(file: AgentConfigFileInput): Promise<AgentConfigFileResult>;
}
export interface AgentSession {
  agent_environment_id?: string | null;
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
  /** State subscribers skip token-only updates; legacy snapshot consumers remain supported. */
  streamFormat?: "incremental" | "snapshot" | "state";
  session: AgentSession;
  nativeId: string | null;
  projectPath: string | null;
  sharedAccess?: boolean;
  actorUserId?: string;
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
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
  turn_id?: string;
  statistics?: AgentStatistics;
  streaming?: boolean;
  queued?: boolean;
  phase?: "commentary" | "final" | "error";
  content_blocks?: Array<
    | { type: "text"; index: number; text: string }
    | {
        type: "tool_use";
        index: number;
        id: string;
        name: string;
        input: unknown;
        status: "running" | "completed" | "failed";
        result?: string;
        is_error?: boolean;
      }
  >;
  presentation?: "compaction_summary";
  compaction?: {
    before_tokens: number | null;
    after_tokens: number | null;
    duration_ms: number | null;
  };
  error?: {
    code?: string;
    will_retry: boolean;
  };
  client_id?: string;
  /** Platform-owned provenance, attached only after submission identity is verified. */
  batch?: Array<{text:string;attachments:ConversationAttachment[]}>;
  input_source?: { kind: string; label: string };
  /** Native echo identity, when a terminal generated a different client ID. */
  native_client_id?: string;
  sequence?: number;
  attachments?: ConversationAttachment[];
  image_paths?: string[];
  async_questions?: AgentAsyncQuestion[];
  question_replies?: AgentQuestionReply[];
}
export interface AgentTextMessage {
  role: "user" | "assistant";
  /** `unknown` is an internal parser state for native assistant messages
   * whose lifecycle has not yet been decided by a completion event. */
  phase: "user" | "unknown" | "commentary" | "final";
  text: string;
  timestamp: string | null;
  task_reference?: string | null;
}
export interface ModelPreference {
  service_tier?: string;
  provider?: string;
  model: string;
  effort: string;
}
export interface AgentRuntime {
  source: string;
  session_id: string | null;
  state:
    | "ready"
    | "running"
    | "idle"
    | "waiting_for_input"
    | "interrupted"
    | "failed"
    | "unknown";
  last_activity_at: string | null;
  observed_at: string;
  reason: string;
  completed_turn_id?: string;
  compaction?: import("./events.js").AgentCompaction | null;
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
  default_service_tier?: string | null;
  service_tiers?: Array<{ id: string; name: string; description: string }>;
  provider?: string;
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
export interface AgentProgressSegment {
  id:string; start_at:string|null; end_at:string|null; elapsed_ms:number|null; end_reason:'input'|'completed'|'interrupted'|'unknown'|null;
  tokens:Record<string,number|null>|null; requests:number; tool_calls:number; tool_rounds:number; complete:boolean;
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
  segment?: AgentProgressSegment;
  conclusion?: AgentStatisticsInterval & {
    start_at: string | null;
    end_at: string | null;
    elapsed_ms: number | null;
  };
}
export interface AgentControls {
  supports_model_recovery?: boolean;
  supports_fresh_model?: boolean;
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
    role: "user" | "assistant";
    phase?: "user" | "unknown" | "commentary" | "final" | "error";
    text: string;
    timestamp: string | null;
  };
  presentation?: "compaction_summary";
  compaction?: AgentMessage["compaction"];
  contentBlocks?: AgentMessage["content_blocks"];
  failure?: AgentMessage | null;
  itemId?: string;
  recordId?: string;
  clientId?: string;
  turnId?: string;
  recordType: string;
  asyncQuestions?: AgentMessage["async_questions"];
  questionReplies?: AgentMessage["question_replies"];
  imagePaths: string[];
  /** Provider-specific auxiliary record role retained for bounded indexing. */
  sourceRole?: "tool_result";
  /** Tool result record identity and public result, kept out of message text. */
  toolResult?: { toolUseId: string; result: string; failed: boolean };
}
/** File codecs are an optional persistence strategy, never a requirement for
 * an HTTP/SDK agent. Only the generic bounded file reader consumes this port. */
export interface AgentFileHistoryPort {
  locate(context: AgentContext): Promise<string | null>;
  decode(entries: Iterable<unknown>, limit?: number): AgentTextMessage[];
  project(
    record: Buffer,
    questionCallId?: string,
    context?: { nativeId?: string | null; replacementIndex?: number },
  ): AgentHistoryRecord | null;
  /** Native log records that replace the preceding projected history. */
  replacementHistory?(record: Buffer): number[] | null;
  /** Some native formats store the turn identity on surrounding lifecycle
   * records rather than repeating it on every public message. */
  turnBoundary?(
    record: Buffer,
  ): { kind: "start" | "end"; turnId: string } | null;
  recordLimit(prefix: Buffer): number;
  questionCall(record: Buffer): {
    id: string;
    turnId?: string;
    signature: string;
  } | null;
  relevant(line: string): boolean;
  turns(
    entries: Iterable<unknown>,
    rounds: number,
  ): Array<{
    user: string;
    assistant: string;
  }>;
}
export interface AgentHistoryPort {
  read(
    context: AgentContext,
    query: AgentHistoryQuery,
  ): Promise<AgentHistoryPage | null>;
  file?: AgentFileHistoryPort;
  context?(
    context: AgentContext,
    rounds: number,
  ): Promise<
    Array<{
      user: string;
      assistant: string;
    }>
  >;
}
export interface AgentRuntimePort {
  read(context: AgentContext): Promise<AgentRuntime>;
  subscribe(context: AgentContext, changed: () => void): () => void;
}
export interface AgentControlsPort {
  confirmed?(
    context: AgentContext,
    value: ModelPreference,
    controls: AgentControls,
    submittedAt: string,
  ): boolean;
  read(context: AgentContext): Promise<AgentControls>;
  validate(context: AgentContext, value: unknown): Promise<ModelPreference>;
  apply(
    context: AgentContext,
    value: ModelPreference,
  ): Promise<AgentControlResult>;
}
export interface AgentTelemetryPort {
  contextBreakdown?(context:AgentContext):Promise<AgentContextBreakdown>;
  read(context: AgentContext): Promise<{
    usage: AgentControls["usage"];
    observed_at: string | null;
  }>;
}
/** Native occupancy and estimated text categories have distinct denominators. */
export interface AgentContextBreakdown {
  source:'jsonl';exact:false;method:'characters_div_3';checked_at:string;
  observed_at:string|null;model:string|null;usage:AgentControls['usage'];
  partial:boolean;warnings:string[];files_read:number;records_read:number;bytes_read:number;compactions:number;
  categories:Array<{id:string;name:string;tokens:number|null;count:number;detail:Array<{name:string;tokens:number;count:number}>}>;
}
export interface AgentStatisticsPort {
  read(context: AgentContext, path: string): Promise<AgentStatistics[]>;
  readProgress?(context: AgentContext, path: string): Promise<AgentProgressStatistics | null>;
}
export interface AgentProgressStatistics {turn_id:string;tokens:Record<string,number|null>|null;requests:number;tool_calls:number;tool_rounds:number;complete:boolean;segment?:AgentProgressSegment}
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
  state: "idle" | "busy" | "unavailable";
  queued: boolean;
  turn: {
    id: string;
    status: "running" | "completed" | "failed" | "interrupted" | "unknown";
    retryable: boolean;
    has_final: boolean;
    user_client_ids: Array<string | null>;
  } | null;
}
export interface AgentRetryPort {
  retryable(error: unknown): boolean;
  inspect(nativeId: string): Promise<AgentRetrySnapshot>;
  start(
    nativeId: string,
    failedTurnId: string,
    clientId: string,
  ): Promise<string>;
}
export interface AgentControlResult extends ModelPreference {
  pending?: boolean;
}
export interface AgentInputPort {
  /** Submit preserves platform-generated UUIDs in live and durable message identities. */
  supportsClientIdentity?: boolean;
  /** When supported, map a platform client ID to the durable native message ID. */
  messageId?(clientId: string): string | undefined;
  cancelQueued?(context: AgentContext, clientId: string): Promise<void>;
  submit(
    context: AgentContext,
    text: string,
    clientId?: string,
    attachments?: ConversationAttachment[],
  ): Promise<boolean | "queued">;
  afterTerminalSubmit(context: AgentContext): Promise<void>;
}
export interface AgentQuestionAnswer {
  answers: Record<string, { answers: string[] }>;
  attachments?: Record<string, ConversationAttachment[]>;
}
export interface AgentConnection {
  (): void;
  /** Question replies use {answers, attachments?}, grouped by question ID.
   * The API validates uploads; each provider maps them to its native format.
   * A promise resolves only after native acceptance, never on a queued UI write. */
  respond(id: string, answer: unknown): unknown;
}
export interface AgentStreamPort {
  /** Optional credential/endpoint isolation key; defaults to platform owner and project. */
  scope?(context: AgentContext): string;
  enable?(context: AgentContext): Promise<boolean>;
  /** Load durable state for a bound managed conversation without starting or
   * resuming its native session. Backends that expose no external history
   * may omit it and publish their own initial snapshot. */
  seed?(context: AgentContext): Promise<AgentStreamSeed>;
  shutdown?(): void | Promise<void>;
  observe(
    context: AgentContext,
    emit: (frame: AgentStreamFrame) => void,
    onFailure?: (turnId: string, error: unknown, willRetry: boolean) => void,
  ): AgentConnection;
}
export interface AgentStreamSeed {
  messages: AgentMessage[];
  generation: string | null;
}
export interface AgentLifecyclePort {
  preflight(context: AgentContext): Promise<string | null>;
  bind(context: AgentContext, nativeId: string): Promise<void>;
  compact(context: AgentContext): Promise<void>;
  prepareFresh(
    context: AgentContext,
    instructions?: string,
    preference?: ModelPreference,
  ): Promise<string>;
  release(context: AgentContext): Promise<void>;
  interrupt(context: AgentContext): Promise<void>;
  stopTurn(context: AgentContext, turnId: string): Promise<boolean>;
}
export interface AgentTerminalProfile {home:string;readOnlyPaths:string[]}
export interface AgentLaunchPlan {
  /** Durable public message identity for the first submitted input, when known. */
  initialMessageId?: string;
  /** Thin terminal clients use a separate HOME and only their authorized transport paths. */
  terminalProfile?:AgentTerminalProfile;
  nativeId?: string;
  freshMode?: "resume" | "new";
  streamSocket?: string | null;
  bindingPath?: string;
  preSpawnFiles?: Set<string>;
}
export interface AgentLaunchPort {
  /** Fresh launch preserves a platform-generated UUID for its first user message. */
  supportsInitialClientId?: boolean;
  prepare(
    context: AgentContext,
    task: string,
    instructions?: string,
    resume?: boolean,
    initialClientId?: string,
  ): Promise<AgentLaunchPlan>;
  ready(context: AgentContext): Promise<void>;
}
export interface AgentCommandPort {
  configure(
    command: string,
    projectPath?: string,
    streamSocket?: string | null,
  ): string;
  build(options: AgentCommandOptions): string;
  permissions(command: string): string;
  sharedResources(command: string, instructions: string): string;
}
export interface AgentIdentityPort {
  read(session: AgentSession): string | null;
  matchesProcess?(args: string[]): boolean;
  legacyField?: "codex_session_id" | "claude_session_id";
  discoverTerminal?(
    context: AgentContext,
    pid: number,
    args: string[],
  ): string | null | Promise<string | null>;
  watchTerminal?(context: AgentContext, preSpawnFiles?: Set<string>): void;
  captureTerminal?(context: AgentContext): void;
  recover?(): void;
  purge?(context: AgentContext): void;
  /** Delete the adapter-owned durable conversation source before purging the platform row. */
  purgeHistory?(context: AgentContext): Promise<void>;
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
  management: AgentManagementPort;
}
/** New providers implement conversation ports and only the optional features
 * they advertise. Managed providers need no CLI command or file codec. */
export interface AgentDefinition {
  descriptor: AgentDescriptor;
  identity?: AgentAdapter["identity"];
  history: Partial<AgentHistoryPort>;
  runtime: Pick<AgentRuntimePort, "read"> & Partial<AgentRuntimePort>;
  input: Pick<AgentInputPort, "submit"> & Partial<AgentInputPort>;
  stream: AgentStreamPort;
  controls?: Partial<AgentControlsPort>;
  telemetry?: AgentTelemetryPort;
  statistics?: AgentStatisticsPort;
  quota?: AgentQuotaPort;
  retry?: AgentRetryPort;
  lifecycle?: Partial<AgentLifecyclePort>;
  launch?: Partial<AgentLaunchPort>;
  commands?: Partial<AgentCommandPort>;
  management?: Partial<AgentManagementPort>;
}
export class UnsupportedAgentFeature extends Error {
  readonly code = "AGENT_FEATURE_UNSUPPORTED";
  readonly statusCode = 409;
  constructor(
    readonly agentId: string,
    readonly feature: AgentFeature,
    reason?: string,
  ) {
    super(reason || `${agentId} 不支持 ${feature}`);
  }
}
export function requireNative(context: AgentContext): string {
  if (!context.nativeId) throw Error("当前会话尚未绑定原生会话");
  return context.nativeId;
}
export function capabilities(features: AgentFeature[]): AgentCapabilities {
  return Object.fromEntries(
    AGENT_FEATURES.map((feature) => [feature, features.includes(feature)]),
  ) as AgentCapabilities;
}
