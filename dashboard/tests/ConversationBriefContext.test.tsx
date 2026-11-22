import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
import {ConversationBriefContext} from '../src/components/ConversationBriefContext';

afterEach(cleanup);
it('opens a compact card with readable turns and an explicit truncation notice',async()=>{
  const user=userEvent.setup();
  render(<ConversationBriefContext messageId="brief" active projectId={null} onNavigate={()=>{}} context={{version:1,truncated:true,older_omitted:false,omitted_turns:0,turns:[
    {input:'第一个问题',progress:'正在处理',conclusion:'**第一个结论**',attachments:[{kind:'file',name:'说明.txt',path:'/project/说明.txt'}]},
    {input:'第二个问题',conclusion:'第二个结论'},
  ]}}/>);
  const trigger=screen.getByRole('button',{name:/简要压缩/});
  expect(trigger).toHaveTextContent('2 轮');expect(trigger).toHaveTextContent('部分记录已截取');
  expect(screen.queryByText('第一个问题')).toBeNull();
  await user.click(trigger);
  const dialog=screen.getByRole('dialog',{name:'简要压缩详情'});
  expect(within(dialog).getByText('第一个问题')).toBeVisible();
  expect(within(dialog).getByText('第一个结论')).toBeVisible();
  expect(within(dialog).getByText('正在处理')).toBeVisible();
  expect(within(dialog).getByText('/project/说明.txt')).toBeVisible();
  expect(within(dialog).getByText(/完整记录仍可在原会话中查看/)).toBeVisible();
  await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();
});

it('shows scheduled runs and their shared prompt reference as separate turns',async()=>{
  const user=userEvent.setup();
  render(<ConversationBriefContext messageId="brief" active projectId={null} onNavigate={()=>{}} context={{
    version:1,truncated:false,older_omitted:false,omitted_turns:0,turns:[
      {input:'巡检服务',scheduled_task:'每日巡检',conclusion:'第一次结果'},
      {input:'同第 1 轮定时任务提示词',input_ref:1,scheduled_task:'每日巡检',conclusion:'第二次结果'},
    ],
  }}/>);
  await user.click(screen.getByRole('button',{name:/简要压缩/}));
  const dialog=screen.getByRole('dialog',{name:'简要压缩详情'});
  expect(within(dialog).getByText('第 1 轮 · 定时任务：每日巡检')).toBeVisible();
  expect(within(dialog).getByText('第 2 轮 · 定时任务：每日巡检')).toBeVisible();
  expect(within(dialog).getByText('巡检服务')).toBeVisible();
  expect(within(dialog).getByText('同第 1 轮定时任务提示词')).toBeVisible();
  expect(within(dialog).getByText('第一次结果')).toBeVisible();
  expect(within(dialog).getByText('第二次结果')).toBeVisible();
});

it('opens a historical screenshot from the brief details through project preview',async()=>{
  const user=userEvent.setup();
  render(<ConversationBriefContext messageId="brief" active projectId="p" onNavigate={()=>{}} context={{
    version:1,truncated:false,older_omitted:false,omitted_turns:0,turns:[{
      input:'查看错误',attachments:[{kind:'image',name:'error.png',path:'/project/error.png'}],
    }],
  }}/>);
  await user.click(screen.getByRole('button',{name:/简要压缩/}));
  await user.click(screen.getByRole('button',{name:'打开附件 error.png'}));
  const image=within(screen.getByRole('dialog',{name:'图片预览 · error.png'})).getByRole('img');
  const url=new URL(image.getAttribute('src')!,location.origin);
  expect(url.pathname).toBe('/api/files/preview');
  expect(url.searchParams.get('project_id')).toBe('p');
  expect(url.searchParams.get('path')).toBe('/project/error.png');
});
