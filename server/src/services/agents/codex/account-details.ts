import {createHash} from 'crypto';
import {config} from '../../../config.js';
import {accountCommand} from './account-transport.js';
import {getCodexEnvironment,environmentConnection,engineForEnvironment} from './environments.js';
import {runInCodexEngine} from './engine-context.js';
import {withCodexConnection} from './stream.js';
import {readEngineModelsForEnvironment} from './controls.js';

/** Read only the selected account. Raw auth/config documents are never returned. */
export async function readCodexAccountDetails(id:string) {
  const environment=getCodexEnvironment(id);
  if(environment.kind!=='account')throw Object.assign(Error('此详情接口仅适用于 Codex 登录账号'),{statusCode:400});
  const engine=await engineForEnvironment(id);
  const auth=await runInCodexEngine(engine,()=>withCodexConnection(request=>request('account/read',{})));
  const models=await readEngineModelsForEnvironment(id,true);
  const connection=environmentConnection(environment);
  const tag=createHash('sha256').update(config.dbPath+':'+id).digest('hex').slice(0,12);
  const metadata=JSON.parse(await accountCommand(connection,`import os,pathlib,shutil,subprocess,json,sys
home=pathlib.Path.home()
os.environ['PATH']=str(home/'.local/bin')+':/usr/local/bin:/usr/bin:/bin:'+os.environ.get('PATH','')
command=shutil.which(${JSON.stringify(connection.codexCommand)})
if not command:sys.exit('CODEX_NOT_FOUND')
result=subprocess.run([command,'--version'],capture_output=True,text=True,timeout=5)
if result.returncode:sys.exit('CODEX_NOT_FOUND')
directory=pathlib.Path(${JSON.stringify(connection.codexHome||engine.accountHome||'')}) if ${JSON.stringify(connection.codexHome||engine.accountHome||'')} else home/'.codex'
path=directory/'config.toml';settings={};notice=None
try:
 import tomllib
 if path.is_file():
  if path.stat().st_size>1048576:raise ValueError('configuration exceeds 1 MiB')
  parsed=tomllib.loads(path.read_text())
  for key in ['model','model_provider','model_reasoning_effort','approval_policy','sandbox_mode']:
   value=parsed.get(key)
   if isinstance(value,str):settings[key]=value[:500]
except Exception:notice='暂时无法读取或解析 config.toml，其他详情仍可查看'
pid=None
try:pid=int((home/'.agentmanager-codex'/${JSON.stringify(tag)}/'pid').read_text())
except (OSError,ValueError):pass
print(json.dumps({'executable':command,'version':result.stdout.strip()[:200],'home':str(directory),'config':{'path':str(path),'exists':path.is_file(),'notice':notice},'settings':settings,'pid':pid}))`,15000));
  const text=(value:unknown)=>typeof value==='string'?value.slice(0,500):null;
  return {
    id,checked_at:new Date().toISOString(),
    executable:text(metadata.executable),version:text(metadata.version),home:text(metadata.home),
    engine:{state:'connected',pid:Number.isSafeInteger(metadata.pid)?metadata.pid:null},
    authentication:{status:auth.account||auth.requiresOpenaiAuth===false?'authenticated':'unauthenticated',type:text(auth.account?.type),email:text(auth.account?.email),plan:text(auth.account?.planType)},
    config:{path:text(metadata.config?.path),exists:metadata.config?.exists===true,notice:text(metadata.config?.notice)},
    settings:Object.fromEntries(['model','model_provider','model_reasoning_effort','approval_policy','sandbox_mode'].map(key=>[key,text(metadata.settings?.[key])])),
    models,
  };
}
