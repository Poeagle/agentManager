import Fastify,{type FastifyInstance} from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestDatabase} from './helpers/database.js';
import {createUser,createSession,authHook} from '../src/auth.js';
import {saveCodexEnvironment} from '../src/services/agents/codex/environments.js';
import {codexEnvironmentRoutes} from '../src/routes/codex-environments.js';
vi.mock('../src/services/agents/codex/account-transport.js',async original=>({...await original<typeof import('../src/services/agents/codex/account-transport.js')>(),accountCommandInput:vi.fn(async(_connection,script,input)=>execFileSync('python3',['-c',script],{input,encoding:'utf8',maxBuffer:256*1024})),closeAccountTransport:vi.fn(async()=>{})}));
let db:ReturnType<typeof createTestDatabase>,app:FastifyInstance,id:string,root:string,admin:string,member:string;
beforeEach(async()=>{db=createTestDatabase();root=mkdtempSync(join(tmpdir(),'account-config-'));const a=createUser({username:'config-admin',password:'password1',role:'admin'}),m=createUser({username:'config-member',password:'password1'});admin='agentmanager_session='+createSession(a.id);member='agentmanager_session='+createSession(m.id);id=(await saveCodexEnvironment({name:'fixture',connection:{username:'fixture',codexCommand:'codex',codexHome:root},allowed_user_ids:[m.id]})).id;app=Fastify();app.addHook('onRequest',authHook);await app.register(codexEnvironmentRoutes,{prefix:'/api'});});
afterEach(async()=>{await app.close();db.cleanup();rmSync(root,{recursive:true,force:true});});
const pathFor=()=>'/api/codex/environments/'+encodeURIComponent(id)+'/config-files';
describe('account configuration files',()=>{
 it('lists and edits only the selected account files, rejects stale writes, and hides credentials',async()=>{
  writeFileSync(join(root,'config.toml'),'model = "example"\n');writeFileSync(join(root,'AGENTS.md'),'Follow the rules\n');writeFileSync(join(root,'auth.json'),'private credential');
  const list=await app.inject({url:pathFor(),headers:{cookie:admin}});expect(list.statusCode).toBe(200);expect(list.json().files.map((x:{id:string})=>x.id)).toEqual(['config','instructions','override']);expect(list.body).not.toContain('auth.json');
  const read=await app.inject({url:pathFor()+'?file=config',headers:{cookie:admin}});expect(read.json().content).toBe('model = "example"\n');
  const saved=await app.inject({method:'PUT',url:pathFor(),headers:{cookie:admin},payload:{file:'config',content:'model = "new"\n',revision:read.json().revision}});expect(saved.statusCode).toBe(200);expect(readFileSync(join(root,'config.toml'),'utf8')).toContain('new');
  const stale=await app.inject({method:'PUT',url:pathFor(),headers:{cookie:admin},payload:{file:'config',content:'overwrite',revision:read.json().revision}});expect(stale.statusCode).toBe(409);expect(readFileSync(join(root,'config.toml'),'utf8')).toContain('new');
  const deny=await app.inject({url:pathFor()+'?file=auth.json',headers:{cookie:admin}});expect(deny.statusCode).toBe(400);
  writeFileSync(join(root,'config.toml'),'api_key = "sk-example-secret"');const secret=await app.inject({url:pathFor()+'?file=config',headers:{cookie:admin}});expect(secret.statusCode).toBe(400);expect(secret.body).not.toContain('sk-example-secret');
  writeFileSync(join(root,'config.toml'),'{\"api_key\":\"private\"}');const jsonSecret=await app.inject({url:pathFor()+'?file=config',headers:{cookie:admin}});expect(jsonSecret.statusCode).toBe(400);expect(jsonSecret.body).not.toContain('private');
 });
 it('lists a configured catalog only within the selected account and enforces the file size bound',async()=>{
  writeFileSync(join(root,'config.toml'),'model_catalog_json = "model-catalog.json"\n');writeFileSync(join(root,'model-catalog.json'),'{"models":[]}');
  const list=await app.inject({url:pathFor(),headers:{cookie:admin}});expect(list.json().files.map((x:{id:string})=>x.id)).toContain('catalog');
  const catalog=await app.inject({url:pathFor()+'?file=catalog',headers:{cookie:admin}});expect(catalog.json().content).toBe('{"models":[]}');
  writeFileSync(join(root,'model-catalog.json'),'x'.repeat(96*1024+1));const large=await app.inject({url:pathFor()+'?file=catalog',headers:{cookie:admin}});expect(large.statusCode).toBe(400);
  writeFileSync(join(root,'auth.json'),'{}');writeFileSync(join(root,'config.toml'),'model_catalog_json = "auth.json"\n');const authCatalog=await app.inject({url:pathFor(),headers:{cookie:admin}});expect(authCatalog.json().files.map((x:{id:string})=>x.id)).not.toContain('catalog');expect(authCatalog.body).not.toContain('auth.json');
  writeFileSync(join(root,'config.toml'),'model_catalog_json = "/etc/passwd"\n');const external=await app.inject({url:pathFor(),headers:{cookie:admin}});expect(external.json().files.map((x:{id:string})=>x.id)).not.toContain('catalog');expect(external.body).not.toContain('/etc/passwd');
 });
 it('rejects unauthorized access and paths that resolve outside the account directory',async()=>{
  const denied=await app.inject({url:pathFor(),headers:{cookie:member}});expect(denied.statusCode).toBe(403);const deniedWrite=await app.inject({method:'PUT',url:pathFor(),headers:{cookie:member},payload:{file:'config',content:'x',revision:'0'.repeat(64)}});expect(deniedWrite.statusCode).toBe(403);
  symlinkSync('/etc/passwd',join(root,'AGENTS.md'));
  const list=await app.inject({url:pathFor(),headers:{cookie:admin}});expect(list.body).not.toContain('/etc/passwd');
  const read=await app.inject({url:pathFor()+'?file=instructions',headers:{cookie:admin}});expect(read.statusCode).toBe(404);
 });
});
