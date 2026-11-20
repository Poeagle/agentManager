import { createHash } from 'node:crypto';
import { publicTokenCounters } from '../conversation-usage.js';
import type { SessionTokens } from './session-facts.js';

export function factId(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function nativeItemId(role: 'assistant' | 'user', id: string): string {
  return createHash('sha256').update('item:' + role + ':' + id).digest('hex').slice(0, 32);
}

export function factString(value: unknown, limit = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

export function factTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parsedUsage(value: unknown): SessionTokens | null {
  const tokens = publicTokenCounters(value);
  if (Object.values(tokens).every(token => token === null)) return null;
  for (const key of Object.keys(tokens) as Array<keyof SessionTokens>)
    if (!Number.isSafeInteger(tokens[key])) tokens[key] = null;
  return tokens;
}

export function consistentUsage(tokens: SessionTokens | null): boolean {
  if (!tokens || tokens.input_tokens === null || tokens.output_tokens === null ||
    tokens.total_tokens === null || tokens.cached_input_tokens === null) return false;
  return tokens.input_tokens + tokens.output_tokens === tokens.total_tokens &&
    tokens.cached_input_tokens <= tokens.input_tokens &&
    (tokens.reasoning_output_tokens === null || tokens.reasoning_output_tokens <= tokens.output_tokens);
}

export function recordType(header: Buffer): string | undefined {
  return /"type"\s*:\s*"([\w-]+)"/.exec(header.subarray(0, 512).toString())?.[1];
}
