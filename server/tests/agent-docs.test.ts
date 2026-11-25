import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser, sessionCookieName, setProjectToolAccess } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { agentDocsRoutes } from '../src/routes/agent-docs.js';
import { agentRoutes } from '../src/routes/agent.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { skillsRoutes } from '../src/routes/skills.js';
import { agentDocsLaunch } from '../src/services/agent-docs.js';
import { ensureClaudeRuntime, releaseClaudeRuntime } from '../src/services/agents/claude/sdk-runtime.js';
import { createClaudeProvider } from '../src/services/agents/claude/providers.js';
import * as codexControls from '../src/services/agents/codex/controls.js';
import { getAgent } from '../src/services/agents/index.js';
import { linkConversationInputs } from '../src/services/conversation-input-links.js';
import * as manager from '../src/services/session-manager.js';
import { setRoleGrants, setUserRoles } from '../src/services/rbac.js';
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
  app = await testApp();
});

async function testApp() {
  const app = Fastify();
  await app.register(websocket);
  app.addHook('onRequest', authHook);
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(agentDocsRoutes, { prefix: '/api' });
  await app.register(skillsRoutes, { prefix: '/api' });
  return app.ready();
}

afterEach(async () => {
  await app.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

it('serves a task-writing example from the dispatch link in the built-in skill', async () => {
  const cookie = `${sessionCookieName()}=${createSession(owner)}`;
  const endpoint = '/api/integrations/agent-docs';
  const entry = await app.inject({ url: endpoint, query: { file: 'SKILL.md' }, headers: { cookie } });
  expect(entry.statusCode).toBe(200);
  const reference = entry.json().content.match(/\]\((references\/collaboration\.md)#([^)]+)\)/);
  expect(reference).not.toBeNull();
  const [, file, heading] = reference!;
  const playbook = await app.inject({ url: endpoint, query: { file }, headers: { cookie } });
  expect(playbook.statusCode).toBe(200);
  const sections = (playbook.json().content as string).split(/^## /m);
  const guidance = sections.find(section => section.startsWith(heading + '\n'));
  expect(guidance).toBeDefined();
  expect(guidance).toMatch(/^> .+/m);
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

it('lists only the caller’s direct children and bounds in-place settings to those children', async () => {
  getDb().prepare("UPDATE sessions SET parent_session_id='dev-one' WHERE id IN ('test','different-owner','different-project')").run();
  const headers = header('dev-one');
  const children = (await app.inject({ url: base + '/tabs?children=true', headers })).json();
  expect(children.tabs).toMatchObject([{ tab_id: 'test', parent_tab_id: 'dev-one' }]);
  expect(children.tabs).toHaveLength(1);
  const update = (id: string, payload: object, auth = headers) =>
    app.inject({ method: 'POST', url: base + '/tabs/' + id + '/controls', headers: auth, payload });
  const controls = vi.spyOn(getAgent('claude').controls, 'apply');
  for (const id of ['dev-one', 'dev-two', 'different-owner', 'different-project']) {
    expect((await update(id, { request_id: id, execution: { model_id: 'haiku' } })).json())
      .toMatchObject({ result: { status: 'rejected' } });
  }
  const read = await app.inject({ url: base + '/tabs/test/controls', headers });
  expect(read.json()).toMatchObject({
    supported: { model: true, reasoning_effort: false, service_tier: false },
    models: expect.arrayContaining([{ model_id: 'haiku', reasoning_efforts: [], default_reasoning_effort: null, service_tiers: [] }]),
  });
  expect((await update('test', { request_id: 'unsupported', execution: { service_tier: 'priority' } })).json())
    .toMatchObject({ result: { status: 'unsupported' } });
  expect((await update('test', { request_id: 'provider-switch', execution: { model_id: 'haiku', environment_id: 'other' } })).statusCode).toBe(400);
  expect(controls).not.toHaveBeenCalled();
});

it('changes the Claude child model using its existing native session', async () => {
  const fixture = manager.getSession('test')!;
  getDb().prepare("UPDATE sessions SET parent_session_id='dev-one' WHERE id='test'").run();
  const project = getDb().prepare('SELECT path FROM projects WHERE id=?').get(fixture.project_id) as {path: string};
  const runtime = ensureClaudeRuntime(native, project.path, undefined, {model:'opus',effort:''});
  try {
    const headers = header('dev-one'), url = base + '/tabs/test/controls';
    const update = await app.inject({method:'POST',url,headers,payload:{request_id:'claude-model',execution:{model_id:'haiku'}}});
    expect(update.json()).toMatchObject({result:{tab_id:'test',status:'applied',execution:{
      model_id:'haiku',reasoning_effort:null,service_tier:null,
    }}});
    expect((await app.inject({url,headers})).json()).toMatchObject({loaded:true,execution:{model_id:'haiku'}});
    expect(runtime.selectedModel()).toBe('haiku');
    expect(manager.getSession('test')).toMatchObject({native_session_id:native,status:'running'});
  } finally { releaseClaudeRuntime(native); }
});

it('requires collaboration write permission to edit an owned child', async () => {
  getDb().prepare("UPDATE sessions SET parent_session_id='dev-one' WHERE id='test'").run();
  setProjectToolAccess({projectId:'p',userId:owner,canSession:true,canTerminal:false,sessionClients:['claude'],grantedBy:owner});
  getDb().prepare("UPDATE users SET role='member' WHERE id=?").run(owner);
  getDb().prepare("INSERT INTO rbac_roles(id,name) VALUES ('docs-reader','Docs reader')").run();
  setRoleGrants('docs-reader', { agent_api: 'read' });
  setUserRoles(owner, ['docs-reader']);
  const headers = header('dev-one');
  const capabilities = (await app.inject({url:base + '/capabilities',headers})).json();
  expect(capabilities.operations).toContain('tab-controls');
  expect(capabilities.operations).not.toContain('update-tab-controls');
  const url = base + '/tabs/test/controls';
  expect((await app.inject({url,headers})).json()).toMatchObject({can_update:false});
  expect((await app.inject({method:'POST',url,headers,payload:{request_id:'read-only',execution:{model_id:'haiku'}}})).statusCode).toBe(403);
});

it.each([['test','claude'],['dev-two','codex']])('queues an explicit follow-up to %s with its source intact', async (target, agent) => {
  const submit = vi.spyOn(getAgent(agent).input, 'submit').mockResolvedValue('queued');
  const headers = header('dev-one');
  const payload = { request_id:'queue-task', target_tab_ids:[target], after_current_turn:true, intent:'task', text:'下一轮复验' };
  const request = () => app.inject({method:'POST',url:base + '/messages',headers,payload});
  const response = await request();
  const receipt = response.json().result.results[0];
  expect(receipt).toMatchObject({tab_id:target,status:'queued',message_id:expect.any(String)});
  expect((await request()).json()).toEqual(response.json());
  expect(submit.mock.calls).toHaveLength(1);
  expect(submit.mock.calls[0][4]).toEqual({afterCurrentTurn:true});
  expect((await app.inject({url:base + '/inbox/' + receipt.message_id,headers:header(target)})).json())
    .toMatchObject({message:{source_tab_id:'dev-one',content:'下一轮复验'}});
  expect((await app.inject({method:'POST',url:base + '/messages',headers:header(target),
    payload:{request_id:'bad-reply',reply_to:receipt.message_id,after_current_turn:true,text:'不排队回传'}})).statusCode).toBe(400);
});

it('delivers several sources immediately in receipt order and routes each reply to its original sender', async () => {
  const claude = vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue(true);
  const codex = vi.spyOn(getAgent('codex').input, 'submit').mockResolvedValue(true);
  const post = async (id: string, data: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url: base + '/messages', headers: header(id), payload: data })).json();
  const list = async () => (await app.inject({ url: base + '/inbox', headers: header('test') })).json().messages;

  const first = { request_id: 'request-a', target_tab_ids: ['test', 'different-owner'], text: '验收功能 A' };
  const dispatch = await post('dev-one', first);
  expect(dispatch).toMatchObject({ request_id: 'request-a', state: 'settled', result: { results: [
    { tab_id: 'test', status: 'submitted', message_id: expect.any(String) },
    { tab_id: 'different-owner', status: 'rejected' },
  ] } });
  expect(await post('dev-one', first)).toEqual(dispatch);
  await post('dev-two', { request_id: 'request-b', target_tab_ids: ['test'], text: '验收功能 B' });
  expect(claude).toHaveBeenCalledTimes(2);
  expect(claude.mock.calls.every(call => call[4]?.immediate && !call[4].afterCurrentTurn)).toBe(true);
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
  expect(codex.mock.calls[0][4]).toEqual({ immediate: true });
  expect(codex.mock.calls[0][1]).toContain(`reply_to=${b}`);
  expect(await post('test', { request_id: 'result-a', reply_to: a, text: 'A 发现问题' }))
    .toMatchObject({ result: { results: [{ tab_id: 'dev-one', status: 'submitted' }] } });
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
  expect(manager.getSession(id)).toMatchObject({ created_by_user_id: owner, project_id: 'p', parent_session_id: 'dev-one' });
  expect((await app.inject({ url: base + '/tabs', headers })).json().tabs).toContainEqual(expect.objectContaining({ tab_id: id, name: 'DBM-1234 排查', parent_tab_id: 'dev-one' }));
  expect((await app.inject({ method: 'POST', url: base + '/tabs', headers, payload: request })).json()).toEqual(response.json());
  expect(manager.spawnSession).toHaveBeenCalledTimes(1);
});

it.each([['dev-one', 'claude'], ['dev-two', 'codex']])('wakes %s once when its dispatch is sealed and every task has a result', async (parent, parentAgent) => {
  const submit = vi.spyOn(getAgent(parentAgent).input, 'submit').mockResolvedValue(true);
  vi.spyOn(getAgent(parentAgent === 'claude' ? 'codex' : 'claude').input, 'submit').mockResolvedValue(true);
  const child = 'test';
  const post = async (tabId: string, path: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: base + path, headers: header(tabId), payload });
  const opened = await post(parent, '/batches', { request_id: 'open' });
  expect(opened.statusCode).toBe(200);
  const batchId = opened.json().result.batch_id;
  expect((await post(parent, '/batches', { request_id: 'open' })).json()).toEqual(opened.json());
  expect((await app.inject({ url: base + '/batches/' + batchId, headers: header(child) })).statusCode).toBe(404);
  expect((await post(child, '/batches/' + batchId + '/seal', { request_id: 'foreign-seal' })).statusCode).toBe(404);
  expect((await post(child, '/messages', {
    request_id: 'foreign-assign', target_tab_ids: [parent], batch_id: batchId, intent: 'task', text: 'foreign',
  })).statusCode).toBe(409);
  const assign = async (request_id: string) => (await post(parent, '/messages', {
    request_id, target_tab_ids: [child], batch_id: batchId, intent: 'task', text: request_id,
  })).json().result.results[0].message_id;
  const first = await assign('first');
  const second = await assign('second');
  submit.mockClear();
  const reply = (request_id: string, reply_to: string, intent: string) =>
    post(child, '/messages', { request_id, reply_to, intent, text: request_id });

  const progress = await reply('progress', first, 'progress');
  const result = await reply('result-first', first, 'result');
  const { message_id } = result.json().result.results[0];
  expect(progress.json().result.results[0].status).toBe('stored');
  expect(result.json().result.results[0].status).toBe('stored');
  expect((await app.inject({ url: base + '/inbox/' + message_id, headers: header(parent) })).json()).toMatchObject({
    message: { content: 'result-first', reply_to: first, source_tab_id: child, batch_id: batchId },
  });
  expect(submit).toHaveBeenCalledTimes(0);

  await reply('blocker', second, 'blocker');
  expect(submit).toHaveBeenCalledTimes(1);
  await reply('result-second', second, 'result');
  expect(submit).toHaveBeenCalledTimes(1);
  const seal = { request_id: 'seal' };
  expect((await post(parent, '/batches/' + batchId + '/seal', seal)).statusCode).toBe(200);
  expect((await post(parent, '/batches/' + batchId + '/seal', seal)).statusCode).toBe(200);
  expect((await post(parent, '/messages', {
    request_id: 'too-late', target_tab_ids: [child], batch_id: batchId, intent: 'task', text: 'later',
  })).statusCode).toBe(409);
  await reply('result-repeat', second, 'result');
  expect(submit).toHaveBeenCalledTimes(2);
  const wake = submit.mock.calls[1][1];
  expect(wake).toContain(batchId);
  expect(wake).toContain('已回传来源：test');
  expect(linkConversationInputs(parent, native, [{ id: 'batch-echo', role: 'user', text: wake, timestamp: null, client_id: batchId }]))
    .toMatchObject([{ text: wake, input_source: { kind: 'agent_handoff', label: '协作结果' } }]);
  expect((await app.inject({ url: base + '/batches/' + batchId, headers: header(parent) })).json()).toMatchObject({
    batch_id: batchId, wake_reason: 'complete', wake_status: 'submitted',
    tasks: [{ message_id: first, state: 'result' }, { message_id: second, state: 'result' }],
  });
});

it('wakes on the deadline after restart, keeps late results in the inbox, and leaves child tabs open', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue(true);
  const submit = vi.spyOn(getAgent('codex').input, 'submit').mockResolvedValue(true);
  vi.spyOn(manager, 'spawnSession').mockImplementation(async id => {
    getDb().prepare("UPDATE sessions SET status='running',native_session_id=? WHERE id=?").run(native, id);
  });
  const parent = 'dev-two';
  const post = async (tabId: string, path: string, payload: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url: base + path, headers: header(tabId), payload })).json();
  const { result: { batch_id: batchId } } = await post(parent, '/batches', { request_id: 'open', timeout_seconds: 10 });
  const { result: created } = await post(parent, '/tabs', { request_id: 'new', batch_id: batchId, name: 'A', initial_message: 'First' });
  expect(created).toMatchObject({ launch_status: 'ready', initial_message_status: 'submitted' });
  await post(parent, '/messages', {
    request_id: 'assign', target_tab_ids: ['test', 'different-owner'], batch_id: batchId, intent: 'task', text: 'Second',
  });
  await post(parent, '/batches/' + batchId + '/seal', { request_id: 'seal' });
  submit.mockClear();
  await app.close();
  app = await testApp();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  const view = async () => (await app.inject({ url: base + '/batches/' + batchId, headers: header(parent) })).json();
  await expect.poll(async () => (await view()).wake_status).toBe('submitted');
  expect(await view()).toMatchObject({ wake_reason: 'deadline', wake_status: 'submitted', tasks: [
    { state: 'pending', tab_id: created.tab_id }, { state: 'pending', tab_id: 'test' }, { state: 'unavailable' },
  ] });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][1]).toContain('待回传 2 项，未能投递 1 项');
  await post(created.tab_id, '/messages', {
    request_id: 'late-result', reply_to: created.initial_message_id, intent: 'result', text: '迟到的结果',
  });
  expect((await view()).tasks[0]).toMatchObject({ state: 'result', source_tab_id: created.tab_id });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(manager.getSession(created.tab_id)).toMatchObject({ status: 'running', parent_session_id: parent });
});

