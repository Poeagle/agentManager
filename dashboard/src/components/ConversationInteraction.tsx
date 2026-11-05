import {useDisplayClock} from '../lib/display-clock';
import type {ConversationMessage} from '../lib/api';
import {encodeQuestionReply} from '../lib/conversation-question-reply';
import {ConversationQuestionEditor,type QuestionAttachmentContext,type QuestionAttachmentMap,type QuestionAttachmentState} from './ConversationQuestionEditor';
import type {DraftAttachment} from './ConversationAttachments';
import type {ConversationAttachment} from '../lib/conversation-attachments';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import {memo,useCallback,useRef,useState} from 'react';
import {Check,Loader2,MessageCircleQuestion,ShieldCheck} from 'lucide-react';

export interface ConversationInteractionRequest {
  id:string;turn_id:string;kind:'question'|'command'|'file'|'permissions';title:string;detail:string;blocking:boolean;submitted:boolean;
  questions?:Array<{id:string;header:string;question:string;isOther:boolean;isSecret:boolean;options:Array<{label:string;description:string}>|null}>;
}
interface Draft {choice:string;custom:string;attachments?:DraftAttachment[]}
function readyAttachments(items:unknown):DraftAttachment[]{
  if(!Array.isArray(items))return [];
  return items.slice(0,8).flatMap((item,index)=>{
    if(item?.status!=='ready'||typeof item.path!=='string'||!item.path.startsWith('/')||typeof item.name!=='string'||!['image','file'].includes(item.kind))return [];
    return [{id:typeof item.id==='string'?item.id:`saved-${index}`,name:item.name,kind:item.kind,path:item.path,size:Number.isFinite(item.size)?Math.max(0,item.size):0,status:'ready' as const,...Number.isSafeInteger(item.offset)&&item.offset>=0?{offset:item.offset}:{}}];
  });
}
function sameAttachments(a:DraftAttachment[]=[],b:DraftAttachment[]=[]){return a.length===b.length&&a.every((item,index)=>{const next=b[index];return item.id===next.id&&item.name===next.name&&item.kind===next.kind&&item.path===next.path&&item.size===next.size&&item.status===next.status&&item.offset===next.offset;});}
export function ConversationInteraction({request,storageKey,connected,canAnswer,onAnswer,onRaw,inline=false,resolvedLabel,onMinimize,attachmentContext,attachmentHint='附件将以文件引用随回答发送'}:{
  request:ConversationInteractionRequest;storageKey:string;connected:boolean;canAnswer:boolean;
  onAnswer:(id:string,answer:unknown,attachments?:QuestionAttachmentMap)=>Promise<void>;onRaw:()=>void;inline?:boolean;resolvedLabel?:string;onMinimize?:()=>void;attachmentContext?:QuestionAttachmentContext;attachmentHint?:string;
}) {
  const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>{
    try {const value=JSON.parse(sessionStorage.getItem(storageKey)||'{}');return Object.fromEntries((request.questions||[]).filter(q=>!q.isSecret).flatMap(q=>typeof value[q.id]?.choice==='string'&&typeof value[q.id]?.custom==='string'?[[q.id,{choice:value[q.id].choice,custom:value[q.id].custom,attachments:readyAttachments(value[q.id].attachments)}]]:[]));}catch{return {};}
  });
  const [files,setFiles]=useState<Record<string,QuestionAttachmentState>>({});
  const latestRequest=useRef(request);latestRequest.current=request;
  const form=useRef<HTMLFormElement>(null);
  const [sending,setSending]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  const submitted=request.submitted||sent;
  const disabled=!connected||!canAnswer||sending||submitted;
  const update=useCallback((id:string,value:Partial<Draft>)=>{
    setDrafts(previous=>{
      const next={...previous,[id]:{...(previous[id]??{choice:'',custom:''}),...value}};
      if((previous[id]?.choice||'')===next[id].choice&&(previous[id]?.custom||'')===next[id].custom&&sameAttachments(previous[id]?.attachments,next[id].attachments))return previous;
      if(!latestRequest.current.questions?.find(q=>q.id===id)?.isSecret)try {sessionStorage.setItem(storageKey,JSON.stringify(Object.fromEntries((latestRequest.current.questions||[]).filter(q=>!q.isSecret&&next[q.id]).map(q=>[q.id,next[q.id]]))));}catch{/* The in-memory draft remains usable. */}
      return next;
    });setError('');
  },[storageKey]);
  const onAttachments=useCallback((id:string,state:QuestionAttachmentState|null)=>{
    setFiles(previous=>{if(!state){if(!previous[id])return previous;const next={...previous};delete next[id];return next;}if(previous[id]&&sameAttachments(previous[id].items,state.items))return previous;return {...previous,[id]:state};});
    if(state)update(id,{attachments:readyAttachments(state.items)});
  },[update]);
  const customQuestion=(id:string)=>!request.questions?.find(q=>q.id===id)?.options?.length||drafts[id]?.choice==='custom';
  const activeFiles=(request.questions||[]).flatMap(q=>customQuestion(q.id)?files[q.id]?.items||[]:[]);
  const uploading=activeFiles.some(item=>['queued','uploading','packing'].includes(item.status)),failed=activeFiles.some(item=>item.status==='error');
  const limitError=activeFiles.length>8?'本次回答合计最多支持 8 个附件':activeFiles.reduce((sum,item)=>sum+item.size,0)>50*1024*1024?'本次回答的附件合计最多 50 MB':activeFiles.filter(item=>item.kind==='image').reduce((sum,item)=>sum+item.size,0)>10*1024*1024?'本次回答的图片合计最多 10 MB':'';
  function validateFiles(selected:File[]){const plain=selected.filter(file=>!file.webkitRelativePath),directories=new Set(selected.filter(file=>file.webkitRelativePath).map(file=>file.webkitRelativePath.split('/')[0]));
    if(activeFiles.length+plain.length+directories.size>8)return '本次回答合计最多支持 8 个附件';
    if([...activeFiles,...plain].reduce((sum,item)=>sum+item.size,0)>50*1024*1024)return '本次回答的附件合计最多 50 MB';
    if(activeFiles.filter(item=>item.kind==='image').reduce((sum,item)=>sum+item.size,0)+plain.filter(file=>/^image\/(png|jpeg|gif|webp)$/i.test(file.type)).reduce((sum,file)=>sum+file.size,0)>10*1024*1024)return '本次回答的图片合计最多 10 MB';
    return '';
  }
  async function submit(answer:unknown,attached?:QuestionAttachmentMap) {
    if(disabled||uploading||failed||limitError||lock.current)return;lock.current=true;setSending(true);setError('');
    try {if(attached&&Object.values(attached).some(items=>items.length))await onAnswer(request.id,answer,attached);else await onAnswer(request.id,answer);setSent(true);try{sessionStorage.removeItem(storageKey);}catch{/* Optional storage. */}}
    catch(failure){setError(failure instanceof Error?failure.message:'提交失败，请检查连接');}
    finally{lock.current=false;setSending(false);}
  }
  const complete=(request.questions||[]).every(q=>customQuestion(q.id)?!!drafts[q.id]?.custom.trim()||!!files[q.id]?.values.length:!!drafts[q.id]?.choice);
  return <section className={`conversation-interaction${inline?' conversation-interaction-inline':''}`} aria-label={request.title}>
    <header>{request.kind==='question'?<MessageCircleQuestion size={16}/>:<ShieldCheck size={16}/>}<strong>{request.title}</strong>{!request.blocking&&<span>可稍后回答</span>}{submitted&&<span><Check size={13}/>{resolvedLabel||'已提交'}</span>}</header>
    <form ref={form} onSubmit={event=>{event.preventDefault();if(!complete)return;const answers=Object.fromEntries((request.questions||[]).map(q=>{const draft=drafts[q.id];return [q.id,{answers:[customQuestion(q.id)?draft?.custom.trim()||'请查看附件。':draft.choice]}];}));const attached=Object.fromEntries((request.questions||[]).filter(q=>customQuestion(q.id)&&files[q.id]?.values.length).map(q=>[q.id,files[q.id].values]));void submit({answers},attached);}}>
      <div className="conversation-interaction-body">
        {request.detail&&<pre>{request.detail}</pre>}
        {request.questions?.map((question,index)=>{
          const draft=drafts[question.id]||{choice:'',custom:''};const custom=!question.options?.length||draft.choice==='custom';
          return <fieldset key={question.id} disabled={disabled}><legend><span className="conversation-question-index">{index+1}</span>{question.header&&<span>{question.header} · </span>}{question.question}</legend>
            {question.options?.map((option,i)=><label key={option.label} className="conversation-question-option" data-selected={draft.choice===option.label}><input type="radio" name={`${storageKey}:${question.id}`} checked={draft.choice===option.label} onChange={()=>update(question.id,{...draft,choice:option.label})}/><span><b>{i+1}. {option.label}</b>{option.description&&<small>{option.description}</small>}</span></label>)}
            {!!question.options?.length&&question.isOther&&<label className="conversation-question-option" data-selected={custom}><input type="radio" name={`${storageKey}:${question.id}`} checked={draft.choice==='custom'} onChange={()=>update(question.id,{...draft,choice:'custom'})}/><span>其他回答</span></label>}
            {custom&&(question.isOther||!question.options?.length)&&<div className="conversation-question-custom"><span>{question.isSecret?'私密回答':'你的回答'}</span>{question.isSecret?<input type="password" autoComplete="off" aria-label={question.question} value={draft.custom} onChange={event=>update(question.id,{choice:'custom',custom:event.target.value})}/>:attachmentContext?<ConversationQuestionEditor id={question.id} label={question.question} value={draft.custom} initial={draft.attachments} disabled={disabled} context={attachmentContext} onChange={(text,items)=>update(question.id,{choice:'custom',custom:text,attachments:readyAttachments(items)})} onAttachments={onAttachments} validateFiles={validateFiles} onSubmit={()=>form.current?.requestSubmit()}/>:<textarea rows={2} aria-label={question.question} value={draft.custom} onChange={event=>update(question.id,{choice:'custom',custom:event.target.value})}/>}</div>}
          </fieldset>;
        })}
      </div>
      {error&&<p role="alert" className="session-chat-error">{error}</p>}
      {limitError&&<p role="alert" className="session-chat-error">{limitError}</p>}
      {!!activeFiles.length&&<p className="conversation-question-attachment-hint">{attachmentHint}</p>}
      <div className="conversation-interaction-actions"><button type="button" onClick={onMinimize||onRaw}>{onMinimize?'稍后回答':'原始终端'}</button><span>{!canAnswer?'当前账号只读':!connected?'连接已断开，重连后可处理':submitted?resolvedLabel||'已提交，等待 Agent 继续':sending?'正在提交…':''}</span>
        {request.kind==='question'?<button type="submit" className="conversation-interaction-primary" disabled={disabled||!complete||uploading||failed||!!limitError}>{sending?<Loader2 size={14} className="animate-spin"/>:null}提交回答</button>:<>{request.kind!=='permissions'&&<button type="button" disabled={disabled} onClick={()=>void submit({decision:'cancel'})}>取消</button>}<button type="button" disabled={disabled} onClick={()=>void submit({decision:'decline'})}>拒绝</button><button type="button" className="conversation-interaction-primary" disabled={disabled} onClick={()=>void submit({decision:'accept'})}>允许本次</button></>}
      </div>
    </form>
  </section>;
}


