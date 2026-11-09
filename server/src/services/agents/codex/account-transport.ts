import {spawn,execFile,type ChildProcess} from 'child_process';
import {promisify} from 'util';
import {createHash} from 'crypto';
import {mkdir,unlink,writeFile,readFile} from 'fs/promises';
import {dirname,join} from 'path';
import {homedir} from 'os';
import {config} from '../../../config.js';
import {shellSingleQuote} from '../shell.js';
import {waitForSocketReady} from './process-lifecycle.js';
const execute=promisify(execFile);
export interface AccountConnection {username:string;port:number;identityFile:string;codexCommand:string;codexHome:string;authMethod?:'key'|'password';password?:string;passwordConfigured?:boolean}
export class AccountConnectionError extends Error {constructor(readonly stage:string,message:string){super(message);}}
export function validateAccountConnection(value:unknown,options:{stored?:boolean}={}):AccountConnection {
 const p=value as Record<string,unknown>;
 if(!p||typeof p!=='object'||! /^[a-z_][a-z0-9_-]{0,63}\$?$/i.test(String(p.username||'')))throw Object.assign(Error('请输入有效的本机系统用户名'),{statusCode:400});
 const port=Number(p.port??22);
 if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(Error('SSH 端口必须在 1–65535 之间'),{statusCode:400});
 const field=(name:string,fallback='')=>{const v=p[name]??fallback;if(typeof v!=='string'||v.length>2048||/[\0\r\n]/.test(v))throw Object.assign(Error('连接配置字段无效：'+name),{statusCode:400});return v.trim();};
 const authMethod=p.authMethod??'key';if(authMethod!=='key'&&authMethod!=='password')throw Object.assign(Error('SSH 认证方式必须为密码或密钥'),{statusCode:400});
 if(p.password!==undefined&&(typeof p.password!=='string'||p.password.length>4096||/[\0\r\n]/.test(p.password)))throw Object.assign(Error('SSH 密码格式无效'),{statusCode:400});
 const identityFile=field('identityFile'),codexHome=field('codexHome'),codexCommand=field('codexCommand','codex');
 if(identityFile&&!identityFile.startsWith('/')&&!identityFile.startsWith('~/'))throw Object.assign(Error('SSH 私钥路径必须为绝对路径或 ~/ 路径'),{statusCode:400});
 if(codexHome&&!codexHome.startsWith('/'))throw Object.assign(Error('CODEX_HOME 必须为目标用户下的绝对路径，或留空使用默认值'),{statusCode:400});
 if(!codexCommand||!options.stored&&/\s/.test(codexCommand)||!(/^[\w.+-]+$/.test(codexCommand)||codexCommand.startsWith('/')))throw Object.assign(Error('这里只填写 Codex 可执行文件，例如 codex 或 /home/用户名/.local/bin/codex，不要附加启动参数；会话权限由平台控制'),{statusCode:400});
 return {username:String(p.username),port,identityFile,codexCommand,codexHome,authMethod,...typeof p.password==='string'?{password:p.password}:{},...p.passwordConfigured===true?{passwordConfigured:true}:{}};
}
export function sshArguments(connection:AccountConnection):string[] {
 return ['-T','-p',String(connection.port),'-o',connection.authMethod==='password'?'BatchMode=no':'BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',...(connection.authMethod==='password'?['-o','PreferredAuthentications=password','-o','PubkeyAuthentication=no','-o','NumberOfPasswordPrompts=1']:[]),...(connection.authMethod!=='password'&&connection.identityFile?['-o','IdentitiesOnly=yes','-i',connection.identityFile.startsWith('~/')?join(homedir(),connection.identityFile.slice(2)):connection.identityFile]:[])];
}
/** OpenSSH asks a local helper for the password. Secrets stay out of argv,
 * helper files and stderr; key authentication never enables askpass. */
