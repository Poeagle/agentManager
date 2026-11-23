import {decorateBatches} from '../src/services/conversation-batches.js';
import Fastify, {type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createSession,createUser,setProjectToolAccess} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {setRoleGrants,setUserRoles} from '../src/services/rbac.js';
import * as manager from '../src/services/session-manager.js';
import * as state from '../src/services/session-state.js';
import * as conversation from '../src/services/agents/codex/stream.js';
import * as fileStream from '../src/services/conversation-file-stream.js';
import {setIgnoredQuestions} from '../src/services/question-attention.js';
import {createTestDatabase} from './helpers/database.js';
import {mkdirSync,realpathSync,writeFileSync} from 'fs';
import {join} from 'path';
import {createHash} from 'crypto';
import {createServer} from 'http';
import {WebSocketServer} from 'ws';
import * as environments from '../src/services/agents/codex/environments.js';
import * as inputLinks from '../src/services/conversation-input-links.js';
import {SEND_GUARD_KEY} from '../src/services/send-guard-policy.js';
import {notificationSession,putNotification,listNotifications} from '../src/services/notifications.js';

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
  it.each(['accepted','queued','rejected','unknown'] as const)('settles existing notifications only when input is %s and preserves a new result arriving during submission',async outcome=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const session=notificationSession('own')!,owner=session.created_by_user_id!;
    putNotification(session,{kind:'result',state:'info',source_id:'previous',title:'完成',body:'旧结果'});
    vi.spyOn(conversation,'submitStreamingCodexInput').mockImplementation(async()=>{
      putNotification(session,{kind:'result',state:'info',source_id:'newer',title:'新完成',body:'新结果'});
      if(outcome==='rejected'||outcome==='unknown')throw Object.assign(new Error('未确认'),{submission:outcome});
      return outcome==='queued'?'queued':true;
    });
    const response=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'继续处理',source:'conversation'}});
    expect(response.statusCode).toBe(outcome==='rejected'?409:outcome==='unknown'?503:202);
    expect(listNotifications(owner).notifications.map(row=>row.source_id)).toEqual(outcome==='accepted'||outcome==='queued'?['newer']:['newer','previous']);
  });
  it('pushes a journal-verified terminal echo as an input reconciliation',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    getDb().prepare('INSERT INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset) VALUES(?,?,?,?,?)').run('own','native','browser',createHash('sha256').update('hello').digest('hex'),10);
    getDb().prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label) VALUES(?,?,?,?)').run('own','browser','scheduled','巡检');
    let fileEmit!:(frame:any)=>void;vi.spyOn(fileStream,'observeConversationFile').mockImplementation((_binding,emit)=>{fileEmit=emit;return vi.fn();});
    vi.spyOn(conversation,'observeCodexConversation').mockImplementation(()=>Object.assign(vi.fn(),{respond:vi.fn()}));
    const received:any[]=[],socket=await app.injectWS('/api/sessions/own/conversation/stream?protocol=2',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
    try{await vi.waitFor(()=>expect(fileEmit).toBeTypeOf('function'));fileEmit({type:'history',runtime:{},messages:[{id:'durable',sequence:20,role:'user',text:'hello',timestamp:null,client_id:'terminal'}]});
      await vi.waitFor(()=>expect(received.find(frame=>frame.type==='input_reconciliation')).toMatchObject({native_id:'native',messages:[{id:'durable',client_id:'browser',native_client_id:'terminal',input_source:{kind:'scheduled',label:'巡检'}}]}));
    }finally{await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.close();});}
  });
  it('rejects browser reuse of a platform submission identity',async()=>{
    getDb().prepare('INSERT INTO conversation_input_sources(session_id,client_id,kind,label) VALUES(?,?,?,?)').run('own','platform-id','scheduled','巡检');
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'伪造',source:'conversation',client_id:'platform-id'}});
    expect(result.statusCode).toBe(409);expect(result.json().submission).toBe('rejected');expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('forwards late statistics while the native event stream remains connected',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    let fileEmit:((frame:any)=>void)|undefined,nativeEmit:((frame:any)=>void)|undefined;
    vi.spyOn(fileStream,'observeConversationFile').mockImplementation((_binding,emit)=>{fileEmit=emit;return vi.fn();});
    vi.spyOn(conversation,'observeCodexConversation').mockImplementation((_native,emit)=>{nativeEmit=emit;return Object.assign(vi.fn(),{respond:vi.fn()});});
    const frames:any[]=[],socket=await app.injectWS('/api/sessions/own/conversation/stream',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>frames.push(JSON.parse(bytes.toString())))});
    try{
      await vi.waitFor(()=>expect(nativeEmit&&fileEmit).toBeTruthy());
      nativeEmit!({type:'snapshot',messages:[],interactions:[],activities:[],compaction:null,busy:true,connected:true,turn_id:'turn',started_at:null,completed_at:null,stage:'tools'});
      fileEmit!({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:'finished',turn_id:'turn',tokens:{input_tokens:100},requests:1,tool_calls:2,tool_rounds:1,complete:true}]});
      await vi.waitFor(()=>expect(frames.find(frame=>frame.type==='statistics')).toMatchObject({statistics:[{message_id:'finished',tool_calls:2}]}));
    }finally{await new Promise<void>(resolve=>{socket.once('close',resolve);socket.close();});}
  });
  it('projects personal ignored questions on every history replay after reconnect',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    const owner=getDb().prepare("SELECT id FROM users WHERE username='owner'").get() as {id:string};
    setIgnoredQuestions(owner.id,'native',['old-question']);
    vi.spyOn(conversation,'observeCodexConversation').mockImplementation((_native,emit)=>{
      queueMicrotask(()=>emit({type:'unavailable',reason:'test fallback'}));
      return Object.assign(vi.fn(),{respond:vi.fn()});
    });
    vi.spyOn(fileStream,'observeConversationFile').mockImplementation((_binding,emit)=>{
      queueMicrotask(()=>emit({type:'history',messages:[],runtime:{source:'codex_rollout',session_id:'native',state:'idle',observed_at:new Date().toISOString(),last_activity_at:null,reason:'native',pending_question_count:1,pending_questions:[{id:'old',timestamp:null,questions:[{id:'old-question',title:'Old question',options:null}]}]}}));
      return vi.fn();
    });
    for(let reconnect=0;reconnect<2;reconnect++){
      const received:any[]=[];
      const socket=await app.injectWS('/api/sessions/own/conversation/stream',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
      try{await vi.waitFor(()=>expect(received.find(frame=>frame.type==='history')?.runtime).toMatchObject({pending_question_count:0,pending_questions:[],ignored_question_ids:['old-question']}));}
      finally{await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.close();});}
    }
  });
  it('preserves native event sequence numbers when file and native usage counters coincide',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    let nativeEmit!:(frame:any)=>void,fileEmit!:(frame:any)=>void;
    const stopFile=vi.fn();
    vi.spyOn(conversation,'observeCodexConversation').mockImplementation((_native,emit)=>{nativeEmit=emit;return Object.assign(vi.fn(),{respond:vi.fn()});});
    vi.spyOn(fileStream,'observeConversationFile').mockImplementation((_binding,emit)=>{fileEmit=emit;return stopFile;});
    const received:any[]=[],socket=await app.injectWS('/api/sessions/own/conversation/stream?protocol=2',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
    try {
      await vi.waitFor(()=>expect(nativeEmit).toBeTypeOf('function'));
      nativeEmit({type:'unavailable',reason:'test fallback'});
      await vi.waitFor(()=>expect(fileEmit).toBeTypeOf('function'));
      const usage={type:'usage',native_id:'native',usage:{total:null,last:null,window:40000},observed_at:new Date().toISOString()};
      fileEmit(usage);
      const state={type:'snapshot',messages:[],interactions:[],activities:[],compaction:null,busy:true,connected:true,turn_id:'turn',started_at:null,completed_at:null,stage:'answering'};
      nativeEmit(state);
      nativeEmit(usage);nativeEmit({type:'patch',upserts:[],deltas:[],state:{...state,busy:false,stage:'idle'}});
      await vi.waitFor(()=>expect(received.some(frame=>frame.type==='patch')).toBe(true));
      const sequence=received.filter(frame=>frame.stream_id).map(frame=>frame.stream_seq);
      expect(sequence).toEqual(sequence.map((_:number,index:number)=>index+1));
      expect(received.filter(frame=>frame.type==='usage'&&!frame.stream_id)).toHaveLength(1);
      expect(stopFile).toHaveBeenCalledOnce();
    }finally{await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.close();});}
  });
  it('acknowledges an async provider response only after acceptance and reports rejection',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    let resolve!:()=>void;const respond=vi.fn().mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done;})).mockRejectedValueOnce(new Error('Agent 拒绝回答'));
    vi.spyOn(conversation,'observeCodexConversation').mockReturnValue(Object.assign(vi.fn(),{respond}));vi.spyOn(fileStream,'observeConversationFile').mockReturnValue(vi.fn());
    const received:any[]=[],socket=await app.injectWS('/api/sessions/own/conversation/stream',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
    try {
      await vi.waitFor(()=>expect(conversation.observeCodexConversation).toHaveBeenCalled());socket.send(JSON.stringify({type:'interaction_response',request_id:'q',answer:{answers:{q:{answers:['answer']}}}}));
      await vi.waitFor(()=>expect(respond).toHaveBeenCalledOnce());expect(received.filter(frame=>frame.type==='interaction_result')).toEqual([]);
      resolve();await vi.waitFor(()=>expect(received.at(-1)).toMatchObject({ok:true,request_id:'q'}));
      socket.send(JSON.stringify({type:'interaction_response',request_id:'next',answer:{}}));await vi.waitFor(()=>expect(received.at(-1)).toMatchObject({ok:false,request_id:'next',error:'Agent 拒绝回答'}));
    }finally{await new Promise<void>(done=>{socket.once('close',()=>done());socket.close();});}
  });
  it('reattaches before sending when the server restarted after the last browser snapshot',async()=>{
    vi.mocked(manager.isSessionActive).mockReturnValue(false);getDb().prepare("UPDATE sessions SET status='detached' WHERE id='own'").run();
    const reconnect=vi.spyOn(manager,'reconnectSession').mockResolvedValue(true);
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'继续当前任务'}});
    expect(result.statusCode).toBe(202);expect(reconnect).toHaveBeenCalledExactlyOnceWith('own');expect(manager.writeToSession).toHaveBeenCalledTimes(2);
  });
  it('rejects an unavailable terminal clearly and does not write or resend the input',async()=>{
    vi.mocked(manager.isSessionActive).mockReturnValue(false);vi.spyOn(manager,'reconnectSession').mockResolvedValue(false);vi.spyOn(manager,'recoverSessionOnAttach').mockResolvedValue(false);
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'继续'}});
    expect(result.statusCode).toBe(409);expect(result.json()).toMatchObject({submission:'rejected'});expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('checks access and payload before reattaching any terminal',async()=>{
    const reconnect=vi.spyOn(manager,'reconnectSession').mockResolvedValue(true);
    expect((await app.inject({method:'POST',url:'/api/sessions/other/input',headers:{cookie},payload:{input:'继续'}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:''}})).statusCode).toBe(400);
    expect(reconnect).not.toHaveBeenCalled();expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('allows native responses only with fresh write permission, session access and a live login',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    const user=getDb().prepare("SELECT id FROM users WHERE username='owner'").get() as {id:string};
    getDb().prepare("UPDATE users SET role='member' WHERE id=?").run(user.id);
    getDb().prepare("INSERT INTO rbac_roles(id,name) VALUES ('read-chat','Read chat')").run();setRoleGrants('read-chat',{agent_api:'read'});setUserRoles(user.id,['read-chat']);
    const respond=vi.fn(),stop=Object.assign(vi.fn(),{respond});
    vi.spyOn(conversation,'observeCodexConversation').mockReturnValue(stop);
    const received:any[]=[];
    const socket=await app.injectWS('/api/sessions/own/conversation/stream',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
    const send=()=>socket.send(JSON.stringify({type:'interaction_response',request_id:'7',answer:{decision:'accept'}}));
    try {
      send();await vi.waitFor(()=>expect(received.findLast(frame=>frame.type==='interaction_result')).toMatchObject({type:'interaction_result',ok:false}));expect(respond).not.toHaveBeenCalled();
      setRoleGrants('read-chat',{agent_api:'write'});received.length=0;send();await vi.waitFor(()=>expect(received.findLast(frame=>frame.type==='interaction_result')).toMatchObject({ok:true}));expect(respond).toHaveBeenCalledOnce();
      getDb().prepare("UPDATE sessions SET created_by_user_id=(SELECT id FROM users WHERE username='other') WHERE id='own'").run();received.length=0;send();await vi.waitFor(()=>expect(received.findLast(frame=>frame.type==='interaction_result')).toMatchObject({ok:false}));expect(respond).toHaveBeenCalledOnce();
      getDb().prepare("UPDATE sessions SET created_by_user_id=? WHERE id='own'").run(user.id);getDb().prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);received.length=0;send();await vi.waitFor(()=>expect(received.findLast(frame=>frame.type==='interaction_result')).toMatchObject({ok:false}));expect(respond).toHaveBeenCalledOnce();
    }finally {await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.close();});}
    expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('validates and persists batch boundaries without changing the submitted prompt',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const payload={input:'one\n\ntwo',source:'conversation',client_id:'batch-one',batch:[{length:3,attachments:0},{length:3,attachments:0}]};
    const rejected=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{...payload,batch:[{length:99,attachments:0}]}});
    expect(rejected.statusCode).toBe(400);expect(submit).not.toHaveBeenCalled();
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload});
    expect(result.statusCode).toBe(202);expect(submit.mock.calls[0][1]).toBe(payload.input);
    expect(decorateBatches('own',[{id:'native-message',role:'user',text:payload.input,timestamp:null,client_id:'batch-one'}])[0].batch).toEqual([{text:'one',attachments:[]},{text:'two',attachments:[]}]);
  });
  it('routes chat followups directly to the existing native engine instead of a terminal menu',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'能否再详细一下',source:'conversation'}});
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','能否再详细一下',undefined,[],expect.any(Function));expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it.each(['unchanged', 'before reconnect', 'during reconnect'] as const)('handles a first brief send disconnect on the selected account (binding: %s)', async (binding) => {
    const db = getDb();
    const nativeId = '019ff001-2525-7888-8888-888888888888';
    const account = 'account:brief';
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(SEND_GUARD_KEY, JSON.stringify({enabled: false, rules: []}));
    const {id: owner} = db.prepare("SELECT id FROM users WHERE username='owner'").get() as {id: string};
    db.prepare("INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids) VALUES (?,'codex','Brief account','account',1,?,?)")
      .run(account, JSON.stringify({username: 'fixture'}), JSON.stringify([owner]));
    db.prepare("UPDATE sessions SET native_session_id=?,codex_session_id=?,agent_environment_id=? WHERE id='own'").run(nativeId, nativeId, account);

    const engineSocket = join(fixtureDir, 'target-engine.sock');
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', join(fixtureDir, 'different-engine.sock'));
    vi.spyOn(environments, 'engineForEnvironment').mockResolvedValue({socket: engineSocket, environmentId: account});
    vi.spyOn(inputLinks, 'rememberConversationInput').mockResolvedValue(undefined);
    const engine = createServer();
    const ws = new WebSocketServer({server: engine});
    const turns: unknown[] = [];
    let reads = 0;
    ws.on('connection', (socket) => {
      socket.on('message', (bytes) => {
        const {id, method, params} = JSON.parse(bytes.toString());
        if (!id) return;
        if (method === 'thread/read') {
          reads++;
          if ((reads === 1 && binding === 'before reconnect') || (reads === 2 && binding === 'during reconnect')) {
            db.prepare("UPDATE sessions SET agent_environment_id=NULL WHERE id='own'").run();
          }
          if (reads === 1) {
            socket.terminate();
            return;
          }
        }
        if (method === 'turn/start') turns.push(params);
        socket.send(JSON.stringify({id, result: method === 'thread/read' ? {thread: {id: nativeId, status: {type: 'idle'}}} : {}}));
      });
    });
    await new Promise<void>((resolve) => engine.listen(engineSocket, resolve));
    const input = '简要历史与当前草稿';
    const clientId = 'brief-account-draft';
    try {
      const check = await app.inject({method: 'POST', url: '/api/sessions/own/input-check', headers: {cookie}, payload: {input}});
      expect(check.statusCode).toBe(200);
      expect(check.json().native_id).toBe(nativeId);
      const result = await app.inject({
        method: 'POST', url: '/api/sessions/own/input', headers: {cookie},
        payload: {input, source: 'conversation', client_id: clientId, guard_token: check.json().token},
      });
      expect(manager.writeToSession).not.toHaveBeenCalled();
      if (binding !== 'unchanged') {
        expect(result.statusCode).toBe(409);
        expect(result.json()).toMatchObject({submission: 'rejected', error: expect.stringContaining('账号已变化')});
        expect(reads).toBe(binding === 'before reconnect' ? 1 : 2);
        expect(turns).toEqual([]);
      } else {
        expect(result.statusCode).toBe(202);
        expect(result.json()).toMatchObject({status: 'submitted'});
        expect(reads).toBe(2);
        expect(turns).toEqual([expect.objectContaining({threadId: nativeId, clientUserMessageId: clientId, input: [expect.objectContaining({text: input})]})]);
      }
    } finally {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => engine.close(() => resolve()));
    }
  });
  it('acknowledges native queued input without falling through to terminal paste',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue('queued');const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'压缩完再处理',source:'conversation',client_id:'queue-one'}});expect(result.statusCode).toBe(202);expect(result.json()).toMatchObject({status:'queued'});expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('forwards and validates the correlation ID before submitting native chat input',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const post=(client_id:unknown)=>app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'继续',source:'conversation',client_id}});
    expect((await post('client-one')).statusCode).toBe(202);
    expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','继续','client-one',[],expect.any(Function));
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
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','', 'file-only',[{...attachments[0],path:realpathSync(path)}],expect.any(Function));
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
  it('upgrades an unloaded idle legacy conversation before submitting the same client identity once',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValueOnce(false).mockResolvedValueOnce(true),upgrade=vi.spyOn(manager,'ensureCodexConversationStreaming').mockResolvedValue(true);
    const response=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'实时输出检查',source:'conversation',client_id:'same-client'}});
    expect(response.statusCode).toBe(202);expect(upgrade).toHaveBeenCalledOnce();expect(submit.mock.calls.map(call=>call.slice(0,3))).toEqual([['019ff001-8888-7888-8888-888888888888','实时输出检查','same-client'],['019ff001-8888-7888-8888-888888888888','实时输出检查','same-client']]);expect(manager.writeToSession).not.toHaveBeenCalled();
  });
  it('reports a failed upgrade as not submitted and never pastes into a half-reloaded terminal',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(false);vi.spyOn(manager,'ensureCodexConversationStreaming').mockRejectedValue(new manager.CodexStreamingUpgradeError('版本不匹配，原会话已保留'));
    const response=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'检查',source:'conversation',client_id:'client'}});
    expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({submission:'rejected',error:'版本不匹配，原会话已保留'});expect(manager.writeToSession).not.toHaveBeenCalled();
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
    expect((await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'follow-up'}})).statusCode).toBe(409);
    expect(manager.writeToSession).toHaveBeenCalledTimes(1);
  });
});
