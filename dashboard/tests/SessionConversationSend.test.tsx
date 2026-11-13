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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><SessionConversation session={target} active onRaw={() => {}} /></QueryClientProvider>);
  await waitFor(() => expect(Socket.latest?.onmessage).toBeTruthy());
  act(() => Socket.latest.emit({ type: 'snapshot', messages: [], busy: false, stage: 'idle' }));
  await waitFor(() => expect(screen.getByText('Event stream connected')).toBeInTheDocument());
}
beforeEach(() => {
  Socket.latest = undefined as unknown as Socket;
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(api.agent, 'conversation').mockResolvedValue({ messages: [], statistics: [], has_more: false, reset: false, available: true, generation: 'generation', native_id: 'native', session_active: true, session_status: 'running', runtime: { state: 'idle' }, interaction: null } as unknown as ConversationPage);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('conversation send transaction', () => {
  it('reconciles the terminal echo when its native ID differs from the browser ID',async()=>{
    const response=deferred<SendResult>(),submit=vi.spyOn(api.agent,'sendInput').mockReturnValue(response.promise);await mount();input('terminal echo');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));await waitFor(()=>expect(submit).toHaveBeenCalledOnce());
    const browser=submit.mock.calls[0][2],live={id:'live-terminal',client_id:'terminal-client',role:'user',text:'terminal echo',timestamp:new Date().toISOString()};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[live],busy:true,stage:'tools'}));expect(screen.getAllByText('terminal echo')).toHaveLength(2);
    const durable={...live,id:'durable-terminal',sequence:120,client_id:browser,native_client_id:'terminal-client'};
    act(()=>Socket.latest.emit({type:'input_reconciliation',native_id:'native',messages:[durable]}));expect(screen.getAllByText('terminal echo')).toHaveLength(1);
    act(()=>Socket.latest.emit({type:'snapshot',messages:[live],busy:true,stage:'tools'}));expect(screen.getAllByText('terminal echo')).toHaveLength(1);
    await act(async()=>response.resolve({status:'submitted'} as SendResult));
  });
  it('shows the shared progress summary while continuing after a follow-up',async()=>{
    await mount();const prior={id:'before-followup',role:'assistant',turn_id:'turn',phase:'commentary',text:'Prior work',timestamp:new Date(Date.now()-20000).toISOString()};const followup={id:'followup',role:'user',turn_id:'turn',text:'Continue please',timestamp:new Date(Date.now()-10000).toISOString()};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[prior,followup],busy:true,stage:'waiting',turn_id:'turn',started_at:new Date(Date.now()-20000).toISOString(),activities:[]}));
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:12345},tool_calls:7,tool_rounds:5,complete:true}}));
    const status=(await screen.findByText('0 items')).closest('[role=status]')!;expect(status).toHaveTextContent('0 items');expect(status).toHaveTextContent('token: 12.3K');expect(status).toHaveTextContent('tools: 7 calls / 5 rounds');expect(status).toHaveTextContent('In progress');expect(status).not.toHaveTextContent('Follow-up sent');
  });
  it('updates the active progress total without mixing other native sessions',async()=>{
    await mount();const item={id:'progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'working',timestamp:null};
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'运行命令 · test',status:'completed',duration_ms:40000,started_at:null,completed_at:null}]}));await screen.findByText('working');
    const header=screen.getByText('progress').closest('summary')!;expect(within(header).getByText('Step 40s')).toHaveAttribute('title','Duration of the most recently completed tool step');expect(within(header).getByText(/^Turn /)).toHaveAttribute('title','Elapsed time since the current user message or follow-up');expect(within(screen.getByTestId('conversation-activity-line')).queryByText(/^Turn /)).not.toBeInTheDocument();
    expect(header).toHaveTextContent('unknown: —');
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'running',started_at:new Date(Date.now()-35000).toISOString(),completed_at:null,duration_ms:null}]}));
    expect(header).toHaveTextContent(/calling \(test\): 3[45]s/);
    act(()=>Socket.latest.emit({type:'snapshot',messages:[item],busy:true,stage:'tools',turn_id:'turn',started_at:new Date(Date.now()-120000).toISOString(),activities:[{id:'tool',label:'调用工具 · test',status:'completed',started_at:new Date(Date.now()-35000).toISOString(),completed_at:new Date(Date.now()-5000).toISOString(),duration_ms:30000}]}));
    expect(header).toHaveTextContent(/waiting: [45]s/);
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'other',progress:{turn_id:'turn',tokens:{total_tokens:999},tool_calls:9,tool_rounds:9,complete:true}}));expect(screen.queryByText(/token: 999/)).not.toBeInTheDocument();
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:392100},tool_calls:2,tool_rounds:2,complete:true}}));expect(await screen.findByText('total · token: 392.1K · tools: 2 calls / 2 rounds')).toBeVisible();
    act(()=>Socket.latest.emit({type:'progress_statistics',native_id:'native',progress:{turn_id:'turn',tokens:{total_tokens:400000},tool_calls:3,tool_rounds:2,complete:true}}));expect(await screen.findByText('total · token: 400K · tools: 3 calls / 2 rounds')).toBeVisible();
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
