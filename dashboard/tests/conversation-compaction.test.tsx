import {act,render,renderHook,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {useConversationCompaction} from '../src/lib/use-conversation-compaction';
import {ConversationCompactionStatus} from '../src/components/ConversationCompactionStatus';
import {api,type ConversationControlsData} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{sessions:{compactConversation:vi.fn().mockResolvedValue({ok:true})}}}));
let client:QueryClient;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(['conversation-controls','s'],{usage:{last:{total_tokens:24000},total:{total_tokens:1000000},window:40000}});});
afterEach(()=>{client.clear();vi.useRealTimers();});
function mount(){return renderHook(()=>useConversationCompaction('s','native'),{wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});}
it('waits for native completion after RPC acceptance, shows time and updates context through push only',async()=>{
 vi.useFakeTimers();const {result}=mount();await act(async()=>result.current.start());expect(result.current.state?.status).toBe('pending');expect(result.current.running).toBe(true);
 const time=new Date(Date.now()-27000).toISOString();act(()=>result.current.observe({id:'c',status:'running',started_at:time,completed_at:null,duration_ms:null}));const view=render(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('Compacting context')).toBeVisible();expect(screen.getByText('27s')).toBeVisible();
 act(()=>{result.current.usage({total:{total_tokens:1000000},last:{total_tokens:2000},window:40000},new Date().toISOString());result.current.observe({id:'c',status:'completed',started_at:time,completed_at:new Date().toISOString(),duration_ms:27000});});view.rerender(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('Context compaction complete')).toBeVisible();expect(screen.getByText('Context 60% → 5%')).toBeVisible();expect(client.getQueryData<ConversationControlsData>(['conversation-controls','s'])?.usage?.last.total_tokens).toBe(2000);act(()=>vi.advanceTimersByTime(8000));expect(result.current.state).toBeNull();
});
it('shows terminal initiated compaction and keeps disconnects and interruptions distinct from completion',()=>{
 const {result}=mount();const native={id:'remote',status:'running' as const,started_at:null,completed_at:null,duration_ms:null};act(()=>result.current.observe(native));expect(result.current.running).toBe(true);act(()=>result.current.disconnected());expect(result.current.state?.status).toBe('unknown');act(()=>result.current.observe(native));expect(result.current.running).toBe(true);act(()=>result.current.observe({...native,status:'interrupted'}));render(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('Context compaction interrupted')).toBeVisible();expect(screen.queryByText('Context compaction complete')).not.toBeInTheDocument();
});
it('keeps request failures visible instead of claiming compression started',async()=>{
 vi.mocked(api.sessions.compactConversation).mockRejectedValueOnce(Error('请等待当前任务完成后再压缩会话'));const {result}=mount();await act(async()=>{await expect(result.current.start()).rejects.toThrow('当前任务');});expect(result.current.state).toMatchObject({status:'rejected',error:'请等待当前任务完成后再压缩会话'});expect(result.current.running).toBe(false);
});
it('expires completion after three seconds and never resurrects it from repeated snapshots',()=>{
 vi.useFakeTimers();const {result}=mount(),now=Date.now(),native={id:'once',status:'completed' as const,started_at:new Date(now-10000).toISOString(),completed_at:new Date(now).toISOString(),duration_ms:10000};
 act(()=>result.current.observe(native,true));expect(result.current.state?.status).toBe('completed');
 act(()=>vi.advanceTimersByTime(3000));expect(result.current.state).toBeNull();
 act(()=>result.current.observe({...native,completed_at:new Date().toISOString()},true));expect(result.current.state).toBeNull();
});
it('immediately yields to resumed work and ignores old completion on reconnect',()=>{
 vi.useFakeTimers();const {result}=mount(),now=Date.now(),native={id:'done',status:'completed' as const,started_at:null,completed_at:new Date(now).toISOString(),duration_ms:1000};
 act(()=>result.current.observe(native,true));expect(result.current.state?.status).toBe('completed');
 act(()=>result.current.observe(native,true,true));expect(result.current.state).toBeNull();
 act(()=>result.current.observe(native,true));expect(result.current.state).toBeNull();
 const old={...native,id:'old',completed_at:new Date(now-60000).toISOString()};act(()=>result.current.observe(old));expect(result.current.state).toBeNull();
 act(()=>result.current.observe({...native,id:'new-turn'}));expect(result.current.state?.status).toBe('completed');
 act(()=>result.current.observe(null,true));expect(result.current.state).toBeNull();
 act(()=>result.current.observe({...native,id:'new-turn'}));expect(result.current.state).toBeNull();
});

it('keeps a native running receipt when the HTTP response arrives late with an error',async()=>{
 let reject!:(e:Error)=>void;vi.mocked(api.sessions.compactConversation).mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));const {result}=mount();let work!:Promise<void>;
 act(()=>{work=result.current.start();});act(()=>result.current.observe({id:'native-now',status:'running',started_at:new Date().toISOString(),completed_at:null,duration_ms:null}));
 await act(async()=>{reject(Error('late transport error'));await work;});expect(result.current.state?.status).toBe('running');
});
it('shows an unknown dispatch separately from a rejected request',async()=>{
 vi.mocked(api.sessions.compactConversation).mockRejectedValueOnce(Object.assign(Error('connection lost'),{submission:'unknown'}));const {result}=mount();await act(async()=>{await expect(result.current.start()).rejects.toThrow();});expect(result.current.state?.status).toBe('unknown');
});
