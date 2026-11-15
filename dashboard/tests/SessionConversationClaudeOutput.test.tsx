import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {api,type ConversationPage,type Session} from '../src/lib/api';
import {SessionConversation} from '../src/components/SessionConversation';

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
  vi.stubGlobal('WebSocket',Socket);
  vi.spyOn(api.agent,'conversation').mockResolvedValue({
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:'claude-native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
  vi.spyOn(api.agent,'checkSend').mockResolvedValue({needs_confirmation:false,matched:false,enabled:true,context_tokens:null,context_window:null,context_percent:null,idle_minutes:null,last_completed_at:null,observed_at:null,native_id:'claude-native',checked_at:new Date().toISOString(),can_compact:false,can_new:false,token:''});
});

it('renders Claude output with Claudian structure and no progress or final wrapper',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:false,turn_id:'turn',stage:'idle',
    messages:[
      {id:'user',role:'user',text:'Inspect the project',timestamp:new Date().toISOString()},
      {id:'assistant',role:'assistant',text:'The project is ready.',timestamp:new Date(Date.now()+5000).toISOString(),turn_id:'turn',phase:'final',content_blocks:[
        {type:'thinking',index:0,text:'I should inspect the repository first.'},
        {type:'tool_use',index:1,id:'tool-1',name:'Read',input:{file_path:'/p/README.md'},status:'completed',result:'# Project'},
        {type:'text',index:2,text:'The project is ready.'},
      ]},
    ],
  }));
  const thinking=screen.getByText('Thought').closest('details')!;
  expect(thinking).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Thought'));
  expect(thinking).toHaveAttribute('open');
  expect(screen.getByText('I should inspect the repository first.')).toBeVisible();
  expect(screen.getByText('Read')).toBeVisible();
  expect(screen.getByText('README.md')).toBeVisible();
  expect(document.querySelector('.claudian-baked-duration')).toHaveTextContent('Baked for 5s');
  expect(screen.getByText('The project is ready.')).toBeVisible();
  expect(screen.queryByText('progress')).not.toBeInTheDocument();
  expect(screen.queryByText('final')).not.toBeInTheDocument();
  expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  expect(screen.queryByText('Claude Provider')).not.toBeInTheDocument();
});

it('does not leave a Claude turn clock or stop control after a completed snapshot',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({type:'snapshot',busy:false,turn_id:'turn',completed_at:new Date().toISOString(),stage:'idle',messages:[{id:'a',role:'assistant',turn_id:'turn',phase:'final',text:'Done',timestamp:new Date().toISOString()}]}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'停止当前执行'})).not.toBeInTheDocument());
  expect(screen.queryByText(/esc to interrupt/)).not.toBeInTheDocument();
});
