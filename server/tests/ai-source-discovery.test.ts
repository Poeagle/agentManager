import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {availableAiClients} from '../src/services/ai-source-discovery.js';
let root:string,bin:string,codex:string,claude:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'ai-discovery-'));bin=join(root,'bin');codex=join(root,'codex');claude=join(root,'claude');for(const dir of [bin,codex,claude])mkdirSync(dir);vi.stubEnv('PATH',bin);vi.stubEnv('CODEX_HOME',codex);vi.stubEnv('CLAUDE_CONFIG_DIR',claude);for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'])vi.stubEnv(key,'');});
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
const client=(kind:string)=>writeFileSync(join(bin,kind),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root,'calls')}'\nprintf '${kind} 0.166.0 PRIVATE_VERSION_OUTPUT\\n'\n`,{mode:0o755});
describe('read-only AI client discovery',()=>{
 it('detects executable, version, local login and cached models without inference or credential changes',async()=>{
  client('codex');const auth=JSON.stringify({tokens:{access_token:'header.'+Buffer.from(JSON.stringify({exp:4102444800})).toString('base64url')+'.PRIVATE_ACCESS',refresh_token:'PRIVATE_REFRESH'}});writeFileSync(join(codex,'auth.json'),auth);writeFileSync(join(codex,'config.toml'),'model = "configured-model"\n[secret]\napi_key="PRIVATE_CONFIG"');writeFileSync(join(codex,'models_cache.json'),JSON.stringify({identity:'PRIVATE_ACCOUNT',fetched_at:'2026-11-02T07:00:00Z',models:[{slug:'listed-model',display_name:'Listed',priority:2},{slug:'hidden-model',visibility:'hide'},{slug:'bad<script>'}]}));
  const result=await availableAiClients(true),found=result.find(item=>item.kind==='codex')!;expect(found).toMatchObject({installed:true,executable:join(bin,'codex'),version:'0.166.0',login:'detected',credential_source:'local',default_model:'configured-model'});expect(found.models.map(item=>item.id)).toEqual(['configured-model','listed-model']);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|refresh_token|access_token|api_key/);expect(readFileSync(join(codex,'auth.json'),'utf8')).toBe(auth);expect(readFileSync(join(root,'calls'),'utf8')).toBe('--version\n');await availableAiClients();expect(readFileSync(join(root,'calls'),'utf8')).toBe('--version\n');
 });
 it('reports absent clients and expired login without claiming verified model access',async()=>{
  writeFileSync(join(claude,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'PRIVATE_ACCESS',expiresAt:1000}}));writeFileSync(join(claude,'settings.json'),'{"model":"sonnet"}');const result=await availableAiClients(true);expect(result.find(item=>item.kind==='claude')).toMatchObject({installed:false,version:null,login:'expired',default_model:'sonnet',models:[{id:'sonnet'}]});expect(result.find(item=>item.kind==='codex')).toMatchObject({installed:false,login:'not_detected',default_model:null,models:[]});
 });
 it('reports environment credential presence without returning its value and tolerates invalid local metadata',async()=>{
  vi.stubEnv('ANTHROPIC_API_KEY','PRIVATE_API_SECRET');writeFileSync(join(codex,'auth.json'),'broken');const result=await availableAiClients(true);expect(result.find(item=>item.kind==='claude')).toMatchObject({login:'detected',credential_source:'environment'});expect(JSON.stringify(result)).not.toContain('PRIVATE_API_SECRET');expect(result.find(item=>item.kind==='codex')?.login).toBe('not_detected');
 });
});
