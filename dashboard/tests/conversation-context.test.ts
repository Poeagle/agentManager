import {describe,it,expect} from 'vitest';
import {automaticConversationContext,automaticContextMarkdown} from '../src/lib/conversation-context';
import {conversationTimings} from '../src/lib/conversation-timing';
import {conversationOutline} from '../src/components/ConversationReadingTools';
import {groupConversationProgress} from '../src/lib/conversation-progress';
const rules='# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\n# 项目治理\n自动规则\n</INSTRUCTIONS>';
describe('native automatic context',()=>{
 it('unwraps complete native blocks without stripping user examples and displays environment XML faithfully',()=>{
  expect(automaticContextMarkdown('<octoally_shared_resources>\n## 标题\n**内容**\n</octoally_shared_resources>')).toBe('## 共享资源\n\n## 标题\n**内容**');const plain='示例：<environment_context>linux</environment_context>';expect(automaticContextMarkdown(plain)).toBe(plain);expect(automaticContextMarkdown('<environment_context><cwd>/work</cwd></environment_context>')).toContain('```xml\n<cwd>/work</cwd>\n```');
 });
 it('folds coalesced startup rules and environment, retaining ordinary requests after wrappers',()=>{
  const combined=rules+'\n<environment_context>linux</environment_context>';
  expect(automaticConversationContext(combined)).toMatchObject({kind:'combined',label:'项目规则 · 运行环境'});
  expect(automaticConversationContext(combined+'\n请继续处理任务')).toBeNull();
  const messages=[{id:'auto',role:'user' as const,text:combined,timestamp:null}];expect(conversationOutline(messages)).toEqual([]);
 });
 it('labels explicit native project and environment wrappers',()=>{
  expect(automaticConversationContext(rules)).toMatchObject({kind:'project_rules',label:'项目规则'});expect(automaticConversationContext('<environment_context>linux</environment_context>')?.label).toBe('运行环境');expect(automaticConversationContext('<task_notification>done</task_notification>')?.label).toBe('任务通知');
 });
 it('does not fold normal questions, quoted examples or a user request after context',()=>{
  for(const text of ['请修改 AGENTS.md',`例子：\n${rules}`,rules+'\n\n请修复这个问题','# Context from my IDE setup:\n\n## My request for Codex:\n修复问题'])expect(automaticConversationContext(text)).toBeNull();
 });
 it('shows resource injection like project rules without treating it as a question or resetting timing',()=>{
  const text='<octoally_shared_resources>\n凭据文件：/work/.env\n通过本地程序读取凭据。\n</octoally_shared_resources>';
  expect(automaticConversationContext(text)).toEqual({kind:'shared_resources',label:'共享资源',source:'.env · /work/.env'});
  const messages=[{id:'u',role:'user' as const,text:'原问题',timestamp:'2026-01-01T00:00:00Z'},{id:'context',role:'user' as const,text,timestamp:'2026-01-01T00:01:00Z'},{id:'a',role:'assistant' as const,phase:'final' as const,text:'结果',timestamp:'2026-01-01T00:02:00Z'}];
  expect(conversationTimings(messages,0,false).get('a')?.label).toBe('本轮耗时 2分0秒');
  expect(conversationOutline(messages)).toHaveLength(1);
  expect(automaticConversationContext(`示例：${text}`)).toBeNull();
 });
 it('does not treat automatic rules as the latest user question or reset elapsed time',()=>{
  const messages=[{id:'u',role:'user' as const,text:'我的问题',timestamp:'2026-01-01T00:00:00Z'},{id:'auto',role:'user' as const,text:rules,timestamp:'2026-01-01T00:01:00Z'},{id:'a',role:'assistant' as const,phase:'final' as const,text:'结果',timestamp:'2026-01-01T00:02:00Z'}];
  expect(conversationTimings(messages,0,false).get('a')?.label).toBe('本轮耗时 2分0秒');expect(conversationOutline(messages)).toHaveLength(1);expect(conversationOutline(messages)[0].question).toBe('我的问题');
 });
 it('keeps compaction summaries out of ordinary assistant progress and conclusion bubbles',()=>{
  const summary={id:'summary',role:'assistant' as const,phase:'commentary' as const,presentation:'compaction_summary' as const,text:'Compressed context',timestamp:null};
  expect(groupConversationProgress([summary])).toEqual([{kind:'message',id:'summary',message:summary}]);
 });
});
