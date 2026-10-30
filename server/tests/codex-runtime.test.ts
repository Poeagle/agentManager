import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync,utimesSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {readCodexRuntime} from '../src/services/codex-runtime.js';
import Fastify from 'fastify';
import {authHook,createSession,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {sessionRoutes} from '../src/routes/sessions.js';
import {createTestDatabase} from './helpers/database.js';
import * as manager from '../src/services/session-manager.js';

const id='019ff001-1111-7111-8111-111111111111';
let dir:string; let file:string;
function event(type:string,second:number,extra:Record<string,unknown>={}) {
  return JSON.stringify({timestamp:`2026-10-29T10:00:${String(second).padStart(2,'0')}.000Z`,type:'event_msg',payload:{type,...extra}})+'\n';
}
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),'codex-native-'));vi.stubEnv('CODEX_HOME',dir);mkdirSync(join(dir,'sessions'));
  file=join(dir,'sessions',`rollout-test-${id}.jsonl`);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});

describe('Codex native execution status',()=>{
  it('reports a failed turn instead of idle when completion carries a model error',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'failed'})+event('task_complete',2,{turn_id:'failed',error:{message:'Selected model is at capacity.',codex_error_info:'server_overloaded'}}));
    expect(await readCodexRuntime(id)).toMatchObject({state:'failed',last_activity_at:'2026-10-29T10:00:02.000Z'});
    appendFileSync(file,event('task_started',3,{turn_id:'retry'}));expect((await readCodexRuntime(id)).state).toBe('running');
  });
  it('preserves running status through quiet periods and ignores bookkeeping/mtime/PTY clocks',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'a'})+event('agent_reasoning',2));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
    appendFileSync(file,event('token_count',20)+JSON.stringify({timestamp:'2026-10-29T11:00:00Z',type:'session_meta',payload:{id}})+'\n');
    utimesSync(file,new Date(),new Date());
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:02.000Z'});
  });
  it('uses exact native tool events, handles partial JSON, and waits for actual task completion',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'a'}));
    const call=JSON.stringify({timestamp:'2026-10-29T10:00:03Z',type:'response_item',payload:{type:'function_call',name:'request_user_input',call_id:'question',arguments:'private'}})+'\n';
    appendFileSync(file,call.slice(0,60)); expect((await readCodexRuntime(id)).state).toBe('running');
    appendFileSync(file,call.slice(60)); expect((await readCodexRuntime(id)).state).toBe('waiting_for_input');
    appendFileSync(file,JSON.stringify({timestamp:'2026-10-29T10:00:04Z',type:'response_item',payload:{type:'function_call_output',call_id:'question',output:'private'}})+'\n');
    expect((await readCodexRuntime(id)).state).toBe('running');
    appendFileSync(file,event('task_complete',5,{turn_id:'a'}));
    const runtime=await readCodexRuntime(id);expect(runtime).toMatchObject({state:'idle',last_activity_at:'2026-10-29T10:00:05.000Z'});
    expect(JSON.stringify(runtime)).not.toContain('private');
  });
  it('does not let another turn completion or another thread override the active turn',async()=>{
    writeFileSync(file,event('task_started',1,{turn_id:'old'})+event('task_started',2,{turn_id:'new'})+event('turn_aborted',3,{turn_id:'old'})+event('task_complete',4,{turn_id:'elsewhere',thread_id:'other'}));
    expect(await readCodexRuntime(id)).toMatchObject({state:'running',last_activity_at:'2026-10-29T10:00:03.000Z'});
    appendFileSync(file,event('turn_aborted',5,{turn_id:'new'}));expect((await readCodexRuntime(id)).state).toBe('interrupted');
  });
  it('recovers after file replacement and never substitutes a different conversation for missing logs',async()=>{
    writeFileSync(file,event('task_complete',1));expect((await readCodexRuntime(id)).state).toBe('idle');
    writeFileSync(file,event('task_started',2));expect((await readCodexRuntime(id)).state).toBe('running');
    expect(await readCodexRuntime('019ff001-2222-7222-8222-222222222222')).toMatchObject({state:'unknown',last_activity_at:null});
    expect(await readCodexRuntime(null)).toMatchObject({state:'unknown',last_activity_at:null});
  });
  it('returns only authorized native timestamps in the session list despite newer terminal output',async()=>{
    const database=createTestDatabase(); const app=Fastify();
    try {
      const user=createUser({username:'native-owner',password:'password1',role:'admin'});
      const cookie=`agentmanager_session=${createSession(user.id)}`;
      getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('native-p','Native',?,?)").run(dir,user.id);
      getDb().prepare("INSERT INTO sessions(id,project_id,task,status,cli_type,codex_session_id,created_by_user_id) VALUES ('native-s','native-p','Task','running','codex',?,?)").run(id,user.id);
      getDb().prepare("INSERT INTO pty_output(session_id,seq,data,created_at) VALUES ('native-s',1,'screen repaint','2099-01-01 00:00:00')").run();
      writeFileSync(file,event('task_started',1));vi.spyOn(manager,'getLiveWorkAgent').mockResolvedValue('codex');
      app.addHook('onRequest',authHook); await app.register(sessionRoutes,{prefix:'/api'});
      const first=await app.inject({url:'/api/sessions',headers:{cookie}});
      expect(first.json().sessions[0]).toMatchObject({last_activity_at:'2026-10-29T10:00:01.000Z',agent_runtime:{source:'codex_rollout',state:'running'}});
      const second=await app.inject({url:'/api/sessions',headers:{cookie}});
      expect(second.json().sessions[0].last_activity_at).toBe(first.json().sessions[0].last_activity_at);
      vi.mocked(manager.getLiveWorkAgent).mockResolvedValue(null);
      expect((await app.inject({url:'/api/sessions',headers:{cookie}})).json().sessions[0].agent_runtime.state).toBe('unknown');
      const other=createUser({username:'native-other',password:'password1'});
      expect((await app.inject({url:'/api/sessions',headers:{cookie:`agentmanager_session=${createSession(other.id)}`}})).json().sessions).toEqual([]);
    } finally {await app.close();database.cleanup();}
  });
});
