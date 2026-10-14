import { describe, expect, it } from 'vitest';
import {
  buildSessionCommand,
  codexIdentityFlags,
  shellSingleQuote,
  withAllPermissions,
} from '../src/services/cli-command.js';

const SESSION_ID = '019f7f9d-6ad7-7110-8615-8410399fd932';

describe('CLI command construction', () => {
  it('pins fresh Claude sessions to the assigned native UUID', () => {
    expect(buildSessionCommand("fix user's bug", false, 'claude --model sonnet', 'claude', undefined, SESSION_ID))
      .toBe(`claude --model sonnet --session-id ${SESSION_ID} 'fix user'\\''s bug'`);
  });

  it('resumes Claude without resubmitting the original task', () => {
    const command = buildSessionCommand('do not submit this again', false, 'claude', 'claude', SESSION_ID);
    expect(command).toBe(`claude --resume '${SESSION_ID}'`);
    expect(command).not.toContain('do not submit');
  });

  it('resumes Codex with the exact UUID and durable identity hook', () => {
    const command = buildSessionCommand('old task', true, 'codex --yolo', 'codex', SESSION_ID, undefined, '/tmp/binding.json');
    expect(command).toContain('codex --yolo --disable plugins resume');
    expect(command).toContain(`--no-alt-screen`);
    expect(command).toContain(SESSION_ID);
    expect(command).toContain('/tmp/binding.json');
    expect(command).toContain('--dangerously-bypass-hook-trust');
    expect(command).not.toContain('old task');
  });

  it('quotes arbitrary shell values and omits hooks without a binding path', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
    expect(codexIdentityFlags()).toBe('');
  });

  it('applies explicit all-permissions mode to Claude and Codex exactly once', () => {
    expect(withAllPermissions('claude', 'claude')).toBe('claude --dangerously-skip-permissions');
    expect(withAllPermissions('codex', 'codex')).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(withAllPermissions('codex --yolo', 'codex')).toBe('codex --yolo');
  });
  it('disables plugins for new Codex sessions and every transport', () => {
    for (const direct of [true, false]) {
      expect(buildSessionCommand('hello', direct, 'codex --model example', 'codex')).toContain('--disable plugins');
      expect(buildSessionCommand('hello', direct, 'codex', 'claude')).not.toContain('--disable plugins');
    }
  });

});
