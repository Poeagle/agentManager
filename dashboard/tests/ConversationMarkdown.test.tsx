import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {ConversationMarkdown,conversationLocalPath} from '../src/components/ConversationMarkdown';
import {ConversationMarkdownBlocks} from '../src/lib/conversation-markdown-blocks';

vi.mock('../src/components/FileExplorer',()=>({FileExplorer:({openFileRequest}:{openFileRequest:{path:string}})=><div>{openFileRequest.path}</div>}));
const props={messageId:'message',projectId:'project',projectPath:'/work/project',onNavigate:()=>{}};
describe('conversation Markdown',()=>{
  it.each(['完成。','- 第一项\n- 最后一项','> 引用结论。'])('keeps one metadata footer in the last prose block: %s',content=>{
    const view=render(<ConversationMarkdown {...props} content={content} footer={<time>12:30</time>}/>);
    expect(view.container.querySelectorAll('time')).toHaveLength(1);expect(view.container.querySelector('.conversation-inline-meta time')).toHaveTextContent('12:30');
  });
  it('renders quoted Chinese strong text without interpreting code or escaped markers',()=>{
    const view=render(<ConversationMarkdown {...props} content={'**“重点”**内容\n\n`**“代码”**内容`\n\n\\*\\*“原样”\\*\\*内容'}/>);
    expect(view.container.querySelector('strong')).toHaveTextContent('“重点”');expect(view.container.querySelectorAll('strong')).toHaveLength(1);
    expect(view.container.querySelector('code')).toHaveTextContent('**“代码”**内容');expect(screen.getByText('**“原样”**内容')).toBeVisible();
  });
  it('keeps growing fences mounted, preserves wrapping and highlights settled code',async()=>{
    const view=render(<ConversationMarkdown {...props} streaming content={'## 示例\n\n```ts\nconst value = 1;'}/>);
    const pre=view.container.querySelector('pre');const heading=screen.getByRole('heading',{name:'示例'});const id=heading.id;
    fireEvent.click(screen.getByRole('button',{name:'代码自动换行'}));expect(pre).toHaveClass('conversation-code-wrap');
    const text='## 示例\n\n```ts\nconst value = 1;\nconsole.log(value);\n```\n\n完成。';
    view.rerender(<ConversationMarkdown {...props} streaming content={text}/>);
    expect(view.container.querySelector('pre')).toBe(pre);expect(screen.getByRole('heading',{name:'示例'}).id).toBe(id);
    view.rerender(<ConversationMarkdown {...props} content={text}/>);
    expect(view.container.querySelector('pre')).toBe(pre);expect(pre).toHaveClass('conversation-code-wrap');
    await waitFor(()=>expect(pre?.querySelector('.tok-keyword')).toHaveTextContent('const'));
  });
  it('renders tables, task lists and file links while treating raw HTML as inert',()=>{
    const onOpenFile=vi.fn();const view=render(<ConversationMarkdown {...props} onOpenFile={onOpenFile} content={'## 内容\n\n| 列名 | 数值 |\n| --- | --- |\n| 测试 | 42 |\n\n- [x] 完成\n- [ ] 待处理\n\n[说明](README.md)\n\n<script>window.bad=1</script>'}/>);
    expect(screen.getByRole('region',{name:'横向滚动表格'})).toContainElement(screen.getByRole('table'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);expect(view.container.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('link',{name:'说明'}));expect(onOpenFile).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'文件预览 · README.md'})).toBeVisible();
  });
  it('repairs incomplete tables and resolves document-wide reference links and footnotes',()=>{
    const view=render(<ConversationMarkdown {...props} streaming content={'首段。\n\n| 名称 | 数值 |'}/>);
    view.rerender(<ConversationMarkdown {...props} content={'首段。\n\n| 名称 | 数值 |\n| --- | --- |\n| A | 1 |\n\n[文档][ref]\n\n注释[^a]\n\n[ref]: https://example.com\n[^a]: 完整脚注'}/>);
    expect(screen.getByRole('table')).toHaveTextContent('A');expect(screen.getByRole('link',{name:'文档'})).toHaveAttribute('href','https://example.com');
    expect(screen.getByText('完整脚注')).toBeVisible();
  });
  it('renders newly appended streamed headings after a settled baseline',()=>{
    const text='## 已有内容\n\n原文。';const view=render(<ConversationMarkdown {...props} content={text}/>);
    view.rerender(<ConversationMarkdown {...props} streaming content={text+'\n\n## 新增章节\n\n继续输出'}/>);
    expect(screen.getByRole('heading',{name:'新增章节'})).toBeVisible();expect(screen.getByText('原文。')).toBeVisible();
    view.rerender(<ConversationMarkdown {...props} streaming content={text+'\n\n## 新增章节\n\n继续输出中。'}/>);
    expect(screen.getByText('继续输出中。')).toBeVisible();
  });
  it('only resolves project files and preserves encoded paths and line suffixes',()=>{
    expect(conversationLocalPath('src/My%20File.ts:24','/work/project')).toBe('/work/project/src/My File.ts');
    expect(conversationLocalPath('/work/project/README.md#L3','/work/project')).toBe('/work/project/README.md');
    for(const href of ['../../private.txt','javascript:alert(1)','//external/path','#section','%00bad'])expect(conversationLocalPath(href,'/work/project')).toBeNull();
  });
});
describe('stream block frontier',()=>{
  it('retains frozen blocks and global offsets while only the trailing blocks grow',()=>{
    const parser=new ConversationMarkdownBlocks();const first=parser.update('第一段。\n\n第二段。\n\n第三段。',true);
    const next=parser.update('第一段。\n\n第二段。\n\n第三段。继续。\n\n第四段。',true);
    expect(next[0]).toBe(first[0]);expect(next.map(block=>block.source).join('')).toBe('第一段。\n\n第二段。\n\n第三段。继续。\n\n第四段。');
    expect(new Set(next.map(block=>block.key)).size).toBe(next.length);
    expect(parser.update('重新开始',false).map(block=>block.source).join('')).toBe('重新开始');
  });
});
