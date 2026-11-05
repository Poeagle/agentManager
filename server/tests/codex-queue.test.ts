import {describe,expect,it,vi} from 'vitest';
import {readCodexQueue} from '../src/services/agents/codex/queue.js';
describe('bounded native queue pagination',()=>{
 it('preserves the existing 100-entry view and reports its continuation',async()=>{
  const request=vi.fn(async(_method,params:any)=>{const offset=Number(params.cursor||0);return {data:Array.from({length:4},(_,i)=>({id:offset+i})),nextCursor:String(offset+4)};});
  const result=await readCodexQueue(request,'thread');expect(result.data.map(item=>item.id)).toEqual(Array.from({length:100},(_,i)=>i));expect(result.nextCursor).toBe('100');expect(request).toHaveBeenCalledTimes(25);
 });
 it('stops malformed providers from endlessly replaying one cursor',async()=>{
  const request=vi.fn().mockResolvedValue({data:[],nextCursor:'same'});await expect(readCodexQueue(request,'thread')).rejects.toThrow('未前进');expect(request).toHaveBeenCalledTimes(2);
 });
 it('bounds empty advancing pages as well as accumulated items',async()=>{
  let cursor=0;const request=vi.fn(async()=>({data:[],nextCursor:String(++cursor)}));await expect(readCodexQueue(request,'thread')).rejects.toThrow('未完成');expect(request).toHaveBeenCalledTimes(25);
 });
});
