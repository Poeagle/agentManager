import Fastify, {type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createSession,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import * as manager from '../src/services/session-manager.js';
import * as state from '../src/services/session-state.js';
import {createTestDatabase} from './helpers/database.js';

describe('immediate session input',()=>{
  let app:FastifyInstance,cleanup:()=>void,cookie:string;
  let tracker:state.SessionStateTracker;
  beforeEach(async()=>{
    ({cleanup}=createTestDatabase());
    const owner=createUser({username:'owner',password:'password1'});
    const other=createUser({username:'other',password:'password1'});
    cookie=`agentmanager_session=${createSession(owner.id)}`;
    getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES ('p','Project','/tmp/input-test',?)").run(owner.id);
    setProjectToolAccess({projectId:'p',userId:owner.id,canSession:true,canTerminal:true,sessionClients:['codex'],grantedBy:owner.id});
    getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES ('own','p','Terminal','running','terminal','codex',?),('other','p','Work','running','session','codex',?)").run(owner.id,other.id);
    vi.spyOn(manager,'isSessionActive').mockReturnValue(true);
    vi.spyOn(manager,'writeToSession').mockReturnValue(true);
    tracker=new state.SessionStateTracker('own');
    vi.spyOn(state,'getTracker').mockReturnValue(tracker);
    app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});await app.ready();
  });
  afterEach(async()=>{tracker.destroy();await app.close();vi.restoreAllMocks();cleanup();});
  it('submits during an active execute without cancelling the wait or clearing output',async()=>{
    const execution=tracker.execute({input:'first task',timeout:60000,quiescenceMs:5000,stripAnsi:true});
    await execution.ready;
    tracker.onData('existing progress');
    const reset=vi.spyOn(tracker,'resetOutputBuffer');
    const cancel=vi.spyOn(tracker,'cancelExecute');
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'只查 v1.0.1\n保留当前任务'}});
    expect(result.statusCode).toBe(202);expect(result.json()).toEqual({id:'own',status:'submitted'});
    expect(vi.mocked(manager.writeToSession).mock.calls).toEqual([['own','只查 v1.0.1\n保留当前任务',true],['own','\r',false]]);
    expect(tracker.hasPendingExecute).toBe(true);expect(reset).not.toHaveBeenCalled();expect(cancel).not.toHaveBeenCalled();
    const rejected=expect(execution.result).rejects.toThrow('cancelled');tracker.cancelExecute();await rejected;
  });
  it('keeps concurrent paste/Enter pairs ordered without waiting for idle',async()=>{
    const results=await Promise.all(['first','second'].map(input=>app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input}})));
    expect(results.map(result=>result.statusCode)).toEqual([202,202]);
    expect(vi.mocked(manager.writeToSession).mock.calls).toEqual([['own','first',true],['own','\r',false],['own','second',true],['own','\r',false]]);
  });
  it('checks ownership and validates payload before writing',async()=>{
    expect((await app.inject({method:'POST',url:'/api/sessions/other/input',headers:{cookie},payload:{input:'private'}})).statusCode).toBe(404);
    for(const input of ['',42,'x'.repeat(65*1024)]) expect((await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input}})).statusCode).toBe(400);
    expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('does not acknowledge a failed write as submitted',async()=>{
    vi.mocked(manager.writeToSession).mockReturnValue(false);
    expect((await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'follow-up'}})).statusCode).toBe(503);
    expect(manager.writeToSession).toHaveBeenCalledTimes(1);
  });
});
