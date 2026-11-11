import {EXPORT_HISTORY_BUNDLE} from './history-bundle.js';
// Reuse the native lineage reader: it validates roots, inherited prefix bounds,
// cycles and conflicting duplicate ancestors. No history body leaves this helper.
const graphReader=EXPORT_HISTORY_BUNDLE.slice(0,EXPORT_HISTORY_BUNDLE.indexOf('mapping={'));
export const CONTEXT_SCAN=String.raw`
import os,sys,json,pathlib,math,re,datetime
options=json.load(sys.stdin)
home=pathlib.Path(options.get('home') or str(pathlib.Path.home()/'.codex')).resolve()
path=pathlib.Path(options['path']).resolve()
if any((home/name).is_symlink() for name in ['sessions','archived_sessions']):raise ValueError('HISTORY_ACCESS')
if path.suffix!='.jsonl':raise ValueError('HISTORY_ACCESS')
if not any(str(path).startswith(str((home/name).resolve())+'/') for name in ['sessions','archived_sessions']):raise ValueError('HISTORY_ACCESS')
if path.is_symlink() or not path.is_file():raise ValueError('HISTORY_ACCESS')
with path.open('rb') as f:header=f.readline(4*1024*1024+1)
try:metadata=json.loads(header)
except (ValueError,UnicodeDecodeError):metadata={}
if metadata.get('type')=='session_meta' and metadata.get('payload',{}).get('history_base'):
 exec(${JSON.stringify(graphReader)})
 def ordered(ident):
  entry=entries[ident];base=json.loads(entry['header'])['payload'].get('history_base')
  return (ordered(base['thread_id']) if base else [])+[entry]
 files=ordered(root)
else:files=[{'path':path,'size':path.stat().st_size,'header':header}]
budget=64*1024*1024;selected=[];partial=False;warnings=set();records=0;read=0;compactions=0;model=None;usage=None;observed=None
for entry in reversed(files):
 take=min(entry['size'],budget);budget-=take
 selected.append((entry,max(0,entry['size']-take)))
 if take<entry['size']:partial=True;warnings.add('tail_only')
 if budget<=0:break
if len(selected)<len(files):partial=True;warnings.add('tail_only')
selected.reverse()
categories={};calls={};base_text={};seen_base=set();images=0;omitted=0
names={'system':'系统提示','injections':'上下文注入','tools':'工具 schemas','user':'用户消息','assistant':'助手回复（纯文本）','calls':'助手工具调用','results':'工具结果','summary':'压缩摘要','images':'图片输入'}
method='characters_div_3'
def tokens(text):
 if not text:return 0
 # Same offline fallback as DolphinDB Manager when a matching vocabulary is
 # unavailable. Never install/download a tokenizer during a read-only request.
 return max(1,math.ceil(len(text)/3))
def add(key,text,name=None):
 if not text:return
 c=categories.setdefault(key,{'id':key,'name':names[key],'tokens':0,'count':0,'detail':{}})
 count=tokens(text);c['tokens']+=count;c['count']+=1
 if name:
  name=str(name)[:120]
  if name not in c['detail'] and len(c['detail'])>=100:name='其他'
  d=c['detail'].setdefault(name,{'name':name,'tokens':0,'count':0});d['tokens']+=count;d['count']+=1
def text_content(value):
 global images
 if isinstance(value,str):return value
 if not isinstance(value,list):return ''
 result=[]
 for part in value:
  if not isinstance(part,dict):continue
  if part.get('type') in ['image','input_image','image_url','local_image']:images+=1;continue
  if isinstance(part.get('text'),str):result.append(part['text'])
 return '\n'.join(result)
def injection(text):
 if text.startswith('# AGENTS.md instructions for ') and text.rstrip().endswith('</INSTRUCTIONS>'):return '项目规则'
 for tag,label in [('octoally_shared_resources','共享资源'),('environment_context','运行环境'),('permissions','权限说明'),('skills_instructions','技能说明')]:
  if text.lstrip().startswith('<'+tag) and text.rstrip().endswith('</'+tag+'>'):return label
 return None
def item(p):
 if not isinstance(p,dict):return
 kind=p.get('type');role=p.get('role')
 if kind=='message':
  text=text_content(p.get('content'));label=injection(text) if role=='user' else None
  if role in ['system','developer']:add('system',text,'原生 '+role)
  elif label:add('injections',text,label)
  elif role=='user':add('user',text)
  elif role=='assistant':add('assistant',text)
 elif kind in ['function_call','custom_tool_call','tool_call']:
  name=p.get('name') or '未知工具';ident=p.get('call_id')
  if isinstance(ident,str) and len(calls)<10000:calls[ident]=str(name)[:120]
  content=p.get('arguments',p.get('input',''));add('calls',json.dumps({'name':name,'arguments':content},ensure_ascii=False),name)
 elif kind in ['function_call_output','custom_tool_call_output','tool_result']:
  output=p.get('output',p.get('content',''));text=output if isinstance(output,str) else text_content(output) if isinstance(output,list) else json.dumps(output,ensure_ascii=False)
  add('results',text,p.get('name') or calls.get(p.get('call_id')) or '未知工具')
 # Encrypted reasoning and image bytes are intentionally not counted as text.
for entry,start in selected:
 try:
  h=json.loads(entry['header']);p=h.get('payload') or {}
  if h.get('type')=='session_meta':
   for key,label in [('base_instructions','基础指令'),('developer_instructions','开发者指令')]:
    value=p.get(key);text=value if isinstance(value,str) else value.get('text','') if isinstance(value,dict) else ''
    if text and text not in seen_base:base_text[label]=text;seen_base.add(text)
 except (ValueError,TypeError,AttributeError):pass
 with entry['path'].open('rb') as f:
  f.seek(start)
  if start:f.readline(16*1024*1024+1)
  while f.tell()<entry['size']:
   line=f.readline(min(16*1024*1024+1,entry['size']-f.tell()));read+=len(line)
   if len(line)>16*1024*1024:
    while line and not line.endswith(b'\n') and f.tell()<entry['size']:line=f.readline(min(262144,entry['size']-f.tell()));read+=len(line)
    partial=True;warnings.add('oversized');omitted+=1;continue
   if not line.endswith(b'\n'):partial=True;warnings.add('incomplete');break
   records+=1
   if records>200000:partial=True;warnings.add('record_limit');break
   try:
    r=json.loads(line);p=r.get('payload') or {};kind=r.get('type')
    if kind=='turn_context' and isinstance(p.get('model'),str):model=p['model'][:120]
    elif kind=='event_msg' and p.get('type')=='token_count' and isinstance(p.get('info'),dict):
     info=p['info'];last=info.get('last_token_usage') or {}
     usage={'last':{k:last.get(k) if type(last.get(k)) in [int,float] and math.isfinite(last[k]) and last[k]>=0 else None for k in ['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']},'window':info.get('model_context_window')};observed=r.get('timestamp')
    elif kind=='response_item':item(p)
    elif kind=='compacted':
     categories={};calls={};images=0;compactions+=1
     # A complete replacement supersedes all earlier projected history.
     if isinstance(p.get('replacement_history'),list):
      for replacement in p['replacement_history']:item(replacement)
      warnings.discard('tail_only');partial=bool(warnings)
     else:
      add('summary',p.get('message') if isinstance(p.get('message'),str) else '')
      partial=True;warnings.add('compaction_partial')
   except (ValueError,TypeError,AttributeError,OverflowError):partial=True;warnings.add('malformed')
for label,text in base_text.items():add('system',text,label)
result=[]
for key in ['system','tools','injections','user','assistant','calls','results','summary','images']:
 c=categories.get(key)
 if c:c['detail']=sorted(c['detail'].values(),key=lambda d:-d['tokens']);result.append(c)
 elif key in ['system','tools'] or key=='images' and images:result.append({'id':key,'name':names[key],'tokens':None,'count':images if key=='images' else 0,'detail':[]})
print(json.dumps({'source':'jsonl','exact':False,'method':method,'partial':partial,'warnings':sorted(warnings),'model':model,'usage':usage,'observed_at':observed,'categories':result,'files_read':len(selected),'records_read':records,'bytes_read':read,'compactions':compactions},ensure_ascii=True,separators=(',',':')))
`;
