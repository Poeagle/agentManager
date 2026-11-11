import {mkdir,open,unlink,rm} from 'fs/promises';
import {dirname,join} from 'path';
import {randomUUID} from 'crypto';
import {config} from '../../../config.js';
import {getCodexEnvironment,environmentConnection} from './environments.js';
import {accountCommand,ensureAccountTransport} from './account-transport.js';
import {historyFileCommand,localHome} from './account-files.js';
/** Only gateways verified to reject this native protocol item opt in. */
export function omitAdditionalToolsForEndpoint(endpoint:unknown):boolean {
 if(typeof endpoint!=='string')return false;
 try{return new URL(endpoint).origin==='https://xindu.xyz';}catch{return false;}
}
/** Copy immutable lineage prefixes. Only native metadata IDs change, always
 * UUID -> UUID of identical byte length, so native byte cutoffs remain valid.
 * Raw messages, tools, context and compaction records are retained verbatim. */
export const EXPORT_HISTORY_BUNDLE=String.raw`
import pathlib,json,sys,os,re,uuid,tarfile,io
home=pathlib.Path(options['home'] or str(pathlib.Path.home()/'.codex')).resolve()
roots=[(home/'sessions').resolve(),(home/'archived_sessions').resolve()]
pattern=re.compile(r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$')
limit=1024*1024*1024
index=None;entries={};total=0

def allowed(p):return any(str(p).startswith(str(root)+'/') for root in roots)
def lookup(ident):
 global index
 if not re.fullmatch(r'[0-9a-fA-F-]{36}',ident):raise ValueError('invalid ancestor identity')
 if index is None:
  index={};count=0
  for root in roots:
   if not root.exists():continue
   for directory,dirs,files in os.walk(root,followlinks=False):
    for name in files:
     count+=1
     if count>50000:raise ValueError('too many history files')
     m=pattern.search(name)
     if m:index.setdefault(m[1],[]).append(pathlib.Path(directory)/name)
 matches=index.get(ident,[])
 if not matches:raise ValueError('missing history ancestor')
 # Multiple physical paths are acceptable only when the required prefix is identical.
 return matches

def visit(path,cut=None,expected=None,depth=0):
 global total
 if depth>64:raise ValueError('history lineage is too deep')
 p=path.resolve()
 if not allowed(p):raise ValueError('history outside account sessions')
 match=pattern.search(p.name)
 if not match:raise ValueError('invalid rollout filename')
 ident=match[1];size=p.stat().st_size if cut is None else cut
 if size<1 or size>p.stat().st_size:raise ValueError('invalid prefix cutoff')
 if ident in entries:
  if entries[ident]['size']!=size:raise ValueError('ambiguous history prefix')
  if entries[ident].get('visiting'):raise ValueError('cyclic history lineage')
  return ident
 with p.open('rb') as f:
  header=f.readline(1024*1024+1)
  if not header.endswith(b'\n') or len(header)>size:raise ValueError('incomplete history header')
  meta=json.loads(header)
  if meta.get('type')!='session_meta' or not isinstance(meta.get('payload'),dict):raise ValueError('missing native metadata')
  f.seek(size-1)
  if f.read(1)!=b'\n':raise ValueError('prefix ends inside a record')
  if expected is not None:
   f.seek(max(len(header),size-2*1024*1024));tail=f.read(size-f.tell());lines=tail.splitlines()
   if not lines or json.loads(lines[-1]).get('ordinal')!=expected-1:raise ValueError('history ordinal mismatch')
 total+=size
 if total>limit:raise ValueError('history bundle exceeds 1 GiB')
 entries[ident]={'path':p,'size':size,'header':header,'visiting':True}
 base=meta['payload'].get('history_base')
 if base:
  candidates=lookup(base['thread_id']);cutoff=base['end_byte_offset']
  chosen=candidates[0]
  # Avoid guessing when stale duplicated rollout paths disagree.
  if len(candidates)>1:
   import hashlib
   def digest(file):
    h=hashlib.sha256();left=cutoff
    with file.open('rb') as f:
     while left:
      b=f.read(min(left,65536))
      if not b:raise ValueError('incomplete duplicate ancestor')
      h.update(b);left-=len(b)
    return h.digest()
   first=digest(chosen)
   if any(digest(q)!=first for q in candidates[1:]):raise ValueError('conflicting ancestor paths')
  visit(chosen,cutoff,base['end_ordinal_exclusive'],depth+1)
 entries[ident]['visiting']=False
 return ident

root=visit(pathlib.Path(options['path']))
mapping={ident:str(uuid.uuid4()) for ident in entries}
manifest={'root':entries[root]['path'].name.replace(root,mapping[root]),'ids':list(mapping.values())}
class PrefixReader:
 def __init__(self,path,header,size):self.file=path.open('rb');self.file.seek(len(header));self.left=size-len(header);self.header=header;self.position=0
 def read(self,size):
  result=self.header[self.position:self.position+size];self.position+=len(result)
  if len(result)<size and self.left:
   chunk=self.file.read(min(self.left,size-len(result)))
   if not chunk:raise ValueError('history changed while exporting')
   self.left-=len(chunk);result+=chunk
  return result
 def close(self):self.file.close()
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
 data=json.dumps(manifest).encode();info=tarfile.TarInfo('manifest.json');info.size=len(data);info.mode=0o600;archive.addfile(info,io.BytesIO(data))
 for ident,entry in entries.items():
  header=entry['header'];payload=json.loads(header)['payload']
  # Change only identity-valued metadata fields, never arbitrary prompt text.
  for key in ['id','session_id','thread_id','forked_from_id','parent_thread_id']:
   expression=rb'(?<!\\)("'+key.encode()+rb'"\s*:\s*")([0-9a-fA-F-]{36})(")'
   def change(match):
    value=match[2].decode();replacement=mapping[ident] if key=='id' else mapping.get(value,value)
    return match[1]+replacement.encode()+match[3]
   header=re.sub(expression,change,header)
  if len(header)!=len(entry['header']):raise ValueError('history offsets changed')
  reader=PrefixReader(entry['path'],header,entry['size']);info=tarfile.TarInfo(entry['path'].name.replace(ident,mapping[ident]));info.size=entry['size'];info.mode=0o600
  try:archive.addfile(info,reader)
  finally:reader.close()
`;
export const IMPORT_HISTORY_BUNDLE=String.raw`
import pathlib,sys,tarfile,re,os,json
root=pathlib.Path(options['directory']);root.mkdir(parents=True,mode=0o700,exist_ok=False)
count=0;total=0
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
 for member in archive:
  count+=1;total+=member.size
  if count>66 or total>1024*1024*1024+65536 or not member.isfile() or member.size<0:raise ValueError('invalid history bundle')
  if member.name!='manifest.json' and not re.fullmatch(r'rollout-[^/\\]*[0-9a-fA-F-]{36}\.jsonl',member.name):raise ValueError('invalid history filename')
  if '/' in member.name or '\\' in member.name:raise ValueError('invalid history path')
  with (root/member.name).open('xb') as out:
   os.chmod(root/member.name,0o600);source=archive.extractfile(member)
   while True:
    chunk=source.read(65536)
    if not chunk:break
    out.write(chunk)
`;
/** Build one self-contained paginated root for the destination. Native Codex
 * may otherwise resolve only the nearest parent of an imported fork. The
 * original files remain untouched; message and tool payloads are retained. */
