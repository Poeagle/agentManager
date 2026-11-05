import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ConversationAsyncQuestion} from '../src/components/ConversationInteraction';
import {api,type ConversationMessage} from '../src/lib/api';
import {decodeQuestionReply} from '../src/lib/conversation-question-reply';
const question:ConversationMessage={id:'ask',role:'assistant',text:'',timestamp:null,async_questions:[{id:'native-question',title:'补充截图或日志',options:null}]};
const context={sessionId:'session',projectId:'project',projectPath:'/project',enabled:true};
function mount(reply=vi.fn().mockResolvedValue(undefined),message=question,enabled=true,canAnswer=true){return render(<ConversationAsyncQuestion message={message} agentName="Agent" storageKey="attachment-question" connected canAnswer={canAnswer} attachmentContext={{...context,enabled}} onReply={reply} onRaw={()=>{}} onMinimize={()=>{}}/>);}
const file=(name='report.txt')=>new File(['log'],name,{type:'text/plain'});
function paste(files:File[],label='补充截图或日志'){fireEvent.paste(screen.getByRole('textbox',{name:label}),{clipboardData:{files,getData:()=>''}});}
beforeEach(()=>{sessionStorage.clear();vi.spyOn(api.sessions,'pasteFile').mockImplementation(async(_id,_data,name)=>({path:'/project/.agentmanager/pastes/'+name}));vi.spyOn(api.sessions,'pasteImage').mockResolvedValue({path:'/project/.agentmanager/pastes/screenshot.png'});});
describe('question reply attachments',()=>{
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
 it.each([false,true])('respects provider capabilities and readonly access (canAnswer %s)',async canAnswer=>{
  mount(vi.fn(),question,!canAnswer,canAnswer);paste([file()]);await act(async()=>{});expect(api.sessions.pasteFile).not.toHaveBeenCalled();expect(api.sessions.pasteImage).not.toHaveBeenCalled();
  if(canAnswer)expect(screen.getByRole('alert')).toHaveTextContent('不支持附件');
 });
});
