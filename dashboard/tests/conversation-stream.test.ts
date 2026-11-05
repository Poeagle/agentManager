import {describe,expect,it} from 'vitest';
import {ConversationStreamCursor,applyConversationPatches} from '../src/lib/conversation-stream';
import type {TimelineMessage} from '../src/lib/conversation-timeline';
describe('conversation incremental delivery',()=>{
 it('detects missing events independently of display timestamps and ignores duplicate delivery',()=>{
  const cursor=new ConversationStreamCursor();expect(cursor.observe({type:'queue',stream_id:'one',stream_seq:1})).toBe('accept');expect(cursor.observe({type:'snapshot',stream_id:'one',stream_seq:2})).toBe('accept');
  expect(cursor.observe({type:'patch',stream_id:'one',stream_seq:2})).toBe('ignore');expect(cursor.observe({type:'patch',stream_id:'one',stream_seq:4})).toBe('resync');
  expect(cursor.observe({type:'snapshot',stream_id:'one',stream_seq:4,baseline:true})).toBe('accept');expect(cursor.observe({type:'patch',stream_id:'one',stream_seq:5})).toBe('accept');
 });
 it('merges batched deltas and completion metadata while preserving other messages by identity',()=>{
  const old:TimelineMessage={id:'old',role:'assistant',text:'completed',timestamp:null},stream:TimelineMessage={id:'live',role:'assistant',text:'A',timestamp:null,streaming:true};
  const result=applyConversationPatches([old,stream],[{type:'patch',upserts:[],deltas:[{id:'live',offset:1,text:'B'},{id:'live',offset:2,text:'C'}]}]);
  expect(result.needsSync).toBe(false);expect(result.messages[0]).toBe(old);expect(result.messages[1].text).toBe('ABC');
  const done=applyConversationPatches(result.messages,[{type:'patch',deltas:[],upserts:[{...stream,text:'ABC',streaming:false,timestamp:'2026-11-05T00:00:00Z'}]}]);expect(done.messages[1]).toMatchObject({text:'ABC',streaming:false,timestamp:'2026-11-05T00:00:00Z'});
 });
 it('requests a baseline when a delta prefix is missing, without clearing unsent user content',()=>{
  const draft:TimelineMessage={id:'local',role:'user',text:'unsent',timestamp:null,optimistic:{afterSequence:1}};
  const result=applyConversationPatches([draft],[{type:'patch',upserts:[],deltas:[{id:'unknown',offset:20,text:'tail'}]}]);expect(result.needsSync).toBe(true);expect(result.messages).toEqual([draft]);
 });
 it('rebuilds indexes only across structural updates, preserving aliases and completed items through a batch',()=>{
  const old:TimelineMessage={id:'old',role:'assistant',text:'unchanged',timestamp:null},live:TimelineMessage={id:'persisted',aliases:['native'],role:'assistant',text:'A',timestamp:null,streaming:true};
  const result=applyConversationPatches([old,live],[{type:'patch',upserts:[],deltas:[{id:'native',offset:1,text:'B'}]},{type:'patch',upserts:[{id:'new',role:'assistant',text:'X',timestamp:null,streaming:true}],deltas:[]},{type:'patch',upserts:[],deltas:[{id:'new',offset:1,text:'Y'},{id:'native',offset:2,text:'C'}]}]);
  expect(result.needsSync).toBe(false);expect(result.messages.map(item=>item.text)).toEqual(['unchanged','ABC','XY']);expect(result.messages[0]).toBe(old);
  const empty=applyConversationPatches([old],[{type:'patch',upserts:[],deltas:[{id:'old',offset:9,text:''}]}]);expect(empty.messages).toBeDefined();expect(empty.messages[0]).toBe(old);
 });
});
