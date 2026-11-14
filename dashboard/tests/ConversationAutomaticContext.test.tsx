import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {ConversationAutomaticContext} from '../src/components/ConversationAutomaticContext';
afterEach(cleanup);
it('opens the compaction summary in a centered dialog and restores focus',async()=>{
 const user=userEvent.setup(),copy=vi.fn(),message={id:'summary',role:'assistant' as const,text:'## Summary\n\n- **关键内容**',timestamp:null,presentation:'compaction_summary' as const,compaction:{before_tokens:141965,after_tokens:7212,duration_ms:2300}};
 render(<ConversationAutomaticContext message={message} context={{kind:'compaction_summary',label:'压缩摘要',source:'Codex'}} copied={false} onCopy={copy} projectId={null} onNavigate={()=>{}}/>);
 const trigger=screen.getByRole('button',{name:/Conversation summary/});expect(trigger).toHaveTextContent('141,965 tokens → 7,212 tokens · 2s');expect(screen.queryByRole('dialog')).toBeNull();
 await user.click(trigger);const dialog=screen.getByRole('dialog',{name:'Conversation summary'});expect(within(dialog).getByRole('heading',{name:'Summary'})).toBeVisible();expect(within(dialog).getByText('关键内容').tagName).toBe('STRONG');await user.click(within(dialog).getByRole('button',{name:'Copy conversation summary'}));expect(copy).toHaveBeenCalledOnce();await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();
});
it('opens automatic wrappers as complete Markdown in the dialog',async()=>{
 const user=userEvent.setup(),copy=vi.fn(),message={id:'injection',role:'user' as const,text:'<octoally_shared_resources>\n## 项目说明\n\n**按需读取**\n\n- 保留配置\n</octoally_shared_resources>',timestamp:null};
 render(<ConversationAutomaticContext message={message} context={{kind:'shared_resources',label:'共享资源',source:'.env'}} copied={false} onCopy={copy} projectId={null} onNavigate={()=>{}}/>);
 await user.click(screen.getByRole('button',{name:/自动信息 · 共享资源/}));const dialog=screen.getByRole('dialog',{name:'自动信息 · 共享资源'});expect(within(dialog).getByRole('heading',{name:'项目说明'})).toBeVisible();expect(within(dialog).getByText('按需读取').tagName).toBe('STRONG');expect(within(dialog).getByText('保留配置').tagName).toBe('LI');await user.click(within(dialog).getByRole('button',{name:'复制自动信息 · 共享资源'}));expect(copy).toHaveBeenCalledOnce();
});
it('closes a dialog when its conversation becomes inactive and keeps it closed on return',async()=>{
 const user=userEvent.setup(),message={id:'auto',role:'user' as const,text:'<environment_context>linux</environment_context>',timestamp:null};
 const renderCard=(active:boolean)=><ConversationAutomaticContext active={active} message={message} context={{kind:'environment',label:'运行环境',source:''}} copied={false} onCopy={()=>{}} projectId={null} onNavigate={()=>{}}/>;
 const view=render(renderCard(true));await user.click(screen.getByRole('button',{name:/自动信息 · 运行环境/}));expect(screen.getByRole('dialog')).toBeVisible();
 view.rerender(renderCard(false));expect(screen.queryByRole('dialog')).toBeNull();view.rerender(renderCard(true));expect(screen.queryByRole('dialog')).toBeNull();
});
