import { consistentUsage, factId } from './agents/session-fact-values.js';
import type { CacheDropFactor, NativeRequestFact, SessionCacheDrop, SessionCacheSample } from './agents/session-facts.js';

export function cacheSample(
  input: {id: string; at: string | null} | undefined,
  request: NativeRequestFact,
): SessionCacheSample | null {
  if (!consistentUsage(request.tokens)) return null;
  const {input_tokens, cached_input_tokens} = request.tokens!;
  if (input_tokens! <= 0) return null;
  const writes = request.cache_write_tokens;
  return {
    ...request.dimensions, input_id: input?.id ?? null, input_at: input?.at ?? null, turn_id: request.turn_id,
    request_id: request.id, request_at: request.at, input_tokens: input_tokens!,
    cached_input_tokens: cached_input_tokens!, hit_rate: cached_input_tokens! / input_tokens!,
    ...(writes ? {uncached_input_tokens: input_tokens! - cached_input_tokens! - writes[0] - writes[1], cache_write_tokens:writes} : {}),
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
  if (!at || !previous.request_at || Date.parse(at) < Date.parse(previous.request_at) ||
      current.cached_input_tokens >= previous.cached_input_tokens) return null;
  const factors = cacheDimensionChanges(previous,current);
  if (compaction) factors.push('compact');
  if (previous.input_tokens > current.input_tokens * 2 || current.input_tokens > previous.input_tokens * 2)
    factors.push('input_size');
  const inputGap = previous.input_id !== current.input_id && previous.input_at && current.input_at
    ? Date.parse(current.input_at) - Date.parse(previous.input_at) : null;
  const elapsed_ms = intervalKind === 'request' ? Date.parse(at) - Date.parse(previous.request_at) :
    inputGap !== null && inputGap >= 0 ? inputGap : null;
  if (inputGap !== null && inputGap >= 15 * 60_000) factors.push('input_gap');
  return {
    id: factId('cache', current.input_id, current.request_id), at, previous, current, elapsed_ms,
    interval_kind: intervalKind, ...(compaction ? {compaction_at: compaction.at} : {}),
    decrease_pp: (previous.hit_rate - current.hit_rate) * 100, factors, confirmed_cause: null,
  };
}

/** Apply the current request's prices to both samples' input tokens. */
export function cacheDropExtraCost(drop: SessionCacheDrop, request: NativeRequestFact): SessionCacheDrop['extra_cost'] {
  const pricing = request.cache_input_pricing;
  const previousUncached = drop.previous.uncached_input_tokens;
  const currentUncached = drop.current.uncached_input_tokens;
  const beforeWrites = drop.previous.cache_write_tokens;
  const afterWrites = drop.current.cache_write_tokens;
  if (!pricing || !request.cost?.complete || !beforeWrites || !afterWrites || previousUncached == null || currentUncached == null ||
      previousUncached < 0 || currentUncached < 0) return undefined;
  const uncachedDelta = currentUncached - previousUncached;
  const cachedDelta = drop.current.cached_input_tokens - drop.previous.cached_input_tokens;
  const shortWriteDelta = afterWrites[0] - beforeWrites[0];
  const longWriteDelta = afterWrites[1] - beforeWrites[1];
  if ((shortWriteDelta && pricing.write_5m_per_token == null) || (longWriteDelta && pricing.write_1h_per_token == null)) return undefined;
  const amount = uncachedDelta * pricing.uncached_per_token + cachedDelta * pricing.cached_per_token +
    shortWriteDelta * (pricing.write_5m_per_token ?? 0) + longWriteDelta * (pricing.write_1h_per_token ?? 0);
  return Number.isFinite(amount) ? {amount,unit:request.cost.unit} : undefined;
}
