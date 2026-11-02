import {ConversationPromptEnhancer} from './ConversationPromptEnhancer';
import {ConversationComposerEditor} from './ConversationComposerEditor';
import {ConversationImagePreviewRoot} from './ConversationImagePreview';
import {ConversationControls} from './ConversationControls';
import {ConversationAutomaticContext} from './ConversationAutomaticContext';
import {automaticConversationContext} from '../lib/conversation-context';
import {ConversationInteraction,ConversationAsyncQuestion,ConversationQuestionSummary,type ConversationInteractionRequest} from './ConversationInteraction';
import {memo,useCallback,useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {AlertTriangle,ArrowDown,ArrowUp,Check,Copy,Loader2,Sparkles} from 'lucide-react';
import {api,type ConversationMessage,type ConversationPage,type ConversationControlsData,type Session} from '../lib/api';
import {decodeQuestionReply,questionAnswers} from '../lib/conversation-question-reply';
import {parseConversationInput} from '../lib/conversation-attachments';
import {ConversationAttachmentPicker,ConversationMessageAttachments,useConversationAttachments} from './ConversationAttachments';
import {ConversationMarkdown} from './ConversationMarkdown';
import {ConversationWidthHandles,ConversationNavigator} from './ConversationReadingTools';
import {hasPermission,usePermissions} from '../lib/permissions';
import {conversationClientId,mergeConversationTimeline,type TimelineMessage} from '../lib/conversation-timeline';
import {groupConversationProgress} from '../lib/conversation-progress';
import {conversationTimings,elapsedBetween,formatConversationTimestamp} from '../lib/conversation-timing';
import {ConversationActivityLine,type ConversationActivity} from './ConversationActivityLine';
import './SessionConversation.css';

interface LiveProgress {turn_id:string|null;started_at:string|null;completed_at?:string|null;activities?:ConversationActivity[];stage:'waiting'|'tools'|'answering'|'finishing'|'idle'}

const Bubble=memo(function Bubble({message,streaming,retrying=false,compact=false,agentName,projectPath,projectId,onOpenFile,onNavigate,durationLabel,durationTitle,onRaw}:{durationLabel?:string;durationTitle?:string;retrying?:boolean;onRaw:()=>void;message:ConversationMessage;streaming:boolean;compact?:boolean;agentName:string;projectPath?:string;projectId:string|null;onOpenFile?:(path:string)=>void;onNavigate:()=>void}) {
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
  const metadata=(<span className="session-chat-message-meta">
      {durationLabel && <span className="session-chat-message-duration" title={durationTitle}>{durationLabel}</span>}
      {!compact && message.timestamp && <time dateTime={message.timestamp} title={`原生消息记录时间：${new Date(message.timestamp).toLocaleString('zh-CN',{hour12:false})}（本地时区）；不代表阶段开始时间`}>{formatConversationTimestamp(message.timestamp)}</time>}
      <button type="button" onClick={()=>void copy()} aria-label={`复制${message.role==='user'?'你的消息':'Agent 回复'}`} title={copied?'已复制':'复制消息'}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>
    </span>);
  const automatic=message.role==='user'?automaticConversationContext(message.text):null;
  if(automatic)return <ConversationAutomaticContext message={message} context={automatic} copied={copied} onCopy={()=>void copy()}/>;
  if(message.phase==='error')return <article className="session-chat-message session-chat-error-notice" role="alert" data-phase="error" data-streaming="false" data-retrying={retrying} data-retry-ended={!!message.error?.will_retry && !retrying} data-chat-message-id={message.id}>
    <div className="session-chat-error-heading"><AlertTriangle size={16}/><strong>{message.error?.will_retry?retrying?'执行遇到错误，正在自动重试':'重试已结束':'本轮执行出错'}</strong>{message.timestamp && <time dateTime={message.timestamp} title={`原生消息记录时间：${new Date(message.timestamp).toLocaleString('zh-CN',{hour12:false})}（本地时区）；不代表阶段开始时间`}>{formatConversationTimestamp(message.timestamp)}</time>}</div>
    <p className="session-chat-error-original">{message.text}</p>
    <p>{message.error?.will_retry?retrying?'Agent 正在自动重试，无需重复发送。':'该次重试过程已结束。':message.error?.code==='server_overloaded' || /at capacity/i.test(message.text)?'当前模型繁忙，本轮已停止。可稍后重试，或在原始终端切换模型。':'本轮已停止。请根据错误信息处理后再试。'}</p>
    <div className="session-chat-error-actions"><button type="button" onClick={onRaw}>查看原始终端</button><button type="button" onClick={()=>void copy()}>{copied?'已复制':'复制错误信息'}</button></div>
  </article>;
  return <article className={`session-chat-message ${message.role}`} data-phase={message.phase} data-streaming={streaming} data-chat-message-id={message.id}>
    {message.role==='assistant' && !compact && <div className="session-chat-agent"><Sparkles size={16}/><span>{agentName}</span>{message.phase==='final' && <span className="session-chat-writing">结论</span>}{streaming && <span className="session-chat-writing">正在输出</span>}</div>}
    <div className="session-chat-body">{message.role==='user'?<><div className="session-chat-user-text">{parsed.attachments.length?parsed.text.trimEnd():parsed.text}<ConversationMessageAttachments items={parsed.attachments} projectId={projectId} projectPath={projectPath} onOpenFile={onOpenFile}/></div>{metadata}</>:<ConversationMarkdown content={message.text} messageId={message.id} footer={!compact?metadata:undefined} streaming={streaming} projectPath={projectPath} projectId={projectId} onOpenFile={onOpenFile} onNavigate={onNavigate}/>}{streaming && <span className="session-chat-caret" aria-label="正在输出"/>}</div>
    {message.role==='assistant'&&compact&&metadata}
  </article>;
});

export function SessionConversation({session,active,onRaw,onResume,onClose,resuming=false,resumeFailed=false,userId='local',projectPath,onOpenFile}: {
  session:Session;active:boolean;onRaw:()=>void;onResume?:()=>void;onClose?:()=>void;resuming?:boolean;resumeFailed?:boolean;
  userId?:string;projectPath?:string;onOpenFile?:(path:string)=>void;
}) {
  const permissions=usePermissions();
  const queryClient=useQueryClient();
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
  const [minimizedQuestion,setMinimizedQuestion]=useState<string|null>(null);
  const attachments=useConversationAttachments(session.id);
  const [sending,setSending]=useState(false);
  const [unread,setUnread]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [liveState,setLiveState]=useState<'connecting'|'connected'|'unavailable'>('connecting');
  const [connectionGeneration,setConnectionGeneration]=useState(0);
  const [requests,setRequests]=useState<ConversationInteractionRequest[]>([]);
  const liveSocket=useRef<WebSocket|null>(null);
  const pushAvailable=useRef(false);
  const pendingAnswers=useRef(new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>());
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
  const focusedQuestion=useRef<string|null>(null);
  const timelineRef=useRef(messages);timelineRef.current=messages;
  const scrollBottom=()=>{
    pinned.current=true;setUnread(false);bottom.current?.scrollIntoView({block:'nearest'});
    const timeline=timelineRef.current,lastHuman=timeline.reduce((last,item,index)=>item.role==='user'&&!automaticConversationContext(item.text)?index:last,-1);
    const question=timeline.slice(lastHuman+1).reduce<ConversationMessage|null>((last,item)=>item.async_questions?.length?item:last,null);
    if(question&&focusedQuestion.current!==question.id) {
      const node=[...(list.current?.querySelectorAll<HTMLElement>('[data-chat-message-id]')||[])].find(item=>item.dataset.chatMessageId===question.id);
      if(node){focusedQuestion.current=question.id;node.scrollIntoView({block:'nearest'});}
    }
  };
  const navigate=useCallback(()=>{pinned.current=false;setUnread(false);},[]);
  const ended=['completed','failed','cancelled'].includes(session.status);
  const lastUserIndex=messages.reduce((last,message,index)=>message.role==='user'&&!automaticConversationContext(message.text)?index:last,-1);
  const latestAssistant=messages.reduce<ConversationMessage|null>((last,message,index)=>index>lastUserIndex && message.role==='assistant'?message:last,null);
  const activeError=latestAssistant?.phase==='error' && (liveState!=='connected' || !liveProgress.turn_id || !latestAssistant.turn_id || latestAssistant.turn_id===liveProgress.turn_id)?latestAssistant:null;
  const busy=!(activeError && !activeError.error?.will_retry) && (liveState==='connected'?liveBusy:page?.runtime?.state==='running' || (!page?.runtime && page?.interaction?.processState==='busy'));
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
      } finally {if(!controller.signal.aborted) timer=setTimeout(()=>void poll(),pushAvailable.current?30000:document.hidden?10000:2000);}
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
      liveSocket.current=socket;setConnectionGeneration(value=>value+1);
      socket.onmessage=event=>{
        if(disposed) return;
        let frame:{type:string;model?:string;effort?:string|null;messages?:ConversationMessage[];runtime?:ConversationPage['runtime'];busy?:boolean;interactions?:ConversationInteractionRequest[];request_id?:string;ok?:boolean;error?:string}&Partial<LiveProgress>;try{frame=JSON.parse(event.data);}catch{return;}
        if(frame.type==='settings'&&typeof frame.model==='string'){queryClient.setQueryData<ConversationControlsData>(['conversation-controls',session.id],previous=>previous?{...previous,model:frame.model!,effort:frame.effort??null,pending:null}:previous);return;}
        if(frame.type==='interaction_result' && frame.request_id) {const pending=pendingAnswers.current.get(frame.request_id);if(pending){clearTimeout(pending.timer);pendingAnswers.current.delete(frame.request_id);if(frame.ok)pending.resolve();else pending.reject(new Error(frame.error||'提交失败'));}return;}
        if(frame.type==='history'&&Array.isArray(frame.messages)){pushAvailable.current=true;setMessages(previous=>mergeConversationTimeline(previous,frame.messages!));setPage(previous=>previous?{...previous,runtime:frame.runtime||previous.runtime}:previous);if(frame.messages.length){if(pinned.current)requestAnimationFrame(()=>{if(!disposed)scrollBottom();});else setUnread(true);}return;}
        if(frame.type==='unavailable') {pushAvailable.current=false;setLiveState('unavailable');setLiveBusy(false);return;}
        if(frame.type!=='snapshot' || !Array.isArray(frame.messages)) return;
        pushAvailable.current=true;setLiveState('connected');setLiveBusy(!!frame.busy);
        setRequests(Array.isArray(frame.interactions)?frame.interactions:[]);
        if(frame.stage) setLiveProgress({turn_id:frame.turn_id||null,started_at:frame.started_at||null,completed_at:frame.completed_at||null,activities:Array.isArray(frame.activities)?frame.activities:[],stage:frame.stage});
        const incoming=frame.messages;
        setMessages(previous=>mergeConversationTimeline(previous,incoming));
        if(incoming.length) {
          if(pinned.current) requestAnimationFrame(()=>{if(!disposed) scrollBottom();});else setUnread(true);
          const settled=incoming.filter(item=>item.role==='assistant' && !item.streaming && !settledIds.has(item.id));
          for(const item of settled)settledIds.add(item.id);
          if(settled.length) setRefresh(value=>value+1);
        }
      };
      socket.onclose=()=>{if(!disposed){pushAvailable.current=false;liveSocket.current=null;for(const pending of pendingAnswers.current.values()){clearTimeout(pending.timer);pending.reject(new Error('连接已断开，请重连核对请求状态'));}pendingAnswers.current.clear();setLiveState('unavailable');setLiveBusy(false);retry=setTimeout(connect,2500);}};
      socket.onerror=()=>socket.close();
    };
    connect();
    return ()=>{disposed=true;clearTimeout(retry);socket?.close();pushAvailable.current=false;liveSocket.current=null;for(const pending of pendingAnswers.current.values()){clearTimeout(pending.timer);pending.reject(new Error('连接已关闭，请重新连接后确认请求状态'));}pendingAnswers.current.clear();};
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
  const nativeStateKnown=session.cli_type==='codex' && !!page?.runtime && page.runtime.state!=='unknown';
  const needsAction=(!nativeStateKnown || page?.runtime?.state==='waiting_for_input') && !!interaction && interaction.processState==='waiting_for_input' && (interaction.isPermission || interaction.promptType==='choice' || interaction.promptType==='confirmation');
  const waiting=requests.length?requests.some(request=>request.blocking):needsAction || page?.runtime?.state==='waiting_for_input';
  function answerRequest(id:string,answer:unknown):Promise<void> {
    const socket=liveSocket.current;
    if(!canSend||!socket||socket.readyState!==1)return Promise.reject(new Error('当前连接不可提交，请重新连接后处理'));
    if(pendingAnswers.current.has(id))return Promise.reject(new Error('该回答正在提交'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pendingAnswers.current.delete(id);reject(new Error('未收到提交确认，请重连核对请求状态后再处理'));},10000);
      pendingAnswers.current.set(id,{resolve,reject,timer});
      try {socket.send(JSON.stringify({type:'interaction_response',request_id:id,answer}));}catch {clearTimeout(timer);pendingAnswers.current.delete(id);reject(new Error('连接已断开'));}
    });
  }
  async function send(questionReply?:string) {
    const fromQuestion=questionReply!==undefined;
    const text=questionReply??draftRef.current;
    const attached=fromQuestion?[]:attachments.values();
    if((!text.trim() && !attached.length) || !fromQuestion&&(attachments.uploading || attachments.failed) || sendingRef.current || !canSend || !page?.session_active || ended || waiting) {if(fromQuestion)throw new Error('当前无法提交回答，请等待会话就绪或完成其他交互');return;}
    if(new TextEncoder().encode(text).byteLength>64*1024) {if(fromQuestion)throw new Error('回答超过 64 KB，请缩短后发送');setSendError('消息超过 64 KB，请缩短后发送。');return;}
    sendingRef.current=true;setSending(true);setSendError('');
    const clientId=conversationClientId();
    const parsedReply=decodeQuestionReply(text);
    const timestamp=new Date().toISOString(),visibleText=parsedReply?.text??(text.trim()?text:attached.length?'请查看附件。':text),attachedIds=fromQuestion?[]:attachments.items.map(item=>item.id);
    setMessages(previous=>[...previous,{id:`pending-${clientId}`,client_id:clientId,role:'user',text:visibleText,attachments:attached,timestamp,...(parsedReply?{question_replies:parsedReply.answers}:{}),optimistic:{afterSequence:previous.reduce((last,item)=>Math.max(last,item.sequence??-1),-1)}}]);
    pinned.current=true;requestAnimationFrame(scrollBottom);
    try {
      if(attached.length)await api.agent.sendInput(session.id,text,clientId,attached);else await api.agent.sendInput(session.id,text,clientId);
      if(!fromQuestion)attachments.clear(attachedIds);
      // The native turn/started event can precede this HTTP acknowledgement;
      // only initialize the waiting state if a new turn has not arrived yet.
      setLiveProgress(previous=>previous.stage==='idle'?{turn_id:null,started_at:new Date().toISOString(),stage:'waiting'}:previous);
      if(!fromQuestion&&draftRef.current===text) setDraft('');
      pinned.current=true;setRefresh(value=>value+1);requestAnimationFrame(scrollBottom);
    } catch(failure) {setMessages(previous=>previous.filter(item=>!(item.optimistic && item.client_id===clientId)));if(fromQuestion){setSendError(failure instanceof Error?failure.message:'回答提交失败');throw failure;}setSendError(`${failure instanceof Error?failure.message:'发送失败'}。请查看原始终端确认后再重试。`);}
    finally {sendingRef.current=false;setSending(false);}
  }
  const agentName=session.cli_type==='codex'?'Codex':'Claude';
  const lastUserTime=messages[lastUserIndex]?.timestamp;
  const currentAnswer=messages.some((message,index)=>index>lastUserIndex && message.role==='assistant' && message.phase!=='error' && (!liveProgress.turn_id || message.turn_id===liveProgress.turn_id || message.streaming));
  const currentTurn=liveProgress.turn_id||messages[lastUserIndex]?.turn_id;
  const continuingAfterFollowup=busy && !currentAnswer && !!currentTurn && messages.some((message,index)=>index<lastUserIndex && message.role==='assistant' && message.turn_id===currentTurn);
  const started=continuingAfterFollowup?lastUserTime:liveProgress.started_at||lastUserTime;
  const elapsed=started?Math.max(0,Math.floor((now-Date.parse(started))/1000)):0;
  const waitingForText=busy && !currentAnswer && !activeError && !waiting;
  const displayed=messages;
  const streamingId=!activeError && liveState==='connected' && busy && !['tools','finishing'].includes(liveProgress.stage)
    ? messages.reduce<string|null>((id,message,index)=>index>lastUserIndex && message.role==='assistant' && message.streaming && (!liveProgress.turn_id || message.turn_id===liveProgress.turn_id)?message.id:id,null):null;
  const groups=groupConversationProgress(displayed);
  const timings=conversationTimings(displayed,now,busy,liveProgress.turn_id);
  const pendingQuestion=messages.slice(lastUserIndex+1).reduce<ConversationMessage|null>((last,message)=>message.async_questions?.length?message:last,null);
  const questionActive=!!pendingQuestion&&minimizedQuestion!==pendingQuestion.id;
  const bubble=(message:ConversationMessage,compact=false)=>message.async_questions?.length?<ConversationQuestionSummary key={message.id} message={message} answers={questionAnswers(message,messages.slice(messages.indexOf(message)+1))} continued={messages.slice(messages.indexOf(message)+1).some(item=>item.role==='user'&&!automaticConversationContext(item.text))} onAnswer={()=>setMinimizedQuestion(null)}/>:<Bubble key={message.id} message={message} streaming={message.id===streamingId} retrying={message.id===activeError?.id && !!busy && !!message.error?.will_retry} compact={compact} durationLabel={!compact?timings.get(message.id)?.label:undefined} durationTitle={!compact?timings.get(message.id)?.title:undefined} agentName={agentName} projectPath={projectPath} projectId={session.project_id} onOpenFile={onOpenFile} onNavigate={navigate} onRaw={onRaw}/>;
  return <ConversationImagePreviewRoot active={active} onOpen={navigate}><section ref={readingRoot} className="session-chat" aria-label="会话对话">
    <ConversationPromptEnhancer sessionId={session.id} active={active} canEdit={canSend&&!ended&&!waiting} value={draft} onApply={setDraft}/>
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
              {message.timestamp && Number.isFinite(Date.parse(message.timestamp))?<time aria-label="进展时间" dateTime={message.timestamp} title={`原生消息记录时间：${new Date(message.timestamp).toLocaleString('zh-CN',{hour12:false})}（本地时区）；不代表阶段开始时间`}>{formatConversationTimestamp(message.timestamp)}</time>:<span className="session-chat-progress-time-unknown">时间未知</span>}
              {timings.get(message.id) && <span className="session-chat-message-duration" title={timings.get(message.id)!.title}>{timings.get(message.id)!.label}</span>}
              {message.id===streamingId && <span className="session-chat-progress-updating">正在输出</span>}
            </div>{bubble(message,true)}
          </div>)}</div>
        </section>)}
        {waitingForText && <div className="session-chat-thinking" role="status"><Sparkles size={16}/><div><span>{continuingAfterFollowup?sending?'正在提交追问…':`追问已提交，${agentName} 正在继续执行`:liveProgress.stage==='tools'?`${agentName} 正在执行任务`:`等待 ${agentName} 返回正文`}</span><time className="session-chat-elapsed">{elapsed} 秒</time><p>{continuingAfterFollowup?'当前任务仍在进行，新进展到达后会自动追加。':liveProgress.stage==='tools'?'正在执行任务，新进展到达后会立即显示。':'尚未收到正文，收到后会立即逐段显示。'}</p></div></div>}
        {!loading && canRead && !messages.length && <div className="session-chat-empty"><p>这里显示你的消息、Agent 的进展说明和回答。</p><p>{page?.available?'还没有对话记录。':'尚未读取到绑定的原生对话记录。'}<button onClick={onRaw}>查看原始终端</button></p></div>}
        {error && <p role="alert" className="session-chat-error">{error}<button onClick={()=>setRefresh(value=>value+1)}>重试</button></p>}
        <div ref={bottom}/>
      </div>
    </div>
    <ConversationWidthHandles root={readingRoot} scroll={list} active={active} storageKey={`agentmanager-chat-width:${userId}`}/>
    {canRead && <ConversationNavigator messages={displayed} scroll={list} active={active} hasMore={hasMore} loadingOlder={older} onLoadOlder={()=>void loadOlder()} onNavigate={navigate}/>}
    </div>
    {unread && <button className="session-chat-new" onClick={scrollBottom}><ArrowDown size={14}/>有新消息</button>}
    {requests.length>0&&<div className="conversation-interactions">{requests.length>1&&<p className="conversation-interaction-queue">还有 {requests.length-1} 项待处理</p>}{requests.slice(0,1).map(request=><ConversationInteraction key={`${connectionGeneration}:${request.id}`} request={request} storageKey={`agentmanager-question:${userId}:${session.id}:${request.id}`} connected={active&&liveState==='connected'} canAnswer={canSend&&!ended} onAnswer={answerRequest} onRaw={onRaw}/>)}</div>}
    {waiting && !requests.length && <div className="session-chat-action" role="status"><strong>{interaction?.isPermission?'Agent 需要授权':'Agent 需要你确认或选择'}</strong>
      {interaction?.choices?.length ? <p>{interaction.choices.join(' / ')}</p>:null}<button onClick={onRaw}>切到原始终端处理</button></div>}
    <footer className="session-chat-composer">
      <div className="session-chat-status" role="status"><span className={`session-chat-connection ${liveState}`} aria-hidden="true"/>
        <ConversationActivityLine key={`${session.id}:${liveState}:${liveProgress.turn_id||''}`} activities={liveState==='connected'?liveProgress.activities||[]:[]} busy={busy&&!ended&&!waiting&&!activeError} now={now} totalElapsed={elapsedBetween(started,now)}
          fallback={activeError?activeError.error?.will_retry?busy?'执行遇到错误，正在自动重试…':'重试已结束':'本轮执行失败，可处理后重试':ended?'会话已结束':waiting?'等待你处理':continuingAfterFollowup?sending?'正在提交追问…':'追问已提交，任务继续执行中…':busy?liveProgress.stage==='tools'?'正在执行任务…':waitingForText?'等待正文…':liveProgress.stage==='finishing'?'正在完成本轮…':streamingId?'正文接收中…':'正在处理…':page?.session_active?'可以继续发送消息':'等待会话就绪'}/>
        {liveState==='connected' && <span className="session-chat-live-label">事件通道已连接</span>}
        {ended && onResume && <button onClick={onResume} disabled={resuming}>{resuming?'正在恢复…':resumeFailed?'重试恢复会话':'恢复会话'}</button>}{ended && onClose && <button onClick={onClose}>关闭会话</button>}
      </div>
      {sendError && <p role="alert" className="session-chat-error">{sendError}</p>}
      {pendingQuestion&&<div className="session-chat-question-seat">{questionActive?<ConversationAsyncQuestion key={pendingQuestion.id} message={pendingQuestion} agentName={agentName} storageKey={`agentmanager-question:${userId}:${session.id}:${pendingQuestion.id}`} connected={active&&!!page?.session_active&&!ended} canAnswer={canSend} onReply={send} onRaw={onRaw} onMinimize={()=>setMinimizedQuestion(pendingQuestion.id)}/>:<button type="button" className="session-chat-question-reminder" onClick={()=>setMinimizedQuestion(null)}>待回答 · {pendingQuestion.async_questions?.[0].title}<span>回答问题</span></button>}</div>}
      <form hidden={questionActive} onSubmit={event=>{event.preventDefault();void send();}}
        onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=canSend&&!ended&&!sending?'copy':'none';}}}
        onDrop={event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();if(canSend&&!ended&&!sending)attachments.enqueue(Array.from(event.dataTransfer.files));}}>
        <ConversationComposerEditor value={draft} items={attachments.items} disabled={!canSend||ended||waiting} placeholder={waiting?'请先处理上方交互':'输入消息，Enter 发送，Shift+Enter 换行'} projectId={session.project_id} projectPath={projectPath} onChange={setDraft} onRemove={attachments.remove} onFiles={attachments.enqueue} onSubmit={()=>void send()}/>
        {attachments.error&&<p role="alert" className="session-chat-error">{attachments.error}</p>}

        <div className="session-chat-input-tools"><ConversationAttachmentPicker disabled={!canSend||ended||sending} onFiles={attachments.enqueue}/><span>Enter 发送 · Shift+Enter 换行</span><button type="submit" aria-label="发送消息" disabled={sending||attachments.uploading||attachments.failed||!canSend||(!draft.trim()&&!attachments.items.length)||!page?.session_active||ended||waiting}>{sending?<Loader2 size={17} className="animate-spin"/>:<ArrowUp size={18}/>}</button></div>
      </form>
      {session.cli_type==='codex'&&!!page?.native_id&&canRead&&<ConversationControls sessionId={session.id} active={active}/>}
    </footer>
  </section></ConversationImagePreviewRoot>;
}
