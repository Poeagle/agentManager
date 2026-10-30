// Start this checkout's Codex engine. It survives dashboard restarts so
// reconnecting a client never creates a second owner for an active turn.
import {spawn} from 'node:child_process';
import {mkdirSync,openSync,writeFileSync,closeSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';

const require=createRequire(import.meta.url);
const {WebSocket}=require('../server/node_modules/ws');
const root=resolve(import.meta.dirname,'..');
const key=createHash('sha256').update(root).digest('hex').slice(0,10);
const dir=join(tmpdir(),`octoally-chat-${process.getuid()}-${key}`);
mkdirSync(dir,{recursive:true,mode:0o700});
const socket=join(dir,'codex.sock');
async function connected() {
  return new Promise(resolve=>{
    const ws=new WebSocket(`ws+unix://${socket}:/`,{handshakeTimeout:1000});
    ws.once('open',()=>{ws.close();resolve(true);});ws.once('error',()=>resolve(false));
  });
}
if(!await connected()) {
  // The old PID is diagnostic only; never kill a process or unlink its socket.
  if(existsSync(socket)) throw new Error(`Codex socket exists but is unavailable: ${socket}`);
  const log=openSync(join(dir,'codex.log'),'a',0o600);
  const child=spawn('codex',['app-server','--listen',`unix://${socket}`,'--disable','plugins','-c','analytics.enabled=false'],{cwd:root,stdio:['ignore',log,log],detached:true});
  child.on('error',error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
  child.unref();closeSync(log);writeFileSync(join(dir,'pid'),String(child.pid),{mode:0o600});
  let ready=false;
  for(let attempt=0;attempt<60;attempt++) {if(await connected()){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  if(!ready) throw new Error(`Codex server did not become ready: ${dir}`);
}
process.stdout.write(socket);
