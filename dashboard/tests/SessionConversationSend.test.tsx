import {composerKey,loadComposer,saveComposer,emptyComposer} from '../src/lib/batch-composer';
import {sessionAgent} from '../src/lib/agents';
import { act, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ConversationPage, type ConversationStatistics, type Session } from '../src/lib/api';
import { SessionConversation } from '../src/components/SessionConversation';
import * as metadata from '../src/components/ConversationStatisticsLabel';
import {parseBriefContext} from '../src/lib/conversation-brief-context';

vi.mock('../src/lib/permissions', () => ({ usePermissions: () => ({ data: {}, isPending: false }), hasPermission: () => true }));
vi.mock('../src/lib/use-conversation-compaction', () => ({ useConversationCompaction: () => ({ state: null, running: false, start: vi.fn(), usage: vi.fn(), observe: vi.fn(), disconnected: vi.fn() }) }));
vi.mock('../src/components/ConversationControls', () => ({ ConversationControls: () => null }));
vi.mock('../src/components/ConversationReadingTools', () => ({ ConversationWidthHandles: () => null, ConversationNavigator: () => null }));

class Socket {
  static latest: Socket;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { Socket.latest = this; }
  close() {}
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const session = { id: 'send-session', project_id: 'project', status: 'running', cli_type: 'codex', codex_session_id: 'native', claude_session_id: null } as Session;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type SendResult = Awaited<ReturnType<typeof api.agent.sendInput>>;
function input(value: string) { const editor = screen.getByRole('textbox', { name: '发送给当前 Agent 的消息' }); editor.textContent = value; fireEvent.input(editor); return editor; }
async function mount(target:Session=session,onNewConversation?:(preference?:import('../src/lib/api').AgentModelPreference,expectedNativeId?:string)=>Promise<string|void>) {
  Socket.latest=undefined as unknown as Socket;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view=render(<QueryClientProvider client={client}><SessionConversation session={target} active onRaw={() => {}} onNewConversation={onNewConversation}/></QueryClientProvider>);
  await waitFor(() => expect(Socket.latest?.onmessage).toBeTruthy());
  act(() => Socket.latest.emit({ type: 'snapshot', messages: [], busy: false, stage: 'idle' }));
  await waitFor(() => expect(screen.getByText('Event stream connected')).toBeInTheDocument());
  return view;
}
beforeEach(() => {
  vi.spyOn(api.agent,'checkSend').mockResolvedValue({needs_confirmation:false,token:undefined} as any);
  localStorage.clear();
  sessionStorage.clear();
  Socket.latest = undefined as unknown as Socket;
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(api.agent, 'conversation').mockResolvedValue({ messages: [], statistics: [], has_more: false, reset: false, available: true, generation: 'generation', native_id: 'native', session_active: true, session_status: 'running', runtime: { state: 'idle' }, interaction: null } as unknown as ConversationPage);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('conversation send transaction', () => {
  it('shows submission, waiting for native receipt and delivery across a browser remount',async()=>{
    const response=deferred<SendResult>();
    const submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);
    const view=await mount();
    input('等待回执的追加输入');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    expect(await screen.findByRole('status',{name:'提交中'})).toBeVisible();
    const clientId=submit.mock.calls[0][2];
    await act(async()=>response.resolve({status:'submitted'} as SendResult));
    expect(await screen.findByRole('status',{name:'等待 Agent 接收'})).toBeVisible();
    expect(screen.queryByRole('status',{name:'已发送'})).not.toBeInTheDocument();
    view.unmount();
    await mount();
    expect(await screen.findByRole('status',{name:'等待 Agent 接收'})).toBeVisible();
    act(()=>Socket.latest.emit({type:'snapshot',messages:[{
      id:'confirmed-input',client_id:clientId,role:'user',text:'等待回执的追加输入',timestamp:'2026-11-20T04:02:00Z',
    }],busy:true,stage:'waiting',turn_id:'turn'}));
    expect(await screen.findByRole('status',{name:'已发送'})).toBeVisible();
    expect(screen.getAllByText('等待回执的追加输入')).toHaveLength(1);
    expect(screen.queryByRole('status',{name:'等待 Agent 接收'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'复制你的消息'})).not.toBeInTheDocument();
  });
  it('keeps an ambiguous input pending until the matching native receipt',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockRejectedValue(new ApiError('接收结果暂未确认',503,'unknown'));
    await mount();
    input('结果待确认的消息');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    expect(await screen.findByRole('status',{name:'发送结果待确认'})).toBeVisible();
    expect(screen.queryByRole('status',{name:'已发送'})).not.toBeInTheDocument();
    const id=submit.mock.calls[0][2];
    act(()=>Socket.latest.emit({type:'snapshot',messages:[{
      id:'echo',client_id:id,role:'user',text:'结果待确认的消息',timestamp:'2026-11-20T04:02:00Z',
    }],busy:true,stage:'waiting',turn_id:'turn'}));
    expect(await screen.findByRole('status',{name:'已发送'})).toBeVisible();
    expect(screen.queryByRole('status',{name:'发送结果待确认'})).not.toBeInTheDocument();
    expect(submit).toHaveBeenCalledOnce();
  });
  it('shows the batch panel only while entries need sending and hides it after acceptance',async()=>{
    const response=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);await mount();
    const panel=()=>screen.queryByRole('complementary',{name:'批量待发内容'});
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    expect(panel()).not.toBeInTheDocument();input('staged');expect(panel()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'加入批量'}));expect(panel()).toHaveTextContent('staged');
    expect(screen.getByRole('separator',{name:'调整批量待发区宽度'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(panel()).toHaveTextContent('staged');
    await act(async()=>response.resolve({status:'submitted'} as SendResult));
    await waitFor(()=>expect(panel()).not.toBeInTheDocument());
    expect(screen.getByRole('combobox',{name:'发送模式'})).toHaveValue('batch');
    input('next');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));expect(panel()).toHaveTextContent('next');
    fireEvent.click(screen.getByRole('button',{name:'删除第 1 条消息'}));expect(panel()).not.toBeInTheDocument();
    input('recall');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    fireEvent.click(screen.getByRole('button',{name:'撤回第 1 条消息'}));expect(panel()).not.toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveTextContent('recall');
  });
  it('omits unknown timing and redundant scope labels from a restored final response',async()=>{
    await mount();
    const part={tokens:{total_tokens:100},requests:1,tool_calls:0,tool_rounds:0,complete:false,shared_messages:1,start_at:null,end_at:'2026-11-15T05:30:00Z',elapsed_ms:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[{id:'unknown-timing-final',role:'assistant',phase:'final',text:'Completed with unknown timing',timestamp:part.end_at,turn_id:'turn',statistics:{...part,sequence:1,turn_id:'turn',conclusion:part}}],busy:false,stage:'idle'}));
    const final=document.querySelector('[data-chat-message-id="unknown-timing-final"]')!;
    expect(final).toHaveTextContent('100');expect(final).not.toHaveTextContent('summary ·');expect(final).not.toHaveTextContent('Total: —');
    expect(final.querySelector('.session-chat-message-duration')).toBeNull();
  });
  it('retains the settled usage of an older page after a large live update',async()=>{
    const old={id:'earlier-final',role:'assistant',phase:'final',text:'Earlier reply',timestamp:null,turn_id:'old'} as const;
    const pending:ConversationStatistics={
      sequence:1, revision:1, message_id:old.id, turn_id:'old',
      tokens:null, requests:0, tool_calls:0, tool_rounds:0, complete:false,
    };
    const current={...old,id:'current-final',text:'Current reply',turn_id:'current'};
    vi.mocked(api.agent.conversation).mockImplementation(async(_id,query)=>({
      messages:query?.before?[old]:[current], statistics:query?.before?[pending]:[],
      has_more:!query?.before, reset:false, available:true, generation:'generation',
      native_id:'native', session_active:true, session_status:'running', runtime:{state:'idle'}, interaction:null,
    }) as ConversationPage);
    await mount();
    fireEvent.click(screen.getByRole('button',{name:'加载更早的对话'}));
    await screen.findByText('Earlier reply');
    const settled={...pending,revision:2,requests:1,tokens:{total_tokens:2420},complete:true};
    const emit=(statistics:ConversationStatistics[])=>act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics}));
    emit([settled]);
    const label=document.querySelector('[data-chat-message-id="earlier-final"] .session-chat-message-statistics');
    expect(label).toHaveTextContent('2.4K');
    emit([pending,...Array.from({length:165},(_,index)=>({...settled,message_id:'later-'+index,sequence:2+index}))]);
    expect(label).toHaveTextContent('2.4K');
    expect(label).toHaveAttribute('title',expect.stringContaining('Total 2,420'));
    expect(label).toHaveTextContent('1 round | 0 calls');
  });
  it('closes the guard modal on compact-and-send and keeps a cancellable inline status',async()=>{
    vi.mocked(api.agent.checkSend).mockResolvedValue({needs_confirmation:true,matched:true,token:'confirmed',native_id:'native',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,observed_at:null,can_compact:true,can_new:false} as any);
    const submit=vi.spyOn(api.agent,'sendInput');await mount();input('preserved while compacting');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));expect(screen.queryByRole('dialog',{name:'发送前检查'})).not.toBeInTheDocument();expect(screen.getByText('正在压缩，确认完成后自动发送。')).toBeVisible();expect(submit).not.toHaveBeenCalled();expect(loadComposer(composerKey('local',session.id)).draft).toBe('preserved while compacting');
    fireEvent.click(screen.getByRole('button',{name:'取消后续发送'}));await waitFor(()=>expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled());expect(submit).not.toHaveBeenCalled();expect(loadComposer(composerKey('local',session.id)).draft).toBe('preserved while compacting');
  });

  it('connects when the native binding arrives after the initial conversation response',async()=>{
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const view=render(<QueryClientProvider client={client}><SessionConversation session={{...session,codex_session_id:null,native_session_id:null}} active onRaw={()=>{}}/></QueryClientProvider>);
    try{
      await waitFor(()=>expect(api.agent.conversation).toHaveBeenCalled());
      await waitFor(()=>expect(screen.queryByText('正在加载对话…')).not.toBeInTheDocument());
      expect(Socket.latest).toBeUndefined();
      view.rerender(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
      await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
      act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:false,stage:'idle'}));
      expect(await screen.findByText('Event stream connected')).toBeVisible();
    }finally{view.unmount();client.clear();}
  });
  it('keeps the draft until risk confirmation and submits the confirmed payload once',async()=>{
    vi.mocked(api.agent.checkSend).mockResolvedValue({needs_confirmation:true,matched:true,token:'confirmed',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,observed_at:null,can_compact:false,can_new:false} as any);
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();input('protected draft');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    const dialog=await screen.findByRole('dialog',{name:'发送前检查'});expect(submit).not.toHaveBeenCalled();expect(loadComposer(composerKey('local',session.id)).draft).toBe('protected draft');
    fireEvent.click(within(dialog).getByRole('button',{name:'原样发送'}));await waitFor(()=>expect(submit).toHaveBeenCalledOnce());expect(submit.mock.calls[0][1]).toBe('protected draft');expect(submit.mock.calls[0][5]).toBe('confirmed');
  });
  it('sends a brief history and current draft once, then presents the history as an expandable first card',async()=>{
    const guard={needs_confirmation:true,matched:true,enabled:true,token:'before',native_id:'native',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,checked_at:'',can_compact:true,can_new:true};
    vi.mocked(api.agent.checkSend).mockResolvedValueOnce(guard).mockResolvedValueOnce({...guard,native_id:'fresh',token:'after'});
    vi.mocked(api.agent.conversation).mockImplementation(async(_id,query)=>({
      session_id:session.id,messages:query?.limit?[{id:'old-user',role:'user',text:'旧需求',timestamp:null},{id:'old-final',role:'assistant',phase:'final',text:'旧结论',timestamp:null}]:[],
      statistics:[],has_more:false,reset:false,available:true,generation:'generation',native_id:'native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
    }) as ConversationPage);
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult),newSession=vi.fn().mockResolvedValue('fresh');
    await mount(session,newSession);input('这次的新需求');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    fireEvent.click(within(await screen.findByRole('dialog',{name:'发送前检查'})).getByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(newSession).toHaveBeenCalledExactlyOnceWith(undefined,'native');
    const sent=submit.mock.calls[0][1],brief=parseBriefContext(sent)!;
    expect(brief.input).toBe('这次的新需求');expect(brief.context.turns[0]).toEqual({input:'旧需求',conclusion:'旧结论'});
    expect(submit.mock.calls[0][5]).toBe('after');
    const card=await screen.findByRole('button',{name:/简要压缩/});expect(screen.getByText('这次的新需求')).toBeVisible();
    expect(screen.queryByText('旧需求')).not.toBeInTheDocument();fireEvent.click(card);
    const details=screen.getByRole('dialog',{name:'简要压缩详情'});expect(within(details).getByText('旧需求')).toBeVisible();expect(within(details).getByText('旧结论')).toBeVisible();
  });
  it('preserves batch boundaries when brief history is prepended',async()=>{
    const guard={needs_confirmation:true,matched:true,enabled:true,token:'before',native_id:'native',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,checked_at:'',can_compact:true,can_new:true};
    vi.mocked(api.agent.checkSend).mockResolvedValueOnce(guard).mockResolvedValueOnce({...guard,native_id:'fresh',token:'after'});
    vi.mocked(api.agent.conversation).mockImplementation(async(_id,query)=>({
      session_id:session.id,messages:query?.limit?[{id:'old',role:'user',text:'上一轮',timestamp:null}]:[],statistics:[],has_more:false,reset:false,available:true,generation:'generation',native_id:'native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
    }) as ConversationPage);
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);
    await mount(session,vi.fn().mockResolvedValue('fresh'));fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('one');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('two');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));fireEvent.click(within(await screen.findByRole('dialog',{name:'发送前检查'})).getByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    const sent=submit.mock.calls[0][1],brief=parseBriefContext(sent)!;
    expect(brief.input).toBe('one\n\ntwo');expect(submit.mock.calls[0][4]).toEqual([{length:brief.prefixLength+3,attachments:0},{length:3,attachments:0}]);
    fireEvent.click(await screen.findByRole('button',{name:/批量消息/}));
    const batch=screen.getByRole('dialog',{name:'批量消息 · 2 条'});expect(within(batch).getByLabelText('第 1 条消息')).toHaveTextContent('one');expect(within(batch).getByLabelText('第 1 条消息')).not.toHaveTextContent('上一轮');
  });
  it('retains brief history with a rejected draft across reload and attaches it on retry',async()=>{
    const guard={needs_confirmation:true,matched:true,enabled:true,token:'before',native_id:'native',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,checked_at:'',can_compact:true,can_new:true};
    vi.mocked(api.agent.checkSend).mockResolvedValueOnce(guard).mockResolvedValueOnce({...guard,native_id:'fresh',token:'after'}).mockResolvedValue({...guard,needs_confirmation:false,native_id:'fresh',token:'retry'});
    vi.mocked(api.agent.conversation).mockImplementation(async(_id,query)=>({
      session_id:session.id,messages:query?.limit?[{id:'old',role:'user',text:'旧需求',timestamp:null}]:[],statistics:[],has_more:false,reset:false,available:true,generation:'generation',native_id:'native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
    }) as ConversationPage);
    const submit=vi.spyOn(api.agent,'sendInput').mockRejectedValueOnce(new ApiError('not accepted',409,'rejected')).mockResolvedValue({status:'submitted'} as SendResult);
    const view=await mount(session,vi.fn().mockResolvedValue('fresh'));input('需要保留的草稿');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    fireEvent.click(within(await screen.findByRole('dialog',{name:'发送前检查'})).getByRole('button',{name:'简要压缩后发送'}));fireEvent.click(await screen.findByRole('button',{name:'开始简要压缩'}));
    expect(await screen.findByText('简要历史已保留，将与原草稿一起发送。')).toBeVisible();
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());await waitFor(()=>expect(loadComposer(composerKey('local',session.id)).draft).toBe('需要保留的草稿'));
    const first=submit.mock.calls[0][1],saved=loadComposer(composerKey('local',session.id)).briefContext;
    expect(saved?.nativeId).toBe('fresh');expect(parseBriefContext(first)?.input).toBe('需要保留的草稿');
    view.unmount();vi.mocked(api.agent.conversation).mockResolvedValue({session_id:session.id,messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'new',native_id:'fresh',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null} as unknown as ConversationPage);
    await mount({...session,codex_session_id:'fresh',native_session_id:'fresh'});
    input('另一条输入');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前内容与简要历史关联的原草稿不同');expect(submit).toHaveBeenCalledOnce();
    input('需要保留的草稿');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2));expect(submit.mock.calls[1][1]).toBe(first);
    await waitFor(()=>expect(loadComposer(composerKey('local',session.id)).briefContext).toBeUndefined());
  });
  it('cancels a batch warning and restores it after remount without dispatching',async()=>{
    vi.mocked(api.agent.checkSend).mockResolvedValue({needs_confirmation:true,token:'confirmed',context_tokens:800,context_window:1000,context_percent:80,idle_minutes:null,observed_at:null,can_compact:false,can_new:false} as any);
    const submit=vi.spyOn(api.agent,'sendInput');const view=await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});input('staged risk');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));
    fireEvent.click(within(await screen.findByRole('dialog',{name:'发送前检查'})).getByRole('button',{name:'取消'}));expect(submit).not.toHaveBeenCalled();view.unmount();await mount();expect(loadComposer(composerKey('local',session.id)).entries[0].text).toBe('staged risk');expect(submit).not.toHaveBeenCalled();
  });
  it('stages messages, restores draft and batch after reload, and sends one combined message',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);
    const view=await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('first');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    input('second');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('unfinished');
    const staged=loadComposer(composerKey('local',session.id)).entries;expect(staged.every(entry=>Number.isFinite(Date.parse(entry.createdAt!)))).toBe(true);
    expect(submit).not.toHaveBeenCalled();view.unmount();await mount();
    expect([...screen.getByRole('complementary',{name:'批量待发内容'}).querySelectorAll('time')].map(t=>t.dateTime)).toEqual(staged.map(e=>e.createdAt));
    expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveTextContent('unfinished');
    expect(screen.getByRole('complementary',{name:'批量待发内容'})).toHaveTextContent('first');
    fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());expect(submit.mock.calls[0][1]).toBe('first\n\nsecond');
    await waitFor(()=>expect(loadComposer(composerKey('local',session.id)).entries).toHaveLength(0));
    expect(loadComposer(composerKey('local',session.id)).draft).toBe('unfinished');
  });
  it('retains unknown submissions across reload without resending and reconciles the durable echo',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockRejectedValue(new ApiError('unknown',503,'unknown'));
    const view=await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('keep me');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());await waitFor(()=>expect(screen.getByRole('button',{name:'发送批量内容'})).toBeDisabled());expect(screen.getByRole('complementary',{name:'批量待发内容'})).toHaveTextContent('keep me');
    expect(screen.getByRole('button',{name:'撤回第 1 条消息'})).toBeDisabled();expect(screen.getByRole('button',{name:'删除第 1 条消息'})).toBeDisabled();
    const id=submit.mock.calls[0][2];view.unmount();await mount();
    expect(screen.getByRole('button',{name:'发送批量内容'})).toBeDisabled();expect(submit).toHaveBeenCalledOnce();
    act(()=>Socket.latest.emit({type:'snapshot',messages:[{id:'echo',role:'user',text:'keep me',client_id:id,timestamp:new Date().toISOString()}],busy:false,stage:'idle'}));
    await waitFor(()=>expect(loadComposer(composerKey('local',session.id)).pending).toBeNull());
    expect(loadComposer(composerKey('local',session.id)).entries).toHaveLength(0);
  });
  it('keeps rejected batch contents available and protects new input during an in-flight send',async()=>{
    const response=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);
    await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('batch');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));input('new input');
    await act(async()=>response.reject(new ApiError('not accepted',409,'rejected')));
    expect(loadComposer(composerKey('local',session.id)).draft).toBe('new input');
    expect(loadComposer(composerKey('local',session.id)).entries[0].text).toBe('batch');
    expect(screen.getByRole('button',{name:'发送批量内容'})).toBeEnabled();expect(submit).toHaveBeenCalledOnce();
  });
  it('sends staged content from its send button and opens a centered batch detail dialog',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('one');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('two');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    const editor=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,isComposing:true});expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][4]).toEqual([{length:3,attachments:0},{length:3,attachments:0}]);
    const sentAt='2026-11-14T06:00:00Z';act(()=>Socket.latest.emit({type:'snapshot',messages:[{id:'sent-batch',client_id:submit.mock.calls[0][2],role:'user',text:'one\n\ntwo',timestamp:sentAt}],busy:false,stage:'idle'}));
    fireEvent.click(screen.getByRole('button',{name:/批量消息/}));
    const dialog=screen.getByRole('dialog',{name:'批量消息 · 2 条'});expect(within(dialog).getByLabelText('第 1 条消息')).toHaveTextContent('one');expect(within(dialog).getByLabelText('第 2 条消息')).toHaveTextContent('two');
    expect([...dialog.querySelectorAll('time')].map(t=>t.dateTime)).toEqual([sentAt,sentAt]);
    fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('sends the staged batch with Ctrl+Enter when the editor is empty',async()=>{
    const response=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});const editor=input('staged');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][1]).toBe('staged');expect(submit.mock.calls[0][4]).toEqual([{length:6,attachments:0}]);await act(async()=>response.resolve({status:'submitted'} as SendResult));
    expect(screen.getByRole('button',{name:/批量消息/})).toBeInTheDocument();
  });
  it('sends the batch when focus remains on the add-to-batch button',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});input('staged');const button=screen.getByRole('button',{name:'加入批量'});fireEvent.click(button);expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveFocus();button.focus();
    fireEvent.keyDown(button,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledOnce());expect(submit.mock.calls[0][1]).toBe('staged');expect(submit.mock.calls[0][4]).toEqual([{length:6,attachments:0}]);
  });
  it('handles Command+Enter on a focused batch button and does not resend unknown batches',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockRejectedValue(new ApiError('unknown',503,'unknown'));await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});const editor=input('staged');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    fireEvent.keyDown(screen.getByRole('button',{name:'发送批量内容'}),{key:'Enter',metaKey:true});await waitFor(()=>expect(screen.getByText('unknown')).toBeInTheDocument());
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(submit).toHaveBeenCalledOnce();
  });
  it('directly sends only the current input with Ctrl+Enter in batch mode as a plain message',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('staged');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));const editor=input('direct');
    fireEvent.compositionStart(editor);fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});expect(submit).not.toHaveBeenCalled();fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,repeat:true});expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledOnce());expect(submit.mock.calls[0][1]).toBe('direct');expect(submit.mock.calls[0][4]).toBeUndefined();
    expect(loadComposer(composerKey('local',session.id)).entries.map(e=>e.text)).toEqual(['staged']);expect(screen.queryByRole('button',{name:/批量消息/})).not.toBeInTheDocument();
  });
  it('sends an attachment-only input directly instead of consuming the staged batch',async()=>{
    const file={kind:'file' as const,name:'fixture.txt',path:'/fixture/fixture.txt',offset:0};
    saveComposer(composerKey('local',session.id),{...emptyComposer(),mode:'batch',draftAttachments:[file],entries:[{id:'staged',text:'keep staged',attachments:[]}]});
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.keyDown(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'}),{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][1]).toBe('');expect(submit.mock.calls[0][3]?.[0].path).toBe(file.path);expect(submit.mock.calls[0][4]).toBeUndefined();expect(loadComposer(composerKey('local',session.id)).entries[0].text).toBe('keep staged');
  });
  it('does not reuse an uncertain batch identity for an identical direct message',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockRejectedValueOnce(new ApiError('unknown',503,'unknown')).mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});input('same');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));
    await waitFor(()=>expect(screen.getByText('unknown')).toBeInTheDocument());const editor=input('same');fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0][2]).not.toBe(submit.mock.calls[1][2]);expect(submit.mock.calls[1][4]).toBeUndefined();expect(loadComposer(composerKey('local',session.id)).pending?.id).toBe(submit.mock.calls[0][2]);
  });
  it('recalls one staged message into the existing draft without losing either text',async()=>{
    await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('staged');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('editing');
    fireEvent.click(screen.getByRole('button',{name:'撤回第 1 条消息'}));
    const stored=loadComposer(composerKey('local',session.id));expect(stored.entries).toEqual([]);expect(stored.draft).toBe('editing\n\nstaged');
    expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveTextContent('editing');
  });
  it('uses the conversation image preview in staged entries and restores recalled attachments after reload',async()=>{
    const image={kind:'image' as const,name:'fixture.png',path:'/fixture/fixture.png',offset:3};
    saveComposer(composerKey('local',session.id),{...emptyComposer(),mode:'batch',entries:[{id:'image',text:'pic',attachments:[image]}]});
    const view=await mount();fireEvent.click(screen.getByRole('button',{name:'打开附件 fixture.png'}));
    expect(screen.getByRole('dialog',{name:'图片预览 · fixture.png'})).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'关闭图片预览 · fixture.png'}));
    fireEvent.click(screen.getByRole('button',{name:'撤回第 1 条消息'}));
    expect(loadComposer(composerKey('local',session.id)).draftAttachments).toEqual([image]);view.unmount();await mount();
    expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveTextContent('pic');expect(loadComposer(composerKey('local',session.id)).draftAttachments).toEqual([image]);
  });
  it('deletes a staged entry without changing the current input and persists the removal',async()=>{
    const view=await mount();fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('remove');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('keep');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('editing');
    fireEvent.click(screen.getByRole('button',{name:'删除第 1 条消息'}));
    const saved=loadComposer(composerKey('local',session.id));expect(saved.entries.map(e=>e.text)).toEqual(['keep']);expect(saved.draft).toBe('editing');view.unmount();await mount();
    expect(screen.getByRole('complementary',{name:'批量待发内容'})).toHaveTextContent('keep');expect(screen.getByRole('complementary',{name:'批量待发内容'})).not.toHaveTextContent('remove');
  });
  it('reconciles the terminal echo when its native ID differs from the browser ID',async()=>{
    const response=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);await mount();input('terminal echo');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    const browser=submit.mock.calls[0][2],live={id:'live-terminal',client_id:'terminal-client',role:'user',text:'terminal echo',timestamp:new Date().toISOString()};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[live],busy:true,stage:'tools'}));expect(screen.getAllByText('terminal echo')).toHaveLength(2);
    const durable={...live,id:'durable-terminal',sequence:120,client_id:browser,native_client_id:'terminal-client'};
    act(()=>Socket.latest.emit({type:'input_reconciliation',native_id:'native',messages:[durable]}));expect(screen.getAllByText('terminal echo')).toHaveLength(1);
    act(()=>Socket.latest.emit({type:'snapshot',messages:[live],busy:true,stage:'tools'}));expect(screen.getAllByText('terminal echo')).toHaveLength(1);
    await act(async()=>response.resolve({status:'submitted'} as SendResult));
  });
  it('requests a stop only for the observed active turn and waits for its stream to finish',async()=>{
    const stop=deferred<{status:'accepted'}>();const call=vi.spyOn(api.agent,'stopTurn').mockReturnValue(stop.promise);
    const descriptor=sessionAgent(session);await mount({...session,agent:{...descriptor,capabilities:{...descriptor.capabilities,stopTurn:true}}});
    act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:true,stage:'tools',turn_id:'active-turn',started_at:new Date().toISOString()}));
    const button=await screen.findByRole('button',{name:'停止当前执行'});expect(button).toBeEnabled();fireEvent.click(button);fireEvent.click(button);expect(call).toHaveBeenCalledExactlyOnceWith(session.id,'active-turn');expect(button).toBeDisabled();expect(button).toHaveAccessibleName('正在停止当前执行');
    await act(async()=>stop.resolve({status:'accepted'}));expect(button).toBeDisabled();
    act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:false,stage:'idle',turn_id:'active-turn'}));expect(screen.queryByRole('button',{name:'停止当前执行'})).not.toBeInTheDocument();
  });
  it('uses Escape to stop the active conversation while respecting composition and dialogs',async()=>{
    const stop=deferred<{status:'accepted'}>(),call=vi.spyOn(api.agent,'stopTurn').mockReturnValue(stop.promise),descriptor=sessionAgent(session);
    await mount({...session,agent:{...descriptor,capabilities:{...descriptor.capabilities,stopTurn:true}}});
    const editor=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});fireEvent.keyDown(editor,{key:'Escape'});expect(call).not.toHaveBeenCalled();
    act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:true,stage:'tools',turn_id:'active-turn',started_at:new Date().toISOString()}));
    fireEvent.keyDown(editor,{key:'Escape',isComposing:true});fireEvent.keyDown(editor,{key:'Escape',repeat:true});expect(call).not.toHaveBeenCalled();
    const select=document.createElement('select');editor.closest('section')!.appendChild(select);fireEvent.keyDown(select,{key:'Escape'});expect(call).not.toHaveBeenCalled();select.remove();
    const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');document.body.appendChild(modal);
    fireEvent.keyDown(editor,{key:'Escape'});expect(call).not.toHaveBeenCalled();modal.remove();
    const unrelated=document.createElement('input');document.body.appendChild(unrelated);fireEvent.keyDown(unrelated,{key:'Escape'});expect(call).not.toHaveBeenCalled();unrelated.remove();
    fireEvent.keyDown(editor,{key:'Escape'});fireEvent.keyDown(editor,{key:'Escape'});expect(call).toHaveBeenCalledExactlyOnceWith(session.id,'active-turn');
    await act(async()=>stop.resolve({status:'accepted'}));
  });
  it('keeps an uncertain stop from being retried until the turn state changes',async()=>{
    const call=vi.spyOn(api.agent,'stopTurn').mockRejectedValue(new Error('timeout'));const descriptor=sessionAgent(session);
    await mount({...session,agent:{...descriptor,capabilities:{...descriptor.capabilities,stopTurn:true}}});
    act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:true,stage:'tools',turn_id:'active-turn',started_at:new Date().toISOString()}));
    fireEvent.click(await screen.findByRole('button',{name:'停止当前执行'}));expect(await screen.findByRole('alert')).toHaveTextContent('停止结果暂未确认');
    expect(screen.getByRole('button',{name:'正在停止当前执行'})).toBeDisabled();expect(call).toHaveBeenCalledTimes(1);
    act(()=>Socket.latest.emit({type:'snapshot',messages:[],busy:false,stage:'idle',turn_id:'active-turn'}));await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('creates the next numbered progress before text, streams tools there and replaces them with commentary',async()=>{
    await mount();
    const stamp=new Date(Date.now()-10000).toISOString();
    const prior=Array.from({length:4},(_,index)=>({id:`round-${index+1}`,role:'assistant',turn_id:'turn',phase:'commentary',text:`Finished ${index+1}`,timestamp:stamp}));
    const tool={id:'build',label:'运行命令 · npm run build',status:'running',started_at:stamp,completed_at:null,duration_ms:null,turn_id:'turn',after_message_id:'round-4'};
    const push=(messages:unknown[],activities:unknown[],stage='tools',busy=true)=>act(()=>Socket.latest.emit({type:'snapshot',messages,activities,busy,stage,turn_id:'turn',started_at:stamp}));
    push(prior,[tool]);
    const pending=await screen.findByRole('status',{name:'正在执行的进展 5'});
    expect(pending.closest('.session-chat-progress')).toHaveTextContent('5 items');
    expect(pending.querySelector('.session-chat-live-tool>summary')).toHaveTextContent('Run command · npm run build');
    expect(pending.querySelector('time')).toHaveAttribute('dateTime',stamp);expect(pending.querySelector('.session-chat-metadata-row')).toHaveTextContent('Input');
    expect(screen.getByTestId('conversation-activity-line')).not.toHaveTextContent('npm run build');
    expect(screen.getByTestId('conversation-activity-line')).not.toBeVisible();expect(screen.getByText('Event stream connected')).toBeVisible();
    push(prior,[{...tool,result_preview:'Compiling modules…'}]);expect(pending).toHaveTextContent('Compiling modules…');
    push(prior,[{...tool,status:'completed',result_preview:'Build succeeded',completed_at:stamp}]);expect(pending).toHaveTextContent('Build succeeded');expect(pending.querySelector('.session-chat-live-tool>summary')).toHaveTextContent('Waiting');
    expect(pending.querySelectorAll('.session-chat-live-tool')).toHaveLength(1);
    push(prior,[{...tool,status:'completed',result_preview:'Build succeeded'}, {...tool,id:'second',label:'运行命令 · npm test'}]);
    expect(pending.querySelector('.session-chat-live-tool>summary')).toHaveTextContent('npm test');expect(pending).not.toHaveTextContent('Build succeeded');
    push([...prior,{id:'round-5',role:'assistant',turn_id:'turn',phase:'commentary',text:'The build passed.',timestamp:stamp,streaming:true}],[tool],'answering');
    expect(await screen.findByText('The build passed.')).toBeVisible();expect(screen.queryByText('Build succeeded')).not.toBeInTheDocument();expect(screen.queryByRole('status',{name:'正在执行的进展 5'})).not.toBeInTheDocument();
    push([...prior,{id:'round-5',role:'assistant',turn_id:'turn',phase:'commentary',text:'The build passed.',timestamp:stamp,streaming:false}],[tool]);
    expect(screen.queryByRole('status',{name:'正在执行的进展 6'})).not.toBeInTheDocument();
    push([...prior,{id:'final',role:'assistant',turn_id:'turn',phase:'final',text:'All done',timestamp:stamp}],[],'idle',false);
    expect(screen.queryByRole('status',{name:/正在执行的进展/})).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-activity-line')).toBeVisible();
  });
  it('starts the first live progress without assistant text and excludes tools from a previous input or turn',async()=>{
    await mount();const stamp=new Date().toISOString();
    const prompt={id:'input',role:'user',turn_id:'turn',text:'Begin',timestamp:stamp};
    const tools=[{id:'old',label:'Old step',status:'running',started_at:stamp,turn_id:'turn',after_message_id:'previous'},
      {id:'foreign',label:'Foreign step',status:'running',started_at:stamp,turn_id:'other',after_message_id:'input'},
      {id:'current',label:'Current step',status:'running',started_at:stamp,turn_id:'turn',after_message_id:'input'}];
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prompt],activities:tools,busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
    const pending=await screen.findByRole('status',{name:'正在执行的进展 1'});expect(pending).toHaveTextContent('Current step');expect(pending).not.toHaveTextContent('Old step');expect(pending).not.toHaveTextContent('Foreign step');
    act(()=>Socket.latest.onclose?.());
    expect(screen.queryByText('Current step')).not.toBeInTheDocument();expect(screen.queryByRole('status',{name:'正在执行的进展 1'})).not.toBeInTheDocument();
  });
  it('renders a current-turn tool start immediately when the native event has no message anchor',async()=>{
    await mount();
    const inputAt=new Date(Date.now()-10000).toISOString();
    const prior={id:'prior-progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'Previous progress',timestamp:inputAt};
    const followup={id:'followup-pending',role:'user',turn_id:'turn',text:'Continue',timestamp:inputAt,queued:true};
    const tool={id:'current-tool',label:'Run command · npm test',status:'running',started_at:new Date().toISOString(),completed_at:null,duration_ms:null,turn_id:'turn',after_message_id:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,followup],activities:[tool],busy:true,stage:'tools',turn_id:'turn',started_at:inputAt}));
    const pending=screen.getByRole('status',{name:'正在执行的进展 2'});
    expect(pending.querySelector('.session-chat-live-tool>summary')).toHaveTextContent('npm test');
    expect(screen.getByText('Event stream connected')).toBeVisible();
  });
  it('does not carry an earlier unanchored activity past a newer accepted input',async()=>{
    await mount();
    const previousToolAt=new Date(Date.now()-20000).toISOString();
    const inputAt=new Date(Date.now()-10000).toISOString();
    const inputMessage={id:'current-input',role:'user',turn_id:'turn',text:'Continue',timestamp:inputAt};
    const previousTool={id:'previous-tool',label:'Run command · old task',status:'completed',started_at:previousToolAt,completed_at:inputAt,duration_ms:10000,turn_id:'turn',after_message_id:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[inputMessage],activities:[previousTool],busy:true,stage:'tools',turn_id:'turn',started_at:inputAt}));
    expect(screen.queryByRole('status',{name:/正在执行的进展/})).not.toBeInTheDocument();
    expect(screen.queryByText('old task')).not.toBeInTheDocument();
  });
  it('leaves consecutive inserted inputs adjacent until a native reply or tool is observed',async()=>{
    await mount();const prior={id:'before-followup',role:'assistant',turn_id:'turn',phase:'commentary',text:'Prior work',timestamp:new Date(Date.now()-20000).toISOString()};const followup={id:'followup',role:'user',turn_id:'turn',text:'Continue please',timestamp:new Date(Date.now()-10000).toISOString()};
    const second={...followup,id:'second',text:'Another insertion',timestamp:new Date(Date.now()-9000).toISOString()};
    const empty={...prior,id:'empty',text:'',streaming:true};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,followup,empty,second],busy:true,stage:'waiting',turn_id:'turn',started_at:new Date(Date.now()-20000).toISOString(),activities:[]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:12345},tool_calls:7,tool_rounds:5,complete:true}}));
    expect(screen.getByText('Another insertion')).toBeVisible();
    expect(screen.getAllByRole('region',{name:/进展$/})).toHaveLength(1);
    expect(screen.queryByRole('status',{name:/正在执行的进展/})).not.toBeInTheDocument();
    const oldPart={id:'old-segment',start_at:new Date(Date.now()-20000).toISOString(),end_at:followup.timestamp,elapsed_ms:10000,end_reason:'input',tokens:{total_tokens:1000},requests:1,tool_calls:3,tool_rounds:1,complete:true};
    const newPart={...oldPart,id:'new-segment',start_at:second.timestamp,end_at:null,elapsed_ms:null,end_reason:null,tokens:{total_tokens:200},tool_calls:1};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:10,message_id:prior.id,turn_id:'turn',...oldPart,segment:oldPart}]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:1200},requests:2,tool_calls:4,tool_rounds:2,complete:true,segment:newPart}}));
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,followup,empty,second],busy:true,stage:'tools',turn_id:'turn',
      activities:[{id:'tool',label:'Native-only tool',status:'running',turn_id:'turn',after_message_id:second.id}]}));
    const status=(await screen.findByRole('status',{name:'正在执行的进展 1'})).closest('.session-chat-progress')!.querySelector('summary')!;
    expect(status).toHaveTextContent('1 item');
    const statistics=status.querySelector('.session-chat-message-statistics')!;
    expect(statistics).toHaveTextContent('200 (—)｜—｜—｜—｜— · 1 round | 1 call');expect(statistics).not.toHaveTextContent('1.2K');
  });
  it('updates current tool counts before tokens, accepts authoritative step data without a complete prior snapshot, and patches late statistics',async()=>{
    await mount();const stamp=new Date(Date.now()-10000).toISOString();
    const prior={id:'prior-step',role:'assistant',phase:'commentary',turn_id:'turn',text:'Previous update',timestamp:stamp};
    const tool={id:'active-tool',label:'Run command · test',status:'running',started_at:stamp,turn_id:'turn',after_message_id:prior.id};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior],activities:[tool],busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
    const pending=await screen.findByRole('status',{name:'正在执行的进展 2'});expect(pending).toHaveTextContent('— rounds | ≥1 call');
    const segment={id:'live-segment',start_at:stamp,end_at:null,end_reason:null,elapsed_ms:null,tokens:{total_tokens:10000,input_tokens:9000,cached_input_tokens:8000,reasoning_output_tokens:100,output_tokens:1000},requests:2,tool_calls:4,tool_rounds:3,complete:false};
    const step={segment_id:segment.id,after_message_id:prior.id,after_sequence:null,start_at:stamp,tokens:{total_tokens:1100,input_tokens:1000,cached_input_tokens:900,reasoning_output_tokens:50,output_tokens:100},requests:1,tool_calls:2,tool_rounds:1,complete:true,shared_messages:1,cost:{unit:'USD',amount:3.21,complete:true}};
    const progress={turn_id:'turn',...segment,segment,step};
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress}));const pendingStatistics=pending.querySelector('.session-chat-message-statistics')!;expect(pendingStatistics).toHaveTextContent('1.1K ($3.21)｜100 (—)｜900 (— | 90%)｜50 (—)｜100 (—)');expect(pendingStatistics).toHaveTextContent('1 round | 2 calls');
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:prior.id,turn_id:'turn',tokens:{total_tokens:200},requests:1,tool_calls:1,tool_rounds:1,complete:true,interval:{tokens:{total_tokens:200},requests:1,tool_calls:1,tool_rounds:1,complete:true,shared_messages:1}}]}));
    expect(document.querySelector('[data-chat-message-id="prior-step"] .session-chat-message-statistics')).toHaveTextContent('200 (—)｜');expect(pendingStatistics).toHaveTextContent('1.1K ($3.21)｜');
    const current={id:'streamed-step',role:'assistant',phase:'commentary',turn_id:'turn',text:'Current streamed text',timestamp:stamp,streaming:true};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,current],activities:[tool],busy:true,stage:'answering',turn_id:'turn',started_at:stamp}));
    const bubble=document.querySelector('[data-chat-message-id="streamed-step"]')!;expect(bubble.querySelector('.session-chat-message-statistics')).toHaveTextContent('1.1K ($3.21)｜');expect(bubble.querySelector('time')).toBeNull();
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{...progress,step:{...step,after_message_id:'wrong-boundary',tokens:{total_tokens:999999}}}}));
    expect(bubble.querySelector('.session-chat-message-statistics')).not.toHaveTextContent('1M');
  });
  it.each(['account:fixture','provider:fixture'])('updates the running Item and the whole Progress in %s',async(environment)=>{
    await mount({...session,agent_environment_id:environment});
    const stamp=new Date(Date.now()-5000).toISOString();
    const cost=environment.startsWith('account:')?{unit:'USD',basis:'public_usd_reference',amount:0.04,complete:true}:null;
    const counters=(total_tokens:number,requests:number,tool_calls:number)=>({tokens:{total_tokens},requests,tool_calls,tool_rounds:requests,complete:true,cost});
    const scope=(id:string,total_tokens:number,requests:number,tool_calls:number)=>({...counters(total_tokens,requests,tool_calls),id,start_at:stamp,end_at:null,elapsed_ms:null,end_reason:null});
    const first=scope('earlier',1000,1,1),second=scope('current',1700,2,2);
    const messages=Array.from({length:3},(_,index)=>({id:`item-${index}`,role:'assistant',phase:'commentary',turn_id:'turn',text:`Progress ${index}`,timestamp:stamp}));
    const emit=(frame:unknown)=>act(()=>Socket.latest.emit(frame));
    emit({type:'snapshot',messages,activities:[{id:'command',label:'Run command · npm test',status:'running',turn_id:'turn',after_message_id:'item-2'}],busy:true,stage:'tools',turn_id:'turn',started_at:stamp});
    emit({type:'statistics',native_id:'native',statistics:messages.map((message,index)=>({sequence:index+1,revision:1,message_id:message.id,turn_id:'turn',progress_id:index<2?first.id:second.id,segment:index<2?first:scope(second.id,1200,1,1)}))});
    const pending=await screen.findByRole('status',{name:'正在执行的进展 4'});
    emit({type:'usage',native_id:'native',observed_at:new Date().toISOString(),usage:{total:{total_tokens:2700},last:{total_tokens:500,input_tokens:400,cached_input_tokens:300,output_tokens:100},window:40000}});
    expect(await within(pending).findByText(/Latest request · 500 tokens/)).toBeVisible();
    emit({type:'progress_statistics',native_id:'native',progress:{...second,turn_id:'turn',revision:2,segment:second,
      step:{...counters(500,1,1),shared_messages:1,segment_id:second.id,after_message_id:'item-2',after_sequence:3,start_at:stamp}}});
    expect(pending.querySelector('.session-chat-metadata-row')).toHaveTextContent(/500.*1 round \| 1 call/);
    const header=pending.closest('.session-chat-progress')!.querySelector('summary')!;
    expect(header).toHaveTextContent('4 items');
    expect(header.querySelector('.session-chat-message-statistics')).toHaveAttribute('title',expect.stringContaining('Total 2,700;'));
    expect(header).toHaveTextContent('3 rounds | 3 calls');
    expect(header.textContent?.includes('Est. $')).toBe(cost!==null);
    expect(pending).toHaveTextContent('npm test');
  });
  it('updates the active progress total without mixing other native sessions',async()=>{
    await mount();const item={id:'progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'working',timestamp:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'运行命令 · test',status:'completed',duration_ms:40000,started_at:null,completed_at:null}]}));await screen.findByText('working');
    const header=screen.getByText('progress').closest('summary')!;expect(within(header).getByText('Step 40s')).toHaveAttribute('title','Duration of the most recently completed tool step');expect(within(header).getByText(/^Elapsed /)).toHaveAttribute('title','Elapsed time for this progress segment');expect(within(screen.getByTestId('conversation-activity-line')).queryByText(/^Turn /)).not.toBeInTheDocument();
    expect(header).toHaveTextContent('unknown: —');
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'running',started_at:new Date(Date.now()-35000).toISOString(),completed_at:null,duration_ms:null}]}));
    expect(header).toHaveTextContent(/calling: 3[45]s/);expect(header).not.toHaveTextContent('test');
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'completed',started_at:new Date(Date.now()-35000).toISOString(),completed_at:new Date(Date.now()-5000).toISOString(),duration_ms:30000}]}));
    expect(header).toHaveTextContent(/waiting: [45]s/);
    const segment={id:'segment-one',start_at:new Date(Date.now()-120000).toISOString(),end_at:null,elapsed_ms:null,end_reason:null,tokens:{total_tokens:392100},requests:1,tool_calls:2,tool_rounds:2,complete:true};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:item.id,turn_id:'turn',tokens:{total_tokens:392100},requests:1,tool_calls:2,tool_rounds:2,complete:true,segment}]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'other',progress:{turn_id:'turn',tokens:{total_tokens:999},tool_calls:9,tool_rounds:9,complete:true}}));expect(screen.queryByText(/token: 999/)).not.toBeInTheDocument();
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'another-turn',tokens:{total_tokens:999},tool_calls:9,tool_rounds:9,complete:true,segment:{...segment,tokens:{total_tokens:999}}}}));expect(header.querySelector('.session-chat-message-statistics')).toHaveTextContent('392.1K (—)｜');expect(header).not.toHaveTextContent('999');
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:400000},tool_calls:3,tool_rounds:2,complete:true,segment:{...segment,tokens:{total_tokens:400000},tool_calls:3}}}));await waitFor(()=>expect(header.querySelector('.session-chat-message-statistics')).toHaveTextContent('400K (—)｜—｜—｜—｜— · 1 round | 3 calls'));
    const ended={...segment,end_at:new Date().toISOString(),elapsed_ms:120000,end_reason:'interrupted',tokens:{total_tokens:400000},tool_calls:3};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:item.id,turn_id:'turn',tokens:{total_tokens:400000},requests:1,tool_calls:3,tool_rounds:2,complete:true,segment:ended}]}));
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:false,stage:'idle',turn_id:'turn'}));
    expect(header.querySelector('.session-chat-message-statistics')).toHaveTextContent('400K (—)｜—｜—｜—｜— · 1 round | 3 calls');expect(header).toHaveTextContent('Elapsed 2m 0s');expect(header).toHaveTextContent('Interrupted');expect(header).not.toHaveTextContent('waiting:');
  });
  it('reconciles an executing Item and its Progress before and after the Item settles',async()=>{
    await mount();
    const timestamp=new Date(Date.now()-10000).toISOString();
    const usage=(tokens:number,requests:number,calls:number,amount:number)=>({
      tokens:{total_tokens:tokens},requests,tool_calls:calls,tool_rounds:calls,complete:true,coverage:'complete' as const,
      shared_messages:1,cost:{unit:'USD',amount,complete:true},
    });
    const itemUsage=usage(2900000,7,6,10.532),workUsage=usage(1400000,3,4,3.498);
    const timing={start_at:timestamp,end_at:null,end_reason:null,elapsed_ms:null};
    const old={id:'before',role:'assistant',phase:'commentary',turn_id:'turn',text:'Before the insert',timestamp,
      statistics:{...usage(3800000,9,9,12.733),sequence:1,turn_id:'turn',progress_id:'old',
        interval:usage(3800000,9,9,12.733),segment:{...usage(3800000,9,9,12.733),...timing,id:'old'}}};
    const user={id:'insert',role:'user',text:'Accepted insertion',turn_id:'turn',timestamp};
    const item={id:'local-first',role:'assistant',phase:'commentary',turn_id:'turn',text:'First local Item',timestamp,
      statistics:{...itemUsage,sequence:3,revision:1,turn_id:'turn',progress_id:'local',interval:itemUsage,
        segment:{...itemUsage,...timing,id:'local'}}};
    const activity={id:'tool',label:'Native tool',status:'running',turn_id:'turn',after_message_id:item.id};
    const send=(frame:unknown)=>act(()=>Socket.latest.emit(frame));
    send({type:'snapshot',messages:[old,user,item],activities:[activity],busy:true,stage:'tools',turn_id:'turn'});
    const total={...usage(4300000,10,10,14.03),...timing,id:'local'};
    send({type:'progress_statistics',native_id:'native',progress:{...total,revision:2,turn_id:'turn',
      segment:{...total,unassigned:workUsage},
      step:{...workUsage,segment_id:total.id,after_message_id:item.id,after_sequence:3,start_at:timestamp}}});
    const group=screen.getByText(item.text).closest('.session-chat-progress')!;
    const heading=group.querySelector('summary .session-chat-message-statistics')!;
    expect(heading).toHaveAttribute('title',expect.stringContaining('Total 4,300,000;'));
    expect(heading).toHaveTextContent('4.3M ($14.03)');
    expect(heading).toHaveTextContent('10 rounds | 10 calls');
    expect(group.querySelector('[data-chat-message-id="local-first"] .session-chat-message-statistics')).toHaveTextContent('2.9M ($10.53)');
    expect(within(group as HTMLElement).getByRole('status',{name:'正在执行的进展 2'})).toHaveTextContent('1.4M ($3.50)');
    const settled={id:'local-next',role:'assistant',phase:'commentary',turn_id:'turn',text:'Second local Item',timestamp,
      statistics:{...workUsage,sequence:4,revision:3,turn_id:'turn',progress_id:'local',interval:workUsage,segment:total}};
    send({type:'snapshot',messages:[old,user,item,settled],activities:[],busy:true,stage:'waiting',turn_id:'turn'});
    expect(heading).toHaveTextContent('4.3M ($14.03)');
    expect(group.querySelectorAll('.session-chat-progress-entry')).toHaveLength(2);
    expect(screen.queryByRole('status',{name:'正在执行的进展 2'})).not.toBeInTheDocument();
    expect(group.querySelector('[data-chat-message-id="local-next"] .session-chat-message-statistics')).toHaveTextContent('1.4M ($3.50)');
  });
  it('restores completed progress totals and duration from recorded conclusion statistics',async()=>{
    const existing=await api.agent.conversation(session.id),item={id:'historical-progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'Earlier work',timestamp:'2026-01-01T00:00:05Z'},final={id:'historical-final',role:'assistant',turn_id:'turn',phase:'final',text:'Complete',timestamp:'2026-01-01T00:01:00Z'};
    const total={id:'historical-segment',end_reason:'completed',tokens:{total_tokens:97400},requests:2,tool_calls:4,tool_rounds:3,complete:true,shared_messages:1,start_at:'2026-01-01T00:00:00Z',end_at:final.timestamp,elapsed_ms:60000};
    vi.mocked(api.agent.conversation).mockResolvedValue({...existing,messages:[item,final],statistics:[{sequence:1,message_id:final.id,turn_id:'turn',...total,conclusion:total,segment:total}]} as unknown as ConversationPage);
    await mount();const header=(await screen.findByText('progress')).closest('summary')!;
    expect(header.querySelector('.session-chat-message-statistics')).toHaveTextContent('97.4K (—)｜—｜—｜—｜— · 2 rounds | 4 calls');expect(header).toHaveTextContent('Elapsed 1m 0s');expect(header).toHaveTextContent('Completed');expect(header).not.toHaveTextContent('calling:');
  });
  it('does not mark a progress segment completed just because an async question follows it',async()=>{
    const existing=await api.agent.conversation(session.id);
    vi.mocked(api.agent.conversation).mockResolvedValue({...existing,messages:[{id:'progress-before-question',role:'assistant',turn_id:'turn',phase:'commentary',text:'Working',timestamp:null},{id:'question-after-progress',role:'assistant',turn_id:'turn',phase:'final',text:'Choose',timestamp:null,async_questions:[{id:'q',title:'Choose',options:['A','B']}]}]} as unknown as ConversationPage);
    await mount();expect((await screen.findByText('progress')).closest('summary')).not.toHaveTextContent('Completed');
  });
  it('keeps follow-up segments separate when history is restored and the native turn is the same',async()=>{
    const existing=await api.agent.conversation(session.id);
    const first={id:'first-segment',role:'assistant',turn_id:'turn',phase:'commentary',text:'First progress',timestamp:'2026-01-01T00:00:05Z'};
    const followup={id:'followup-boundary',role:'user',turn_id:'turn',text:'Continue',timestamp:'2026-01-01T00:00:10Z'};
    const second={id:'second-segment',role:'assistant',turn_id:'turn',phase:'commentary',text:'Second progress',timestamp:'2026-01-01T00:00:15Z'};
    const firstPart={id:'seg-a',start_at:'2026-01-01T00:00:00Z',end_at:'2026-01-01T00:00:10Z',elapsed_ms:10000,end_reason:'input',tokens:{total_tokens:1000},requests:1,tool_calls:2,tool_rounds:1,complete:true};
    const secondPart={...firstPart,id:'seg-b',start_at:followup.timestamp,end_at:'2026-01-01T00:00:20Z',elapsed_ms:10000,end_reason:'interrupted',tokens:{total_tokens:300},tool_calls:1};
    const stats=[{sequence:1,message_id:first.id,turn_id:'turn',...firstPart,segment:firstPart},{sequence:2,message_id:second.id,turn_id:'turn',...secondPart,segment:secondPart}];
    vi.mocked(api.agent.conversation).mockResolvedValue({...existing,messages:[first,followup,second],statistics:stats} as unknown as ConversationPage);
    await mount();const headers=(await screen.findAllByText('progress')).map(node=>node.closest('summary')!);
    expect(headers[0].querySelector('.session-chat-message-statistics')).toHaveTextContent('1K (—)｜—｜—｜—｜— · 1 round | 2 calls');expect(headers[0]).toHaveTextContent('Elapsed 10s');
    expect(headers[1].querySelector('.session-chat-message-statistics')).toHaveTextContent('300 (—)｜—｜—｜—｜— · 1 round | 1 call');expect(headers[1]).toHaveTextContent('Interrupted');expect(headers[1]).not.toHaveTextContent('1K');
  });
  it('reloads the baseline instead of dropping older messages when another reader replaced the history generation',async()=>{
    const original=await api.agent.conversation(session.id);
    const old={id:'old',role:'user' as const,text:'保留之前的消息',timestamp:null};
    const latest={id:'new',role:'assistant' as const,text:'新消息正文',timestamp:null,phase:'final' as const,streaming:false};
    const read=vi.mocked(api.agent.conversation);read.mockResolvedValueOnce({...original,messages:[old]});await mount();
    expect(await screen.findByText(old.text)).toBeVisible();
    read.mockResolvedValueOnce({...original,generation:'replaced',messages:[latest],reset:false})
      .mockResolvedValue({...original,generation:'replaced',messages:[old,latest],reset:false});
    act(()=>Socket.latest.emit({type:'snapshot',messages:[latest],busy:false,stage:'idle'}));
    expect(await screen.findByText(latest.text)).toBeVisible();
    await waitFor(()=>expect(read.mock.calls.slice(-1)[0][1]).toEqual({}));
    expect(screen.getByText(old.text)).toBeVisible();
    expect(document.querySelectorAll('[data-chat-message-id]')).toHaveLength(2);
  });
  it('does not rerender completed message metadata when only the current answer changes',async()=>{
    const title=vi.spyOn(metadata,'metadataTimestampTitle');await mount();
    const old={id:'old-answer',role:'assistant',turn_id:'previous',phase:'final',text:'已完成的结论',timestamp:'2026-11-05T01:00:00Z',streaming:false};
    const live={id:'live-answer',role:'assistant',turn_id:'current',phase:'commentary',text:'当前正文',timestamp:null,streaming:true};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[old,live],busy:true,stage:'answering',turn_id:'current'}));await screen.findByText('当前正文');
    const before=title.mock.calls.filter(([message])=>message.id===old.id).length;expect(before).toBeGreaterThan(0);
    act(()=>Socket.latest.emit({type:'patch',upserts:[],deltas:[{id:live.id,offset:4,text:'继续输出'}]}));
    await screen.findByText('当前正文继续输出');expect(title.mock.calls.filter(([message])=>message.id===old.id)).toHaveLength(before);
  });
  it('recovers stale and half-open streams on browser resume without losing drafts or resending input',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    const editor=input('未发送的草稿'),first=Socket.latest;first.readyState=0;
    act(()=>window.dispatchEvent(new Event('online')));
    expect(Socket.latest).not.toBe(first);const second=Socket.latest;
    act(()=>second.emit({type:'snapshot',stream_id:'shared',stream_seq:1,messages:[],busy:false,stage:'idle'}));
    // Old sockets may finish their close handshake much later. Their events
    // cannot overwrite the replacement's state or restore stale messages.
    act(()=>first.emit({type:'snapshot',messages:[{id:'stale',role:'assistant',text:'stale text'}],busy:false,stage:'idle'}));
    expect(screen.queryByText('stale text')).not.toBeInTheDocument();
    const now=performance.now();vi.spyOn(performance,'now').mockReturnValue(now+61000);vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
    act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(Socket.latest).not.toBe(second);
    expect(editor).toHaveTextContent('未发送的草稿');expect(submit).not.toHaveBeenCalled();
  });
  it('clears stale streaming indicators on disconnect and restores live streaming after reconnect',async()=>{
    await mount();const first=Socket.latest;
    const item={id:'partial',role:'assistant',text:'部分输出',phase:'commentary',streaming:true,turn_id:'turn'};
    act(()=>first.emit({type:'snapshot',messages:[item],busy:true,stage:'answering'}));
    await waitFor(()=>expect(screen.getByText('Streaming')).toBeInTheDocument());
    act(()=>first.emit({type:'unavailable',reason:'断线',retrying:true}));
    await waitFor(()=>expect(screen.queryByText('Streaming')).not.toBeInTheDocument());expect(screen.getByText('部分输出')).toBeInTheDocument();
    act(()=>first.emit({type:'snapshot',messages:[{...item,text:'部分输出继续'}],busy:true,stage:'answering'}));
    await waitFor(()=>expect(screen.getByText('Streaming')).toBeInTheDocument());expect(screen.getByText('部分输出继续')).toBeInTheDocument();
  });
  it('does not show waiting or a stop control after a final reply arrives before a stale busy frame',async()=>{
    await mount();
    const stamp=new Date(Date.now()-4000).toISOString();
    const user={id:'user',role:'user',text:'Hi',timestamp:stamp};
    const final={id:'final',role:'assistant',turn_id:'turn',phase:'final',text:'Done',timestamp:new Date().toISOString(),streaming:false};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[user,final],busy:false,stage:'idle',turn_id:'turn'}));
    expect(await screen.findByText('Done')).toBeVisible();
    act(()=>Socket.latest.emit({type:'snapshot',messages:[user,final],busy:true,stage:'waiting',turn_id:'different-native-turn',started_at:stamp}));
    await waitFor(()=>expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button',{name:'停止当前执行'})).not.toBeInTheDocument();
    expect(screen.queryByText(/In progress/)).not.toBeInTheDocument();
  });
  it('resynchronizes a missing delta sequence immediately without replaying a submitted message',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();const first=Socket.latest;
    act(()=>first.emit({type:'snapshot',stream_id:'shared',stream_seq:1,messages:[],busy:false,stage:'idle'}));
    act(()=>first.emit({type:'patch',stream_id:'shared',stream_seq:3,upserts:[],deltas:[{id:'missing',offset:5,text:'tail'}]}));
    expect(Socket.latest).not.toBe(first);expect(submit).not.toHaveBeenCalled();
  });
  it('keeps dialogue usable while disabling unsupported attachment operations for another provider',async()=>{
    const descriptor=sessionAgent(session),target={...session,cli_type:'remote',agent_id:'remote',native_session_id:'native',agent:{...descriptor,id:'remote',label:'Remote',capabilities:{...descriptor.capabilities,attachments:false}}};
    const upload=vi.spyOn(api.sessions,'pasteFile').mockResolvedValue({path:'/project/note.txt'});await mount(target);
    expect(screen.getByRole('button',{name:'上传图片或文件'})).toBeDisabled();expect(screen.getByRole('button',{name:'上传目录'})).toBeDisabled();
    const editor=input('仍然可以输入文字');fireEvent.paste(editor,{clipboardData:{files:[new File(['note'],'note.txt')],getData:()=>''}});
    expect(await screen.findByRole('alert')).toHaveTextContent('此 Agent 不支持附件');expect(upload).not.toHaveBeenCalled();expect(editor.textContent).toBe('仍然可以输入文字');
  });
  it('clears the composer before a delayed HTTP acknowledgement, without clearing a newer draft', async () => {
    const send = deferred<SendResult>(); vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise);
    await mount();
    const editor = input('立即发送'); fireEvent.click(screen.getByRole('button', { name: '发送消息', exact: true }));
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledOnce());
    expect(editor.textContent).toBe('');
    input('下一条草稿');
    await act(async () => send.resolve({ status: 'submitted' } as SendResult));
    expect(editor).toHaveTextContent('下一条草稿');
  });
  it('does not erase a new draft that happens to match the submitted text', async () => {
    const send = deferred<SendResult>(); vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('相同文字'); fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledOnce());expect(editor.textContent).toBe(''); input('相同文字');
    await act(async () => send.resolve({ status: 'queued' } as SendResult));
    expect(editor).toHaveTextContent('相同文字');
  });
  it('restores a rejected draft and reuses its submission identity for an intentional retry', async () => {
    const send = deferred<SendResult>(); const submit = vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('保留失败内容'); fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    const clientId = submit.mock.calls[0][2]; expect(editor.textContent).toBe('');
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor).toHaveTextContent('保留失败内容'); expect(screen.getByRole('alert')).toHaveTextContent('消息未受理');
    submit.mockResolvedValue({ status: 'submitted' } as SendResult);
    await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }));
    expect(submit.mock.calls[1][2]).toBe(clientId); expect(editor.textContent).toBe('');
  });
  it('keeps a newer draft and exposes the failed one for explicit recovery', async () => {
    const send = deferred<SendResult>(); vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('发送失败的原文'); fireEvent.keyDown(editor, { key: 'Enter' }); await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledOnce());input('等待时写的新内容');
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor).toHaveTextContent('等待时写的新内容'); expect(screen.getByRole('button', { name: '恢复未发送内容' })).toBeDisabled();
    input(''); fireEvent.click(screen.getByRole('button', { name: '恢复未发送内容' }));
    expect(editor).toHaveTextContent('发送失败的原文'); expect(screen.queryByRole('button', { name: '恢复未发送内容' })).not.toBeInTheDocument();
  });
  it('does not restore or duplicate a message confirmed by the native echo when HTTP later fails', async () => {
    const send = deferred<SendResult>(); const submit = vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('原生已受理'); fireEvent.keyDown(editor, { key: 'Enter' });await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    act(() => Socket.latest.emit({ type: 'snapshot', messages: [{ id: 'native-echo', client_id: submit.mock.calls[0][2], role: 'user', text: '原生已受理', timestamp: new Date().toISOString() }], busy: true, stage: 'waiting' }));
    await waitFor(() => expect(document.querySelector('[data-chat-message-id="native-echo"]')).toBeInTheDocument());
    await act(async () => send.reject(new ApiError('响应超时', 503, 'unknown')));
    expect(editor.textContent).toBe(''); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.session-chat-message.user')).toHaveLength(1);
  });
  it('clears an uncertain delivery warning when the native receipt arrives later without resending',async()=>{
    const send=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(send.promise);await mount();const editor=input('等待回执');fireEvent.keyDown(editor,{key:'Enter'});
    await act(async()=>send.reject(new ApiError('发送结果待确认',503,'unknown')));expect(screen.getByRole('alert')).toHaveTextContent('发送结果待确认');
    act(()=>Socket.latest.emit({type:'snapshot',messages:[{id:'late-native',client_id:submit.mock.calls[0][2],role:'user',text:'等待回执'}],busy:true,stage:'tools'}));
    await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());expect(submit).toHaveBeenCalledOnce();expect(editor).toHaveTextContent('等待回执');
  });
  it('clears attachments immediately and restores their original inline positions without reuploading', async () => {
    const send = deferred<SendResult>(); const submit = vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise);
    const upload = vi.spyOn(api.sessions, 'pasteFile').mockResolvedValue({ path: '/project/note.txt' }); await mount();
    const editor = input('前文后文'), range = document.createRange(); range.setStart(editor.firstChild!, 2); range.collapse(true);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent.mouseUp(editor);
    fireEvent.change(screen.getByLabelText('选择对话附件'), { target: { files: [new File(['note'], 'note.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(editor.querySelector('[data-status="ready"]')).toBeTruthy());
    expect(editor.textContent?.replaceAll('\u200b', '')).toBe('前文文件 1后文');
    fireEvent.click(screen.getByRole('button', { name: '发送消息', exact: true }));
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());expect(editor.textContent).toBe(''); expect(submit.mock.calls[0][3]?.[0]).toMatchObject({ path: '/project/note.txt', offset: 2 });
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor.textContent?.replaceAll('\u200b', '')).toBe('前文文件 1后文'); expect(upload).toHaveBeenCalledOnce();
  });
});
