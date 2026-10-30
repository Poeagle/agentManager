import {useEffect} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SessionWorkspacePane} from '../src/components/SessionWorkspacePane';
import {api,type ConversationPage,type Session} from '../src/lib/api';
vi.mock('../src/lib/api',async(original)=>{
  const actual=await original<typeof import('../src/lib/api')>();
  return {...actual,api:{...actual.api,agent:{...actual.api.agent,conversation:vi.fn(),sendInput:vi.fn()},sessions:{...actual.api.sessions,pasteImage:vi.fn(),pasteFile:vi.fn()},rbac:{...actual.api.rbac,me:vi.fn()}}};
});
const session={id:'chat',project_id:'p',task:'Work',status:'running',mode:'session',cli_type:'codex',codex_session_id:'native',pid:null,started_at:null,completed_at:null,exit_code:null,created_at:'2026-10-29T10:00:00Z'} satisfies Session;
let client:QueryClient;let page:ConversationPage;
function Raw({visible,suspended,ready}:{visible:boolean;suspended:boolean;ready:()=>void}) {useEffect(()=>{ready();},[]);return <div data-testid="raw" data-suspended={suspended} data-visible={visible}>raw tool result</div>;}
beforeEach(()=>{
  localStorage.clear();vi.clearAllMocks();Element.prototype.scrollIntoView=vi.fn();
  client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  page={messages:[{id:'a'.repeat(32),role:'user',text:'检查代码',timestamp:null},{id:'b'.repeat(32),role:'assistant',text:'检查已完成。',timestamp:null}],has_more:false,available:true,reset:false,generation:'native',session_id:'chat',native_id:'native',session_active:true,session_status:'running',runtime:null,interaction:{processState:'idle',promptType:null,isPermission:false,choices:null}};
  vi.mocked(api.sessions.pasteImage).mockResolvedValue({ok:true,path:'/project/.agentmanager/pastes/image.png'});vi.mocked(api.sessions.pasteFile).mockResolvedValue({ok:true,path:'/project/.agentmanager/pastes/note.txt'});
  vi.mocked(api.rbac.me).mockResolvedValue({permissions:{agent_api:'write'},roles:[],catalog:[]});
  vi.mocked(api.agent.conversation).mockImplementation(async()=>page);vi.mocked(api.agent.sendInput).mockResolvedValue({status:'submitted'});
});
afterEach(()=>{client.clear();vi.unstubAllGlobals();});
function mount() {return render(<QueryClientProvider client={client}><SessionWorkspacePane session={session} userId="u" active renderTerminal={(visible,suspended,ready)=><Raw visible={visible} suspended={suspended} ready={ready}/>} /></QueryClientProvider>);}
describe('chat/raw terminal display',()=>{
  it('shows only dialogue by default and switches the same terminal without remounting it',async()=>{
    mount();expect(await screen.findByText('检查已完成。')).toBeVisible();expect(screen.getByText('raw tool result')).not.toBeVisible();
    const raw=screen.getByTestId('raw');expect(raw).toHaveAttribute('data-suspended','true');
    fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));
    expect(raw).toBeVisible();expect(raw).toHaveAttribute('data-suspended','false');
    fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));expect(screen.getByTestId('raw')).toBe(raw);
    expect(screen.getByText('检查已完成。')).toBeVisible();
  });
  it('sends directly to the current session once and keeps composer drafts through switching',async()=>{
    mount();const input=await screen.findByRole('textbox',{name:'发送给当前 Agent 的消息'});
    await screen.findByText('检查已完成。');
    fireEvent.change(input,{target:{value:'继续修复'}});fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
    expect(input).toHaveValue('继续修复');fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledWith('chat','继续修复',expect.any(String)));
    expect(api.agent.sendInput).toHaveBeenCalledTimes(1);await waitFor(()=>expect(input).toHaveValue(''));
  });
  it('reserves send order immediately and reconciles an echo and streamed answer before the HTTP response',async()=>{
    let acknowledge!:(result:{status:string})=>void;
    vi.mocked(api.agent.sendInput).mockImplementation(()=>new Promise(resolve=>{acknowledge=resolve;}));
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class {onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    // Browser and native clocks can differ by much more than five seconds.
    page.messages[0].timestamp='2099-01-01T00:00:00Z';page.messages[1].timestamp='2099-01-02T00:00:00Z';
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    const input=screen.getByRole('textbox');fireEvent.change(input,{target:{value:'继续修复'}});
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    const order=()=>Array.from(document.querySelectorAll('.session-chat-message .session-chat-body')).map(node=>node.textContent);
    expect(order()).toEqual(['检查代码','检查已完成。','继续修复']);
    const clientId=vi.mocked(api.agent.sendInput).mock.calls[0][2];
    const echo={id:'d'.repeat(32),role:'user' as const,text:'继续修复',timestamp:'2020-01-01T00:00:00Z',client_id:clientId};
    const answer={id:'e'.repeat(32),role:'assistant' as const,text:'本轮答复',timestamp:'2019-01-01T00:00:00Z',streaming:true};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[echo,answer],busy:true})}));
    expect(order()).toEqual(['检查代码','检查已完成。','继续修复','本轮答复']);
    await act(async()=>{acknowledge({status:'submitted'});});
    expect(order()).toEqual(['检查代码','检查已完成。','继续修复','本轮答复']);
    page={...page,messages:[...page.messages,{...echo,sequence:200},{...answer,sequence:300,streaming:false}]};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[echo,{...answer,streaming:false}],busy:false})}));
    await waitFor(()=>expect(document.querySelector(`[data-chat-message-id="${answer.id}"]`)).toHaveAttribute('data-streaming','false'));
    fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
    await waitFor(()=>expect(api.agent.conversation).toHaveBeenCalled());
    expect(order()).toEqual(['检查代码','检查已完成。','继续修复','本轮答复']);
  });
  it('exposes recovery retry in chat after failure and disables it while resuming',async()=>{
    const resume=vi.fn(),ended={...session,status:'completed' as const};
    const pane=(resuming:boolean)=><QueryClientProvider client={client}><SessionWorkspacePane session={ended} userId="u" active resumeFailed resuming={resuming} onResume={resume} renderTerminal={(visible,suspended,ready)=><Raw visible={visible} suspended={suspended} ready={ready}/>} /></QueryClientProvider>;
    const view=render(pane(false));
    fireEvent.click(await screen.findByRole('button',{name:'重试恢复会话',exact:true}));expect(resume).toHaveBeenCalledTimes(1);
    view.rerender(pane(true));expect(screen.getByRole('button',{name:'正在恢复…',exact:true})).toBeDisabled();
  });
  it('pastes an image, uploads a file and sends both to the same conversation without losing them on a view switch',async()=>{
    mount();await screen.findByText('检查已完成。');const input=screen.getByRole('textbox');
    fireEvent.paste(input,{clipboardData:{files:[new File(['image'],'截图.png',{type:'image/png'})]}});
    await waitFor(()=>expect(api.sessions.pasteImage).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.queryByText('正在上传…')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('选择对话附件'),{target:{files:[new File(['report'],'报告.txt',{type:'text/plain'})]}});
    await waitFor(()=>expect(api.sessions.pasteFile).toHaveBeenCalledTimes(1));await waitFor(()=>expect(screen.queryByText('正在上传…')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
    expect(screen.getByLabelText('待发送附件')).toHaveTextContent('截图.png');expect(screen.getByLabelText('待发送附件')).toHaveTextContent('报告.txt');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledWith('chat','',expect.any(String),[{kind:'image',name:'截图.png',path:'/project/.agentmanager/pastes/image.png'},{kind:'file',name:'报告.txt',path:'/project/.agentmanager/pastes/note.txt'}]));
    await waitFor(()=>expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument());expect(screen.getByRole('button',{name:'打开附件 截图.png'})).toBeVisible();expect(document.body.textContent).not.toContain('agentmanager_attachments');
  });
  it('keeps failed uploads and unsent drafts visible and never sends before upload completion',async()=>{
    vi.mocked(api.sessions.pasteFile).mockRejectedValue(new Error('上传失败'));
    mount();await screen.findByText('检查已完成。');fireEvent.change(screen.getByRole('textbox'),{target:{value:'保留文字'}});
    fireEvent.change(screen.getByLabelText('选择对话附件'),{target:{files:[new File(['report'],'报告.txt',{type:'text/plain'})]}});
    expect(await screen.findByRole('alert')).toHaveTextContent('上传失败');expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();expect(screen.getByRole('textbox')).toHaveValue('保留文字');expect(api.agent.sendInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'移除附件 报告.txt'}));expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();
  });
  it('keeps interactive confirmation visible and routes it to the original terminal',async()=>{
    page={...page,interaction:{processState:'waiting_for_input',promptType:'choice',isPermission:true,choices:['Allow','Deny']}};
    mount();expect(await screen.findByText('Agent 需要授权')).toBeVisible();
    expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'切到原始终端处理'}));expect(screen.getByTestId('raw')).toBeVisible();
  });
  it('does not retry ambiguous sends or discard text on failure',async()=>{
    vi.mocked(api.agent.sendInput).mockRejectedValue(new Error('发送未能确认'));
    mount();await screen.findByText('检查已完成。');const input=screen.getByRole('textbox');fireEvent.change(input,{target:{value:'保留草稿'}});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));});
    expect(await screen.findByRole('alert')).toHaveTextContent('请查看原始终端确认后再重试');expect(input).toHaveValue('保留草稿');expect(api.agent.sendInput).toHaveBeenCalledTimes(1);
  });
  it('keeps a native terminal draft from being combined with chat input',async()=>{
    mount();await screen.findByText('检查已完成。');
    fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));
    const listener=(event:Event)=>(event as CustomEvent).detail.respond(true);
    window.addEventListener('agentmanager:check-terminal-draft',listener);
    try {
      fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
      expect(screen.getByTestId('raw')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent('还有未发送的内容');
      expect(api.agent.sendInput).not.toHaveBeenCalled();
    } finally {window.removeEventListener('agentmanager:check-terminal-draft',listener);}
    fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
    expect(screen.getByText('检查已完成。')).toBeVisible();
  });
  it('updates a single live answer in place and keeps it after settlement and a view switch',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null;close:ReturnType<typeof vi.fn>}> = [];
    vi.stubGlobal('WebSocket',class {
      onmessage:((event:{data:string})=>void)|null=null;onclose=null;onerror=null;close=vi.fn();
      constructor(){sockets.push(this);}
    });
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[],busy:true,stage:'waiting',turn_id:'next',started_at:new Date(Date.now()-17000).toISOString()})}));
    expect(screen.getByText('等待 Codex 返回正文')).toBeVisible();
    expect(screen.getByText('尚未收到正文，收到后会立即逐段显示。')).toBeVisible();
    expect(screen.getByText(/\d+ 秒/)).toBeVisible();
    expect(screen.queryByText('正文接收中…')).not.toBeInTheDocument();
    const message={id:'c'.repeat(32),role:'assistant' as const,text:'真正的',timestamp:'2026-10-29T10:01:00Z',turn_id:'next',streaming:true};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[message],busy:true,stage:'answering',turn_id:'next'})}));
    expect(screen.queryByText('等待 Codex 返回正文')).not.toBeInTheDocument();
    expect(screen.getByText('正文接收中…')).toBeVisible();
    const bubble=screen.getByText('真正的').closest('article');expect(bubble).toHaveAttribute('data-streaming','true');
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{...message,text:'真正的流式回复'}],busy:true})}));
    expect(screen.getByText('真正的流式回复').closest('article')).toBe(bubble);
    page={...page,messages:[...page.messages,{...message,text:'真正的流式回复',streaming:false}]};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{...message,text:'真正的流式回复',streaming:false}],busy:false})}));
    await waitFor(()=>expect(bubble).toHaveAttribute('data-streaming','false'));
    expect(screen.getAllByText('真正的流式回复')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));expect(sockets[0].close).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));expect(screen.getAllByText('真正的流式回复')).toHaveLength(1);
  });
  it('shows at most one live caret and clears all stale carets while tools run or a turn ends',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class{onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    const messages=['第一段进展','第二段进展'].map((text,index)=>({id:`progress-${index}`,role:'assistant',phase:'commentary',text,turn_id:'active-turn',streaming:true,timestamp:null}));
    const frame=(stage:string,busy=true)=>act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages,busy,stage,turn_id:'active-turn'})}));
    frame('answering');expect(document.querySelectorAll('.session-chat-caret')).toHaveLength(1);expect(screen.getByText('第一段进展').closest('article')).toHaveAttribute('data-streaming','false');
    frame('tools');expect(document.querySelectorAll('.session-chat-caret')).toHaveLength(0);
    frame('idle',false);expect(document.querySelectorAll('.session-chat-caret')).toHaveLength(0);
  });
  it('updates one progress region in place, keeps final replies separate and starts a new region after a followup',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class{onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    page.messages=[...page.messages,{id:'progress-one',role:'assistant',phase:'commentary',text:'开始检查',turn_id:'turn',timestamp:'2026-10-30T06:59:01Z'}];
    mount();await screen.findByText('开始检查');await waitFor(()=>expect(sockets).toHaveLength(1));
    const region=screen.getByRole('region',{name:'Codex 进展'});
    const progress={id:'progress-two',role:'assistant',phase:'commentary',text:'正在核对日志',turn_id:'turn',streaming:true,timestamp:'2026-10-30T06:59:05Z'};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[progress],busy:true,stage:'answering',turn_id:'turn'})}));
    expect(screen.getByRole('region',{name:'Codex 进展'})).toBe(region);expect(region).toHaveTextContent('开始检查');expect(region).toHaveTextContent('正在核对日志');
    expect(screen.getByLabelText('进展序号 1')).toHaveTextContent('1');expect(screen.getByLabelText('进展序号 2')).toHaveTextContent('2');
    expect(screen.getAllByLabelText('进展时间').map(node=>node.getAttribute('datetime'))).toEqual(['2026-10-30T06:59:01Z','2026-10-30T06:59:05Z']);
    for(const time of screen.getAllByLabelText('进展时间'))expect(time).toHaveTextContent(/^\d{2}:\d{2}:\d{2}$/);
    const final={id:'final-answer',role:'assistant',phase:'final',text:'最终结论：检查通过',turn_id:'turn',timestamp:null};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{...progress,streaming:false},final],busy:false,stage:'idle',turn_id:'turn'})}));
    expect(region).not.toContainElement(screen.getByText('最终结论：检查通过'));expect(region.querySelectorAll('.session-chat-caret')).toHaveLength(0);
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{id:'followup',role:'user',text:'继续核对',turn_id:'turn-two',timestamp:null},{...progress,id:'next-progress',text:'新一轮进展',turn_id:'turn-two'}],busy:true,stage:'answering',turn_id:'turn-two'})}));
    expect(screen.getAllByRole('region',{name:'Codex 进展'})).toHaveLength(2);expect(screen.getAllByRole('region',{name:'Codex 进展'})[1]).toHaveTextContent('新一轮进展');
  });
});
