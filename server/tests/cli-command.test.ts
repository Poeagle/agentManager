import { describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  buildSessionCommand,
  codexIdentityFlags,
  shellSingleQuote,
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
    expect(command).toContain('codex --yolo resume');
    expect(command).toContain(`--no-alt-screen`);
    expect(command).toContain(SESSION_ID);
    expect(command).toContain('/tmp/binding.json');
    expect(command).toContain('--dangerously-bypass-hook-trust');
    expect(command).not.toContain('old task');
  });

  it('builds Claude and Codex agent commands without shell injection', () => {
    const claude = buildAgentCommand('reviewer', "inspect 'quoted' input", false, 'claude', 'claude', SESSION_ID);
    expect(claude).toContain(`--session-id ${SESSION_ID} --agent 'reviewer'`);
    expect(claude).toContain(`'inspect '\\''quoted'\\'' input'`);

    const codex = buildAgentCommand('reviewer', '', false, 'codex', 'codex');
    expect(codex).toBe("codex --no-alt-screen 'You are a reviewer agent. Ask me what I want you to do.'");
  });

  it('quotes arbitrary shell values and omits hooks without a binding path', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
    expect(codexIdentityFlags()).toBe('');
  });
});
