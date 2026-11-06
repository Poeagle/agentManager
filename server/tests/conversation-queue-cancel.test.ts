import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {createServer} from 'http';
import {WebSocketServer} from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession,createUser} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {agentRoutes} from '../src/routes/agent.js';
import {join} from 'path';

afterEach(()=>vi.unstubAllEnvs());
it('cancels only the selected pending native message, rejects consumed messages and checks permissions before RPC',async()=>{
 const fixture=createTestDatabase(),app=Fastify(),server=createServer(),wss=new WebSocketServer({server});
 const owner=createUser({username:'queue-owner',password:'password1',role:'admin'});
 const other=createUser({username:'queue-other',password:'password1',role:'admin'});
 const cookie=`agentmanager_session=${createSession(owner.id)}`,native='019ff001-1515-7515-8515-151515151515';
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('q-project','Queue',?,?)").run(fixture.dir,owner.id);
 getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('queued','q-project','Task','running','session','codex',?,?)").run(native,owner.id);
 vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(fixture.dir,'native.sock'));
 let queued=[{id:'native-a',clientUserMessageId:'client-a',input:[]},{id:'native-b',clientUserMessageId:'client-b',input:[]}];const calls:any[]=[];
 wss.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(!m.id)return;calls.push(m);let result:any={};if(m.method==='thread/queue/list')result={data:queued};if(m.method==='thread/queue/delete'){const before=queued.length;queued=queued.filter(q=>q.id!==m.params.queuedSubmissionId);result={deleted:queued.length<before};}ws.send(JSON.stringify({id:m.id,result}));}));
 await new Promise<void>(resolve=>server.listen(join(fixture.dir,'native.sock'),resolve));
 await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});
 try {
  const removed=await app.inject({method:'DELETE',url:'/api/sessions/queued/queue/client-a',headers:{cookie}});expect(removed.statusCode).toBe(200);expect(queued.map(q=>q.clientUserMessageId)).toEqual(['client-b']);
  expect(calls.filter(c=>c.method==='thread/queue/delete')).toMatchObject([{params:{threadId:native,queuedSubmissionId:'native-a'}}]);
  expect((await app.inject({method:'DELETE',url:'/api/sessions/queued/queue/client-a',headers:{cookie}})).statusCode).toBe(409);
  const before=calls.length;const forbidden=await app.inject({method:'DELETE',url:'/api/sessions/queued/queue/client-b',headers:{cookie:`agentmanager_session=${createSession(other.id)}`}});expect([403,404]).toContain(forbidden.statusCode);expect(calls).toHaveLength(before);
  expect(calls.some(c=>c.method==='turn/start'||c.method==='turn/interrupt')).toBe(false);
 }finally{await app.close();for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));fixture.cleanup();}
});
