import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'events';
import {PassThrough} from 'stream';
import {createTestDatabase} from './helpers/database.js';
const state=vi.hoisted(()=>({execute:vi.fn(),forward:vi.fn(),ready:vi.fn(async()=>true)}));
vi.mock('child_process',async original=>{(state.execute as any)[Symbol.for('nodejs.util.promisify.custom')]=(...args:any[])=>new Promise((resolve,reject)=>state.execute(...args,(error:unknown,stdout:string,stderr:string)=>error?reject(error):resolve({stdout,stderr})));return {...await original<typeof import('child_process')>(),execFile:state.execute,spawn:state.forward};});
vi.mock('../src/services/agents/codex/process-lifecycle.js',()=>({waitForSocketReady:state.ready}));
import {readFile,stat} from 'fs/promises';
import {execFileSync} from 'child_process';
import {sshArguments,sshEnvironment,accountCommand,ensureAccountTransport,closeAccountTransports,validateAccountConnection} from '../src/services/agents/codex/account-transport.js';
const connection={username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''};
let db:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{
 vi.clearAllMocks();db=createTestDatabase();state.ready.mockResolvedValue(true);
 state.execute.mockImplementation((_cmd,_args,_options,callback)=>callback(null,JSON.stringify({socket:'/fixture/engine.sock',home:'/fixture/.codex'}),''));
 state.forward.mockImplementation(()=>{const child:any=new EventEmitter();child.exitCode=null;child.killed=false;child.stderr=new PassThrough();child.kill=vi.fn(()=>{child.killed=true;child.emit('exit',0);return true;});return child;});
});
afterEach(async()=>{await closeAccountTransports();db.cleanup();});
describe('same-machine account SSH transport',()=>{
 it.each(['codex --dangerously-bypass-approvals-and-sandbox','/home/fixture/.local/bin/codex --dangerously-bypass-approvals-and-sandbox'])('explains that %s contains CLI flags before any SSH attempt',value=>{expect(()=>validateAccountConnection({...connection,codexCommand:value})).toThrow('不要附加启动参数');expect(state.execute).not.toHaveBeenCalled();});
 it.each(['codex','/home/fixture/.local/bin/codex'])('accepts the executable %s without requiring interactive CLI flags',value=>{expect(validateAccountConnection({...connection,codexCommand:value}).codexCommand).toBe(value);});

 it.each([
  ['Permission denied (publickey).','ssh_authentication','认证失败'],
  ['Host key verification failed.','ssh_host_key','主机密钥'],
  ['Connection refused','ssh_connection','sshd'],
  ['CODEX_LOGIN_REQUIRED','codex_authentication','codex login'],
  ['CODEX_NOT_FOUND','codex_executable','Codex 命令'],
  ['PROJECT_ACCESS','project_access','目录权限'],
  ['ENGINE_PRESENT_NOT_READY','codex_process','不会仅凭 PID'],
 ])('reports %s by stage without exposing stderr',async(stderr,stage,message)=>{
  state.execute.mockImplementationOnce((_cmd,_args,_options,callback)=>callback(Object.assign(Error('private error'),{stderr:stderr+' SECRET_VALUE',code:255}),'',''));
  const error=await accountCommand(connection,'print("ok")').catch(e=>e);expect(error).toMatchObject({stage,message:expect.stringContaining(message)});expect(error.message).not.toContain('SECRET_VALUE');
 });
 it('quotes the target script and fixes the destination to localhost',async()=>{await accountCommand(connection,"print('quoted $HOME; `id`')");const [command,args]=state.execute.mock.calls[0];expect(command).toBe('ssh');expect(args).toContain('fixture@127.0.0.1');expect(args).toContain('StrictHostKeyChecking=yes');expect(args.at(-1)).toContain("'\\''");});
 it('reuses a single tunnel for concurrent launches and closes only that tunnel',async()=>{
  const results=await Promise.all([ensureAccountTransport('account:fixture',connection),ensureAccountTransport('account:fixture',connection)]);expect(results[0].socket).toBe(results[1].socket);expect(state.execute).toHaveBeenCalledOnce();expect(state.forward).toHaveBeenCalledOnce();
  const launch=state.execute.mock.calls[0][1].at(-1) as string;expect(launch).toContain('CODEX_LOGIN_REQUIRED');expect(launch).not.toContain('SIGKILL');
  const child=state.forward.mock.results[0].value;await closeAccountTransports();expect(child.kill).toHaveBeenCalledWith('SIGTERM');
 });
 it('isolates two accounts into different forwarding sockets',async()=>{const a=await ensureAccountTransport('account:a',connection),b=await ensureAccountTransport('account:b',{...connection,username:'second'});expect(a.socket).not.toBe(b.socket);expect(state.forward.mock.calls.map(c=>c[1].at(-1))).toEqual(['fixture@127.0.0.1','second@127.0.0.1']);});
 it('uses password askpass without including a password in argv or helper files',async()=>{
  const secret="fixture password '$() test";const c={...connection,authMethod:'password' as const,password:secret};const env=await sshEnvironment(c);
  expect(sshArguments(c)).toContain('PreferredAuthentications=password');expect(sshArguments(c)).not.toContain(secret);
  const helper=env.SSH_ASKPASS!;expect((await stat(helper)).mode&0o777).toBe(0o700);expect(await readFile(helper,'utf8')).not.toContain(secret);
  expect(execFileSync(helper,[],{env,encoding:'utf8'})).toBe(secret);
  await accountCommand(c,'print("ok")');expect(state.execute.mock.calls[0][1].join(' ')).not.toContain(secret);expect(state.execute.mock.calls[0][2].env.AGENTMANAGER_SSH_PASSWORD).toBe(secret);
 });
 it('rejects missing password authentication without spawning SSH',async()=>{await expect(accountCommand({...connection,authMethod:'password'},'print("ok")')).rejects.toMatchObject({stage:'ssh_authentication'});expect(state.execute).not.toHaveBeenCalled();});
 it('rejects command injection and relative credential paths before invoking SSH',()=>{for(const value of [{...connection,username:'-oProxyCommand=id'},{...connection,codexCommand:'codex; id'},{...connection,identityFile:'secret/key'}])expect(()=>validateAccountConnection(value)).toThrow();expect(state.execute).not.toHaveBeenCalled();});
});
