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
