import {sessionAgent} from '../src/lib/agents';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationControls} from '../src/components/ConversationControls';
import {api,type ConversationControlsData} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{codexEnvironments:{forSession:vi.fn(async()=>({current:'provider:provider-a',environments:[{id:'provider:provider-a',kind:'provider',provider:'provider-a',name:'A',auth_mode:'account',can_control:true},{id:'provider:provider-b',kind:'provider',provider:'provider-b',name:'B',can_control:true}]})),sessionPreflight:vi.fn(async()=>({ok:true,checks:[{stage:'models',ok:true,message:'available'}],models:[{model:'model-b',name:'B',provider:'provider-b',efforts:[{value:'low'}],defaultEffort:'low'}]})),transfer:vi.fn(async()=>({ok:true}))},agent:{controls:vi.fn(),setControls:vi.fn(),contextBreakdown:vi.fn()},sessions:{compactConversation:vi.fn().mockResolvedValue({ok:true})}}}));
let client:QueryClient,data:ConversationControlsData;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});data={agent:sessionAgent({cli_type:'codex'}),engine_version:'0.166.0',git:{branch:'main',changes:2},state:'active',model:'model-a',effort:'high',provider:'openai',cwd:'/project',cli_version:'0.test',permission:'workspace-write',approval:'never',service_tier:null,usage:{total:{total_tokens:400000},last:{total_tokens:12000,input_tokens:11000,cached_input_tokens:9000,output_tokens:1000},window:40000},limits:[{used_percent:25,minutes:10080,resets_at:1900000000}],models:[{model:'model-a',name:'Model A',description:'默认',efforts:[{value:'high',description:''}],defaultEffort:'high'},{model:'model-b',name:'Model B',description:'另一模型',efforts:[{value:'low',description:''},{value:'medium',description:''}],defaultEffort:'low'}],can_edit:true,loaded:true,pending:null,warning:null,native_id:'native',checked_at:'2026-10-31T02:00:00Z',usage_observed_at:'2026-10-31T01:59:00Z'};vi.mocked(api.agent.controls).mockImplementation(async()=>data);vi.mocked(api.agent.setControls).mockImplementation(async(_id,value)=>({ok:true,pending:null,...value}));});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active/></QueryClientProvider>);
describe('compact conversation controls',()=>{
 it('does not present subscription reference credits as API pricing',async()=>{
  data.models[0]={...data.models[0],reference_credits:{input:25,cached:1.25,output:125,as_of:'2026-11-11'}};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'provider:a',environments:[{id:'provider:a',name:'API',kind:'provider',auth_mode:'api',enabled:true,allowed_user_ids:null}]} as any);
  mount();const select=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(api.codexEnvironments.forSession).toHaveBeenCalled());fireEvent.focus(select);
  const tooltip=screen.getByRole('tooltip');expect(tooltip).not.toHaveTextContent('Credits / 1M');expect(tooltip).toHaveTextContent('计费标准未提供');expect(screen.queryByText(/Weekly remaining/)).not.toBeInTheDocument();
 });
 it('shows selected account model details on focus and distinguishes reference credits',async()=>{
  data.models[0]={...data.models[0],context_window:128000,input_modalities:['text','image'],release_date:'2026-01-01',reference_credits:{input:25,cached:1.25,output:125,as_of:'2026-11-11'}};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'native',environments:[{id:'native',name:'Account',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]} as any);
  mount();const select=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(api.codexEnvironments.forSession).toHaveBeenCalled());
  fireEvent.focus(select);const tooltip=screen.getByRole('tooltip');
  expect(tooltip).toHaveTextContent('2026-01-01');expect(tooltip).toHaveTextContent('128,000 tokens');expect(tooltip).toHaveTextContent('text、image');expect(tooltip).toHaveTextContent('Credits / 1M');expect(tooltip).toHaveTextContent('非实际账单');
  fireEvent.blur(select);expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
 });

 it('removes the provider prefix only for API engines while retaining account labels',async()=>{
  data={...data,provider:'provider-a',models:[{...data.models[0],provider:'provider-a',name:'DeepSeek V4.1 Flash'},{...data.models[1],provider:'provider-b'}]};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'provider:provider-a',environments:[{id:'provider:provider-a',name:'API',kind:'provider',provider:'provider-a',auth_mode:'api',enabled:true,allowed_user_ids:null,can_control:true},{id:'provider:provider-b',name:'Account',kind:'provider',provider:'provider-b',auth_mode:'account',enabled:true,allowed_user_ids:null,can_control:true}]});
  mount();const model=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(within(model).getByRole('option',{name:'DeepSeek V4.1 Flash'})).toBeVisible());expect(within(model).getByRole('option',{name:'provider-b · Model B'})).toBeVisible();expect(model).toHaveAttribute('title',expect.stringContaining('DeepSeek V4.1 Flash'));
 });
 it('reads context categories only after clicking the usage indicator without reloading controls',async()=>{
  vi.mocked(api.agent.contextBreakdown).mockReset().mockResolvedValue({context:{source:'jsonl',exact:false,method:'characters_div_3',checked_at:'2026-11-11T12:00:00Z',observed_at:null,model:'model-a',usage:null,partial:false,warnings:[],files_read:1,records_read:1,bytes_read:100,compactions:0,categories:[{id:'user',name:'用户消息',tokens:100,count:1,detail:[]}]}});
  mount();await screen.findByText('Context 30%');expect(api.agent.contextBreakdown).not.toHaveBeenCalled();const calls=vi.mocked(api.agent.controls).mock.calls.length;
  fireEvent.click(screen.getByRole('button',{name:'View context token details'}));const dialog=await screen.findByRole('dialog',{name:'上下文 Token 详情'});expect(await within(dialog).findByRole('rowheader',{name:'用户消息'})).toBeVisible();expect(api.agent.controls).toHaveBeenCalledTimes(calls);expect(api.agent.contextBreakdown).toHaveBeenCalledTimes(1);fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('places editable controls in the composer slot and keeps runtime information below',async()=>{
  const slot=document.createElement('div');document.body.append(slot);
  const view=render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active toolbarTarget={slot} onNewConversation={async()=>{}}/></QueryClientProvider>);
  expect(await within(slot).findByLabelText('选择模型')).toBeVisible();
  expect(within(slot).getByLabelText('选择推理强度')).toBeVisible();
  expect(within(slot).getByRole('button',{name:'压缩'})).toBeVisible();
  expect(within(slot).getByRole('button',{name:'新开'})).toBeVisible();
  expect(within(slot).queryByText('Context 30%')).not.toBeInTheDocument();
  expect(within(view.container).getByText('Context 30%')).toBeVisible();
  expect(within(slot).queryByText('/project')).not.toBeInTheDocument();
  expect(within(view.container).getByText('/project')).toBeVisible();
  view.unmount();expect(slot).toBeEmptyDOMElement();slot.remove();
 });
 it('updates usage immediately without an extra controls request and ignores an older metadata refresh',async()=>{
  mount();await screen.findByText('Context 30%');const calls=vi.mocked(api.agent.controls).mock.calls.length;
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:2400,input_tokens:2000,cached_input_tokens:1900,output_tokens:400},total:{total_tokens:402400,input_tokens:400000,cached_input_tokens:380000},window:40000}});});
  expect(await screen.findByText('Context 6%')).toBeVisible();expect(api.agent.controls).toHaveBeenCalledTimes(calls);
  await act(async()=>{await client.invalidateQueries({queryKey:['conversation-controls','s']});});
  expect(screen.getByText('Context 6%')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Details'}));const dialog=screen.getByRole('dialog',{name:'会话详情'});expect(within(dialog).getByRole('rowheader',{name:'本次缓存命中率'}).parentElement).toHaveTextContent('95.0%');
 });
 it('does not mix another native thread usage into this tab',async()=>{
  mount();await screen.findByText('Context 30%');
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'other',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:1000},total:{},window:40000}});});
  expect(screen.getByText('Context 30%')).toBeVisible();
 });
 it('refreshes every five minutes, ignores focus refresh and retains a manual refresh action',async()=>{
  vi.useFakeTimers();vi.mocked(api.agent.controls).mockClear();
  try {
   await act(async()=>{mount();await vi.advanceTimersByTimeAsync(0);});expect(api.agent.controls).toHaveBeenCalledTimes(1);
   await act(async()=>{await vi.advanceTimersByTimeAsync(299999);window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});expect(api.agent.controls).toHaveBeenCalledTimes(1);
   await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(api.agent.controls).toHaveBeenCalledTimes(2);
   await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Refresh session status'}));await vi.advanceTimersByTimeAsync(0);});expect(api.agent.controls).toHaveBeenCalledTimes(3);
  }finally{vi.useRealTimers();}
 });

 it('shows actual context and weekly remaining values and expands only allowlisted details',async()=>{
  data={...data,limits:[{used_percent:60,minutes:300,resets_at:1900000000},...data.limits]};mount();expect(await screen.findByText('Context 30%')).toBeVisible();expect(await screen.findByText('Weekly remaining 75%')).toBeVisible();expect(screen.getByText('5h remaining 40%')).toBeVisible();expect(screen.getByText('Engine 0.166.0')).toBeVisible();expect(screen.getByText('Approval: never')).toBeVisible();expect(screen.getByText('Tokens Window/Total : 40K/400K')).toBeVisible();expect(screen.getByText('Git main · 2 changed')).toBeVisible();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Details'}));const dialog=screen.getByRole('dialog',{name:'会话详情'});expect(dialog).not.toHaveTextContent('0.test');expect(dialog).not.toHaveTextContent('创建版本');expect(dialog).toHaveTextContent('工作区可写');expect(dialog).toHaveTextContent('40,000');expect(dialog).toHaveTextContent('400,000');const table=within(dialog).getByRole('table',{name:'Token 用量与运行环境'});expect(within(table).getByRole('rowheader',{name:'缓存命中输入'})).toBeVisible();expect(within(table).getByRole('rowheader',{name:'当前模型'})).toBeVisible();expect(dialog.querySelectorAll('details')).toHaveLength(0);fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
 it('sets and cancels Fast with a native catalog tier rather than guessing a provider setting',async()=>{
  data={...data,service_tier:'default',models:[{...data.models[0],service_tiers:[{id:'priority',name:'Fast',description:'Faster requests'}]},data.models[1]]};mount();
  const enable=await screen.findByRole('button',{name:'开启 Fast 模式'});fireEvent.click(enable);await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-a',effort:'high',service_tier:'priority'}));
  const disable=await screen.findByRole('button',{name:'关闭 Fast 模式'});expect(disable).toHaveAttribute('aria-pressed','true');fireEvent.click(disable);await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-a',effort:'high',service_tier:'default'}));
  expect(await screen.findByRole('button',{name:'开启 Fast 模式'})).toHaveAttribute('aria-pressed','false');
 });
 it('recognizes a catalog default Fast tier and disables it explicitly',async()=>{
  data={...data,service_tier:null,models:[{...data.models[0],default_service_tier:'priority',service_tiers:[{id:'priority',name:'Fast',description:'Faster requests'}]}]};mount();
  fireEvent.click(await screen.findByRole('button',{name:'关闭 Fast 模式'}));await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-a',effort:'high',service_tier:'default'}));expect(await screen.findByRole('button',{name:'开启 Fast 模式'})).toHaveAttribute('aria-pressed','false');
 });
 it('copies history when switching providers instead of opening an empty conversation',async()=>{
  data={...data,supports_fresh_model:true,provider:'provider-a',models:[{...data.models[0],provider:'provider-a'},{...data.models[1],provider:'provider-b'}]};
  const open=vi.fn().mockResolvedValue(undefined);vi.mocked(api.agent.setControls).mockClear();render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active onNewConversation={open}/></QueryClientProvider>);
  const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:JSON.stringify(['provider-b','model-b'])}});
  expect(api.agent.setControls).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
  const dialog=await screen.findByRole('dialog',{name:'保留上下文切换 Codex 环境'});fireEvent.click(within(dialog).getByRole('button',{name:'预检连接、登录、模型与项目权限'}));await within(dialog).findByRole('combobox',{name:'目标环境模型'});fireEvent.click(within(dialog).getByRole('button',{name:'复制历史并切换'}));await waitFor(()=>expect(api.codexEnvironments.transfer).toHaveBeenCalledWith('s',{environment_id:'provider:provider-b',provider:'provider-b',model:'model-b',effort:'low'}));expect(open).not.toHaveBeenCalled();
 });
 it('shows a saved recovery model without resubmitting settings automatically',async()=>{
  data={...data,supports_model_recovery:true,loaded:false,pending:{model:'model-b',effort:'low'},pending_status:'saved'};vi.mocked(api.agent.setControls).mockClear();mount();
  expect(await screen.findByText('恢复或重载时应用')).toBeVisible();expect(screen.getByRole('combobox',{name:'选择模型'})).toBeEnabled();expect(api.agent.setControls).not.toHaveBeenCalled();
 });
 it('does not invent percentages or editable options for missing or read-only telemetry',async()=>{
  data={...data,can_edit:false,loaded:false,models:[],limits:[],usage:null,model:null,effort:null};mount();expect(await screen.findByRole('combobox',{name:'选择模型'})).toBeDisabled();expect(screen.queryByRole('button',{name:'View context token details'})).not.toBeInTheDocument();expect(screen.queryByText(/Weekly remaining/)).not.toBeInTheDocument();
 });
});
