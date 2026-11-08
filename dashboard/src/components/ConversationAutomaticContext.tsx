import {useDisplayClock} from '../lib/display-clock';
import {ChevronDown,Copy,Check,Info} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import {formatElapsed} from '../lib/conversation-timing';
import {ConversationMarkdown} from './ConversationMarkdown';
export function ConversationAutomaticContext({message,context,copied,onCopy,projectPath,projectId,onNavigate}:{message:ConversationMessage;context:{kind:string;label:string;source:string};copied:boolean;onCopy:()=>void;projectPath?:string;projectId:string|null;onNavigate:()=>void}) {
  useDisplayClock();
  const isSummary=context.kind==='compaction_summary';
  const heading=isSummary?'会话压缩摘要':`自动信息 · ${context.label}`;
  const metrics=message.compaction;
  const tokenCount=(value:number)=>new Intl.NumberFormat('zh-CN').format(value);
  return <article className="conversation-auto-context" data-chat-message-id={message.id} data-context-kind={context.kind}>
    <details><summary><Info size={13}/><strong>{heading}</strong>{isSummary&&metrics?.before_tokens!==null&&metrics?.before_tokens!==undefined&&metrics.after_tokens!==null&&metrics.after_tokens!==undefined&&<span className="conversation-auto-compaction-metrics">{tokenCount(metrics.before_tokens)} tokens → {tokenCount(metrics.after_tokens)} tokens{metrics.duration_ms!==null&&metrics.duration_ms!==undefined?` · ${formatElapsed(metrics.duration_ms)}`:''}</span>}{context.source&&<span title={context.source}>{context.source}</span>}{message.timestamp&&<time dateTime={message.timestamp}>{formatConversationTimestamp(message.timestamp)}</time>}<ChevronDown size={13} className="conversation-auto-expand"/></summary>
      <button className="conversation-auto-copy" type="button" onClick={onCopy} aria-label={`复制${heading}`} title={copied?'已复制':'复制全文'}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>
      <div className={`conversation-auto-context-body${isSummary?' conversation-auto-summary-body':''}`}>{isSummary?<ConversationMarkdown content={message.text} messageId={message.id} projectPath={projectPath} projectId={projectId} onNavigate={onNavigate}/>:<pre>{message.text}</pre>}</div>
    </details>
  </article>;
}
