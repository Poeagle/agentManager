export const USAGE_EVENT_LIMIT=500000;
/** Run inside the selected account. Aggregate complete files before transport;
 * message bodies, tool output, credentials and byte cursors never leave it. */
export const USAGE_SCAN = String.raw`
import os,sys,json,pathlib,hashlib,re,datetime,math,base64
from zoneinfo import ZoneInfo
o=json.load(sys.stdin)
zone=ZoneInfo(o.get('timezone') or 'UTC');previous_zone=ZoneInfo(o.get('previous_timezone') or 'UTC');rebin=bool(o.get('rebin'))
home=pathlib.Path(o.get('home') or str(pathlib.Path.home()/'.codex')).resolve()
mode=o.get('mode','full'); day=o.get('day')
if mode not in ['full','daily','catchup']:raise ValueError('invalid mode')
if mode=='daily':datetime.date.fromisoformat(day)
target=o.get('native_id')
target_candidates=bool(target and o.get('target_candidates'))
incremental=o.get('checkpoints') is not None and not rebin and not o.get('reconcile') and not target
saved=(o.get('target_checkpoints') if target_candidates else o.get('checkpoints')) or {};checkpoints={};budget=256*1024*1024
since=o.get('since_day')
if mode=='catchup' and (not since or datetime.date.fromisoformat(since)>datetime.date.fromisoformat(day)):raise ValueError('invalid catchup window')
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
   modified=datetime.datetime.fromtimestamp(st.st_mtime,zone).date().isoformat()
   if target and (not match or match[1].lower()!=target.lower()):continue
   if incremental or target or mode=='full' or mode=='catchup' and modified>=since or mode=='daily' and modified in days:
    paths.append((p,st))
   if len(paths)>20000:raise RuntimeError('history inventory exceeds limit')
fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
known=base64.b64decode(o.get('known_events',''),validate=True)
if len(known)%32 or len(known)>64000000:raise ValueError('invalid known events')
groups={};matched={};events=[];events_truncated=False;candidates=[];candidate_bytes=0;candidates_truncated=False;projection_seen=set();previous_known={known[i:i+32] for i in range(0,len(known),32)};seen=set() if rebin or o.get('reconcile') else set(previous_known);new_events={};read=0;incomplete=False;files_complete=0
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
def token_values(value):
 return {k:value.get(k) if type(value.get(k))==int and 0<=value[k]<=10**15 else None for k in fields}
def fingerprint(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).digest()
def emit(candidate,echo=None):
 global events_truncated,candidate_bytes,candidates_truncated,errors
 if candidate is None:return
 stamp,last,response_id,ordinal,cwd,model,tier,provider,turn,session,after,inherited_ordinal=candidate
 at=timestamp(stamp)
 if after and at<=timestamp(after) or inherited_ordinal is not None and type(ordinal)==int and ordinal<inherited_ordinal:return
 tokens=token_values(last)
 if tokens['total_tokens'] is None:errors+=1;return
 input_tokens=tokens['input_tokens'];cached=tokens['cached_input_tokens'];output=tokens['output_tokens'];reasoning=tokens['reasoning_output_tokens']
 if input_tokens is not None and cached is not None and cached>input_tokens or output is not None and reasoning is not None and reasoning>output or input_tokens is not None and output is not None and input_tokens+output!=tokens['total_tokens']:
  # Keep the reported values available for audit and mark this source partial.
  errors+=1
 alias=None;echo_tokens=None;legacy_key=None;request_key=None
 if echo:
  stamp_echo,cwd_echo,turn_echo,total,legacy_last=echo
  alias=fingerprint([turn_echo or stamp_echo,cwd_echo,total])
  legacy_key=fingerprint([stamp_echo,cwd_echo,total]).hex()
  echo_tokens=token_values(legacy_last) if response_id else None
 if response_id:
  request=fingerprint(['request',response_id]);request_key=request.hex()
  # Existing ledgers used the changed cumulative echo as identity. Its old
  # counters are carried only to verify reconciliation during a rule upgrade.
  key=alias if alias and alias in previous_known and request not in previous_known else request
 else:
  key=alias
 if key is None:return
 local_at=at.astimezone(zone);event_day=local_at.date().isoformat();event_hour=local_at.replace(minute=0,second=0,microsecond=0).isoformat()
 if not incremental and not target and (mode=='daily' and event_day not in days or mode=='catchup' and not since<=event_day<=day):return
 if target_candidates:
  if candidates_truncated or cutoff and at<=cutoff:return
  entry={'key':key.hex(),'alias_key':alias.hex() if alias else None,'legacy_key':legacy_key,'echo_tokens':echo_tokens,'request_key':request_key,'day':event_day,'hour':event_hour,'at':at.astimezone(datetime.timezone.utc).isoformat(),'session':session,'cwd':cwd or '','model':model,'tier':tier,'provider':provider,'tokens':tokens,'timezone':str(zone)}
  candidate_bytes+=len(json.dumps(entry))+2
  if candidate_bytes>16*1024*1024 or len(candidates)>=${USAGE_EVENT_LIMIT}:candidates_truncated=True;candidates.clear();return
  candidates.append(entry)
  return
 if o.get('includeEvents') and o.get('rebuildEvents') and key not in projection_seen:
  if len(events)<${USAGE_EVENT_LIMIT}:
   projection_seen.add(key);events.append({'key':key.hex(),'legacy_key':legacy_key,'echo_tokens':echo_tokens,'request_key':request_key,'day':event_day,'hour':event_hour,'at':at.astimezone(datetime.timezone.utc).isoformat(),'session':session,'cwd':cwd or '', 'model':model,'tier':tier,'provider':provider,'tokens':tokens})
  else:events_truncated=True
 if not rebin and cutoff and at<=cutoff:return
 if key in seen:return
 seen.add(key)
 if o.get('includeEvents') and not o.get('rebuildEvents'):
  if len(events)<${USAGE_EVENT_LIMIT}:events.append({'key':key.hex(),'legacy_key':legacy_key,'echo_tokens':echo_tokens,'request_key':request_key,'day':event_day,'hour':event_hour,'at':at.astimezone(datetime.timezone.utc).isoformat(),'session':session,'cwd':cwd or '', 'model':model,'tier':tier,'provider':provider,'tokens':tokens})
  else:events_truncated=True
 if len(seen)>2000000:raise RuntimeError('usage event limit exceeded')
 if rebin and (key in previous_known or cutoff and at<=cutoff):
  legacy=key not in previous_known;old_day=at.astimezone(previous_zone).date().isoformat();matched_tokens=echo_tokens if echo_tokens and alias==key else tokens;mask=tuple(matched_tokens[k] is not None for k in fields)
  match_key=(old_day,cwd or '',model,tier,legacy,None if legacy else mask)
  entry=matched.setdefault(match_key,{'day':old_day,'cwd':cwd or '', 'model':model,'tier':tier,'legacy':legacy,'requests':0,'tokens':dict.fromkeys(fields,0)})
  if len(matched)>50000:raise RuntimeError('usage match limit exceeded')
  entry['requests']+=1
  for k in fields:entry['tokens'][k]=None if entry['tokens'][k] is None or matched_tokens[k] is None else entry['tokens'][k]+matched_tokens[k]
 new_events.setdefault(event_day,bytearray()).extend(key)
 # Keep complete counters separate from unknown fields so a partial request
 # cannot erase the known estimate of earlier requests in the same model.
 group_key=(event_day,cwd or '',model,tier,tuple(tokens[k] is not None for k in fields))
 group=groups.setdefault(group_key,{'day':event_day,'cwd':cwd or '','model':model,'tier':tier,'requests':0,'tokens':dict.fromkeys(fields,0)})
 if len(groups)>50000:raise RuntimeError('usage group limit exceeded')
 group['requests']+=1
 for k in fields:group['tokens'][k]=None if group['tokens'][k] is None or tokens[k] is None else group['tokens'][k]+tokens[k]

def sampled(f,pos,length):
 cur=f.tell();f.seek(pos);buffer=f.read(length);f.seek(cur);return hashlib.sha256(buffer).hexdigest()
def file_stamp(st):return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
def verified_scope(st,session):return [str(st.st_ctime_ns),o.get('checkpoint_version'),o.get('baseline_at'),str(zone),origins.get(session) or {}]
for path,st in paths:
 size=st.st_size;identity=fingerprint([st.st_dev,st.st_ino]).hex()
 previous_file=saved.get(identity)
 if incremental and read>=budget:
  incomplete=True
  continue
 file_errors=errors
 # Persist only receipt settings and counters. The source bytes, including
 # prompts and tool results, remain in the account that owns the history.
 cwd=None;model=None;tier=None;provider=None;previous=None;turn=None;after=None;inherited_ordinal=None;session=None;pending=None;sent_primary=False;closed=False;state_errors=0;recent=[]
 verified=bool(o.get('checkpoint_version') and not rebin and not o.get('reconcile') and not o.get('rebuildEvents') and (incremental or mode=='full'))
 with path.open('rb') as f:
  if target_candidates and file_stamp(os.fstat(f.fileno()))!=file_stamp(st):incomplete=True;continue
  target_checkpoint=target_candidates and previous_file and previous_file.get('errors')==0 and previous_file.get('verification')==verified_scope(st,previous_file['settings'][8]) and previous_file['length']==size and previous_file['modified']==str(st.st_mtime_ns)
  if (incremental or target_checkpoint) and previous_file and previous_file['offset']<=size:
   offset=previous_file['offset']
   unchanged=previous_file['length']==size and previous_file['modified']==str(st.st_mtime_ns)
   if unchanged and previous_file.get('eof'):
    files_complete+=1
    errors+=previous_file.get('errors',0)
    continue
   appended=previous_file['length']<size and previous_file['head']==sampled(f,0,min(128,offset)) and previous_file['tail']==sampled(f,max(0,offset-128),min(128,offset))
   if unchanged or appended:
    cwd,model,tier,provider,previous,turn,after,inherited_ordinal,session,sent_primary,closed=previous_file['settings']
    recent=previous_file.get('recent',[])
    state_errors=previous_file.get('errors',0)
    # An append observed by the general collector can still use its normal
    # cursor, but only an unchanged, verified snapshot is safe for deletion.
    verified=verified and unchanged and previous_file.get('verification')==verified_scope(st,session)
    f.seek(offset)
  while f.tell()<size and not closed:
   position=f.tell()
   if incremental and read>=budget:break
   limit=4194304 if f.tell()==0 else 262144
   line=f.readline(min(limit+1,size-f.tell()));read+=len(line)
   first_type=re.search(rb'"type"\s*:\s*"([^"\\]+)"',line[:1024])
   if len(line)>limit and first_type and first_type[1] in [b'turn_context',b'session_meta'] and not line.endswith(b'\n'):
    extra=f.readline(min(4194305-len(line),size-f.tell()));line+=extra;read+=len(extra);limit=4194304
   if len(line)>limit:
    if first_type and first_type[1] in [b'token_usage_record',b'turn_context',b'session_meta'] or b'"token_count"' in line[:512]:errors+=1
    while line and not line.endswith(b'\n') and f.tell()<size:
     line=f.readline(min(262145,size-f.tell()));read+=len(line)
    if not line.endswith(b'\n'):f.seek(position);break
    continue
   if not line.endswith(b'\n'):f.seek(position);break
   if first_type and first_type[1] in [b'response_item',b'compacted',b'function_call_output',b'agent_message',b'task_started',b'task_complete']:continue
   try:
    r=json.loads(line);p=r.get('payload') or {};kind=r.get('type')
    if kind=='session_meta':
     session=p.get('id') if isinstance(p.get('id'),str) else None
     origin=origins.get(p.get('id')) or {}
     if origin.get('exclude') or '.agentmanager-imports' in path.relative_to(home).parts:closed=True;break
     if origin.get('after'):after=timestamp(origin['after']).isoformat()
     if p.get('forked_from_id'):
      verified=False
      created=p.get('timestamp') or r.get('timestamp')
      if created:after=max(timestamp(after),timestamp(created)).isoformat() if after else timestamp(created).isoformat()
      elif type(p.get('forked_from_ordinal_exclusive'))==int:inherited_ordinal=p['forked_from_ordinal_exclusive']
      elif not p.get('history_base'):errors+=1;closed=True;break
     if p.get('history_base'):
      verified=False
      try:previous=inherited_snapshot(p['history_base'])
      except (OSError,ValueError,TypeError,KeyError):errors+=1;closed=True;break
    settings=p if kind in ['session_meta','turn_context'] else p.get('thread_settings') if kind=='event_msg' and p.get('type')=='thread_settings_applied' else None
    if isinstance(settings,dict):
     if isinstance(settings.get('cwd'),str):cwd=settings['cwd'][:4096]
     if isinstance(settings.get('model'),str):model=settings['model'][:120]
     if isinstance(settings.get('model_provider'),str):provider=settings['model_provider'][:120]
     if 'service_tier' in settings:tier=settings['service_tier'][:120] if isinstance(settings['service_tier'],str) else None
    if kind=='turn_context' or kind=='event_msg' and p.get('type')=='task_started':
     if isinstance(p.get('turn_id'),str):turn=p['turn_id'][:200]
    if kind=='token_usage_record':
     if not isinstance(p.get('response_id'),str) or not p['response_id'] or not isinstance(p.get('usage'),dict):errors+=1;continue
     stamp=r.get('timestamp')
     timestamp(stamp)
     response_key=fingerprint(['request',p['response_id']]).hex()
     if response_key in recent:continue
     recent=(recent+[response_key])[-16:]
     emit(pending)
     request_model=p.get('model',model);request_tier=p.get('service_tier',tier)
     request_model=request_model[:120] if isinstance(request_model,str) else None
     request_tier=request_tier[:120] if isinstance(request_tier,str) else None
     pending=(stamp,p['usage'],p['response_id'],r.get('ordinal'),cwd,request_model,request_tier,provider,p.get('turn_id') or turn,session,after,inherited_ordinal)
     sent_primary=False
     continue
    if kind!='event_msg' or p.get('type')!='token_count' or not p.get('info'):continue
    info=p['info'];total=info.get('total_token_usage') or {};last=info.get('last_token_usage') or {};stamp=r.get('timestamp')
    snapshot=json.dumps(total,sort_keys=True,separators=(',',':'))
    changed=snapshot!=previous
    before=previous;previous=snapshot
    echo=(stamp,cwd,turn,total,last) if changed and isinstance(stamp,str) and type(total.get('total_tokens'))==int else None
    if pending:
     emit(pending,echo);pending=None;sent_primary=False
    elif sent_primary:
     sent_primary=False
    elif echo:
     if before:
      prior_total=json.loads(before)
      if any(type(total.get(k))==int and type(prior_total.get(k))==int and type(last.get(k))==int and total[k]-prior_total[k]!=last[k] for k in fields):errors+=1
     emit((stamp,last,None,r.get('ordinal'),cwd,model,tier,provider,turn,session,after,inherited_ordinal),echo)
    elif changed:errors+=1
   except (ValueError,TypeError,AttributeError,OverflowError):
    errors+=1
    if first_type and first_type[1]==b'session_meta':closed=True;break
  if pending:
   emit(pending)
   sent_primary=True
  eof=closed or f.tell()==size
  if target_candidates and file_stamp(os.fstat(f.fileno()))!=file_stamp(st):incomplete=True;verified=False
  if eof:files_complete+=1
  if not eof:incomplete=True
  if incremental or o.get('save_checkpoints') or target_candidates:
   offset=f.tell()
   checkpoints[identity]={'offset':offset,'length':size,'modified':str(st.st_mtime_ns),'head':sampled(f,0,min(128,offset)),'tail':sampled(f,max(0,offset-128),min(128,offset)),'eof':eof,'errors':state_errors+errors-file_errors,'recent':recent,'settings':[cwd,model,tier,provider,previous,turn,after,inherited_ordinal,session,sent_primary,closed]}
   if verified and session and not closed:checkpoints[identity]['verification']=verified_scope(st,session)
  errors+=state_errors
result={'rows':list(groups.values()),'event_keys':{d:base64.b64encode(keys).decode('ascii') for d,keys in new_events.items()},'mode':mode,'day':day,'errors':errors,'partial':errors>0 or incomplete,'progress':{'mode':mode,'day':day,'history_files':history_files,'history_bytes':history_bytes,'files_selected':len(paths),'files_total':len(paths),'files_complete':files_complete,'bytes_total':sum(st.st_size for _,st in paths),'bytes_read':read,'lineage_bytes_read':baseline_bytes}}
if incremental or o.get('save_checkpoints') or target_candidates:result['checkpoints']=checkpoints
if target_candidates:result.update({'candidates':candidates,'candidates_truncated':candidates_truncated})
if o.get('includeEvents'):
 for event in events:event['timezone']=o.get('timezone') or 'UTC'
 result.update({'events':events,'events_truncated':events_truncated})
if rebin:result['matched_rows']=list(matched.values())
print(json.dumps(result,separators=(',',':'),allow_nan=False))
`;
