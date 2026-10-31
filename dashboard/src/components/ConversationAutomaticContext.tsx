import {ChevronDown,Copy,Check,Info} from 'lucide-react';
import type {ConversationMessage} from '../lib/api';
import {formatConversationTimestamp} from '../lib/conversation-timing';
export function ConversationAutomaticContext({message,context,copied,onCopy}:{message:ConversationMessage;context:{kind:string;label:string;source:string};copied:boolean;onCopy:()=>void}) {
  return <article className="conversation-auto-context" data-chat-message-id={message.id} data-context-kind={context.kind}>
    <details><summary><Info size={13}/><strong>自动信息 · {context.label}</strong>{context.source&&<span title={context.source}>{context.source}</span>}{message.timestamp&&<time dateTime={message.timestamp}>{formatConversationTimestamp(message.timestamp)}</time>}<ChevronDown size={13} className="conversation-auto-expand"/></summary>
      <div className="conversation-auto-context-body"><button type="button" onClick={onCopy} aria-label="复制自动信息">{copied?<Check size={13}/>:<Copy size={13}/>}复制全文</button><pre>{message.text}</pre></div>
    </details>
  </article>;
}
