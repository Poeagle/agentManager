import {spawn} from 'child_process';
import {createReadStream,createWriteStream} from 'fs';
import {mkdir,unlink,access,copyFile,rename,stat,chmod,realpath,open} from 'fs/promises';
import {dirname,join,sep} from 'path';
import {randomUUID,createHash} from 'crypto';
import {homedir} from 'os';
import {pipeline} from 'stream/promises';
import {Transform} from 'stream';
import {config} from '../../../config.js';
import {shellSingleQuote} from '../shell.js';
import {sshArguments,sshEnvironment,type AccountConnection,accountCommand} from './account-transport.js';
import {getCodexEnvironment,environmentConnection,type CodexEnvironment} from './environments.js';
import {readAgentManagement} from '../management-store.js';
import {runInCodexEngine,engineForThread} from './engine-context.js';
import {findCodexRollout} from '../../prompt-context.js';
const MAX_BYTES=1024*1024*1024;
const cached=new Map<string,{until:number;path:string;signature:string}>();
const pending=new Map<string,Promise<string|null>>();
/** Drop a private history mirror after its source Codex rollout is deleted. */
export async function forgetEnvironmentRollout(environmentId:string,nativeId:string):Promise<void> {
 const key=JSON.stringify([config.dbPath,environmentId,nativeId]);
 await pending.get(key)?.catch(()=>null);
 const previous=cached.get(key);cached.delete(key);
 const directory=join(dirname(config.dbPath),'account-history',createHash('sha256').update(environmentId).digest('hex').slice(0,12));
 await unlink(previous?.path||join(directory,nativeId+'.jsonl')).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
}
export function localHome(e:CodexEnvironment):string {
 if(e.kind==='native')return process.env.CODEX_HOME||join(homedir(),'.codex');
 const provider=readAgentManagement('codex').providers.find(p=>p.id===e.provider);
 const value=typeof provider?.fields.codexHome==='string'?provider.fields.codexHome:join(homedir(),'.codex-agentmanager',e.provider!);
 return value.startsWith('~/')?join(homedir(),value.slice(2)):value;
}
function accountRoot(c:AccountConnection):string{return c.codexHome?JSON.stringify(c.codexHome):"str(pathlib.Path.home()/'.codex')";}
export async function historyFileCommand(c:AccountConnection|null,script:string,source:string,destination:string,direction:'read'|'write'):Promise<void> {
 const child=c?spawn('ssh',[...sshArguments(c),`${c.username}@127.0.0.1`,`python3 -c ${shellSingleQuote(script)}`],{stdio:['pipe','pipe','pipe'],env:await sshEnvironment(c)}):spawn('python3',['-c',script],{stdio:['pipe','pipe','pipe']});
 child.stderr.resume();
 const done=new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(Error('SSH 文件传输启动失败')));child.once('close',code=>code===0?resolve():reject(Error('会话历史文件传输失败，请检查目标用户的目录权限')));});
 // Register rejection handlers before pumping bytes so an early exit is observed.
 void done.catch(()=>{});const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 let bytes=0;const bound=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>MAX_BYTES?Error('会话历史超过 1 GiB，本次迁移未执行'):null,chunk);}});
 try {
  if(direction==='read'){child.stdin.end();await Promise.all([pipeline(child.stdout,bound,createWriteStream(destination,{mode:0o600,flags:'wx'})),done]);}
  else {child.stdout.resume();await Promise.all([pipeline(createReadStream(source),bound,child.stdin),done]);}
 }catch(e){child.kill('SIGTERM');if(direction==='read')await unlink(destination).catch(()=>{});throw e;}finally{clearTimeout(timer);}
}
/** Keep the reader's generation/cursors when an account transcript only grows.
 * A genuine rewrite still publishes a new inode and triggers a full baseline. */
