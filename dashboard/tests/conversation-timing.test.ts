import {describe,expect,it} from 'vitest';
import {conversationTimings,elapsedBetween,formatElapsed} from '../src/lib/conversation-timing';
import type {ConversationMessage} from '../src/lib/api';
describe('conversation elapsed time',()=>{
  it('shows historical step intervals and total reply time without depending on reconnect time',()=>{
    const message=(id:string,role:'user'|'assistant',phase:'commentary'|'final'|undefined,timestamp:string|null):ConversationMessage=>({id,role,phase,timestamp,text:id});
    const messages=[message('u','user',undefined,'2026-10-30T07:40:00Z'),message('a','assistant','commentary','2026-10-30T07:40:26Z'),message('b','assistant','commentary','2026-10-30T07:42:12Z'),message('f','assistant','final','2026-10-30T07:43:00Z')];
    const timing=conversationTimings(messages,Date.parse('2027-01-01'),false);
    expect(timing.get('a')?.label).toBe('阶段间隔 1分46秒');expect(timing.get('b')?.label).toBe('阶段间隔 48秒');
    expect(timing.get('f')?.label).toBe('本轮耗时 3分0秒');
    expect(conversationTimings(messages.slice(0,3),Date.parse('2026-10-30T07:43:12Z'),true).get('b')?.label).toBe('已持续 1分0秒');
    expect(conversationTimings(messages.slice(0,3),Date.now(),false).has('b')).toBe(false);
  });
  it('does not invent elapsed time for missing or inconsistent timestamps',()=>{
    expect(elapsedBetween(null,Date.now())).toBeNull();expect(elapsedBetween('invalid',Date.now())).toBeNull();
    expect(elapsedBetween('2026-10-30','2026-10-29')).toBeNull();expect(formatElapsed(3661000)).toBe('1时1分1秒');
  });
});
