import {describe,expect,it} from 'vitest';
import {ConversationProjection} from '../src/services/conversation-projection.js';
import type {AgentMessage} from '../src/services/agents/types.js';

const message=(id:string,text:string,phase:'commentary'|'final'='commentary',extra:Partial<AgentMessage>={}):AgentMessage=>({
  id,role:'assistant',text,phase,timestamp:null,turn_id:'turn-1',...extra,
});

describe('ConversationProjection',()=>{
  it('coalesces native progress and durable final with different ids',()=>{
    const projection=new ConversationProjection();
    const live=projection.accept({type:'snapshot',messages:[message('live','正在检查代码')],interactions:[],activities:[],compaction:null,busy:true,connected:true,turn_id:'turn-1',started_at:null,completed_at:null,stage:'answering'});
    expect(live?.type).toBe('snapshot');
    const durable=projection.accept({type:'history',runtime:{},messages:[message('rollout','正在检查代码','final')]});
    expect(durable?.type).toBe('history');
    expect((durable as any).messages).toHaveLength(1);
    expect((durable as any).messages[0]).toMatchObject({id:'live',phase:'final'});
  });

  it('drops an identical rollout replay after the native snapshot',()=>{
    const projection=new ConversationProjection();
    projection.accept({type:'snapshot',messages:[message('live','结论','final')],interactions:[],activities:[],compaction:null,busy:false,connected:true,turn_id:'turn-1',started_at:null,completed_at:null,stage:'idle'});
    const replay=projection.accept({type:'history',runtime:{},messages:[message('rollout','结论','final')]});
    expect(replay?.type).toBe('history');
    expect((replay as any).messages).toEqual([]);
    expect(projection.accept({type:'history',runtime:{},messages:[message('rollout','结论','final')]})).toBeNull();
  });
});
