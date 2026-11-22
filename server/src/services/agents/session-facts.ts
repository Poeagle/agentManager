import type { AgentContext, AgentCostEstimate, AgentProgressStatistics, AgentStatistics, AgentStatisticsInterval } from './types.js';
import type { publicTokenCounters } from '../conversation-usage.js';

export type SessionTokens = ReturnType<typeof publicTokenCounters>;
export interface RequestDimensions {
  model: string | null;
  speed: string | null;
  environment: string | null;
  account: string | null;
}

export type SessionAction =
  | 'create' | 'resume' | 'reload' | 'new' | 'close' | 'delete'
  | 'compact' | 'model' | 'speed' | 'environment' | 'account' | 'input'
  | 'queue' | 'cancel_queue' | 'stop' | 'interrupt';
export type SessionActionState = 'requested' | 'accepted' | 'completed' | 'failed' | 'unknown';
export interface SessionActivityContext {
  turn_id: string | null;
  last_progress_id: string | null;
  last_item_id: string | null;
  active_item_ids: string[];
  active_tool_ids: string[];
}
export interface SessionLifecycleFact {
  id: string;
  action: SessionAction;
  state: SessionActionState;
  evidence: 'platform' | 'native';
  at: string | null;
  turn_id?: string | null;
  message_id?: string;
  client_id?: string;
  operation_id?: string;
  platform_session_id?: string;
  related_native_id?: string;
  dimensions?: RequestDimensions;
  execution?: SessionActivityContext;
}

export interface CacheInputPricing {
  uncached_per_token: number;
  cached_per_token: number;
}

export interface NativeRequestFact {
  id: string;
  turn_id: string | null;
  at: string | null;
  tokens: SessionTokens | null;
  dimensions: RequestDimensions;
  /** A legacy record may establish usage without a native response identity. */
  evidence: 'request' | 'legacy';
  inherited?: boolean;
  cost: AgentCostEstimate | null;
  cache_input_pricing?: CacheInputPricing;
  cache_write_input_tokens?: number;
}

export type NativeSessionFact = (
  | { kind: 'start'; turn_id: string; at: string | null }
  | { kind: 'input'; id: string; turn_id: string; at: string | null; client_id?: string }
  | { kind: 'item_start'; id: string; turn_id: string }
  | { kind: 'item'; id: string; turn_id: string; at: string | null; phase: 'progress' | 'final' | 'unknown'; digest?: string }
  | { kind: 'tool'; id: string; turn_id: string }
  | { kind: 'tool_end'; id: string; turn_id: string }
  | { kind: 'request'; request: NativeRequestFact }
  | { kind: 'end'; turn_id: string; at: string | null; outcome: 'completed' | 'interrupted' | 'unknown'; final_digest?: string }
  | { kind: 'lifecycle'; event: Omit<SessionLifecycleFact, 'id' | 'evidence'>; id?: string; related_request_id?: string }
  | { kind: 'gap'; reason: SessionCoverageReason; affectsUsage?: boolean }
) & { source_offset?: number };

export interface NativeFactLocation {
  offset: number;
  at: string | null;
  context: AgentContext;
}
export interface AgentSessionFactsPort {
  /** Bump when checkpoints from a prior native interpretation need replay. */
  revision: number;
  recordLimit?(header: Buffer): number;
  decode(record: Record<string, any>, location: NativeFactLocation, prior: unknown): {
    state: unknown;
    facts: NativeSessionFact[];
  };
  /** Oversized records are skipped without storing transcript contents. */
  oversized?(header: Buffer, context: AgentContext): NativeSessionFact[];
  /** Inventory of authorized local native sessions, including those without tabs. */
  discover?(): AsyncIterable<{ path: string; context: AgentContext }>;
  /** A provider may retain usage in its existing account ledger before deletion. */
  preserveAccountUsage?(context: AgentContext): Promise<void>;
}

export type SessionCoverageReason =
  | 'backfill' | 'source_unavailable' | 'incomplete_record' | 'unreadable_record'
  | 'missing_start' | 'missing_usage' | 'ambiguous_boundary' | 'counter_mismatch'
  | 'source_replaced' | 'inherited_history';
export type SessionCoverage = 'complete' | 'pending' | 'partial' | 'unavailable';

export interface SessionUsageTotals {
  tokens: SessionTokens | null;
  requests: number;
  tool_calls: number;
  tool_rounds: number;
  cost: AgentCostEstimate | null;
}
export interface SessionModelTotals extends SessionUsageTotals, RequestDimensions {}
export interface SessionCacheSample extends RequestDimensions {
  input_id: string | null;
  turn_id: string | null;
  input_at: string | null;
  request_id: string;
  request_at: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  hit_rate: number;
  uncached_input_tokens?: number;
}
export type CacheDropFactor = 'input_gap' | 'model' | 'speed' | 'environment' | 'account' | 'compact' | 'input_size';
export interface SessionCacheDrop {
  id: string;
  message_id?: string;
  at: string;
  previous: SessionCacheSample;
  current: SessionCacheSample;
  elapsed_ms: number | null;
  interval_kind?: 'input' | 'request';
  compaction_at?: string | null;
  decrease_pp: number;
  extra_cost?: {amount: number; unit: string};
  factors: CacheDropFactor[];
  confirmed_cause: { label: string; evidence: string } | null;
}

export interface SessionMetadata {
  native_id: string;
  generation?: string;
  revision: number;
  status: SessionCoverage;
  reasons: SessionCoverageReason[];
  totals: SessionUsageTotals | null;
  latest: Omit<NativeRequestFact, 'cache_input_pricing' | 'cache_write_input_tokens'> | null;
  user_inputs: number | null;
  completed_turns: number | null;
  cache_drop_count: number;
  observed_at: string | null;
}
export interface SessionMetadataDetails {
  summary: SessionMetadata;
  models: SessionModelTotals[];
  events: SessionLifecycleFact[];
  cache_drops: SessionCacheDrop[];
  next_event: string | null;
  next_cache_drop: string | null;
}

export interface SessionUsageIntervalRow {
  id: string;
  kind: 'final' | 'progress' | 'item' | 'open' | 'unassigned';
  phase?: 'final';
  at: string | null;
  usage: AgentStatisticsInterval | null;
  expandable: boolean;
}

export interface SessionUsageIntervalPage {
  native_id: string;
  generation?: string;
  revision: number;
  rows: SessionUsageIntervalRow[];
  next_before: string | null;
}

export interface SessionFactsUpdate {
  summary: SessionMetadata;
  statistics: AgentStatistics[];
  progress: AgentProgressStatistics | null;
  cache_drops: SessionCacheDrop[];
  coverage_changed?: boolean;
}