it('keeps the results when the parent changes its native conversation before the batch completes', async () => {
  const submit = vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue(true);
  const post = async (tabId: string, path: string, payload: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url: base + path, headers: header(tabId), payload })).json();
  const { result: { batch_id: batchId } } = await post('dev-one', '/batches', { request_id: 'open' });
  const { result: { results: [{ message_id: taskId }] } } = await post('dev-one', '/messages', {
    request_id: 'assign', target_tab_ids: ['test'], batch_id: batchId, intent: 'task', text: 'First',
  });
  await post('dev-one', '/batches/' + batchId + '/seal', { request_id: 'seal' });
  getDb().prepare("UPDATE sessions SET native_session_id='changed-native' WHERE id='dev-one'").run();
  submit.mockClear();
  const result = await post('test', '/messages', { request_id: 'result', reply_to: taskId, intent: 'result', text: 'Result' });
  expect(result.result.results[0]).toMatchObject({ status: 'stored' });
  expect(submit).toHaveBeenCalledTimes(0);
  expect((await app.inject({ url: base + '/batches/' + batchId, headers: header('dev-one') })).json()).toMatchObject({
    wake_reason: 'complete', wake_status: 'rejected', tasks: [{ state: 'result' }],
  });
});

it('does not retry a batch wake with an uncertain native receipt', async () => {
  const submit = vi.spyOn(getAgent('claude').input, 'submit').mockResolvedValue(true);
  const post = async (tabId: string, path: string, payload: Record<string, unknown>) =>
    (await app.inject({ method: 'POST', url: base + path, headers: header(tabId), payload })).json();
  const { result: { batch_id: batchId } } = await post('dev-one', '/batches', { request_id: 'open' });
  const assign = (request_id: string) => post('dev-one', '/messages', {
    request_id, target_tab_ids: ['test'], batch_id: batchId, intent: 'task', text: request_id,
  });
  const [a, b] = await Promise.all([assign('A'), assign('B')]);
  await post('dev-one', '/batches/' + batchId + '/seal', { request_id: 'seal' });
  submit.mockClear();
  submit.mockRejectedValue(new Error('mock transport closed'));
  const report = (request_id: string, assignment: typeof a) => post('test', '/messages', {
    request_id, reply_to: assignment.result.results[0].message_id, intent: 'result', text: request_id,
  });
  await Promise.all([report('reply-a', a), report('reply-b', b)]);
  expect(submit).toHaveBeenCalledTimes(1);
  await app.close();
  app = await testApp();
  await report('reply-b', b);
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await app.inject({ url: base + '/batches/' + batchId, headers: header('dev-one') })).json()).toMatchObject({
    wake_reason: 'complete', wake_status: 'unknown', tasks: [{ state: 'result' }, { state: 'result' }],
  });
});

