import {expect,it} from 'vitest';
import {activityResultPreview,conversationActivity} from '../src/services/conversation-activity.js';
it('shows bounded tool labels and real elapsed time without output, reasoning or credentials',()=>{
  const item={id:'tool',type:'commandExecution',command:'curl --token my-private-token https://example.test',output:'PRIVATE_OUTPUT'};
  const start=conversationActivity(item,false,undefined,1000)!;
  expect(start.label).toContain('[隐藏]');expect(start.input_preview).toContain('curl');expect(start.input_preview).not.toContain('my-private-token');expect(JSON.stringify(start)).not.toMatch(/my-private-token|PRIVATE_OUTPUT/);
  expect(conversationActivity(item,true,start,4500)).toMatchObject({status:'completed',duration_ms:3500});
  expect(conversationActivity({id:'reason',type:'reasoning',text:'private'},false)).toBeNull();
  expect(conversationActivity({id:'mcp',type:'mcpToolCall',server:'tools',tool:'exec',arguments:'PRIVATE_ARGUMENTS'},false)?.label).toBe('调用工具 · tools / exec');
});
it('keeps unknown historical activity times unknown on reconnect',()=>{
  const item={id:'tool',type:'commandExecution',command:'rg src'};
  expect(conversationActivity(item,true,undefined,null)).toMatchObject({started_at:null,completed_at:null,duration_ms:null});
  expect(conversationActivity({...item,startedAtMs:1000,completedAtMs:4000},true,undefined,null)?.duration_ms).toBe(3000);
});

it('includes only bounded redacted text results and ignores non-text or malformed blocks',()=>{
  const result=conversationActivity({id:'mcp',type:'mcpToolCall',result:{content:[{type:'text',text:'tests passed token=private-secret'},{type:'image',data:'PRIVATE_IMAGE'}]}},true)!;
  expect(result.result_preview).toContain('tests passed');expect(result.result_preview).not.toContain('private-secret');expect(JSON.stringify(result)).not.toContain('PRIVATE_IMAGE');
  expect(conversationActivity({id:'bad',type:'mcpToolCall',result:{content:'malformed'}},true)?.result_preview).toBeUndefined();
  expect(activityResultPreview('x'.repeat(10000)+'newest result')).toHaveLength(2000);
  expect(activityResultPreview('x'.repeat(10000)+'newest result')).toContain('newest result');
  expect(activityResultPreview('https://user:pass@example.test/path?token=hidden')).toBe('https://example.test/path');
});
