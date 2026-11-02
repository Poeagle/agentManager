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
function typeDraft(node:HTMLElement,value:string){node.textContent=value;fireEvent.input(node);}
function mount(onReload?:()=>Promise<void>) {return render(<QueryClientProvider client={client}><SessionWorkspacePane session={session} userId="u" active onReload={onReload} renderTerminal={(visible,suspended,ready)=><Raw visible={visible} suspended={suspended} ready={ready}/>} /></QueryClientProvider>);}
describe('chat/raw terminal display',()=>{
  it('refreshes stale startup permissions once the terminal becomes ready without waiting five minutes',async()=>{
    const cached={model:'a',effort:'high',models:[{model:'a',name:'A',efforts:[{value:'high'}],defaultEffort:'high'}],usage:null,limits:[],loaded:true,can_edit:false,pending:null};
    client.setQueryData(['conversation-controls',session.id],cached);
    const get=vi.spyOn(api.agent,'controls').mockResolvedValue({...cached,can_edit:true} as any);
    try{render(<QueryClientProvider client={client}><SessionWorkspacePane session={session} userId="u" active renderTerminal={(_visible,_suspended,ready)=><button onClick={ready}>测试终端就绪</button>}/></QueryClientProvider>);const select=await screen.findByRole('combobox',{name:'选择模型'});expect(select).toBeDisabled();fireEvent.click(screen.getByText('测试终端就绪'));await waitFor(()=>expect(select).toBeEnabled());expect(get).toHaveBeenCalledTimes(1);}finally{get.mockRestore();}
  });
  it('does not preserve native trailing newlines before inline image text',async()=>{
    page.messages=[{id:'image-user',role:'user',text:'这段正文\n\n',timestamp:null,attachments:[{kind:'image',name:'image.png',path:'/project/image.png'}]}];mount();const image=await screen.findByRole('button',{name:'打开附件 image.png'});const parent=image.closest('.session-chat-user-text')!;expect(parent.firstChild?.textContent).toBe('这段正文');expect(parent).toHaveTextContent('这段正文图片 1');expect(parent.querySelector('img')).toBeNull();
  });
  it('folds injected project instructions with a clear automatic category',async()=>{
    page.messages.splice(1,0,{id:'rules',role:'user',text:'# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\n'+('项目规则\n'.repeat(50))+'</INSTRUCTIONS>',timestamp:'2026-10-31T03:00:00Z'});mount();const label=await screen.findByText('自动信息 · 项目规则');const details=label.closest('details')!;expect(details.open).toBe(false);fireEvent.click(label);expect(details.open).toBe(true);expect(details.querySelector('pre')).toHaveTextContent('项目规则');
  });
  it('confirms reload once, retains draft text, and keeps a failed reload reviewable',async()=>{
    let finish!:()=>void;const reload=vi.fn(()=>new Promise<void>(resolve=>finish=resolve));mount(reload);await screen.findByText('检查已完成。');const input=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});typeDraft(input,'尚未发送的反馈');fireEvent.click(screen.getByRole('button',{name:'重载标签页',exact:true}));expect(screen.getByRole('button',{name:'取消',exact:true})).toHaveFocus();expect(reload).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'重载并保留对话'}));expect(reload).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'正在重载…'})).toBeDisabled();await act(async()=>finish());expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(input).toHaveTextContent('尚未发送的反馈');
  });

  it('renders real async question messages as choice cards and replies without clearing the composer draft',async()=>{
    page.messages=[page.messages[0],{id:'question-message',role:'assistant',phase:'final',text:'免费旅行，你最想去哪里？',timestamp:null,async_questions:[{id:'native-question',title:'免费旅行，你最想去哪里？',options:['太空','深海','森林']}]},{id:'after-question',role:'assistant',text:'问题已发出。',timestamp:null}];
    mount();await screen.findByRole('radio',{name:/太空/});fireEvent.click(screen.getByRole('button',{name:'稍后回答'}));const draft=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});typeDraft(draft,'这份草稿先留着');
    fireEvent.click(screen.getByRole('button',{name:/^待回答/}));fireEvent.click(screen.getByRole('radio',{name:/太空/}));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答',exact:true})));
    expect(api.agent.sendInput).toHaveBeenCalledExactlyOnceWith('chat',expect.stringContaining('<send_user_message_question_reply>'),expect.any(String));expect(draft).toHaveTextContent('这份草稿先留着');expect(screen.queryByRole('button',{name:'提交回答',exact:true})).not.toBeInTheDocument();expect(screen.getByText('已回答')).toBeVisible();
  });
  it('keeps an async answer editable after a failed submission and locks superseded history on restore',async()=>{
    const question={id:'question',role:'assistant' as const,text:'哪个？',timestamp:null,async_questions:[{id:'native-id',title:'哪个？',options:['A','B']}]};page.messages=[page.messages[0],question];vi.mocked(api.agent.sendInput).mockRejectedValueOnce(new Error('网络断开'));
    const view=mount();fireEvent.click(await screen.findByRole('radio',{name:/A/}));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'提交回答',exact:true})));expect(await screen.findByRole('alert')).toHaveTextContent('网络断开');expect(screen.getByRole('button',{name:'提交回答',exact:true})).toBeEnabled();view.unmount();
    page.messages=[...page.messages,{id:'next-user',role:'user',text:'下一个问题',timestamp:null}];mount();expect(screen.queryByRole('button',{name:'提交回答',exact:true})).not.toBeInTheDocument();expect(await screen.findByText('已继续对话')).toBeVisible();
  });
  it('shows native errors with time, stops stale busy/caret indicators and retains the error after switching views',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class{onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    const failure={id:'error-one',role:'assistant' as const,phase:'error' as const,text:'Selected model is at capacity. Please try a different model.',turn_id:'failed',timestamp:'2026-10-30T07:00:00Z',error:{code:'server_overloaded',will_retry:false}};
    page.messages=[...page.messages,failure];
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',busy:true,stage:'tools',turn_id:'failed',messages:[failure]})}));
    const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(failure.text);expect(alert).toHaveTextContent('当前模型繁忙');expect(alert.querySelector('time')).toHaveAttribute('datetime',failure.timestamp);
    expect(screen.getByText('本轮执行失败，可处理后重试')).toBeVisible();expect(document.querySelectorAll('.session-chat-caret')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'查看原始终端',exact:true}));expect(screen.getByTestId('raw')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));expect(await screen.findAllByRole('alert')).toHaveLength(1);
  });
  it('distinguishes automatic retry from a final error and ends the retry notice after progress resumes',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class{onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    const failure={id:'retry-error',role:'assistant',phase:'error',text:'Network connection interrupted',turn_id:'retry',timestamp:null,error:{code:'response_stream_disconnected',will_retry:true}};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',busy:true,stage:'waiting',turn_id:'retry',messages:[failure]})}));
    expect(screen.getByRole('alert')).toHaveTextContent('Agent 正在自动重试');expect(screen.queryByText('本轮执行失败，可处理后重试')).not.toBeInTheDocument();
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',busy:true,stage:'answering',turn_id:'retry',messages:[failure,{id:'recovered',role:'assistant',phase:'commentary',text:'连接已恢复，继续检查',turn_id:'retry',timestamp:null,streaming:true}]})}));
    expect(screen.getByRole('alert')).toHaveTextContent('重试已结束');expect(screen.getByText('连接已恢复，继续检查')).toBeVisible();expect(screen.getByText('正文接收中…')).toBeVisible();
  });
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
    typeDraft(input,'继续修复');fireEvent.click(screen.getByRole('button',{name:'原始终端',exact:true}));fireEvent.click(screen.getByRole('button',{name:'对话',exact:true}));
    expect(input).toHaveTextContent('继续修复');fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledWith('chat','继续修复',expect.any(String)));
    expect(api.agent.sendInput).toHaveBeenCalledTimes(1);await waitFor(()=>expect(input).toHaveTextContent(''));
  });
  it('reserves send order immediately and reconciles an echo and streamed answer before the HTTP response',async()=>{
    let acknowledge!:(result:{status:string})=>void;
    vi.mocked(api.agent.sendInput).mockImplementation(()=>new Promise(resolve=>{acknowledge=resolve;}));
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class {onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    // Browser and native clocks can differ by much more than five seconds.
    page.messages[0].timestamp='2099-01-01T00:00:00Z';page.messages[1].timestamp='2099-01-02T00:00:00Z';
    mount();await screen.findByText('检查已完成。');await waitFor(()=>expect(sockets).toHaveLength(1));
    const input=screen.getByRole('textbox');typeDraft(input,'继续修复');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    const order=()=>Array.from(document.querySelectorAll('.session-chat-message .session-chat-body')).map(node=>{const copy=node.cloneNode(true) as HTMLElement;copy.querySelectorAll('.session-chat-message-meta').forEach(meta=>meta.remove());return (copy.querySelector('.session-chat-user-text')||copy).textContent;});
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
    expect(screen.getByRole('button',{name:'预览待发送图片 截图.png'})).toHaveTextContent('图片 1');expect(screen.getByRole('button',{name:'预览待发送文件 报告.txt'})).toHaveTextContent('文件 1');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));
    await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledWith('chat','',expect.any(String),[{kind:'image',name:'截图.png',path:'/project/.agentmanager/pastes/image.png'},{kind:'file',name:'报告.txt',path:'/project/.agentmanager/pastes/note.txt'}]));
    await waitFor(()=>expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument());expect(screen.getByRole('button',{name:'打开附件 截图.png'})).toBeVisible();expect(document.body.textContent).not.toContain('agentmanager_attachments');
  });
  it('keeps failed uploads and unsent drafts visible and never sends before upload completion',async()=>{
    vi.mocked(api.sessions.pasteFile).mockRejectedValue(new Error('上传失败'));
    mount();await screen.findByText('检查已完成。');typeDraft(screen.getByRole('textbox'),'保留文字');
    fireEvent.change(screen.getByLabelText('选择对话附件'),{target:{files:[new File(['report'],'报告.txt',{type:'text/plain'})]}});
    expect(await screen.findByRole('alert')).toHaveTextContent('上传失败');expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();expect(screen.getByRole('textbox')).toHaveTextContent('保留文字');expect(api.agent.sendInput).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button',{name:'预览待发送文件 报告.txt'}),{key:'Backspace'});expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeEnabled();
  });
  it('keeps interactive confirmation visible and routes it to the original terminal',async()=>{
    page={...page,interaction:{processState:'waiting_for_input',promptType:'choice',isPermission:true,choices:['Allow','Deny']}};
    mount();expect(await screen.findByText('Agent 需要授权')).toBeVisible();
    expect(screen.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'切到原始终端处理'}));expect(screen.getByTestId('raw')).toBeVisible();
  });
  it.each(['idle','running','failed'] as const)('does not turn Outlook instructions into a choice prompt when native Codex is %s',async state=>{
    page={...page,runtime:{source:'codex_rollout',session_id:'native',state,last_activity_at:null,observed_at:new Date().toISOString(),reason:'native execution'},interaction:{processState:'waiting_for_input',promptType:'choice',isPermission:false,choices:['打开齿轮 → 邮件 → 规则','点击 ▶ 立即运行规则']}};
    mount();await screen.findByText('检查已完成。');expect(screen.queryByText('Agent 需要你确认或选择')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'切到原始终端处理'})).not.toBeInTheDocument();expect(screen.getByRole('textbox')).toBeEnabled();
  });
  it('still shows genuine native requests for user input',async()=>{
    page={...page,runtime:{source:'codex_rollout',session_id:'native',state:'waiting_for_input',last_activity_at:null,observed_at:new Date().toISOString(),reason:'native request'},interaction:{processState:'waiting_for_input',promptType:'choice',isPermission:false,choices:['继续','取消']}};
    mount();expect(await screen.findByText('Agent 需要你确认或选择')).toBeVisible();expect(screen.getByRole('textbox')).toHaveAttribute('aria-disabled','true');
  });
  it('does not retry ambiguous sends or discard text on failure',async()=>{
    vi.mocked(api.agent.sendInput).mockRejectedValue(new Error('发送未能确认'));
    mount();await screen.findByText('检查已完成。');const input=screen.getByRole('textbox');typeDraft(input,'保留草稿');
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));});
    expect(await screen.findByRole('alert')).toHaveTextContent('请查看原始终端确认后再重试');expect(input).toHaveTextContent('保留草稿');expect(api.agent.sendInput).toHaveBeenCalledTimes(1);
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
  it('keeps an executing task active after a followup and inserts its next progress immediately',async()=>{
    const sockets:Array<{onmessage:((event:{data:string})=>void)|null}>=[];
    vi.stubGlobal('WebSocket',class{onmessage=null;onclose=null;onerror=null;close=vi.fn();constructor(){sockets.push(this);}});
    page.messages=[{id:'first-user',role:'user',text:'整理文档',turn_id:'active',timestamp:null},{id:'first-progress',role:'assistant',text:'正在补充差异说明',phase:'commentary',turn_id:'active',timestamp:null}];
    mount();await screen.findByText('正在补充差异说明');await waitFor(()=>expect(sockets).toHaveLength(1));
    const frame=(messages:unknown[],stage='tools')=>act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages,busy:true,stage,turn_id:'active',started_at:new Date(Date.now()-120000).toISOString()})}));
    frame([]);typeDraft(screen.getByRole('textbox'),'请用通俗语言解释');
    fireEvent.click(screen.getByRole('button',{name:'发送消息',exact:true}));await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalled());
    await screen.findByText('追问已提交，Codex 正在继续执行');expect(screen.queryByText('尚未收到正文，收到后会立即逐段显示。')).not.toBeInTheDocument();
    const [,text,clientId]=vi.mocked(api.agent.sendInput).mock.calls[0];
    const echo={id:'followup-echo',role:'user',text,client_id:clientId,turn_id:'active',timestamp:new Date().toISOString()};
    frame([echo]);expect(screen.getAllByText('请用通俗语言解释')).toHaveLength(1);
    const progress={id:'new-progress',role:'assistant',phase:'commentary',text:'我会用',turn_id:'active',streaming:true,timestamp:new Date().toISOString()};
    frame([echo,progress],'answering');const article=screen.getByText('我会用').closest('article');expect(article).toHaveAttribute('data-streaming','true');
    expect(screen.queryByText('追问已提交，Codex 正在继续执行')).not.toBeInTheDocument();
    frame([echo,{...progress,text:'我会用具体数字逐项解释'}],'answering');expect(screen.getByText('我会用具体数字逐项解释').closest('article')).toBe(article);
    expect(screen.getAllByText('请用通俗语言解释')).toHaveLength(1);
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
    for(const time of screen.getAllByLabelText('进展时间'))expect(time).toHaveTextContent(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const final={id:'final-answer',role:'assistant',phase:'final',text:'最终结论：检查通过',turn_id:'turn',timestamp:null};
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{...progress,streaming:false},final],busy:false,stage:'idle',turn_id:'turn'})}));
    expect(region).not.toContainElement(screen.getByText('最终结论：检查通过'));expect(region.querySelectorAll('.session-chat-caret')).toHaveLength(0);
    act(()=>sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',messages:[{id:'followup',role:'user',text:'继续核对',turn_id:'turn-two',timestamp:null},{...progress,id:'next-progress',text:'新一轮进展',turn_id:'turn-two'}],busy:true,stage:'answering',turn_id:'turn-two'})}));
    expect(screen.getAllByRole('region',{name:'Codex 进展'})).toHaveLength(2);expect(screen.getAllByRole('region',{name:'Codex 进展'})[1]).toHaveTextContent('新一轮进展');
  });
});
