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
  it('pushes a journal-verified terminal echo as an input reconciliation',async()=>{
    getDb().prepare("UPDATE sessions SET codex_session_id='native' WHERE id='own'").run();
    getDb().prepare('INSERT INTO conversation_input_links(session_id,native_id,client_id,input_hash,after_offset) VALUES(?,?,?,?,?)').run('own','native','browser',createHash('sha256').update('hello').digest('hex'),10);
    let fileEmit!:(frame:any)=>void;vi.spyOn(fileStream,'observeConversationFile').mockImplementation((_binding,emit)=>{fileEmit=emit;return vi.fn();});
    vi.spyOn(conversation,'observeCodexConversation').mockImplementation(()=>Object.assign(vi.fn(),{respond:vi.fn()}));
    const received:any[]=[],socket=await app.injectWS('/api/sessions/own/conversation/stream?protocol=2',{headers:{cookie}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))});
    try{await vi.waitFor(()=>expect(fileEmit).toBeTypeOf('function'));fileEmit({type:'history',runtime:{},messages:[{id:'durable',sequence:20,role:'user',text:'hello',timestamp:null,client_id:'terminal'}]});
      await vi.waitFor(()=>expect(received.find(frame=>frame.type==='input_reconciliation')).toMatchObject({native_id:'native',messages:[{id:'durable',client_id:'browser',native_client_id:'terminal'}]}));
    }finally{await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.close();});}
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
  it('routes chat followups directly to the existing native engine instead of a terminal menu',async()=>{
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/tmp/test-preview.sock');
    getDb().prepare("UPDATE sessions SET codex_session_id='019ff001-8888-7888-8888-888888888888' WHERE id='own'").run();
    const submit=vi.spyOn(conversation,'submitStreamingCodexInput').mockResolvedValue(true);
    const result=await app.inject({method:'POST',url:'/api/sessions/own/input',headers:{cookie},payload:{input:'能否再详细一下',source:'conversation'}});
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','能否再详细一下');expect(manager.writeToSession).not.toHaveBeenCalled();
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
    expect(result.statusCode).toBe(202);expect(submit).toHaveBeenCalledWith('019ff001-8888-7888-8888-888888888888','', 'file-only',[{...attachments[0],path:realpathSync(path)}]);
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
    expect(response.statusCode).toBe(202);expect(upgrade).toHaveBeenCalledOnce();expect(submit.mock.calls).toEqual([['019ff001-8888-7888-8888-888888888888','实时输出检查','same-client'],['019ff001-8888-7888-8888-888888888888','实时输出检查','same-client']]);expect(manager.writeToSession).not.toHaveBeenCalled();
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
