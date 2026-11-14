import {composerKey,loadComposer,saveComposer,emptyComposer} from '../src/lib/batch-composer';
import {sessionAgent} from '../src/lib/agents';
import { act, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type ConversationPage, type Session } from '../src/lib/api';
import { SessionConversation } from '../src/components/SessionConversation';
import * as metadata from '../src/components/ConversationStatisticsLabel';

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
async function mount(target:Session=session) {
  Socket.latest=undefined as unknown as Socket;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view=render(<QueryClientProvider client={client}><SessionConversation session={target} active onRaw={() => {}} /></QueryClientProvider>);
  await waitFor(() => expect(Socket.latest?.onmessage).toBeTruthy());
  act(() => Socket.latest.emit({ type: 'snapshot', messages: [], busy: false, stage: 'idle' }));
  await waitFor(() => expect(screen.getByText('Event stream connected')).toBeInTheDocument());
  return view;
}
beforeEach(() => {
  localStorage.clear();
  Socket.latest = undefined as unknown as Socket;
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(api.agent, 'conversation').mockResolvedValue({ messages: [], statistics: [], has_more: false, reset: false, available: true, generation: 'generation', native_id: 'native', session_active: true, session_status: 'running', runtime: { state: 'idle' }, interaction: null } as unknown as ConversationPage);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('conversation send transaction', () => {
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
    await waitFor(()=>expect(submit).toHaveBeenCalledOnce());await waitFor(()=>expect(screen.getByRole('button',{name:'发送批量内容'})).toBeDisabled());
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
  it('sends staged content with Ctrl+Enter and opens a centered batch detail dialog',async()=>{
    const submit=vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'} as SendResult);await mount();
    fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});
    input('one');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('two');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));
    const editor=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true,isComposing:true});expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][4]).toEqual([{length:3,attachments:0},{length:3,attachments:0}]);
    const sentAt='2026-11-14T06:00:00Z';act(()=>Socket.latest.emit({type:'snapshot',messages:[{id:'sent-batch',client_id:submit.mock.calls[0][2],role:'user',text:'one\n\ntwo',timestamp:sentAt}],busy:false,stage:'idle'}));
    fireEvent.click(screen.getByRole('button',{name:/批量消息/}));
    const dialog=screen.getByRole('dialog',{name:'批量消息 · 2 条'});expect(within(dialog).getByLabelText('第 1 条消息')).toHaveTextContent('one');expect(within(dialog).getByLabelText('第 2 条消息')).toHaveTextContent('two');
    expect([...dialog.querySelectorAll('time')].map(t=>t.dateTime)).toEqual([sentAt,sentAt]);
    fireEvent.keyDown(dialog,{key:'Escape'});expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
  it('shows the shared progress summary while continuing after a follow-up',async()=>{
    await mount();const prior={id:'before-followup',role:'assistant',turn_id:'turn',phase:'commentary',text:'Prior work',timestamp:new Date(Date.now()-20000).toISOString()};const followup={id:'followup',role:'user',turn_id:'turn',text:'Continue please',timestamp:new Date(Date.now()-10000).toISOString()};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,followup],busy:true,stage:'waiting',turn_id:'turn',started_at:new Date(Date.now()-20000).toISOString(),activities:[]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:12345},tool_calls:7,tool_rounds:5,complete:true}}));
    const status=(await screen.findByText('0 items')).closest('[role=status]')!;expect(status).toHaveTextContent('0 items');expect(status).toHaveTextContent('segment · token: — · tools: —');expect(status).not.toHaveTextContent('12.3K');expect(status).toHaveTextContent('In progress');expect(status).not.toHaveTextContent('Follow-up sent');
    const oldPart={id:'old-segment',start_at:new Date(Date.now()-20000).toISOString(),end_at:followup.timestamp,elapsed_ms:10000,end_reason:'input',tokens:{total_tokens:1000},requests:1,tool_calls:3,tool_rounds:1,complete:true};
    const newPart={...oldPart,id:'new-segment',start_at:followup.timestamp,end_at:null,elapsed_ms:null,end_reason:null,tokens:{total_tokens:200},tool_calls:1};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:10,message_id:prior.id,turn_id:'turn',...oldPart,segment:oldPart}]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:1200},requests:2,tool_calls:4,tool_rounds:2,complete:true,segment:newPart}}));
    expect(status).toHaveTextContent('segment · token: 200 · tools: 1 call');expect(status).not.toHaveTextContent('1.2K');
  });
  it('updates the active progress total without mixing other native sessions',async()=>{
    await mount();const item={id:'progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'working',timestamp:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'运行命令 · test',status:'completed',duration_ms:40000,started_at:null,completed_at:null}]}));await screen.findByText('working');
    const header=screen.getByText('progress').closest('summary')!;expect(within(header).getByText('Step 40s')).toHaveAttribute('title','Duration of the most recently completed tool step');expect(within(header).getByText(/^Elapsed /)).toHaveAttribute('title','Elapsed time for this progress segment');expect(within(screen.getByTestId('conversation-activity-line')).queryByText(/^Turn /)).not.toBeInTheDocument();
    expect(header).toHaveTextContent('unknown: —');
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'running',started_at:new Date(Date.now()-35000).toISOString(),completed_at:null,duration_ms:null}]}));
    expect(header).toHaveTextContent(/calling \(test\): 3[45]s/);
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'completed',started_at:new Date(Date.now()-35000).toISOString(),completed_at:new Date(Date.now()-5000).toISOString(),duration_ms:30000}]}));
    expect(header).toHaveTextContent(/waiting: [45]s/);
    const segment={id:'segment-one',start_at:new Date(Date.now()-120000).toISOString(),end_at:null,elapsed_ms:null,end_reason:null,tokens:{total_tokens:392100},requests:1,tool_calls:2,tool_rounds:2,complete:true};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:item.id,turn_id:'turn',tokens:{total_tokens:392100},requests:1,tool_calls:2,tool_rounds:2,complete:true,segment}]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'other',progress:{turn_id:'turn',tokens:{total_tokens:999},tool_calls:9,tool_rounds:9,complete:true}}));expect(screen.queryByText(/token: 999/)).not.toBeInTheDocument();
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'another-turn',tokens:{total_tokens:999},tool_calls:9,tool_rounds:9,complete:true,segment:{...segment,tokens:{total_tokens:999}}}}));expect(header).toHaveTextContent('segment · token: 392.1K');expect(header).not.toHaveTextContent('token: 999');
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:400000},tool_calls:3,tool_rounds:2,complete:true,segment:{...segment,tokens:{total_tokens:400000},tool_calls:3}}}));expect(await screen.findByText('segment · token: 400K · tools: 3 calls ｜ 2 rounds')).toBeVisible();
    const ended={...segment,end_at:new Date().toISOString(),elapsed_ms:120000,end_reason:'interrupted',tokens:{total_tokens:400000},tool_calls:3};
    act(()=>Socket.latest.emit({type:'statistics',native_id:'native',statistics:[{sequence:1,message_id:item.id,turn_id:'turn',tokens:{total_tokens:400000},requests:1,tool_calls:3,tool_rounds:2,complete:true,segment:ended}]}));
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:false,stage:'idle',turn_id:'turn'}));
    expect(header).toHaveTextContent('segment · token: 400K · tools: 3 calls ｜ 2 rounds');expect(header).toHaveTextContent('Elapsed 2m 0s');expect(header).toHaveTextContent('Interrupted');expect(header).not.toHaveTextContent('waiting:');
  });
  it('restores completed progress totals and duration from recorded conclusion statistics',async()=>{
    const existing=await api.agent.conversation(session.id),item={id:'historical-progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'Earlier work',timestamp:'2026-01-01T00:00:05Z'},final={id:'historical-final',role:'assistant',turn_id:'turn',phase:'final',text:'Complete',timestamp:'2026-01-01T00:01:00Z'};
    const total={id:'historical-segment',end_reason:'completed',tokens:{total_tokens:97400},requests:2,tool_calls:4,tool_rounds:3,complete:true,shared_messages:1,start_at:'2026-01-01T00:00:00Z',end_at:final.timestamp,elapsed_ms:60000};
    vi.mocked(api.agent.conversation).mockResolvedValue({...existing,messages:[item,final],statistics:[{sequence:1,message_id:final.id,turn_id:'turn',...total,conclusion:total,segment:total}]} as unknown as ConversationPage);
    await mount();const header=(await screen.findByText('progress')).closest('summary')!;
    expect(header).toHaveTextContent('segment · token: 97.4K · tools: 4 calls ｜ 3 rounds');expect(header).toHaveTextContent('Elapsed 1m 0s');expect(header).toHaveTextContent('Completed');expect(header).not.toHaveTextContent('calling:');
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
    expect(headers[0]).toHaveTextContent('segment · token: 1K · tools: 2 calls');expect(headers[0]).toHaveTextContent('Elapsed 10s');
    expect(headers[1]).toHaveTextContent('segment · token: 300 · tools: 1 call');expect(headers[1]).toHaveTextContent('Interrupted');expect(headers[1]).not.toHaveTextContent('1K');
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
    expect(api.agent.sendInput).toHaveBeenCalledOnce();
    expect(editor.textContent).toBe('');
    input('下一条草稿');
    await act(async () => send.resolve({ status: 'submitted' } as SendResult));
    expect(editor).toHaveTextContent('下一条草稿');
  });
  it('does not erase a new draft that happens to match the submitted text', async () => {
    const send = deferred<SendResult>(); vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('相同文字'); fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.textContent).toBe(''); input('相同文字');
    await act(async () => send.resolve({ status: 'queued' } as SendResult));
    expect(editor).toHaveTextContent('相同文字');
  });
  it('restores a rejected draft and reuses its submission identity for an intentional retry', async () => {
    const send = deferred<SendResult>(); const submit = vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('保留失败内容'); fireEvent.keyDown(editor, { key: 'Enter' });
    const clientId = submit.mock.calls[0][2]; expect(editor.textContent).toBe('');
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor).toHaveTextContent('保留失败内容'); expect(screen.getByRole('alert')).toHaveTextContent('消息未受理');
    submit.mockResolvedValue({ status: 'submitted' } as SendResult);
    await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }));
    expect(submit.mock.calls[1][2]).toBe(clientId); expect(editor.textContent).toBe('');
  });
  it('keeps a newer draft and exposes the failed one for explicit recovery', async () => {
    const send = deferred<SendResult>(); vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('发送失败的原文'); fireEvent.keyDown(editor, { key: 'Enter' }); input('等待时写的新内容');
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor).toHaveTextContent('等待时写的新内容'); expect(screen.getByRole('button', { name: '恢复未发送内容' })).toBeDisabled();
    input(''); fireEvent.click(screen.getByRole('button', { name: '恢复未发送内容' }));
    expect(editor).toHaveTextContent('发送失败的原文'); expect(screen.queryByRole('button', { name: '恢复未发送内容' })).not.toBeInTheDocument();
  });
  it('does not restore or duplicate a message confirmed by the native echo when HTTP later fails', async () => {
    const send = deferred<SendResult>(); const submit = vi.spyOn(api.agent, 'sendInput').mockReturnValue(send.promise); await mount();
    const editor = input('原生已受理'); fireEvent.keyDown(editor, { key: 'Enter' });
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
    expect(editor.textContent).toBe(''); expect(submit.mock.calls[0][3]?.[0]).toMatchObject({ path: '/project/note.txt', offset: 2 });
    await act(async () => send.reject(new ApiError('消息未受理', 409, 'rejected')));
    expect(editor.textContent?.replaceAll('\u200b', '')).toBe('前文文件 1后文'); expect(upload).toHaveBeenCalledOnce();
  });
});