export async function sshEnvironment(connection:AccountConnection):Promise<NodeJS.ProcessEnv> {
 const env={...process.env};delete env.AGENTMANAGER_SSH_PASSWORD;
 if(connection.authMethod!=='password')return env;
 if(!connection.password)throw new AccountConnectionError('ssh_authentication','请填写 SSH 登录密码，或使用已保存的密码');
 const directory=join(dirname(config.dbPath),'account-ssh');await mkdir(directory,{recursive:true,mode:0o700});
 const helper=join(directory,'askpass-v1');
 const content='#!'+process.execPath+'\nprocess.stdout.write(process.env.AGENTMANAGER_SSH_PASSWORD || "");\n';
 try{await writeFile(helper,content,{mode:0o700,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await readFile(helper,'utf8')!==content)throw new AccountConnectionError('ssh_authentication','SSH 密码助手文件不匹配，请检查平台数据目录');}
 return {...env,SSH_ASKPASS:helper,SSH_ASKPASS_REQUIRE:'force',DISPLAY:env.DISPLAY||':0',AGENTMANAGER_SSH_PASSWORD:connection.password};
}
function connectionFailure(stderr:string):AccountConnectionError {
 if(/host key verification|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))return new AccountConnectionError('ssh_host_key','本机 SSH 主机密钥未受信任或已变更，请先在平台运行用户的终端确认 127.0.0.1 主机指纹');
 if(/Permission denied|authentication failed|no such identity|Load key/i.test(stderr))return new AccountConnectionError('ssh_authentication','SSH 认证失败，请检查系统用户名、SSH 密码或密钥，以及服务端允许的认证方式');
 if(/Connection refused/i.test(stderr))return new AccountConnectionError('ssh_connection','无法连接本机 SSH 端口，请检查 sshd 是否运行及端口配置');
 if(/timed out|No route to host|Connection reset/i.test(stderr))return new AccountConnectionError('ssh_connection','本机 SSH 连接超时或中断，请检查 sshd 和本机网络策略');
 if(/CODEX_LOGIN_REQUIRED/.test(stderr))return new AccountConnectionError('codex_authentication','该系统用户尚未登录 Codex，请先以该系统用户在终端运行 codex login');
 if(/ENGINE_PRESENT_NOT_READY/.test(stderr))return new AccountConnectionError('codex_process','目标用户的引擎进程存在但未就绪，请在该用户下检查引擎日志；平台不会仅凭 PID 杀死进程');
 if(/CODEX_NOT_FOUND/.test(stderr))return new AccountConnectionError('codex_executable','目标用户下找不到 Codex 命令，请安装 Codex 或填写绝对命令路径');
 if(/CODEX_PREFLIGHT_MODELS_FAILED/.test(stderr))return new AccountConnectionError('models','SSH 已连通，但目标用户的 Codex 无法读取模型目录，请检查该用户的 Codex 配置和版本');
 if(/PROJECT_ACCESS/.test(stderr))return new AccountConnectionError('project_access','目标系统用户无法读写该项目目录，请检查项目目录权限');
 if(/HISTORY_ACCESS/.test(stderr))return new AccountConnectionError('history_access','目标用户无法读取该会话历史文件');
 if(/python3.*not found|python3:/.test(stderr))return new AccountConnectionError('runtime','目标用户下找不到 python3，无法执行本机连接检查');
 return new AccountConnectionError('codex_process','目标用户的 Codex 进程操作失败，请检查该用户的 Codex 安装、启动参数及进程日志');
}
export async function accountCommand(connection:AccountConnection,script:string,timeout=10000):Promise<string> {
 try {const result=await execute('ssh',[...sshArguments(connection),`${connection.username}@127.0.0.1`,`python3 -c ${shellSingleQuote(script)}`],{timeout,maxBuffer:128*1024,env:await sshEnvironment(connection)});return result.stdout.trim();}
 catch(e){if(e instanceof AccountConnectionError)throw e;const error=e as {stderr?:string;code?:string};if(error.code==='ENOENT')throw new AccountConnectionError('ssh_executable','平台运行环境找不到 ssh 命令');throw connectionFailure(error.stderr||String(error.code||''));}
}
/** Send file content over stdin; it never appears in command arguments or logs. */
async function commandInput(command:string,args:string[],env:NodeJS.ProcessEnv,input:string):Promise<string> {
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],env});
  let output='',error='',settled=false;
  const finish=(failure?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);failure?reject(failure):resolve(output.trim());};
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('账号文件操作超时'));},15000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{output+=chunk;if(Buffer.byteLength(output)>768*1024){child.kill('SIGTERM');finish(new Error('账号文件响应过大'));}});
  child.stderr.on('data',(chunk:Buffer)=>{if(error.length<4096)error+=chunk.toString();});
  child.on('error',()=>finish(new Error('无法启动文件操作')));
  child.on('close',code=>finish(code===0?undefined:connectionFailure(error)));
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export async function accountCommandInput(connection:AccountConnection,script:string,input:string):Promise<string> {
 return commandInput('ssh',[...sshArguments(connection),`${connection.username}@127.0.0.1`,`python3 -c ${shellSingleQuote(script)}`],await sshEnvironment(connection),input);
}
export async function localCommandInput(script:string,input:string):Promise<string> {
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,LANG:process.env.LANG};
 return commandInput('python3',['-c',script],env,input);
}
const launchScript=(c:AccountConnection,tag:string)=>`import os,pathlib,shutil,socket,subprocess,json,sys
home=pathlib.Path.home()
os.environ['PATH']=str(home/'.local/bin')+':/usr/local/bin:/usr/bin:/bin:'+os.environ.get('PATH','')
command=shutil.which(${JSON.stringify(c.codexCommand)})
if not command:sys.exit('CODEX_NOT_FOUND')
if ${JSON.stringify(c.codexHome)}:os.environ['CODEX_HOME']=${JSON.stringify(c.codexHome)}
try:logged_in=subprocess.run([command,'login','status'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=6).returncode==0
except subprocess.TimeoutExpired:sys.exit('CODEX_LOGIN_REQUIRED')
if not logged_in:sys.exit('CODEX_LOGIN_REQUIRED')
directory=home/'.agentmanager-codex'/${JSON.stringify(tag)}
directory.mkdir(parents=True,exist_ok=True,mode=0o700)
path=str(directory/'c.sock')
if len(path.encode())>=104:sys.exit('SOCKET_PATH_TOO_LONG')
s=socket.socket(socket.AF_UNIX);s.settimeout(1)
ready=False
try:s.connect(path);ready=True
except OSError:pass
finally:s.close()
if not ready:
 pidfile=directory/'pid'
 if pidfile.exists():
  try:os.kill(int(pidfile.read_text()),0)
  except (ProcessLookupError,ValueError):pass
  else:sys.exit('ENGINE_PRESENT_NOT_READY')
 pathlib.Path(path).unlink(missing_ok=True)
 env=dict(os.environ)
 if ${JSON.stringify(c.codexHome)}:env['CODEX_HOME']=${JSON.stringify(c.codexHome)}
 with open(directory/'engine.log','ab') as log:
  child=subprocess.Popen([command,'app-server','--listen','unix://'+path,'--disable','plugins','-c','analytics.enabled=false'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env=env,cwd=str(home))
 pidfile.write_text(str(child.pid));os.chmod(pidfile,0o600)
print(json.dumps({'socket':path,'home':${JSON.stringify(c.codexHome)} or str(home/'.codex'),'command':command}))`;
const tunnels=new Map<string,{child:ChildProcess;socket:string;home:string;fingerprint:string}>();
const starting=new Map<string,Promise<{socket:string;home:string}>>();
export async function ensureAccountTransport(id:string,connection:AccountConnection):Promise<{socket:string;home:string}> {
 const fingerprint=createHash('sha256').update(JSON.stringify([config.dbPath,connection])).digest('hex');const current=tunnels.get(id);
 if(current&&current.fingerprint===fingerprint&&current.child.exitCode===null&&!current.child.killed&&await waitForSocketReady(current.socket,100))return current;
 if(starting.has(id))return starting.get(id)!;
 const work=(async()=>{
  await closeAccountTransport(id);
  const tag=createHash('sha256').update(config.dbPath+':'+id).digest('hex').slice(0,12);
  const remote=JSON.parse(await accountCommand(connection,launchScript(connection,tag))) as {socket:string;home:string};
  if(!remote.socket?.startsWith('/')||!remote.home?.startsWith('/'))throw new AccountConnectionError('codex_process','目标用户返回了无效的引擎路径');
  const directory=join(dirname(config.dbPath),'account-tunnels');await mkdir(directory,{recursive:true,mode:0o700});const socket=join(directory,tag+'.sock');
  if(Buffer.byteLength(socket)>=104)throw new AccountConnectionError('socket_path','平台数据库目录过长，无法创建本机 Unix socket');
  await unlink(socket).catch(()=>{});
  const child=spawn('ssh',[...sshArguments(connection),'-N','-o','ExitOnForwardFailure=yes','-L',`${socket}:${remote.socket}`,`${connection.username}@127.0.0.1`],{stdio:['ignore','ignore','pipe'],env:await sshEnvironment(connection)});
  let errorText='';child.stderr?.on('data',data=>{errorText=(errorText+String(data)).slice(-4096);});child.on('error',()=>{errorText='ssh unavailable';});
  tunnels.set(id,{child,socket,home:remote.home,fingerprint});
  child.once('exit',()=>{if(tunnels.get(id)?.child===child)tunnels.delete(id);});
  if(!await waitForSocketReady(socket,6000)){await closeAccountTransport(id);throw errorText?connectionFailure(errorText):new AccountConnectionError('codex_socket','SSH 已连接，但 Codex 引擎未就绪，请检查目标用户的引擎日志');}
  return {socket,home:remote.home};
 })();starting.set(id,work);try{return await work;}finally{starting.delete(id);}
}
export async function closeAccountTransport(id:string):Promise<void> {
 const current=tunnels.get(id);if(!current)return;tunnels.delete(id);current.child.kill('SIGTERM');await unlink(current.socket).catch(()=>{});
}
export async function closeAccountTransports():Promise<void>{await Promise.all([...tunnels.keys()].map(closeAccountTransport));}
export async function checkAccountProject(c:AccountConnection,path:string):Promise<void>{await accountCommand(c,`import os,sys,tempfile\np=${JSON.stringify(path)}\nif not os.path.isdir(p) or not os.access(p,os.R_OK|os.W_OK|os.X_OK):sys.exit('PROJECT_ACCESS')\nwith tempfile.NamedTemporaryFile(dir=p,prefix='.codex-access-check-') as f:f.write(b'ok')\nprint('ok')`);}

