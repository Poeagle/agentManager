import {describe,it,expect} from 'vitest';
import {automaticConversationContext} from '../src/lib/conversation-context';
import {conversationTimings} from '../src/lib/conversation-timing';
import {conversationOutline} from '../src/components/ConversationReadingTools';
const rules='# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\n# 项目治理\n自动规则\n</INSTRUCTIONS>';
describe('native automatic context',()=>{
 it('labels explicit native project and environment wrappers',()=>{
  expect(automaticConversationContext(rules)).toMatchObject({kind:'project_rules',label:'项目规则'});expect(automaticConversationContext('<environment_context>linux</environment_context>')?.label).toBe('运行环境');expect(automaticConversationContext('<task_notification>done</task_notification>')?.label).toBe('任务通知');
 });
 it('does not fold normal questions, quoted examples or a user request after context',()=>{
  for(const text of ['请修改 AGENTS.md',`例子：\n${rules}`,rules+'\n\n请修复这个问题','# Context from my IDE setup:\n\n## My request for Codex:\n修复问题'])expect(automaticConversationContext(text)).toBeNull();
 });
 it('does not treat automatic rules as the latest user question or reset elapsed time',()=>{
  const messages=[{id:'u',role:'user' as const,text:'我的问题',timestamp:'2026-01-01T00:00:00Z'},{id:'auto',role:'user' as const,text:rules,timestamp:'2026-01-01T00:01:00Z'},{id:'a',role:'assistant' as const,phase:'final' as const,text:'结果',timestamp:'2026-01-01T00:02:00Z'}];
  expect(conversationTimings(messages,0,false).get('a')?.label).toBe('本轮耗时 2分0秒');expect(conversationOutline(messages)).toHaveLength(1);expect(conversationOutline(messages)[0].question).toBe('我的问题');
 });
});
