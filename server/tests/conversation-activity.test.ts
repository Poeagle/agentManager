import {expect,it} from 'vitest';
import {conversationActivity} from '../src/services/conversation-activity.js';
it('shows bounded tool labels and real elapsed time without output, reasoning or credentials',()=>{
  const item={id:'tool',type:'commandExecution',command:'curl --token my-private-token https://example.test',output:'PRIVATE_OUTPUT'};
  const start=conversationActivity(item,false,undefined,1000)!;
  expect(start.label).toContain('[隐藏]');expect(JSON.stringify(start)).not.toMatch(/my-private-token|PRIVATE_OUTPUT/);
  expect(conversationActivity(item,true,start,4500)).toMatchObject({status:'completed',duration_ms:3500});
  expect(conversationActivity({id:'reason',type:'reasoning',text:'private'},false)).toBeNull();
  expect(conversationActivity({id:'mcp',type:'mcpToolCall',server:'tools',tool:'exec',arguments:'PRIVATE_ARGUMENTS'},false)?.label).toBe('调用工具 · tools / exec');
});
it('keeps unknown historical activity times unknown on reconnect',()=>{
  const item={id:'tool',type:'commandExecution',command:'rg src'};
  expect(conversationActivity(item,true,undefined,null)).toMatchObject({started_at:null,completed_at:null,duration_ms:null});
  expect(conversationActivity({...item,startedAtMs:1000,completedAtMs:4000},true,undefined,null)?.duration_ms).toBe(3000);
});