it.each([
  { agent: 'codex', source: 'dev-two', environment: 'account:parent', otherEnvironment: 'account:other' },
  { agent: 'claude', source: 'dev-one', environment: 'claude-provider:parent', otherEnvironment: 'claude-provider:other' },
])('inherits and restricts the source $agent Provider', async ({ agent, source, environment, otherEnvironment }) => {
  for (const id of ['parent', 'other']) {
    if (agent === 'claude') {
      createClaudeProvider({
        id, name: id, apiKey: 'test-key',
        fields: { baseUrl: 'https://example.invalid', models: [id + '-model'] },
      });
    } else {
      getDb().prepare(`INSERT INTO agent_environments(id,agent_id,name,kind,enabled,config,allowed_user_ids)
        VALUES(?,'codex',?,'account',1,?,'[]')`)
        .run('account:' + id, id, JSON.stringify({ username: id, port: 22, identityFile: '', codexCommand: 'codex', codexHome: '' }));
    }
  }
  getDb().prepare('UPDATE sessions SET agent_environment_id=? WHERE id=?').run(environment, source);
  const readModels = vi.spyOn(codexControls, 'readEngineModelsForEnvironment').mockResolvedValue([]);
  const spawn = vi.spyOn(manager, 'spawnSession').mockImplementation(async id => {
    getDb().prepare("UPDATE sessions SET status='running',native_session_id=? WHERE id=?").run(native, id);
  });
  const headers = header(source);
  const post = async (requestId: string, execution?: object, sourceHeaders = headers) => (
    await app.inject({
      method: 'POST', url: base + '/tabs', headers: sourceHeaders,
      payload: { request_id: requestId, name: requestId, ...(execution && { execution }) },
    })
  ).json();

  const initialCount = getDb().prepare('SELECT count(*) AS count FROM sessions').get();
  expect(await post('other-provider', { agent_id: agent, environment_id: otherEnvironment }))
    .toMatchObject({ state: 'settled', result: { launch_status: 'rejected' } });
  expect(await post('other-agent', { agent_id: agent === 'codex' ? 'claude' : 'codex' }))
    .toMatchObject({ state: 'settled', result: { launch_status: 'rejected' } });
  expect(spawn).not.toHaveBeenCalled();
  expect(getDb().prepare('SELECT count(*) AS count FROM sessions').get()).toEqual(initialCount);

  const options = (await app.inject({ url: base + '/execution-options', headers })).json();
  expect(options).toMatchObject({
    source_execution: { agent_id: agent, environment_id: environment },
    environments: [{ agent_id: agent, environment_id: environment }],
  });
  expect(readModels.mock.calls.map(([id]) => id)).toEqual(agent === 'codex' ? [environment] : []);

  const child = await post('inherit-provider');
  expect(child).toMatchObject({ result: { launch_status: 'ready', applied_execution: { agent_id: agent, environment_id: environment } } });
  expect(manager.getSession(child.result.tab_id)).toMatchObject({ parent_session_id: source, agent_environment_id: environment });
  expect(await post('inherit-provider')).toEqual(child);

  const grandchild = await post('same-provider', { agent_id: agent, environment_id: environment }, header(child.result.tab_id));
  expect(grandchild).toMatchObject({ result: { launch_status: 'ready', applied_execution: { agent_id: agent, environment_id: environment } } });
  expect(manager.getSession(grandchild.result.tab_id)).toMatchObject({ parent_session_id: child.result.tab_id, agent_environment_id: environment });
});

