import {act,cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ConversationActivityLine,type ConversationActivity} from '../src/components/ConversationActivityLine';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('scrolls new UI-only tool steps through one row, displays durations and clears on completion',()=>{
  vi.useFakeTimers();
  const activity=(id:string,label:string):ConversationActivity=>({id,label,status:'running',started_at:'2026-10-30T07:00:00Z',completed_at:null,duration_ms:null});
  const now=Date.parse('2026-10-30T07:00:05Z');
  const first=activity('first','运行命令 · rg source');
  const view=render(<ConversationActivityLine activities={[first]} busy now={now} totalElapsed={15000} fallback="正在执行任务…"/>);
  expect(screen.getByTestId('conversation-activity-line').textContent).toContain('运行命令 · rg source');
  expect(screen.getByText('5秒')).toBeTruthy();expect(screen.getByText('本轮 15秒')).toBeTruthy();
  const second=activity('second','修改文件 · app.ts');
  view.rerender(<ConversationActivityLine activities={[first,second]} busy now={now} totalElapsed={15000} fallback="正在执行任务…"/>);
  expect(screen.getByText('修改文件 · app.ts')).toBeTruthy();
  expect(screen.queryByText('运行命令 · rg source')).toBeNull();
  view.rerender(<ConversationActivityLine activities={[first,second]} busy={false} now={now} totalElapsed={15000} fallback="可以继续发送消息"/>);
  expect(screen.getByText('可以继续发送消息')).toBeTruthy();expect(screen.queryByText('修改文件 · app.ts')).toBeNull();
});
it('immediately replaces a running step with its completion or a newer native step',()=>{
 const first={id:'first',label:'旧步骤',status:'running' as const,started_at:null,completed_at:null,duration_ms:null};
 const view=render(<ConversationActivityLine activities={[first]} busy now={Date.now()} totalElapsed={0} fallback="任务进行中"/>);
 view.rerender(<ConversationActivityLine activities={[{...first,status:'completed',duration_ms:2}]} busy now={Date.now()} totalElapsed={0} fallback="任务进行中"/>);
 expect(screen.getByTestId('conversation-activity-line')).toHaveTextContent('执行中 · 最近完成 · 旧步骤');
 view.rerender(<ConversationActivityLine activities={[{...first,status:'completed'},{...first,id:'new',label:'最新步骤'}]} busy now={Date.now()} totalElapsed={0} fallback="任务进行中"/>);
 expect(screen.getByTestId('conversation-activity-line')).toHaveTextContent('最新步骤');expect(screen.queryByText('执行中 · 最近完成 · 旧步骤')).toBeNull();
});
