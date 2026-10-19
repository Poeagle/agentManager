import {existsSync,mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {getDb} from '../src/db/index.js';
import {detectWorkAgent,detectWorkAgents} from '../src/services/platform-ai/agents.js';
import {createTestDatabase} from './helpers/database.js';
let cleanup:()=>void, dir:string;
beforeEach(()=>{({cleanup,dir}=createTestDatabase());vi.stubEnv('SHELL','/bin/sh');});
afterEach(()=>{vi.unstubAllEnvs();cleanup();});
const command=(cli:string,value:string)=>getDb().prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(`session_${cli}_command`,value);
it('discovers configured executables without running them or installing anything',async()=>{
  const bin=join(dir,'bin with spaces');mkdirSync(bin);
  const executable=join(bin,'test-agent'), sentinel=join(dir,'must-not-exist');
  writeFileSync(executable,`#!/bin/sh\ntouch '${sentinel}'\n`,{mode:0o700});
  command('codex',`'${executable}' --model test`);command('claude',join(dir,'missing-claude'));
  expect(await detectWorkAgents(dir)).toMatchObject([{cli_type:'codex',status:'available'},{cli_type:'claude',status:'unavailable'}]);
  expect(existsSync(sentinel)).toBe(false);
});
it('rechecks before launch and does not mistake a custom wrapper for a ready Agent',async()=>{
  command('codex','npx custom-agent');
  expect((await detectWorkAgent('codex',dir,true)).status).toBe('unknown');
  command('codex',join(dir,'missing-codex'));
  expect((await detectWorkAgent('codex',dir,true)).status).toBe('unavailable');
});