/** Nonblocking Codex questions are messages, not pending JSON-RPC requests.
 * Reply through the normal user-input path, preserving the composer's draft. */
export function ConversationAsyncQuestion({message,agentName,storageKey,connected,canAnswer,onReply,onRaw,onMinimize,attachmentContext}:{
  message:ConversationMessage;agentName:string;storageKey:string;connected:boolean;canAnswer:boolean;
  onReply:(text:string,attachments?:ConversationAttachment[])=>Promise<void>;onRaw:()=>void;onMinimize:()=>void;attachmentContext?:QuestionAttachmentContext;
}) {
  const questions=message.async_questions||[];
  const request:ConversationInteractionRequest={id:message.id,turn_id:message.turn_id||'',kind:'question',title:`${agentName} 向你提问`,detail:'',blocking:false,submitted:false,
    questions:questions.map((q,index)=>({id:`question-${index+1}`,header:'',question:q.title,isOther:true,isSecret:false,options:q.options?.map(label=>({label,description:''}))||null}))};
  return <ConversationInteraction request={request} storageKey={storageKey} connected={connected} canAnswer={canAnswer} inline onRaw={onRaw} onMinimize={onMinimize} attachmentContext={attachmentContext} attachmentHint="图片和文件将随回答一起发送"
    onAnswer={async(_id,value,attached)=>{
      const answers=(value as {answers:Record<string,{answers:string[]}>}).answers;
      const replies=questions.map((q,index)=>{
        if(!q.id||q.id.length>512)throw new Error('请刷新页面以获取此提问的原生标识');
        let question='',bytes=0;for(const char of q.title.replace(/[\r\n]/g,' ')){const length=new TextEncoder().encode(char).length;if(bytes+length>512)break;question+=char;bytes+=length;}
        const files=attached?.[`question-${index+1}`]||[];
        return {question_id:q.id,question,answer:answers[`question-${index+1}`].answers[0]+(files.length?`\n此回答的附件：${files.map(file=>file.name).join('、')}`:'')};
      });
      const files=Object.values(attached||{}).flat();if(files.length)await onReply(encodeQuestionReply(replies),files);else await onReply(encodeQuestionReply(replies));
    }}/>;
}

