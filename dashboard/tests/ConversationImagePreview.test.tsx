vi.mock('../src/lib/api',async()=>{const actual=await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');return {...actual,fetchJSON:vi.fn(async(url:string)=>({path:new URL(url,'http://test').searchParams.get('path'),type:'file'}))};});
import {fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {ConversationMessageAttachments} from '../src/components/ConversationAttachments';
import {ConversationImagePreviewRoot} from '../src/components/ConversationImagePreview';
import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
import {api} from '../src/lib/api';
vi.mock('../src/components/FileExplorer',()=>({FileExplorer:({openFileRequest,readOnly}:{openFileRequest:{path:string};readOnly:boolean})=><div data-testid="preview-file" data-readonly={readOnly}>{openFileRequest.path}</div>}));
const image={kind:'image' as const,name:'截图.png',path:'/project/.agentmanager/pastes/test.png'};
describe('conversation image preview',()=>{
  it('opens an attachment in a centered dialog, zooms and restores focus without opening a file',()=>{
    const open=vi.fn();render(<ConversationMessageAttachments items={[image]} projectId="p" onOpenFile={open}/>);
    const button=screen.getByRole('button',{name:'打开附件 截图.png'});button.focus();fireEvent.click(button);
    const dialog=screen.getByRole('dialog',{name:'图片预览 · 截图.png'});expect(open).not.toHaveBeenCalled();expect(document.body.style.overflow).toBe('hidden');
    const full=within(dialog).getByRole('img',{name:'截图.png'});Object.defineProperties(full,{naturalWidth:{value:1600},naturalHeight:{value:900}});fireEvent.load(full);
    const initial=within(dialog).getByLabelText('图片缩放比例').textContent;fireEvent.click(within(dialog).getByRole('button',{name:'放大图片'}));expect(within(dialog).getByLabelText('图片缩放比例').textContent).not.toBe(initial);
    fireEvent.click(within(dialog).getByRole('button',{name:'适应窗口'}));expect(within(dialog).getByLabelText('图片缩放比例')).toHaveTextContent(initial!);
    fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(button).toHaveFocus();expect(document.body.style.overflow).toBe('');
  });
  it('keeps a small image in a roomy dialog before and after it loads',()=>{
    render(<ConversationMessageAttachments items={[image]} projectId="p"/>);fireEvent.click(screen.getByRole('button',{name:'打开附件 截图.png'}));
    const dialog=screen.getByRole('dialog');expect(within(dialog).getByRole('group',{name:'图片缩放'}).closest('header')).toBe(within(dialog).getByRole('heading').closest('header'));expect(within(dialog).getByLabelText('图片预览区域')).toHaveStyle({height:'240px'});
    const full=within(dialog).getByRole('img');Object.defineProperties(full,{naturalWidth:{value:312},naturalHeight:{value:171}});fireEvent.load(full);
    expect(within(dialog).getByLabelText('图片预览区域')).toHaveStyle({height:'240px'});
    expect(full).toHaveStyle({width:'312px',height:'171px'});
  });
  it('previews files without changing tabs, closes on the backdrop and releases the modal when switching sessions',async()=>{
    const open=vi.fn();const view=render(<ConversationImagePreviewRoot active><ConversationMessageAttachments items={[image,{kind:'file',name:'说明.txt',path:'/project/note.txt'}]} projectId="p" onOpenFile={open}/></ConversationImagePreviewRoot>);
    fireEvent.click(screen.getByRole('button',{name:'打开附件 说明.txt'}));expect(open).not.toHaveBeenCalled();expect(await screen.findByTestId('preview-file')).toHaveTextContent('/project/note.txt');expect(screen.getByTestId('preview-file')).toHaveAttribute('data-readonly','true');fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
    fireEvent.click(screen.getByRole('button',{name:'打开附件 截图.png'}));fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'打开附件 截图.png'}));view.rerender(<ConversationImagePreviewRoot active={false}><ConversationMessageAttachments items={[image]} projectId="p"/></ConversationImagePreviewRoot>);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(document.body.style.overflow).toBe('');
  });
  it('docks a file without remounting the reader or trapping conversation focus, and switches back',async()=>{
    const size=vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(1000);
    try {
      render(<ConversationImagePreviewRoot><textarea aria-label="对话草稿" defaultValue="保留反馈"/><ConversationMessageAttachments items={[{kind:'file',name:'说明.txt',path:'/project/note.txt'}]} projectId="p"/></ConversationImagePreviewRoot>);
      fireEvent.click(screen.getByRole('button',{name:'打开附件 说明.txt'}));const reader=await screen.findByTestId('preview-file');
      fireEvent.click(screen.getByRole('button',{name:'显示到侧边'}));const side=screen.getByRole('complementary',{name:'文件预览 · 说明.txt'});
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByTestId('preview-file')).toBe(reader);expect(document.body.style.overflow).toBe('');
      const draft=screen.getByRole('textbox',{name:'对话草稿'});draft.focus();fireEvent.change(draft,{target:{value:'继续反馈'}});expect(draft).toHaveFocus();expect(draft).toHaveValue('继续反馈');expect(fireEvent.keyDown(side,{key:'Tab'})).toBe(true);
      fireEvent.click(within(side).getByRole('button',{name:'居中显示'}));expect(screen.getByRole('dialog')).toBeInTheDocument();expect(screen.getByTestId('preview-file')).toBe(reader);expect(document.body.style.overflow).toBe('hidden');
    }finally{size.mockRestore();}
  });
  it('checks external Markdown images with the user-scoped preview API',async()=>{
    const preview=vi.spyOn(api.files,'preview').mockRejectedValue(new Error('Forbidden'));
    try{render(<ConversationMarkdown content="![外部截图](/tmp/example.png)" messageId="m" projectPath="/project" projectId="p" onNavigate={()=>{}}/>);
      await waitFor(()=>expect(preview).toHaveBeenCalledWith('/tmp/example.png',expect.any(AbortSignal),undefined));expect(await screen.findByText('图片加载失败：外部截图')).toBeVisible();
    }finally{preview.mockRestore();}
  });
  it('previews local image links and paths together while retaining the original links',async()=>{
    const preview=vi.spyOn(api.files,'preview').mockResolvedValue(new Blob(['image']));
    const create=vi.fn().mockReturnValue('blob:test-image'),revoke=vi.fn();
    vi.stubGlobal('URL',class extends URL {static createObjectURL=create;static revokeObjectURL=revoke;});
    try{
      const first='结果：[弹窗](/tmp/dialog.png) · /project/report.jpg';
      const view=render(<ConversationMarkdown content={first} streaming messageId="m" projectPath="/project" projectId="p" onNavigate={()=>{}}/>);
      await waitFor(()=>expect(preview).toHaveBeenCalledTimes(2));
      expect(preview).toHaveBeenCalledWith('/tmp/dialog.png',expect.any(AbortSignal),undefined);
      expect(preview).toHaveBeenCalledWith('/project/report.jpg',expect.any(AbortSignal),'p');
      expect(screen.getByRole('link',{name:/弹窗/})).toBeVisible();
      const row=view.container.querySelector('.conversation-linked-images')!;
      expect(within(row).getAllByRole('button')).toHaveLength(2);
      view.rerender(<ConversationMarkdown content={first+' · [重复](/tmp/dialog.png) · [文本](/tmp/readme.txt)'} messageId="m" projectPath="/project" projectId="p" onNavigate={()=>{}}/>);
      expect(within(row).getAllByRole('button')).toHaveLength(2);expect(preview).toHaveBeenCalledTimes(2);
      fireEvent.click(await screen.findByRole('button',{name:'预览图片 dialog.png'}));expect(screen.getByRole('dialog',{name:'图片预览 · dialog.png'})).toBeVisible();
      view.unmount();expect(revoke).toHaveBeenCalledTimes(2);
    }finally{preview.mockRestore();vi.unstubAllGlobals();}
  });
  it('does not create local previews for remote links, code blocks or existing Markdown images',()=>{
    const preview=vi.spyOn(api.files,'preview').mockRejectedValue(new Error('Forbidden'));
    try{
      render(<ConversationMarkdown content={'[远程](https://example.com/a.png)\n\n```\n/tmp/code.png\n```\n\n![图片](https://example.com/b.png)'} messageId="m" projectPath="/project" projectId="p" onNavigate={()=>{}}/>);
      expect(preview).not.toHaveBeenCalled();expect(screen.getAllByRole('button',{name:/预览图片/})).toHaveLength(1);
    }finally{preview.mockRestore();}
  });
  it('keeps the link usable when an inline image path is denied',async()=>{
    const preview=vi.spyOn(api.files,'preview').mockRejectedValue(new Error('Forbidden'));
    try{
      render(<ConversationMarkdown content={'截图：`/tmp/private.png`'} messageId="m" projectPath="/project" projectId="p" onNavigate={()=>{}}/>);
      expect(await screen.findByText('图片加载失败：private.png')).toBeVisible();
      expect(screen.getByRole('link',{name:'/tmp/private.png'})).toBeVisible();
    }finally{preview.mockRestore();}
  });
  it('uses the same dialog for Markdown image links and reports loading failures',()=>{
    render(<ConversationMarkdown content="[![示意图](https://example.com/image.png)](https://example.com/full.png)" messageId="m" projectId="p" onNavigate={()=>{}}/>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'预览图片 示意图'}));const dialog=screen.getByRole('dialog');fireEvent.error(within(dialog).getByRole('img'));expect(within(dialog).getByRole('alert')).toHaveTextContent('图片加载失败');
  });
});
