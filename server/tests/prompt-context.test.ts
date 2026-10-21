import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractClaudePromptContext,
  extractAgentMessages,
  extractCodexPromptContext,
  limitPromptContext,
  loadPromptContextFromFile,
  MAX_PROMPT_CONTEXT_CHARS,
} from '../src/services/prompt-context.js';

describe('prompt enhancement conversation context', () => {
  it('keeps automatic goal replies associated with the original human task and hides internal instructions', () => {
    const prompt='查看未完成 Jira [Platform task reference: original-task]';
    const internal='<codex_internal_context source="goal">internal continuation instructions</codex_internal_context>';
    const entries=[
      {type:'event_msg',payload:{type:'user_message',message:prompt}},
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'正在检查连接'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:internal}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'继续检查项目历史'}]}},
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'仍未找到接入，请提供 Jira 项目链接。'}},
      {type:'event_msg',payload:{type:'user_message',message:internal}},
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'任务受阻，请提供 Jira 项目或筛选器链接。'}},
    ];
    const messages=extractAgentMessages(entries,'codex');
    expect(messages.filter(message=>message.role==='user').map(message=>message.text)).toEqual([prompt]);
    expect(messages.at(-1)).toMatchObject({phase:'final',task_reference:'original-task',text:'任务受阻，请提供 Jira 项目或筛选器链接。'});
    expect(JSON.stringify(messages)).not.toContain('internal continuation instructions');
    expect(extractCodexPromptContext(entries,1)).toEqual([{user:prompt,assistant:'任务受阻，请提供 Jira 项目或筛选器链接。'}]);
    // A genuine new human prompt breaks the old task association.
    const next=[...entries,{type:'event_msg',payload:{type:'user_message',message:'改查别的项目'}},{type:'event_msg',payload:{type:'task_complete',last_agent_message:'新请求的答复'}}];
    expect(extractAgentMessages(next,'codex').at(-1)?.task_reference).toMatch(/^native:/);
    expect(extractCodexPromptContext(next,1)).toEqual([{user:'改查别的项目',assistant:'新请求的答复'}]);
  });
  it('extracts Codex progress and final messages while excluding tools, reasoning and duplicate event records', () => {
    const messages=extractAgentMessages([
      {type:'event_msg',payload:{type:'user_message',message:'查询 Jira'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'查询 Jira'}]}},
      {type:'response_item',payload:{type:'reasoning',text:'hidden thought'}},
      {type:'response_item',payload:{type:'function_call',arguments:'private arguments'}},
      {type:'response_item',payload:{type:'function_call_output',output:'private result'}},
      {type:'event_msg',payload:{type:'agent_message',message:'正在检查已有配置'}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'正在检查已有配置'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'找到三个未完成问题'}]}},
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'找到三个未完成问题'}},
    ],'codex');
    expect(messages.map(({role,phase,text})=>({role,phase,text}))).toEqual([
      {role:'user',phase:'user',text:'查询 Jira'},
      {role:'assistant',phase:'commentary',text:'正在检查已有配置'},
      {role:'assistant',phase:'final',text:'找到三个未完成问题'},
    ]);
  });
  it('extracts Claude text messages while ignoring nested tool results, thinking and sidechains', () => {
    const messages=extractAgentMessages([
      {type:'user',message:{role:'user',content:'检查配置'}},
      {type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'hidden'},{type:'tool_use',input:{token:'private'}},{type:'text',text:'正在检查'}]}},
      {type:'user',message:{role:'user',content:[{type:'tool_result',content:[{type:'text',text:'private result'}]}]}},
      {type:'assistant',isSidechain:true,message:{role:'assistant',content:'subagent detail'}},
      {type:'assistant',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'需要你确认项目范围'}]}},
    ],'claude');
    expect(messages.map(m=>m.text)).toEqual(['检查配置','正在检查','需要你确认项目范围']);
    expect(messages.at(-1)?.phase).toBe('final');
  });
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
  it('reads Codex response-item user prompts when user_message events are absent', () => {
    const turns = extractCodexPromptContext([
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>metadata</environment_context>'}]}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'只读分析项目 [Platform task reference: task-one]'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'正在读取文件'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'已完成源码分析，未修改文件。'}]}},
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'已完成源码分析，未修改文件。'}},
    ],1);
    expect(turns).toEqual([{user:'只读分析项目 [Platform task reference: task-one]',assistant:'已完成源码分析，未修改文件。'}]);
  });
  it('deduplicates dual-format Codex prompts and keeps later interrupted work out', () => {
    const prompt={type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'完成第一轮'}]}};
    expect(extractCodexPromptContext([
      {type:'event_msg',payload:{type:'user_message',message:'完成第一轮'}},prompt,
      {type:'event_msg',payload:{type:'task_complete',last_agent_message:'第一轮结果'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'未完成第二轮'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'还在处理中'}]}},
    ],5)).toEqual([{user:'完成第一轮',assistant:'第一轮结果'}]);
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
