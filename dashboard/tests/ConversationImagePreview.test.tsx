import {fireEvent,render,screen,within} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {ConversationMessageAttachments} from '../src/components/ConversationAttachments';
import {ConversationImagePreviewRoot} from '../src/components/ConversationImagePreview';
import {ConversationMarkdown} from '../src/components/ConversationMarkdown';
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
  it('previews files without changing tabs, closes on the backdrop and releases the modal when switching sessions',async()=>{
    const open=vi.fn();const view=render(<ConversationImagePreviewRoot active><ConversationMessageAttachments items={[image,{kind:'file',name:'说明.txt',path:'/project/note.txt'}]} projectId="p" onOpenFile={open}/></ConversationImagePreviewRoot>);
    fireEvent.click(screen.getByRole('button',{name:'打开附件 说明.txt'}));expect(open).not.toHaveBeenCalled();expect(await screen.findByTestId('preview-file')).toHaveTextContent('/project/note.txt');expect(screen.getByTestId('preview-file')).toHaveAttribute('data-readonly','true');fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
    fireEvent.click(screen.getByRole('button',{name:'打开附件 截图.png'}));fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'打开附件 截图.png'}));view.rerender(<ConversationImagePreviewRoot active={false}><ConversationMessageAttachments items={[image]} projectId="p"/></ConversationImagePreviewRoot>);expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(document.body.style.overflow).toBe('');
  });
  it('uses the same dialog for Markdown image links and reports loading failures',()=>{
    render(<ConversationMarkdown content="[![示意图](https://example.com/image.png)](https://example.com/full.png)" messageId="m" projectId="p" onNavigate={()=>{}}/>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'预览图片 示意图'}));const dialog=screen.getByRole('dialog');fireEvent.error(within(dialog).getByRole('img'));expect(within(dialog).getByRole('alert')).toHaveTextContent('图片加载失败');
  });
});
