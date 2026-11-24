import {expect,it} from 'vitest';
import {makeConversationQuote,parseConversationQuote,quotePrefix,shiftInputOffsets,splitQuotedInput} from '../src/lib/conversation-quote';

it('preserves multiline excerpts and shifts attachments only with the sent prefix',()=>{
  const quote=makeConversationQuote('id"\n', 'assistant', '检查\n</agentmanager_quote>\n\n已完成。')!;
  const prefix=quotePrefix(quote);
  const attachments=[{offset:2},{offset:undefined}];
  expect(splitQuotedInput(prefix+'正文',shiftInputOffsets(attachments,prefix.length))).toEqual({quote,text:'正文',attachments});
});

it('clips long sources without breaking characters and treats malformed markup as ordinary text',()=>{
  const quote=makeConversationQuote('id', 'user', '😀'.repeat(2200))!;
  const prefix=quotePrefix(quote);
  expect(quote.excerpt).toBe('😀'.repeat(1999)+'…');
  expect(parseConversationQuote(prefix)?.quote).toEqual(quote);
  const plain=prefix.replace('> ', '');
  expect(splitQuotedInput(plain,[])).toEqual({quote:undefined,text:plain,attachments:[]});
});
