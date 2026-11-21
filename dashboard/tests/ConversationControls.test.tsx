import {sessionAgent} from '../src/lib/agents';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationControls} from '../src/components/ConversationControls';
import {api,type ConversationControlsData} from '../src/lib/api';
import type {SessionMetadata} from '../src/lib/session-metadata';
vi.mock('../src/lib/api',()=>({api:{codexEnvironments:{forSession:vi.fn(async()=>({current:'provider:provider-a',environments:[{id:'provider:provider-a',kind:'provider',provider:'provider-a',name:'A',auth_mode:'account',can_control:true},{id:'provider:provider-b',kind:'provider',provider:'provider-b',name:'B',can_control:true}]})),sessionPreflight:vi.fn(async()=>({ok:true,checks:[{stage:'models',ok:true,message:'available'}],models:[{model:'model-b',name:'B',provider:'provider-b',efforts:[{value:'low'}],defaultEffort:'low'}]})),transfer:vi.fn(async()=>({ok:true}))},agent:{controls:vi.fn(),setControls:vi.fn(),contextBreakdown:vi.fn(),conversationMetadata:vi.fn(async()=>({metadata:null})),conversationUsageIntervals:vi.fn(async()=>({intervals:null}))},sessions:{compactConversation:vi.fn().mockResolvedValue({ok:true})}}}));
let client:QueryClient,data:ConversationControlsData;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});data={agent:sessionAgent({cli_type:'codex'}),engine_version:'0.166.0',git:{branch:'main',changes:2},state:'active',model:'model-a',effort:'high',provider:'openai',cwd:'/project',cli_version:'0.test',permission:'workspace-write',approval:'never',service_tier:null,usage:{total:{total_tokens:400000},last:{total_tokens:12000,input_tokens:11000,cached_input_tokens:9000,output_tokens:1000},window:40000},limits:[{used_percent:25,minutes:10080,resets_at:1900000000}],models:[{model:'model-a',name:'Model A',description:'默认',efforts:[{value:'high',description:''}],defaultEffort:'high'},{model:'model-b',name:'Model B',description:'另一模型',efforts:[{value:'low',description:''},{value:'medium',description:''}],defaultEffort:'low'}],can_edit:true,loaded:true,pending:null,warning:null,native_id:'native',checked_at:'2026-10-31T02:00:00Z',usage_observed_at:'2026-10-31T01:59:00Z'};vi.mocked(api.agent.controls).mockImplementation(async()=>data);vi.mocked(api.agent.setControls).mockImplementation(async(_id,value)=>({ok:true,pending:null,...value}));});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active/></QueryClientProvider>);
describe('compact conversation controls',()=>{
 it.each(['codex','claude'])('shows the actual usage status and clears it after settlement for %s',async agent=>{
  data={...data,agent:sessionAgent({cli_type:agent})};
  const pending:SessionMetadata={native_id:'native',revision:1,observed_at:null,status:'pending',reasons:[],
    totals:{tokens:{input_tokens:100,cached_input_tokens:90,output_tokens:10,total_tokens:110},requests:1,tool_calls:0,tool_rounds:0,cost:null},
    latest:null,user_inputs:1,completed_turns:0,cache_drop_count:0};
  const view=(metadata:SessionMetadata)=><QueryClientProvider client={client}><ConversationControls sessionId="s" active metadata={metadata}/></QueryClientProvider>;
  const {rerender}=render(view(pending));
  expect(await screen.findByText('等待用量回执')).toBeVisible();
  expect(screen.getByLabelText('Cumulative token usage')).toHaveTextContent('110');
  rerender(view({...pending,reasons:['backfill']}));
  expect(screen.getByText('正在回填历史用量')).toBeVisible();
  rerender(view({...pending,reasons:['incomplete_record']}));
  expect(screen.getByText('等待原生记录写入完成')).toBeVisible();
  rerender(view({...pending,status:'complete'}));
  expect(screen.queryByText(/等待用量|正在回填|等待原生记录/)).toBeNull();
 });
 it('retains all cumulative token metrics while displaying window capacity only in Context',async()=>{
  data={...data,usage:{total:{total_tokens:330800000,input_tokens:330200000,cached_input_tokens:327800000,reasoning_output_tokens:286200,output_tokens:627600},last:{total_tokens:104500},window:475000}};
  mount();expect(await screen.findByText('Context 475K | 22%')).toBeVisible();
  const tokens=screen.getByLabelText('Cumulative token usage');
  expect(tokens).toHaveTextContent('Tokens Total｜Input｜Cache｜Reasoning｜Output : 330.8M｜2.4M｜327.8M｜286.2K｜627.6K');
  expect(tokens).not.toHaveTextContent('Window');expect(tokens).not.toHaveTextContent('475K');
  expect(within(tokens).getByText('327.8M')).toHaveAttribute('title','累计命中缓存的输入 Token（327,800,000）');
  const calls=vi.mocked(api.agent.controls).mock.calls.length;
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-16T01:00:00Z',usage:{total:{total_tokens:331000000,input_tokens:330400000,cached_input_tokens:328000000,reasoning_output_tokens:286300,output_tokens:627800},last:{total_tokens:120000},window:475000}});});
  await waitFor(()=>expect(tokens).toHaveTextContent('Tokens Total｜Input｜Cache｜Reasoning｜Output : 331M｜2.4M｜328M｜286.3K｜627.8K'));
  expect(api.agent.controls).toHaveBeenCalledTimes(calls);
 });
 it('shows known zero token counts and omits missing cumulative metrics',async()=>{
  data={...data,usage:{total:{input_tokens:0,output_tokens:1000},last:{},window:475000}};
  mount();const tokens=await screen.findByLabelText('Cumulative token usage');
  expect(tokens).toHaveTextContent('Tokens Input｜Output : 0｜1K');
  expect(tokens).not.toHaveTextContent(/Window|Total|Cache|Reasoning/);
  expect(screen.queryByRole('button',{name:'View context token details'})).not.toBeInTheDocument();
 });
 it.each([null,{total:{},last:{total_tokens:12000},window:40000}])('omits token consumption when cumulative counts are unavailable',async usage=>{
  data={...data,usage};mount();await screen.findByRole('button',{name:'Details'});
  expect(screen.queryByLabelText('Cumulative token usage')).not.toBeInTheDocument();
 });

 it('shows window capacity beside context usage and updates both from live events',async()=>{
  data={...data,usage:{total:{total_tokens:9999999},last:{total_tokens:166250},window:475000}};
  mount();expect(await screen.findByText('Context 475K | 35%')).toBeVisible();
  expect(screen.getByRole('button',{name:'View context token details'})).toHaveAttribute('title',expect.stringContaining('475,000 tokens'));
  expect(screen.queryByText(/Tokens Window/)).not.toBeInTheDocument();expect(within(screen.getByLabelText('Cumulative token usage')).getByText('10M')).toBeVisible();
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-16T01:00:00Z',usage:{total:{},last:{total_tokens:40000},window:80000}});});
  expect(await screen.findByText('Context 80K | 50%')).toBeVisible();
 });
 it.each([{total:{},last:{total_tokens:100}}, {total:{},last:{total_tokens:100},window:0}, {total:{},last:{},window:475000}])('omits the context indicator when capacity or recent usage is unknown',async usage=>{
  data={...data,usage};mount();await screen.findByRole('button',{name:'Details'});
  expect(screen.queryByRole('button',{name:'View context token details'})).not.toBeInTheDocument();
 });
 it.each([[80,'var(--success)'],[35,'#b7790b'],[20,'#e57b18'],[10,'var(--error)']] as const)('colors weekly remaining %s%% consistently with account quota',async(remaining,color)=>{
  data={...data,limits:[{used_percent:100-remaining,minutes:10080,resets_at:null}]};mount();const weekly=await screen.findByLabelText(`Weekly remaining ${remaining}%`);
  expect(weekly.querySelector('i')).toHaveAttribute('style',expect.stringContaining(color));expect(weekly.querySelector('strong')).toHaveStyle({color});
 });
 it('dismisses model details while selecting and restores them after focus leaves',async()=>{
  mount();const select=await screen.findByRole('combobox',{name:'选择模型'}),label=select.closest('label')!;
  fireEvent.mouseEnter(label);expect(screen.getByRole('tooltip')).toBeVisible();fireEvent.pointerDown(select);fireEvent.focus(select);expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.mouseLeave(label);fireEvent.mouseEnter(label);expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();fireEvent.blur(select);fireEvent.mouseEnter(label);expect(screen.getByRole('tooltip')).toBeVisible();
 });
 it('does not present subscription reference credits as API pricing',async()=>{
  data.models[0]={...data.models[0],reference_credits:{input:25,cached:1.25,output:125,as_of:'2026-11-11'}};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'provider:a',environments:[{id:'provider:a',name:'API',kind:'provider',auth_mode:'api',enabled:true,allowed_user_ids:null}]} as any);
  mount();const select=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(api.codexEnvironments.forSession).toHaveBeenCalled());fireEvent.focus(select);
  const tooltip=screen.getByRole('tooltip');expect(tooltip).not.toHaveTextContent('Credits 每百万 Token');expect(tooltip).toHaveTextContent('计费标准未提供');expect(screen.queryByText(/Weekly remaining/)).not.toBeInTheDocument();
 });
 it('shows selected account model details on focus and distinguishes reference credits',async()=>{
  data.models[0]={...data.models[0],context_window:128000,input_modalities:['text','image'],release_date:'2026-01-01',reference_credits:{input:25,cached:1.25,output:125,as_of:'2026-11-11'}};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'native',environments:[{id:'native',name:'Account',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]} as any);
  mount();const select=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(api.codexEnvironments.forSession).toHaveBeenCalled());
  fireEvent.focus(select);const tooltip=screen.getByRole('tooltip');
  expect(tooltip).toHaveTextContent('2026-01-01');expect(tooltip).toHaveTextContent('128,000 tokens');expect(tooltip).toHaveTextContent('text、image');expect(tooltip).toHaveTextContent('Credits 每百万 Token');expect(tooltip).toHaveTextContent('非实际账单');
  fireEvent.blur(select);expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
 });

 it('removes the provider prefix only for API engines while retaining account labels',async()=>{
  data={...data,provider:'provider-a',models:[{...data.models[0],provider:'provider-a',name:'DeepSeek V4.1 Flash'},{...data.models[1],provider:'provider-b'}]};
  vi.mocked(api.codexEnvironments.forSession).mockResolvedValueOnce({current:'provider:provider-a',environments:[{id:'provider:provider-a',name:'API',kind:'provider',provider:'provider-a',auth_mode:'api',enabled:true,allowed_user_ids:null,can_control:true},{id:'provider:provider-b',name:'Account',kind:'provider',provider:'provider-b',auth_mode:'account',enabled:true,allowed_user_ids:null,can_control:true}]});
  mount();const model=await screen.findByRole('combobox',{name:'选择模型'});await waitFor(()=>expect(within(model).getByRole('option',{name:'DeepSeek V4.1 Flash'})).toBeVisible());expect(within(model).getByRole('option',{name:'provider-b · Model B'})).toBeVisible();expect(model).toHaveAttribute('title',expect.stringContaining('DeepSeek V4.1 Flash'));
 });
 it('shows the cumulative cache hit rate before context and updates it live',async()=>{
  data={...data,usage:{...data.usage!,total:{total_tokens:400000,input_tokens:1000,cached_input_tokens:974}}};
  mount();const cache=await screen.findByLabelText('Cache hit rate 97.4%');expect(cache.querySelector('i')).toHaveStyle({background:'conic-gradient(var(--success) 97.4%, var(--border) 0)'});expect(cache.compareDocumentPosition(screen.getByText('Context 40K | 30%'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:1000,input_tokens:1000,cached_input_tokens:1000},total:{input_tokens:2000,cached_input_tokens:500},window:40000}});});
  expect(await screen.findByLabelText('Cache hit rate 25%')).toBeVisible();
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-02T03:20:56Z',usage:{last:{input_tokens:1000,cached_input_tokens:1000},total:{input_tokens:0,cached_input_tokens:0},window:40000}});});
  await waitFor(()=>expect(screen.queryByLabelText(/Cache hit rate/)).not.toBeInTheDocument());
 });
 it('reads context categories only after clicking the usage indicator without reloading controls',async()=>{
  vi.mocked(api.agent.contextBreakdown).mockReset().mockResolvedValue({context:{source:'jsonl',exact:false,method:'characters_div_3',checked_at:'2026-11-11T12:00:00Z',observed_at:null,model:'model-a',usage:null,partial:false,warnings:[],files_read:1,records_read:1,bytes_read:100,compactions:0,categories:[{id:'user',name:'用户消息',tokens:100,count:1,detail:[]}]}});
  mount();await screen.findByText('Context 40K | 30%');const weekly=await screen.findByLabelText('Weekly remaining 75%');expect(screen.queryByText(/Tokens Window/)).not.toBeInTheDocument();expect(screen.getByText('Context 40K | 30%').compareDocumentPosition(weekly)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(weekly.querySelector('i')).toHaveAttribute('aria-hidden','true');expect(weekly.querySelector('i')).toHaveAttribute('style',expect.stringContaining('75%'));expect(api.agent.contextBreakdown).not.toHaveBeenCalled();const calls=vi.mocked(api.agent.controls).mock.calls.length;
  fireEvent.click(screen.getByRole('button',{name:'View context token details'}));const dialog=await screen.findByRole('dialog',{name:'上下文 Token 详情'});expect(await within(dialog).findByRole('rowheader',{name:'用户消息'})).toBeVisible();expect(api.agent.controls).toHaveBeenCalledTimes(calls);expect(api.agent.contextBreakdown).toHaveBeenCalledTimes(1);fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('places editable controls in the composer slot and keeps runtime information below',async()=>{
  const slot=document.createElement('div');document.body.append(slot);
  const view=render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active toolbarTarget={slot} onNewConversation={async()=>{}}/></QueryClientProvider>);
  expect(await within(slot).findByLabelText('选择模型')).toBeVisible();
  expect(within(slot).getByLabelText('选择推理强度')).toBeVisible();
  expect(within(slot).getByRole('button',{name:'压缩'})).toBeVisible();
  expect(within(slot).getByRole('button',{name:'新开'})).toBeVisible();
  expect(within(slot).queryByText('Context 40K | 30%')).not.toBeInTheDocument();
  expect(within(view.container).getByText('Context 40K | 30%')).toBeVisible();
  expect(within(slot).queryByText('/project')).not.toBeInTheDocument();
  expect(within(view.container).getByText('/project')).toBeVisible();
  view.unmount();expect(slot).toBeEmptyDOMElement();slot.remove();
 });
 it('offers brief compaction alongside existing session controls and disables it while busy',async()=>{
  const brief=vi.fn(),view=render(<QueryClientProvider client={client}><ConversationControls sessionId="s" active onBrief={brief} onNewConversation={async()=>{}}/></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'简要压缩'}));expect(brief).toHaveBeenCalledOnce();
  view.rerender(<QueryClientProvider client={client}><ConversationControls sessionId="s" active busy onBrief={brief} onNewConversation={async()=>{}}/></QueryClientProvider>);
  expect(screen.getByRole('button',{name:'简要压缩'})).toBeDisabled();
 });
 it('updates usage immediately without an extra controls request and ignores an older metadata refresh',async()=>{
  mount();await screen.findByText('Context 40K | 30%');const calls=vi.mocked(api.agent.controls).mock.calls.length;
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'native',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:2400,input_tokens:2000,cached_input_tokens:1900,output_tokens:400},total:{total_tokens:402400,input_tokens:400000,cached_input_tokens:380000},window:40000}});});
  expect(await screen.findByText('Context 40K | 6%')).toBeVisible();expect(api.agent.controls).toHaveBeenCalledTimes(calls);
  await act(async()=>{await client.invalidateQueries({queryKey:['conversation-controls','s']});});
  expect(screen.getByText('Context 40K | 6%')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Details'}));const dialog=screen.getByRole('dialog',{name:'会话详情'});expect(within(dialog).getByRole('rowheader',{name:'缓存命中率'}).parentElement).toHaveTextContent('95.0%');
 });
 it('does not mix another native thread usage into this tab',async()=>{
  mount();await screen.findByText('Context 40K | 30%');
  await act(async()=>{client.setQueryData(['conversation-usage','s'],{native_id:'other',observed_at:'2026-11-02T03:20:55Z',usage:{last:{total_tokens:1000},total:{},window:40000}});});
  expect(screen.getByText('Context 40K | 30%')).toBeVisible();
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

 it('opens the overview and switches among three table pages by keyboard',async()=>{
  mount();
  expect(await screen.findByText('Context 40K | 30%')).toBeVisible();
  expect(await screen.findByLabelText('Weekly remaining 75%')).toBeVisible();
  const details=screen.getByRole('button',{name:'Details'});
  details.focus();
  fireEvent.click(details);
  const dialog=screen.getByRole('dialog',{name:'会话详情'});
  const overview=within(dialog).getByRole('tab',{name:'概览'});
  expect(overview).toHaveFocus();
  expect(within(dialog).getByRole('table',{name:'Token 用量'})).toBeVisible();
  expect(within(dialog).getByRole('rowheader',{name:'当前模型'}).parentElement).toHaveTextContent('model-a');
  fireEvent.keyDown(overview,{key:'ArrowRight'});
  const cache=within(dialog).getByRole('tab',{name:'缓存异常'});
  expect(cache).toHaveFocus();
  expect(within(dialog).getByRole('table',{name:'缓存命中输入减少明细'})).toBeVisible();
  expect(within(dialog).queryByRole('table',{name:'Token 用量'})).not.toBeInTheDocument();
  fireEvent.keyDown(cache,{key:'End'});
  const usage=within(dialog).getByRole('tab',{name:'会话详情'});
  expect(usage).toHaveAttribute('aria-selected','true');
  expect(within(dialog).getByRole('table',{name:'逐区间用量'})).toBeVisible();
  fireEvent.keyDown(usage,{key:'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(details).toHaveFocus();
 });
 it('applies model and effort immediately and shows the confirmed current settings',async()=>{
  mount();const model=await screen.findByRole('combobox',{name:'选择模型'});fireEvent.change(model,{target:{value:'model-b'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenCalledWith('s',{model:'model-b',effort:'low'}));expect(await screen.findByText('已应用')).toBeVisible();expect(screen.getByRole('combobox',{name:'选择推理强度'})).toHaveValue('low');expect(screen.queryByText('下轮生效')).not.toBeInTheDocument();fireEvent.change(screen.getByRole('combobox',{name:'选择推理强度'}),{target:{value:'medium'}});await waitFor(()=>expect(api.agent.setControls).toHaveBeenLastCalledWith('s',{model:'model-b',effort:'medium'}));expect(model).toHaveValue('model-b');
 });
 it('removes the open interval on settlement while retaining loaded earlier Final rows',async()=>{
  let settled=false;
  const usage={coverage:'complete' as const,complete:true,tokens:{total_tokens:5010},requests:1,tool_rounds:0,tool_calls:0,shared_messages:1};
  const row=(id:string,total_tokens:number)=>({id,kind:'final' as const,at:null,usage:{...usage,tokens:{total_tokens}},expandable:true});
  vi.mocked(api.agent.conversationUsageIntervals).mockImplementation(async(_id,query)=>({intervals:{
    native_id:'native',generation:'same',revision:settled?2:1,
    rows:query.before?[row('older',4030)]:[
      settled?row('settled',6010):{id:'open',kind:'open' as const,at:null,usage:null,expandable:true},
      row('first',5010),
    ],next_before:query.before?null:'older-cursor',
  }}));
  mount();fireEvent.click(await screen.findByRole('button',{name:'Details'}));
  fireEvent.click(screen.getByRole('tab',{name:'会话详情'}));
  const table=screen.getByRole('table',{name:'逐区间用量'});
  expect(await within(table).findByText('未完成答复')).toBeVisible();
  fireEvent.click(within(table).getByRole('button',{name:'更早的用量'}));
  expect(await within(table).findByText('4,030')).toBeVisible();
  settled=true;
  await act(async()=>{await client.invalidateQueries({queryKey:['conversation-usage-intervals','s']});});
  expect(await within(table).findByText('6,010')).toBeVisible();
  expect(within(table).queryByText('未完成答复')).not.toBeInTheDocument();
  expect(within(table).getByText('4,030')).toBeVisible();
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
