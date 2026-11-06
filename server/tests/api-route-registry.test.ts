import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {readFile,readdir} from 'fs/promises';
import {expect,it} from 'vitest';
import {authHook,createSession,createUser} from '../src/auth.js';
import {apiRoutePlugins,registerApiRoutes} from '../src/routes/index.js';
import {installApiFallback} from '../src/http-fallback.js';
import {createTestDatabase} from './helpers/database.js';

it('registers every exported route plugin and keeps hooks/API errors reachable through the production registry',async()=>{
 const dir=new URL('../src/routes/',import.meta.url);
 const exports=(await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.ts')&&n!=='index.ts').map(async n=>[... (await readFile(new URL(n,dir),'utf8')).matchAll(/export const (\w+Routes)\s*:/g)].map(m=>m[1])))).flat();
 expect(Object.keys(apiRoutePlugins).sort()).toEqual(exports.sort());
 const database=createTestDatabase(),app=Fastify();
 try {
  await app.register(websocket);app.addHook('onRequest',authHook);installApiFallback(app);await registerApiRoutes(app);
  app.get('/*',async(_,reply)=>reply.type('text/html').send('SPA'));
  expect((await app.inject('/api/hooks/events-status')).statusCode).toBe(401);
  const user=createUser({username:'routes-admin',password:'password1',role:'admin'});
  const headers={cookie:`agentmanager_session=${createSession(user.id)}`};
  const status=await app.inject({url:'/api/hooks/events-status',headers});expect(status.statusCode).toBe(400);expect(status.json()).toEqual({error:'path is required'});
  const wrong=await app.inject({method:'POST',url:'/api/files/write',headers,payload:{}});expect(wrong.statusCode).toBe(405);expect(wrong.headers.allow).toContain('PUT');
  const missing=await app.inject({url:'/api/sessions/no-such-session/agent',headers});expect(missing.statusCode).toBe(404);expect(missing.json()).toEqual({error:'Session not found'});
 }finally{await app.close();database.cleanup();}
});
