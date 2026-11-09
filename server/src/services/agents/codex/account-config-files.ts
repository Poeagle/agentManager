import {accountCommandInput,localCommandInput} from './account-transport.js';
import {getCodexEnvironment,environmentConnection} from './environments.js';

const LIMIT=96*1024;
const descriptions={config:{label:'Codex 配置',description:'模型、Provider 和运行参数，重启 Engine 后生效。',format:'TOML'},instructions:{label:'全局指令',description:'该 Codex 用户全局生效的 AGENTS.md 指令。',format:'Markdown'},override:{label:'全局覆盖指令',description:'优先于 AGENTS.md 的全局覆盖指令。',format:'Markdown'},rules:{label:'命令规则',description:'Codex 执行命令时使用的用户规则。',format:'Rules'},credentials:{label:'Codex 凭据文件',description:'保存登录凭据；仅显示文件状态，内容受保护。',format:'JSON'},catalog:{label:'模型目录',description:'config.toml 指定的模型能力目录。',format:'JSON'}} as const;
type FileId=keyof typeof descriptions;
const script=(home:string)=>`import os,sys,json,pathlib,hashlib,tempfile,re
root=(pathlib.Path(${JSON.stringify(home)}) if ${JSON.stringify(home)} else pathlib.Path.home()/'.codex').expanduser().resolve()
r=json.load(sys.stdin);op=r.get('operation');name=r.get('file')
paths={'config':root/'config.toml','instructions':root/'AGENTS.md','override':root/'AGENTS.override.md'}
if (root/'rules').is_dir():paths['rules']=root/'rules'/'default.rules'
try:
 import tomllib
 cfg=paths['config']
 if cfg.resolve().is_relative_to(root) and cfg.is_file() and cfg.stat().st_size<=98304:
  data=tomllib.loads(cfg.read_text(encoding='utf-8'));catalog=data.get('model_catalog_json')
  if isinstance(catalog,str) and catalog:
   cp=pathlib.Path(catalog).expanduser();paths['catalog']=cp if cp.is_absolute() else root/cp
except Exception:pass
files=[]
for key,p in paths.items():
 p=p.resolve()
 protected=[root/'auth.json',root/'credentials.json',root/'.credentials.json']
 if p.name.startswith('.') or p.name.lower() in ('auth.json','credentials.json') or any(p==secret.resolve() or (p.exists() and secret.exists() and p.samefile(secret)) for secret in protected):continue
 if key=='catalog' and p.suffix.lower()!='.json':continue
 try:p.relative_to(root)
 except ValueError:continue
 files.append({'id':key,'path':str(p),'exists':p.is_file()})
files.append({'id':'credentials','path':str(root/'auth.json'),'exists':(root/'auth.json').is_file(),'sensitive':True})
if op=='list':print(json.dumps({'files':files},ensure_ascii=False));sys.exit(0)
if name=='credentials':print(json.dumps({'error':'凭据文件内容受保护','status':403}));sys.exit(0)
item=next((f for f in files if f['id']==name),None)
if not item:print(json.dumps({'error':'文件不存在或超出该账号目录','status':404}));sys.exit(0)
p=pathlib.Path(item['path'])
try:
 raw=b''
 if p.is_file():
  with p.open('rb') as f:raw=f.read(98305)
 if len(raw)>98304:raise ValueError('文件超过 96 KiB，无法在此编辑')
 text=raw.decode('utf-8')
 # Do not expose files containing inline credentials through this UI.
 pattern=r'(?im)(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|authorization|secret)[\"\\\']?\\s*[:=]\\s*["\\\']?[^\\s"\\\']+'
 if re.search(pattern,text) or re.search(r'(?i)bearer\\s+[a-z0-9._~-]{8,}|sk-[a-z0-9_-]{12,}|https?://[^/\\s]+:[^@/\\s]+@|[?&](?:key|token|secret|signature)=',text):raise ValueError('文件包含敏感凭据，不能在此查看或编辑')
 revision=hashlib.sha256(raw).hexdigest()
 if op=='read':print(json.dumps({'content':text,'revision':revision,'exists':p.is_file()},ensure_ascii=False));sys.exit(0)
 if op!='write' or not isinstance(r.get('content'),str) or not isinstance(r.get('revision'),str):raise ValueError('文件请求无效')
 if revision!=r['revision']:print(json.dumps({'error':'文件已被其他操作修改，请重新读取后再保存','status':409}));sys.exit(0)
 content=r['content'];encoded=content.encode('utf-8')
 if len(encoded)>98304:raise ValueError('文件超过 96 KiB，无法保存')
 if re.search(pattern,content) or re.search(r'(?i)bearer\\s+[a-z0-9._~-]{8,}|sk-[a-z0-9_-]{12,}|https?://[^/\\s]+:[^@/\\s]+@|[?&](?:key|token|secret|signature)=',content):raise ValueError('文件包含敏感凭据，不能在此保存')
 if not root.is_dir() or not p.parent.is_dir():raise ValueError('目标目录不存在')
 fd,tmp=tempfile.mkstemp(prefix='.agentmanager-',dir=p.parent)
 try:
  if p.is_file():os.fchmod(fd,p.stat().st_mode & 0o777)
  with os.fdopen(fd,'wb') as f:f.write(encoded)
  os.replace(tmp,p)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
 print(json.dumps({'content':content,'revision':hashlib.sha256(encoded).hexdigest(),'exists':True},ensure_ascii=False))
except (OSError,UnicodeError,ValueError) as e:print(json.dumps({'error':str(e) if isinstance(e,ValueError) else '文件不可读取或写入','status':400},ensure_ascii=False))`;
export async function accountConfigFiles(id:string,operation:'list'|'read'|'write',file?:string,content?:unknown,revision?:unknown) {
 const environment=getCodexEnvironment(id);
 if(environment.kind!=='account'&&environment.kind!=='native')throw Object.assign(Error('此操作仅适用于登录账号'),{statusCode:400});
 if(operation!=='list'&&file==='credentials')throw Object.assign(Error('凭据文件内容受保护'),{statusCode:403});
 if(operation!=='list'&&!(file&&Object.hasOwn(descriptions,file)))throw Object.assign(Error('不支持的配置文件'),{statusCode:400});
 if(operation==='write'&&(typeof content!=='string'||Buffer.byteLength(content)>LIMIT||typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision)))throw Object.assign(Error('文件内容或版本无效'),{statusCode:400});
 const input=JSON.stringify({operation,file,content,revision});
 const result=JSON.parse(environment.kind==='native'?await localCommandInput(script(process.env.CODEX_HOME||''),input):await (async()=>{const connection=environmentConnection(environment);return accountCommandInput(connection,script(connection.codexHome),input);})());
 if(result.error)throw Object.assign(Error(result.error),{statusCode:result.status||400});
 if(operation==='list')return {files:(result.files as Array<{id:FileId;path:string;exists:boolean;sensitive?:boolean}>).map(item=>({...item,...descriptions[item.id]}))};
 return result as {content:string;revision:string;exists:boolean};
}
