import {act,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationRetryStatus,type ConversationRetry} from '../src/components/ConversationRetryStatus';
const base:ConversationRetry={session_id:'session',native_id:'native',root_turn_id:'root',failed_turn_ids:['root'],attempt:0,max_attempts:3,status:'waiting',next_retry_at:null};
afterEach(()=>vi.useRealTimers());
describe('automatic retry status',()=>{
 it('distinguishes a cancelled plan with zero dispatches from exhausted retries and shows the reason',()=>{
  render(<ConversationRetryStatus retry={{...base,status:'cancelled',attempt:0,stop_reason:'final_answer'}}/>);
  expect(screen.getByRole('status')).toHaveTextContent('已尝试 0/3 次');expect(screen.getByRole('status')).toHaveTextContent('停止原因：该轮已给出最终答复。');expect(screen.getByRole('status')).not.toHaveTextContent('已达上限');
 });
 it('counts down the next attempt and allows stopping it',async()=>{
  vi.useFakeTimers();const cancel=vi.fn().mockResolvedValue(undefined);
  render(<ConversationRetryStatus retry={{...base,next_retry_at:new Date(Date.now()+10000).toISOString()}} onCancel={cancel}/>);
  expect(screen.getByRole('status')).toHaveTextContent('10 秒后自动重试（1/3）');act(()=>vi.advanceTimersByTime(1000));expect(screen.getByRole('status')).toHaveTextContent('9 秒后自动重试（1/3）');
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'停止自动重试'})));expect(cancel).toHaveBeenCalledTimes(1);
 });
 it.each([['running','正在自动重试（2/3）'],['succeeded','已自动恢复（2/3）'],['exhausted','自动重试已达上限（3/3）'],['unknown','提交结果尚未确认'],['cancelled','自动重试已停止']])('shows %s clearly', (status,label)=>{
  render(<ConversationRetryStatus retry={{...base,status:status as ConversationRetry['status'],attempt:2}}/>);expect(screen.getByRole('status')).toHaveTextContent(label);expect(screen.queryByRole('button')).not.toBeInTheDocument();
 });
});
