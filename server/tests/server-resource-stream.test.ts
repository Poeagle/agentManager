import { once } from 'events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { streamRoutes } from '../src/routes/stream.js';
import { broadcastEphemeral } from '../src/services/event-store.js';
import { setRoleGrants, setUserRoles } from '../src/services/rbac.js';
import { getDb } from '../src/db/index.js';
import { createTestDatabase } from './helpers/database.js';
import {setIgnoredQuestions} from '../src/services/question-attention.js';

it('pushes host samples only to users with monitor access, including permission changes', async () => {
  const database = createTestDatabase();
  const app = Fastify({ logger: false });
  const sockets: WebSocket[] = [];
  const admin = createUser({ username: 'admin', password: 'password1', role: 'admin' });
  const observer = createUser({ username: 'observer', password: 'password2' });
  const member = createUser({ username: 'member', password: 'password3' });
  getDb().prepare("INSERT INTO rbac_roles (id, name) VALUES ('observer', 'Test observer')").run();
  setRoleGrants('observer', { monitor: 'read' });
  setUserRoles(observer.id, ['observer']);
  await app.register(websocket);
  app.addHook('onRequest', authHook);
  await app.register(streamRoutes, { prefix: '/api' });
  await app.ready();

  async function connect(userId: string) {
    const messages: { type: string; data: string }[] = [];
    const socket = await app.injectWS('/api/stream', {
      headers: { cookie: `agentmanager_session=${createSession(userId)}` },
    }, { onInit: (ws) => ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()))) });
    sockets.push(socket);
    return { socket, messages };
  }

  async function publish() {
    const barriers = sockets.map((socket) => new Promise<void>((resolve) => {
      const listen = (raw: { toString(): string }) => {
        if (JSON.parse(raw.toString()).type !== 'test.barrier') return;
        socket.off('message', listen);
        resolve();
      };
      socket.on('message', listen);
    }));
    broadcastEphemeral({ type: 'server.resources', data: { server_resources: { sampled_at: '2026-10-13T08:00:00.000Z' } } });
    broadcastEphemeral({ type: 'test.barrier' });
    await Promise.all(barriers);
  }

  try {
    await expect(app.injectWS('/api/stream')).rejects.toThrow('401');
    const adminStream = await connect(admin.id);
    const observerStream = await connect(observer.id);
    const memberStream = await connect(member.id);
    await publish();
    expect(adminStream.messages.filter((message) => message.type === 'server.resources')).toHaveLength(1);
    expect(observerStream.messages.filter((message) => message.type === 'server.resources')).toHaveLength(1);
    expect(memberStream.messages.filter((message) => message.type === 'server.resources')).toHaveLength(0);
    setUserRoles(observer.id, ['member']);
    await publish();
    expect(adminStream.messages.filter((message) => message.type === 'server.resources')).toHaveLength(2);
    expect(observerStream.messages.filter((message) => message.type === 'server.resources')).toHaveLength(1);
  } finally {
    await Promise.all(sockets.map(async (socket) => { const closed = once(socket, 'close'); socket.terminate(); await closed; }));
    await app.close();
    database.cleanup();
  }
});

it('pushes native status with per-user reminders and rejects inaccessible sessions and stale bindings',async()=>{
  const database=createTestDatabase(),app=Fastify(),sockets:WebSocket[]=[];
  try{
    const owner=createUser({username:'native-owner',password:'password1',role:'admin'}),viewer=createUser({username:'native-viewer',password:'password1',role:'admin'}),outsider=createUser({username:'native-other',password:'password1'});
    getDb().prepare("INSERT INTO sessions(id,task,status,cli_type,mode,codex_session_id,created_by_user_id) VALUES('runtime-s','Work','running','codex','terminal','native',?)").run(owner.id);
    setIgnoredQuestions(owner.id,'native',['q']);
    await app.register(websocket);app.addHook('onRequest',authHook);await app.register(streamRoutes,{prefix:'/api'});await app.ready();
    const connect=async(userId:string)=>{const received:any[]=[];sockets.push(await app.injectWS('/api/stream',{headers:{cookie:`agentmanager_session=${createSession(userId)}`}},{onInit:ws=>ws.on('message',bytes=>received.push(JSON.parse(bytes.toString())))}));return received;};
    const own=await connect(owner.id),view=await connect(viewer.id),other=await connect(outsider.id);
    const runtime={source:'codex_rollout',session_id:'native',state:'idle',last_activity_at:null,observed_at:new Date().toISOString(),reason:'native',pending_questions:[{id:'call',timestamp:null,questions:[{id:'q',title:'Question',options:null}]}]};
    broadcastEphemeral({type:'session.runtime',session_id:'runtime-s',data:{runtime}});
    const barriers=sockets.map(socket=>new Promise<void>(resolve=>{const onMessage=(bytes:any)=>{if(JSON.parse(bytes.toString()).type==='barrier'){socket.off('message',onMessage);resolve();}};socket.on('message',onMessage);}));broadcastEphemeral({type:'barrier'});await Promise.all(barriers);
    expect(JSON.parse(own.find(e=>e.type==='session.runtime').data).runtime).toMatchObject({pending_question_count:0,ignored_question_ids:['q']});
    expect(JSON.parse(view.find(e=>e.type==='session.runtime').data).runtime).toMatchObject({pending_question_count:1,ignored_question_ids:[]});
    expect(other.some(e=>e.type==='session.runtime')).toBe(false);
    getDb().prepare("UPDATE sessions SET codex_session_id='next' WHERE id='runtime-s'").run();broadcastEphemeral({type:'session.runtime',session_id:'runtime-s',data:{runtime}});
    await new Promise(resolve=>setTimeout(resolve,20));expect(own.filter(e=>e.type==='session.runtime')).toHaveLength(1);
  }finally{await Promise.all(sockets.map(async socket=>{const closed=once(socket,'close');socket.terminate();await closed;}));await app.close();database.cleanup();}
});
