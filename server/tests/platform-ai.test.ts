import { installPlatformApiRegistry } from '../src/services/platform-ai/api-registry.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { createCipheriv, createHash, createPrivateKey, randomBytes, sign } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession as createAuthSession, createUser, setProjectToolAccess, userCanUseSessionTool } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { platformAiRoutes } from '../src/routes/platform-ai.js';
import { projectRoutes } from '../src/routes/projects.js';
import { sessionRoutes } from '../src/routes/sessions.js';
import { scheduledTaskRoutes } from '../src/routes/scheduled-tasks.js';
import * as manager from '../src/services/session-manager.js';
import { readAiConfig, updateAiConfig } from '../src/services/platform-ai/config.js';
import { decodeCallback, decryptWechatMessage, getChannel, hmacSignature, saveChannel, xmlText } from '../src/services/platform-ai/channels.js';
import { claimMessage, enqueueNotice, getConversation, receiveMessage, trackTask, type InboxMessage } from '../src/services/platform-ai/store.js';
import { newObservationText, PlatformAiWorker, validateAssessment } from '../src/services/platform-ai/worker.js';
import { captureScheduledBaseline, reconcileScheduledObservations } from '../src/services/platform-ai/scheduled-observation.js';
import { createTestDatabase } from './helpers/database.js';
import * as agents from '../src/services/platform-ai/agents.js';
import { broadcastEphemeral } from '../src/services/event-store.js';
import { executePlatformTool } from '../src/services/platform-ai/tools.js';

