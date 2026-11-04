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
