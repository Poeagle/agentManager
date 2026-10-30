import {memo,useCallback,useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,Check,Copy,Loader2,Sparkles} from 'lucide-react';
import {api,type ConversationMessage,type ConversationPage,type Session} from '../lib/api';
import {parseConversationInput} from '../lib/conversation-attachments';
import {ConversationAttachmentPicker,ConversationMessageAttachments,useConversationAttachments} from './ConversationAttachments';
import {ConversationMarkdown} from './ConversationMarkdown';
import {ConversationWidthHandles,ConversationNavigator} from './ConversationReadingTools';
import {hasPermission,usePermissions} from '../lib/permissions';
import {conversationClientId,mergeConversationTimeline,type TimelineMessage} from '../lib/conversation-timeline';
import {groupConversationProgress} from '../lib/conversation-progress';
import './SessionConversation.css';

interface LiveProgress {turn_id:string|null;started_at:string|null;stage:'waiting'|'tools'|'answering'|'finishing'|'idle'}

const Bubble=memo(function Bubble({message,streaming,compact=false,agentName,projectPath,projectId,onOpenFile,onNavigate}:{message:ConversationMessage;streaming:boolean;compact?:boolean;agentName:string;projectPath?:string;projectId:string|null;onOpenFile?:(path:string)=>void;onNavigate:()=>void}) {
  const [copied,setCopied]=useState(false);
  const parsed=message.role==='user'?(message.attachments?{text:message.text,attachments:message.attachments}:parseConversationInput(message.text)):{text:message.text,attachments:[]};
  async function copy() {
    const copyText=parsed.text+(parsed.attachments.length?'\n'+parsed.attachments.map(item=>item.name).join('\n'):'');
    try {
      if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(copyText);
      else {
        const area=document.createElement('textarea');area.value=copyText;area.style.position='fixed';area.style.top='-9999px';document.body.appendChild(area);area.select();
        const ok=document.execCommand('copy');area.remove();if(!ok) return;
      }
      setCopied(true);
    } catch {setCopied(false);}
  }
  return <article className={`session-chat-message ${message.role}`} data-phase={message.phase} data-streaming={streaming} data-chat-message-id={message.id}>
    {message.role==='assistant' && !compact && <div className="session-chat-agent"><Sparkles size={16}/><span>{agentName}</span>{message.phase==='final' && <span className="session-chat-writing">结论</span>}{streaming && <span className="session-chat-writing">正在输出</span>}</div>}
    <div className="session-chat-body">{message.role==='user'?<><div className="session-chat-user-text">{parsed.text}</div><ConversationMessageAttachments items={parsed.attachments} projectId={projectId} onOpenFile={onOpenFile}/></>:<ConversationMarkdown content={message.text} messageId={message.id} streaming={streaming} projectPath={projectPath} projectId={projectId} onOpenFile={onOpenFile} onNavigate={onNavigate}/>}{streaming && <span className="session-chat-caret" aria-label="正在输出"/>}</div>
    <div className="session-chat-message-meta">
      {!compact && message.timestamp && <time dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString('zh-CN',{hour12:false})}>{new Date(message.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}</time>}
      <button type="button" onClick={()=>void copy()} aria-label={`复制${message.role==='user'?'你的消息':'Agent 回复'}`} title={copied?'已复制':'复制消息'}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>
    </div>
  </article>;
});

