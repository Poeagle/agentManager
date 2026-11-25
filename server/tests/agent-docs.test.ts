import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, sessionCookieName } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { agentDocsRoutes } from '../src/routes/agent-docs.js';
import { agentRoutes } from '../src/routes/agent.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { agentDocsLaunch } from '../src/services/agent-docs.js';
import { getAgent } from '../src/services/agents/index.js';
import { linkConversationInputs } from '../src/services/conversation-input-links.js';
import * as manager from '../src/services/session-manager.js';
import { createTestDatabase } from './helpers/database.js';

const base = '/api/agent-docs';
const native = '019ff001-8888-7888-8888-888888888888';
let app: FastifyInstance;
let cleanup: () => void;
let owner: string;
let other: string;

function tab(id: string, actor: string, project = 'p', agent = 'claude') {
  getDb().prepare("INSERT INTO sessions(id,project_id,task,status,mode,cli_type,created_by_user_id,native_session_id) VALUES(?,?,?,'running','session',?,?,?)")
    .run(id, project, id, agent, actor, native);
}

function header(id: string) {
  const launch = agentDocsLaunch(manager.getSession(id)!);
  expect(launch?.instructions).toContain('agent-docs');
  const secret = launch!.environment.AGENT_MANAGER_COLLABORATION_SESSION;
  expect(launch!.instructions).not.toContain(secret);
  return { authorization: 'Bearer ' + secret };
}

beforeEach(async () => {
  const db = createTestDatabase();
  cleanup = db.cleanup;
  owner = createUser({ username: 'owner', display_name: 'Owner', password: 'isolated-password', role: 'admin' }).id;
  other = createUser({ username: 'other', password: 'isolated-password', role: 'admin' }).id;
  for (const [id, path] of [['p', db.dir], ['q', db.dir + '/other']]) {
    getDb().prepare('INSERT INTO projects(id,name,path,owner_id) VALUES(?,?,?,?)').run(id, id, path, owner);
  }
  tab('dev-one', owner);
  tab('dev-two', owner, 'p', 'codex');
  tab('test', owner);
  tab('different-owner', other);
  tab('different-project', owner, 'q');
  app = Fastify();
  await app.register(websocket);
  app.addHook('onRequest', authHook);
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(agentDocsRoutes, { prefix: '/api' });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  cleanup();
});

it('inherits the creator and restricts the credential to Agent Docs, the same project, and live tabs', async () => {
  const headers = header('dev-one');
  const endpoint = base + '/capabilities';
  expect((await app.inject(endpoint)).statusCode).toBe(401);
  const cookie = `${sessionCookieName()}=${createSession(owner)}`;
  expect((await app.inject({ url: endpoint, headers: { cookie } })).statusCode).toBe(401);
  const result = await app.inject({ url: endpoint, headers });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ user: { id: owner, display_name: 'Owner' }, project_id: 'p', source_tab_id: 'dev-one' });
  expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
  const tabs = await app.inject({ url: base + '/tabs', headers });
  expect(tabs.json().tabs.map((item: { tab_id: string }) => item.tab_id)).toEqual(['dev-one', 'dev-two', 'test']);
  for (const id of ['different-owner', 'different-project']) {
    expect((await app.inject({ url: base + '/tabs/' + id, headers })).statusCode).toBe(404);
  }
  getDb().prepare("UPDATE sessions SET status='cancelled' WHERE id='dev-one'").run();
  expect((await app.inject({ url: endpoint, headers })).statusCode).toBe(401);
});

