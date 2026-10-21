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
  it('reads public agent messages from an authorized terminal tab and checks access before reading history',async()=>{
    getDb().prepare("UPDATE sessions SET mode='terminal' WHERE id='own'").run();
    const owner=getDb().prepare("SELECT created_by_user_id AS id FROM sessions WHERE id='own'").get() as {id:string};
    setProjectToolAccess({projectId:'p',userId:owner.id,canSession:false,canTerminal:true,sessionClients:[],grantedBy:owner.id});
    const messages=[{role:'assistant' as const,phase:'commentary' as const,text:'正在检查现有配置',timestamp:null}];
    const load=vi.spyOn(context,'loadRecentAgentMessages').mockResolvedValue(messages);
    const result=await app.inject({url:'/api/sessions/own/agent-messages',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({messages,available:true,project_name:'Project'});
    expect((await app.inject({url:'/api/sessions/other/agent-messages',headers:{cookie}})).statusCode).toBe(404);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('renders an ended session snapshot for monitoring after replay has been archived',async()=>{
    getDb().prepare("UPDATE sessions SET status='completed',exit_code=0 WHERE id='own'").run();
    getDb().prepare("INSERT INTO session_snapshots(session_id,cols,rows,rendered) VALUES ('own',120,40,?)").run('zsh:1: command not found: codex\u001b[1B');
    const result=await app.inject({url:'/api/sessions/own/display?since=99',headers:{cookie}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({outputSource:'snapshot',output:expect.stringContaining('command not found: codex')});
    expect((await app.inject({url:'/api/sessions/other/display',headers:{cookie}})).statusCode).toBe(404);
  });
  it('keeps the incremental cursor on empty polls and returns actual rendered text',async()=>{
    getDb().prepare("INSERT INTO pty_output(session_id,seq,data) VALUES ('own',42,?)").run('\u001b[31m旧内容\u001b[0m\r\u001b[2K最终结果');
    const full=await app.inject({url:'/api/sessions/own/display',headers:{cookie}});
    expect(full.json()).toMatchObject({cursor:42,cursorReset:false,output:'最终结果'});
    expect(full.json().output).not.toContain('\u001b');
    for (let attempt=0;attempt<3;attempt++) {
      const empty=await app.inject({url:'/api/sessions/own/display?since=42',headers:{cookie}});
      expect(empty.json()).toMatchObject({cursor:42,cursorReset:false,output:''});
    }
    const reset=await app.inject({url:'/api/sessions/own/display?since=100',headers:{cookie}});
    expect(reset.json()).toMatchObject({cursor:42,cursorReset:true});
  });
  it('reads terminal tab text with the dashboard label without registering a tracked task',async()=>{
    const session=getDb().prepare("SELECT created_by_user_id AS user_id FROM sessions WHERE id='own'").get() as {user_id:string};
    setProjectToolAccess({projectId:'p',userId:session.user_id,canSession:false,canTerminal:true,sessionClients:[],grantedBy:session.user_id});
    getDb().prepare("UPDATE sessions SET mode='terminal',task='Terminal' WHERE id='own'").run();
    getDb().prepare("INSERT INTO user_ui_state(user_id,key,value) VALUES (?,'project:p',?)").run(session.user_id,JSON.stringify({terminalInstances:[{id:'own',label:'Terminal 1',customLabel:'设计'}]}));
    getDb().prepare("INSERT INTO pty_output(session_id,seq,data) VALUES ('own',1,?)").run('正在补充测试用例\r\n尚未运行测试');
    const result=await app.inject({url:'/api/sessions/own/display?lines=200',headers:{cookie}});
    expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({display_name:'设计',project_name:'Project',output:'正在补充测试用例\n尚未运行测试'});
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_tasks').get()).toEqual({n:0});
  });
});