export const ConversationQuestionSummary=memo(function ConversationQuestionSummary({message,answers,state,onAnswer}:{message:ConversationMessage;answers:string[]|null;state?:'pending'|'sending'|'submitted'|'queued'|'answered';continued?:boolean;onAnswer:(id:string)=>void}) {
  useDisplayClock();
  const questions=message.async_questions||[];
  const status=state??(answers!==null?'answered':'pending'),settled=status!=='pending';
  const labels={pending:'待回答',sending:'正在提交',submitted:'已提交 · 等待接收',queued:'回答已排队',answered:'已回答'};
  return <article className="session-chat-question-summary" data-chat-message-id={message.id}>
    <details key={settled?'answered':'pending'}>
      <summary><MessageCircleQuestion size={14}/><span className="conversation-question-state">{labels[status]}</span><strong>{questions[0]?.title}</strong><span className="conversation-question-expand">查看详情</span></summary>
      <dl>{questions.map((q,index)=><div key={q.id||index}><dt>{q.title}</dt><dd>{q.options?.length?q.options.join(' · '):settled?'文字回答':'自由回答'}</dd></div>)}</dl>
      {status==='queued'&&<p>回答已进入原生队列，等待 Agent 接收；上下文压缩期间需等待压缩结束，无需重复提交。</p>}
      {status==='submitted'&&<p>原生服务已接受提交，正在等待回答进入会话记录，无需重复提交。</p>}
      {!settled&&<button type="button" onClick={()=>onAnswer(message.id)}>回答问题</button>}
    </details>
    {message.timestamp&&<div className="session-chat-message-meta"><time dateTime={message.timestamp}>{formatConversationTimestamp(message.timestamp)}</time></div>}
  </article>;
});
