import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {api,type ConversationPage,type Session} from '../src/lib/api';
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
    progressHeading:progress.querySelector('summary')?.textContent?.replace(/^(?:Claude|codex)/,'').replace(/\s+/g,' ').trim(),
    toolClass:tool.className,
    toolSummary:tool.querySelector('summary')?.textContent?.replace(/\s+/g,' ').trim(),
    hasCompactTool:!!progress.querySelector('.session-chat-tool-compact'),
    progressContent:progress.textContent?.replace(/^(?:Claude|codex)/,'').replace(/(?:Claude|codex) 的思考过程/,'思考过程').replace(/\s+/g,' ').trim(),
    finalText:screen.getByText('The project is ready.').textContent,
  };
}
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
it('renders Claude through the same conversation structure as every other agent',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:false,turn_id:'turn',stage:'idle',
    messages:[
      {id:'user',role:'user',text:'Inspect the project',timestamp:new Date().toISOString()},
      {id:'assistant',role:'assistant',text:'The project is ready.',timestamp:new Date(Date.now()+5000).toISOString(),turn_id:'turn',phase:'final',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:30,total_tokens:150},content_blocks:[
        {type:'thinking',index:0,text:'I should inspect the repository first.'},
        {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'# Project'},
        {type:'text',index:2,text:'The project is ready.'},
      ]},
    ],
  }));
  const thinking=screen.getByText('Claude 的思考过程').closest('details')!;
  expect(thinking).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Claude 的思考过程'));
  expect(thinking).toHaveAttribute('open');
  expect(screen.getByText('I should inspect the repository first.')).toBeVisible();
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
