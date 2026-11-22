import type { CacheInputPricing, SessionTokens } from './session-facts.js';
import type { TokenCostBreakdown } from './types.js';

/** Keep the total input, output and cache writes fixed when pricing cache reads. */
export function cacheInputPricing(
  tokens: SessionTokens | null,
  cacheWrites: number,
  price: (usage: SessionTokens) => TokenCostBreakdown | null | undefined,
): CacheInputPricing | undefined {
  if (tokens?.input_tokens == null) return undefined;
  const eligibleInput = tokens.input_tokens - cacheWrites;
  if (eligibleInput <= 0) return undefined;
  const allUncached = price({...tokens,cached_input_tokens:0});
  const allCached = price({...tokens,cached_input_tokens:eligibleInput});
  if (!allUncached || !allCached) return undefined;
  return {
    uncached_per_token:(allUncached.input-allCached.input)/eligibleInput,
    cached_per_token:allCached.cache/eligibleInput,
  };
}
