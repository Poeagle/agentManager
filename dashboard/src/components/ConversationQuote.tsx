import {X} from 'lucide-react';
import type {ConversationQuote as Quote} from '../lib/conversation-quote';

export function ConversationQuote({quote, agentName, onJump, onRemove}: {
  quote: Quote;
  agentName: string;
  onJump?: (messageId: string) => void;
  onRemove?: () => void;
}) {
  const author = quote.role === 'user' ? '你' : agentName;
  const content = <><strong>{author}</strong><span>{quote.excerpt}</span></>;
  return (
    <div className="session-chat-quote" role={onRemove ? 'group' : undefined} aria-label={onRemove ? '待发送引用' : undefined}>
      {onJump
        ? <button type="button" className="session-chat-quote-text" onClick={() => onJump(quote.messageId)} aria-label={`跳到引用原消息 · ${author} · ${quote.excerpt}`}>{content}</button>
        : <div className="session-chat-quote-text">{content}</div>}
      {onRemove && <button type="button" className="session-chat-quote-remove" aria-label="移除引用" title="移除引用" onClick={onRemove}><X size={14}/></button>}
    </div>
  );
}
