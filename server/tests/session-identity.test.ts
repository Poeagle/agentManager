import { describe, expect, it } from 'vitest';
import {
  cliTypeFromArgv,
  codexRolloutCandidateFromPrefix,
  codexSessionIdFromOpenTargets,
  explicitClaudeSessionId,
  nativeConversationId,
  selectCodexRolloutCandidate,
  selectClaudeSessionCandidate,
} from '../src/services/session-identity.js';

const CODEX_ID = '019f7f9d-6ad7-7110-8615-8410399fd932';
const CLAUDE_ID = '766a36a0-959f-4544-a2b4-487f542e847a';

describe('nativeConversationId', () => {
  it('uses the native id for the selected CLI', () => {
    expect(nativeConversationId({ cli_type: 'codex', codex_session_id: CODEX_ID, claude_session_id: CLAUDE_ID })).toBe(CODEX_ID);
    expect(nativeConversationId({ cli_type: 'claude', codex_session_id: CODEX_ID, claude_session_id: CLAUDE_ID })).toBe(CLAUDE_ID);
    expect(nativeConversationId({ claude_session_id: CLAUDE_ID })).toBe(CLAUDE_ID);
  });
});

describe('CLI process recognition', () => {
  it('recognizes direct Claude and Codex executables', () => {
    expect(cliTypeFromArgv(['/usr/local/bin/codex', '--yolo'])).toBe('codex');
    expect(cliTypeFromArgv(['/home/user/.local/bin/claude', '--resume', CLAUDE_ID])).toBe('claude');
  });

  it('does not mistake a shell argument for a CLI process', () => {
    expect(cliTypeFromArgv(['/bin/zsh', '-c', 'codex --yolo'])).toBeNull();
    expect(cliTypeFromArgv(['/usr/bin/node', '/tmp/codex-helper.js'])).toBeNull();
  });
});

describe('Codex rollout identity', () => {
  it('extracts one UUID from an open rollout path', () => {
    const target = `/home/user/.codex/sessions/2026/07/20/rollout-2026-07-20T21-00-50-${CODEX_ID}.jsonl`;
    expect(codexSessionIdFromOpenTargets(['/dev/null', target, target])).toBe(CODEX_ID);
  });

  it('accepts a deleted-but-open rollout and rejects ambiguity', () => {
    const other = '123e4567-e89b-12d3-a456-426614174000';
    expect(codexSessionIdFromOpenTargets([`/tmp/rollout-x-${CODEX_ID}.jsonl (deleted)`])).toBe(CODEX_ID);
    expect(codexSessionIdFromOpenTargets([
      `/tmp/rollout-x-${CODEX_ID}.jsonl`,
      `/tmp/rollout-y-${other}.jsonl`,
    ])).toBeNull();
  });

  it('uses the session launch timestamp instead of a delayed outer event timestamp', () => {
    const prefix = [
      JSON.stringify({
        timestamp: '2026-08-03T08:41:28.017Z',
        type: 'session_meta',
        payload: {
          session_id: CODEX_ID,
          timestamp: '2026-08-03T08:35:43.220Z',
          cwd: '/workspace/project',
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix OPS-397' } }),
    ].join('\n');
    expect(codexRolloutCandidateFromPrefix(prefix, CODEX_ID)).toEqual({
      id: CODEX_ID,
      cwd: '/workspace/project',
      startedAt: Date.parse('2026-08-03T08:35:43.220Z'),
      firstPrompt: 'Fix OPS-397',
    });
  });

  it('selects one unused rollout by project and launch time and refuses ambiguity', () => {
    const startedAt = Date.parse('2026-08-03T08:35:39.000Z');
    const other = '123e4567-e89b-12d3-a456-426614174000';
    const candidates = [
      { id: CODEX_ID, cwd: '/workspace/project', startedAt: startedAt + 4_000, firstPrompt: 'Fix OPS-397' },
      { id: other, cwd: '/workspace/other', startedAt: startedAt + 2_000, firstPrompt: 'Other task' },
    ];
    expect(selectCodexRolloutCandidate(startedAt, '/workspace/project', candidates)).toBe(CODEX_ID);
    expect(selectCodexRolloutCandidate(startedAt, '/workspace/project', [
      ...candidates,
      { id: other, cwd: '/workspace/project', startedAt: startedAt + 5_000, firstPrompt: 'Other task' },
    ])).toBeNull();
    expect(selectCodexRolloutCandidate(startedAt, '/workspace/project', candidates, new Set([CODEX_ID]))).toBeNull();
  });
});

describe('Claude identity selection', () => {
  it('reads explicit session and resume flags', () => {
    expect(explicitClaudeSessionId(['claude', '--session-id', CLAUDE_ID])).toBe(CLAUDE_ID);
    expect(explicitClaudeSessionId(['claude', '-r', `/tmp/${CLAUDE_ID}.jsonl`])).toBe(CLAUDE_ID);
    expect(explicitClaudeSessionId(['claude', '--resume', 'picker-search'])).toBeNull();
  });

  it('selects a unique close JSONL and ignores already-bound ids', () => {
    const startedAt = 1_000_000;
    const other = '123e4567-e89b-12d3-a456-426614174000';
    const candidates = [
      { id: CLAUDE_ID, startedAt: startedAt + 1_300 },
      { id: other, startedAt: startedAt + 20_000 },
    ];
    expect(selectClaudeSessionCandidate(startedAt, candidates)).toBe(CLAUDE_ID);
    expect(selectClaudeSessionCandidate(startedAt, candidates, new Set([CLAUDE_ID]))).toBe(other);
  });

  it('refuses two nearly-equivalent candidates or an out-of-window log', () => {
    const startedAt = 1_000_000;
    expect(selectClaudeSessionCandidate(startedAt, [
      { id: CLAUDE_ID, startedAt: startedAt + 1_000 },
      { id: CODEX_ID, startedAt: startedAt + 2_000 },
    ])).toBeNull();
    expect(selectClaudeSessionCandidate(startedAt, [
      { id: CLAUDE_ID, startedAt: startedAt + 31_000 },
    ])).toBeNull();
  });
});
