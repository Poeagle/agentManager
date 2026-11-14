import {useState} from 'react';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {api,ApiError,type ConversationPage,type SendGuardCheck,type Session} from '../src/lib/api';
import {composerKey,loadComposer} from '../src/lib/batch-composer';
import {SessionConversation} from '../src/components/SessionConversation';

vi.mock('../src/lib/permissions',()=>({usePermissions:()=>({data:{},isPending:false}),hasPermission:()=>true}));
vi.mock('../src/components/ConversationControls',()=>({ConversationControls:()=>null}));
vi.mock('../src/components/ConversationReadingTools',()=>({ConversationWidthHandles:()=>null,ConversationNavigator:()=>null}));

class Socket {
  static sessions=new Map<string,Socket>();
  readyState=1;
  onmessage:((event:{data:string})=>void)|null=null;
  close=vi.fn(()=>{this.readyState=3;});
  constructor(url:string){Socket.sessions.set(decodeURIComponent(new URL(url).pathname.split('/')[3]),this);}
  emit(frame:unknown){if(this.readyState!==1)throw Error('The original subscription was closed');this.onmessage?.({data:JSON.stringify(frame)});}
}
const source={id:'source',project_id:'p',status:'running',cli_type:'codex',codex_session_id:'source-native',claude_session_id:null} as Session;
const other={...source,id:'other',codex_session_id:'other-native'};
const check:SendGuardCheck={needs_confirmation:true,matched:true,enabled:true,context_tokens:800,context_window:1000,context_percent:80,idle_minutes:40,last_completed_at:null,observed_at:null,native_id:'source-native',checked_at:'',can_compact:true,can_new:false,token:'before'};
const clients:QueryClient[]=[];
function Harness(){
  const [selected,setSelected]=useState('source');
  return <><button onClick={()=>setSelected('source')}>源会话</button><button onClick={()=>setSelected('other')}>其他会话</button>{[source,other].map(session=><section key={session.id} data-testid={session.id} style={{display:selected===session.id?'block':'none'}}><SessionConversation session={session} active={selected===session.id} onRaw={()=>{}}/></section>)}</>;
}
async function mount(){
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);
  const view=render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await waitFor(()=>expect(Socket.sessions.get('source')?.onmessage).toBeTruthy());
  act(()=>Socket.sessions.get('source')!.emit({type:'snapshot',messages:[],busy:false,stage:'idle'}));
  return view;
}
function input(text:string){const editor=screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'});editor.textContent=text;fireEvent.input(editor);}
async function start(batch=false){
  if(batch){fireEvent.change(screen.getByRole('combobox',{name:'发送模式'}),{target:{value:'batch'}});input('first');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));input('second');fireEvent.click(screen.getByRole('button',{name:'加入批量'}));fireEvent.click(screen.getByRole('button',{name:'发送批量内容'}));}
  else{input('source draft');fireEvent.click(screen.getByRole('button',{name:'发送消息'}));}
  fireEvent.click(await screen.findByRole('button',{name:'压缩后发送'}));
  await waitFor(()=>expect(api.sessions.compactConversation).toHaveBeenCalledExactlyOnceWith('source'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}
function complete(socket:Socket){act(()=>socket.emit({type:'snapshot',messages:[],busy:false,stage:'idle',compaction:{id:'current-compaction',status:'completed',started_at:new Date(Date.now()-500).toISOString(),completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:1000}}));}
beforeEach(()=>{
  Socket.sessions.clear();vi.stubGlobal('WebSocket',Socket);
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
  vi.spyOn(api.agent,'conversation').mockImplementation(async id=>({messages:[],statistics:[],has_more:false,reset:false,available:true,generation:id,native_id:`${id}-native`,session_active:true,session_status:'running',runtime:{state:'idle'},interaction:null}) as unknown as ConversationPage);
  let checks=0;
  vi.spyOn(api.agent,'checkSend').mockImplementation(async id=>id==='source'?++checks===1?check:{...check,needs_confirmation:false,token:'after',context_percent:20}:{...check,needs_confirmation:false,native_id:'other-native',token:'other'});
  vi.spyOn(api.sessions,'compactConversation').mockResolvedValue({ok:true} as Awaited<ReturnType<typeof api.sessions.compactConversation>>);
  vi.spyOn(api.agent,'sendInput').mockResolvedValue({status:'submitted'});
});
afterEach(()=>{for(const client of clients.splice(0))client.clear();vi.unstubAllGlobals();});

it.each([false,true])('automatically sends the original payload in the background after compaction (batch=%s)',async batch=>{
  await mount();await start(batch);const original=Socket.sessions.get('source')!;
  fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));
  await waitFor(()=>expect(Socket.sessions.get('other')?.onmessage).toBeTruthy());
  expect(original.close).not.toHaveBeenCalled();expect(api.agent.sendInput).not.toHaveBeenCalled();
  input('keep the other draft');complete(original);
  await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledOnce());
  expect(vi.mocked(api.agent.sendInput).mock.calls[0]).toEqual(['source',batch?'first\n\nsecond':'source draft',expect.any(String),[],batch?[{length:5,attachments:0},{length:6,attachments:0}]:undefined,'after']);
  expect(screen.getByRole('textbox',{name:'发送给当前 Agent 的消息'})).toHaveTextContent('keep the other draft');
  await waitFor(()=>expect(original.close).toHaveBeenCalledOnce());
  if(batch)expect(loadComposer(composerKey('local','source')).entries).toHaveLength(0);
  else expect(loadComposer(composerKey('local','source')).draft).toBe('');
  fireEvent.click(screen.getByRole('button',{name:'源会话',exact:true}));
  expect(api.agent.sendInput).toHaveBeenCalledOnce();
});