const providerResponse = (message: Record<string, unknown>) => new Response(JSON.stringify({choices: [{message}]}), {status: 200});
const toolResponse = (name: string, args: unknown, id = 'call-1') => providerResponse({content: null, tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
let app: FastifyInstance;
let cleanup: () => void;
let worker: PlatformAiWorker;
let admin: string;
let member: string;
let other: string;
let adminCookie: string;
let cookie: string;
let databaseDir: string;
let nativeTurns: Array<{user: string; assistant: string}>;
let nativeMessages: Array<{role: string; phase: string; text: string; timestamp: string; task_reference?:string}>;
let display: {cursor: number | null; output: string; processState: string; promptType: string | null; cursorReset?: boolean};
let displayRequests: string[];
let executeRequests: Array<{input: string}>;

beforeEach(async () => {
  vi.spyOn(agents, 'detectWorkAgent').mockImplementation(async cli => ({cli_type: cli, label: cli, status:'available',reason:'Test fixture'}));
  vi.spyOn(agents, 'detectWorkAgents').mockResolvedValue([{cli_type:'codex',label:'Codex',status:'available',reason:'Test fixture'},{cli_type:'claude',label:'Claude',status:'unavailable',reason:'Test fixture'}]);
  const database = createTestDatabase();
  cleanup = database.cleanup; databaseDir = database.dir;
  admin = createUser({username: 'admin', password: 'password1', role: 'admin'}).id;
  member = createUser({username: 'member', password: 'password1'}).id;
  other = createUser({username: 'other', password: 'password1'}).id;
  adminCookie = `agentmanager_session=${createAuthSession(admin)}`;
  cookie = `agentmanager_session=${createAuthSession(member)}`;
  getDb().prepare("INSERT INTO projects (id,name,path,owner_id) VALUES ('p','Project',?,?)").run(databaseDir, member);
  setProjectToolAccess({projectId: 'p', userId: member, canSession: true, canTerminal: true, sessionClients: ['codex','claude'], grantedBy: admin});
  app = Fastify();
  installPlatformApiRegistry(app);
  app.addHook('onRequest', authHook);
  await app.register(projectRoutes, {prefix: '/api'});
  await app.register(sessionRoutes, {prefix: '/api'});
  await app.register(scheduledTaskRoutes, {prefix: '/api'});
  await app.register(platformAiRoutes, {prefix: '/api', runWorker: false});
  display = {cursor: 0, output: '', processState: 'idle', promptType: null};
  nativeTurns = [];
  nativeMessages = [];
  displayRequests = [];
  executeRequests = [];
  app.get('/api/sessions/:id/completed-turn', async () => ({turns: nativeTurns}));
  app.get('/api/sessions/:id/agent-messages', async () => ({messages:nativeMessages,available:nativeMessages.length>0}));
  app.get<{Params: {id: string}}>('/api/sessions/:id/display', async (req, reply) => {
    displayRequests.push(req.url);
    if (!userCanUseSessionTool(req.user!.id, req.params.id, 'codex', 'session')) return reply.code(404).send({error: 'Session not found'});
    return {...display};
  });
  app.post<{Body: {input: string}}>('/api/sessions/:id/execute', async req => {executeRequests.push(req.body);return {status:'completed'};});
  worker = new PlatformAiWorker(app);
  await app.ready();
});
afterEach(async () => {
  await worker.stop();
  await app.close();
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  cleanup();
});

function configure() {
  updateAiConfig({enabled: true, endpoint: 'https://model.example/v1', model: 'test-model', api_key: 'model-secret-never-expose'});
}
function inbound(content = '列出项目', messageId = 'message-1', userId = member, chatId = 'web-test') {
  return receiveMessage({userId, externalUserId: userId, chatId, messageId, content});
}
function seedSession(id = 'session-1') {
  getDb().prepare("INSERT INTO sessions (id,project_id,task,status,mode,cli_type,created_by_user_id) VALUES (?,'p','Work','running','session','codex',?)").run(id, member);
}

describe('platform AI configuration and access boundaries', () => {
  it('lists dashboard tab names and reads terminal work even with no tracked task', async () => {
    configure(); seedSession('design-tab');
    getDb().prepare("UPDATE sessions SET mode='terminal',task='Terminal',started_at='2026-10-21 10:00:00',updated_at='2026-10-21 10:00:00',created_at='2026-10-21 09:00:00' WHERE id='design-tab'").run();
    getDb().prepare('INSERT INTO user_ui_state (user_id,key,value) VALUES (?,?,?)').run(member, 'project:p', JSON.stringify({terminalInstances: [{id:'design-tab',label:'Terminal 1',customLabel:'设计'}], terminalLabels: {'design-tab':'旧名称'}}));
    const received = inbound('Project 项目正在跑什么？'); const conversation = getConversation(received.conversation_id)!;
    nativeMessages = [{role:'assistant',phase:'commentary',text:'正在修改分区匹配逻辑',timestamp:'2026-10-21T09:34:00.000Z'}];
    const tabs = await executePlatformTool(app, conversation, 'list_project_tabs', JSON.stringify({project_name:'Project'}), 'list');
    expect(tabs.tabs).toEqual([expect.objectContaining({session_id:'design-tab',tab_name:'设计',project_name:'Project',mode:'terminal'})]);
    expect(tabs.tabs[0]).toMatchObject({agent_messages_available:true,latest_agent_message:{text:'正在修改分区匹配逻辑',phase:'commentary'}});
    expect(tabs.tabs[0].latest_update_local).toBe('2026-10-21 17:34:00');
    display = {...display, processState:'busy',output:'tool result: private command output'};
    nativeMessages = [{role:'assistant',phase:'commentary',text:'已补充 full-scope 测试；尚未执行测试。',timestamp:'2026-10-21T09:34:00.000Z'}];
    const result = await executePlatformTool(app, conversation, 'read_tab', JSON.stringify({session_id:'design-tab'}), 'read');
    expect(result).toMatchObject({tab_name:'设计',project_name:'Project',mode:'terminal',process_state:'busy',messages:nativeMessages});
    expect(result).toMatchObject({latest_update_at:'2026-10-21T09:34:00.000Z',latest_update_local:'2026-10-21 17:34:00',utc_offset:'+08:00'});
    expect(JSON.stringify(result)).not.toContain('private command output');
    expect(displayRequests.at(-1)).toBe('/api/sessions/design-tab/display?lines=200');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_tasks').get()).toEqual({n:0});
    const listed = await app.inject({url:'/api/sessions?project_id=p',headers:{cookie}});
    expect(listed.json().sessions[0].display_name).toBe('设计');
  });
  it('does not expose another users tab contents through the read-only progress tools', async () => {
    configure(); seedSession('private-tab');
    getDb().prepare("UPDATE sessions SET created_by_user_id=? WHERE id='private-tab'").run(other);
    const received = inbound();
    await expect(executePlatformTool(app,getConversation(received.conversation_id)!,'read_tab',JSON.stringify({session_id:'private-tab'}),'read')).rejects.toThrow('404');
    expect(displayRequests).toHaveLength(0);
  });
  it('translates a legacy rendered-output read to the authorized clean display without requiring tracking', async () => {
    configure(); seedSession();const received = inbound();
    const catalog = app.platformAiApiRegistry!;
    catalog.set('GET /api/sessions/:id/rendered-output',{endpoint_id:'GET /api/sessions/:id/rendered-output',method:'GET',path:'/api/sessions/:id/rendered-output',description:'legacy',callable:false,restriction:'Use display'});
    display.output = 'private tool result';
    nativeMessages = [{role:'assistant',phase:'commentary',text:'实际 Agent 进度消息',timestamp:new Date().toISOString()}];
    const result = await executePlatformTool(app,getConversation(received.conversation_id)!,'platform_request',JSON.stringify({endpoint_id:'GET /api/sessions/:id/rendered-output',path_params:{id:'session-1'},query:{lines:'200'}}),'read');
    expect(result.messages).toEqual(nativeMessages);expect(JSON.stringify(result)).not.toContain('private tool result');expect(displayRequests.at(-1)).toContain('/display?lines=200');
  });
  it('returns state without terminal tool output when native messages are unavailable', async () => {
    configure();seedSession();const received=inbound();
    display={...display,processState:'busy',output:'sensitive tool result should not reach the model'};
    const result=await executePlatformTool(app,getConversation(received.conversation_id)!,'read_tab',JSON.stringify({session_id:'session-1'}),'read');
    expect(result).toMatchObject({process_state:'busy',messages_available:false,messages:[]});
    expect(JSON.stringify(result)).not.toContain(display.output);
  });
  it('inventories actual API routes, exposes scoped state reads and keeps credential routes out of generic calls', async () => {
    const result = await app.inject({url:'/api/platform-ai/tools',headers:{cookie}});
    const endpoints = result.json().endpoints;
    expect(endpoints.find((item: any) => item.endpoint_id==='GET /api/sessions/:id/display').callable).toBe(true);
    expect(endpoints.find((item: any) => item.endpoint_id==='GET /api/platform-ai/config').callable).toBe(false);
    expect(endpoints.find((item: any) => item.endpoint_id==='POST /api/platform-ai/config/models').callable).toBe(false);
    expect(endpoints.find((item: any) => item.endpoint_id==='POST /api/platform-ai/config/test').callable).toBe(false);
    expect(endpoints.find((item: any) => item.endpoint_id==='POST /api/platform-ai/bindings').callable).toBe(false);
    expect(new Set(endpoints.map((item: any) => item.endpoint_id)).size).toBe(endpoints.length);
  });
  it('is disabled by default and requires login outside exact signed callback paths', async () => {
    expect(readAiConfig().enabled).toBe(false);
    for (const path of ['/api/platform-ai/config', '/api/platform-ai/tasks', '/api/platform-ai/callbacks/channel/extra']) {
      expect((await app.inject({url: path})).statusCode).toBe(401);
    }
    expect((await app.inject({url: '/api/platform-ai/callbacks/missing'})).statusCode).toBe(404);
    const send = await app.inject({method: 'POST', url: '/api/platform-ai/messages', headers: {cookie}, payload: {content: 'hello', request_id: 'one'}});
    expect(send.statusCode).toBe(503);
  });
  it('encrypts model and channel credentials and never returns them to the browser', async () => {
    configure();
    const channel = saveChannel({name: 'Gateway', kind: 'webhook', enabled: true, config: {outbound_url: 'https://gateway.example/reply'}, secrets: {signing_secret: 'a'.repeat(40)}});
    const stored = getDb().prepare('SELECT value FROM settings WHERE key=?').get('platform_ai_api_key');
    expect(JSON.stringify(stored)).not.toContain('model-secret');
    expect(readAiConfig().api_key).toBe('model-secret-never-expose');
    expect(getChannel(channel.id)?.secrets.signing_secret).toBe('a'.repeat(40));
    expect(statSync(join(databaseDir, '.platform-ai.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(databaseDir, '.platform-ai.key')).length).toBe(32);
    const response = await app.inject({url: '/api/platform-ai/config', headers: {cookie: adminCookie}});
    expect(response.json().config.api_key_configured).toBe(true);
    expect(response.body).not.toContain('model-secret');
    expect((await app.inject({url: '/api/platform-ai/config', headers: {cookie}})).statusCode).toBe(403);
    const channels = await app.inject({url: '/api/platform-ai/channels', headers: {cookie: adminCookie}});
    expect(channels.body).not.toContain('a'.repeat(40));
    expect(channels.json().channels[0].secret_fields_configured).toEqual(['signing_secret']);
  });
  it('preserves a configured secret on empty updates and validates readiness', async () => {
    expect(() => updateAiConfig({enabled: true})).toThrow('配置');
    configure();
    updateAiConfig({api_key: '', model: 'replacement'});
    expect(readAiConfig().api_key).toBe('model-secret-never-expose');
    expect(() => updateAiConfig({endpoint: 'file:///etc/passwd'})).toThrow('HTTP');
    expect(() => updateAiConfig({observation_interval_seconds: 0})).toThrow();
  });
  it('isolates conversations even for users sharing an external chat id', async () => {
    configure();
    const first = inbound();
    const second = inbound('other', 'second', other);
    expect(first.conversation_id).not.toBe(second.conversation_id);
    const forbidden = await app.inject({url: `/api/platform-ai/conversations/${second.conversation_id}`, headers: {cookie}});
    expect(forbidden.statusCode).toBe(404);
    const listed = await app.inject({url: '/api/platform-ai/conversations', headers: {cookie}});
    expect(listed.json().conversations.map((c: any) => c.id)).toEqual([first.conversation_id]);
  });
  it('deduplicates web submissions with a stable request id', async () => {
    configure();
    const payload = {content: '列出项目', request_id: 'stable-request'};
    const first = await app.inject({method: 'POST', url: '/api/platform-ai/messages', headers: {cookie}, payload});
    const repeated = await app.inject({method: 'POST', url: '/api/platform-ai/messages', headers: {cookie}, payload});
    expect(first.statusCode).toBe(202);
    expect(repeated.json()).toMatchObject({duplicate: true, message_id: first.json().message_id});
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get() as any).n).toBe(1);
  });
});

describe('signed external channel ingestion', () => {
  it('authenticates before mapping users, persists before acknowledging, and rejects replay/tampering', async () => {
    configure();
    const secret = 'webhook-secret-'.repeat(4);
    const channel = saveChannel({name: 'Webhook', kind: 'webhook', enabled: true, config: {outbound_url: 'https://gateway.example/reply'}, secrets: {signing_secret: secret}});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({message_id: 'ext-1', user_id: 'external-member', chat_id: 'group', content: '列出项目'});
    const request = {method: 'POST' as const, url: channel.callback_path, payload: body, headers: {'content-type': 'application/json', 'x-platform-timestamp': timestamp, 'x-platform-signature': hmacSignature(secret, timestamp, body)}};
    expect((await app.inject(request)).statusCode).toBe(403);
    const binding = await app.inject({method: 'POST', url: '/api/platform-ai/bindings', headers: {cookie: adminCookie}, payload: {channel_id: channel.id, external_user_id: 'external-member', user_id: member}});
    expect(binding.statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_messages').get() as any).n).toBe(1);
    expect((await app.inject({...request, payload: body.replace('列出项目', '修改配置')})).statusCode).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await app.inject({...request, headers: {...request.headers, 'x-platform-timestamp': old, 'x-platform-signature': hmacSignature(secret, old, body)}})).statusCode).toBe(401);
  });
  it('validates QQ challenges and signatures while keeping group senders isolated', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const saved = saveChannel({name: 'QQ', kind: 'qq', enabled: true, config: {app_id: '123'}, secrets: {app_secret: secret}});
    const channel = getChannel(saved.id)!;
    const challenge = decodeCallback(channel, 'POST', {}, {}, JSON.stringify({op: 13, d: {plain_token: 'challenge', event_ts: '1234'}}));
    expect(challenge.response).toMatchObject({plain_token: 'challenge', signature: expect.stringMatching(/^[a-f0-9]{128}$/)});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {id: 'msg', group_openid: 'group-1', author: {member_openid: 'member-A'}, content: '<@123> hello'}});
    const key = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8'});
    const headers = {'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), key).toString('hex')};
    expect(decodeCallback(channel, 'POST', {}, headers, body).message).toMatchObject({externalUserId: 'member-A', chatId: 'group-1', content: 'hello'});
    expect(() => decodeCallback(channel, 'POST', {}, headers, body + ' ')).toThrow('签名');
  });
  it('decrypts WeCom messages, binds the receiver and rejects XML entity expansion', () => {
    const aesKey = randomBytes(32);
    const saved = saveChannel({name: 'WeCom', kind: 'wecom', enabled: true, config: {corp_id: 'corp-1', agent_id: '1001'}, secrets: {app_secret: 'secret', token: 'token-1', aes_key: aesKey.toString('base64').replace(/=$/,'')}});
    const xml = '<xml><ToUserName><![CDATA[corp-1]]></ToUserName><FromUserName>member-1</FromUserName><AgentID>1001</AgentID><MsgType>text</MsgType><MsgId>999</MsgId><Content><![CDATA[检查 A & B]]></Content></xml>';
    const bytes = Buffer.from(xml); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const payload = Buffer.concat([randomBytes(16), length, bytes, Buffer.from('corp-1')]);
    const padding = 32 - payload.length % 32;
    const cipher = createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0,16)); cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.alloc(padding,padding)])), cipher.final()]).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'nonce';
    const msg_signature = createHash('sha1').update(['token-1',timestamp,nonce,encrypted].sort().join('')).digest('hex');
    const decoded = decodeCallback(getChannel(saved.id)!, 'POST', {timestamp,nonce,msg_signature}, {}, `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`);
    expect(decoded.message).toMatchObject({externalUserId: 'member-1', content: '检查 A & B'});
    expect(() => decryptWechatMessage(encrypted, aesKey.toString('base64').replace(/=$/,''), 'different-corp')).toThrow('接收方');
    expect(() => xmlText('<!DOCTYPE x [<!ENTITY file SYSTEM "file:///etc/passwd">]><xml/>','Content')).toThrow('entities');
    expect(xmlText('<Content>&lt;a&gt; &#x4e2d;</Content>', 'Content')).toBe('<a> 中');
  });
  it('receives signed plaintext WeChat public-account text messages', () => {
    const saved = saveChannel({name: 'WeChat', kind: 'wechat', enabled: true, config: {app_id: 'app-1'}, secrets: {app_secret: 'secret', token: 'callback-token'}});
    const timestamp = String(Math.floor(Date.now()/1000)); const nonce = 'nonce';
    const signature = createHash('sha1').update(['callback-token',timestamp,nonce].sort().join('')).digest('hex');
    const result = decodeCallback(getChannel(saved.id)!, 'POST', {timestamp,nonce,signature}, {}, '<xml><FromUserName>openid</FromUserName><MsgType>text</MsgType><MsgId>message</MsgId><Content>你好</Content></xml>');
    expect(result.message).toMatchObject({externalUserId: 'openid', content: '你好'});
  });
});