it('queues several sources in receipt order, displays trusted metadata, and routes each reply to its original sender', async () => {
  const claude = vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue('queued');
  const codex = vi.spyOn(getAgent('codex').input, 'submit').mockResolvedValue(true);
  const post = async (id: string, data: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url: base + '/messages', headers: header(id), payload: data })).json();
  const list = async () => (await app.inject({ url: base + '/inbox', headers: header('test') })).json().messages;

  const first = { request_id: 'request-a', target_tab_ids: ['test', 'different-owner'], text: '验收功能 A' };
  const dispatch = await post('dev-one', first);
  expect(dispatch).toMatchObject({ request_id: 'request-a', state: 'settled', result: { results: [
    { tab_id: 'test', status: 'queued', message_id: expect.any(String) },
    { tab_id: 'different-owner', status: 'rejected' },
  ] } });
  expect(await post('dev-one', first)).toEqual(dispatch);
  await post('dev-two', { request_id: 'request-b', target_tab_ids: ['test'], text: '验收功能 B' });
  expect(claude).toHaveBeenCalledTimes(2);
  expect(claude.mock.calls.every(call => call[4]?.afterCurrentTurn && call[4].followUpLimit === 20)).toBe(true);
  const received = await list();
  expect(received).toMatchObject([{ source_tab_id: 'dev-one', preview: '验收功能 A' }, { source_tab_id: 'dev-two', preview: '验收功能 B' }]);
  const [a, b] = received.map((row: { message_id: string }) => row.message_id);
  expect((await app.inject({ url: base + '/inbox/' + b, headers: header('test') })).json()).toMatchObject({ message: { content: '验收功能 B', source_tab_id: 'dev-two' } });
  expect((await app.inject({ url: base + '/inbox/' + b, headers: header('dev-one') })).statusCode).toBe(404);
  const firstNative = claude.mock.calls[0][1];
  expect(firstNative).toContain(`source_tab_id=dev-one · message_id=${a}`);
  expect(linkConversationInputs('test', native, [{ id: 'native-echo', role: 'user', text: firstNative, timestamp: null, client_id: a }])).toMatchObject([
    { text: '验收功能 A', input_source: { kind: 'agent_handoff', label: 'dev-one' } },
  ]);

  expect(await post('dev-one', { request_id: 'wrong-recipient', reply_to: b, text: '偷换结果' }))
    .toMatchObject({ result: { status: 'rejected' } });
  const replyB = await post('test', { request_id: 'result-b', reply_to: b, text: 'B 通过', intent: 'result' });
  expect(replyB).toMatchObject({ result: { results: [{ tab_id: 'dev-two', status: 'submitted' }] } });
  expect(await list()).toMatchObject([{ result_replied: false }, { result_replied: true }]);
  expect(codex).toHaveBeenCalledTimes(1);
  expect(codex.mock.calls[0][1]).toContain(`reply_to=${b}`);
  expect(await post('test', { request_id: 'result-a', reply_to: a, text: 'A 发现问题' }))
    .toMatchObject({ result: { results: [{ tab_id: 'dev-one', status: 'queued' }] } });
  expect((await app.inject({ url: base + '/operations/request-a', headers: header('dev-one') })).json()).toEqual(dispatch);
});

it('creates a named tab as its creator and sends the first handoff only after launch', async () => {
  vi.spyOn(manager, 'spawnSession').mockImplementation(async id => {
    getDb().prepare("UPDATE sessions SET status='running',native_session_id=? WHERE id=?").run(native, id);
  });
  vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue(true);
  const headers = header('dev-one');
  const request = { request_id: 'create-one', name: 'DBM-1234 排查', execution: { agent_id: 'claude' }, initial_message: '排查并回传' };
  const response = await app.inject({ method: 'POST', url: base + '/tabs', headers, payload: request });
  expect(response.json()).toMatchObject({ result: { tab_id: expect.any(String), launch_status: 'ready', initial_message_status: 'submitted', initial_message_id: expect.any(String) } });
  const id = response.json().result.tab_id;
  expect(manager.getSession(id)).toMatchObject({ created_by_user_id: owner, project_id: 'p' });
  expect((await app.inject({ url: base + '/tabs', headers })).json().tabs).toContainEqual(expect.objectContaining({ tab_id: id, name: 'DBM-1234 排查' }));
  expect((await app.inject({ method: 'POST', url: base + '/tabs', headers, payload: request })).json()).toEqual(response.json());
  expect(manager.spawnSession).toHaveBeenCalledTimes(1);
});
