import {execFile} from 'child_process';
import {promisify} from 'util';
import {withCodexConnection} from './conversation-stream.js';
const execute=promisify(execFile);
export const codexVersion=(value:unknown)=>typeof value==='string'?value.match(/\b(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/)?.[1]||null:null;
let saved:{key:string;until:number;value:string}|undefined;
export async function installedCodexVersion(force=false):Promise<string> {
  const key=process.env.PATH||'';
  if(!force&&saved?.key===key&&saved.until>Date.now())return saved.value;
  const {stdout}=await execute('codex',['--version'],{timeout:3000,maxBuffer:8192});
  const value=codexVersion(stdout);if(!value)throw Error('无法读取服务器已安装的 Codex 版本');
  saved={key,until:Date.now()+60000,value};return value;
}
/** Preflight before stopping anything. A tab reload must never restart the
 * shared engine or claim a client reconnect upgraded an old engine. */
export async function prepareCodexReload(shared:boolean) {
  const installed=await installedCodexVersion(true);
  if(shared&&process.env.AGENTMANAGER_CODEX_STREAM_SOCKET) {
    const engine=await withCodexConnection(async(_request,server)=>codexVersion(server.userAgent));
    if(!engine)throw Error('无法确认 Codex 服务版本，原会话已保留，请稍后重试');
    if(engine!==installed)throw Error(`Codex 服务运行 ${engine}，已安装 ${installed}。请先升级共享 Codex 服务；原会话已保留。重载单个标签页不会重启其他会话共用的服务。`);
  }
  return installed;
}
