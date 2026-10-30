import {describe,expect,it} from 'vitest';
import {conversationTimings,elapsedBetween,formatElapsed} from '../src/lib/conversation-timing';
import type {ConversationMessage} from '../src/lib/api';
describe('conversation elapsed time',()=>{
  it('never counts the screenshot outage and the next human question as a progress duration',()=>{
    const messages:ConversationMessage[]=[{id:'last-progress',role:'assistant',phase:'commentary',turn_id:'old',timestamp:'2026-10-30T04:18:18.028Z',text:'图片验证完成'},
      {id:'next-question',role:'user',turn_id:'new',timestamp:'2026-10-30T05:55:23.219Z',text:'服务器连不上了'},
      {id:'new-progress',role:'assistant',phase:'commentary',turn_id:'new',timestamp:'2026-10-30T05:55:42.367Z',text:'开始排查'}];
    const times=conversationTimings(messages,Date.parse('2026-10-30T05:55:50Z'),true,'new');
    expect(times.has('last-progress')).toBe(false);expect(times.get('new-progress')?.label).toBe('距上次更新 7秒');
  });
  it('does not cross known turn boundaries, errors or time an old historical tail as current work',()=>{
    const first:ConversationMessage={id:'old',role:'assistant',phase:'commentary',turn_id:'old',timestamp:'2026-10-30T04:18:18Z',text:'旧进展'};
    const next:ConversationMessage={id:'new',role:'assistant',phase:'commentary',turn_id:'new',timestamp:'2026-10-30T05:55:23Z',text:'新进展'};
    expect(conversationTimings([first,next],Date.now(),false).has('old')).toBe(false);
    expect(conversationTimings([first],Date.now(),true,'new').has('old')).toBe(false);
    expect(conversationTimings([first,{...next,phase:'error',turn_id:'old'}],Date.now(),false).size).toBe(0);
  });
  it('shows historical step intervals and total reply time without depending on reconnect time',()=>{
    const message=(id:string,role:'user'|'assistant',phase:'commentary'|'final'|undefined,timestamp:string|null):ConversationMessage=>({id,role,phase,timestamp,text:id});
    const messages=[message('u','user',undefined,'2026-10-30T07:40:00Z'),message('a','assistant','commentary','2026-10-30T07:40:26Z'),message('b','assistant','commentary','2026-10-30T07:42:12Z'),message('f','assistant','final','2026-10-30T07:43:00Z')];
    const timing=conversationTimings(messages,Date.parse('2027-01-01'),false);
    expect(timing.get('a')?.label).toBe('消息间隔 1分46秒');expect(timing.get('b')?.label).toBe('消息间隔 48秒');
    expect(timing.get('f')?.label).toBe('本轮耗时 3分0秒');
    expect(conversationTimings(messages.slice(0,3),Date.parse('2026-10-30T07:43:12Z'),true).get('b')?.label).toBe('距上次更新 1分0秒');
    expect(conversationTimings(messages.slice(0,3),Date.now(),false).has('b')).toBe(false);
  });
  it('does not invent elapsed time for missing or inconsistent timestamps',()=>{
    expect(elapsedBetween(null,Date.now())).toBeNull();expect(elapsedBetween('invalid',Date.now())).toBeNull();
    expect(elapsedBetween('2026-10-30','2026-10-29')).toBeNull();expect(formatElapsed(3661000)).toBe('1时1分1秒');
  });
});