it('closes only accessible tabs in the same project and reuses the receipt without restarting cleanup', async () => {
  const headers = header('dev-one');
  const post = (id: string, requestId: string, deleteHistory = false) => app.inject({
    method: 'POST', url: base + '/tabs/' + id + '/delete', headers,
    payload: { request_id: requestId, delete_history: deleteHistory },
  });
  expect((await app.inject({ url: base + '/capabilities', headers })).json().operations).toContain('delete-tab');
  for (const id of ['different-owner', 'different-project', 'dev-one']) {
    expect((await post(id, id)).json()).toMatchObject({ result: { status: 'rejected' } });
    expect(manager.getSession(id)?.status).toBe('running');
  }
  getDb().prepare("UPDATE sessions SET parent_session_id='test' WHERE id='dev-two'").run();
  const kill = vi.spyOn(manager, 'killSession').mockImplementation(async id => {
    getDb().prepare("UPDATE sessions SET status='cancelled' WHERE id=?").run(id);
    return true;
  });
  const response = await post('test', 'close-test');
  expect(response.json()).toMatchObject({ state: 'settled', result: { tab_id: 'test', status: 'closed', history_status: 'retained' } });
  expect((await post('test', 'close-test')).json()).toEqual(response.json());
  expect(kill).toHaveBeenCalledTimes(1);
  expect((await post('dev-two', 'close-test')).statusCode).toBe(409);
  expect(manager.getSession('dev-two')).toMatchObject({ status: 'running', parent_session_id: 'test' });
  const stored = getDb().prepare("SELECT value FROM user_ui_state WHERE user_id=? AND key='project:p'").get(owner) as {value: string};
  expect(JSON.parse(stored.value).hiddenSessionIds).toContain('test');
  expect(manager.getSession('test')).toMatchObject({ status: 'cancelled', native_session_id: native });
  expect((await app.inject({ url: base + '/tabs', headers })).json().tabs).not.toContainEqual(expect.objectContaining({ tab_id: 'test' }));
  expect((await app.inject({ url: base + '/tabs?include_ended=true', headers })).json().tabs)
    .toContainEqual(expect.objectContaining({ tab_id: 'test', can_receive: false, can_delete: true }));
});

