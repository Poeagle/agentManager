import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ConversationAsyncQuestion} from '../src/components/ConversationInteraction';
import {api,type ConversationMessage} from '../src/lib/api';
import {decodeQuestionReply} from '../src/lib/conversation-question-reply';
import {packDirectory} from '../src/lib/directory-upload';
vi.mock('../src/lib/directory-upload',async()=>({...await vi.importActual('../src/lib/directory-upload'),packDirectory:vi.fn()}));
const question:ConversationMessage={id:'ask',role:'assistant',text:'',timestamp:null,async_questions:[{id:'native-question',title:'补充截图或日志',options:null}]};
const context={sessionId:'session',projectId:'project',projectPath:'/project',enabled:true};
function mount(reply=vi.fn().mockResolvedValue(undefined),message=question,enabled=true,canAnswer=true){return render(<ConversationAsyncQuestion message={message} agentName="Agent" storageKey="attachment-question" connected canAnswer={canAnswer} attachmentContext={{...context,enabled}} onReply={reply} onRaw={()=>{}} onMinimize={()=>{}}/>);}
const file=(name='report.txt')=>new File(['log'],name,{type:'text/plain'});
function paste(files:File[],label='补充截图或日志'){fireEvent.paste(screen.getByRole('textbox',{name:label}),{clipboardData:{files,getData:()=>''}});}
beforeEach(()=>{sessionStorage.clear();vi.spyOn(api.sessions,'pasteFile').mockImplementation(async(_id,_data,name)=>({path:'/project/.agentmanager/pastes/'+name}));vi.spyOn(api.sessions,'pasteImage').mockResolvedValue({path:'/project/.agentmanager/pastes/screenshot.png'});});
describe('question reply attachments',()=>{
 it('does not rewrite the saved draft for directory progress-only updates',async()=>{
  let progress!:(percent:number)=>void,finish!:(file:File)=>void;
  vi.mocked(packDirectory).mockImplementation(async(_name,_entries,_signal,changed)=>{progress=changed;return new Promise<File>(resolve=>{finish=resolve;});});
  mount();const save=vi.spyOn(Storage.prototype,'setItem'),source=file();Object.defineProperty(source,'webkitRelativePath',{value:'data/report.txt'});
  fireEvent.change(screen.getByLabelText('选择回答目录'),{target:{files:[source]}});await waitFor(()=>expect(packDirectory).toHaveBeenCalledOnce());
  const before=save.mock.calls.filter(([key])=>key==='attachment-question').length;
  try {
   for(let i=1;i<=30;i++)act(()=>progress(i));
   expect(save.mock.calls.filter(([key])=>key==='attachment-question')).toHaveLength(before);
  }finally{await act(async()=>finish(new File(['zip'],'data.zip',{type:'application/zip'})));}
  await waitFor(()=>expect(screen.getByRole('button',{name:'预览待发送文件 data.zip'})).toHaveAttribute('data-status','ready'));
  expect(save.mock.calls.filter(([key])=>key==='attachment-question')).toHaveLength(before+1);expect(sessionStorage.getItem('attachment-question')).toContain('data.zip');
 });
 it('shares upload work across answer fields and canceling an active upload releases the next field',async()=>{
  vi.mocked(api.sessions.pasteFile).mockImplementation(async(_id,_data,name,signal)=>{
   if(name==='first.txt')await new Promise<void>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('canceled','AbortError')),{once:true}));
   return {path:'/project/.agentmanager/pastes/'+name};
  });
  mount(vi.fn(),{...question,async_questions:[{id:'one',title:'问题一',options:null},{id:'two',title:'问题二',options:null}]});
  paste([file('first.txt')],'问题一');paste([file('second.txt')],'问题二');await waitFor(()=>expect(api.sessions.pasteFile).toHaveBeenCalledOnce());
  expect(screen.getByRole('button',{name:'预览待发送文件 second.txt'})).toHaveTextContent('排队中');fireEvent.click(screen.getByRole('button',{name:'移除附件 first.txt'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'预览待发送文件 second.txt'})).toHaveAttribute('data-status','ready'));expect(api.sessions.pasteFile).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:'移除附件 first.txt'})).not.toBeInTheDocument();
 });
 it('restores the attachment position inside a text answer after reopening the question',async()=>{
  const view=mount();const editor=screen.getByRole('textbox',{name:'补充截图或日志'});editor.textContent='前文后文';fireEvent.input(editor);
  const range=document.createRange();range.setStart(editor.firstChild!,2);range.collapse(true);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);fireEvent.mouseUp(editor);paste([file()]);
  await waitFor(()=>expect(screen.getByRole('button',{name:'预览待发送文件 report.txt'})).toHaveAttribute('data-status','ready'));
  expect(editor.textContent?.replaceAll('\u200b','')).toBe('前文文件 1后文');view.unmount();mount();const restored=screen.getByRole('textbox',{name:'补充截图或日志'});
  expect(restored.textContent?.replaceAll('\u200b','')).toBe('前文文件 1后文');expect(api.sessions.pasteFile).toHaveBeenCalledOnce();
 });
 it('pastes images and files, waits for uploads and submits them in the same answer',async()=>{
  let finish!:(value:{path:string})=>void;vi.mocked(api.sessions.pasteImage).mockReturnValue(new Promise(resolve=>{finish=resolve;}));const reply=vi.fn().mockResolvedValue(undefined);mount(reply);
  paste([new File(['png'],'screenshot.png',{type:'image/png'}),file()]);
  const submit=screen.getByRole('button',{name:'提交回答'});await waitFor(()=>expect(api.sessions.pasteImage).toHaveBeenCalledOnce());expect(submit).toBeDisabled();
  await act(async()=>finish({path:'/project/.agentmanager/pastes/screenshot.png'}));await waitFor(()=>expect(submit).toBeEnabled());
  await act(async()=>fireEvent.click(submit));expect(reply).toHaveBeenCalledOnce();
  expect(decodeQuestionReply(reply.mock.calls[0][0])?.answers[0]).toMatchObject({question_id:'native-question',answer:expect.stringContaining('screenshot.png、report.txt')});
  expect(reply.mock.calls[0][1]).toEqual([{kind:'image',name:'screenshot.png',path:'/project/.agentmanager/pastes/screenshot.png'},{kind:'file',name:'report.txt',path:'/project/.agentmanager/pastes/report.txt'}]);
 });
 it('retries failed uploads and restores a rejected answer after remount without uploading again',async()=>{
  vi.mocked(api.sessions.pasteFile).mockRejectedValueOnce(new Error('网络中断'));const reply=vi.fn().mockRejectedValueOnce(new Error('回答未受理')).mockResolvedValue(undefined);const view=mount(reply);paste([file()]);
  await screen.findByRole('button',{name:'重试上传 report.txt'});expect(screen.getByRole('button',{name:'提交回答'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'重试上传 report.txt'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'提交回答'})).toBeEnabled());expect(document.querySelectorAll('[data-attachment-id]')).toHaveLength(1);
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答'})));expect(await screen.findByRole('alert')).toHaveTextContent('回答未受理');view.unmount();mount(reply);
  await waitFor(()=>expect(screen.getByRole('button',{name:'提交回答'})).toBeEnabled());await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答'})));
  expect(api.sessions.pasteFile).toHaveBeenCalledTimes(2);expect(reply).toHaveBeenCalledTimes(2);expect(reply.mock.calls[1]).toEqual(reply.mock.calls[0]);
 });
 it('enforces one attachment budget across multiple question fields',async()=>{
  mount(vi.fn(),{...question,async_questions:[{id:'one',title:'问题一',options:null},{id:'two',title:'问题二',options:null}]});
  paste(Array.from({length:5},(_,i)=>file(`one-${i}.txt`)),'问题一');paste(Array.from({length:4},(_,i)=>file(`two-${i}.txt`)),'问题二');
  expect(await screen.findByText('本次回答合计最多支持 8 个附件')).toBeVisible();expect(screen.getByRole('button',{name:'提交回答'})).toBeDisabled();
 });
 it('accepts 100 MB in an answer and enforces the total across question fields',async()=>{
  mount(vi.fn(),{...question,async_questions:[{id:'one',title:'问题一',options:null},{id:'two',title:'问题二',options:null}]});
  const second=screen.getByRole('textbox',{name:'问题二'});second.textContent='补充说明';fireEvent.input(second);
  const large=file('large.zip');Object.defineProperty(large,'size',{value:100*1024*1024});paste([large],'问题一');
  await waitFor(()=>expect(screen.getByRole('button',{name:'提交回答'})).toBeEnabled());
  paste([file('extra.txt')],'问题二');
  expect(await screen.findByText('本次回答的附件合计最多 100 MB')).toBeVisible();expect(screen.getByRole('button',{name:'提交回答'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'预览待发送文件 extra.txt'})).not.toBeInTheDocument();
  expect(api.sessions.pasteFile).toHaveBeenCalledOnce();
 });
 it.each([false,true])('respects provider capabilities and readonly access (canAnswer %s)',async canAnswer=>{
  mount(vi.fn(),question,!canAnswer,canAnswer);paste([file()]);await act(async()=>{});expect(api.sessions.pasteFile).not.toHaveBeenCalled();expect(api.sessions.pasteImage).not.toHaveBeenCalled();
  if(canAnswer)expect(screen.getByRole('alert')).toHaveTextContent('不支持附件');
 });
});
