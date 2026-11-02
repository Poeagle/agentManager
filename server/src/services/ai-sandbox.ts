import {createServer} from 'http';
import {connect,type Socket} from 'net';
import {lookup} from 'dns/promises';
import {existsSync} from 'fs';
import {readFile,writeFile,realpath,stat} from 'fs/promises';
import {homedir} from 'os';
import {join,isAbsolute} from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
const exec=promisify(execFile);
const defaults=['api.openai.com','chatgpt.com','auth.openai.com','api.anthropic.com','claude.ai','platform.claude.com','console.anthropic.com'];
export function validateAiHosts(value:string|undefined){const list=value?JSON.parse(value):[];if(!Array.isArray(list)||list.length>16||list.some(host=>typeof host!=='string'||!/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(host)))throw Error('额外模型域名必须是 JSON 域名数组，不含通配符、路径、IP 或端口');return list.map(host=>host.toLowerCase());}
function publicAddress(ip:string){const [a,b,c]=ip.split('.').map(Number);return Number.isInteger(a)&&a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);}
export async function prepareAiSandbox(directory:string,executable:string,args:string[],hosts?:string,profile:'none'|'codex'|'claude'='none'){
 if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap')||!existsSync('/usr/bin/prlimit'))throw Error('本机 AI 需要 Linux bubblewrap 和 prlimit 隔离，未满足时禁止运行');
 const allowed=new Set([...defaults,...validateAiHosts(hosts)]),sockets=new Set<Socket>();
 const proxy=createServer((_req,res)=>{res.writeHead(403);res.end();});
 proxy.on('connect',(req,client,head)=>{const socket=client as Socket;sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));void(async()=>{
  const match=/^([a-zA-Z0-9.-]+):443$/.exec(req.url||'');if(!match||!allowed.has(match[1].toLowerCase())){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const addresses=await lookup(match[1],{all:true,family:4});if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('Blocked address');if(socket.destroyed)return;
  const upstream=connect({host:addresses[0].address,port:443});sockets.add(upstream);upstream.setTimeout(65000,()=>upstream.destroy());upstream.on('error',()=>socket.destroy());upstream.once('close',()=>{sockets.delete(upstream);socket.destroy();});socket.once('close',()=>upstream.destroy());upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
 })().catch(()=>socket.destroy());});
 const close=()=>{for(const socket of sockets)socket.destroy();proxy.close();};
 try{
  await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(join(directory,'proxy.sock'),resolve);});
  const credentials:Record<string,unknown>={};
  // Access tokens only: these disposable runs must not rotate or rewrite the
  // account's refresh token or original client configuration.
  for(const [kind,file] of [['codex',join(process.env.CODEX_HOME||join(homedir(),'.codex'),'auth.json')],['claude',join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'.credentials.json')]]){
   if(kind!==profile)continue;
   try{const raw=await readFile(file,'utf8');if(raw.length>512000)continue;const value=JSON.parse(raw);if(value.tokens)value.tokens.refresh_token='';if(value.claudeAiOauth)value.claudeAiOauth.refreshToken='';credentials[kind]=value;}catch{/* A client without reusable credentials reports an auth error. */}
  }
  const env:Record<string,string>={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/ai',CODEX_HOME:'/home/ai/.codex',CLAUDE_CONFIG_DIR:'/home/ai/.claude',LANG:'C.UTF-8',NODE_OPTIONS:'--max-old-space-size=256'};
  for(const key of (profile==='codex'?['OPENAI_API_KEY','CODEX_API_KEY']:profile==='claude'?['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']:[]))if(process.env[key])env[key]=process.env[key]!;
  const candidate=isAbsolute(executable)?executable:(await exec('/bin/sh',['-c','command -v -- "$1"','ai-client',executable],{timeout:2000,maxBuffer:4096})).stdout.trim();const command=await realpath(candidate);
  await writeFile(join(directory,'run.json'),JSON.stringify({command,args,credentials,env}),{mode:0o600});
  await writeFile(join(directory,'bootstrap.cjs'),`const fs=require('fs'),net=require('net'),cp=require('child_process');const config=JSON.parse(fs.readFileSync(${JSON.stringify(join(directory,'run.json'))},'utf8'));fs.mkdirSync('/home/ai/.codex',{recursive:true});fs.mkdirSync('/home/ai/.claude',{recursive:true});for(const [kind,value] of Object.entries(config.credentials)){fs.writeFileSync('/home/ai/.'+kind+'/'+(kind==='codex'?'auth.json':'.credentials.json'),JSON.stringify(value),{mode:384});}const server=net.createServer(client=>{const upstream=net.connect({path:${JSON.stringify(join(directory,'proxy.sock'))}});upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.pipe(upstream);upstream.pipe(client);});server.listen(0,'127.0.0.1',()=>{const proxy='http://127.0.0.1:'+server.address().port;const child=cp.spawn(config.command,config.args,{stdio:'inherit',env:{...config.env,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,NO_PROXY:'',no_proxy:''}});child.on('error',()=>process.exit(127));child.on('exit',code=>process.exit(code??1));});`);
  const sandbox=['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin'];
  for(const path of ['/lib','/lib64','/etc/ssl/certs','/etc/ld.so.cache','/etc/nsswitch.conf'])if(existsSync(path))sandbox.push('--ro-bind',path,path);
  sandbox.push('--proc','/proc','--dev','/dev','--size','67108864','--tmpfs','/tmp','--size','67108864','--tmpfs','/home','--dir','/home/ai','--size','67108864','--tmpfs','/work','--ro-bind',directory,directory);
  for(const path of [command,...args.filter(value=>isAbsolute(value)&&/\.(?:cjs|mjs|js|py|sh)$/.test(value))]){if(path.startsWith('/usr/')||path.startsWith(directory+'/'))continue;const info=await stat(path).catch(()=>null);if(info?.isFile())sandbox.push('--ro-bind',path,path);}
  const processes=(await exec('/bin/ps',['-u',String(process.getuid?.()??0),'-o','pid='],{timeout:2000,maxBuffer:1024*1024})).stdout.trim().split(/\s+/).length;
  sandbox.push('--chdir','/work','--clearenv','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','LANG','C.UTF-8','/usr/bin/prlimit','--cpu=45',`--nproc=${processes+64}`,'--fsize=33554432','--core=0','--',process.execPath,join(directory,'bootstrap.cjs'));
  return {executable:'/usr/bin/bwrap',args:sandbox,env:{PATH:'/usr/bin:/bin'},close};
 }catch(error){close();throw error instanceof Error&&error.message.startsWith('本机 AI')?error:Error('无法建立本机 AI 隔离环境，已禁止运行');}
}