export const NORMALIZE_TRANSFER_HISTORY=EXPORT_HISTORY_BUNDLE.slice(0,EXPORT_HISTORY_BUNDLE.indexOf('mapping={'))+String.raw`
import tempfile
new_id=str(uuid.uuid4())
meta=json.loads(entries[root]['header']);payload=meta['payload'];payload['id']=new_id;payload['session_id']=new_id
for key in ['history_base','forked_from_id','forked_from_ordinal_exclusive','parent_thread_id']:payload.pop(key,None)
meta['ordinal']=0
order=[]
def collect(ident):
 base=json.loads(entries[ident]['header'])['payload'].get('history_base')
 if base:collect(base['thread_id'])
 order.append(ident)
collect(root)
def encode(item):return (json.dumps(item,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode()
with tempfile.TemporaryFile() as out:
 def append(item):
  data=encode(item)
  if out.tell()+len(data)>limit:raise ValueError('normalized history exceeds limit')
  out.write(data)
 append(meta);ordinal=1;expected=0
 for ident in order:
  entry=entries[ident];header=json.loads(entry['header'])
  if header.get('ordinal')!=expected:raise ValueError('history ordinal mismatch')
  expected+=1
  with entry['path'].open('rb') as source:
   source.readline();left=entry['size']-len(entry['header'])
   while left>0:
    line=source.readline(min(left,64*1024*1024+1));left-=len(line)
    if not line or len(line)>64*1024*1024 or not line.endswith(b'\n'):raise ValueError('history record exceeds limit')
    item=json.loads(line)
    if not isinstance(item,dict) or item.get('ordinal')!=expected:raise ValueError('history ordinal mismatch')
    expected+=1
    payload=item.get('payload')
    if options.get('omit_additional') and item.get('type')=='response_item' and isinstance(payload,dict) and payload.get('type')=='additional_tools':continue
    item['ordinal']=ordinal;ordinal+=1;append(item)
 size=out.tell();out.seek(0);name=entries[root]['path'].name.replace(root,new_id)
 manifest={'root':name,'ids':[new_id]}
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
  data=json.dumps(manifest).encode();info=tarfile.TarInfo('manifest.json');info.size=len(data);info.mode=0o600;archive.addfile(info,io.BytesIO(data))
  info=tarfile.TarInfo(name);info.size=size;info.mode=0o600;archive.addfile(info,out)
`;
/** Read-only projection for the conversation reader. Native imports retain
 * their paginated graph; only the platform's private view is concatenated. */
