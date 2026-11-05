import {describe,expect,it,vi} from 'vitest';
import {scheduleConversationUpload} from '../src/lib/conversation-upload-queue';
describe('shared conversation upload queue',()=>{
 it('serializes question fields in one session while keeping other sessions independent',async()=>{
  let finish!:()=>void;const order:string[]=[],first=scheduleConversationUpload('same',async()=>{order.push('first');await new Promise<void>(resolve=>{finish=resolve;});});
  const second=scheduleConversationUpload('same',async()=>{order.push('second');});const other=scheduleConversationUpload('other',async()=>{order.push('other');});
  await other;expect(order).toEqual(['first','other']);finish();await Promise.all([first,second]);expect(order).toEqual(['first','other','second']);
 });
 it('does not let a rejected upload poison the queue or start a canceled queued task',async()=>{
  const controller=new AbortController(),work=vi.fn(),first=scheduleConversationUpload('failed',async()=>{throw Error('network');});
  const canceled=scheduleConversationUpload('failed',async()=>{if(!controller.signal.aborted)work();});controller.abort();
  await expect(first).rejects.toThrow('network');await canceled;expect(work).not.toHaveBeenCalled();await scheduleConversationUpload('failed',async()=>{work();});expect(work).toHaveBeenCalledOnce();
 });
});
