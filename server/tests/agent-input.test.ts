import Fastify, {type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createSession,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import * as manager from '../src/services/session-manager.js';
import * as state from '../src/services/session-state.js';
import * as conversation from '../src/services/conversation-stream.js';
import {createTestDatabase} from './helpers/database.js';
import {mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';

describe('immediate session input',()=>{
  let app:FastifyInstance,cleanup:()=>void,cookie:string,fixtureDir:string;
  let tracker:state.SessionStateTracker;
  beforeEach(async()=>{
    ({cleanup,dir:fixtureDir}=createTestDatabase());
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
  afterEach(async()=>{tracker.destroy();await app.close();vi.restoreAllMocks();vi.unstubAllEnvs();cleanup();});
  it('routes chat followups directly to the existing native engine instead of a terminal menu',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'能否再详细一下',source:'conversation'}});
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','能否再详细一下');expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('forwards and validates the correlation ID before submitting native chat input',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const post=(client_id:unknown)=>app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'继续',source:'conversation',client_id}});
    expect((await post('client-one')).statusCode).toBe(202);
    expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','继续','client-one');
    for(const value of ['',42,'x'.repeat(101)])expect((await post(value)).statusCode).toBe(400);
    expect(submit).toHaveBeenCalledTimes(1);expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('validates attachments before forwarding an attachment-only native message',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    const dir=join(fixtureDir,'input-project');const pastes=join(dir,'.agentmanager','pastes');mkdirSync(pastes,{recursive:true});
    const path=join(pastes,'note.txt');writeFileSync(path,'attached text');
    getDb().prepare("UPDATE projects SET path=? WHERE id='p'").run(dir);
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const attachments=[{kind:'file',name:'note.txt',path}];
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'',source:'conversation',client_id:'file-only',attachments}});
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','', 'file-only',attachments);
    const rejected=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'read',source:'conversation',attachments:[{kind:'file',name:'private',path:'/etc/passwd'}]}});
    expect(rejected.statusCode).toBe(400);expect(submit).toHaveBeenCalledTimes(1);expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous native send by also pasting the message into the terminal',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    vi.spyOn(conversation,'submitStreamingCodexInput').mockRejectedValue(new Error('connection closed'));
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'followup',source:'conversation'}});
    expect(result.statusCode).toBe(503);expect(manager.writeToSession).not.toHaveBeenCalled();
  });
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
