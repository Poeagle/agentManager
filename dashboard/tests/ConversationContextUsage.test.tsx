import {render,screen,fireEvent,within,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ConversationContextUsage} from '../src/components/ConversationContextUsage';
import {api,type ConversationContextBreakdown} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{agent:{contextBreakdown:vi.fn()}}}));
let client:QueryClient,data:ConversationContextBreakdown;
beforeEach(()=>{client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(api.agent.contextBreakdown).mockReset();data={source:'jsonl',exact:false,method:'characters_div_3',checked_at:'2026-11-11T13:00:00Z',observed_at:'2026-11-11T12:00:00Z',model:'fixture-model',usage:{last:{total_tokens:12000},total:{},window:40000},partial:false,warnings:[],files_read:1,records_read:8,bytes_read:1024,compactions:1,categories:[{id:'user',name:'用户消息',tokens:100,count:2,detail:[]},{id:'results',name:'工具结果',tokens:300,count:1,detail:[{name:'read_file',tokens:300,count:1}]},{id:'tools',name:'工具 schemas',tokens:null,count:0,detail:[]}]};vi.mocked(api.agent.contextBreakdown).mockImplementation(async()=>({context:data}));});
afterEach(()=>client.clear());
const mount=(nativeId='n')=>render(<QueryClientProvider client={client}><ConversationContextUsage sessionId="s" nativeId={nativeId} usage={{last:{total_tokens:24000},total:{total_tokens:900000},window:40000}} observedAt="2026-11-11T12:30:00Z" model="fixture-model" onClose={()=>{}}/></QueryClientProvider>);
it('separates actual latest context from approximate category shares and retains unknown values',async()=>{
 mount();expect(await screen.findByRole('table',{name:'上下文分类 Token'})).toBeVisible();const dialog=screen.getByRole('dialog');expect(dialog).toHaveTextContent('24,000 / 40,000');expect(dialog).toHaveTextContent('60.0%');expect(dialog).not.toHaveTextContent('900,000');
 const user=screen.getByRole('rowheader',{name:'用户消息'}).closest('tr')!;expect(within(user).getByText('25.0%')).toBeVisible();const unknown=screen.getByRole('rowheader',{name:'工具 schemas'}).closest('tr')!;expect(within(unknown).getByText('未提供')).toBeVisible();expect(within(unknown).getAllByText('—')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'展开工具结果明细'}));expect(screen.getByRole('rowheader',{name:'└ read_file'})).toBeVisible();expect(dialog).toHaveTextContent('字符数 ÷ 3');expect(api.agent.contextBreakdown).toHaveBeenCalledWith('s',false,expect.any(AbortSignal));
});
it('reuses cached categories on reopen and only explicitly refreshes the JSONL endpoint',async()=>{
 const view=mount();await screen.findByRole('table');view.unmount();mount();await screen.findByRole('table');expect(api.agent.contextBreakdown).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole('button',{name:'重新读取'}));await waitFor(()=>expect(api.agent.contextBreakdown).toHaveBeenCalledTimes(2));expect(api.agent.contextBreakdown).toHaveBeenLastCalledWith('s',true,expect.any(AbortSignal));
});
it('isolates the native thread, handles zero category totals and reports partial or failed reads',async()=>{
 data={...data,partial:true,warnings:['压缩记录未提供完整替换历史'],categories:[{id:'user',name:'用户消息',tokens:0,count:0,detail:[]}]};mount('another-native');await screen.findByRole('table');expect(screen.getByText('部分日志')).toBeVisible();expect(screen.getByRole('status')).toHaveTextContent('压缩记录未提供完整替换历史');expect(screen.getByRole('rowheader',{name:'用户消息'}).closest('tr')).toHaveTextContent('—');
 vi.mocked(api.agent.contextBreakdown).mockRejectedValueOnce(new Error('当前 Agent 不支持上下文分类'));fireEvent.click(screen.getByRole('button',{name:'重新读取'}));expect(await screen.findByRole('alert')).toHaveTextContent('当前 Agent 不支持上下文分类');expect(screen.getByRole('table')).toBeVisible();
});
