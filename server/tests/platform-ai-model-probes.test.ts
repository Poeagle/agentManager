import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHook, createSession, createUser } from '../src/auth.js';
import { getDb } from '../src/db/index.js';
import { platformAiRoutes } from '../src/routes/platform-ai.js';
import { readAiConfig, updateAiConfig } from '../src/services/platform-ai/config.js';
import { modelApiUrl } from '../src/services/platform-ai/model.js';
import { createTestDatabase } from './helpers/database.js';

let app: FastifyInstance;
let cleanup: () => void;
let adminCookie: string;
let memberCookie: string;
const draft = {endpoint: 'https://gateway.example/v1/', api_key: 'draft-secret', model: 'tools-model', timeout_ms: 1000};
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const textReply = () => jsonResponse({choices: [{message: {content: 'OK'}}]});
const send = (path: 'models' | 'test', payload: unknown = draft, cookie = adminCookie) => app.inject({
  method: 'POST', url: `/api/platform-ai/config/${path}`, headers: {cookie}, payload,
});
beforeEach(async () => {
  ({cleanup} = createTestDatabase());
  adminCookie = `agentmanager_session=${createSession(createUser({username: 'admin', password: 'password1', role: 'admin'}).id)}`;
  memberCookie = `agentmanager_session=${createSession(createUser({username: 'member', password: 'password1'}).id)}`;
  app = Fastify();
  app.addHook('onRequest', authHook);
  await app.register(platformAiRoutes, {prefix: '/api', runWorker: false});
});
afterEach(async () => { await app.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); cleanup(); });

describe('model discovery and connection probes', () => {
  it('requires settings write permission before making any provider request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const path of ['models', 'test'] as const) {
      expect((await send(path, draft, '')).statusCode).toBe(401);
      expect((await send(path, draft, memberCookie)).statusCode).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('discovers, normalizes and deduplicates model IDs with unsaved credentials while disabled', async () => {
    const before = getDb().prepare('SELECT * FROM settings ORDER BY key').all();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({data: [{id:'z-model'}, {id:' a-model '}, {id:'z-model'}, {id: ''}, {}, {id: 3}, null]}));
    vi.stubGlobal('fetch', fetchMock);
    const response = await send('models', {...draft, model: ''});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({models: ['a-model', 'z-model']});
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/v1/models', expect.objectContaining({method: 'GET', redirect: 'error', headers: {Authorization: 'Bearer draft-secret'}}));
    expect(response.body).not.toContain('draft-secret');
    expect(getDb().prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
    expect(readAiConfig().enabled).toBe(false);
  });
  it('uses the same API base for model listing and chat, including complete endpoint URLs', () => {
    for (const suffix of ['', '/', '/chat/completions', '/chat/completions/', '/models']) {
      expect(modelApiUrl(`https://gateway.example/custom/v1${suffix}?api-version=test`, 'models')).toBe('https://gateway.example/custom/v1/models?api-version=test');
      expect(modelApiUrl(`https://gateway.example/custom/v1${suffix}?api-version=test`, 'chat/completions')).toBe('https://gateway.example/custom/v1/chat/completions?api-version=test');
    }
  });
  it('reuses a stored secret without returning it and requires a fresh key for another API address', async () => {
    updateAiConfig({...draft, enabled: false});
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({data: []})); vi.stubGlobal('fetch', fetchMock);
    const {api_key: _key, ...withoutKey} = draft;
    expect((await send('models', {...withoutKey, endpoint: 'https://gateway.example/v1/chat/completions'})).statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer draft-secret');
    const changed = await send('models', {...withoutKey, endpoint: 'https://other.example/v1'});
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error).toContain('重新输入');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await send('models', {...draft, endpoint:'https://other.example/v1', api_key:'new-secret'})).statusCode).toBe(200);
    expect(readAiConfig().api_key).toBe('draft-secret');
  });
  it('explains unsupported model listing and never returns provider error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({error:'draft-secret provider internal details'}, 404)));
    const response = await send('models');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('404');
    expect(response.body).not.toContain('draft-secret');
  });
  it.each([{unexpected: []}, {data: null}, 'html page'])('rejects an invalid model list (%j)', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(data)));
    const response = await send('models');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('手动');
  });
  it('tests normal replies and real structured tool arguments without persisting or executing a platform operation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(textReply()).mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body);
      const token = body.messages[0].content.match(/exactly "([a-f0-9]+)"/)[1];
      expect(body.tool_choice).toBe('auto');
      return jsonResponse({choices:[{message:{content:null,tool_calls:[{id:'probe',type:'function',function:{name:'platform_connection_probe',arguments:JSON.stringify({token})}}]}}]});
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await send('test');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ok: true, model:'tools-model', checks:{connection:{status:'passed'},response:{status:'passed'},tools:{status:'passed'}}});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readAiConfig().enabled).toBe(false);
    for (const table of ['platform_ai_tasks','platform_ai_operations','sessions']) {
      expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({n:0});
    }
    expect(response.body).not.toContain('draft-secret');
  });
  it.each([
    {content:'I would call the tool'},
    {tool_calls:[{id:'x',type:'function',function:{name:'platform_connection_probe',arguments:'{"token":"wrong"}'}}]},
    {tool_calls:[{id:'x',type:'function',function:{name:'platform_connection_probe',arguments:'invalid json'}}]},
  ])('does not mistake a normal reply or invalid arguments for tool support', async (message) => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(textReply()).mockResolvedValueOnce(jsonResponse({choices:[{message}]})));
    const result = (await send('test')).json();
    expect(result.ok).toBe(false);
    expect(result.checks.response.status).toBe('passed');
    expect(result.checks.tools.status).toBe('failed');
  });
  it('distinguishes an accessible endpoint with rejected credentials from network failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({error:'draft-secret'},401)).mockRejectedValueOnce(new Error('network error draft-secret'));
    vi.stubGlobal('fetch',fetchMock);
    const denied = await send('test');
    expect(denied.json()).toMatchObject({ok:false,checks:{connection:{status:'passed'},response:{status:'failed',message:expect.stringContaining('401')},tools:{status:'skipped'}}});
    const offline = await send('test');
    expect(offline.json().checks.connection.status).toBe('failed');
    expect(denied.body + offline.body).not.toContain('draft-secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reports tool request rejection separately from a working text model', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(textReply()).mockResolvedValueOnce(jsonResponse({error:'upstream details'},400)));
    expect((await send('test')).json()).toMatchObject({ok:false,checks:{response:{status:'passed'},tools:{status:'failed',message:expect.stringContaining('400')}}});
  });
  it('honors the configured timeout without waiting indefinitely for an upstream response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true});
    })));
    const response = await send('test');
    expect(response.json()).toMatchObject({ok:false,checks:{connection:{status:'failed',message:expect.stringContaining('超时')},tools:{status:'skipped'}}});
  });
  it('rejects incomplete drafts and non-HTTP addresses before sending requests', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock);
    for (const input of [{...draft,model:''}, {...draft,api_key:''}, {...draft,endpoint:'file:///etc/passwd'}, {...draft,timeout_ms:0}]) {
      expect((await send('test',input)).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('bounds provider responses and rejects non-JSON success pages', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('<html>wrong endpoint</html>')).mockResolvedValueOnce(new Response('x'.repeat(1024*1024+1))));
    expect((await send('models')).json().error).toContain('JSON');
    expect((await send('models')).json().error).toContain('大小限制');
  });
});
