import {describe,expect,it} from 'vitest';
import {mergeConversationTimeline,type TimelineMessage} from '../src/lib/conversation-timeline';

const message=(id:string,role:'user'|'assistant',extra:Partial<TimelineMessage>={}):TimelineMessage=>({id,role,text:id,timestamp:null,...extra});
const ids=(items:TimelineMessage[])=>items.map(item=>item.id);

describe('deterministic conversation timeline',()=>{
  it('repairs live arrival order when durable sequences arrive, including replay and duplicates',()=>{
    const progress=message('progress','assistant',{phase:'commentary',streaming:false});
    const answer=message('answer','assistant',{phase:'final',streaming:false});
    const live=mergeConversationTimeline([], [answer,progress]);
    const history=[{...progress,sequence:10},{...answer,sequence:20}];
    const repaired=mergeConversationTimeline(live,history);
    expect(ids(repaired)).toEqual(['progress','answer']);
    expect(ids(mergeConversationTimeline(repaired,history))).toEqual(['progress','answer']);
    expect(ids(mergeConversationTimeline([],history))).toEqual(['progress','answer']);
  });
  it('keeps unsequenced and queued messages anchored while ordering durable items',()=>{
    const local=message('local','user',{optimistic:{afterSequence:10}});
    const queued=message('queued','user',{queued:true});
    const previous=[message('answer','assistant',{sequence:30}),local,message('progress','assistant',{sequence:10}),queued];
    expect(ids(mergeConversationTimeline(previous,[]))).toEqual(['progress','local','answer','queued']);
  });
  it('updates exact native identities and preserves intentional identical messages',()=>{
    const first=message('one','assistant',{text:'相同',streaming:true});
    const settled=mergeConversationTimeline([first],[message('one','assistant',{text:'相同',sequence:20})]);
    expect(settled).toHaveLength(1);expect(settled[0].streaming).toBe(false);
    expect(mergeConversationTimeline(settled,[message('two','assistant',{text:'相同',sequence:30})])).toHaveLength(2);
  });

  it('never regresses an assistant message when a stale history frame is shorter',()=>{
    const live=message('native','assistant',{text:'已经输出到这里',streaming:true});
    const stale=message('native','assistant',{text:'已经输出',phase:'final',sequence:20});
    const result=mergeConversationTimeline([live],[stale]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('已经输出到这里');
  });

  it('settles one optimistic send only through its client identity',()=>{
    const pending=message('pending','user',{text:'继续',client_id:'client-one',optimistic:{afterSequence:10}});
    const native=message('native','user',{text:'继续',client_id:'client-one',sequence:20});
    const settled=mergeConversationTimeline([pending],[native]);
    expect(settled).toHaveLength(1);expect(settled[0]).toMatchObject({id:'native',client_id:'client-one',queued:false,optimistic:undefined});
    expect(mergeConversationTimeline(settled,[message('repeat','user',{text:'继续',client_id:'client-two',sequence:30})])).toHaveLength(2);
  });

  it('uses native sequence for durable gaps without consulting timestamps',()=>{
    const old=[message('q2','user',{sequence:200,timestamp:'2030-01-01'}),message('q3','user',{sequence:400,timestamp:'2020-01-01'})];
    const result=mergeConversationTimeline(old,[message('a1','assistant',{sequence:100}),message('a2','assistant',{sequence:300})]);
    expect(ids(result)).toEqual(['a1','q2','a2','q3']);
  });

  it('uses one native batch to fill a missing item before an already known item',()=>{
    const answer=message('answer','assistant',{streaming:true});
    expect(ids(mergeConversationTimeline([answer],[message('question','user'),answer]))).toEqual(['question','answer']);
  });

  it('prepends older unsequenced history and keeps queued input last',()=>{
    const queued=message('queued','user',{queued:true,client_id:'queued'});
    const current=message('current','assistant');
    const result=mergeConversationTimeline([current,queued],[message('old-user','user'),message('old-answer','assistant')],'prepend');
    expect(ids(result)).toEqual(['old-user','old-answer','current','queued']);
  });

  it('does not infer identity from text, phase, turn or newline normalization',()=>{
    const live=message('live','assistant',{text:'回答\n',phase:'commentary',turn_id:'live-turn'});
    const durable=message('durable','assistant',{text:'回答',phase:'final',turn_id:'durable-turn',sequence:20});
    expect(ids(mergeConversationTimeline([live],[durable]))).toEqual(['live','durable']);
  });

  it('removes a stale optimistic copy when client correlation arrives after the native item',()=>{
    const pending=message('pending','user',{client_id:'client',optimistic:{afterSequence:10}});
    const native=message('native','user',{sequence:20});
    const result=mergeConversationTimeline([pending,native],[{...native,client_id:'client'}]);
    expect(ids(result)).toEqual(['native']);expect(result[0].client_id).toBe('client');
  });
  it('reconciles a proven terminal alias, including late native snapshots, without hiding later repeats',()=>{
    const pending=message('pending','user',{text:'same',client_id:'browser',optimistic:{afterSequence:10}}),live=message('live','user',{text:'same',client_id:'terminal'});
    const durable=message('durable','user',{text:'same',client_id:'browser',native_client_id:'terminal',sequence:20});
    const result=mergeConversationTimeline([pending,live],[durable]);expect(ids(result)).toEqual(['durable']);
    expect(ids(mergeConversationTimeline(result,[live]))).toEqual(['durable']);
    expect(ids(mergeConversationTimeline(result,[message('intentional','user',{text:'same',client_id:'another',sequence:30})]))).toEqual(['durable','intentional']);
  });
});
