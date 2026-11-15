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
  readyState=1;onmessage:((event:{data:string})=>void)|null=null;
  constructor(){Socket.latest=this;}
  close(){}
  emit(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
}
const session={id:'claude-ui',project_id:'p',status:'running',cli_type:'claude',claude_session_id:'claude-native',codex_session_id:null} as Session;

beforeEach(()=>{
  vi.stubGlobal('WebSocket',Socket);
  vi.spyOn(api.agent,'conversation').mockResolvedValue({
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:'claude-native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
});

it('renders Claude thinking and tool output inside the transcript without adding control UI',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  act(()=>Socket.latest.emit({
    type:'snapshot',busy:false,turn_id:'turn',stage:'idle',
    messages:[
      {id:'user',role:'user',text:'Inspect the project',timestamp:new Date().toISOString()},
      {id:'assistant',role:'assistant',text:'The project is ready.',timestamp:new Date().toISOString(),turn_id:'turn',phase:'final',content_blocks:[
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
  expect(screen.getByText('The project is ready.')).toBeVisible();
  expect(screen.queryByText('Claude Provider')).not.toBeInTheDocument();
});
