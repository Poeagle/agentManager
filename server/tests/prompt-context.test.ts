import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractClaudePromptContext,
  extractCodexPromptContext,
  limitPromptContext,
  loadPromptContextFromFile,
  MAX_PROMPT_CONTEXT_CHARS,
} from '../src/services/prompt-context.js';

describe('prompt enhancement conversation context', () => {
  it('keeps Claude human prompts and end-turn text while excluding tools, thinking, and unfinished work', () => {
    const turns = extractClaudePromptContext([
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: '修复标签页黑屏' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '我先检查。' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'secret command output' }] } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '已修复重挂载导致的黑屏。' }] } },
      { type: 'system', subtype: 'turn_duration' },
      { type: 'user', message: { role: 'user', content: '这轮还没完成' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '中间进度，不是结论。' }] } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'no visible conclusion' }] } },
    ], 5);

    expect(turns).toEqual([
      { user: '修复标签页黑屏', assistant: '已修复重挂载导致的黑屏。' },
    ]);
    expect(JSON.stringify(turns)).not.toContain('secret command output');
    expect(JSON.stringify(turns)).not.toContain('我先检查');
  });

  it('uses Codex user_message and final answer events, never commentary or reasoning', () => {
    const turns = extractCodexPromptContext([
      { type: 'event_msg', payload: { type: 'user_message', message: '排查复制问题' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: 'hidden reasoning' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '正在检查。' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '候选最终回答' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已隔离复制操作，不会写入终端。' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '未完成问题' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '未完成进度' }] } },
    ], 5);

    expect(turns).toEqual([
      { user: '排查复制问题', assistant: '已隔离复制操作，不会写入终端。' },
    ]);
    expect(JSON.stringify(turns)).not.toContain('正在检查');
    expect(JSON.stringify(turns)).not.toContain('hidden reasoning');
  });

  it('keeps only the configured newest rounds within the context budget', () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({
      user: `user-${index}-${'u'.repeat(2_000)}`,
      assistant: `answer-${index}-${'a'.repeat(2_000)}`,
    }));
    const selected = limitPromptContext(turns, 10);

    expect(selected.at(-1)?.user).toContain('user-11');
    expect(selected[0].user).not.toContain('user-0');
    expect(selected.reduce((sum, turn) => sum + turn.user.length + turn.assistant.length, 0))
      .toBeLessThanOrEqual(MAX_PROMPT_CONTEXT_CHARS);
    expect(limitPromptContext(turns, 0)).toEqual([]);
  });

  it('reads backward from a large Codex log until enough complete turns are found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmanager-context-tail-'));
    const file = join(dir, 'rollout.jsonl');
    const completed = (index: number) => [
      { type: 'event_msg', payload: { type: 'user_message', message: `user-${index}` } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `final-${index}` } },
    ];
    const entries = [
      ...completed(1),
      ...completed(2),
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x'.repeat(6 * 1024 * 1024) } },
      ...completed(3),
    ];
    try {
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n'));
      await expect(loadPromptContextFromFile(file, 'codex', 3)).resolves.toEqual([
        { user: 'user-1', assistant: 'final-1' },
        { user: 'user-2', assistant: 'final-2' },
        { user: 'user-3', assistant: 'final-3' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
