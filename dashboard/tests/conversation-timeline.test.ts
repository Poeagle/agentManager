import {describe,expect,it} from 'vitest';
import {mergeConversationTimeline,type TimelineMessage} from '../src/lib/conversation-timeline';
const message=(id:string,role:'user'|'assistant',extra:Partial<TimelineMessage>={}):TimelineMessage=>({id,role,text:id,timestamp:null,...extra});
const ids=(items:TimelineMessage[])=>items.map(item=>item.id);
describe('causal conversation timeline',()=>{
  it('reconciles pasted Windows line endings with a terminal echo and preserves intentional repeats',()=>{
    const pending=message('pending','user',{text:'ifconfig\r\n  inet 192.168.1.31\r\n',client_id:'first',optimistic:{afterSequence:10}});
    const echo=message('native','user',{text:'ifconfig\n  inet 192.168.1.31',sequence:20});
    expect(mergeConversationTimeline([pending],[echo])).toHaveLength(1);
    expect(mergeConversationTimeline([pending],[echo])[0]).toMatchObject({id:'native',client_id:'first',optimistic:undefined});
    const second=message('repeat','user',{text:echo.text,client_id:'second',sequence:30});
    expect(mergeConversationTimeline(mergeConversationTimeline([pending],[echo]),[second])).toHaveLength(2);
  });
  it('settles an existing duplicate when the terminal correlation becomes available later',()=>{
    const pending=message('pending','user',{text:'same',client_id:'c',queued:true,optimistic:{afterSequence:999}});
    const native=message('native','user',{text:'same',sequence:10});
    const result=mergeConversationTimeline([pending,native],[{...native,client_id:'c'}]);
    expect(result).toHaveLength(1);expect(result[0]).toMatchObject({id:'native',client_id:'c',sequence:10,queued:false,optimistic:undefined});
    expect(mergeConversationTimeline(result,[{...native,id:'other-log-id',client_id:'c'}])).toHaveLength(1);
  });
  it('reconciles resumed assistant item IDs and trailing newlines without merging repeated items or phases',()=>{
    const live=[message('live-one','assistant',{text:'正在检查。\n',turn_id:'turn',phase:'commentary',streaming:true}),message('live-two','assistant',{text:'正在检查。\n',turn_id:'turn',phase:'commentary',streaming:true}),message('live-final','assistant',{text:'正在检查。',turn_id:'turn',phase:'final',streaming:true})];
    const history=[message('saved-one','assistant',{text:'正在检查。',turn_id:'turn',phase:'commentary',sequence:100}),message('saved-two','assistant',{text:'正在检查。',turn_id:'turn',phase:'commentary',sequence:200}),message('saved-final','assistant',{text:'正在检查。',turn_id:'turn',phase:'final',sequence:300})];
    const merged=mergeConversationTimeline(live,history);expect(ids(merged)).toEqual(ids(history));expect(merged.every(item=>!item.streaming)).toBe(true);
    expect(ids(mergeConversationTimeline(merged,live))).toEqual(ids(history));expect(mergeConversationTimeline(merged,live).every(item=>!item.streaming)).toBe(true);
    expect(ids(mergeConversationTimeline(history,live))).toEqual(ids(history));
    expect(mergeConversationTimeline(history,[message('other','assistant',{text:'正在检查。',turn_id:'other',phase:'commentary',streaming:true})])).toHaveLength(4);
  });
  it('ignores clock skew and completion timestamp changes while preserving a streaming bubble',()=>{
    const old=[message('q1','user',{timestamp:'2030-01-01'}),message('a1','assistant',{timestamp:'2030-01-02'}),message('q2','user',{timestamp:'2020-01-01'}),message('a2','assistant',{timestamp:'2020-01-02',streaming:true})];
    const merged=mergeConversationTimeline(old,[message('a2','assistant',{timestamp:'2019-01-01',sequence:400})]);
    expect(ids(merged)).toEqual(['q1','a1','q2','a2']);expect(merged.at(-1)?.streaming).toBe(false);
    const settled=mergeConversationTimeline(old,[message('a2','assistant',{timestamp:'2019-01-01',sequence:400,streaming:false})]);
    expect(ids(settled)).toEqual(['q1','a1','q2','a2']);
    expect(mergeConversationTimeline(settled,[message('a2','assistant',{streaming:true})]).at(-1)?.streaming).toBe(false);
  });
  it('matches identical pending prompts one for one by client identity, even when echo precedes HTTP acknowledgement',()=>{
    const old=[message('q0','user',{text:'继续',sequence:0}),message('a0','assistant',{sequence:100}),message('p1','user',{text:'继续',client_id:'one',optimistic:{afterSequence:100}}),message('p2','user',{text:'继续',client_id:'two',optimistic:{afterSequence:100}})];
    const merged=mergeConversationTimeline(old,[message('q1','user',{text:'继续',client_id:'one'}),message('a1','assistant',{streaming:true})]);
    expect(ids(merged)).toEqual(['q0','a0','q1','p2','a1']);expect(merged.filter(item=>item.optimistic)).toHaveLength(1);
    const echo=mergeConversationTimeline(merged,[message('q1','user',{text:'继续',sequence:200}),message('q2','user',{text:'继续',sequence:300})]);
    expect(ids(echo)).toEqual(['q0','a0','q1','q2','a1']);expect(echo.some(item=>item.optimistic)).toBe(false);
  });
  it('aliases different native user IDs from stream and history without duplicating repeated prompts',()=>{
    const live=[message('stream1','user',{text:'继续',turn_id:'same',client_id:'one'}),message('answer1','assistant'),message('stream2','user',{text:'继续',turn_id:'same',client_id:'two'})];
    const history=[message('log1','user',{text:'继续',turn_id:'same',sequence:100}),message('answer1','assistant',{sequence:200}),message('log2','user',{text:'继续',turn_id:'same',sequence:300})];
    const merged=mergeConversationTimeline(live,history);expect(ids(merged)).toEqual(['log1','answer1','log2']);
    expect(ids(mergeConversationTimeline(merged,live))).toEqual(['log1','answer1','log2']);
    const historyFirst=mergeConversationTimeline(history,live);expect(ids(historyFirst)).toEqual(['log1','answer1','log2']);
    expect(historyFirst[0].client_id).toBe('one');expect(historyFirst[2].client_id).toBe('two');
  });
  it('never consumes a new identical prompt with an old historical echo',()=>{
    const old=[message('q0','user',{text:'继续',sequence:10}),message('p','user',{text:'继续',optimistic:{afterSequence:20}})];
    const merged=mergeConversationTimeline(old,[message('old','user',{text:'继续',sequence:0}),message('q0','user',{text:'继续',sequence:10})],'prepend');
    expect(ids(merged)).toEqual(['old','q0','p']);expect(merged.at(-1)?.optimistic).toBeDefined();
  });
  it('fills gaps in native order and prepends older history without moving current messages ahead of it',()=>{
    const old=[message('q2','user',{sequence:200}),message('a2','assistant',{streaming:true}),message('q3','user',{sequence:400})];
    const merged=mergeConversationTimeline(old,[message('a1','assistant',{sequence:100}),message('q2','user',{sequence:200}),message('a2','assistant',{sequence:300,streaming:false})]);
    expect(ids(merged)).toEqual(['a1','q2','a2','q3']);
    expect(ids(mergeConversationTimeline(merged,[message('q0','user'),message('a0','assistant')],'prepend'))).toEqual(['q0','a0','a1','q2','a2','q3']);
  });
  it('places a late-discovered user before the answer already delivered by the event channel',()=>{
    expect(ids(mergeConversationTimeline([message('a1','assistant')],[message('q1','user'),message('a1','assistant')]))).toEqual(['q1','a1']);
  });
});


it('reconciles a restored native queued message with its eventual user echo exactly once',()=>{
 const queued={id:'queued-c',role:'user' as const,text:'压缩后处理',timestamp:null,client_id:'c',queued:true};
 const result=mergeConversationTimeline([queued],[{id:'native',role:'user',text:queued.text,timestamp:null,client_id:'c',turn_id:'new-turn'}]);expect(result).toHaveLength(1);expect(result[0].queued).toBe(false);expect(result[0].id).toBe('native');
});

it('keeps waiting messages after the active answer and ignores a delayed queue snapshot once a message has started',()=>{
 const queue=(id:string)=>({id:`q-${id}`,role:'user' as const,text:id,timestamp:null,client_id:id,queued:true});
 let result=mergeConversationTimeline([queue('one'),queue('two')],[{id:'one',role:'user',text:'one',timestamp:null,client_id:'one',turn_id:'t1'},{id:'answer',role:'assistant',text:'answer one',timestamp:null,turn_id:'t1'}]);expect(result.map(item=>item.text)).toEqual(['one','answer one','two']);result=mergeConversationTimeline(result,[queue('one'),queue('two')]);expect(result.map(item=>item.text)).toEqual(['one','answer one','two']);
});
