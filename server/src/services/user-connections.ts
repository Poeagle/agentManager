import { getDb } from '../db/index.js';
import {getSessionUser} from '../auth.js';

interface ClosableSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
  on?(event:'pong',listener:()=>void):unknown;
  off?(event:'pong',listener:()=>void):unknown;
}

interface UserConnection {
  socket: ClosableSocket;
  token: string;
  heartbeatAt?:number;
}

const connectionsByUser = new Map<string, Set<UserConnection>>();
let validationTimer: ReturnType<typeof setInterval> | null = null;
export const PRESENCE_STALE_MS=75_000;

/** Only the dashboard event stream registers presence. Terminal/API activity
 * and stored login cookies do not establish browser connectivity. */
export function userPresence(userId:string,token?:string,now=Date.now()) {
  const entries=[...(connectionsByUser.get(userId)||[])].filter(entry=>entry.heartbeatAt!==undefined&&entry.socket.readyState===1&&(!token||entry.token===token)&&tokenIsActive(userId,entry.token));
  const fresh=entries.filter(entry=>now-(entry.heartbeatAt!)<=PRESENCE_STALE_MS);
  const latest=entries.reduce((last,entry)=>Math.max(last,entry.heartbeatAt!),0);
  const recorded=getDb().prepare(`SELECT MAX(last_heartbeat_at) AS at FROM auth_sessions
    WHERE user_id=? AND session_kind='browser' AND expires_at>datetime('now')${token?' AND token=?':''}`).get(...token?[userId,token]:[userId]) as {at:string|null};
  const at=Math.max(latest,recorded.at?Date.parse(recorded.at.replace(' ','T')+'Z')||0:0);
  return {state:fresh.length?'online':entries.length?'unresponsive':'offline',connections:fresh.length,last_heartbeat_at:at?new Date(at).toISOString():null} as const;
}

function stopValidationTimerIfIdle(): void {
  if (connectionsByUser.size === 0 && validationTimer) {
    clearInterval(validationTimer);
    validationTimer = null;
  }
}

function ensureValidationTimer(): void {
  if (validationTimer) return;
  validationTimer = setInterval(revalidateUserConnections, 60_000);
  validationTimer.unref?.();
}

function tokenIsActive(userId: string, token: string): boolean {
  const row = getDb().prepare(`
    SELECT u.disabled
    FROM auth_sessions a
    JOIN users u ON u.id = a.user_id
    WHERE a.token = ? AND a.user_id = ? AND a.expires_at > datetime('now')
  `).get(token, userId) as { disabled: number } | undefined;
  return !!row && row.disabled === 0;
}

/** Register a long-lived authenticated socket. The DB recheck closes the race
 * between the request auth hook and a concurrent credential revocation. */
export function registerUserConnection(
  userId: string,
  token: string | null,
  socket: ClosableSocket,
  presence=false,
): (() => void) | null {
  if (!token || !tokenIsActive(userId, token)) {
    try { socket.close(1008, 'Authentication revoked'); } catch { /* already closed */ }
    return null;
  }

  const browser=presence&&(getDb().prepare("SELECT session_kind FROM auth_sessions WHERE token=?").get(token) as {session_kind:string}|undefined)?.session_kind==='browser';
  const entry:UserConnection = { socket, token,...browser?{heartbeatAt:Date.now()}:{}};
  const heartbeat=()=>{
    if(!browser||!tokenIsActive(userId,token))return;
    entry.heartbeatAt=Date.now();
    getSessionUser(token);
    getDb().prepare("UPDATE auth_sessions SET last_heartbeat_at=datetime('now') WHERE token=?").run(token);
  };
  if(browser)getDb().prepare("UPDATE auth_sessions SET last_heartbeat_at=datetime('now') WHERE token=?").run(token);
  if(presence)socket.on?.('pong',heartbeat);
  let connections = connectionsByUser.get(userId);
  if (!connections) {
    connections = new Set();
    connectionsByUser.set(userId, connections);
  }
  connections.add(entry);
  ensureValidationTimer();

  const unregister = () => {
    if(presence)socket.off?.('pong',heartbeat);
    const current = connectionsByUser.get(userId);
    current?.delete(entry);
    if (current?.size === 0) connectionsByUser.delete(userId);
    stopValidationTimerIfIdle();
  };
  socket.once('close', unregister);
  return unregister;
}

/** Close every live socket for a user, optionally preserving a freshly
 * rotated login token. */
export function revokeUserConnections(userId: string, exceptToken?: string): number {
  const connections = connectionsByUser.get(userId);
  if (!connections) return 0;
  let closed = 0;
  for (const entry of [...connections]) {
    if (exceptToken && entry.token === exceptToken) continue;
    connections.delete(entry);
    try { entry.socket.close(1008, 'Authentication revoked'); } catch { /* already closed */ }
    closed++;
  }
  if (connections.size === 0) connectionsByUser.delete(userId);
  stopValidationTimerIfIdle();
  return closed;
}

/** Close sockets authenticated by one login token (logout/session rotation). */
export function revokeTokenConnections(token: string): number {
  let closed = 0;
  for (const [userId, connections] of connectionsByUser) {
    for (const entry of [...connections]) {
      if (entry.token !== token) continue;
      connections.delete(entry);
      try { entry.socket.close(1008, 'Authentication revoked'); } catch { /* already closed */ }
      closed++;
    }
    if (connections.size === 0) connectionsByUser.delete(userId);
  }
  stopValidationTimerIfIdle();
  return closed;
}

/** Periodic DB recheck ensures a long-lived socket cannot outlive its login. */
export function revalidateUserConnections(): number {
  let closed = 0;
  for (const [userId, connections] of connectionsByUser) {
    for (const entry of [...connections]) {
      if (tokenIsActive(userId, entry.token)) continue;
      connections.delete(entry);
      try { entry.socket.close(1008, 'Authentication expired'); } catch { /* already closed */ }
      closed++;
    }
    if (connections.size === 0) connectionsByUser.delete(userId);
  }
  stopValidationTimerIfIdle();
  return closed;
}
