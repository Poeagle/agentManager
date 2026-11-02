import {EventEmitter} from 'node:events';
import Fastify from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authHook,createSession,createUser,getSessionUser} from '../src/auth.js';
import {authRoutes} from '../src/routes/auth.js';
import {userRoutes} from '../src/routes/users.js';
import {getDb,closeDb,initDb} from '../src/db/index.js';
import {requestLoginMetadata} from '../src/services/login-metadata.js';
import {registerUserConnection,userPresence,PRESENCE_STALE_MS} from '../src/services/user-connections.js';
import {createTestDatabase} from './helpers/database.js';
import {serverResourceSampler} from '../src/services/server-resources.js';
let fixture:ReturnType<typeof createTestDatabase>;const sockets:FakeSocket[]=[];
class FakeSocket extends EventEmitter {readyState=1;close(){this.readyState=3;this.emit('close');}}
beforeEach(()=>{fixture=createTestDatabase();});
afterEach(async()=>{sockets.splice(0).forEach(s=>s.close());await serverResourceSampler.stop();vi.useRealTimers();fixture.cleanup();});
function socket(){const s=new FakeSocket();sockets.push(s);return s;}
describe('login source and browser presence',()=>{
 it('migrates old logins without inventing historical IP or losing authentication',()=>{
  const user=createUser({username:'legacy-login',password:'password1'}),token=createSession(user.id);
  for(const name of ['login_ip','last_ip','user_agent','session_kind','last_heartbeat_at'])getDb().exec(`ALTER TABLE auth_sessions DROP COLUMN ${name}`);
  getDb().pragma('user_version=19');closeDb();initDb();expect(getSessionUser(token)?.id).toBe(user.id);
  expect(getDb().prepare('SELECT login_ip,last_ip,user_agent,session_kind FROM auth_sessions WHERE token=?').get(token)).toEqual({login_ip:null,last_ip:null,user_agent:null,session_kind:'browser'});
 });
 it('records login metadata, preserves original login IP and leaves old metadata unknown',()=>{
  const user=createUser({username:'login',password:'password1'});const old=createSession(user.id);getSessionUser(old,{ip:'192.0.2.5',userAgent:'Browser'});
  expect(getDb().prepare('SELECT login_ip,last_ip FROM auth_sessions WHERE token=?').get(old)).toEqual({login_ip:null,last_ip:'192.0.2.5'});
  const fresh=createSession(user.id,{ip:'192.0.2.1',userAgent:'Initial'});getSessionUser(fresh,{ip:'192.0.2.2',userAgent:'Updated'});
  expect(getDb().prepare('SELECT login_ip,last_ip,user_agent FROM auth_sessions WHERE token=?').get(fresh)).toEqual({login_ip:'192.0.2.1',last_ip:'192.0.2.2',user_agent:'Updated'});
 });
 it('ignores spoofed forwarding data from remote peers and accepts the local proxy observed peer',()=>{
  const req=(peer:string,headers:any)=>({raw:{socket:{remoteAddress:peer}},ip:peer,headers}) as any;
  expect(requestLoginMetadata(req('192.0.2.10',{'x-forwarded-for':'198.51.100.1','x-agentmanager-client-ip':'198.51.100.2'})).ip).toBe('192.0.2.10');
  expect(requestLoginMetadata(req('127.0.0.1',{'x-agentmanager-client-ip':'::ffff:192.0.2.3','user-agent':'x'.repeat(700)}))).toEqual({ip:'192.0.2.3',userAgent:'x'.repeat(512)});
  expect(requestLoginMetadata(req('127.0.0.1',{'x-agentmanager-client-ip':'fake'})).ip).toBe('127.0.0.1');
 });
 it('does not call an API request or terminal socket browser online',()=>{
  const user=createUser({username:'api-user',password:'password1'}),token=createSession(user.id);getSessionUser(token);registerUserConnection(user.id,token,socket());
  expect(userPresence(user.id).state).toBe('offline');
 });
 it('tracks multiple browser logins, native heartbeats, timeouts and explicit close independently',()=>{
  const user=createUser({username:'browser',password:'password1'}),a=createSession(user.id),b=createSession(user.id),first=socket(),second=socket();
  vi.useFakeTimers();registerUserConnection(user.id,a,first,true);registerUserConnection(user.id,b,second,true);expect(userPresence(user.id).connections).toBe(2);
  expect(userPresence(user.id,a).connections).toBe(1);vi.setSystemTime(Date.now()+PRESENCE_STALE_MS+1);
  expect(userPresence(user.id).state).toBe('unresponsive');first.emit('pong');expect(userPresence(user.id).connections).toBe(1);expect(userPresence(user.id,b).state).toBe('unresponsive');
  first.close();expect(userPresence(user.id).state).toBe('unresponsive');second.close();expect(userPresence(user.id).state).toBe('offline');expect(userPresence(user.id).last_heartbeat_at).not.toBeNull();
 });
 it('never treats an internal platform AI credential as a browser login',()=>{
  const user=createUser({username:'internal',password:'password1'}),token=createSession(user.id,{ip:null,userAgent:null,kind:'internal'});registerUserConnection(user.id,token,socket(),true);expect(userPresence(user.id).state).toBe('offline');
 });
 it('captures login request address and user agent at authentication',async()=>{
  createUser({username:'request-login',password:'password1'});const app=Fastify();app.addHook('onRequest',authHook);await app.register(authRoutes,{prefix:'/api'});
  try{const result=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:'192.0.2.8',headers:{'user-agent':'Test Browser','x-forwarded-for':'fake'},payload:{username:'request-login',password:'password1'}});expect(result.statusCode).toBe(200);expect(getDb().prepare('SELECT login_ip,last_ip,user_agent FROM auth_sessions').get()).toEqual({login_ip:'192.0.2.8',last_ip:'192.0.2.8',user_agent:'Test Browser'});}finally{await app.close();}
 });
 it('exposes only safe browser login metadata and uses heartbeat evidence instead of last API time',async()=>{
  const user=createUser({username:'monitor',password:'password1',role:'admin'}),token=createSession(user.id,{ip:'192.0.2.4',userAgent:'Browser'});createSession(user.id,{ip:null,userAgent:null,kind:'internal'});
  getDb().prepare("UPDATE auth_sessions SET last_seen_at=datetime('now','-6 minutes') WHERE token=?").run(token);registerUserConnection(user.id,token,socket(),true);
  const app=Fastify();app.addHook('onRequest',async req=>{req.user=user;});await app.register(userRoutes,{prefix:'/api'});
  try{const response=await app.inject({method:'GET',url:'/api/admin/monitor'});expect(response.statusCode).toBe(200);const account=response.json().users[0];expect(account).toMatchObject({online:true,presence:{state:'online',connections:1}});expect(account.login_sessions).toHaveLength(1);expect(account.login_sessions[0]).toMatchObject({login_ip:'192.0.2.4',last_ip:'192.0.2.4',user_agent:'Browser'});expect(JSON.stringify(account)).not.toContain(token);expect(account.login_sessions[0]).not.toHaveProperty('token');expect(account.login_sessions[0]).not.toHaveProperty('user_id');}finally{await app.close();}
 });
});
