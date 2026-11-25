import {it,expect,vi} from 'vitest';
import {createHash} from 'crypto';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {configureStreamingSharedResources} from '../src/services/agents/codex/stream.js';
it('uses the durable context hash after the in-memory cache has no entry',async()=>{
 const fixture=createTestDatabase(),socket='/tmp/no-rpc-needed-for-persisted-context',native='persisted-thread',text='shared discovery instructions';vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET',socket);
 try{
  getDb().prepare('INSERT INTO shared_resource_injections(scope_key,content_hash) VALUES(?,?)').run(`${socket}:${native}`,createHash('sha256').update(text).digest('hex'));
  await expect(configureStreamingSharedResources(native,text)).resolves.toBeUndefined();
 }finally{vi.unstubAllEnvs();fixture.cleanup();}
});

it('upgrades the old combined startup hash without injecting the same shared resources', async () => {
 const fixture = createTestDatabase();
 const socket = '/tmp/no-rpc-needed-to-upgrade-context', native = 'legacy-context-thread';
 const text = '<octoally_shared_resources>\n旧说明\n</octoally_shared_resources>';
 const skill = 'The platform skill agent-docs';
 const key = `${socket}:${native}`;
 vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', socket);
 try {
  getDb().prepare('INSERT INTO shared_resource_injections(scope_key,content_hash) VALUES(?,?)')
    .run(key, createHash('sha256').update(`${text}\n\n${skill}`).digest('hex'));
  await expect(configureStreamingSharedResources(native, text, skill)).resolves.toBeUndefined();
  expect(getDb().prepare('SELECT content_hash FROM shared_resource_injections WHERE scope_key=?').get(key))
    .toEqual({ content_hash: createHash('sha256').update(text).digest('hex') });
 } finally {
  vi.unstubAllEnvs();
  fixture.cleanup();
 }
});