it('uses background deletion for explicit history removal and exposes its outcome by request ID', async () => {
  const headers = header('dev-one');
  vi.spyOn(manager, 'killSession').mockImplementation(async id => {
    getDb().prepare("UPDATE sessions SET status='cancelled' WHERE id=?").run(id);
    return true;
  });
  const purge = vi.spyOn(manager, 'purgeSessionRecord').mockResolvedValue({ ok: false, error: 'isolated failure' });
  const create = await app.inject({
    method: 'POST', url: base + '/tabs/test/delete', headers,
    payload: { request_id: 'purge-test', delete_history: true },
  });
  expect(create.json()).toMatchObject({ result: { tab_id: 'test', status: 'closed', history_status: 'pending' } });
  await vi.waitFor(() => expect(purge).toHaveBeenCalledWith('test', { background: true }));
  const operation = () => app.inject({ url: base + '/operations/purge-test', headers });
  expect((await operation()).json()).toMatchObject({ result: { history_status: 'failed' } });
});

it('recovers persisted creation receipts only within the original user and project', async () => {
  const addReceipt = getDb().prepare("INSERT INTO agent_docs_operations(tab_id,request_id,fingerprint,state,result) VALUES(?,?,?,'settled',?)");
  for (const [parent, child] of [['dev-one', 'test'], ['dev-one', 'different-project'], ['dev-one', 'different-owner']]) {
    addReceipt.run(parent, child, child, JSON.stringify({ tab_id: child, launch_status: 'ready' }));
  }
  await app.close();
  app = await testApp();
  expect(manager.getSession('test')?.parent_session_id).toBe('dev-one');
  expect(manager.getSession('different-project')?.parent_session_id).toBeNull();
  expect(manager.getSession('different-owner')?.parent_session_id).toBeNull();
});
