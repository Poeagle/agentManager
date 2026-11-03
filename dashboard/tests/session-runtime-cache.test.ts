import {describe,expect,it} from 'vitest';
import {QueryClient} from '@tanstack/react-query';
import {cacheSessionRuntime,mergeSessionRuntimeLists} from '../src/lib/session-runtime-cache';
import type {Session} from '../src/lib/api';
const runtime=(second:number,state='running')=>({source:'codex_rollout',session_id:'native',state,observed_at:`2026-11-03T00:00:0${second}Z`,last_activity_at:null,reason:'native'}) as NonNullable<Session['agent_runtime']>;
const session={id:'s',codex_session_id:'native',agent_runtime:runtime(1)} as Session;
describe('real-time session runtime cache',()=>{
 it('updates both project and session tabs and rejects older or rebound events',()=>{
  const client=new QueryClient();const data={sessions:[session]};client.setQueryData(['sessions'],data);client.setQueryData(['project-sessions','p'],data);
  cacheSessionRuntime(client,'s',runtime(3,'idle'));cacheSessionRuntime(client,'s',runtime(2));cacheSessionRuntime(client,'s',{...runtime(4),session_id:'other'});
  for(const key of [['sessions'],['project-sessions','p']])expect(client.getQueryData<{sessions:Session[]}>(key)?.sessions[0].agent_runtime).toEqual(runtime(3,'idle'));
 });
 it('keeps a newer pushed status when an older list fetch finishes, while accepting other list changes',()=>{
  const previous={sessions:[{...session,agent_runtime:runtime(3,'idle')}]};const incoming={sessions:[{...session,task:'Updated title',agent_runtime:runtime(2)}]};
  expect(mergeSessionRuntimeLists(previous,incoming)).toMatchObject({sessions:[{task:'Updated title',agent_runtime:runtime(3,'idle')}]});
  expect(mergeSessionRuntimeLists(previous,{sessions:[{...session,codex_session_id:'new',agent_runtime:{...runtime(1),session_id:'new'}}]})).toMatchObject({sessions:[{codex_session_id:'new',agent_runtime:{session_id:'new'}}]});
 });
});
