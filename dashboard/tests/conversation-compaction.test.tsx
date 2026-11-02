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
 const time=new Date(Date.now()-27000).toISOString();act(()=>result.current.observe({id:'c',status:'running',started_at:time,completed_at:null,duration_ms:null}));const view=render(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('正在压缩上下文')).toBeVisible();expect(screen.getByText('27秒')).toBeVisible();
 act(()=>{result.current.usage({total:{total_tokens:1000000},last:{total_tokens:2000},window:40000},new Date().toISOString());result.current.observe({id:'c',status:'completed',started_at:time,completed_at:new Date().toISOString(),duration_ms:27000});});view.rerender(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('上下文压缩完成')).toBeVisible();expect(screen.getByText('上下文 60% → 5%')).toBeVisible();expect(client.getQueryData<ConversationControlsData>(['conversation-controls','s'])?.usage?.last.total_tokens).toBe(2000);act(()=>vi.advanceTimersByTime(8000));expect(result.current.state).toBeNull();
});
it('shows terminal initiated compaction and keeps disconnects and interruptions distinct from completion',()=>{
 const {result}=mount();const native={id:'remote',status:'running' as const,started_at:null,completed_at:null,duration_ms:null};act(()=>result.current.observe(native));expect(result.current.running).toBe(true);act(()=>result.current.disconnected());expect(result.current.state?.status).toBe('unknown');act(()=>result.current.observe(native));expect(result.current.running).toBe(true);act(()=>result.current.observe({...native,status:'interrupted'}));render(<ConversationCompactionStatus state={result.current.state!} now={Date.now()}/>);expect(screen.getByText('上下文压缩已中断')).toBeVisible();expect(screen.queryByText('上下文压缩完成')).not.toBeInTheDocument();
});
it('keeps request failures visible instead of claiming compression started',async()=>{
 vi.mocked(api.sessions.compactConversation).mockRejectedValueOnce(Error('请等待当前任务完成后再压缩会话'));const {result}=mount();await act(async()=>{await expect(result.current.start()).rejects.toThrow('当前任务');});expect(result.current.state).toMatchObject({status:'failed',error:'请等待当前任务完成后再压缩会话'});expect(result.current.running).toBe(false);
});
