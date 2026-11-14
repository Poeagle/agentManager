import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {ConversationAutomaticContext} from '../src/components/ConversationAutomaticContext';
afterEach(cleanup);
it('folds a compaction summary and preserves Markdown and copy',async()=>{
 const user=userEvent.setup(),copy=vi.fn(),message={id:'summary',role:'assistant' as const,text:'## Summary\n\n- **关键内容**',timestamp:null,presentation:'compaction_summary' as const,compaction:{before_tokens:141965,after_tokens:7212,duration_ms:2300}};
 const {container}=render(<ConversationAutomaticContext message={message} context={{kind:'compaction_summary',label:'压缩摘要',source:'Codex'}} copied={false} onCopy={copy} projectId={null} onNavigate={()=>{}}/>);
 const card=container.querySelector('details')!,trigger=container.querySelector('summary')!;expect(card.open).toBe(false);expect(trigger).toHaveTextContent('141,965 tokens → 7,212 tokens · 2s');
 await user.click(trigger);expect(card.open).toBe(true);expect(screen.getByRole('heading',{name:'Summary'})).toBeVisible();expect(screen.getByText('关键内容').tagName).toBe('STRONG');await user.click(screen.getByRole('button',{name:'Copy conversation summary'}));expect(copy).toHaveBeenCalledOnce();await user.click(trigger);expect(card.open).toBe(false);
});
it('folds automatic wrappers and renders their complete Markdown',async()=>{
 const user=userEvent.setup(),copy=vi.fn(),message={id:'injection',role:'user' as const,text:'<octoally_shared_resources>\n## 项目说明\n\n**按需读取**\n\n- 保留配置\n</octoally_shared_resources>',timestamp:null};
 const {container}=render(<ConversationAutomaticContext message={message} context={{kind:'shared_resources',label:'共享资源',source:'.env'}} copied={false} onCopy={copy} projectId={null} onNavigate={()=>{}}/>);
 const card=container.querySelector('details')!;expect(card.open).toBe(false);await user.click(container.querySelector('summary')!);expect(screen.getByRole('heading',{name:'项目说明'})).toBeVisible();expect(screen.getByText('按需读取').tagName).toBe('STRONG');expect(screen.getByText('保留配置').tagName).toBe('LI');await user.click(screen.getByRole('button',{name:'复制自动信息 · 共享资源'}));expect(copy).toHaveBeenCalledOnce();
});
