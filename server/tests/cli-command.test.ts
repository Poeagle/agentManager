import { describe, expect, it,vi } from 'vitest';
import {
  buildSessionCommand,
  codexIdentityFlags,
  shellSingleQuote,
  withAllPermissions,
} from '../src/services/cli-command.js';

const SESSION_ID = '019f7f9d-6ad7-7110-8615-8410399fd932';

describe('CLI command construction', () => {
  it('attaches a remote terminal without submitting the initial task again',()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/chat-preview.sock');
    try {
      const command=buildSessionCommand('already submitted',false,'codex --cd /project','codex',undefined,SESSION_ID);
      expect(command).toContain("--remote 'unix:///tmp/chat-preview.sock'");expect(command).toContain(`resume --no-alt-screen '${SESSION_ID}'`);
      expect(command).not.toContain('already submitted');expect(command).not.toContain('SessionStart');
    } finally {vi.unstubAllEnvs();}
  });
  it('keeps sandboxed members on the embedded CLI even with a shared engine configured',()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/shared.sock');
    try {
      const command=buildSessionCommand('old task',false,'codex --yolo','codex',SESSION_ID,undefined,'/tmp/member-binding.json',null);
      expect(command).not.toContain('--remote');expect(command).toContain('SessionStart');expect(command).toContain('/tmp/member-binding.json');expect(command).toContain(SESSION_ID);expect(command).not.toContain('old task');
    } finally {vi.unstubAllEnvs();}
  });
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
