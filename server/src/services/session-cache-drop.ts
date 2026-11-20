import { consistentUsage, factId } from './agents/session-fact-values.js';
import type { CacheDropFactor, NativeRequestFact, SessionCacheDrop, SessionCacheSample } from './agents/session-facts.js';

export function cacheSample(
  input: {id: string; at: string | null} | undefined,
  request: NativeRequestFact,
): SessionCacheSample | null {
  if (!consistentUsage(request.tokens)) return null;
  const {input_tokens, cached_input_tokens} = request.tokens!;
  if (input_tokens! < 1024) return null;
  return {
    ...request.dimensions, input_id: input?.id ?? null, input_at: input?.at ?? null, turn_id: request.turn_id,
    request_id: request.id, request_at: request.at, input_tokens: input_tokens!,
    cached_input_tokens: cached_input_tokens!, hit_rate: cached_input_tokens! / input_tokens!,
  };
}

const dimensions = ['model', 'speed', 'environment', 'account'] as const;
export function cacheDimensionChanges(previous: SessionCacheSample, current: SessionCacheSample): CacheDropFactor[] {
  return dimensions.filter(key => previous[key] !== null && current[key] !== null && previous[key] !== current[key]);
}

export function detectCacheDrop(
  previous: SessionCacheSample, current: SessionCacheSample,
  intervalKind: 'input' | 'request', compaction?: {at: string | null},
): SessionCacheDrop | null {
  const at = current.request_at;
  const drop = previous.hit_rate - current.hit_rate;
  if (!at || !previous.request_at || Date.parse(at) < Date.parse(previous.request_at) ||
    previous.hit_rate < 0.8 || drop + Number.EPSILON < 0.25) return null;
  const factors = cacheDimensionChanges(previous,current);
  if (compaction) factors.push('compact');
  if (previous.input_tokens > current.input_tokens * 2 || current.input_tokens > previous.input_tokens * 2) {
    if (!factors.length) return null;
    factors.push('input_size');
  }
  const inputGap = previous.input_id !== current.input_id && previous.input_at && current.input_at
    ? Date.parse(current.input_at) - Date.parse(previous.input_at) : null;
  const elapsed_ms = intervalKind === 'request' ? Date.parse(at) - Date.parse(previous.request_at) :
    inputGap !== null && inputGap >= 0 ? inputGap : null;
  if (inputGap !== null && inputGap >= 15 * 60_000) factors.push('input_gap');
  return {
    id: factId('cache', current.input_id, current.request_id), at, previous, current, elapsed_ms,
    interval_kind: intervalKind, ...(compaction ? {compaction_at: compaction.at} : {}),
    decrease_pp: drop * 100, factors, confirmed_cause: null,
  };
}
