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
it('interrupts only the requested active native turn after authorization',async()=>{
 const fixture=createTestDatabase(),app=Fastify(),server=createServer(),wss=new WebSocketServer({server});
 const owner=createUser({username:'stop-owner',password:'password1',role:'admin'}),other=createUser({username:'stop-other',password:'password1',role:'admin'});
 const cookie=`agentmanager_session=${createSession(owner.id)}`,native='019ff001-1515-7515-8515-151515151515';
 getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('stop-project','Stop',?,?)").run(fixture.dir,owner.id);
 getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,codex_session_id,created_by_user_id) VALUES('stop-session','stop-project','Task','running','session','codex',?,?)").run(native,owner.id);
 vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',join(fixture.dir,'native.sock'));
 const calls:any[]=[];let active='turn-new';
 wss.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(!m.id)return;calls.push(m);let result:any={};if(m.method==='thread/read')result={thread:{status:{type:'active'}}};if(m.method==='thread/turns/list')result={data:[{id:active,status:'inProgress'}]};ws.send(JSON.stringify({id:m.id,result}));}));
 await new Promise<void>(resolve=>server.listen(join(fixture.dir,'native.sock'),resolve));await app.register(websocket);app.addHook('onRequest',authHook);await app.register(agentRoutes,{prefix:'/api'});
 try {
  const request=(turn_id:string,auth=cookie)=>app.inject({method:'POST',url:'/api/sessions/stop-session/conversation/stop',headers:{cookie:auth},payload:{turn_id}});
  expect((await request('')).statusCode).toBe(400);
  expect((await request('turn-old')).statusCode).toBe(409);expect(calls.some(call=>call.method==='turn/interrupt')).toBe(false);
  const before=calls.length;expect([403,404]).toContain((await request('turn-new',`agentmanager_session=${createSession(other.id)}`)).statusCode);expect(calls).toHaveLength(before);
  expect((await request('turn-new')).statusCode).toBe(202);expect(calls.filter(call=>call.method==='turn/interrupt')).toMatchObject([{params:{threadId:native,turnId:'turn-new'}}]);
  active='turn-later';expect((await request('turn-new')).statusCode).toBe(409);expect(calls.filter(call=>call.method==='turn/interrupt')).toHaveLength(1);
 }finally{await app.close();for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));fixture.cleanup();}
});
