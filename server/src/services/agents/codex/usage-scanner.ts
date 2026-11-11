/** Runs under the selected OS account. Only bounded metadata and counters leave
 * the process; prompts, tool arguments and authentication files are never read. */
export const USAGE_SCAN = String.raw`
import os,sys,json,pathlib,time,hashlib
o=json.load(sys.stdin); home=pathlib.Path(o.get('home') or str(pathlib.Path.home()/'.codex')).resolve()
cursors=o.get('cursors',{}); changes=[]; events=[]; budget=16*1024*1024; partial=False; errors=0; directories=0
roots=[home/'sessions',home/'archived_sessions']; paths=[]
for root in roots:
 if not root.exists():continue
 for directory,dirs,files in os.walk(root,followlinks=False):
  directories+=1
  if directories>20000:raise RuntimeError('history inventory exceeds limit')
  dirs[:]=sorted(d for d in dirs if not pathlib.Path(directory,d).is_symlink())
  for name in sorted(files):
   if name.endswith('.jsonl'):paths.append(pathlib.Path(directory,name))
   if len(paths)>20000:raise RuntimeError('history inventory exceeds limit')
# Unvisited recent files first, then least recently visited. Current work is
# visible during bootstrap without starving older history on later passes.
def priority(p):
 try:modified=p.stat().st_mtime
 except OSError:modified=0
 return (cursors.get(str(p),{}).get('visited',0),-modified,str(p))
paths.sort(key=priority)
for path in paths:
 try:
  if path.is_symlink():errors+=1;continue
  canonical=path.resolve()
  if not any(str(canonical).startswith(str(root.resolve())+'/') for root in roots):errors+=1;continue
  s=path.stat(); old=cursors.get(str(path),{}); state=dict(old)
  if old.get('offset')==s.st_size and old.get('mtime')==str(s.st_mtime_ns) and old.get('generation','').startswith(str(s.st_dev)+':'+str(s.st_ino)+':'):
   if old.get('incomplete'):errors+=1
   continue
  if budget<=0 or len(changes)>=200 or len(events)>=1000:partial=True;break
  with path.open('rb') as f:
   # A small immutable prefix detects replacement even on filesystems reusing inodes.
   first=f.readline(262145); budget-=len(first); prefix=hashlib.sha256(first).hexdigest()
   generation=str(s.st_dev)+':'+str(s.st_ino)+':'+prefix
   if old.get('generation')!=generation or old.get('offset',0)>s.st_size:state={'offset':0,'cwd':None,'model':None,'tier':None}
   state['generation']=generation; state['visited']=time.time()
   # Large modern headers contain instructions as well as cwd. Inspect once,
   # bounded to 4 MiB, without returning the instruction fields to the caller.
   if not state.get('cwd'):
    f.seek(0); header=f.readline(4*1024*1024+1);budget-=len(header)
    if header.endswith(b'\n') and len(header)<=4*1024*1024:
     try:
      metadata=json.loads(header)
      if metadata.get('type')=='session_meta':
       payload=metadata.get('payload') or {}
       if isinstance(payload.get('cwd'),str):state['cwd']=payload['cwd'][:4096]
       if state['offset']==0:state['offset']=len(header)
     except (ValueError,TypeError):pass
   if state['offset']==s.st_size:
    if old.get('mtime')!=str(s.st_mtime_ns):state={'offset':0,'cwd':None,'model':None,'tier':None,'generation':generation,'visited':time.time()}
    else:changes.append([str(path),state]);continue
   f.seek(state['offset']); count=0
   while f.tell()<s.st_size and budget>0 and count<5000 and len(events)<1000:
    start=f.tell(); line=f.readline(262145); budget-=len(line);count+=1
    if len(line)>262144:
     # Skip oversized records without retaining their contents.
     if b'"token_count"' in line[:512]:errors+=1;state['incomplete']=True
     while line and not line.endswith(b'\n') and budget>0:line=f.readline(262145);budget-=len(line)
     if not line.endswith(b'\n'):f.seek(start);partial=True;break
     state['offset']=f.tell();continue
    if not line.endswith(b'\n'):f.seek(start);partial=True;break
    state['offset']=f.tell()
    try:r=json.loads(line)
    except Exception:errors+=1;state['incomplete']=True;continue
    p=r.get('payload') or {}; kind=r.get('type')
    if kind in ['session_meta','turn_context']:
     if isinstance(p.get('cwd'),str):state['cwd']=p['cwd'][:4096]
     if isinstance(p.get('model'),str):state['model']=p['model'][:120]
     if 'service_tier' in p:state['tier']=p['service_tier']
    if kind!='event_msg' or p.get('type')!='token_count' or not p.get('info'):continue
    info=p['info']; total=info.get('total_token_usage') or {}; last=info.get('last_token_usage') or {}; stamp=r.get('timestamp')
    fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
    if not isinstance(stamp,str) or not isinstance(total.get('total_tokens'),(int,float)):errors+=1;state['incomplete']=True;continue
    snapshot=json.dumps(total,sort_keys=True,separators=(',',':'))
    if snapshot==state.get('total'):continue
    state['total']=snapshot
    fingerprint=json.dumps([stamp,state.get('cwd'),total],sort_keys=True,separators=(',',':'))
    key=hashlib.sha256(fingerprint.encode()).hexdigest()
    # The native last-request counters avoid charging a fork's cumulative baseline.
    if not isinstance(last.get('total_tokens'),(int,float)):errors+=1;state['incomplete']=True;continue
    counters={k:last.get(k) if isinstance(last.get(k),(int,float)) and last.get(k)>=0 else None for k in fields}
    if any(v is not None and v>10**15 for v in counters.values()):errors+=1;continue
    events.append({'key':key,'timestamp':stamp,'cwd':state.get('cwd'),'model':state.get('model'),'tier':state.get('tier'),'tokens':counters})
   if state['offset']<s.st_size:partial=True
   state['mtime']=str(s.st_mtime_ns)
   changes.append([str(path),state])
 except (OSError,ValueError,TypeError):errors+=1
print(json.dumps({'changes':changes,'events':events,'partial':partial,'errors':errors},separators=(',',':')))
`;
