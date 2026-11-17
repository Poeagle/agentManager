import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'events';
import {PassThrough} from 'stream';
import {createTestDatabase} from './helpers/database.js';
const state=vi.hoisted(()=>({execute:vi.fn(),forward:vi.fn(),ready:vi.fn(async()=>true)}));
vi.mock('child_process',async original=>{(state.execute as any)[Symbol.for('nodejs.util.promisify.custom')]=(...args:any[])=>new Promise((resolve,reject)=>state.execute(...args,(error:unknown,stdout:string,stderr:string)=>error?reject(error):resolve({stdout,stderr})));return {...await original<typeof import('child_process')>(),execFile:state.execute,spawn:state.forward};});
vi.mock('../src/services/agents/codex/process-lifecycle.js',()=>({waitForSocketReady:state.ready}));
import {readFile,stat,writeFile,mkdir} from 'fs/promises';
import {execFileSync} from 'child_process';
import {sshArguments,sshEnvironment,checkAccountProject,checkAccountAttachments,accountCommand,accountCommandInput,localCommandInput,ensureAccountTransport,closeAccountTransports,validateAccountConnection} from '../src/services/agents/codex/account-transport.js';
const connection={username:'fixture',port:22,identityFile:'',codexCommand:'codex',codexHome:''};
let db:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{
 vi.clearAllMocks();db=createTestDatabase();state.ready.mockResolvedValue(true);
 state.execute.mockImplementation((_cmd,_args,_options,callback)=>callback(null,JSON.stringify({socket:'/fixture/engine.sock',home:'/fixture/.codex'}),''));
 state.forward.mockImplementation(()=>{const child:any=new EventEmitter();child.exitCode=null;child.killed=false;child.stderr=new PassThrough();child.kill=vi.fn(()=>{child.killed=true;child.emit('exit',0);return true;});return child;});
});
afterEach(async()=>{await closeAccountTransports();db.cleanup();});
describe('same-machine account SSH transport',()=>{
 it('accepts explicit usage-snapshot output bounds while keeping ordinary file reads bounded',async()=>{
  state.forward.mockImplementation(()=>{
   const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn();
   child.stdin.on('data',()=>{});child.stdin.on('end',()=>{child.stdout.write('x'.repeat(800*1024));child.stdout.end();child.emit('close',0);});return child;
  });
  await expect(localCommandInput('unused','')).rejects.toThrow('响应过大');
  expect((await localCommandInput('unused','',{maxOutputBytes:1024*1024,timeoutMs:300000})).length).toBe(800*1024);
 });
 it('sends file content through SSH stdin and decodes split UTF-8 output',async()=>{
  let input='';state.forward.mockImplementation((_command:string,args:string[])=>{
   expect(args.join(' ')).not.toContain('文件内容');
   const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn();
   child.stdin.on('data',(chunk:Buffer)=>{input+=chunk.toString();});child.stdin.on('end',()=>{const bytes=Buffer.from('中文');child.stdout.write(bytes.subarray(0,2));child.stdout.write(bytes.subarray(2));child.stdout.end();child.emit('close',0);});return child;
  });
  expect(await accountCommandInput(connection,'print("ok")','文件内容')).toBe('中文');expect(input).toBe('文件内容');
 });
 it('counts response bytes incrementally while preserving a large chunked response',async()=>{
  const original=Buffer.byteLength,measured:number[]=[];const measure=vi.spyOn(Buffer,'byteLength').mockImplementation(((value:any,...args:any[])=>{if(typeof value==='string')measured.push(value.length);return original(value,...args as []);}) as typeof Buffer.byteLength);
  state.forward.mockImplementation(()=>{const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn();child.stdin.on('end',()=>{for(let i=0;i<4096;i++)child.stdout.write('x'.repeat(1024));child.stdout.end();child.emit('close',0);});child.stdin.resume();return child;});
  try{const output=await localCommandInput('unused','',{maxOutputBytes:5*1024*1024});expect(output).toHaveLength(4*1024*1024);expect(Math.max(...measured)).toBeLessThanOrEqual(1024);}finally{measure.mockRestore();}
 });
 it('does not forward unrelated service environment values to local file helpers',async()=>{
  vi.stubEnv('TEST_UNRELATED_SERVICE_SECRET','dummy');state.forward.mockImplementation((_command:string,_args:string[],options:any)=>{
   expect(options.env.TEST_UNRELATED_SERVICE_SECRET).toBeUndefined();const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=vi.fn();
   child.stdin.on('data',()=>{});child.stdin.on('end',()=>{child.stdout.write('ok');child.stdout.end();child.emit('close',0);});return child;
  });
  try{expect(await localCommandInput('print("ok")','')).toBe('ok');}finally{vi.unstubAllEnvs();}
 });
 it.each(['codex --dangerously-bypass-approvals-and-sandbox','/home/fixture/.local/bin/codex --dangerously-bypass-approvals-and-sandbox'])('explains that %s contains CLI flags before any SSH attempt',value=>{expect(()=>validateAccountConnection({...connection,codexCommand:value})).toThrow('不要附加启动参数');expect(state.execute).not.toHaveBeenCalled();});
 it.each(['codex','/home/fixture/.local/bin/codex'])('accepts the executable %s without requiring interactive CLI flags',value=>{expect(validateAccountConnection({...connection,codexCommand:value}).codexCommand).toBe(value);});

 it.each([
  ['Permission denied (publickey).','ssh_authentication','认证失败'],
  ['Host key verification failed.','ssh_host_key','主机密钥'],
  ['Connection refused','ssh_connection','sshd'],
  ['CODEX_LOGIN_REQUIRED','codex_authentication','codex login'],
  ['CODEX_NOT_FOUND','codex_executable','Codex 命令'],
  ['PROJECT_ACCESS','project_access','目录权限'],
  ['ATTACHMENT_ACCESS','attachment_access','历史附件'],
  ['ENGINE_PRESENT_NOT_READY','codex_process','不会仅凭 PID'],
 ])('reports %s by stage without exposing stderr',async(stderr,stage,message)=>{
  state.execute.mockImplementationOnce((_cmd,_args,_options,callback)=>callback(Object.assign(Error('private error'),{stderr:stderr+' SECRET_VALUE',code:255}),'',''));
  const error=await accountCommand(connection,'print("ok")').catch(e=>e);expect(error).toMatchObject({stage,message:expect.stringContaining(message)});expect(error.message).not.toContain('SECRET_VALUE');if(stage==='ssh_host_key'){expect(error.message).toContain('StrictHostKeyChecking=ask');expect(error.message).not.toContain('StrictHostKeyChecking=no');}
 });
 it('allows retained readable attachments and expired paths without changing files',async()=>{
  const retained=db.dir+"/保留 '截图.png",expired=db.dir+'/expired.png';await writeFile(retained,'image');
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{
   try{callback(null,execFileSync('/bin/sh',['-c',args.at(-1)],{encoding:'utf8'}),'');}catch(e){callback(e,'','');}
  });
  await expect(checkAccountAttachments(connection,[expired,db.dir+'/removed-directory/expired.png',retained])).resolves.toBeUndefined();
  expect(await readFile(retained,'utf8')).toBe('image');await expect(stat(expired)).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each(['unreadable','inaccessible-parent','directory'])('reports %s as attachment access rather than project permissions',async(kind)=>{
  const path=db.dir+'/attachment';if(kind==='directory')await mkdir(path);else await writeFile(path,'image');
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{
   // Inject filesystem denial into the generated Python script so this stays deterministic even as root.
   const prefix=kind==='unreadable'?"import os; os.access=lambda *args: False\n":kind==='inaccessible-parent'?"import os\ndef denied(*args, **kwargs): raise PermissionError()\nos.stat=denied\n":'';
   const command=args.at(-1) as string;
   const script=execFileSync('/bin/sh',['-c',command.replace('python3 -c ','printf %s ')],{encoding:'utf8'});
   try{callback(null,execFileSync('python3',['-c',prefix+script],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),'');}catch(e){callback(e,'','');}
  });
  await expect(checkAccountAttachments(connection,[path])).rejects.toMatchObject({stage:'attachment_access',message:expect.stringContaining('历史附件')});
 });
 it('gives a narrowly scoped owner repair command that restores access to a retained file',async()=>{
  const path=db.dir+"/截图 '$HOME; touch unexpected.png";await writeFile(path,'image',{mode:0o200});
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{
   const script=execFileSync('/bin/sh',['-c',(args.at(-1) as string).replace('python3 -c ','printf %s ')],{encoding:'utf8'});
   const prefix="import os\noriginal_access=os.access\nos.access=lambda p, mode: False if p=="+JSON.stringify(path)+" and not os.stat(p).st_mode & 0o400 else original_access(p,mode)\n";
   try{callback(null,execFileSync('python3',['-c',prefix+script],{encoding:'utf8'}),'');}catch(e){callback(e,'','');}
  });
  const error=await checkAccountAttachments(connection,[path]).catch(e=>e);
  expect(error).toMatchObject({stage:'attachment_access'});expect(error.message).toContain(path);expect(error.message).toContain('fixture');
  const command=error.message.split('\n').find((line:string)=>line.startsWith('sudo -u'))!;
  // Execute only the generated chmod on our isolated fixture, without sudo or another OS account.
  execFileSync('/bin/sh',['-c',command.replace("sudo -u 'fixture' ", '')]);
  expect((await stat(path)).mode&0o600).toBe(0o600);
  await expect(checkAccountAttachments(connection,[path])).resolves.toBeUndefined();
 });
 it('quotes paths in administrator repair commands',async()=>{
  const path="/fixture/截图 '$(touch unexpected)\n.png";
  state.execute.mockImplementationOnce((_cmd,_args,_options,callback)=>callback(null,JSON.stringify({issues:[{path,reason:'permission'}],repairs:[{path,mode:'acl',permissions:'rw-'}]}),''));
  const error=await checkAccountAttachments(connection,[path]).catch(e=>e);
  expect(error.message).toContain('sudo setfacl -m');expect(error.message).not.toContain('chmod -R');
  // Parse the quoted command with the shell without executing its sudo/setfacl words.
  const start=error.message.indexOf('sudo setfacl'),end=error.message.indexOf('\nnamei',start);
  const parsed=execFileSync('/bin/sh',['-c',"set -- "+error.message.slice(start,end)+"; printf '%s\\0' \"$@\""],{encoding:'utf8'}).split('\0');
  expect(parsed.slice(0,-1)).toEqual(['sudo','setfacl','-m','u:fixture:rw-','--',path]);
 });
 it('merges the required read permission with existing named ACL write rights',async()=>{
  const path=db.dir+'/retained.png';await writeFile(path,'image');
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{
   const script=execFileSync('/bin/sh',['-c',(args.at(-1) as string).replace('python3 -c ','printf %s ')],{encoding:'utf8'});
   const prefix="import os,subprocess,types\noriginal_stat=os.stat\noriginal_access=os.access\np="+JSON.stringify(path)+"\ndef file_stat(path,*args,**kwargs):\n info=original_stat(path,*args,**kwargs)\n return types.SimpleNamespace(st_uid=os.getuid()+1,st_mode=info.st_mode) if path==p else info\nos.stat=file_stat\nos.access=lambda path,mode: False if path==p else original_access(path,mode)\nsubprocess.run=lambda *args,**kwargs: types.SimpleNamespace(returncode=0,stdout='user:'+str(os.getuid())+':-w-\\n')\n";
   try{callback(null,execFileSync('python3',['-c',prefix+script],{encoding:'utf8'}),'');}catch(e){callback(e,'','');}
  });
  const error=await checkAccountAttachments(connection,[path]).catch(e=>e);
  expect(error.message).toContain("sudo setfacl -m 'u:fixture:rw-'");
 });
 it('does not prescribe creating an empty project when the project directory is missing',async()=>{
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{try{callback(null,execFileSync('/bin/sh',['-c',args.at(-1)],{encoding:'utf8'}),'');}catch(e){callback(e,'','');}});
  const error=await checkAccountProject(connection,db.dir+'/missing-project').catch(e=>e);
  expect(error).toMatchObject({stage:'project_access'});expect(error.message).toContain('项目目录不存在');expect(error.message).toContain('namei -l');expect(error.message).not.toContain('mkdir');expect(error.message).not.toContain('sudo setfacl');
 });
 it('diagnoses a read-only project mount without suggesting permission changes',async()=>{
  state.execute.mockImplementation((_cmd,args,_options,callback)=>{
   const script=execFileSync('/bin/sh',['-c',(args.at(-1) as string).replace('python3 -c ','printf %s ')],{encoding:'utf8'});
   try{callback(null,execFileSync('python3',['-c',"import os,types\nos.statvfs=lambda path:types.SimpleNamespace(f_flag=os.ST_RDONLY)\n"+script],{encoding:'utf8'}),'');}catch(e){callback(e,'','');}
  });
  const error=await checkAccountProject(connection,db.dir).catch(e=>e);
  expect(error.message).toContain('只读挂载');expect(error.message).toContain('findmnt -T');expect(error.message).toContain('df -h');expect(error.message).not.toContain('sudo setfacl');expect(error.message).not.toContain('chmod u+');
 });
 it('includes target-specific login commands without returning configured passwords',async()=>{
  state.execute.mockImplementationOnce((_cmd,_args,_options,callback)=>callback(Object.assign(Error('hidden'),{stderr:'CODEX_LOGIN_REQUIRED PRIVATE_DETAIL'}),'',''));
  const error=await accountCommand({...connection,codexHome:'/fixture/private codex'},'unused').catch(e=>e);
  expect(error.message).toContain("sudo -iu 'fixture'");expect(error.message).toContain('CODEX_HOME');expect(error.message).toContain('login');expect(error.message).not.toContain('PRIVATE_DETAIL');
 });
 it('skips SSH attachment checks when no attachments were recorded',async()=>{await checkAccountAttachments(connection,[]);expect(state.execute).not.toHaveBeenCalled();});
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