export function SessionConversation({session,active,onRaw,onResume,onClose,resuming=false,resumeFailed=false,userId='local',projectPath,onOpenFile}: {
  session:Session;active:boolean;onRaw:()=>void;onResume?:()=>void;onClose?:()=>void;resuming?:boolean;resumeFailed?:boolean;
  userId?:string;projectPath?:string;onOpenFile?:(path:string)=>void;
}) {
  const permissions=usePermissions();
  const canRead=hasPermission(permissions.data,'agent_api');
  const canSend=hasPermission(permissions.data,'agent_api','write');
  const [messages,setMessages]=useState<TimelineMessage[]>([]);
  const [page,setPage]=useState<ConversationPage|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const [loading,setLoading]=useState(true);
  const [older,setOlder]=useState(false);
  const [error,setError]=useState('');
  const [sendError,setSendError]=useState('');
  const [draft,setDraft]=useState('');
  const attachments=useConversationAttachments(session.id);
  const [sending,setSending]=useState(false);
  const [unread,setUnread]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [liveState,setLiveState]=useState<'connecting'|'connected'|'unavailable'>('connecting');
  const [liveBusy,setLiveBusy]=useState(false);
  const [liveProgress,setLiveProgress]=useState<LiveProgress>({turn_id:null,started_at:null,stage:'idle'});
  const [now,setNow]=useState(Date.now);
  const cursor=useRef<string|undefined>(undefined);
  const generation=useRef<string|null>(null);
  const list=useRef<HTMLDivElement>(null);
  const readingRoot=useRef<HTMLElement>(null);
  const pinned=useRef(true);
  const sendingRef=useRef(false);
  const draftRef=useRef(draft);draftRef.current=draft;
  const bottom=useRef<HTMLDivElement>(null);
  const scrollBottom=()=>{pinned.current=true;setUnread(false);bottom.current?.scrollIntoView({block:'nearest'});};
  const navigate=useCallback(()=>{pinned.current=false;setUnread(false);},[]);
  const ended=['completed','failed','cancelled'].includes(session.status);
  const busy=liveState==='connected'?liveBusy:page?.runtime?.state==='running' || (!page?.runtime && page?.interaction?.processState==='busy');
  useEffect(()=>{
    if(!active || !busy) return;
    setNow(Date.now());const clock=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(clock);
  },[active,busy]);
  useEffect(()=>{if(ended) setMessages(previous=>previous.map(message=>message.streaming?{...message,streaming:false}:message));},[ended]);

  useEffect(()=>{
    if(!active || !canRead) return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const result=await api.agent.conversation(session.id,cursor.current?{after:cursor.current}:{},controller.signal);
        if(controller.signal.aborted) return;
        const reset=result.reset || (generation.current!==null && result.generation!==generation.current);
        const first=!cursor.current || reset;
        generation.current=result.generation;
        setPage(result);setError('');setLoading(false);
        if(first) {setMessages(previous=>{
          if(reset) return mergeConversationTimeline(previous.filter(item=>item.optimistic),result.messages,'prepend');
          return mergeConversationTimeline(previous,result.messages,'prepend');
        });setHasMore(result.has_more);cursor.current=result.messages.at(-1)?.id;}
        else if(result.messages.length) {
          setMessages(previous=>mergeConversationTimeline(previous,result.messages));
          cursor.current=result.messages.at(-1)?.id;
        }
        if(result.messages.length) {
          if(pinned.current) requestAnimationFrame(()=>{if(!controller.signal.aborted) scrollBottom();});
          else if(!first) setUnread(true);
        }
      } catch(failure) {
        if(!controller.signal.aborted) {setError(failure instanceof Error?failure.message:'对话读取失败');setLoading(false);}
      } finally {if(!controller.signal.aborted) timer=setTimeout(()=>void poll(),document.hidden?10000:2000);}
    };
    void poll();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[active,canRead,session.id,refresh]);

  useEffect(()=>{
    if(!active || !canRead || session.cli_type!=='codex' || !page?.native_id || ended) return;
    let disposed=false;const settledIds=new Set<string>();let socket:WebSocket;let retry:ReturnType<typeof setTimeout>;
    const connect=()=>{
      if(disposed) return;
      setLiveState('connecting');
      socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/sessions/${encodeURIComponent(session.id)}/conversation/stream`);
      socket.onmessage=event=>{
        if(disposed) return;
        let frame:{type:string;messages?:ConversationMessage[];busy?:boolean}&Partial<LiveProgress>;try{frame=JSON.parse(event.data);}catch{return;}
        if(frame.type==='unavailable') {setLiveState('unavailable');setLiveBusy(false);return;}
        if(frame.type!=='snapshot' || !Array.isArray(frame.messages)) return;
        setLiveState('connected');setLiveBusy(!!frame.busy);
        if(frame.stage) setLiveProgress({turn_id:frame.turn_id||null,started_at:frame.started_at||null,stage:frame.stage});
        const incoming=frame.messages;
        setMessages(previous=>mergeConversationTimeline(previous,incoming));
        if(incoming.length) {
          if(pinned.current) requestAnimationFrame(()=>{if(!disposed) scrollBottom();});else setUnread(true);
          const settled=incoming.filter(item=>item.role==='assistant' && !item.streaming && !settledIds.has(item.id));
          for(const item of settled)settledIds.add(item.id);
          if(settled.length) setRefresh(value=>value+1);
        }
      };
      socket.onclose=()=>{if(!disposed){setLiveState('unavailable');setLiveBusy(false);retry=setTimeout(connect,2500);}};
      socket.onerror=()=>socket.close();
    };
    connect();
    return ()=>{disposed=true;clearTimeout(retry);socket?.close();};
  },[active,canRead,session.id,session.cli_type,page?.native_id,ended]);

  async function loadOlder() {
    if(older) return;
    setOlder(true);const previousHeight=list.current?.scrollHeight || 0;const previousTop=list.current?.scrollTop || 0;
    try {
      const result=await api.agent.conversation(session.id,{before:messages[0]?.id || '0'.repeat(32)});
      setMessages(previous=>mergeConversationTimeline(previous,result.messages,'prepend'));
      setHasMore(result.has_more);setError('');
      if(!cursor.current) cursor.current=result.messages.at(-1)?.id;
      requestAnimationFrame(()=>{if(list.current) list.current.scrollTop=previousTop+list.current.scrollHeight-previousHeight;});
    } catch(failure) {setError(failure instanceof Error?failure.message:'历史加载失败');}
    finally {setOlder(false);}
  }

  const interaction=page?.interaction;
  const needsAction=!!interaction && interaction.processState==='waiting_for_input' && (interaction.isPermission || interaction.promptType==='choice' || interaction.promptType==='confirmation');
  const waiting=needsAction || page?.runtime?.state==='waiting_for_input';
  async function send() {
    const text=draftRef.current;
    const attached=attachments.values();
    if((!text.trim() && !attached.length) || attachments.uploading || attachments.failed || sendingRef.current || !canSend || !page?.session_active || ended || waiting) return;
    if(new TextEncoder().encode(text).byteLength>64*1024) {setSendError('消息超过 64 KB，请缩短后发送。');return;}
    sendingRef.current=true;setSending(true);setSendError('');
    const clientId=conversationClientId();
    const timestamp=new Date().toISOString(),visibleText=text.trim()?text:attached.length?'请查看附件。':text,attachedIds=attachments.items.map(item=>item.id);
    setMessages(previous=>[...previous,{id:`pending-${clientId}`,client_id:clientId,role:'user',text:visibleText,attachments:attached,timestamp,optimistic:{afterSequence:previous.reduce((last,item)=>Math.max(last,item.sequence??-1),-1)}}]);
    pinned.current=true;requestAnimationFrame(scrollBottom);
    try {
      if(attached.length)await api.agent.sendInput(session.id,text,clientId,attached);else await api.agent.sendInput(session.id,text,clientId);
      attachments.clear(attachedIds);
      // The native turn/started event can precede this HTTP acknowledgement;
      // only initialize the waiting state if a new turn has not arrived yet.
      setLiveProgress(previous=>previous.stage==='idle'?{turn_id:null,started_at:new Date().toISOString(),stage:'waiting'}:previous);
      if(draftRef.current===text) setDraft('');
      pinned.current=true;setRefresh(value=>value+1);requestAnimationFrame(scrollBottom);
    } catch(failure) {setMessages(previous=>previous.filter(item=>!(item.optimistic && item.client_id===clientId)));setSendError(`${failure instanceof Error?failure.message:'发送失败'}。请查看原始终端确认后再重试。`);}
    finally {sendingRef.current=false;setSending(false);}
  }
  const agentName=session.cli_type==='codex'?'Codex':'Claude';
  const lastUserIndex=messages.reduce((last,message,index)=>message.role==='user'?index:last,-1);
  const lastUserTime=messages[lastUserIndex]?.timestamp;
  const currentAnswer=messages.some((message,index)=>index>lastUserIndex && message.role==='assistant' && (!liveProgress.turn_id || message.turn_id===liveProgress.turn_id || message.streaming));
  const started=liveProgress.started_at||lastUserTime;
  const elapsed=started?Math.max(0,Math.floor((now-Date.parse(started))/1000)):0;
  const waitingForText=busy && !currentAnswer;
  const displayed=messages;
  const streamingId=liveState==='connected' && busy && !['tools','finishing'].includes(liveProgress.stage)
    ? messages.reduce<string|null>((id,message,index)=>index>lastUserIndex && message.role==='assistant' && message.streaming && (!liveProgress.turn_id || message.turn_id===liveProgress.turn_id)?message.id:id,null):null;
  const groups=groupConversationProgress(displayed);
  const bubble=(message:ConversationMessage,compact=false)=><Bubble key={message.id} message={message} streaming={message.id===streamingId} compact={compact} agentName={agentName} projectPath={projectPath} projectId={session.project_id} onOpenFile={onOpenFile} onNavigate={navigate}/>;
  return <section ref={readingRoot} className="session-chat" aria-label="会话对话">
    <div className="session-chat-reading">
    <div ref={list} className="session-chat-scroll" onScroll={()=>{if(list.current) pinned.current=list.current.scrollHeight-list.current.scrollTop-list.current.clientHeight<80;}}>
      <div className="session-chat-feed">
        {hasMore && <button className="session-chat-older" disabled={older} onClick={()=>void loadOlder()}>{older?'正在读取…':'加载更早的对话'}</button>}
        {loading && canRead && <p className="session-chat-empty"><Loader2 size={16} className="animate-spin"/>正在读取对话…</p>}
        {!canRead && !permissions.isPending && <p className="session-chat-empty">当前账号没有读取对话的权限，可切换原始终端。</p>}
        {groups.map(group=>group.kind==='message'?bubble(group.message):<section key={`progress-${group.id}`} className="session-chat-progress" aria-label={`${agentName} 进展`}>
          <div className="session-chat-agent"><Sparkles size={16}/><span>{agentName}</span><span className="session-chat-writing">进展</span><span className="session-chat-progress-count">{group.messages.length} 条</span>{busy && groups.at(-1)===group && <span className="session-chat-progress-live">进行中</span>}</div>
          <div className="session-chat-progress-content">{group.messages.map((message,index)=><div key={message.id} className="session-chat-progress-entry" data-active={message.id===streamingId}>
            <div className="session-chat-progress-entry-head"><span className="session-chat-progress-number" aria-label={`进展序号 ${index+1}`}>{index+1}</span>
              {message.timestamp && Number.isFinite(Date.parse(message.timestamp))?<time aria-label="进展时间" dateTime={message.timestamp} title={new Date(message.timestamp).toLocaleString('zh-CN',{hour12:false})}>{new Date(message.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>:<span className="session-chat-progress-time-unknown">时间未知</span>}
              {message.id===streamingId && <span className="session-chat-progress-updating">正在输出</span>}
            </div>{bubble(message,true)}
          </div>)}</div>
        </section>)}
        {waitingForText && <div className="session-chat-thinking" role="status"><Sparkles size={16}/><div><span>{liveProgress.stage==='tools'?`${agentName} 正在执行任务`:`等待 ${agentName} 返回正文`}</span><time className="session-chat-elapsed">{elapsed} 秒</time><p>尚未收到正文，收到后会立即逐段显示。</p></div></div>}
        {!loading && canRead && !messages.length && <div className="session-chat-empty"><p>这里显示你的消息、Agent 的进展说明和回答。</p><p>{page?.available?'还没有对话记录。':'尚未读取到绑定的原生对话记录。'}<button onClick={onRaw}>查看原始终端</button></p></div>}
        {error && <p role="alert" className="session-chat-error">{error}<button onClick={()=>setRefresh(value=>value+1)}>重试</button></p>}
        <div ref={bottom}/>
      </div>
    </div>
    <ConversationWidthHandles root={readingRoot} scroll={list} active={active} storageKey={`agentmanager-chat-width:${userId}`}/>
    {canRead && <ConversationNavigator messages={displayed} scroll={list} active={active} hasMore={hasMore} loadingOlder={older} onLoadOlder={()=>void loadOlder()} onNavigate={navigate}/>}
    </div>
    {unread && <button className="session-chat-new" onClick={scrollBottom}><ArrowDown size={14}/>有新消息</button>}
    {waiting && <div className="session-chat-action" role="status"><strong>{interaction?.isPermission?'Agent 需要授权':'Agent 需要你确认或选择'}</strong>
      {interaction?.choices?.length ? <p>{interaction.choices.join(' / ')}</p>:null}<button onClick={onRaw}>切到原始终端处理</button></div>}
    <footer className="session-chat-composer">
      <div className="session-chat-status" role="status"><span className={`session-chat-connection ${liveState}`} aria-hidden="true"/>{ended?'会话已结束':waiting?'等待你处理':busy?liveProgress.stage==='tools'?'正在执行任务…':waitingForText?'等待正文…':liveProgress.stage==='finishing'?'正在完成本轮…':streamingId?'正文接收中…':'正在处理…':page?.session_active?'可以继续发送消息':'等待会话就绪'}
        {liveState==='connected' && <span className="session-chat-live-label">事件通道已连接</span>}
        {ended && onResume && <button onClick={onResume} disabled={resuming}>{resuming?'正在恢复…':resumeFailed?'重试恢复会话':'恢复会话'}</button>}{ended && onClose && <button onClick={onClose}>关闭会话</button>}
      </div>
      {sendError && <p role="alert" className="session-chat-error">{sendError}</p>}
      <form onSubmit={event=>{event.preventDefault();void send();}}
        onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=canSend&&!ended&&!sending?'copy':'none';}}}
        onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();if(canSend&&!ended&&!sending)attachments.enqueue(Array.from(event.dataTransfer.files));}}>
        <textarea aria-label="发送给当前 Agent 的消息" value={draft} onChange={event=>setDraft(event.target.value)} placeholder={waiting?'请先在原始终端完成交互':'输入消息，Enter 发送，Shift+Enter 换行'} disabled={!canSend || ended || waiting} rows={2}
          onPaste={event=>{const files=Array.from(event.clipboardData.files);if(!files.length)return;event.preventDefault();if(canSend&&!ended&&!sending)attachments.enqueue(files);}}
          onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/>
        <div className="session-chat-input-tools"><ConversationAttachmentPicker items={attachments.items} error={attachments.error} disabled={!canSend||ended||sending} onFiles={attachments.enqueue} onRemove={attachments.remove}/><span>Enter 发送 · Shift+Enter 换行</span><button type="submit" aria-label="发送消息" disabled={sending||attachments.uploading||attachments.failed||!canSend||(!draft.trim()&&!attachments.items.length)||!page?.session_active||ended||waiting}>{sending?<Loader2 size={17} className="animate-spin"/>:<ArrowUp size={18}/>}</button></div>
      </form>
      <p className="session-chat-hint">{liveState==='unavailable' && session.cli_type==='codex'?'当前会话未提供实时事件，进展说明和答复会自动更新。':'展示对话、进展说明与答复'}<span>工具详情、文件及授权可在原始终端处理</span></p>
    </footer>
  </section>;
}