/** Read-only connection/model probe. It uses the account's existing login and
 * terminates only its own temporary stdio child; no model turn is submitted. */
export async function probeAccountConnection(c:AccountConnection,projectPath?:string):Promise<{models:Array<{model:string;name:string;description:string;efforts:Array<{value:string;description:string}>;defaultEffort:string}>}> {
 const script=`import os,pathlib,shutil,subprocess,sys,json,select,time,tempfile
os.environ['PATH']=str(pathlib.Path.home()/'.local/bin')+':/usr/local/bin:/usr/bin:/bin:'+os.environ.get('PATH','')
command=shutil.which(${JSON.stringify(c.codexCommand)})
if not command:sys.exit('CODEX_NOT_FOUND')
if ${JSON.stringify(c.codexHome)}:os.environ['CODEX_HOME']=${JSON.stringify(c.codexHome)}
if subprocess.run([command,'login','status'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=6).returncode:sys.exit('CODEX_LOGIN_REQUIRED')
project=${projectPath?JSON.stringify(projectPath):'None'}
if project:
 if not os.path.isdir(project) or not os.access(project,os.R_OK|os.W_OK|os.X_OK):sys.exit('PROJECT_ACCESS')
 with tempfile.NamedTemporaryFile(dir=project,prefix='.codex-access-check-') as f:f.write(b'ok')
p=subprocess.Popen([command,'app-server','--disable','plugins','-c','analytics.enabled=false'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
seq=0;buffer=b'';deadline=time.monotonic()+18
stage='initialize'
def request(method,params):
 global seq,buffer,stage
 stage=method;seq+=1;ident=seq
 p.stdin.write((json.dumps({'id':ident,'method':method,'params':params})+'\\n').encode());p.stdin.flush()
 while time.monotonic()<deadline:
  while b'\\n' in buffer:
   line,buffer=buffer.split(b'\\n',1)
   try:message=json.loads(line)
   except ValueError:continue
   if message.get('id')==ident and 'method' not in message:
    if 'error' in message:raise RuntimeError(method)
    return message.get('result',{})
  if p.poll() is not None:raise RuntimeError(method)
  ready,_,_=select.select([p.stdout],[],[],min(1,max(0,deadline-time.monotonic())))
  if ready:
   data=os.read(p.stdout.fileno(),65536)
   if not data:raise RuntimeError(method)
   buffer+=data
   if len(buffer)>4194304:raise RuntimeError(method)
 raise RuntimeError(method)
try:
 request('initialize',{'clientInfo':{'name':'octoally-account-preflight','version':'1.0.0'},'capabilities':{'experimentalApi':True}})
 p.stdin.write(b'{"method":"initialized"}\\n');p.stdin.flush()
 auth=request('account/read',{})
 if not auth.get('account') and auth.get('requiresOpenaiAuth',True):sys.exit('CODEX_LOGIN_REQUIRED')
 models=[];cursor=None
 for page in range(16):
  result=request('model/list',{'limit':100,'includeHidden':False,'cursor':cursor})
  for item in result.get('data',[]):
   if item.get('hidden') or not item.get('model'):continue
   efforts=[{'value':e['reasoningEffort'],'description':e.get('description','')} for e in item.get('supportedReasoningEfforts',[]) if isinstance(e.get('reasoningEffort'),str)]
   models.append({'model':item['model'],'name':item.get('displayName') or item['model'],'description':item.get('description') or '', 'efforts':efforts,'defaultEffort':item.get('defaultReasoningEffort') or (efforts[0]['value'] if efforts else '')})
  cursor=result.get('nextCursor')
  if not cursor:break
 if not models:sys.exit('CODEX_PREFLIGHT_MODELS_FAILED')
 print(json.dumps({'models':models}))
except (RuntimeError,ValueError,OSError):sys.exit('CODEX_PREFLIGHT_MODELS_FAILED')
finally:
 if p.poll() is None:
  p.terminate()
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:p.kill();p.wait()
`;
 return JSON.parse(await accountCommand(c,script,30000));
}
