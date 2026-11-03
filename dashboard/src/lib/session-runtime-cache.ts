import type {QueryClient} from '@tanstack/react-query';
import type {Session} from './api';
export function cacheSessionRuntime(client:QueryClient,id:string,runtime:NonNullable<Session['agent_runtime']>){
  const update=(previous:{sessions:Session[]}|undefined)=>previous?{...previous,sessions:previous.sessions.map(session=>{
    if(session.id!==id||session.codex_session_id!==runtime.session_id||Date.parse(session.agent_runtime?.observed_at||'')>Date.parse(runtime.observed_at))return session;
    return {...session,agent_runtime:runtime,last_activity_at:runtime.last_activity_at};
  })}:previous;
  client.setQueriesData({queryKey:['sessions']},update);
  client.setQueriesData({queryKey:['project-sessions']},update);
}
