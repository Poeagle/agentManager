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
