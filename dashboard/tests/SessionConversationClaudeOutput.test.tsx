import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {api,type ConversationPage,type Session} from '../src/lib/api';
import {sessionAgent} from '../src/lib/agents';
import {SessionConversation} from '../src/components/SessionConversation';
type ConvMessage=NonNullable<ConversationPage['messages']>[number];

vi.mock('../src/lib/permissions',()=>({usePermissions:()=>({data:{},isPending:false}),hasPermission:()=>true}));
vi.mock('../src/components/ConversationControls',()=>({ConversationControls:()=>null}));
vi.mock('../src/components/ConversationReadingTools',()=>({ConversationWidthHandles:()=>null,ConversationNavigator:()=>null}));
vi.mock('../src/lib/use-conversation-compaction',()=>({useConversationCompaction:()=>({state:null,running:false,start:vi.fn(),usage:vi.fn(),observe:vi.fn(),disconnected:vi.fn()})}));

class Socket {
  static latest:Socket;
  readyState=1;onmessage:((event:{data:string})=>void)|null=null;onopen:(()=>void)|null=null;
  constructor(){Socket.latest=this;}
  close(){}
  connect(){this.onopen?.();}
  emit(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
}
const session={id:'claude-ui',project_id:'p',status:'running',cli_type:'claude',claude_session_id:'claude-native',codex_session_id:null} as Session;

beforeEach(()=>{
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  localStorage.clear();
  Socket.latest=undefined as unknown as Socket;
  vi.stubGlobal('WebSocket',Socket);
  vi.spyOn(api.agent,'conversation').mockResolvedValue({
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:'claude-native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
  vi.spyOn(api.agent,'checkSend').mockResolvedValue({needs_confirmation:false,matched:false,enabled:true,context_tokens:null,context_window:null,context_percent:null,idle_minutes:null,last_completed_at:null,observed_at:null,native_id:'claude-native',checked_at:new Date().toISOString(),can_compact:false,can_new:false,token:''});
});

async function renderSnapshot(agent: Pick<Session,'id'|'project_id'|'status'|'cli_type'|'claude_session_id'|'codex_session_id'>,messages:ConvMessage[]){
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  vi.spyOn(api.agent,'conversation').mockResolvedValue({
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:agent.claude_session_id||agent.codex_session_id,session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
  const view=render(<QueryClientProvider client={client}><SessionConversation session={agent as Session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({type:'snapshot',busy:false,turn_id:'turn',stage:'idle',messages}));
  return view;
}
function readConversationDom(agentLabel:string){
  const progress=screen.getByLabelText(`${agentLabel} 进展`);
  const tool=within(progress).getByText('Read').closest('details')!;
  return {
    progressClass:progress.className,
    progressHeading:progress.querySelector('.session-chat-progress-toggle')?.textContent?.replace(/^(?:Claude|codex)/,'').replace(/\s+/g,' ').trim(),
    toolClass:tool.className,
    toolSummary:tool.querySelector('summary')?.textContent?.replace(/\s+/g,' ').trim(),
    hasCompactTool:!!progress.querySelector('.session-chat-tool-compact'),
    progressContent:progress.textContent?.replace(/(?:Claude|codex)(?=progress)/,'').replace(/\s+/g,' ').trim(),
    finalText:screen.getByText('The project is ready.').textContent,
  };
}
it.each(['claude','codex'] as const)('shows the recorded send time on a live %s scheduled task card',async agent=>{
  const timestamp='2026-11-23T16:18:45Z';
  const source={kind:'scheduled',label:'UI审查'} as const;
  await renderSnapshot({
    ...session,cli_type:agent,claude_session_id:agent==='claude'?'native':null,codex_session_id:agent==='codex'?'native':null,
  },[
    {id:'scheduled-with-time',role:'user',text:'执行界面审查',timestamp,input_source:source},
    {id:'scheduled-without-time',role:'user',text:'执行历史界面审查',timestamp:null,input_source:{...source,label:'旧版UI审查'}},
  ]);
  const card=await screen.findByRole('button',{name:/定时任务\s*UI审查/});
  expect(card.querySelector('time')).toHaveAttribute('datetime',timestamp);
  expect(card.querySelector('time')).toBeVisible();
  expect(screen.getByRole('button',{name:/定时任务\s*旧版UI审查/}).querySelector('time')).toBeNull();
});
it.each(['claude','codex'] as const)('shows a sourced handoff using the platform message card in %s',async agent=>{
  await renderSnapshot({
    ...session,cli_type:agent,claude_session_id:agent==='claude'?'native':null,codex_session_id:agent==='codex'?'native':null,
  },[{id:'handoff',role:'user',text:'请验证 DBM-1234',timestamp:'2026-11-25T00:00:00Z',queued:true,
    input_source:{kind:'agent_handoff',label:'DBM-1234 开发'}}]);
  const card=await screen.findByRole('button',{name:/^DBM-1234 开发/});
  expect(card).toHaveTextContent('已排队');
  expect(card).not.toHaveTextContent('Agent 协作');
  fireEvent.click(card);
  expect(screen.getByRole('dialog',{name:'DBM-1234 开发'})).toHaveTextContent('请验证 DBM-1234');
});
it.each(['claude','codex'] as const)('leaves live Progress when %s publishes a settled Final',async agent=>{
  const descriptor=sessionAgent({cli_type:agent});
  const bound={...session,cli_type:agent,agent: {...descriptor,capabilities:{...descriptor.capabilities,stopTurn:true}},
    native_session_id:'claude-native',codex_session_id:agent==='codex'?'claude-native':null,
    claude_session_id:agent==='claude'?'claude-native':null} as Session;
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={bound} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  const timestamp=new Date().toISOString();
  const messages=[
    {id:'user',role:'user',text:'Inspect',timestamp},
    {id:'round',role:'assistant',turn_id:'turn',phase:'commentary',text:'Reading the repository.',timestamp,streaming:true},
  ];
  const activity={id:'read',label:'读取文件 · README.md',input_preview:'README.md',status:'running',started_at:timestamp,
    completed_at:null,duration_ms:null,turn_id:'turn',after_message_id:'round'};
  act(()=>Socket.latest.emit({type:'snapshot',busy:true,turn_id:'turn',started_at:timestamp,stage:'tools',messages,activities:[activity]}));
  const live=await screen.findByRole('status',{name:'正在执行的进展 2'});
  expect(within(live).getByText('README.md')).toBeVisible();
  expect(screen.getByRole('button',{name:'停止当前执行'})).toBeInTheDocument();
  act(()=>Socket.latest.emit({type:'snapshot',busy:false,turn_id:'turn',stage:'idle',
    started_at:timestamp,completed_at:timestamp,activities:[{...activity,status:'completed',completed_at:timestamp}],
    messages:[...messages.map(message=>({...message,streaming:false})),{id:'final',role:'assistant',turn_id:'turn',phase:'final',text:'The repository is ready.',timestamp}]}));
  expect(await screen.findByText('The repository is ready.')).toBeVisible();
  expect(screen.queryByRole('status',{name:'正在执行的进展 2'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'停止当前执行'})).not.toBeInTheDocument();
  expect(screen.getByTestId('conversation-activity-line')).toHaveTextContent('Ready for your next message');
  client.clear();
});
it('shows a live Claude tool whose tool-only assistant message is omitted from the snapshot',async()=>{
  const timestamp=new Date().toISOString();
  const messages=[{id:'input',role:'user',turn_id:'live-turn',text:'Inspect',timestamp}] as ConvMessage[];
  const view=await renderSnapshot(session,messages);
  const activity={id:'read',label:'读取文件 · README.md',input_preview:'README.md',status:'running',started_at:timestamp,
    completed_at:null,duration_ms:null,turn_id:'live-turn',after_message_id:'hidden-tool-only-message'};
  act(()=>Socket.latest.emit({type:'snapshot',busy:true,turn_id:'live-turn',started_at:timestamp,stage:'tools',messages,activities:[activity]}));
  const pending=screen.getByRole('status',{name:'正在执行的进展 1'});
  expect(within(pending).getByText('README.md')).toBeVisible();
  view.unmount();
});
it('keeps live tool counts visible before the usage receipt and renders native Final before idle',async()=>{
  const timestamp=new Date().toISOString();
  const messages=[{id:'input',role:'user',turn_id:'turn',text:'Check',timestamp},
    {id:'first',role:'assistant',turn_id:'turn',phase:'commentary',text:'First progress',timestamp,streaming:true},
    {id:'second',role:'assistant',turn_id:'turn',phase:'commentary',text:'Second progress',timestamp,streaming:true}] as ConvMessage[];
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const view=render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  const activity=(id:string)=>({id,label:'搜索 · '+id,input_preview:id,status:'running',started_at:timestamp,
    completed_at:null,duration_ms:null,turn_id:'turn',after_message_id:'first',request_message_id:'request-2'});
  act(()=>Socket.latest.emit({type:'snapshot',busy:true,turn_id:'turn',started_at:timestamp,stage:'tools',messages,
    activities:[activity('Search A'),activity('Search B'),activity('Search B')]}));
  const pending=await screen.findByRole('status',{name:'正在执行的进展 3'});
  expect(within(pending).getByText('Search B')).toBeVisible();
  expect(pending.querySelector('.session-chat-tool-counts')).toHaveTextContent('1 round | 2 calls');
  expect(screen.queryByText('Streaming',{exact:true})).not.toBeInTheDocument();
  act(()=>Socket.latest.emit({type:'snapshot',busy:true,turn_id:'turn',started_at:timestamp,stage:'answering',
    messages:[...messages.map(message=>({...message,streaming:false})),
      {id:'answer',role:'assistant',turn_id:'turn',phase:'final',text:'Final response',timestamp}],activities:[]}));
  expect(screen.getByText('Final response').closest('[data-phase]')).toHaveAttribute('data-phase','final');
  expect(screen.queryByRole('status',{name:'正在执行的进展 3'})).not.toBeInTheDocument();
  view.unmount();
});
it('renders identical tool and thinking structure for Claude and Codex',async()=>{
  const messages=[
    {id:'user',role:'user',text:'Inspect the project',timestamp:'2026-11-19T23:45:45.000Z'},
    {id:'progress',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:'2026-11-19T23:45:45.000Z',content_blocks:[
      {type:'thinking',index:0,text:'I should inspect the repository first.'},
      {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'# Project'},
    ]},
    {id:'assistant',role:'assistant',text:'The project is ready.',timestamp:'2026-11-19T23:45:50.000Z',turn_id:'turn',phase:'final',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:30,total_tokens:150}},
  ] as ConvMessage[];
  const codex={id:'codex-ui',project_id:'p',status:'running',cli_type:'codex',claude_session_id:null,codex_session_id:'codex-native'} as Session;
  const first=await renderSnapshot(session,messages);
  const claude=readConversationDom('Claude');
  first.unmount();
  Socket.latest=undefined as unknown as Socket;
  const second=await renderSnapshot(codex,messages);
  const codexView=readConversationDom('codex');
  second.unmount();
  expect(claude).toEqual(codexView);
  expect(claude.toolClass).toBe('conversation-card session-chat-tool');
  expect(claude.hasCompactTool).toBe(false);
  expect(claude.progressContent).toContain('I should inspect the repository first.');
  expect(claude.progressContent).toContain('Read');
  expect(claude.finalText).toBe('The project is ready.');
});
it.each(['claude','codex'] as const)('keeps %s thinking inside its numbered step as the step text arrives',async agent=>{
  const current={...session,cli_type:agent,codex_session_id:agent==='codex'?'claude-native':null,claude_session_id:agent==='claude'?'claude-native':null};
  const stamp='2026-11-19T23:45:45.000Z';
  const messages:ConvMessage[]=[
    {id:'user',role:'user',text:'Inspect the project',timestamp:stamp},
    {id:'older',role:'assistant',turn_id:'thinking-turn',phase:'commentary',text:'Earlier progress',timestamp:stamp,
      content_blocks:[{type:'thinking',index:0,text:'Previous reasoning.'}]},
  ];
  await renderSnapshot(current,messages);
  const push=(thinking:string,text='',busy=true)=>act(()=>Socket.latest.emit({
    type:'snapshot',busy,turn_id:'thinking-turn',stage:busy?'answering':'idle',messages:[...messages,{
      id:'current',role:'assistant',turn_id:'thinking-turn',phase:'commentary',streaming:busy,text,timestamp:stamp,
      content_blocks:[{type:'thinking',index:0,text:thinking},...(text?[{type:'text',index:1,text}]:[])],
    }],
  }));
  const name=agent==='claude'?'Claude':'codex';
  push('Checking files.\n\nReview');
  const progress=await screen.findByLabelText(`${name} 进展`);
  const reasoning=within(progress).getByLabelText(`${name} 正在思考`);
  const row=reasoning.closest('details')!;
  const preview=row.querySelector('.session-chat-thinking-preview');
  expect(preview).toHaveTextContent('Review');
  expect(row).not.toHaveAttribute('open');
  const step=reasoning.closest('.session-chat-progress-entry')! as HTMLElement;
  expect(within(step).getByLabelText('进展序号 2')).toBeVisible();
  expect(within(step).queryByText('Previous reasoning.')).not.toBeInTheDocument();
  expect(within(progress).getByLabelText('进展序号 1').closest('.session-chat-progress-entry')).toHaveTextContent('Previous reasoning.');

  push('Checking files.\n\nReviewing the output.');
  expect(within(progress).getByLabelText(`${name} 正在思考`)).toBe(reasoning);
  expect(preview).toHaveTextContent('Reviewing the output.');
  fireEvent.click(reasoning);
  expect(row).toHaveAttribute('open');
  expect(row.querySelector('.session-chat-thinking-body')?.textContent).toBe('Checking files.\nReviewing the output.');
  push('Checking files.\n\nReviewing the output.','Response starts here.');
  expect(within(step).getByLabelText(`${name} 的思考过程`)).toBe(reasoning);
  expect(row).toHaveAttribute('open');
  expect(within(step).getByText('Response starts here.')).toBeVisible();
});
it('does not reserve numbered items for Claude thinking-only request snapshots',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  const stamp='2026-11-19T23:45:45.000Z';
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:true,turn_id:'turn',stage:'tools',
    messages:[
      {id:'user',role:'user',text:'Inspect the project',timestamp:stamp},
      {id:'thought-1',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
        {type:'thinking',index:0,text:'First private reasoning.'},
      ]},
      {id:'commentary',role:'assistant',turn_id:'turn',phase:'commentary',text:'I found the relevant files.',timestamp:stamp},
      {id:'thought-2',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
        {type:'thinking',index:0,text:'Second private reasoning.'},
      ]},
      {id:'tool',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
        {type:'tool_use',index:0,id:'read',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'README'},
      ]},
    ],
  }));
  const progress=await screen.findByLabelText('Claude 进展');
  const entries=progress.querySelectorAll('.session-chat-progress-entry:not(.session-chat-progress-pending)');
  expect(entries).toHaveLength(2);
  expect(within(entries[0] as HTMLElement).getByText('I found the relevant files.')).toBeVisible();
  expect(within(entries[1] as HTMLElement).getByText('Read')).toBeVisible();
  expect(entries[0].querySelector('.session-chat-progress-number')).toHaveTextContent('1');
  expect(entries[1].querySelector('.session-chat-progress-number')).toHaveTextContent('2');
  expect(within(progress).getByLabelText('进展序号 2')).toBeInTheDocument();
  expect(entries[0].querySelector('.session-chat-thinking-preview')).toHaveTextContent('First private reasoning.');
  expect(entries[1].querySelector('.session-chat-thinking-preview')).toHaveTextContent('Second private reasoning.');
  expect(progress.querySelector('.session-chat-progress-toggle')).toHaveTextContent('2 items');
});
it.each(['claude','codex'] as const)('places separate %s reasoning inside Final for a direct answer',async agent=>{
  const current={...session,cli_type:agent,codex_session_id:agent==='codex'?'codex-native':null,claude_session_id:agent==='claude'?'claude-native':null};
  const timestamp='2026-11-19T23:45:45.000Z';
  const {container}=await renderSnapshot(current,[
    {id:'user',role:'user',text:'Answer directly',timestamp},
    {id:'thought',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp,
      content_blocks:[{type:'thinking',index:0,text:'Direct reasoning.'}]},
    {id:'answer',role:'assistant',turn_id:'turn',phase:'final',text:'Direct answer.',timestamp},
  ]);
  const final=container.querySelector('[data-phase="final"]')!;
  const heading=final.querySelector('.session-chat-agent')!;
  const thinking=final.querySelector('.session-chat-thinking-block')!;
  const answer=within(final as HTMLElement).getByText('Direct answer.');
  expect(thinking).toHaveTextContent('Direct reasoning.');
  expect(heading.compareDocumentPosition(thinking)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(thinking.compareDocumentPosition(answer)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('.session-chat-progress')).toBeNull();
});
it('renders Claude through the same conversation structure as every other agent',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:false,turn_id:'turn',stage:'idle',
    messages:[
      {id:'user',role:'user',text:'Inspect the project',timestamp:new Date().toISOString()},
      {id:'assistant',role:'assistant',text:'The project is ready.',timestamp:new Date(Date.now()+5000).toISOString(),turn_id:'turn',phase:'final',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:30,total_tokens:150},content_blocks:[
        {type:'text',index:0,text:'The project is ready.'},
        {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'# Project'},
        {type:'thinking',index:2,text:'I should inspect the repository first.'},
      ]},
    ],
  }));
  const thinking=screen.getByLabelText('Claude 的思考过程').closest('details')!;
  expect(thinking).not.toHaveAttribute('open');
  expect(thinking.parentElement?.firstElementChild).toBe(thinking);
  fireEvent.click(screen.getByLabelText('Claude 的思考过程'));
  expect(thinking).toHaveAttribute('open');
  expect(within(thinking).getByText('I should inspect the repository first.',{selector:'.session-chat-thinking-body'})).toBeVisible();
  expect(screen.getByText('Read')).toBeVisible();
  expect(screen.getByText('Read')).toBeVisible();
  expect(screen.getByText('The project is ready.')).toBeVisible();
  expect(screen.getByText('Claude')).toBeInTheDocument();
  expect(document.querySelector('.session-chat-tool-compact')).toBeNull();
  expect(document.querySelector('.session-chat-tool summary')).toHaveTextContent('Read完成');
  expect(document.querySelector('.session-chat-message.assistant')).toBeInTheDocument();
  expect(document.querySelector('.claudian-message')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'复制Agent 回复'})).toBeInTheDocument();
});

