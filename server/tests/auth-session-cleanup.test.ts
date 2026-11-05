import Fastify from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createSession,createUser,getSessionUser,purgeExpiredAuthSessions} from '../src/auth.js';
import {authRoutes} from '../src/routes/auth.js';
import {getDb} from '../src/db/index.js';
import {startAuthSessionCleanup,AUTH_SESSION_CLEANUP_INTERVAL_MS} from '../src/services/auth-session-cleanup.js';
import {createTestDatabase} from './helpers/database.js';
let cleanup:()=>void,stop:(()=>void)|undefined;
beforeEach(()=>{({cleanup}=createTestDatabase());});
afterEach(()=>{stop?.();stop=undefined;vi.useRealTimers();cleanup();});
function fixture(){const user=createUser({username:'cleanup',password:'password1'}),active=createSession(user.id),expired=createSession(user.id),internal=createSession(user.id,{kind:'internal',ip:null,userAgent:null});getDb().prepare("UPDATE auth_sessions SET expires_at=datetime('now','-1 day') WHERE token=?").run(expired);return {user,active,expired,internal};}
describe('authentication session retention',()=>{
 it('deletes expired credentials while retaining old-but-renewed logins and Agent history',()=>{
  const {user,active,expired,internal}=fixture();getDb().prepare("UPDATE auth_sessions SET created_at=datetime('now','-90 days') WHERE token=?").run(active);
  getDb().prepare("INSERT INTO projects(id,name,path,owner_id) VALUES('project','P','/tmp/auth-retention',?)").run(user.id);getDb().prepare("INSERT INTO sessions(id,project_id,task,status,created_by_user_id) VALUES('agent','project','Retain history','running',?)").run(user.id);
  expect(purgeExpiredAuthSessions()).toBe(1);expect(getSessionUser(expired)).toBeUndefined();expect(getSessionUser(active)?.id).toBe(user.id);expect(getSessionUser(internal)?.id).toBe(user.id);expect(getDb().prepare("SELECT status FROM sessions WHERE id='agent'").get()).toEqual({status:'running'});
  expect(purgeExpiredAuthSessions()).toBe(0);
 });
 it('sweeps immediately and hourly, and releases the timer when stopped',async()=>{
  const {user,expired}=fixture();vi.useFakeTimers();const onError=vi.fn();stop=startAuthSessionCleanup(onError);expect(getDb().prepare('SELECT token FROM auth_sessions WHERE token=?').get(expired)).toBeUndefined();
  const later=createSession(user.id);getDb().prepare("UPDATE auth_sessions SET expires_at=datetime('now','-1 minute') WHERE token=?").run(later);
  await vi.advanceTimersByTimeAsync(AUTH_SESSION_CLEANUP_INTERVAL_MS-1);expect(getDb().prepare('SELECT token FROM auth_sessions WHERE token=?').get(later)).toBeDefined();await vi.advanceTimersByTimeAsync(1);expect(getDb().prepare('SELECT token FROM auth_sessions WHERE token=?').get(later)).toBeUndefined();
  stop();const retained=createSession(user.id);getDb().prepare("UPDATE auth_sessions SET expires_at=datetime('now','-1 minute') WHERE token=?").run(retained);await vi.advanceTimersByTimeAsync(AUTH_SESSION_CLEANUP_INTERVAL_MS);expect(getDb().prepare('SELECT token FROM auth_sessions WHERE token=?').get(retained)).toBeDefined();expect(onError).not.toHaveBeenCalled();
 });
 it('runs from the authentication plugin lifecycle without a returning browser request',async()=>{
  const {expired}=fixture(),app=Fastify();await app.register(authRoutes,{prefix:'/api'});
  try{await app.ready();expect(getDb().prepare('SELECT token FROM auth_sessions WHERE token=?').get(expired)).toBeUndefined();}finally{await app.close();}
 });
});
