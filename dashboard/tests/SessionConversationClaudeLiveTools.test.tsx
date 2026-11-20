import {act,render,screen,waitFor} from '@testing-library/react';
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
  emit(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)});}
}
const session={id:'claude-live-tools',project_id:'p',status:'running',cli_type:'claude',claude_session_id:'native',codex_session_id:null} as Session;

beforeEach(()=>{
  localStorage.clear();
  Socket.latest=undefined as unknown as Socket;
  vi.stubGlobal('WebSocket',Socket);
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  vi.spyOn(api.agent,'conversation').mockResolvedValue({
    messages:[],statistics:[],has_more:false,reset:false,available:true,generation:'g',
    native_id:'native',session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null,
  } as unknown as ConversationPage);
  vi.spyOn(api.agent,'checkSend').mockResolvedValue({needs_confirmation:false,matched:false,enabled:true,context_tokens:null,context_window:null,context_percent:null,idle_minutes:null,last_completed_at:null,observed_at:null,native_id:'native',checked_at:new Date().toISOString(),can_compact:false,can_new:false,token:''});
});

it('refreshes one latest Claude activity slot instead of stacking duplicate tool ids',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><SessionConversation session={session} active onRaw={()=>{}}/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.latest?.onmessage).toBeTruthy());
  const stamp=new Date(Date.now()-1000).toISOString();
  const prompt={id:'user',role:'user',text:'Run tests',timestamp:stamp};
  const round={id:'round',role:'assistant',turn_id:'turn',phase:'commentary',text:'',timestamp:stamp};
  const tool={id:'same-tool',label:'运行命令 · npm test',status:'running',started_at:stamp,completed_at:null,duration_ms:null,turn_id:'turn',after_message_id:'round',input_preview:'npm test'};
  act(()=>Socket.latest.emit({type:'snapshot',messages:[prompt,round],activities:[tool],busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
  const slot=await screen.findByRole('status',{name:'正在执行的进展 2'});
  expect(slot.querySelectorAll('.session-chat-live-tool')).toHaveLength(1);
  expect(slot).toHaveTextContent('npm test');
  expect(slot.querySelector('.session-chat-live-tool')).not.toHaveAttribute('open','');
  expect(slot.querySelector('.session-chat-live-tool-details')).not.toBeVisible();
  act(()=>Socket.latest.emit({type:'snapshot',messages:[prompt,round],activities:[tool,{...tool,result_preview:'Tests passed'}],busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
  expect(slot.querySelectorAll('.session-chat-live-tool')).toHaveLength(1);
  expect(slot).toHaveTextContent('Tests passed');
  act(()=>Socket.latest.emit({type:'snapshot',messages:[prompt,round],activities:[{...tool,status:'completed',result_preview:'Tests passed'}],busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
  expect(slot.querySelectorAll('.session-chat-live-tool')).toHaveLength(1);
  expect(slot).toHaveTextContent('Tests passed');
  act(()=>Socket.latest.emit({type:'snapshot',messages:[prompt,round],activities:[{...tool,status:'completed',result_preview:'Tests passed'},{...tool,id:'next-tool',label:'运行命令 · npm run build',input_preview:'npm run build'}],busy:true,stage:'tools',turn_id:'turn',started_at:stamp}));
  expect(slot.querySelectorAll('.session-chat-live-tool')).toHaveLength(1);
  expect(slot).toHaveTextContent('npm run build');
  expect(slot).not.toHaveTextContent('Tests passed');
});
