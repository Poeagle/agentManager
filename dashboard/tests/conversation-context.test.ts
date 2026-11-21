import {describe,it,expect} from 'vitest';
import {automaticConversationContext,automaticContextMarkdown} from '../src/lib/conversation-context';
import {conversationTimings} from '../src/lib/conversation-timing';
import {conversationOutline} from '../src/components/ConversationReadingTools';
import {groupConversationProgress,progressGroupStatistics} from '../src/lib/conversation-progress';
it('collapses only consecutive retry errors from the same known turn while preserving the latest state',()=>{
 const retry=(id:string,turn_id:string|undefined,code:string|undefined,will_retry=true)=>({id,role:'assistant' as const,phase:'error' as const,text:id,timestamp:null,turn_id,error:{code,will_retry}});
 const first=retry('first','one','network'),second=retry('second','one','network'),final=retry('final','one','network',false);
 const groups=groupConversationProgress([first,second,final]);expect(groups).toHaveLength(1);expect(groups[0]).toEqual({kind:'message',id:'first',message:final});
 expect(groupConversationProgress([first,retry('different','one','other')])).toHaveLength(2);
 expect(groupConversationProgress([first,retry('other-turn','two','network')])).toHaveLength(2);
 expect(groupConversationProgress([retry('unknown-a',undefined,'network'),retry('unknown-b',undefined,'network')])).toHaveLength(2);
 expect(groupConversationProgress([final,second])).toHaveLength(2);
 expect(groupConversationProgress([first,{id:'user',role:'user',text:'continue',timestamp:null},second])).toHaveLength(3);
});
it('groups consecutive assistant updates across native turn identity changes without crossing user input',()=>{
 const progress=(id:string,turn_id:string)=>({id,role:'assistant' as const,phase:'commentary' as const,text:id,timestamp:null,turn_id});
 const first=progress('one','record-one'),second=progress('two','record-two'),third=progress('three','record-three');
 const groups=groupConversationProgress([{id:'user',role:'user',text:'Inspect',timestamp:null},first,second,third,{id:'followup',role:'user',text:'Continue',timestamp:null},progress('four','record-four')]);
 expect(groups.map(group=>group.kind==='progress'?group.messages.map(message=>message.id):group.message.id)).toEqual([
   'user',['one','two','three'],'followup',['four'],
 ]);
 const missing=groupConversationProgress([
  {id:'first-user',role:'user',text:'First',timestamp:null},
  {...first,turn_id:undefined},
  {id:'second-user',role:'user',text:'Second',timestamp:null},
  {...second,turn_id:undefined},
 ]);
 expect(missing.map(group=>group.kind==='progress'?group.messages.map(message=>message.id):group.message.id)).toEqual([
  'first-user',['one'],'second-user',['two'],
 ]);
 const blockOnly={id:'tool-only',role:'assistant' as const,text:'',timestamp:null,phase:'commentary' as const,content_blocks:[{type:'tool_use' as const,index:0,id:'tool',name:'Read',input:{},status:'completed' as const}]};
 expect(groupConversationProgress([{id:'input',role:'user',text:'Inspect',timestamp:null},blockOnly,{...blockOnly,id:'tool-only-two'}]))
  .toMatchObject([{kind:'message',message:{id:'input'}},{kind:'progress',messages:[{id:'tool-only'},{id:'tool-only-two'}]}]);
});
it('keeps a late native Item with its original Progress even after a confirmed user insertion',()=>{
 const item=(id:string,progress_id:string)=>({id,role:'assistant' as const,phase:'commentary' as const,
   text:id,timestamp:null,statistics:{sequence:1,turn_id:'turn',progress_id,
     tokens:null,requests:1,tool_calls:0,tool_rounds:0,complete:true}});
 const groups=groupConversationProgress([
   item('earlier','first'),{id:'steer',role:'user',text:'Continue',timestamp:null},
   item('late','first'),item('new','second'),
 ]);
 expect(groups.map(group=>group.kind==='progress'?group.messages.map(message=>message.id):group.message.id))
   .toEqual([['earlier','late'],'steer',['new']]);
});
it('groups adjacent progress items across statistics segments until the next user input',()=>{
 const item=(id:string,progress_id:string)=>({id,role:'assistant' as const,phase:'commentary' as const,
   text:id,timestamp:null,statistics:{sequence:1,turn_id:'turn',progress_id,
     tokens:null,requests:1,tool_calls:0,tool_rounds:0,complete:true}});
 const groups=groupConversationProgress([
  item('first','segment-one'),item('second','segment-two'),
  {id:'followup',role:'user' as const,text:'Continue',timestamp:null},
  item('third','segment-three'),
 ]);
 expect(groups.map(group=>group.kind==='progress'?group.messages.map(message=>message.id):group.message.id))
  .toEqual([['first','second'],'followup',['third']]);
});
it('uses the group segment when recorded and falls back to cumulative native turn usage',()=>{
 const segment={id:'segment',start_at:null,end_at:null,elapsed_ms:null,end_reason:null,tokens:{total_tokens:300},requests:1,tool_calls:2,tool_rounds:1,complete:true};
 const messages=[
  {id:'one',role:'assistant' as const,phase:'commentary' as const,text:'one',timestamp:null,turn_id:'native-one',statistics:{sequence:1,message_id:'one',turn_id:'user',tokens:{total_tokens:100},requests:1,tool_calls:1,tool_rounds:1,complete:true}},
  {id:'two',role:'assistant' as const,phase:'commentary' as const,text:'two',timestamp:null,turn_id:'native-two',statistics:{sequence:2,message_id:'two',turn_id:'user',tokens:{total_tokens:300},requests:2,tool_calls:4,tool_rounds:2,complete:true,segment}},
 ];
 expect(progressGroupStatistics(messages)).toMatchObject({turn_id:'user',tokens:{total_tokens:300},requests:1,tool_calls:2,tool_rounds:1,interval:{shared_messages:1}});
 expect(progressGroupStatistics(messages.map(message=>({...message,statistics:{...message.statistics!,segment:undefined}})))).toMatchObject({turn_id:'user',tokens:{total_tokens:300},requests:2,tool_calls:4,tool_rounds:2});
});
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
