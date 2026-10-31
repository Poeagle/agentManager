import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationControls} from '../src/components/ConversationControls';
import {api,type ConversationControlsData} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{agent:{controls:vi.fn(),setControls:vi.fn()}}}));
let client:QueryClient,data:ConversationControlsData;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});data={model:'model-a',effort:'high',provider:'openai',cwd:'/project',cli_version:'0.test',permission:'workspace-write',approval:'never',service_tier:null,usage:{total:{total_tokens:400000},last:{total_tokens:12000,input_tokens:11000,cached_input_tokens:9000,output_tokens:1000},window:40000},limits:[{used_percent:25,minutes:10080,resets_at:1900000000}],models:[{model:'model-a',name:'Model A',description:'默认',efforts:[{value:'high',description:''}],defaultEffort:'high'},{model:'model-b',name:'Model B',description:'另一模型',efforts:[{value:'low',description:''},{value:'medium',description:''}],defaultEffort:'low'}],can_edit:true,loaded:true,pending:null,warning:null,native_id:'native',checked_at:'2026-10-31T02:00:00Z',usage_observed_at:'2026-10-31T01:59:00Z'};vi.mocked(api.agent.controls).mockImplementation(async()=>data);vi.mocked(api.agent.setControls).mockImplementation(async(_id,value)=>({ok:true,pending:value}));});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active/></QueryClientProvider>);
describe('compact conversation controls',()=>{
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
  mount();expect(await screen.findByText('上下文 30%')).toBeVisible();expect(screen.getByText('周额度剩余 75%')).toBeVisible();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'详情'}));const dialog=screen.getByRole('dialog',{name:'会话详情'});expect(dialog).toHaveTextContent('工作区可写');expect(dialog).toHaveTextContent('40,000');expect(dialog).toHaveTextContent('400,000');expect(within(dialog).getByText('缓存命中输入')).toBeVisible();fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
 it('selects supported defaults for a new model, shows pending state, and undoes without changing current information',async()=>{
  mount();const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:'model-b'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenCalledWith('s',{model:'model-b',effort:'low'}));expect(await screen.findByText(/下轮生效/)).toBeVisible();expect(screen.getByRole('combobox',{name:'选择推理强度'})).toHaveValue('low');fireEvent.change(screen.getByRole('combobox',{name:'选择推理强度'}),{target:{value:'medium'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-b',effort:'medium'}));fireEvent.click(screen.getByRole('button',{name:'撤销'}));await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',null));expect(model).toHaveValue('model-a');
 });
 it('retains the selected model and reports failed saves',async()=>{
  vi.mocked(api.agent.setControls).mockRejectedValueOnce(new Error('连接失败'));mount();const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:'model-b'}});expect(await screen.findByRole('alert')).toHaveTextContent('连接失败');expect(model).toHaveValue('model-a');
 });
 it('does not invent percentages or editable options for missing or read-only telemetry',async()=>{
  data={...data,can_edit:false,loaded:false,models:[],limits:[],usage:null,model:null,effort:null};mount();expect(await screen.findByRole('combobox',{name:'选择模型'})).toBeDisabled();expect(screen.queryByText(/上下文 \d/)).not.toBeInTheDocument();expect(screen.queryByText(/周额度剩余/)).not.toBeInTheDocument();
 });
});
