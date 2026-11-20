import { consistentUsage, factId } from './agents/session-fact-values.js';
import type { CacheDropFactor, NativeRequestFact, SessionCacheDrop, SessionCacheSample } from './agents/session-facts.js';

export function cacheSample(
  input: {id: string; turn: string; at: string | null},
  request: NativeRequestFact,
): SessionCacheSample | null {
  if (!consistentUsage(request.tokens)) return null;
  const {input_tokens, cached_input_tokens} = request.tokens!;
  if (input_tokens! < 1024) return null;
  return {
    ...request.dimensions, input_id: input.id, input_at: input.at, turn_id: input.turn,
    request_id: request.id, request_at: request.at, input_tokens: input_tokens!,
    cached_input_tokens: cached_input_tokens!, hit_rate: cached_input_tokens! / input_tokens!,
  };
}

export function detectCacheDrop(
  previous: SessionCacheSample, current: SessionCacheSample, compacted: boolean,
): SessionCacheDrop | null {
  const at = current.request_at;
  const drop = previous.hit_rate - current.hit_rate;
  if (!at || !previous.request_at || Date.parse(at) < Date.parse(previous.request_at) ||
    previous.hit_rate < 0.8 || drop + Number.EPSILON < 0.25) return null;
  const factors: CacheDropFactor[] = [];
  for (const key of ['model', 'speed', 'environment', 'account'] as const)
    if (previous[key] !== null && current[key] !== null && previous[key] !== current[key]) factors.push(key);
  if (compacted) factors.push('compact');
  if (previous.input_tokens > current.input_tokens * 2 || current.input_tokens > previous.input_tokens * 2) {
    if (!factors.length) return null;
    factors.push('input_size');
  }
  const interval = previous.input_at && current.input_at ? Date.parse(current.input_at) - Date.parse(previous.input_at) : null;
  const elapsed_ms = interval !== null && interval >= 0 ? interval : null;
  if (elapsed_ms !== null && elapsed_ms >= 15 * 60_000) factors.push('input_gap');
  return {
    id: factId('cache', current.input_id, current.request_id), at, previous, current, elapsed_ms,
    decrease_pp: drop * 100, factors, confirmed_cause: null,
  };
}
