import Fastify, {type FastifyInstance} from 'fastify';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {authHook,createSession,createUser,destroySession} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {platformAiRoutes} from '../src/routes/platform-ai.js';
import {publishMessage} from '../src/services/platform-ai/live.js';
import {receiveMessage} from '../src/services/platform-ai/store.js';
import {createTestDatabase} from './helpers/database.js';

let app: FastifyInstance, cleanup: ()=>void, base: string, token: string, otherToken: string;
let conversation: ReturnType<typeof receiveMessage>;
let abort: AbortController;
beforeEach(async()=>{
  ({cleanup}=createTestDatabase());
  const user=createUser({username:'owner',password:'password1'});
  token=createSession(user.id);otherToken=createSession(createUser({username:'other',password:'password1'}).id);
  conversation=receiveMessage({userId:user.id,externalUserId:user.id,chatId:'web',messageId:'one',content:'你好'});
  app=Fastify();app.addHook('onRequest',authHook);await app.register(platformAiRoutes,{prefix:'/api',runWorker:false});
  base=await app.listen({port:0,host:'127.0.0.1'});abort=new AbortController();
});
afterEach(async()=>{abort.abort();await app.close();cleanup();});
it('streams durable progress only to the conversation owner and closes when authentication is revoked',async()=>{
  const path=`/api/platform-ai/conversations/${conversation.conversation_id}/events`;
  expect((await app.inject({url:path})).statusCode).toBe(401);
  expect((await app.inject({url:path,headers:{cookie:`agentmanager_session=${otherToken}`}})).statusCode).toBe(404);
  const response=await fetch(base+path,{headers:{cookie:`agentmanager_session=${token}`},signal:abort.signal});
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader=response.body!.getReader();const decoder=new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('"type":"refresh"');
  getDb().prepare("UPDATE platform_ai_messages SET status='processing',progress='正在生成回复',partial_content='你好，正在' WHERE id=?").run(conversation.message_id);
  publishMessage(conversation.message_id);
  const chunk=decoder.decode((await reader.read()).value);
  expect(chunk).toContain('你好，正在');expect(chunk).toContain('正在生成回复');
  const saved=await app.inject({url:`/api/platform-ai/conversations/${conversation.conversation_id}`,headers:{cookie:`agentmanager_session=${token}`}});
  expect(saved.json().messages[0].partial_content).toBe('你好，正在');
  destroySession(token);publishMessage(conversation.message_id);
  expect((await reader.read()).done).toBe(true);reader.releaseLock();
});
