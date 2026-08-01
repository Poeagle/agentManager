import { getDb } from '../db/index.js';

interface ClosableSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

interface UserConnection {
  socket: ClosableSocket;
  token: string;
}

const connectionsByUser = new Map<string, Set<UserConnection>>();
let validationTimer: ReturnType<typeof setInterval> | null = null;

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
): (() => void) | null {
  if (!token || !tokenIsActive(userId, token)) {
    try { socket.close(1008, 'Authentication revoked'); } catch { /* already closed */ }
    return null;
  }

  const entry = { socket, token };
  let connections = connectionsByUser.get(userId);
  if (!connections) {
    connections = new Set();
    connectionsByUser.set(userId, connections);
  }
  connections.add(entry);
  ensureValidationTimer();

  const unregister = () => {
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