describe('durable platform AI tool execution', () => {
  it('does not append an unsolicited new-task offer to a status query', async () => {
    configure();seedSession();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(toolResponse('list_project_tabs',{project_id:'p'}))
      .mockResolvedValueOnce(providerResponse({content:'当前没有运行任务。\n\n需要我在某个标签页开新任务吗？'})));
    inbound('有哪些任务正在跑？');worker.tick();await worker.drain();
    expect(getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant'").get()).toEqual({content:'当前没有运行任务。'});
  });
  it('creates another project tab while existing work is busy and forwards the exact user text instead of model embellishment', async () => {
    configure(); seedSession('busy-tab');
    const prior = inbound('正在执行的其他工作','old',''+member,'old-chat');
    trackTask(getConversation(prior.conversation_id)!,'busy-tab','其他工作');
    vi.spyOn(manager,'isSessionActive').mockReturnValue(true);
    const spawn = vi.spyOn(manager,'spawnSession').mockResolvedValue();
    const original = '这个项目建个任务，查看当前未完成的jira';
    const received = inbound(original,'jira');
    const result = await executePlatformTool(app,getConversation(received.conversation_id)!,'start_work',JSON.stringify({project_id:'p',cli_type:'codex',requirement:'只读自查仓库 JIRA 接入，禁止写操作，输出 markdown 表格和验收标准'}),'jira-operation',received.message_id);
    expect(result.status).toBe('running');expect(result.forwarded_verbatim).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2]).toBe(original+'\n\n[Platform task reference: jira-operation]');
    expect(getDb().prepare('SELECT requirement FROM platform_ai_tasks WHERE session_id=?').get(result.session_id)).toEqual({requirement:original});
    expect(getDb().prepare("SELECT status FROM sessions WHERE id='busy-tab'").get()).toEqual({status:'running'});
  });
  it('forwards selected original clarification messages in order and rejects sources from another conversation', async () => {
    configure();
    const first = inbound('查看当前未完成的jira','first');
    const second = inbound('项目是 Project，用 Codex','second');
    const unrelated = inbound('别的对话内容','third',member,'other-conversation');
    const conversation = getConversation(second.conversation_id)!;
    await expect(executePlatformTool(app,conversation,'start_work',JSON.stringify({project_id:'p',cli_type:'codex',requirement:'expanded',source_message_ids:[unrelated.message_id]}),'bad',second.message_id)).rejects.toThrow('不属于当前对话');
    const spawn=vi.spyOn(manager,'spawnSession').mockResolvedValue();
    await executePlatformTool(app,conversation,'start_work',JSON.stringify({project_id:'p',cli_type:'codex',requirement:'expanded',source_message_ids:[first.message_id]}),'clarified',second.message_id);
    expect(spawn.mock.calls[0][2]).toBe('查看当前未完成的jira\n\n项目是 Project，用 Codex\n\n[Platform task reference: clarified]');
  });
  it('only checks the selected target tab before forwarding a follow-up verbatim', async () => {
    configure();seedSession('target-tab');seedSession('other-busy-tab');
    vi.spyOn(manager,'isSessionActive').mockReturnValue(true);
    const received=inbound('继续查询未完成的jira','followup');const conversation=getConversation(received.conversation_id)!;
    display={...display,processState:'busy'};
    await expect(executePlatformTool(app,conversation,'send_to_session',JSON.stringify({session_id:'target-tab',instruction:'自定义改写'}),'blocked',received.message_id)).rejects.toThrow('目标会话正在执行');
    expect(executeRequests).toHaveLength(0);
    display={...display,processState:'idle'};
    await executePlatformTool(app,conversation,'send_to_session',JSON.stringify({session_id:'target-tab',instruction:'只读调查并必须输出报告'}),'ready',received.message_id);
    expect(executeRequests[0].input).toBe('继续查询未完成的jira\n\n[Platform task reference: ready]');
  });
  it('copies the current screenshots into the authorized project before spawning the work agent', async () => {
    configure(); const received = inbound('根据截图修复项目');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CsAAAAAASUVORK5CYII=', 'base64');
    getDb().prepare("INSERT INTO platform_ai_attachments (id,message_id,status,mime,bytes,data) VALUES (?,?,'ready','image/png',?,?)").run('screenshot-1', received.message_id, png.length, png);
    const spawn = vi.spyOn(manager, 'spawnSession').mockResolvedValue();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(toolResponse('start_work', {project_id: 'p', requirement: '根据用户提供的截图修复显示问题', cli_type: 'codex'}))
      .mockResolvedValueOnce(providerResponse({content: '已连同截图派发。'})));
    worker.tick(); await worker.drain();
    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = spawn.mock.calls[0][2];
    const path = prompt.match(/图片 1：([^\n]+)/)?.[1];
    expect(path).toContain(databaseDir + '/.agentmanager/pastes/');
    expect(readFileSync(path!).equals(png)).toBe(true);
    expect(prompt).toContain('[Platform task reference:');
    expect((getDb().prepare('SELECT task FROM sessions').get() as {task: string}).task).toBe(prompt);
  });
  it('rejects image attachments from another conversation before creating an agent session', async () => {
    configure(); const first = inbound('我的项目', 'first');
    const second = inbound('其他对话图片', 'second', other, 'other-chat');
    getDb().prepare("INSERT INTO platform_ai_attachments (id,message_id,status,mime,bytes,data) VALUES (?,?,'ready','image/png',8,?)").run('private-image', second.message_id, Buffer.from('private-data'));
    await expect(executePlatformTool(app, getConversation(first.conversation_id)!, 'start_work', JSON.stringify({project_id: 'p', requirement: '修复', cli_type: 'codex', attachment_ids: ['private-image']}), 'test-operation'))
      .rejects.toThrow('不属于当前对话');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n: 0});
  });
  it('exposes discovered agents and rejects a missing CLI before creating any session or task', async () => {
    configure();
    vi.mocked(agents.detectWorkAgent).mockResolvedValue({cli_type:'claude',label:'Claude',status:'unavailable',reason:'找不到启动命令'});
    const spawn = vi.spyOn(manager,'spawnSession').mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValueOnce(toolResponse('start_work',{project_id:'p',requirement:'只读分析项目',cli_type:'claude'}))
      .mockResolvedValueOnce(providerResponse({content:'Claude 当前不可用，可选择已探测可用的 Codex。'}));
    vi.stubGlobal('fetch',fetchMock);
    const capabilities = await app.inject({url:'/api/platform-ai/agents',headers:{cookie}});
    expect(capabilities.json().agents).toHaveLength(2);
    inbound('只读分析项目'); worker.tick(); await worker.drain();
    expect(spawn).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n:0});
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_tasks').get()).toEqual({n:0});
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.find((m: any) => m.role==='tool').content).toContain('Claude 当前不可用');
  });
  it('claims conversations in FIFO order without blocking independent users', () => {
    const first = inbound('first','one'); inbound('second','two'); inbound('other','three',other);
    const a = claimMessage(Date.now(),60000)!;
    const b = claimMessage(Date.now(),60000)!;
    expect(a.id).toBe(first.message_id);
    expect(b.conversation_id).not.toBe(a.conversation_id);
    expect(claimMessage(Date.now(),60000)).toBeUndefined();
  });
  it('acknowledges a dispatched task in one sentence without a second model call or duplicate dispatch', async () => {
    configure();
    const spawn = vi.spyOn(manager,'spawnSession').mockResolvedValue();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolResponse('start_work',{project_id: 'p', requirement: '实现导出并执行测试', cli_type: 'codex'}))
      .mockRejectedValueOnce(new Error('provider temporarily unavailable'))
      .mockResolvedValueOnce(providerResponse({content: '任务已派发，平台会跟踪进度。'}));
    vi.stubGlobal('fetch',fetchMock);
    const received = inbound('给 p 项目实现导出');
    worker.tick(); await worker.drain();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_tasks').get() as any).n).toBe(1);
    getDb().prepare('UPDATE platform_ai_messages SET available_at=0 WHERE id=?').run(received.message_id);
    worker.tick(); await worker.drain();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT status FROM platform_ai_messages WHERE id=?').get(received.message_id)).toEqual({status:'done'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reply=getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant'").get() as {content:string};
    expect(reply.content).toMatch(/^已在「Project \/ .+」新建任务。$/);
    expect(reply.content).not.toMatch(/队列|超时|接下来|跟踪/);
    const modelBodies = fetchMock.mock.calls.map(call => JSON.parse(call[1].body));
    expect(JSON.stringify(modelBodies)).not.toContain('agentmanager_session');
  });
  it('uses real API authorization when a model attempts to access another user project', async () => {
    configure();
    getDb().prepare("INSERT INTO projects (id,name,path,owner_id) VALUES ('private','Private','/tmp/platform-ai-private',?)").run(other);
    const fetchMock = vi.fn().mockResolvedValueOnce(toolResponse('platform_request',{endpoint_id: 'GET /api/projects/:id',path_params: {id: 'private'}}))
      .mockResolvedValueOnce(providerResponse({content: '该项目无访问权限。'}));
    vi.stubGlobal('fetch',fetchMock);
    inbound('查看 private'); worker.tick(); await worker.drain();
    const messages = JSON.parse(fetchMock.mock.calls[1][1].body).messages;
    expect(messages.find((m: any) => m.role === 'tool').content).toContain('404');
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as any).n).toBe(2);
  });
  it('finishes a recovered final response without calling the model again', async () => {
    configure(); const received = inbound();
    const checkpoint = [{role:'user',content:'列出项目'},{role:'assistant',content:'已有一个项目。'}];
    getDb().prepare('UPDATE platform_ai_messages SET checkpoint=? WHERE id=?').run(JSON.stringify(checkpoint),received.message_id);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock);
    worker.tick(); await worker.drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT content FROM platform_ai_messages WHERE role='assistant'").get()).toEqual({content:'已有一个项目。'});
  });
  it('reconciles an interrupted write operation without executing it again', async () => {
    configure(); const received = inbound();
    const call = {id:'interrupted',type:'function',function:{name:'start_work',arguments:JSON.stringify({project_id:'p',requirement:'work',cli_type:'codex'})}};
    const {operationKey} = await import('../src/services/platform-ai/tools.js');
    const operation = operationKey(received.message_id,call.id);
    getDb().prepare("INSERT INTO platform_ai_operations (id,message_id,tool_name,arguments,status) VALUES (?,?,'start_work',?,'started')").run(operation,received.message_id,call.function.arguments);
    getDb().prepare('UPDATE platform_ai_messages SET checkpoint=? WHERE id=?').run(JSON.stringify([{role:'user',content:'work'},{role:'assistant',content:null,tool_calls:[call]}]),received.message_id);
    const spawn = vi.spyOn(manager,'spawnSession').mockResolvedValue();
    const fetchMock = vi.fn().mockResolvedValue(providerResponse({content:'原操作结果待核对，未重复执行。'})); vi.stubGlobal('fetch',fetchMock);
    worker.tick(); await worker.drain();
    expect(spawn).not.toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages.find((m: any) => m.role==='tool').content).toContain('uncertain');
  });
  it('links created schedules to the source conversation and tracks each successful occurrence', async () => {
    configure();
    vi.stubGlobal('fetch',vi.fn()
      .mockResolvedValueOnce(toolResponse('platform_request',{endpoint_id:'POST /api/scheduled-tasks',body:{project_id:'p',name:'每日检查',prompt:'执行测试',schedule_kind:'daily',schedule_value:'09:00',timezone:'Asia/Taipei',target_type:'new',new_mode:'session',new_cli_type:'codex',enabled:false}}))
      .mockResolvedValueOnce(providerResponse({content:'已保存定时任务。'})));
    const received=inbound('每天检查测试'); worker.tick(); await worker.drain();
    const link=getDb().prepare('SELECT * FROM platform_ai_schedule_links').get() as any;
    expect(link.conversation_id).toBe(received.conversation_id);
    seedSession();
    getDb().prepare("INSERT INTO scheduled_task_runs (id,task_id,trigger,status,scheduled_for) VALUES ('run-1',?,'scheduled','running',datetime('now'))").run(link.schedule_id);
    captureScheduledBaseline(link.schedule_id,'run-1',null);
    getDb().prepare("UPDATE scheduled_task_runs SET status='success',session_id='session-1' WHERE id='run-1'").run();
    reconcileScheduledObservations(); reconcileScheduledObservations();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_tasks').get() as any).n).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_outbox WHERE dedupe_key='schedule:run-1'").get() as any).n).toBe(1);
  });
});

