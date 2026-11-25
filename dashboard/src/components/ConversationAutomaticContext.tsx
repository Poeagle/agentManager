import {useDisplayClock} from '../lib/display-clock';
import {Copy,Check,Info} from 'lucide-react';
import { useState } from 'react';
import type {ConversationMessage} from '../lib/api';
import {formatConversationTimestamp,formatElapsedEnglish} from '../lib/conversation-timing';
import { copyConversationText } from '../lib/conversation-clipboard';
import {ConversationMarkdown} from './ConversationMarkdown';
import {ConversationDialogCard} from './ConversationDialogCard';
import {automaticContextMarkdown} from '../lib/conversation-context';
type ContextEntry = ConversationMessage & { context: { kind: string; label: string; source: string } };
type ContextLocation = { projectPath?: string; projectId: string | null; onNavigate: () => void };

export function ConversationAutomaticContext({message,context,copied,onCopy,projectPath,projectId,onNavigate,active=true,compact=false}:ContextLocation & {
  message: ConversationMessage;
  context: ContextEntry['context'];
  copied: boolean;
  onCopy: () => void;
  active?: boolean;
  compact?: boolean;
}) {
  useDisplayClock();
  const isSummary=context.kind==='compaction_summary';
  const heading=isSummary?'Conversation summary':`自动信息 · ${context.label}`;
  const metrics=message.compaction;
  const tokenCount=(value:number)=>new Intl.NumberFormat('zh-CN').format(value);
  return <article className="conversation-auto-context" data-chat-message-id={message.id} data-context-kind={context.kind}>
    <ConversationDialogCard active={active} title={heading} dialogClassName="conversation-auto-context-dialog" summary={<><Info size={13}/><strong>{compact ? context.label : heading}</strong>{isSummary&&metrics?.before_tokens!=null&&metrics.after_tokens!=null&&<span>{tokenCount(metrics.before_tokens)} tokens → {tokenCount(metrics.after_tokens)} tokens{metrics.duration_ms!=null?` · ${formatElapsedEnglish(metrics.duration_ms)}`:''}</span>}{context.source&&<span title={context.source}>{context.source}</span>}{!compact&&message.timestamp&&<time dateTime={message.timestamp}>{formatConversationTimestamp(message.timestamp)}</time>}{!compact&&<span className="conversation-question-expand">查看详情</span>}</>} actions={<button className="conversation-auto-dialog-copy" type="button" onClick={onCopy} aria-label={isSummary?'Copy conversation summary':`复制${heading}`} title={copied?'Copied':'Copy'}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'Copied':'Copy'}</button>}>
      <div className="conversation-auto-context-body"><div className="conversation-auto-dialog-meta">{context.source&&<span>{context.source}</span>}{message.timestamp&&<time>{formatConversationTimestamp(message.timestamp)}</time>}</div><ConversationMarkdown content={isSummary?message.text:automaticContextMarkdown(message.text)} messageId={`${message.id}-details`} projectPath={projectPath} projectId={projectId} onNavigate={onNavigate}/></div>
    </ConversationDialogCard>
  </article>;
}

export function ConversationSessionContext({ entries, ...location }: ContextLocation & { entries: ContextEntry[] }) {
  const [copiedId, setCopiedId] = useState<string>();
  return <details className="session-chat-context-panel" onKeyDown={event => {
    if (event.key !== 'Escape' || !event.currentTarget.open
      || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
  }}>
    <summary>会话上下文 · {entries.length}</summary>
    <ul className="session-chat-context-list" aria-label="已注入的上下文">
      {entries.map(entry => <li key={entry.id}>
        <ConversationAutomaticContext {...location}
          message={entry}
          context={entry.context}
          copied={copiedId === entry.id}
          onCopy={() => void copyConversationText(entry.text)
            .then(() => setCopiedId(entry.id))
            .catch(() => setCopiedId(undefined))}
          compact
        />
      </li>)}
    </ul>
  </details>;
}
