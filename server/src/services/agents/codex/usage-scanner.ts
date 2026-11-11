/** Run inside the selected account. Aggregate complete files before transport;
 * message bodies, tool output, credentials and byte cursors never leave it. */
export const USAGE_SCAN = String.raw`
import os,sys,json,pathlib,hashlib,re,datetime,math
o=json.load(sys.stdin)
home=pathlib.Path(o.get('home') or str(pathlib.Path.home()/'.codex')).resolve()
mode=o.get('mode','full'); day=o.get('day')
if mode not in ['full','daily']:raise ValueError('invalid mode')
if mode=='daily':datetime.date.fromisoformat(day)
roots=[home/'sessions',home/'archived_sessions']; paths=[]; directories=0; inventory=0; errors=0; history_files=0; history_bytes=0
def walk_error(error):raise error
for root in roots:
 if root.is_symlink():raise ValueError('history root is a symlink')
 if not root.exists():continue
 for directory,dirs,files in os.walk(root,followlinks=False,onerror=walk_error):
  directories+=1
  if directories>20000:raise RuntimeError('history inventory exceeds limit')
  dirs[:]=sorted(d for d in dirs if not pathlib.Path(directory,d).is_symlink())
  for name in sorted(files):
   if not name.endswith('.jsonl'):continue
   inventory+=1
   if inventory>20000:raise RuntimeError('history inventory exceeds limit')
   p=pathlib.Path(directory,name)
   if p.is_symlink():errors+=1;continue
   st=p.stat()
   history_files+=1;history_bytes+=st.st_size
   modified=datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).date().isoformat()
   if mode=='full' or modified==day:paths.append((p,st.st_size))
   if len(paths)>20000:raise RuntimeError('history inventory exceeds limit')
fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
groups={};seen=set();read=0;events=[];events_truncated=False
for path,size in paths:
 cwd=None;model=None;tier=None;provider=None;previous=None
 # One bounded line at a time. Modern metadata may be up to 4 MiB;
 # oversized message/tool records are discarded in 256 KiB chunks.
 with path.open('rb') as f:
  while f.tell()<size:
   limit=4194304 if f.tell()==0 else 262144
   line=f.readline(min(limit+1,size-f.tell()));read+=len(line)
   first_type=re.search(rb'"type"\s*:\s*"([^"\\]+)"',line[:1024])
   if len(line)>limit and first_type and first_type[1] in [b'turn_context',b'session_meta'] and not line.endswith(b'\n'):
    extra=f.readline(min(4194305-len(line),size-f.tell()));line+=extra;read+=len(extra);limit=4194304
   if len(line)>limit:
    if b'"token_count"' in line[:512] or b'"turn_context"' in line[:512] or b'"session_meta"' in line[:512]:errors+=1
    while line and not line.endswith(b'\n') and f.tell()<size:
     line=f.readline(min(262145,size-f.tell()));read+=len(line)
    continue
   if not line.endswith(b'\n'):errors+=1;break
   if first_type and first_type[1] in [b'response_item',b'function_call_output',b'agent_message',b'task_started',b'task_complete']:continue
   try:
    r=json.loads(line);p=r.get('payload') or {};kind=r.get('type')
    if kind in ['session_meta','turn_context']:
     if isinstance(p.get('cwd'),str):cwd=p['cwd'][:4096]
     if isinstance(p.get('model'),str):model=p['model'][:120]
     if isinstance(p.get('model_provider'),str):provider=p['model_provider'][:120]
     if 'service_tier' in p:tier=p['service_tier'][:120] if isinstance(p['service_tier'],str) else None
    if kind!='event_msg' or p.get('type')!='token_count' or not p.get('info'):continue
    info=p['info'];total=info.get('total_token_usage') or {};last=info.get('last_token_usage') or {};stamp=r.get('timestamp')
    if not isinstance(stamp,str) or not isinstance(total.get('total_tokens'),(int,float)):errors+=1;continue
    snapshot=json.dumps(total,sort_keys=True,separators=(',',':'))
    if snapshot==previous:continue
    previous=snapshot
    at=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
    if at.tzinfo is None:errors+=1;continue
    event_day=at.astimezone(datetime.timezone.utc).date().isoformat()
    if mode=='daily' and event_day!=day:continue
    if not isinstance(last.get('total_tokens'),(int,float)):errors+=1;continue
    tokens={k:last.get(k) if type(last.get(k)) in [int,float] and math.isfinite(last[k]) and 0<=last[k]<=10**15 else None for k in fields}
    if tokens['total_tokens'] is None:errors+=1;continue
    fingerprint=json.dumps([stamp,cwd,total],sort_keys=True,separators=(',',':'))
    key=hashlib.sha256(fingerprint.encode()).digest()
    if key in seen:continue
    seen.add(key)
    if o.get('includeEvents'):
     if len(events)<50000:events.append({'key':key.hex(),'day':event_day,'cwd':cwd or '', 'model':model,'tier':tier,'provider':provider,'tokens':tokens})
     else:events_truncated=True
    if len(seen)>2000000:raise RuntimeError('usage event limit exceeded')
    group_key=(event_day,cwd or '',model,tier)
    group=groups.setdefault(group_key,{'day':event_day,'cwd':cwd or '','model':model,'tier':tier,'requests':0,'tokens':dict.fromkeys(fields,0)})
    if len(groups)>50000:raise RuntimeError('usage group limit exceeded')
    group['requests']+=1
    for k in fields:group['tokens'][k]=None if group['tokens'][k] is None or tokens[k] is None else group['tokens'][k]+tokens[k]
   except (ValueError,TypeError,AttributeError,OverflowError):errors+=1
result={'rows':list(groups.values()),'mode':mode,'day':day,'errors':errors,'partial':errors>0,'progress':{'mode':mode,'day':day,'history_files':history_files,'history_bytes':history_bytes,'files_selected':len(paths),'files_total':len(paths),'files_complete':len(paths),'bytes_total':sum(s for _,s in paths),'bytes_read':read}}
if o.get('includeEvents'):result.update({'events':events,'events_truncated':events_truncated})
print(json.dumps(result,separators=(',',':'),allow_nan=False))
`;
