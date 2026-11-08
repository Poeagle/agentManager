import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ConversationAutomaticContext} from '../src/components/ConversationAutomaticContext';

vi.mock('../src/components/ConversationMarkdown',()=>({ConversationMarkdown:({content}:{content:string})=><div>{content}</div>}));
afterEach(cleanup);

it('shows compaction token counts and duration alongside the summary heading',()=>{
 const message={id:'summary',role:'assistant' as const,text:'## Summary',timestamp:null,presentation:'compaction_summary' as const,compaction:{before_tokens:141965,after_tokens:7212,duration_ms:2300}};
 render(<ConversationAutomaticContext message={message} context={{kind:'compaction_summary',label:'压缩摘要',source:'Codex'}} copied={false} onCopy={()=>{}} projectId={null} onNavigate={()=>{}}/>);
 const heading=screen.getByText('会话压缩摘要').parentElement!;
 expect(heading).toHaveTextContent('141,965 tokens → 7,212 tokens · 2秒');
 expect(screen.getByText('## Summary')).toBeTruthy();
});
