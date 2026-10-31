import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'fs';import {join} from 'path';import{tmpdir}from'os';
const stub=vi.hoisted(()=>({agent:'codex_cli_rs/0.166.0'}));
vi.mock('../src/services/conversation-stream.js',()=>({withCodexConnection:vi.fn(async action=>action(vi.fn(),{userAgent:stub.agent}))}));
import {installedCodexVersion,prepareCodexReload} from '../src/services/codex-version.js';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'codex-version-'));writeFileSync(join(dir,'codex'),'#!/bin/sh\nprintf "codex-cli 0.166.0\\n"\n');chmodSync(join(dir,'codex'),0o755);vi.stubEnv('PATH',dir);vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET','/test.sock');stub.agent='codex_cli_rs/0.166.0';});
afterEach(()=>{vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
describe('reload version preflight',()=>{
 it('reads the installed CLI version and accepts a matching shared engine',async()=>{expect(await installedCodexVersion()).toBe('0.166.0');expect(await prepareCodexReload(true)).toBe('0.166.0');});
 it('refuses a shared engine mismatch before any client is stopped',async()=>{stub.agent='codex_cli_rs/0.163.0';await expect(prepareCodexReload(true)).rejects.toThrow('请先升级共享 Codex 服务');});
 it('forces a new installed-version read at reload time',async()=>{expect(await installedCodexVersion()).toBe('0.166.0');writeFileSync(join(dir,'codex'),'#!/bin/sh\nprintf "codex-cli 0.167.0\\n"\n');stub.agent='codex_cli_rs/0.167.0';expect(await prepareCodexReload(true)).toBe('0.167.0');});
});
