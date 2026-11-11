import Fastify from 'fastify';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {authHook,createSession,createUser,sessionCookieName} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {authRoutes} from '../src/routes/auth.js';
import {requirePermission} from '../src/services/rbac.js';
import {createTestDatabase} from './helpers/database.js';

let app:ReturnType<typeof Fastify>,cleanup:()=>void,cookie:string,userId:string;
beforeEach(async()=>{
  ({cleanup}=createTestDatabase());
  const user=createUser({username:'api-owner',password:'password1',role:'admin'});userId=user.id;
  cookie=`${sessionCookieName()}=${createSession(user.id)}`;
  app=Fastify();app.addHook('onRequest',authHook);
  await app.register(authRoutes,{prefix:'/api'});
  app.get('/api/agent-management/codex',async(req,reply)=>{if(!requirePermission(req,reply,'settings','read'))return;return {ok:true};});
  app.post('/api/agent-management/codex/providers',async(req,reply)=>{if(!requirePermission(req,reply,'settings','write'))return;return {ok:true};});
  app.get('/api/projects',async()=>({ok:true}));
});
afterEach(async()=>{await app.close();cleanup();});
async function createKey(grants:Record<string,string>={settings:'write',agent_api:'write'}){
 const response=await app.inject({method:'POST',url:'/api/auth/api-keys',headers:{cookie},payload:{name:'test',grants,expires_at:new Date(Date.now()+3600000).toISOString()}});
 expect(response.statusCode).toBe(200);return response.json() as {key:string;record:{id:string}};
}
describe('expiring API keys',()=>{
 it('only returns the secret once, limits routes, and revokes immediately',async()=>{
  const {key,record}=await createKey();const headers={authorization:`Bearer ${key}`};
  expect(getDb().prepare('SELECT token_hash FROM api_keys WHERE id=?').get(record.id)).not.toEqual({token_hash:key});
  const list=await app.inject({method:'GET',url:'/api/auth/api-keys',headers:{cookie}});
  expect(list.body).not.toContain(key);expect(list.headers['cache-control']).toBe('no-store');
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/agent-management/codex/providers',headers})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:'/api/projects',headers})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:'/api/users',headers})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/auth/api-keys',headers,payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:'DELETE',url:`/api/auth/api-keys/${record.id}`,headers:{cookie}})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers})).statusCode).toBe(401);
 });
 it('enforces the selected permission and level separately from the account',async()=>{
  const {key}=await createKey({settings:'read'});const headers={authorization:`Bearer ${key}`};
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/agent-management/codex/providers',headers})).statusCode).toBe(403);
  expect((await app.inject({method:'GET',url:'/api/projects',headers})).statusCode).toBe(403);
 });
 it('rejects expiry, disabled accounts and permissions removed after issuance',async()=>{
  const {key,record}=await createKey();const headers={authorization:`Bearer ${key}`};
  getDb().prepare('UPDATE users SET role=? WHERE id=?').run('member',userId);
  getDb().prepare('DELETE FROM rbac_user_roles WHERE user_id=?').run(userId);
  expect((await app.inject({method:'POST',url:'/api/agent-management/codex/providers',headers})).statusCode).toBe(403);
  getDb().prepare('UPDATE users SET disabled=1 WHERE id=?').run(userId);
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers})).statusCode).toBe(401);
  getDb().prepare('UPDATE users SET disabled=0,role=? WHERE id=?').run('admin',userId);
  getDb().prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),record.id);
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers})).statusCode).toBe(401);
 });
 it('rejects invalid expiry and other users cannot revoke a key',async()=>{
  const bad=await app.inject({method:'POST',url:'/api/auth/api-keys',headers:{cookie},payload:{name:'x',expires_at:'invalid'}});expect(bad.statusCode).toBe(400);
  const {record}=await createKey();const other=createUser({username:'other',password:'password1',role:'admin'});
  const otherCookie=`${sessionCookieName()}=${createSession(other.id)}`;
  expect((await app.inject({method:'DELETE',url:`/api/auth/api-keys/${record.id}`,headers:{cookie:otherCookie}})).statusCode).toBe(404);
 });
 it('cannot create a key with permissions the account lacks',async()=>{
  const member=createUser({username:'limited',password:'password1',role:'member'});
  const memberCookie=`${sessionCookieName()}=${createSession(member.id)}`;
  const result=await app.inject({method:'POST',url:'/api/auth/api-keys',headers:{cookie:memberCookie},payload:{name:'bad',expires_at:new Date(Date.now()+3600000).toISOString(),grants:{settings:'write'}}});
  expect(result.statusCode).toBe(403);
 });
 it('revokes existing keys when the account is disabled through session invalidation',async()=>{
  const {key}=await createKey();
  const {destroyUserSessions}=await import('../src/auth.js');destroyUserSessions(userId);
  expect((await app.inject({method:'GET',url:'/api/agent-management/codex',headers:{authorization:`Bearer ${key}`}})).statusCode).toBe(401);
 });
});
