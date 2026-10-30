import {useRef,useState} from 'react';
import {Check,Loader2,MessageCircleQuestion,ShieldCheck} from 'lucide-react';

export interface ConversationInteractionRequest {
  id:string;turn_id:string;kind:'question'|'command'|'file'|'permissions';title:string;detail:string;blocking:boolean;submitted:boolean;
  questions?:Array<{id:string;header:string;question:string;isOther:boolean;isSecret:boolean;options:Array<{label:string;description:string}>|null}>;
}
interface Draft {choice:string;custom:string}
export function ConversationInteraction({request,storageKey,connected,canAnswer,onAnswer,onRaw}:{
  request:ConversationInteractionRequest;storageKey:string;connected:boolean;canAnswer:boolean;
  onAnswer:(id:string,answer:unknown)=>Promise<void>;onRaw:()=>void;
}) {
  const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>{
    try {const value=JSON.parse(sessionStorage.getItem(storageKey)||'{}');return Object.fromEntries((request.questions||[]).filter(q=>!q.isSecret).flatMap(q=>typeof value[q.id]?.choice==='string'&&typeof value[q.id]?.custom==='string'?[[q.id,value[q.id]]]:[]));}catch{return {};}
  });
  const [sending,setSending]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  const submitted=request.submitted||sent;
  const disabled=!connected||!canAnswer||sending||submitted;
  function update(id:string,value:Draft) {
    setDrafts(previous=>{
      const next={...previous,[id]:value};
      try {sessionStorage.setItem(storageKey,JSON.stringify(Object.fromEntries((request.questions||[]).filter(q=>!q.isSecret&&next[q.id]).map(q=>[q.id,next[q.id]]))));}catch{/* The in-memory draft remains usable. */}
      return next;
    });setError('');
  }
  async function submit(answer:unknown) {
    if(disabled||lock.current)return;lock.current=true;setSending(true);setError('');
    try {await onAnswer(request.id,answer);setSent(true);try{sessionStorage.removeItem(storageKey);}catch{/* Optional storage. */}}
    catch(failure){setError(failure instanceof Error?failure.message:'提交失败，请检查连接');}
    finally{lock.current=false;setSending(false);}
  }
  const complete=(request.questions||[]).every(q=>{const draft=drafts[q.id];return draft?.choice==='custom'?!!draft.custom.trim():!!draft?.choice;});
  return <section className="conversation-interaction" aria-label={request.title}>
    <header>{request.kind==='question'?<MessageCircleQuestion size={16}/>:<ShieldCheck size={16}/>}<strong>{request.title}</strong>{!request.blocking&&<span>可稍后回答</span>}{submitted&&<span><Check size={13}/>已提交</span>}</header>
    <form onSubmit={event=>{event.preventDefault();if(!complete)return;const answers=Object.fromEntries((request.questions||[]).map(q=>{const draft=drafts[q.id];return [q.id,{answers:[draft.choice==='custom'?draft.custom.trim():draft.choice]}];}));void submit({answers});}}>
      <div className="conversation-interaction-body">
        {request.detail&&<pre>{request.detail}</pre>}
        {request.questions?.map((question,index)=>{
          const draft=drafts[question.id]||{choice:'',custom:''};const custom=!question.options?.length||draft.choice==='custom';
          return <fieldset key={question.id} disabled={disabled}><legend><span className="conversation-question-index">{index+1}</span>{question.header&&<span>{question.header} · </span>}{question.question}</legend>
            {question.options?.map((option,i)=><label key={option.label} className="conversation-question-option" data-selected={draft.choice===option.label}><input type="radio" name={`${storageKey}:${question.id}`} checked={draft.choice===option.label} onChange={()=>update(question.id,{...draft,choice:option.label})}/><span><b>{i+1}. {option.label}</b>{option.description&&<small>{option.description}</small>}</span></label>)}
            {!!question.options?.length&&question.isOther&&<label className="conversation-question-option" data-selected={custom}><input type="radio" name={`${storageKey}:${question.id}`} checked={draft.choice==='custom'} onChange={()=>update(question.id,{...draft,choice:'custom'})}/><span>其他回答</span></label>}
            {custom&&(question.isOther||!question.options?.length)&&<label className="conversation-question-custom"><span>{question.isSecret?'私密回答':'你的回答'}</span>{question.isSecret?<input type="password" autoComplete="off" aria-label={question.question} value={draft.custom} onChange={event=>update(question.id,{choice:'custom',custom:event.target.value})}/>:<textarea rows={2} aria-label={question.question} value={draft.custom} onChange={event=>update(question.id,{choice:'custom',custom:event.target.value})}/>}</label>}
          </fieldset>;
        })}
      </div>
      {error&&<p role="alert" className="session-chat-error">{error}</p>}
      <div className="conversation-interaction-actions"><button type="button" onClick={onRaw}>原始终端</button><span>{!canAnswer?'当前账号只读':!connected?'连接已断开，重连后可处理':submitted?'已提交，等待 Agent 继续':sending?'正在提交…':''}</span>
        {request.kind==='question'?<button type="submit" className="conversation-interaction-primary" disabled={disabled||!complete}>{sending?<Loader2 size={14} className="animate-spin"/>:null}提交回答</button>:<>{request.kind!=='permissions'&&<button type="button" disabled={disabled} onClick={()=>void submit({decision:'cancel'})}>取消</button>}<button type="button" disabled={disabled} onClick={()=>void submit({decision:'decline'})}>拒绝</button><button type="button" className="conversation-interaction-primary" disabled={disabled} onClick={()=>void submit({decision:'accept'})}>允许本次</button></>}
      </div>
    </form>
  </section>;
}
