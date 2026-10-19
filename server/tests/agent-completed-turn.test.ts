import Fastify, {type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createSession,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import * as context from '../src/services/prompt-context.js';
import {createTestDatabase} from './helpers/database.js';

describe('native completed-turn observation API',()=>{
  let app: FastifyInstance;
  let cleanup: ()=>void;
  let cookie: string;
  beforeEach(async()=>{
    ({cleanup}=createTestDatabase());
    const owner=createUser({username:'owner',password:'password1'});
    const other=createUser({username:'other',password:'password1'});
    cookie=`agentmanager_session=${createSession(owner.id)}`;
    getDb().prepare("INSERT INTO projects (id,name,path,owner_id) VALUES ('p','Project','/tmp/completed-turn',?)").run(owner.id);
    setProjectToolAccess({projectId:'p',userId:owner.id,canSession:true,canTerminal:false,sessionClients:['codex'],grantedBy:owner.id});
    getDb().prepare("INSERT INTO sessions (id,project_id,task,mode,cli_type,created_by_user_id) VALUES ('own','p','Task','session','codex',?),('other','p','Other task','session','codex',?)").run(owner.id,other.id);
    app=Fastify();await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});await app.ready();
  });
  afterEach(async()=>{await app.close();vi.restoreAllMocks();cleanup();});
  it('returns only the authorized session native user/final pair without requiring a live process',async()=>{
    const load=vi.spyOn(context,'loadRecentPromptContext').mockResolvedValue([{user:'Do work [Platform task reference: one]',assistant:'Done; tests passed.'}]);
    const result=await app.inject({url:'/api/sessions/own/completed-turn',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.json().turns).toHaveLength(1);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({cli_type:'codex',project_path:'/tmp/completed-turn'}),1);
    const forbidden=await app.inject({url:'/api/sessions/other/completed-turn',headers:{cookie}});
    expect(forbidden.statusCode).toBe(404);expect(load).toHaveBeenCalledTimes(1);
  });
  it('returns no completed turn when native history is unavailable',async()=>{
    const result=await app.inject({url:'/api/sessions/own/completed-turn',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual({turns:[]});
  });
  it('renders an ended session snapshot for monitoring after replay has been archived',async()=>{
    getDb().prepare("UPDATE sessions SET status='completed',exit_code=0 WHERE id='own'").run();
    getDb().prepare("INSERT INTO session_snapshots(session_id,cols,rows,rendered) VALUES ('own',120,40,?)").run('zsh:1: command not found: codex\u001b[1B');
    const result=await app.inject({url:'/api/sessions/own/display?since=99',headers:{cookie}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({outputSource:'snapshot',output:expect.stringContaining('command not found: codex')});
    expect((await app.inject({url:'/api/sessions/other/display',headers:{cookie}})).statusCode).toBe(404);
  });
});