it('does not leave a Claude turn clock or stop control after a completed snapshot',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({type:'snapshot',busy:false,turn_id:'turn',completed_at:new Date().toISOString(),stage:'idle',messages:[{id:'a',role:'assistant',turn_id:'turn',phase:'final',text:'Done',timestamp:new Date().toISOString()}]}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'停止当前执行'})).not.toBeInTheDocument());
  expect(screen.queryByText(/esc to interrupt/)).not.toBeInTheDocument();
});

it('groups Claude tool rounds with the final answer using the shared progress structure',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({type:'snapshot',busy:false,stage:'idle',messages:[],stream_id:'group-test',stream_seq:1}));
  const stamp='2026-11-15T05:00:00.000Z';
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:false,turn_id:'turn',stage:'idle',stream_id:'group-test',stream_seq:2,
    messages:[
      {id:'user',role:'user',text:'介绍一下项目',timestamp:stamp},
      {id:'tool-round',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
        {type:'tool_use',index:0,id:'read-one',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'README'},
        {type:'tool_use',index:1,id:'read-two',name:'Bash',input:{command:'npm test'},status:'completed',result:'ok'},
      ]},
      {id:'tool-round-two',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp,content_blocks:[
        {type:'tool_use',index:0,id:'read-three',name:'Read',input:{file_path:'/p/package.json'},status:'completed',result:'package'},
      ]},
      {id:'final',role:'assistant',turn_id:'turn',phase:'final',text:'项目介绍已完成。',timestamp:stamp},
    ],
  }));
  const progress=await screen.findByLabelText('Claude 进展');
  const tool=within(progress).getAllByText('Read')[0].closest('details')!;
  expect(tool).not.toHaveAttribute('open');
  expect(tool).toHaveClass('session-chat-tool');
  expect(tool.querySelector('.session-chat-tool-detail')).toBeNull();
  expect(screen.getByText('项目介绍已完成。')).toBeVisible();
  expect(within(progress).queryByText('项目介绍已完成。')).not.toBeInTheDocument();
});
it('groups Claude progress across native record turns and shows recorded usage without a segment',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  vi.mocked(api.agent.conversation).mockResolvedValue({
    messages:[
      {id:'user',role:'user',text:'Inspect',timestamp:'2026-11-19T23:45:45.000Z'},
      {id:'one',role:'assistant',turn_id:'record-one',phase:'commentary',text:'Read the README',timestamp:'2026-11-19T23:45:46.000Z'},
      {id:'two',role:'assistant',turn_id:'record-two',phase:'commentary',text:'Run the tests',timestamp:'2026-11-19T23:45:47.000Z'},
      {id:'three',role:'assistant',turn_id:'record-three',phase:'commentary',text:'Check the result',timestamp:'2026-11-19T23:45:48.000Z'},
      {id:'final',role:'assistant',turn_id:'record-four',phase:'final',text:'Done',timestamp:'2026-11-19T23:45:50.000Z'},
    ],
    statistics:[
      {sequence:2,message_id:'one',turn_id:'user-record',tokens:{total_tokens:1200,input_tokens:1000,output_tokens:200},requests:1,tool_calls:2,tool_rounds:1,complete:true},
      {sequence:3,message_id:'two',turn_id:'user-record',tokens:{total_tokens:2600,input_tokens:2300,output_tokens:300},requests:2,tool_calls:4,tool_rounds:2,complete:true},
      {sequence:4,message_id:'three',turn_id:'user-record',tokens:{total_tokens:4200,input_tokens:3800,output_tokens:400},requests:3,tool_calls:5,tool_rounds:3,complete:true},
    ],
    has_more:false,reset:false,available:true,generation:'g',native_id:'claude-native',
    session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  const progress=await screen.findByLabelText('Claude 进展');
  const header=progress.querySelector('.session-chat-progress-toggle')!;
  expect(header).toHaveTextContent('3 items');
  const statistics=header.querySelector('.session-chat-message-statistics');
  expect(statistics).toHaveTextContent('4.2K (—)｜—｜—｜—｜400 · 3 rounds | 5 calls');
  expect(statistics).toHaveAttribute('title',expect.stringContaining('total input 3,800'));
  expect(header).not.toHaveTextContent('— rounds | — calls');
  expect(within(progress).getByText('Check the result')).toBeInTheDocument();
  expect(screen.getByText('Done')).toBeVisible();
});
