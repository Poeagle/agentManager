import {NATIVE_SESSION_ID_RE} from '../native-identifiers.js';
export interface ClaudeLogCandidate {
  id: string;
  startedAt: number;
}

/** Claude exposes the native UUID directly when launched with an identity flag. */
export function explicitClaudeSessionId(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    if (!['--session-id', '--resume', '-r'].includes(args[i]) || !args[i + 1]) continue;
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i.exec(args[i + 1]);
    if (match && NATIVE_SESSION_ID_RE.test(match[1])) return match[1];
  }
  return null;
}

/**
 * Select a fresh Claude JSONL by process/log start time. Ambiguous launches are
 * deliberately rejected so a tab can never silently bind to the wrong chat.
 */
export function selectClaudeSessionCandidate(
  processStartedAt: number,
  candidates: ClaudeLogCandidate[],
  usedIds: ReadonlySet<string> = new Set(),
  matchWindowMs = 30_000,
  ambiguityGapMs = 5_000,
): string | null {
  const matches = candidates
    .filter((candidate) => !usedIds.has(candidate.id))
    .map((candidate) => ({ ...candidate, delta: Math.abs(candidate.startedAt - processStartedAt) }))
    .filter((candidate) => candidate.delta <= matchWindowMs)
    .sort((a, b) => a.delta - b.delta);

  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1 && matches[1].delta - matches[0].delta > ambiguityGapMs) return matches[0].id;
  return null;
}