describe('session observation and notification reliability', () => {
  it('subscribes to a busy terminal native request without sending input and notifies on its matching final reply', async () => {
    configure();seedSession();getDb().prepare("UPDATE sessions SET mode='terminal' WHERE id='session-1'").run();
    const received=inbound('这个任务完成通知我');const conversation=getConversation(received.conversation_id)!;
    display={cursor:6,output:'tool output is not sent',processState:'busy',promptType:null};
    nativeMessages=[{role:'user',phase:'user',text:'修复 OPS-779 并部署',timestamp:'2026-10-21T09:00:00Z',task_reference:'native:request-one'},
      {role:'assistant',phase:'commentary',text:'正在部署',timestamp:'2026-10-21T09:34:00Z',task_reference:'native:request-one'}];
    const subscription=await executePlatformTool(app,conversation,'track_session',JSON.stringify({session_id:'session-1',requirement:'修复 OPS-779 并部署完成后通知'}),'subscribe');
    expect(subscription.monitoring).toBe(true);expect(executeRequests).toHaveLength(0);
    const task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(subscription.task_id) as any;
    expect(task.source_ref).toBe('native:request-one');
    display.processState='idle';
    nativeMessages.push({role:'assistant',phase:'final',text:'OPS-779 已修复并部署，线上健康检查通过。',timestamp:'2026-10-21T09:45:00Z',task_reference:'native:request-one'});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'Agent 已报告完成部署',evidence:'OPS-779 已修复并部署'})})));
    await worker.observe(task,readAiConfig(),true);
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete'});
    expect((getDb().prepare("SELECT content FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get() as {content:string}).content).toContain('OPS-779 已修复并部署，线上健康检查通过。');
    expect(executeRequests).toHaveLength(0);expect(getDb().prepare('SELECT COUNT(*) AS n FROM scheduled_tasks').get()).toEqual({n:0});
  });
  it('promptly forwards a matched native blocked reply even while Codex automatically continues and stays busy', async () => {
    configure();seedSession();const received=inbound();
    let task=trackTask(getConversation(received.conversation_id)!,'session-1','查看未完成 Jira',0,'auto-goal');
    task.last_assessed_at=Date.now();task.last_notified_at=Date.now();
    display={cursor:1,output:'tool result deliberately excluded',processState:'busy',promptType:null};
    const reply='已检查项目文档和历史，仍未找到 Jira 地址。请提供项目或筛选器链接，才能继续查询。';
    nativeMessages=[{role:'assistant',phase:'final',text:reply,timestamp:new Date().toISOString(),task_reference:'auto-goal'}];
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'blocked',summary:'Agent 请求提供 Jira 项目或筛选器链接。',evidence:'请提供项目或筛选器链接'})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'blocked'});
    expect((getDb().prepare("SELECT content FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get() as {content:string}).content).toContain(reply);
    const input=JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content);
    expect(input.native_final_answer).toBe(reply);expect(input.output).toBe('');
    task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    await worker.observe(task,readAiConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get()).toEqual({n:1});
  });
  it('does not permanently skip public questions after bounded idle log rechecks are exhausted', async () => {
    configure();seedSession();const received=inbound();
    let task=trackTask(getConversation(received.conversation_id)!,'session-1','查看未完成 Jira',0,'late-question');
    display={cursor:0,output:'',processState:'idle',promptType:null};
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'blocked',summary:'Agent 需要项目链接。',evidence:'请提供项目链接'})}));
    vi.stubGlobal('fetch',fetchMock);
    for(let i=0;i<4;i++){
      await worker.observe(task,readAiConfig(),i===0);
      task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    }
    expect(fetchMock).not.toHaveBeenCalled();
    nativeMessages=[{role:'assistant',phase:'commentary',text:'请提供项目链接',timestamp:new Date().toISOString(),task_reference:'late-question'}];
    task.last_assessed_at=0;
    await worker.observe(task,readAiConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'blocked'});
  });
  it('uses tracked-tab events to wake a coalesced durable queue and ignores unrelated tabs', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目');
    getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
    vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
    const now=Date.now();
    const observe=vi.spyOn(worker,'observe').mockImplementation(async task=>{
      getDb().prepare('UPDATE platform_ai_tasks SET next_observe_at=? WHERE id=?').run(Date.now()+300000,task.id);
    });
    worker.start();worker.tick();await worker.drain();
    expect(observe).toHaveBeenCalledTimes(1);
    broadcastEphemeral({type:'session.state',session_id:'untracked',data:{processState:'idle'}});
    worker.tick();await worker.drain();expect(observe).toHaveBeenCalledTimes(1);
    for(let index=0;index<10;index++) broadcastEphemeral({type:'session.state',session_id:'session-1',data:{processState:'idle'}});
    worker.tick();await worker.drain();expect(observe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now+500);worker.tick();await worker.drain();
    expect(observe).toHaveBeenCalledTimes(2);expect(observe.mock.calls[1][2]).toBe(true);
    vi.setSystemTime(now+1000);
    for(let index=0;index<10;index++) broadcastEphemeral({type:'session.activity',session_id:'session-1',data:{lastActivity:Date.now()}});
    worker.tick();await worker.drain();expect(observe).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now+16000);worker.tick();await worker.drain();expect(observe).toHaveBeenCalledTimes(3);
    await worker.stop();
    const due=(getDb().prepare('SELECT next_observe_at FROM platform_ai_tasks WHERE id=?').get(task.id) as {next_observe_at:number}).next_observe_at;
    broadcastEphemeral({type:'session_end',session_id:'session-1'});
    expect(getDb().prepare('SELECT next_observe_at FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({next_observe_at:due});
  });
  it('does only bounded local rechecks while the native final log is delayed', async () => {
    configure();seedSession();const received=inbound();
    let task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',0,'delayed-event');
    display={cursor:4,output:'Agent 刚刚停止输出',processState:'idle',promptType:null};
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    for(let index=0;index<4;index++) {
      await worker.observe(task,readAiConfig(),index===0);
      task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(task.next_observe_at-Date.now()).toBeGreaterThan(290000);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_outbox').get()).toEqual({n:0});
  });
  it('reports an authorization question from a tab event without calling a model', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目');
    display={cursor:5,output:'Do you want to allow reading this directory? (y/n)',processState:'waiting_for_input',promptType:'confirmation'};
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig(),true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'blocked'});
    expect((getDb().prepare('SELECT content FROM platform_ai_outbox').get() as {content:string}).content).toContain('Do you want to allow reading this directory?');
  });
  it('analyzes a new text question promptly even if its output was seen during a recent busy state', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出');
    task.last_assessed_at=Date.now();task.last_assessed_output='要导出 CSV 还是 JSON?';task.output=task.last_assessed_output;
    nativeMessages=[{role:'assistant',phase:'commentary',text:task.last_assessed_output,timestamp:new Date().toISOString()}];
    display={cursor:0,output:'',processState:'waiting_for_input',promptType:'text'};
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'blocked',summary:'Agent 需要选择导出格式：CSV 或 JSON。',evidence:'要导出 CSV 还是 JSON?'})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig(),true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'blocked'});
  });
  it('uses the matching native final instead of mistaking a numbered report for an input prompt', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',0,'numbered-report');
    display={cursor:5,output:'1. 项目定位\n2. 技术架构',processState:'waiting_for_input',promptType:'choice'};
    nativeTurns=[{user:'分析项目 [Platform task reference: numbered-report]',assistant:'项目分析已完成，未执行构建测试。'}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'分析已完成，未执行构建测试。',evidence:'项目分析已完成'})})));
    await worker.observe(task,readAiConfig(),true);
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete'});
  });
  it('does not turn repeated empty null-cursor polls into resets or model requests', async () => {
    configure();seedSession();const received=inbound();
    let task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',42,'empty-poll');
    display={cursor:null,output:'',processState:'idle',promptType:null};
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    for (let index=0;index<4;index++) {
      await worker.observe(task,readAiConfig());
      task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    }
    expect(task).toMatchObject({cursor:42,status:'running'});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_outbox').get()).toEqual({n:0});
  });
  it('recovers a real cursor reset internally without discarding a completed native result', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',42,'resynced-task');
    display={cursor:3,cursorReset:true,output:'恢复后的屏幕',processState:'idle',promptType:null};
    nativeTurns=[{user:'分析项目 [Platform task reference: resynced-task]',assistant:'已完成项目概览。未执行构建测试。'}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'已完成分析，未执行构建测试。',evidence:'已完成项目概览'})})));
    await worker.observe(task,readAiConfig());
    expect(displayRequests).toEqual(['/api/sessions/session-1/display?lines=300&since=42','/api/sessions/session-1/display?lines=300']);
    expect(getDb().prepare('SELECT cursor,status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({cursor:3,status:'reported_complete'});
    const notice=getDb().prepare("SELECT content FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get() as {content:string};
    expect(notice.content).toContain('已完成项目概览。未执行构建测试。');
    expect(notice.content).not.toContain('游标');
  });
  it('detects a newly available native final even without output and before the next analysis interval', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',42,'idle-result');
    task.last_assessed_at=Date.now();
    display={cursor:null,output:'',processState:'idle',promptType:null};
    nativeTurns=[{user:'分析项目 [Platform task reference: idle-result]',assistant:'已完成分析，报告正文。'}];
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'分析报告已完成，未运行测试。',evidence:'已完成分析'})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(getDb().prepare('SELECT cursor,status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({cursor:42,status:'reported_complete'});
    const modelInput=JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content);
    expect(modelInput.output).toBe('');expect(modelInput.native_final_answer).toBe('已完成分析，报告正文。');
  });
  it('sends incremental, bounded progress text and deduplicates unchanged progress notices', async () => {
    configure();seedSession();const received=inbound();
    let task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目');
    const fetchMock=vi.fn().mockImplementation(async()=>providerResponse({content:JSON.stringify({status:'running',summary:'正在分析核心模块',evidence:''})}));
    vi.stubGlobal('fetch',fetchMock);
    for(let index=0;index<3;index++) {
      display={cursor:index+1,output:`进展${index}`,processState:'idle',promptType:null};
      nativeMessages.push({role:'assistant',phase:'commentary',text:`进展${index}`,timestamp:new Date().toISOString()});
      task.last_assessed_at=0;task.last_notified_at=0;
      await worker.observe(task,readAiConfig());
      task=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    }
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get()).toEqual({n:1});
    const third=JSON.parse(JSON.parse(fetchMock.mock.calls[2][1].body).messages[1].content);
    expect(third.output).toContain('进展2');expect(third.output).not.toContain('进展0');
    expect(third.previous_summary).toBe('正在分析核心模块');
    expect(newObservationText('A'.repeat(12000)+'B'.repeat(12000),'B'.repeat(12000)+'C'.repeat(12000))).toBe('C'.repeat(6000));
    expect(newObservationText('unchanged','unchanged')).toBe('');
  });
  it('collapses identical historical notices in the conversation while retaining the audit rows', async () => {
    const received=inbound();
    for (let index=0;index<3;index++) enqueueNotice(received.conversation_id,`old:${index}`,'同一条历史通知');
    const result=await app.inject({url:`/api/platform-ai/conversations/${received.conversation_id}`,headers:{cookie}});
    expect(result.json().messages.filter((message: {role:string})=>message.role==='notice')).toHaveLength(1);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM platform_ai_messages WHERE role='notice'").get()).toEqual({n:3});
  });
  it('reports a missing CLI from an ended snapshot immediately without asking the model', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','只读分析',100,'missing-cli');
    getDb().prepare("UPDATE sessions SET status='completed',exit_code=0 WHERE id='session-1'").run();
    display={cursor:0,output:'zsh:1: command not found: claude',processState:'idle',promptType:null};
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status,summary FROM platform_ai_tasks WHERE id=?').get(task.id)).toMatchObject({status:'failed',summary:expect.stringContaining('本次需求未执行')});
    expect(getDb().prepare("SELECT content FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get()).toMatchObject({content:expect.stringContaining('启动失败')});
  });
  it('does not leave an ended session with no output in running status', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',0,'ended-task');
    getDb().prepare("UPDATE sessions SET status='completed',exit_code=0 WHERE id='session-1'").run();
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status,summary FROM platform_ai_tasks WHERE id=?').get(task.id)).toMatchObject({status:'uncertain',summary:expect.stringContaining('会话已结束')});
  });
  it.each(['', 'zsh:1: command not found: claude'])('uses the current native final reply despite empty replay or quoted error examples (%s)', async output => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','分析项目',0,'ended-success');
    getDb().prepare("UPDATE sessions SET status='completed',exit_code=0 WHERE id='session-1'").run();
    display={cursor:0,output,processState:'idle',promptType:null};
    nativeTurns=[{user:'分析项目 [Platform task reference: ended-success]',assistant:'分析报告已完成，未修改文件。'}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'分析完成，未修改文件。',evidence:'分析报告已完成'})})));
    await worker.observe(task,readAiConfig());
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete'});
  });
  it('suspends observation immediately after project access is revoked', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出');
    getDb().prepare('UPDATE project_user_access SET can_session=0,can_terminal=0,session_clients=? WHERE user_id=?').run('[]',member);
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'suspended'});
  });
  it('rejects a historical native final answer for a previous task, even if terminal text says completed', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出',0,'new-reference');
    display={cursor:5,output:'导出功能实现完成',processState:'idle',promptType:null};
    nativeTurns=[{user:'实现导出\n[Platform task reference: old-reference]',assistant:display.output}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'实现完成',evidence:display.output})})));
    await worker.observe(task,readAiConfig());
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'running'});
  });
  it('rechecks a delayed native final answer even if no further terminal output arrives', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出',0,'delayed-reference');
    display={cursor:5,output:'功能完成',processState:'idle',promptType:null};
    const fetchMock=vi.fn().mockImplementation(async () => providerResponse({content:JSON.stringify({status:'reported_complete',summary:'功能完成，验证未执行',evidence:'功能完成'})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    nativeTurns=[{user:'实现导出\n[Platform task reference: delayed-reference]',assistant:'功能完成'}];
    const refreshed=getDb().prepare('SELECT * FROM platform_ai_tasks WHERE id=?').get(task.id) as typeof task;
    refreshed.last_assessed_at=0;
    display={cursor:5,output:'',processState:'idle',promptType:null};
    await worker.observe(refreshed,readAiConfig());
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete'});
  });
  it('does not treat an idle session with no new output as completed', async () => {
    configure(); seedSession(); const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出');
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'running'});
  });
  it('requires actual evidence and never upgrades a busy session to completed', () => {
    expect(validateAssessment({status:'reported_complete',summary:'done',evidence:'imagined'},'actual','idle').status).toBe('uncertain');
    expect(validateAssessment({status:'reported_complete',summary:'done',evidence:'actual'},'actual','busy').status).toBe('uncertain');
    expect(validateAssessment({status:'reported_complete',summary:'已实现，测试未执行',evidence:'实现完成'},'实现完成，测试未执行','idle').status).toBe('reported_complete');
  });
  it('stores completion evidence and queues notification in the same transaction', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出',0,'completion-reference');
    display={cursor:5,output:'导出功能实现完成，测试未执行。',processState:'idle',promptType:null};
    nativeTurns=[{user:'实现导出\n[Platform task reference: completion-reference]',assistant:display.output}];
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'reported_complete',summary:'实现完成，测试尚未执行。',evidence:'导出功能实现完成，测试未执行。'})})));
    await worker.observe(task,readAiConfig());
    expect(getDb().prepare('SELECT status,evidence FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'reported_complete',evidence:display.output});
    const notice=getDb().prepare("SELECT content FROM platform_ai_outbox WHERE dedupe_key LIKE 'task:%'").get() as any;
    expect(notice.content).toContain('Agent 已报告完成');expect(notice.content).toContain(nativeTurns[0].assistant);
    expect(notice.content).not.toContain('请查看验证情况');expect(notice.content).not.toContain('###');
  });
  it('does not revive a task cancelled during model assessment', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','实现导出');
    display={cursor:5,output:'功能完成',processState:'idle',promptType:null};
    nativeMessages=[{role:'assistant',phase:'commentary',text:'功能完成',timestamp:new Date().toISOString()}];
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => {
      getDb().prepare("UPDATE platform_ai_tasks SET status='cancelled' WHERE id=?").run(task.id);
      return providerResponse({content:JSON.stringify({status:'reported_complete',summary:'功能完成',evidence:'功能完成'})});
    }));
    await worker.observe(task,readAiConfig());
    expect(getDb().prepare('SELECT status FROM platform_ai_tasks WHERE id=?').get(task.id)).toEqual({status:'cancelled'});
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM platform_ai_outbox').get() as any).n).toBe(0);
  });
  it('does not call the model for tool-only output and assesses only this tasks public agent messages', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','检查 Jira',0,'message-only');
    display={cursor:1,output:'private tool execution result',processState:'busy',promptType:null};
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'running',summary:'正在检查已有 Jira 配置',evidence:''})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).not.toHaveBeenCalled();
    nativeMessages=[
      {role:'assistant',phase:'final',text:'旧任务已完成',timestamp:new Date().toISOString()},
      {role:'user',phase:'user',text:'检查 Jira [Platform task reference: message-only]',timestamp:new Date().toISOString()},
      {role:'assistant',phase:'commentary',text:'正在检查已有 Jira 配置',timestamp:new Date().toISOString()},
      {role:'user',phase:'user',text:'另一个任务',timestamp:new Date().toISOString()},
      {role:'assistant',phase:'commentary',text:'不属于当前任务',timestamp:new Date().toISOString()},
    ];
    await worker.observe(task,readAiConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const input=JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content);
    expect(input.output).toBe('正在检查已有 Jira 配置');
    expect(JSON.stringify(input)).not.toContain('private tool execution result');
  });
  it('keeps reading this tasks new messages when the original prompt has scrolled out and terminal replay is empty', async () => {
    configure();seedSession();const received=inbound();
    const task=trackTask(getConversation(received.conversation_id)!,'session-1','检查 Jira',0,'long-turn');
    display={cursor:0,output:'',processState:'busy',promptType:null};
    nativeMessages=[{role:'assistant',phase:'commentary',text:'找到已有接入，正在查询',timestamp:new Date().toISOString(),task_reference:'long-turn'}];
    const fetchMock=vi.fn().mockResolvedValue(providerResponse({content:JSON.stringify({status:'running',summary:'正在查询',evidence:''})}));
    vi.stubGlobal('fetch',fetchMock);
    await worker.observe(task,readAiConfig());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).output).toBe('找到已有接入，正在查询');
  });
  it('retries failed outbound delivery with a stable idempotency key', async () => {
    configure();
    const saved=saveChannel({name:'Gateway',kind:'webhook',enabled:true,config:{outbound_url:'https://gateway.example/reply'},secrets:{signing_secret:'s'.repeat(40)}});
    getDb().prepare('INSERT INTO platform_ai_bindings (id,channel_id,external_user_id,user_id) VALUES (?,?,?,?)').run('binding',saved.id,'external',member);
    const received=receiveMessage({userId:member,channelId:saved.id,externalUserId:'external',chatId:'chat',messageId:'msg',content:'hello'});
    getDb().prepare("UPDATE platform_ai_messages SET status='done'").run();
    const {enqueueNotice}=await import('../src/services/platform-ai/store.js');
    enqueueNotice(received.conversation_id,'test-notice','task finished');
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('',{status:200}));vi.stubGlobal('fetch',fetchMock);
    worker.tick();await worker.drain();
    expect(getDb().prepare('SELECT status,attempts FROM platform_ai_outbox').get()).toEqual({status:'pending',attempts:1});
    getDb().prepare('UPDATE platform_ai_outbox SET available_at=0').run();
    worker.tick();await worker.drain();
    expect(getDb().prepare('SELECT status,attempts FROM platform_ai_outbox').get()).toEqual({status:'sent',attempts:2});
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe(fetchMock.mock.calls[1][1].headers['Idempotency-Key']);
  });
});
