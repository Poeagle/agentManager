import {sessionAgent} from '../src/lib/agents';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationControls} from '../src/components/ConversationControls';
import {api,type ConversationControlsData} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{agent:{controls:vi.fn(),setControls:vi.fn()},sessions:{compactConversation:vi.fn().mockResolvedValue({ok:true})}}}));
let client:QueryClient,data:ConversationControlsData;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});data={agent:sessionAgent({cli_type:'codex'}),engine_version:'0.166.0',git:{branch:'main',changes:2},state:'active',model:'model-a',effort:'high',provider:'openai',cwd:'/project',cli_version:'0.test',permission:'workspace-write',approval:'never',service_tier:null,usage:{total:{total_tokens:400000},last:{total_tokens:12000,input_tokens:11000,cached_input_tokens:9000,output_tokens:1000},window:40000},limits:[{used_percent:25,minutes:10080,resets_at:1900000000}],models:[{model:'model-a',name:'Model A',description:'默认',efforts:[{value:'high',description:''}],defaultEffort:'high'},{model:'model-b',name:'Model B',description:'另一模型',efforts:[{value:'low',description:''},{value:'medium',description:''}],defaultEffort:'low'}],can_edit:true,loaded:true,pending:null,warning:null,native_id:'native',checked_at:'2026-10-31T02:00:00Z',usage_observed_at:'2026-10-31T01:59:00Z'};vi.mocked(api.agent.controls).mockImplementation(async()=>data);vi.mocked(api.agent.setControls).mockImplementation(async(_id,value)=>({ok:true,pending:null,...value}));});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active/></QueryClientProvider>);
describe('compact conversation controls',()=>{
 it('updates usage immediately without an extra controls request and ignores an older metadata refresh',async()=>{
  mount();await screen.findByText('上下文 30%');const calls=vi.mocked(api.agent.controls).mock.calls.length;
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:2400,input_tokens:2000,cached_input_tokens:1900,output_tokens:400},total:{total_tokens:402400,input_tokens:400000,cached_input_tokens:380000},window:40000}});});
  expect(await screen.findByText('上下文 6%')).toBeVisible();expect(api.agent.controls).toHaveBeenCalledTimes(calls);
  await act(async()=>{await client.invalidateQueries({queryKey:['conversation-controls','s']});});
  expect(screen.getByText('上下文 6%')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'详情'}));expect(within(screen.getByLabelText('本次缓存命中率')).getByText('95.0%')).toBeVisible();
 });
 it('does not mix another native thread usage into this tab',async()=>{
  mount();await screen.findByText('上下文 30%');
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'other',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:1000},total:{},window:40000}});});
  expect(screen.getByText('上下文 30%')).toBeVisible();
 });
 it('refreshes every five minutes, ignores focus refresh and retains a manual refresh action',async()=>{
  vi.useFakeTimers();vi.mocked(api.agent.controls).mockClear();
  try {
   await act(async()=>{mount();await vi.advanceTimersByTimeAsync(0);});expect(api.agent.controls).toHaveBeenCalledTimes(1);
   await act(async()=>{await vi.advanceTimersByTimeAsync(299999);window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});expect(api.agent.controls).toHaveBeenCalledTimes(1);
   await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(api.agent.controls).toHaveBeenCalledTimes(2);
   await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'刷新会话信息'}));await vi.advanceTimersByTimeAsync(0);});expect(api.agent.controls).toHaveBeenCalledTimes(3);
  }finally{vi.useRealTimers();}
 });

 it('shows actual context and weekly remaining values and expands only allowlisted details',async()=>{
  mount();expect(await screen.findByText('上下文 30%')).toBeVisible();expect(screen.getByText('周额度剩余 75%')).toBeVisible();expect(screen.getByText('Codex 0.166.0')).toBeVisible();expect(screen.getByText('累计 400K Token')).toBeVisible();expect(screen.getByText('main')).toBeVisible();expect(screen.getByText('2 项变更')).toBeVisible();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'详情'}));const dialog=screen.getByRole('dialog',{name:'会话详情'});expect(dialog).not.toHaveTextContent('0.test');expect(dialog).not.toHaveTextContent('创建版本');expect(dialog).toHaveTextContent('工作区可写');expect(dialog).toHaveTextContent('40,000');expect(dialog).toHaveTextContent('400,000');fireEvent.click(within(dialog).getByText('查看完整用量明细'));expect(within(dialog).getByText('缓存命中输入')).toBeVisible();fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
 it('applies model and effort immediately and shows the confirmed current settings',async()=>{
  mount();const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:'model-b'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenCalledWith('s',{model:'model-b',effort:'low'}));expect(await screen.findByText('已应用')).toBeVisible();expect(screen.getByRole('combobox',{name:'选择推理强度'})).toHaveValue('low');expect(screen.queryByText('下轮生效')).not.toBeInTheDocument();fireEvent.change(screen.getByRole('combobox',{name:'选择推理强度'}),{target:{value:'medium'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-b',effort:'medium'}));expect(model).toHaveValue('model-b');
 });
 it('does not resubmit a control request that is waiting for native confirmation',async()=>{
  vi.mocked(api.agent.setControls).mockClear();data={...data,pending:{model:'model-b',effort:'low'},pending_status:'submitted'};mount();expect(await screen.findByText('已提交，等待原生模型确认')).toBeVisible();expect(api.agent.setControls).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'应用',exact:true})).not.toBeInTheDocument();
 });
 it('retains the selected model and reports failed saves',async()=>{
  vi.mocked(api.agent.setControls).mockRejectedValueOnce(new Error('连接失败'));mount();const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:'model-b'}});expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');expect(model).toHaveValue('model-a');
 });
 it('compacts once and asks explicitly before replacing the current conversation',async()=>{
  const open=vi.fn().mockResolvedValue(undefined);render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active onNewConversation={open}/></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'压缩',exact:true}));await waitFor(()=>expect(api.sessions.compactConversation).toHaveBeenCalledWith('s'));expect(screen.queryByText('已开始压缩，进度会在当前会话中显示。')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'新开',exact:true}));expect(open).not.toHaveBeenCalled();const dialog=screen.getByRole('dialog',{name:'在当前标签页新开会话'});fireEvent.click(within(dialog).getByRole('button',{name:'停止旧会话并新开'}));await waitFor(()=>expect(open).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 });
 it('does not invent percentages or editable options for missing or read-only telemetry',async()=>{
  data={...data,can_edit:false,loaded:false,models:[],limits:[],usage:null,model:null,effort:null};mount();expect(await screen.findByRole('combobox',{name:'选择模型'})).toBeDisabled();expect(screen.queryByText(/上下文 \d/)).not.toBeInTheDocument();expect(screen.queryByText(/周额度剩余/)).not.toBeInTheDocument();
 });
});
