type QuoteRole = 'user' | 'assistant';
export interface ConversationQuote {
  messageId: string;
  role: QuoteRole;
  excerpt: string;
}

const start = '<agentmanager_quote>\n';
const end = '\n</agentmanager_quote>\n\n';
const excerptLimit = 4000;
const idLimit = 2048;

export function isConversationQuote(value: unknown): value is ConversationQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Partial<ConversationQuote>;
  return typeof quote.messageId === 'string' && quote.messageId.length > 0 && quote.messageId.length <= idLimit &&
    (quote.role === 'user' || quote.role === 'assistant') && typeof quote.excerpt === 'string' &&
    quote.excerpt.trim().length > 0 && quote.excerpt.length <= excerptLimit;
}

export function makeConversationQuote(messageId: string, role: QuoteRole, text: string): ConversationQuote | undefined {
  const trimmed = text.trim();
  const truncated = trimmed.slice(0, excerptLimit - 1).replace(/[\uD800-\uDBFF]$/, '');
  const quote = {messageId, role, excerpt: trimmed.length > excerptLimit ? truncated + '…' : trimmed};
  return isConversationQuote(quote) ? quote : undefined;
}

export function quotePrefix(quote: ConversationQuote): string {
  const author = quote.role === 'user' ? '用户' : 'Agent';
  const id = JSON.stringify(quote.messageId);
  const excerpt = quote.excerpt.split('\n').map(line => '> ' + line).join('\n');
  return start + `引用自 ${author} 的原消息 ${id}\n` + excerpt + end;
}

export function parseConversationQuote(text: string): {quote: ConversationQuote; prefixLength: number} | null {
  if (!text.startsWith(start)) return null;
  const stop = text.indexOf(end, start.length);
  if (stop < 0 || stop > (idLimit + excerptLimit) * 6) return null;
  const headerEnd = text.indexOf('\n', start.length);
  if (headerEnd < 0 || headerEnd >= stop) return null;
  const header = /^引用自 (用户|Agent) 的原消息 (.+)$/s.exec(text.slice(start.length, headerEnd));
  if (!header) return null;
  const lines = text.slice(headerEnd + 1, stop).split('\n');
  if (!lines.every(line => line.startsWith('> '))) return null;
  try {
    const quote = {
      messageId: JSON.parse(header[2]),
      role: header[1] === '用户' ? 'user' : 'assistant',
      excerpt: lines.map(line => line.slice(2)).join('\n'),
    };
    return isConversationQuote(quote) ? {quote, prefixLength: stop + end.length} : null;
  } catch {
    return null;
  }
}

export function shiftInputOffsets<T extends {offset?: number}>(items: T[], by: number): T[] {
  if (!by) return items;
  return items.map(item => item.offset === undefined ? item : {...item, offset: Math.max(0, item.offset + by)});
}

export function splitQuotedInput<T extends {offset?: number}>(text: string, attachments: T[]) {
  const quoted = parseConversationQuote(text);
  const prefixLength = quoted?.prefixLength ?? 0;
  return {quote: quoted?.quote, text: text.slice(prefixLength), attachments: shiftInputOffsets(attachments, -prefixLength)};
}
