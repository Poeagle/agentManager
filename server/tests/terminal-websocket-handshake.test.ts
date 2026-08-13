import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({
  active: false,
  pending: null as any,
  lifecycleListener: null as ((ready: boolean) => void) | null,
  attachTerminal: vi.fn(() => true),
  writeToSession: vi.fn(() => true),
  resizeSession: vi.fn(() => true),
  reconnectSession: vi.fn(async () => false),
  getPendingSpawn: vi.fn(() => manager.pending),
  consumePendingSpawn: vi.fn(() => {
    const pending = manager.pending;
    manager.pending = null;
    return pending;
  }),
  spawnSession: vi.fn(async () => {}),
  spawnTerminal: vi.fn(async () => {}),
  spawnAdopt: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
  sendReplay: vi.fn(),
  recoverSessionOnAttach: vi.fn(async () => false),
  getSession: vi.fn(() => ({ id: 'session-1', mode: 'terminal', cli_type: 'claude' })),
  isSessionActive: vi.fn(() => manager.active),
  isValidTerminalDimensions: vi.fn((cols: unknown, rows: unknown) => (
    Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= 2 && Number(rows) >= 1
  )),
  subscribeSessionLifecycle: vi.fn((_sessionId: string, listener: (ready: boolean) => void) => {
    manager.lifecycleListener = listener;
    return () => { if (manager.lifecycleListener === listener) manager.lifecycleListener = null; };
  }),
  waitForSessionLifecycle: vi.fn(async () => manager.active),
}));

vi.mock('../src/services/session-manager.js', () => manager);
vi.mock('../src/auth.js', () => ({
  readSessionCookie: vi.fn(() => 'token'),
  userCanUseSessionTool: vi.fn(() => true),
}));
vi.mock('../src/services/user-connections.js', () => ({
  registerUserConnection: vi.fn(() => () => {}),
}));

import { terminalRoutes } from '../src/routes/terminal.js';

interface SocketHarness {
  socket: WebSocket;
  next(type: string): Promise<any>;
}

function connect(url: string): Promise<SocketHarness> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages: any[] = [];
    const waiters = new Map<string, Array<(value: any) => void>>();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = waiters.get(message.type)?.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    });
    socket.once('error', reject);
    socket.once('open', () => resolve({
      socket,
      next(type: string) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolveMessage) => {
          const queue = waiters.get(type) || [];
          queue.push(resolveMessage);
          waiters.set(type, queue);
        });
      },
    }));
  });
}

describe('terminal websocket handshake', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager.active = false;
    manager.pending = null;
    manager.lifecycleListener = null;
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      (request as any).user = { id: 'user-1' };
    });
    await app.register(fastifyWebsocket);
    await app.register(terminalRoutes);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('acks both sockets only after business-ready and then flushes queued input in order', async () => {
    manager.pending = { mode: 'terminal', projectPath: '/project', task: 'Terminal' };
    let finishSpawn!: () => void;
    const spawn = new Promise<void>((resolve) => {
      finishSpawn = () => {
        manager.active = true;
        resolve();
      };
    });
    manager.spawnTerminal.mockImplementationOnce(() => spawn);
    manager.reconnectSession.mockImplementationOnce(async () => {
      await spawn;
      return true;
    });

    const client = await connect(`${baseUrl}/terminal/session-1`);
    await client.next('connected');
    client.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    client.socket.send(JSON.stringify({ type: 'input', data: 'first' }));
    client.socket.send(JSON.stringify({ type: 'input', data: 'second', paste: true }));
    await vi.waitFor(() => expect(manager.spawnTerminal).toHaveBeenCalledTimes(1));

    // A second socket arrives after the pending record was consumed but while
    // the first worker is still starting. Map presence must not imply ready.
    const second = await connect(`${baseUrl}/terminal/session-1`);
    await second.next('connected');
    second.socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    second.socket.send(JSON.stringify({ type: 'input', data: 'third' }));
    await vi.waitFor(() => expect(manager.reconnectSession).toHaveBeenCalledTimes(1));
    expect(manager.writeToSession).not.toHaveBeenCalled();
    expect(manager.attachTerminal).not.toHaveBeenCalled();

    finishSpawn();
    expect(await client.next('ready')).toMatchObject({ type: 'ready', sessionId: 'session-1' });
    expect(await second.next('ready')).toMatchObject({ type: 'ready', sessionId: 'session-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.writeToSession.mock.calls).toEqual([
      ['session-1', 'first', false],
      ['session-1', 'second', true],
      ['session-1', 'third', false],
    ]);
    expect(manager.attachTerminal).toHaveBeenCalledWith('session-1', expect.anything(), { skipReplay: true });
    expect(manager.sendReplay).toHaveBeenCalledWith('session-1', expect.anything(), true, 'history');

    manager.sendReplay.mockClear();
    client.socket.send(JSON.stringify({ type: 'refresh' }));
    await vi.waitFor(() => expect(manager.sendReplay).toHaveBeenCalledWith(
      'session-1', expect.anything(), true, 'screen',
    ));
    manager.sendReplay.mockClear();
    client.socket.send(JSON.stringify({ type: 'refresh', history: true }));
    await vi.waitFor(() => expect(manager.sendReplay).toHaveBeenCalledWith(
      'session-1', expect.anything(), true, 'history',
    ));
    client.socket.close();
    second.socket.close();
  });

  it('attaches a passive pending socket after lifecycle completion and ignores a closed stale socket', async () => {
    manager.pending = { mode: 'terminal', projectPath: '/project', task: 'Terminal' };
    const client = await connect(`${baseUrl}/terminal/session-1?passive=1`);
    await client.next('connected');
    expect(manager.attachTerminal).not.toHaveBeenCalled();

    manager.active = true;
    manager.lifecycleListener?.(true);
    expect(await client.next('ready')).toMatchObject({ type: 'ready', passive: true });
    expect(manager.attachTerminal).toHaveBeenCalledTimes(1);
    expect(manager.attachTerminal).toHaveBeenCalledWith('session-1', expect.anything(), { skipReplay: true });
    expect(manager.sendReplay).toHaveBeenCalledWith('session-1', expect.anything(), true, 'screen');
    client.socket.close();

    await new Promise((resolve) => client.socket.once('close', resolve));
    manager.attachTerminal.mockClear();
    manager.active = false;
    manager.pending = { mode: 'terminal', projectPath: '/project', task: 'Terminal' };
    const stale = await connect(`${baseUrl}/terminal/session-1?passive=1`);
    await stale.next('connected');
    const listener = manager.lifecycleListener;
    stale.socket.close();
    await new Promise((resolve) => stale.socket.once('close', resolve));
    manager.active = true;
    listener?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.attachTerminal).not.toHaveBeenCalled();
  });
});
