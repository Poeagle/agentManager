import {describe,expect,it} from 'vitest';
import {ConversationProjection} from '../src/services/conversation-projection.js';
import type {AgentMessage} from '../src/services/agents/types.js';

const message=(id:string,text:string,extra:Partial<AgentMessage>={}):AgentMessage=>({
  id,role:'assistant',text,phase:'commentary',timestamp:null,turn_id:'turn-1',...extra,
});
const snapshot=(messages:AgentMessage[])=>({type:'snapshot' as const,messages,interactions:[],activities:[],compaction:null,busy:true,connected:true as const,turn_id:'turn-1',started_at:null,completed_at:null,stage:'answering' as const});

describe('ConversationProjection exact identity',()=>{
  it('replays durable sequence order after live items arrived out of order',()=>{
    const projection=new ConversationProjection();
    projection.accept(snapshot([message('answer','done',{phase:'final'}),message('progress','working')]));
    projection.accept({type:'history',runtime:{},messages:[message('progress','working',{sequence:10}),message('answer','done',{phase:'final',sequence:20})]});
    const replay=projection.accept(snapshot([]));
    expect(replay&&'messages' in replay?replay.messages.map(item=>item.id):[]).toEqual(['progress','answer']);
  });
  it('updates one native item across live and durable sources without changing its position',()=>{
    const projection=new ConversationProjection();
    projection.accept(snapshot([message('native-item','正在检查',{streaming:true})]));
    const durable=projection.accept({type:'history',runtime:{},messages:[message('native-item','已完成',{phase:'final',sequence:42})]});
    expect(durable).toMatchObject({type:'history',messages:[{id:'native-item',text:'已完成',phase:'final',streaming:false}]});
    expect(projection.accept({type:'history',runtime:{},messages:[message('native-item','已完成',{phase:'final',sequence:42})]})).toBeNull();
  });

  it('never merges distinct native items merely because their text matches',()=>{
    const projection=new ConversationProjection();
    projection.accept(snapshot([message('first','相同回答',{streaming:false})]));
    const durable=projection.accept({type:'history',runtime:{},messages:[message('second','相同回答',{phase:'final',sequence:42})]});
    expect(durable).toMatchObject({type:'history',messages:[{id:'second'}]});
    const full=projection.accept(snapshot([]));
    expect(full&&'messages' in full?full.messages.map(item=>item.id):[]).toEqual(['first','second']);
  });
});