it('keeps the source subscription until a background submission is acknowledged',async()=>{
  let acknowledge!:(value:{status:string})=>void;vi.mocked(api.agent.sendInput).mockReturnValue(new Promise(resolve=>{acknowledge=resolve;}));
  await mount();await start();const original=Socket.sessions.get('source')!;fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));complete(original);
  await waitFor(()=>expect(api.agent.sendInput).toHaveBeenCalledOnce());expect(original.close).not.toHaveBeenCalled();
  await act(async()=>acknowledge({status:'submitted'}));await waitFor(()=>expect(original.close).toHaveBeenCalledOnce());
});

it('does not send after explicitly cancelling and switching away',async()=>{
  await mount();await start();const original=Socket.sessions.get('source')!;
  fireEvent.click(screen.getByRole('button',{name:'取消后续发送'}));fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));
  await waitFor(()=>expect(original.close).toHaveBeenCalledOnce());expect(api.agent.sendInput).not.toHaveBeenCalled();expect(loadComposer(composerKey('local','source')).draft).toBe('source draft');
});

it('preserves the original draft on background compaction failure and releases its subscription',async()=>{
  await mount();await start();const original=Socket.sessions.get('source')!;fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));
  act(()=>original.emit({type:'snapshot',messages:[],busy:false,stage:'idle',compaction:{id:'current-compaction',status:'failed',started_at:new Date().toISOString(),completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:null,error:'compaction failed'}}));
  await waitFor(()=>expect(original.close).toHaveBeenCalledOnce());expect(api.agent.sendInput).not.toHaveBeenCalled();expect(loadComposer(composerKey('local','source')).draft).toBe('source draft');
  fireEvent.click(screen.getByRole('button',{name:'源会话',exact:true}));expect(within(screen.getByTestId('source')).getByRole('alert')).toHaveTextContent('compaction failed');
});

it('does not retry an unknown background submission when switching back',async()=>{
  vi.mocked(api.agent.sendInput).mockRejectedValue(new ApiError('delivery unknown',503,'unknown'));
  await mount();await start();const original=Socket.sessions.get('source')!;fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));complete(original);await waitFor(()=>expect(original.close).toHaveBeenCalledOnce());
  expect(api.agent.sendInput).toHaveBeenCalledOnce();expect(loadComposer(composerKey('local','source')).draft).toBe('source draft');fireEvent.click(screen.getByRole('button',{name:'源会话',exact:true}));expect(api.agent.sendInput).toHaveBeenCalledOnce();
});
it('releases a closed source tab without sending its preserved draft',async()=>{
  const view=await mount();await start();const original=Socket.sessions.get('source')!;fireEvent.click(screen.getByRole('button',{name:'其他会话',exact:true}));view.unmount();expect(original.close).toHaveBeenCalledOnce();
  act(()=>original.onmessage?.({data:JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle',compaction:{id:'late',status:'completed',started_at:null,completed_at:new Date(Date.now()+1000).toISOString(),duration_ms:1000}})}));
  expect(api.agent.sendInput).not.toHaveBeenCalled();expect(loadComposer(composerKey('local','source')).draft).toBe('source draft');
});
