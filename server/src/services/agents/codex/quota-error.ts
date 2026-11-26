/** Codex subscription exhaustion is distinct from transient throttling and API billing. */
export function codexQuotaExhausted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const source = error as Record<string, unknown>;
  const info = source.codexErrorInfo ?? source.codex_error_info ?? source.code;
  const name = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  if (name && ['usagelimitexceeded', 'usagelimitreached'].includes(name.replaceAll('_', '').toLowerCase())) return true;
  return typeof source.message === 'string' &&
    /(?:you(?:'ve| have) (?:hit|reached) your (?:codex )?usage limit|\bcodex (?:usage|subscription) limit (?:reached|exceeded)|\busage_limit_(?:reached|exceeded)\b)/i.test(source.message);
}
