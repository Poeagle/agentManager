import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, createUser, destroyUserSessions } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import {
  registerUserConnection,
  revalidateUserConnections,
  revokeTokenConnections,
  revokeUserConnections,
} from '../src/services/user-connections.js';
import { createTestDatabase } from './helpers/database.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  closeCode: number | undefined;

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
}

let cleanup: (() => void) | undefined;

afterEach(() => cleanup?.());

describe('long-lived user connection revocation', () => {
  it('closes registered sockets when a user is revoked', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'socket-user', password: 'password1' });
    const token = createSession(user.id);
    const socket = new FakeSocket();

    expect(registerUserConnection(user.id, token, socket)).toBeTypeOf('function');
    expect(revokeUserConnections(user.id)).toBe(1);
    expect(socket.closeCode).toBe(1008);
  });

  it('rejects a socket whose login token was already destroyed', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'expired-socket-user', password: 'password1' });
    const token = createSession(user.id);
    destroyUserSessions(user.id);
    const socket = new FakeSocket();

    expect(registerUserConnection(user.id, token, socket)).toBeNull();
    expect(socket.closeCode).toBe(1008);
  });

  it('revokes only sockets using the logged-out token', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'multi-login-user', password: 'password1' });
    const firstToken = createSession(user.id);
    const secondToken = createSession(user.id);
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    registerUserConnection(user.id, firstToken, firstSocket);
    registerUserConnection(user.id, secondToken, secondSocket);

    expect(revokeTokenConnections(firstToken)).toBe(1);
    expect(firstSocket.closeCode).toBe(1008);
    expect(secondSocket.readyState).toBe(1);
    revokeUserConnections(user.id);
  });

  it('closes long-lived sockets after their login expires', () => {
    ({ cleanup } = createTestDatabase());
    const user = createUser({ username: 'natural-expiry-user', password: 'password1' });
    const token = createSession(user.id);
    const socket = new FakeSocket();
    registerUserConnection(user.id, token, socket);
    getDb().prepare("UPDATE auth_sessions SET expires_at = datetime('now', '-1 second') WHERE token = ?").run(token);

    expect(revalidateUserConnections()).toBe(1);
    expect(socket.closeCode).toBe(1008);
  });
});
