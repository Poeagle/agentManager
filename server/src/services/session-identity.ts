import { basename } from 'path';

export type CliType = 'claude' | 'codex';

export interface NativeConversationFields {
  cli_type?: CliType | null;
  claude_session_id?: string | null;
  codex_session_id?: string | null;
}

export interface ClaudeLogCandidate {
  id: string;
  startedAt: number;
}

export interface CodexRolloutCandidate {
  id: string;
  cwd: string;
  startedAt: number;
  firstPrompt: string;
}

export const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function nativeConversationId(session: NativeConversationFields): string | null {
  return session.cli_type === 'codex'
    ? session.codex_session_id ?? null
    : session.claude_session_id ?? null;
}

/** Identify only the real top-level CLI executable, not similarly named args. */
export function cliTypeFromArgv(args: string[]): CliType | null {
  const command = basename(args[0] || '').toLowerCase();
  if (command === 'codex') return 'codex';
  if (command === 'claude') return 'claude';
  return null;
}

/** Codex keeps the active rollout JSONL open; exactly one UUID must be visible. */
export function codexSessionIdFromOpenTargets(targets: Iterable<string>): string | null {
  const ids = new Set<string>();
  for (const target of targets) {
    const match = /\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?: \(deleted\))?$/i.exec(target);
    if (match && NATIVE_SESSION_ID_RE.test(match[1])) ids.add(match[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Read the durable identity from the first session_meta entry in a Codex
 * rollout prefix. The entry's outer timestamp may be delayed until Codex first
 * flushes output, so recovery must use payload.timestamp (the actual launch
 * time) instead.
 */
export function codexRolloutCandidateFromPrefix(prefix: string, fallbackId: string): CodexRolloutCandidate | null {
  const firstLine = prefix.slice(0, prefix.indexOf('\n') >= 0 ? prefix.indexOf('\n') : prefix.length);
  try {
    const entry = JSON.parse(firstLine) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: { session_id?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown };
    };
    if (entry.type !== 'session_meta' || !entry.payload) return null;
    const rawId = typeof entry.payload.session_id === 'string'
      ? entry.payload.session_id
      : typeof entry.payload.id === 'string'
        ? entry.payload.id
        : fallbackId;
    const id = NATIVE_SESSION_ID_RE.test(rawId) ? rawId : fallbackId;
    const timestamp = typeof entry.payload.timestamp === 'string'
      ? entry.payload.timestamp
      : typeof entry.timestamp === 'string'
        ? entry.timestamp
        : '';
    const cwd = typeof entry.payload.cwd === 'string' ? entry.payload.cwd : '';
    const startedAt = Date.parse(timestamp);
    if (!NATIVE_SESSION_ID_RE.test(id) || !cwd || !Number.isFinite(startedAt)) return null;

    let firstPrompt = '';
    const promptMatch = /"type":"user_message","message":("(?:\\.|[^"\\])*")/.exec(prefix);
    if (promptMatch) {
      try { firstPrompt = JSON.parse(promptMatch[1]); } catch { /* optional */ }
    }
    return { id, cwd, startedAt, firstPrompt };
  } catch {
    return null;
  }
}

/** Select only an unambiguous rollout for a project and launch time. */
export function selectCodexRolloutCandidate(
  startedAt: number,
  projectPath: string,
  candidates: CodexRolloutCandidate[],
  usedIds: ReadonlySet<string> = new Set(),
  expectedPrompt = '',
  matchWindowMs = 5 * 60 * 1000,
): string | null {
  let matches = candidates.filter((candidate) =>
    !usedIds.has(candidate.id)
    && candidate.cwd === projectPath
    && Math.abs(candidate.startedAt - startedAt) <= matchWindowMs,
  );
  if (matches.length > 1 && expectedPrompt) {
    const byPrompt = matches.filter((candidate) => candidate.firstPrompt.includes(expectedPrompt));
    if (byPrompt.length === 1) matches = byPrompt;
  }
  return matches.length === 1 ? matches[0].id : null;
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