export const FLATTEN_HISTORY=EXPORT_HISTORY_BUNDLE.slice(0,EXPORT_HISTORY_BUNDLE.indexOf('mapping={'))+String.raw`
def emit(ident):
 entry=entries[ident];base=json.loads(entry['header'])['payload'].get('history_base')
 if base:emit(base['thread_id'])
 with entry['path'].open('rb') as source:
  left=entry['size']
  while left:
   chunk=source.read(min(left,65536))
   if not chunk:raise ValueError('history changed while reading')
   sys.stdout.buffer.write(chunk);left-=len(chunk)
emit(root)
`;
function script(options:unknown,body:string){return `import json\noptions=json.loads(${JSON.stringify(JSON.stringify(options))})\n`+body;}
export async function preparePagedHistory(sourceId:string,sourcePath:string,targetId:string,options:{omitAdditionalTools?:boolean}={}):Promise<{path:string;importedIds:string[];finish:(keep:boolean)=>Promise<void>}> {
 const source=getCodexEnvironment(sourceId),target=getCodexEnvironment(targetId);
 const directory=join(dirname(config.dbPath),'history-transfers');await mkdir(directory,{recursive:true,mode:0o700});
 const archive=join(directory,randomUUID()+'.tar');let targetDirectory:string|undefined;
 const sourceConnection=source.kind==='account'?environmentConnection(source):null,targetConnection=target.kind==='account'?environmentConnection(target):null;
 try{
  await historyFileCommand(sourceConnection,script({home:source.kind==='account'?source.connection!.codexHome:localHome(source),path:sourcePath,omit_additional:options.omitAdditionalTools===true},NORMALIZE_TRANSFER_HISTORY),'',archive,'read');
  const handle=await open(archive,'r');let manifest:{root:string;ids:string[]};
  try{const header=Buffer.alloc(512);await handle.read(header,0,512,0);const size=Number.parseInt(header.subarray(124,136).toString().replace(/\0/g,'').trim(),8);if(header.subarray(0,100).toString().replace(/\0/g,'')!=='manifest.json'||!Number.isFinite(size)||size>65536)throw Error('历史包索引无效');const content=Buffer.alloc(size);await handle.read(content,0,size,512);manifest=JSON.parse(content.toString());if(!/^rollout-[^/\\]+\.jsonl$/.test(manifest.root)||!Array.isArray(manifest.ids)||manifest.ids.length>65||manifest.ids.some(id=>!/^[-a-f0-9]{36}$/i.test(id)))throw Error('历史包路径无效');}finally{await handle.close();}
  const home=target.kind==='account'?(await ensureAccountTransport(target.id,targetConnection!)).home:localHome(target);
  targetDirectory=join(home,'sessions','.agentmanager-imports',randomUUID());
  await historyFileCommand(targetConnection,script({directory:targetDirectory},IMPORT_HISTORY_BUNDLE),archive,'','write');
  const finalDirectory=targetDirectory;
  return {path:join(finalDirectory,manifest.root),importedIds:manifest.ids,finish:async keep=>{await unlink(archive).catch(()=>{});if(!keep)await removeTarget(finalDirectory);}};
 }catch(error){await unlink(archive).catch(()=>{});if(targetDirectory)await removeTarget(targetDirectory);throw error;}
 async function removeTarget(path:string){if(targetConnection)await accountCommand(targetConnection,`import shutil\nshutil.rmtree(${JSON.stringify(path)},ignore_errors=True)`).catch(()=>{});else await rm(path,{recursive:true,force:true}).catch(()=>{});}
}
