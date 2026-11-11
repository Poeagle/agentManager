import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {randomBytes,randomUUID} from 'crypto';
import {
  getUserCount, findUserByUsername, createInitialAdminAsync, hashPassword, verifyPasswordAsync,
  createSession, destroySession, setSessionCookie, clearSessionCookie,
  readSessionCookie, claimOrphanProjects, passwordLengthError, hashApiKey,
} from '../auth.js';
import {getDb} from '../db/index.js';
import {userHasPermission,validateGrants,type PermissionKey,type PermissionLevel} from '../services/rbac.js';
import { config } from '../config.js';
import { revokeTokenConnections } from '../services/user-connections.js';
import {requestLoginMetadata} from '../services/login-metadata.js';
import {startAuthSessionCleanup} from '../services/auth-session-cleanup.js';

interface LoginAttemptBucket {
  failures: number[];
  blockedUntil: number;
  inFlight: number;
}

const loginAttempts = new Map<string, LoginAttemptBucket>();
// Unknown accounts still execute one scrypt verification so response timing
// does not reveal whether a username exists.
const DUMMY_PASSWORD_HASH = hashPassword(randomDummyPassword());

function randomDummyPassword(): string {
  return `agentmanager-login-dummy-${process.pid}-${Date.now()}`;
}

function loginKeys(ip: string, username: string): string[] {
  return [`ip:${ip}`, `account:${username.toLocaleLowerCase('en-US')}`];
}

function currentBlock(keys: string[], now: number): number {
  let blockedUntil = 0;
  for (const key of keys) {
    const bucket = loginAttempts.get(key);
    if (!bucket) continue;
    bucket.failures = bucket.failures.filter((at) => now - at < config.loginRateLimitWindowMs);
    if (bucket.failures.length === 0 && bucket.blockedUntil <= now && bucket.inFlight === 0) loginAttempts.delete(key);
    else blockedUntil = Math.max(blockedUntil, bucket.blockedUntil);
  }
  return blockedUntil;
}

/** Reserve scarce password-hash work before the first await. JavaScript runs
 * this section atomically, so a burst cannot all pass the limiter together. */
function reserveLoginAttempt(keys: string[], now: number): number {
  const blockedUntil = currentBlock(keys, now);
  if (blockedUntil > now) return blockedUntil;
  for (const key of keys) {
    const bucket = loginAttempts.get(key);
    if ((bucket?.failures.length ?? 0) + (bucket?.inFlight ?? 0) >= config.loginRateLimitMax) {
      return now + 1_000;
    }
  }
  for (const key of keys) {
    const bucket = loginAttempts.get(key) || { failures: [], blockedUntil: 0, inFlight: 0 };
    bucket.inFlight++;
    loginAttempts.set(key, bucket);
  }
  return 0;
}

function releaseLoginAttempt(keys: string[]): void {
  const now = Date.now();
  for (const key of keys) {
    const bucket = loginAttempts.get(key);
    if (!bucket) continue;
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    if (bucket.inFlight === 0 && bucket.failures.length === 0 && bucket.blockedUntil <= now) {
      loginAttempts.delete(key);
    }
  }
}

function recordLoginFailure(keys: string[], now: number): number {
  let blockedUntil = 0;
  for (const key of keys) {
    const bucket = loginAttempts.get(key) || { failures: [], blockedUntil: 0, inFlight: 0 };
    bucket.failures = bucket.failures.filter((at) => now - at < config.loginRateLimitWindowMs);
    bucket.failures.push(now);
    if (bucket.failures.length >= config.loginRateLimitMax) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + config.loginBlockMs);
    }
    blockedUntil = Math.max(blockedUntil, bucket.blockedUntil);
    loginAttempts.set(key, bucket);
  }
  if (loginAttempts.size > 10_000) {
    for (const [key, bucket] of loginAttempts) {
      if (bucket.blockedUntil <= now && bucket.failures.every((at) => now - at >= config.loginRateLimitWindowMs)) {
        loginAttempts.delete(key);
      }
    }
  }
  return blockedUntil;
}

