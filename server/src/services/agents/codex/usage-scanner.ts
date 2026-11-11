/** Run inside the selected account. Aggregate complete files before transport;
 * message bodies, tool output, credentials and byte cursors never leave it. */
export const USAGE_SCAN = String.raw`
import os,sys,json,pathlib,hashlib,re,datetime,math,base64
o=json.load(sys.stdin)
home=pathlib.Path(o.get('home') or str(pathlib.Path.home()/'.codex')).resolve()
mode=o.get('mode','full'); day=o.get('day')
if mode not in ['full','daily']:raise ValueError('invalid mode')
if mode=='daily':datetime.date.fromisoformat(day)
days=set(o.get('days') or [day])
if mode=='daily' and (len(days)>2 or any(d not in [day,(datetime.date.fromisoformat(day)-datetime.timedelta(days=1)).isoformat()] for d in days)):raise ValueError('invalid daily window')
roots=[home/'sessions',home/'archived_sessions']; paths=[]; index={};directories=0; inventory=0; errors=0; history_files=0; history_bytes=0
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
   match=re.search(r'([0-9a-fA-F-]{36})\.jsonl$',name)
   if match:index.setdefault(match[1],[]).append((p,st.st_size))
   modified=datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).date().isoformat()
   if mode=='full' or modified in days:paths.append((p,st.st_size))
   if len(paths)>20000:raise RuntimeError('history inventory exceeds limit')
fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
known=base64.b64decode(o.get('known_events',''),validate=True)
if len(known)%32 or len(known)>64000000:raise ValueError('invalid known events')
groups={};events=[];events_truncated=False;projection_seen=set();seen={known[i:i+32] for i in range(0,len(known),32)};new_events={};read=0
cutoff=datetime.datetime.fromisoformat(o['baseline_at'].replace('Z','+00:00')) if o.get('baseline_at') else None
if cutoff and cutoff.tzinfo is None:raise ValueError('invalid baseline')
origins=o.get('origins') or {};baseline_cache={};baseline_budget=64*1024*1024;baseline_bytes=0
def timestamp(value):
 at=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 if at.tzinfo is None:raise ValueError('timestamp without timezone')
 return at
def inherited_snapshot(base,visited=None):
 global baseline_budget,baseline_bytes
 ident=base['thread_id'];end=base['end_byte_offset'];cache_key=(ident,end)
 if cache_key in baseline_cache:return baseline_cache[cache_key]
 visited=set(visited or [])
 if ident in visited or len(visited)>=64:raise ValueError('invalid lineage')
 visited.add(ident);candidates=index.get(ident,[])
 if not candidates:raise ValueError('missing lineage')
 answers=[]
 for p,size in candidates:
  if type(end)!=int or end<1 or end>size:raise ValueError('invalid lineage cutoff')
  found=None
  with p.open('rb') as source:
   pos=end;carry=b''
   while pos>0:
    amount=min(pos,262144)
    if baseline_budget<amount:raise ValueError('lineage read limit')
    baseline_budget-=amount;baseline_bytes+=amount;pos-=amount;source.seek(pos);block=source.read(amount)+carry;lines=block.split(b'\n');carry=lines[0] if pos>0 and len(lines[0])<=262144 else b''
    for line in reversed(lines[1:] if pos>0 else lines):
     if b'"token_count"' not in line[:1024]:continue
     try:
      r=json.loads(line);payload=r.get('payload') or {};info=payload.get('info') or {};total=info.get('total_token_usage')
      if r.get('type')=='event_msg' and payload.get('type')=='token_count' and isinstance(total,dict):found=json.dumps(total,sort_keys=True,separators=(',',':'));break
     except (ValueError,TypeError,AttributeError):pass
    if found is not None:break
   if found is None:
    source.seek(0);header_bytes=source.readline(min(4194305,baseline_budget+1))
    if len(header_bytes)>baseline_budget:raise ValueError('lineage read limit')
    baseline_budget-=len(header_bytes);baseline_bytes+=len(header_bytes);header=json.loads(header_bytes);parent=header.get('payload',{}).get('history_base')
    if parent:found=inherited_snapshot(parent,visited)
  answers.append(found)
 if any(value!=answers[0] for value in answers):raise ValueError('conflicting lineage')
 baseline_cache[cache_key]=answers[0]
 return answers[0]
for path,size in paths:
 cwd=None;model=None;tier=None;provider=None;previous=None;turn=None;after=None;inherited_ordinal=None
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
    if kind=='session_meta':
     origin=origins.get(p.get('id')) or {}
     if origin.get('exclude') or '.agentmanager-imports' in path.relative_to(home).parts:break
     if origin.get('after'):after=timestamp(origin['after'])
     if p.get('forked_from_id'):
      created=p.get('timestamp') or r.get('timestamp')
      if created:after=max(after,timestamp(created)) if after else timestamp(created)
      elif type(p.get('forked_from_ordinal_exclusive'))==int:inherited_ordinal=p['forked_from_ordinal_exclusive']
      elif not p.get('history_base'):errors+=1;break
     if p.get('history_base'):
      try:previous=inherited_snapshot(p['history_base'])
      except (OSError,ValueError,TypeError,KeyError):errors+=1;break
    if kind in ['session_meta','turn_context']:
     if isinstance(p.get('cwd'),str):cwd=p['cwd'][:4096]
     if isinstance(p.get('model'),str):model=p['model'][:120]
     if isinstance(p.get('model_provider'),str):provider=p['model_provider'][:120]
     if 'service_tier' in p:tier=p['service_tier'][:120] if isinstance(p['service_tier'],str) else None
    if kind=='turn_context' or kind=='event_msg' and p.get('type')=='task_started':
     if isinstance(p.get('turn_id'),str):turn=p['turn_id'][:200]
    if kind!='event_msg' or p.get('type')!='token_count' or not p.get('info'):continue
    info=p['info'];total=info.get('total_token_usage') or {};last=info.get('last_token_usage') or {};stamp=r.get('timestamp')
    if not isinstance(stamp,str) or not isinstance(total.get('total_tokens'),(int,float)):errors+=1;continue
    snapshot=json.dumps(total,sort_keys=True,separators=(',',':'))
    if snapshot==previous:continue
    previous=snapshot
    at=datetime.datetime.fromisoformat(stamp.replace('Z','+00:00'))
    if at.tzinfo is None:errors+=1;continue
    event_day=at.astimezone(datetime.timezone.utc).date().isoformat();event_hour=at.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:00:00Z')
    if mode=='daily' and event_day not in days:continue
    if after and at<=after or inherited_ordinal is not None and type(r.get('ordinal'))==int and r['ordinal']<inherited_ordinal:continue
    # Legacy aggregate caches have no request identities. Preserve their totals
    # as a baseline; only events after the last successful snapshot are new.
    if not isinstance(last.get('total_tokens'),(int,float)):errors+=1;continue
    tokens={k:last.get(k) if type(last.get(k)) in [int,float] and math.isfinite(last[k]) and 0<=last[k]<=10**15 else None for k in fields}
    if tokens['total_tokens'] is None:errors+=1;continue
    fingerprint=json.dumps([turn or stamp,cwd,total],sort_keys=True,separators=(',',':'))
    key=hashlib.sha256(fingerprint.encode()).digest()
    legacy_key=hashlib.sha256(json.dumps([stamp,cwd,total],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if o.get('includeEvents') and o.get('rebuildEvents') and key not in projection_seen:
     if len(events)<200000:
      projection_seen.add(key);events.append({'key':key.hex(),'legacy_key':legacy_key,'day':event_day,'hour':event_hour,'cwd':cwd or '', 'model':model,'tier':tier,'provider':provider,'tokens':tokens})
     else:events_truncated=True
    if cutoff and at<=cutoff:continue
    if key in seen:continue
    seen.add(key)
    if o.get('includeEvents') and not o.get('rebuildEvents'):
     if len(events)<200000:events.append({'key':key.hex(),'legacy_key':legacy_key,'day':event_day,'hour':event_hour,'cwd':cwd or '', 'model':model,'tier':tier,'provider':provider,'tokens':tokens})
     else:events_truncated=True
    if len(seen)>2000000:raise RuntimeError('usage event limit exceeded')
    new_events.setdefault(event_day,bytearray()).extend(key)
    # Keep complete counters separate from unknown fields so a partial request
    # cannot erase the known estimate of earlier requests in the same model.
    group_key=(event_day,cwd or '',model,tier,tuple(tokens[k] is not None for k in fields))
    group=groups.setdefault(group_key,{'day':event_day,'cwd':cwd or '','model':model,'tier':tier,'requests':0,'tokens':dict.fromkeys(fields,0)})
    if len(groups)>50000:raise RuntimeError('usage group limit exceeded')
    group['requests']+=1
    for k in fields:group['tokens'][k]=None if group['tokens'][k] is None or tokens[k] is None else group['tokens'][k]+tokens[k]
   except (ValueError,TypeError,AttributeError,OverflowError):
    errors+=1
    if first_type and first_type[1]==b'session_meta':break
result={'rows':list(groups.values()),'event_keys':{d:base64.b64encode(keys).decode('ascii') for d,keys in new_events.items()},'mode':mode,'day':day,'errors':errors,'partial':errors>0,'progress':{'mode':mode,'day':day,'history_files':history_files,'history_bytes':history_bytes,'files_selected':len(paths),'files_total':len(paths),'files_complete':len(paths),'bytes_total':sum(s for _,s in paths),'bytes_read':read,'lineage_bytes_read':baseline_bytes}}
if o.get('includeEvents'):result.update({'events':events,'events_truncated':events_truncated})
print(json.dumps(result,separators=(',',':'),allow_nan=False))
`;
