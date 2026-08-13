import { describe, expect, it } from 'vitest';
import { effectiveSettings } from '../src/routes/settings.js';

describe('settings defaults', () => {
  it('always exposes Claude and Codex commands with all-permissions flags', () => {
    expect(effectiveSettings([])).toMatchObject({
      session_claude_command: 'claude --dangerously-skip-permissions',
      session_codex_command: 'codex --dangerously-bypass-approvals-and-sandbox',
      agent_claude_command: 'claude --dangerously-skip-permissions',
      agent_codex_command: 'codex --dangerously-bypass-approvals-and-sandbox',
    });

    expect(effectiveSettings([
      { key: 'agent_claude_command', value: 'CLAUDE_CODE_DISABLE_MOUSE=1 claude' },
      { key: 'session_codex_command', value: 'codex --yolo' },
    ])).toMatchObject({
      agent_claude_command: 'CLAUDE_CODE_DISABLE_MOUSE=1 claude --dangerously-skip-permissions',
      session_codex_command: 'codex --yolo',
    });
  });
});
