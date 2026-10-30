import {act,fireEvent,render,screen} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ConversationInteraction,type ConversationInteractionRequest} from '../src/components/ConversationInteraction';
const request:ConversationInteractionRequest={id:'7',turn_id:'turn',kind:'question',title:'Agent 需要你的回答',detail:'',blocking:true,submitted:false,questions:[{id:'scope',header:'部署范围',question:'选择环境',isOther:true,isSecret:false,options:[{label:'试用（推荐）',description:'隔离环境'},{label:'正式',description:'日常服务'}]},{id:'note',header:'备注',question:'补充说明',isOther:false,isSecret:false,options:null}]};
const mount=(card=request,answer=vi.fn().mockResolvedValue(undefined),connected=true,canAnswer=true)=>render(<ConversationInteraction request={card} storageKey="question-test" connected={connected} canAnswer={canAnswer} onAnswer={answer} onRaw={()=>{}}/>);
beforeEach(()=>sessionStorage.clear());
describe('human interaction cards',()=>{
  it('shows real options and descriptions, requires all answers and locks repeated submissions',async()=>{
    let resolve!:()=>void;const answer=vi.fn(()=>new Promise<void>(done=>{resolve=done;}));mount(request,answer);
    const submit=screen.getByRole('button',{name:'提交回答'});expect(submit).toBeDisabled();expect(screen.getByText('隔离环境')).toBeVisible();
    fireEvent.click(screen.getByRole('radio',{name:/试用/}));fireEvent.change(screen.getByRole('textbox',{name:'补充说明'}),{target:{value:'先验证再部署'}});
    expect(submit).toBeEnabled();fireEvent.click(submit);fireEvent.click(submit);expect(answer).toHaveBeenCalledTimes(1);expect(answer).toHaveBeenCalledWith('7',{answers:{scope:{answers:['试用（推荐）']},note:{answers:['先验证再部署']}}});
    await act(async()=>resolve());expect(submit).toBeDisabled();expect(screen.getByText('已提交，等待 Agent 继续')).toBeVisible();expect(sessionStorage.getItem('question-test')).toBeNull();
  });
  it('restores nonsecret drafts after remount and submits a custom answer',async()=>{
    const first=mount();fireEvent.click(screen.getByRole('radio',{name:'其他回答'}));fireEvent.change(screen.getByRole('textbox',{name:'选择环境'}),{target:{value:'本地测试'}});fireEvent.change(screen.getByRole('textbox',{name:'补充说明'}),{target:{value:'保留草稿'}});first.unmount();
    const answer=vi.fn().mockResolvedValue(undefined);mount(request,answer);expect(screen.getByRole('textbox',{name:'选择环境'})).toHaveValue('本地测试');expect(screen.getByRole('textbox',{name:'补充说明'})).toHaveValue('保留草稿');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答'})));expect(answer).toHaveBeenCalledWith('7',{answers:{scope:{answers:['本地测试']},note:{answers:['保留草稿']}}});
  });
  it('does not persist secrets, disables disconnected and readonly controls, and reports failures',async()=>{
    const secret={...request,questions:[{...request.questions![1],isSecret:true}]};const first=mount(secret,vi.fn(),false);const input=screen.getByLabelText('补充说明');expect(input).toBeDisabled();expect(input).toHaveAttribute('type','password');first.unmount();
    const answer=vi.fn().mockRejectedValue(new Error('请求已失效'));const second=mount(secret,answer);fireEvent.change(screen.getByLabelText('补充说明'),{target:{value:'private-key'}});expect(sessionStorage.getItem('question-test')).not.toContain('private-key');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答'})));expect(screen.getByRole('alert')).toHaveTextContent('请求已失效');second.unmount();
    mount(request,vi.fn(),true,false);expect(screen.getByText('当前账号只读')).toBeVisible();for(const radio of screen.getAllByRole('radio'))expect(radio).toBeDisabled();
  });
  it.each(['accept','decline','cancel'])('sends an explicit %s decision without submitting question text',async decision=>{
    const answer=vi.fn().mockResolvedValue(undefined);mount({...request,kind:'command',title:'确认执行命令',detail:'echo test',questions:undefined},answer);
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:decision==='accept'?'允许本次':decision==='decline'?'拒绝':'取消',exact:true})));expect(answer).toHaveBeenCalledWith('7',{decision});
  });
});
