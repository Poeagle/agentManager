import type { ConversationCostEstimate, ConversationInterval } from './api';

export type StatisticsCoverage = 'complete' | 'pending' | 'partial' | 'unavailable';
export type StatisticsReason =
  | 'backfill' | 'source_unavailable' | 'incomplete_record' | 'unreadable_record'
  | 'missing_start' | 'missing_usage' | 'ambiguous_boundary' | 'counter_mismatch'
  | 'source_replaced' | 'inherited_history';

export interface SessionDimensions {
  model: string | null;
  speed: string | null;
  environment: string | null;
  account: string | null;
}

export interface SessionUsageTotals {
  tokens: Record<string, number | null> | null;
  requests: number;
  tool_calls: number;
  tool_rounds: number;
  cost: ConversationCostEstimate | null;
}
export interface SessionMetadata {
  native_id: string;
  generation?: string;
  revision: number;
  status: StatisticsCoverage;
  reasons: StatisticsReason[];
  totals: SessionUsageTotals | null;
  latest: {id: string; at: string | null; tokens: SessionUsageTotals['tokens']; dimensions: SessionDimensions} | null;
  user_inputs: number | null;
  completed_turns: number | null;
  cache_drop_count: number;
  observed_at: string | null;
}
export interface SessionCacheSample extends SessionDimensions {
  input_id: string | null;
  input_at: string | null;
  turn_id: string | null;
  request_id: string;
  request_at: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  hit_rate: number;
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
  factors: CacheDropFactor[];
  confirmed_cause: {label: string; evidence: string} | null;
}

export interface SessionLifecycleFact {
  id: string;
  action: 'create' | 'resume' | 'reload' | 'new' | 'close' | 'delete' | 'compact'
    | 'model' | 'speed' | 'environment' | 'account' | 'input' | 'queue' | 'cancel_queue' | 'stop' | 'interrupt';
  state: 'requested' | 'accepted' | 'completed' | 'failed' | 'unknown';
  evidence: 'platform' | 'native';
  at: string | null;
  turn_id?: string | null;
  message_id?: string;
  client_id?: string;
  operation_id?: string;
  platform_session_id?: string;
  related_native_id?: string;
  dimensions?: SessionDimensions;
  execution?: {
    turn_id: string | null;
    last_progress_id: string | null;
    last_item_id: string | null;
    active_item_ids: string[];
    active_tool_ids: string[];
  };
}
export interface SessionMetadataDetails {
  summary: SessionMetadata;
  models: Array<SessionDimensions & SessionUsageTotals>;
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
  usage: ConversationInterval | null;
  expandable: boolean;
}

export interface SessionUsageIntervalPage {
  native_id: string;
  generation?: string;
  revision: number;
  rows: SessionUsageIntervalRow[];
  next_before: string | null;
}

export const coverageText: Record<StatisticsCoverage, string> = {
  complete: '完整', pending: '等待用量回执', partial: '记录不完整', unavailable: '来源不可用',
};
export const unassignedUsageLabel = '执行用量（已计入本段）';
export const unassignedUsageDescription = '这行汇总本段进展里没有对应消息行的用量，例如模型继续调用工具或推理。';

export function intervalCoverageText(coverage: StatisticsCoverage, reasons: StatisticsReason[] = []): string {
  if (coverage === 'pending') {
    if (reasons.includes('backfill')) return '正在回填历史用量';
    if (reasons.includes('incomplete_record')) return '等待原生记录写入完成';
  }
  return coverageText[coverage];
}

export const coverageReason: Record<StatisticsReason, string> = {
  backfill: '正在读取历史记录', source_unavailable: '无法读取原生会话',
  incomplete_record: '等待原生记录写入完成', unreadable_record: '部分原生记录无法读取',
  missing_start: '无法确认区间起点', missing_usage: '有请求未上报完整用量',
  ambiguous_boundary: '无法确认请求所属区间', counter_mismatch: '原生计数不一致或缺少字段',
  source_replaced: '历史来源已替换且部分原始用量缺失', inherited_history: '部分请求来自继承历史',
};

export function creditsLabel(cost: ConversationCostEstimate | null | undefined) {
  return cost?.amount == null ? '未提供' : new Intl.NumberFormat('en', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(cost.amount) + (cost.complete ? '' : '*');
}

export function uncachedInputTokens(tokens: Record<string, number | null> | null | undefined): number | null {
  const input = totalInputTokens(tokens);
  const cached = tokens?.cached_input_tokens;
  if (input===0&&cached==null) return 0;
  if (input==null||cached==null||!Number.isSafeInteger(input)||!Number.isSafeInteger(cached)||cached<0||cached>input) return null;
  return input-cached;
}

export function totalInputTokens(tokens: Record<string, number | null> | null | undefined): number | null {
  const input=tokens?.input_tokens;
  if(input!=null&&Number.isSafeInteger(input)&&input>=0)return input;
  const total=tokens?.total_tokens,output=tokens?.output_tokens;
  if(total==null||output==null||!Number.isSafeInteger(total)||!Number.isSafeInteger(output)||total<output)return null;
  return total-output;
}

export function recordedCachePercent(tokens: Record<string, number | null> | null | undefined): number | null {
  const input=totalInputTokens(tokens),hit=tokens?.cached_input_tokens,output=tokens?.output_tokens;
  const total=tokens?.total_tokens,reasoning=tokens?.reasoning_output_tokens;
  if (input==null||hit==null||output==null||
      ![input,hit,output].every(value=>Number.isSafeInteger(value)&&value>=0)||
      input===0||hit>input||total!=null&&input+output!==total||reasoning!=null&&(reasoning<0||reasoning>output)) return null;
  return 100*hit/input;
}

export interface CacheTimeline {
  summary: SessionMetadata;
  drops: Map<string, SessionCacheDrop>;
}
export function mergeCacheTimeline(
  previous: CacheTimeline | null, summary: SessionMetadata, drops: SessionCacheDrop[],
): CacheTimeline {
  const same = previous?.summary.native_id === summary.native_id &&
    previous.summary.generation === summary.generation;
  if (previous && previous.summary.native_id === summary.native_id && previous.summary.revision > summary.revision) {
    if (!same || !drops.length) return previous;
    // An older page can fill in additional IDs for this generation. It
    // cannot overwrite newer facts already delivered by the live stream.
    return {...previous, drops: new Map([...drops.map(drop => [drop.id, drop] as const), ...previous.drops])};
  }
  return {
    summary, drops: new Map([...(same ? previous.drops : []), ...drops.map(drop => [drop.id, drop] as const)]),
  };
}