function sendRateLimited(reply: FastifyReply, blockedUntil: number) {
  const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  return reply.header('Retry-After', String(retryAfter)).code(429).send({ error: 'Too many login attempts. Try again later.' });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  let stopCleanup:(()=>void)|undefined;
  app.addHook('onReady',async()=>{stopCleanup=startAuthSessionCleanup(error=>app.log.warn({err:error},'Expired login cleanup failed'));});
  app.addHook('onClose',async()=>{stopCleanup?.();});
  // Public: does the app need first-run setup, and am I logged in?
  app.get('/auth/status', async (req) => {
    return {
      needsSetup: getUserCount() === 0,
      authenticated: !!req.user,
      user: req.user ?? null,
    };
  });

  // Public, only valid when there are no users yet: create the first admin.
  app.post('/auth/setup', async (req, reply) => {
    if (getUserCount() > 0) return reply.code(409).send({ error: 'Already set up' });
    const { username, password, display_name } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    if (typeof username !== 'string' || !username.trim() || username.length > 64) {
      return reply.code(400).send({ error: 'username must be between 1 and 64 characters' });
    }
    const passwordError = passwordLengthError(password);
    if (passwordError) return reply.code(400).send({ error: passwordError });
    const user = await createInitialAdminAsync({
      username: String(username),
      password: String(password),
      display_name: display_name ? String(display_name) : undefined,
    });
    if (!user) return reply.code(409).send({ error: 'Already set up' });
    // First admin inherits any pre-existing (ownerless) projects.
    claimOrphanProjects(user.id);
    setSessionCookie(reply, createSession(user.id,requestLoginMetadata(req)));
    return { user };
  });

  // Public: log in.
  app.post('/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    if (typeof username !== 'string' || !username.trim() || username.length > 64) {
      return reply.code(400).send({ error: 'Invalid username or password' });
    }
    if (typeof password !== 'string' || password.length > 256) {
      return reply.code(400).send({ error: 'Invalid username or password' });
    }

    const normalizedUsername = username.trim();
    const keys = loginKeys(req.ip, normalizedUsername);
    const now = Date.now();
    const blockedUntil = reserveLoginAttempt(keys, now);
    if (blockedUntil > now) return sendRateLimited(reply, blockedUntil);

    const row = findUserByUsername(normalizedUsername);
    let passwordMatches = false;
    try {
      passwordMatches = await verifyPasswordAsync(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    } finally {
      releaseLoginAttempt(keys);
    }
    if (!row || row.disabled || !passwordMatches) {
      const newlyBlockedUntil = recordLoginFailure(keys, Date.now());
      if (newlyBlockedUntil > Date.now()) return sendRateLimited(reply, newlyBlockedUntil);
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    const blockedAfterHash = currentBlock(keys, Date.now());
    if (blockedAfterHash > Date.now()) return sendRateLimited(reply, blockedAfterHash);
    loginAttempts.delete(`account:${normalizedUsername.toLocaleLowerCase('en-US')}`);
    setSessionCookie(reply, createSession(row.id,requestLoginMetadata(req)));
    const { password_hash, ...user } = row;
    return { user };
  });

  // Authenticated: who am I.
  app.get('/auth/me', async (req) => ({ user: req.user ?? null }));

  // Key management is available only to a browser session, never a key.
  app.get('/auth/api-keys', async (req,reply) => {
    reply.header('Cache-Control','no-store');
    const rows=getDb().prepare('SELECT id,name,created_at,expires_at,last_used_at,grants FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(req.user!.id) as Array<{grants:string;[key:string]:unknown}>;
    return {keys:rows.map(row=>({...row,grants:JSON.parse(row.grants)}))};
  });
  app.post<{Body:{name?:unknown;expires_at?:unknown;grants?:unknown}}>('/auth/api-keys', async (req,reply) => {
    reply.header('Cache-Control','no-store');
    const {name,expires_at,grants}=req.body||{};
    const expiry=typeof expires_at==='string'?Date.parse(expires_at):NaN;
    if(typeof name!=='string'||!name.trim()||name.trim().length>80||!Number.isFinite(expiry)||expiry<=Date.now()) return reply.code(400).send({error:'请输入名称及未来的有效到期时间'});
    if(!validateGrants(grants)||!Object.keys(grants).length)return reply.code(400).send({error:'请选择有效的授权范围'});
    if(Object.entries(grants).some(([permission,level])=>!userHasPermission(req.user!.id,permission as PermissionKey,level as PermissionLevel)))return reply.code(403).send({error:'不能授予超出当前账号的权限'});
    const id=randomUUID(),key='amk_'+randomBytes(32).toString('base64url'),createdAt=new Date().toISOString(),expiresAt=new Date(expiry).toISOString();
    const db=getDb();
    const inserted=db.transaction(()=>{const count=(db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE user_id=?').get(req.user!.id) as {count:number}).count;if(count>=50)return false;db.prepare('INSERT INTO api_keys (id,user_id,name,token_hash,grants,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id,req.user!.id,name.trim(),hashApiKey(key),JSON.stringify(grants),createdAt,expiresAt);return true;})();
    if(!inserted)return reply.code(409).send({error:'API Key 已达到 50 个，请先撤销不再使用的密钥'});
    return {key,record:{id,name:name.trim(),grants,created_at:createdAt,expires_at:expiresAt,last_used_at:null}};
  });
  app.delete<{Params:{id:string}}>('/auth/api-keys/:id', async (req,reply) => {
    reply.header('Cache-Control','no-store');
    const result=getDb().prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id,req.user!.id);
    if(!result.changes)return reply.code(404).send({error:'API Key 不存在'});
    return {ok:true};
  });

  // Authenticated: log out.
  app.post('/auth/logout', async (req, reply) => {
    const token = readSessionCookie(req);
    if (token) {
      destroySession(token);
      revokeTokenConnections(token);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });
};
