import {useDisplayClock} from '../lib/display-clock';
import {Copy,Check,Info} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {formatConversationTimestamp,formatElapsedEnglish} from '../lib/conversation-timing';
import {ConversationMarkdown} from './ConversationMarkdown';
import {ConversationDialogCard} from './ConversationDialogCard';
import {automaticContextMarkdown} from '../lib/conversation-context';
export function ConversationAutomaticContext({message,context,copied,onCopy,projectPath,projectId,onNavigate,active=true}:{message:ConversationMessage;context:{kind:string;label:string;source:string};copied:boolean;onCopy:()=>void;projectPath?:string;projectId:string|null;onNavigate:()=>void;active?:boolean}) {
  useDisplayClock();
  const isSummary=context.kind==='compaction_summary';
  const heading=isSummary?'Conversation summary':`自动信息 · ${context.label}`;
  const metrics=message.compaction;
  const tokenCount=(value:number)=>new Intl.NumberFormat('zh-CN').format(value);
  return <article className="conversation-auto-context" data-chat-message-id={message.id} data-context-kind={context.kind}>
    <ConversationDialogCard active={active} title={heading} summary={<><Info size={13}/><strong>{heading}</strong>{isSummary&&metrics?.before_tokens!=null&&metrics.after_tokens!=null&&<span>{tokenCount(metrics.before_tokens)} tokens → {tokenCount(metrics.after_tokens)} tokens{metrics.duration_ms!=null?` · ${formatElapsedEnglish(metrics.duration_ms)}`:''}</span>}{context.source&&<span title={context.source}>{context.source}</span>}{message.timestamp&&<time dateTime={message.timestamp}>{formatConversationTimestamp(message.timestamp)}</time>}<span className="conversation-question-expand">查看详情</span></>} actions={<button className="conversation-auto-dialog-copy" type="button" onClick={onCopy} aria-label={isSummary?'Copy conversation summary':`复制${heading}`} title={copied?'Copied':'Copy'}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'Copied':'Copy'}</button>}>
      <div className="conversation-auto-context-body"><div className="conversation-auto-dialog-meta">{context.source&&<span>{context.source}</span>}{message.timestamp&&<time>{formatConversationTimestamp(message.timestamp)}</time>}</div><ConversationMarkdown content={isSummary?message.text:automaticContextMarkdown(message.text)} messageId={`${message.id}-details`} projectPath={projectPath} projectId={projectId} onNavigate={onNavigate}/></div>
    </ConversationDialogCard>
  </article>;
}