export async function publishHistoryMirror(temporary:string,destination:string):Promise<void> {
 let previous:Awaited<ReturnType<typeof open>>|undefined,incoming:Awaited<ReturnType<typeof open>>|undefined;
 let appended=false;
 try{
  previous=await open(destination,'r');incoming=await open(temporary,'r');
  const old=await previous.stat(),next=await incoming.stat();
  if(next.size>=old.size){
   const left=Buffer.alloc(65536),right=Buffer.alloc(65536);let offset=0,identical=true;
   while(offset<old.size){const size=Math.min(left.length,old.size-offset);const [a,b]=await Promise.all([previous.read(left,0,size,offset),incoming.read(right,0,size,offset)]);if(a.bytesRead!==size||b.bytesRead!==size||!left.subarray(0,size).equals(right.subarray(0,size))){identical=false;break;}offset+=size;}
   if(identical){if(next.size>old.size)await pipeline(createReadStream(temporary,{start:old.size}),createWriteStream(destination,{flags:'a'}));appended=true;}
  }
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 finally{await previous?.close();await incoming?.close();}
 if(appended)await unlink(temporary);else await rename(temporary,destination);
}
/** Account files remain private to the OS user. The platform reads only an
 * explicitly bound rollout through that user's authenticated local SSH path. */
export async function environmentRollout(context:{nativeId:string|null;session:{agent_environment_id?:string|null}}):Promise<string|null> {
 if(!context.nativeId)return null;
 const engine=await engineForThread(context.nativeId);
 const environmentId=engine.environmentId??(context.session.agent_environment_id||'native');
 const key=JSON.stringify([config.dbPath,environmentId,context.nativeId]);
 const prior=cached.get(key);if(prior&&prior.until>Date.now())return prior.path;
 if(pending.has(key))return pending.get(key)!;
 const work=(async()=>{
  const e=getCodexEnvironment(environmentId);
  let path:string|null=null;
  if(e.kind==='native')path=await findCodexRollout(context.nativeId!);
  else {
   const {withCodexConnection}=await import('./stream.js');
   try{
    const response=await runInCodexEngine(engine,()=>withCodexConnection(request=>request('thread/read',{threadId:context.nativeId})));
    path=response.thread?.path??null;
   }catch(error){
    const {CodexRpcError}=await import('./stream.js');
    if(error instanceof CodexRpcError&&error.nativeMessage===`thread not loaded: ${context.nativeId}`)return null;
    throw error;
   }
  }
  if(typeof path!=='string'||!path.startsWith('/')||!path.endsWith(context.nativeId+'.jsonl'))return null;
  const c=e.kind==='account'?environmentConnection(e):null;
  let home=e.kind==='account'?engine.accountHome!:localHome(e);
  let metadata:{size:number;mtime:string|number;base:boolean}|undefined;
  try{
   const file=await realpath(path);
   let authorized=false;
   for(const name of ['sessions','archived_sessions']){try{const root=await realpath(join(home,name));if(file.startsWith(root+sep))authorized=true;}catch{}}
   // Old records can lack an explicit provider binding; match only homes
   // enumerated by the legacy rollout lookup, then project their ancestry too.
   if(!authorized&&e.kind==='native'&&!context.session.agent_environment_id){
    for(const provider of readAgentManagement('codex').providers){
     const configured=provider.fields.codexHome;
     const value=typeof configured==='string'&&configured.trim()?configured.trim():join(homedir(),`.codex-${provider.id}`);
     const candidate=value==='~'?homedir():value.startsWith('~/')?join(homedir(),value.slice(2)):value;
     try{const root=await realpath(join(candidate,'sessions'));if(file.startsWith(root+sep)){home=candidate;authorized=true;break;}}catch{/* Unavailable provider home. */}
    }
   }
   if(authorized){
    const handle=await open(file,'r');let base=false;
    try{const buffer=Buffer.alloc(1024*1024);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);try{base=!!JSON.parse(buffer.subarray(0,bytesRead).toString().split('\n')[0]).payload?.history_base;}catch{}}finally{await handle.close();}
    if(!base){await access(file);return file;}
    const info=await stat(file);metadata={size:info.size,mtime:info.mtimeMs,base};
   }
  }catch{/* Read as the target user without broadening filesystem ACLs. */}
  if(!metadata){
   if(!c)throw Error('会话历史超出当前环境目录或不可读取');
   metadata=JSON.parse(await accountCommand(c,`import os,pathlib,json,sys\np=pathlib.Path(${JSON.stringify(path)}).resolve();root=pathlib.Path(${accountRoot(c)}).resolve()\nif not any(str(p).startswith(str(root/name)+'/') for name in ['sessions','archived_sessions']):sys.exit('HISTORY_ACCESS')\nwith p.open('rb') as f:\n try:base=bool(json.loads(f.readline(1048576)).get('payload',{}).get('history_base'))\n except:base=False\ns=p.stat();print(json.dumps({'size':s.st_size,'mtime':s.st_mtime_ns,'base':base}))`));
  }

  const signature=JSON.stringify(metadata);if(prior?.signature===signature){prior.until=Date.now()+2000;return prior.path;}
  if(metadata!.size>MAX_BYTES)throw Error('会话历史超过 1 GiB，无法生成跨用户历史副本');
  const directory=join(dirname(config.dbPath),'account-history',createHash('sha256').update(e.id).digest('hex').slice(0,12));await mkdir(directory,{recursive:true,mode:0o700});
  const destination=join(directory,context.nativeId+'.jsonl'),temporary=destination+'.'+randomUUID()+'.tmp';
  let script=`import pathlib,sys,shutil\np=pathlib.Path(${JSON.stringify(path)}).resolve();root=pathlib.Path(${c?accountRoot(c):JSON.stringify(home)}).resolve()\nif not any(str(p).startswith(str(root/name)+'/') for name in ['sessions','archived_sessions']):sys.exit('HISTORY_ACCESS')\nif p.stat().st_size>${MAX_BYTES}:sys.exit('HISTORY_TOO_LARGE')\nwith p.open('rb') as f:shutil.copyfileobj(f,sys.stdout.buffer)`;
  if(metadata!.base){const {FLATTEN_HISTORY}=await import('./history-bundle.js');script='import json\noptions=json.loads('+JSON.stringify(JSON.stringify({home,path}))+')\n'+FLATTEN_HISTORY;}
  await historyFileCommand(c,script,'',temporary,'read');await publishHistoryMirror(temporary,destination);
  cached.set(key,{path:destination,signature,until:Date.now()+2000});
  while(cached.size>64){const oldest=cached.keys().next().value!;const item=cached.get(oldest)!;cached.delete(oldest);await unlink(item.path).catch(()=>{});}
  return destination;
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
export async function stageEnvironmentHistory(id:string,file:string):Promise<{path:string;cleanup:()=>Promise<void>}> {
 const e=getCodexEnvironment(id);const name=randomUUID()+'.jsonl';
 if((await stat(file)).size>MAX_BYTES)throw Error('会话历史超过 1 GiB，本次迁移未执行');
 if(e.kind==='account'){
  const c=environmentConnection(e);const {home}=await (await import('./account-transport.js')).ensureAccountTransport(id,c);
  const path=home+'/.agentmanager-imports/'+name;
  const script=`import os,pathlib,sys,shutil\np=pathlib.Path(${JSON.stringify(path)});p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)\nwith p.open('xb') as f:\n os.chmod(p,0o600);shutil.copyfileobj(sys.stdin.buffer,f)`;
  try{await historyFileCommand(c,script,file,'','write');}catch(error){await accountCommand(c,`import pathlib\npathlib.Path(${JSON.stringify(path)}).unlink(missing_ok=True)`).catch(()=>{});throw error;}
  return {path,cleanup:async()=>{await accountCommand(c,`import pathlib\npathlib.Path(${JSON.stringify(path)}).unlink(missing_ok=True)`).catch(()=>{});}};
 }
 const directory=join(localHome(e),'.agentmanager-imports');await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,name);await copyFile(file,path);await chmod(path,0o600);
 return {path,cleanup:()=>unlink(path).catch(()=>{})};
}
