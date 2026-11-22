import type { CacheInputPricing, CacheWriteTokens, SessionTokens } from './session-facts.js';
import type { TokenCostBreakdown } from './types.js';

/** Price each input category using the current request's total input tier. */
export function cacheInputPricing(
  tokens: SessionTokens | null,
  price: (usage: SessionTokens, writes: CacheWriteTokens) => TokenCostBreakdown | null | undefined,
  supportsWrites = false,
): CacheInputPricing | undefined {
  const input = tokens?.input_tokens;
  if (!tokens || input == null || input <= 0) return undefined;
  const uncached = {...tokens,cached_input_tokens:0};
  const allUncached = price(uncached,[0,0]);
  const allCached = price({...tokens,cached_input_tokens:input},[0,0]);
  if (!allUncached || !allCached) return undefined;
  const write5 = supportsWrites ? price(uncached,[input,0]) : null;
  const write60 = supportsWrites ? price(uncached,[0,input]) : null;
  return {
    uncached_per_token:allUncached.input/input,
    cached_per_token:allCached.cache/input,
    ...(write5 ? {write_5m_per_token:write5.input/input} : {}),
    ...(write60 ? {write_1h_per_token:write60.input/input} : {}),
  };
}
