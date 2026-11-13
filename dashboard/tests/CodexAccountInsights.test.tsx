import {render,screen,fireEvent,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {it,expect,vi} from 'vitest';
import {CodexAccountInsights} from '../src/components/CodexAccountInsights';
import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn()}));
it('loads and groups precise UTC hourly records without changing daily statistics',async()=>{
 const metric={input_tokens:10,cached_input_tokens:0,output_tokens:0,total_tokens:10};
 vi.mocked(fetchJSON).mockImplementation(async path=>path.includes('/insights')?{usage:{initialized:true,partial:false,timezone:'UTC',rows:[{date:'2026-11-11',...path.includes('granularity=hour')?{hour:'2026-11-11T12:00:00Z'}:{},cwd:'/hour-project',estimated_credits:1,tokens:metric,models:[{model:'model',estimated_credits:1,tokens:metric}]}]}}:{account:{},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="hourly" name="Hourly" onClose={()=>{}}/></QueryClientProvider>);
 expect(await screen.findByText('2026-11-11')).toBeVisible();fireEvent.change(screen.getByRole('combobox',{name:'统计维度'}),{target:{value:'hour'}});
 expect(await screen.findByText('2026-11-11 12:00')).toBeVisible();expect(vi.mocked(fetchJSON).mock.calls.some(([url])=>url.includes('granularity=hour'))).toBe(true);
});
it('shows local-day usage, formats collection time in the same zone and explicitly retains unassigned history',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async path=>path.endsWith('insights')?{usage:{initialized:true,partial:true,timezone:'Asia/Taipei',checked_at:'2026-11-11T16:34:39Z',unassigned:{tokens:{total_tokens:100},requests:1,estimated_credits:1},rows:[{date:'2026-11-12',cwd:'/local',estimated_credits:2,tokens:{input_tokens:20,cached_input_tokens:10,output_tokens:0,total_tokens:20}}]}}:{account:{},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="local" name="Local" onClose={()=>{}}/></QueryClientProvider>);
 expect(await screen.findByText('/local')).toBeVisible();expect(screen.getByText(/上次采集/)).toHaveTextContent('2026/11/12 00:34:39');expect(screen.getByText(/上次采集/)).toHaveTextContent('本地时间（Asia/Taipei）');expect(screen.getByText('2026-11-12')).toBeVisible();expect(screen.queryByText(/已保留 100 Token/)).toBeNull();expect(screen.getByText(/周从本地周一开始/)).toBeVisible();
});
it('orders estimated Credits before spend share and uses Credits rather than Token ratios at each level',async()=>{
 const item=(cwd:string,model:string,n:number,credit:number)=>({date:'2026-11-11',cwd,project_name:cwd.slice(1),estimated_credits:credit,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n},models:[{model,estimated_credits:credit,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n}}]});
 vi.mocked(fetchJSON).mockImplementation(async path=>path.endsWith('insights')?{usage:{initialized:true,partial:false,timezone:'UTC',rows:[item('/Alpha','cheap',900,1),item('/Beta','expensive',100,9),item('/Zero','free',0,0)]}}:{account:{},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="credit-share" name="Credits" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/Alpha');const headers=screen.getAllByRole('columnheader').map(h=>h.textContent);expect(headers.slice(-3)).toEqual(['耗用额度','Est. credits','Share']);
 expect(screen.getByText('/Alpha').closest('tr')!.lastElementChild).toHaveTextContent('10.0%');expect(screen.getByText('/Beta').closest('tr')!.lastElementChild).toHaveTextContent('90.0%');expect(screen.getByText('/Zero').closest('tr')!.lastElementChild).toHaveTextContent('0.0%');
 fireEvent.click(screen.getByRole('button',{name:'展开 Alpha 模型'}));expect(screen.getByText('cheap').closest('tr')!.lastElementChild).toHaveTextContent('10.0%');
 fireEvent.change(screen.getByRole('combobox',{name:'统计维度'}),{target:{value:'model'}});expect(screen.getByText('expensive').closest('tr')!.lastElementChild).toHaveTextContent('90.0%');
 fireEvent.change(screen.getByLabelText('搜索项目或目录'),{target:{value:'Zero'}});expect(screen.getByText('free').closest('tr')!.lastElementChild).toHaveTextContent('—');
});
it('opens a centered dialog, exposes reset expiry and expands dates into project usage',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:true,timezone:'UTC',rows:[{date:'2026-01-01',cwd:'/project',estimated_credits:1,tokens:{input_tokens:10,cached_input_tokens:null,output_tokens:0,total_tokens:10}}]}}:{account:{email:'fixture@example.invalid',plan:'pro'},resets:{availableCount:2,credits:[{status:'available',expiresAt:1800000000,grantedAt:1700000000}]}} as any);
 const close=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="a" name="Fixture" onClose={close}/></QueryClientProvider>);
 expect(screen.getByRole('dialog')).toBeVisible();expect(await screen.findByText('/project')).toBeVisible();expect(screen.getAllByText('100.0%')).toHaveLength(2);expect(screen.getByText('Model details unavailable')).toBeVisible();expect(screen.queryByText('0 个模型')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/收起 2026-01-01/}));expect(screen.queryByText('/project')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/展开 2026-01-01/}));expect(screen.getByText('/project')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:/^重置卡/}));expect(await screen.findByText('重置卡：2 张')).toBeVisible();expect(screen.getByText('服务未返回全部卡片明细。')).toBeVisible();
 fireEvent.click(screen.getByLabelText('关闭Fixture 账号详情'));expect(close).toHaveBeenCalledOnce();
});
it('switches dimensions, recomputes range shares and applies dates before grouping',async()=>{
 const item=(date:string,cwd:string,model:string,n:number)=>({date,cwd,project_name:cwd.slice(1),estimated_credits:n/1000,tokens:{input_tokens:n,cached_input_tokens:n/2,output_tokens:0,total_tokens:n},models:[{model,estimated_credits:n/1000,tokens:{input_tokens:n,cached_input_tokens:n/2,output_tokens:0,total_tokens:n}}]});
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:false,timezone:'UTC',rows:[item('2026-11-09','/Alpha','model-one',100),item('2026-11-10','/Alpha','model-two',300),item('2026-11-10','/Beta','model-one',100)]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="c" name="Dimensions" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/Alpha');const dimension=screen.getByRole('combobox',{name:'统计维度'});
 fireEvent.change(dimension,{target:{value:'week'}});expect(screen.getByText('2026-11-09 ~ 2026-11-15')).toBeVisible();expect(screen.getByRole('columnheader',{name:'Share'})).toBeVisible();
 fireEvent.change(dimension,{target:{value:'month'}});expect(screen.getByText('2026-11')).toBeVisible();
 fireEvent.change(dimension,{target:{value:'project'}});expect(screen.getByText('Project / Model / Date')).toBeVisible();const alpha=screen.getByText('/Alpha').closest('tr')!;expect(within(alpha).getByText('80.0%')).toBeVisible();
 fireEvent.change(dimension,{target:{value:'model'}});expect(screen.getByText('Model / Project / Date')).toBeVisible();expect(screen.getByText('model-two')).toBeVisible();expect(screen.getAllByText('60.0%')[0]).toBeVisible();
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-10'}});expect(screen.getAllByText('75.0%')[0]).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索项目或目录'),{target:{value:'Beta'}});expect(screen.queryByText('model-two')).toBeNull();expect(screen.getByText('model-one')).toBeVisible();
});
it('expands project models and computes weighted cache rates with explicit unknown and zero handling',async()=>{
 const metrics=(input:number,cached:number|null)=>({input_tokens:input,cached_input_tokens:cached,output_tokens:0,total_tokens:input});
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:true,timezone:'UTC',progress:{files_complete:3,files_total:10,bytes_read:1048576,bytes_total:2097152},rows:[{date:'2026-01-02',cwd:'/weighted',project_name:'Weighted',estimated_credits:1,tokens:metrics(1000,900),models:[{model:'model-large',estimated_credits:1,tokens:metrics(900,900)},{model:'model-small',estimated_credits:.1,tokens:metrics(100,0)},{model:'model-zero',estimated_credits:0,tokens:metrics(0,0)}]}]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="b" name="Models" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/weighted');expect(screen.getByText(/历史文件 — · 本轮读取 3 \/ 10 个文件/)).toBeVisible();expect(screen.getByRole('columnheader',{name:'Working directory'})).toBeVisible();expect(screen.getByText('/weighted').closest('td')).toHaveAttribute('title','/weighted');expect(within(screen.getByText('2026-01-02').closest('tr')!).getAllByRole('cell')[1]).toBeEmptyDOMElement();
 expect(screen.getAllByText('90.0%')).toHaveLength(2);expect(screen.queryByText('50.0%')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'展开 Weighted 模型'}));expect(screen.getByText('model-large')).toBeVisible();expect(within(screen.getByText('model-large').closest('tr')!).getAllByRole('cell')[1]).toBeEmptyDOMElement();expect(screen.getByText('model-small')).toBeVisible();expect(screen.getByText('model-zero')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'收起 Weighted 模型'}));expect(screen.queryByText('model-large')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'展开本页'}));expect(screen.getByText('model-large')).toBeVisible();
});
it('distinguishes historical inventory and retains rows with unknown estimates',async()=>{
 const metric={tokens:{input_tokens:100,cached_input_tokens:80,output_tokens:10,total_tokens:110},estimated_credits:1};
 vi.mocked(fetchJSON).mockImplementation(async path=>path.endsWith('insights')?{usage:{initialized:true,checked_at:null,partial:false,error:null,timezone:'UTC',progress:{mode:'daily',history_files:965,files_selected:30,files_total:30,files_complete:30,bytes_total:100,bytes_read:100},rows:[{date:'2026-11-11',cwd:'/known',...metric,models:[{model:'known',...metric}]},{date:'2026-11-11',cwd:'/hidden',tokens:metric.tokens,estimated_credits:null,models:[{model:null,tokens:metric.tokens,estimated_credits:null}]}]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="scope" name="Scope" onClose={()=>{}}/></QueryClientProvider>);
 expect(await screen.findByText(/历史文件 965 · 本轮读取 30 \/ 30 个文件/)).toBeVisible();expect(screen.getByText('/hidden')).toBeVisible();expect(screen.queryByText('暂不可估')).toBeNull();expect(screen.getByText('/known')).toBeVisible();expect(screen.getAllByText('100.0%').length).toBeGreaterThan(0);expect(screen.getByText(/2 条日期\/项目记录/)).toBeVisible();
});
it('filters leaves before grouping and sorts parents and children numerically',async()=>{
 const metric=(n:number)=>({input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n});
 const row=(cwd:string,models:Array<{model:string;n:number}>)=>({date:'2026-11-11',cwd,project_name:cwd.split('/').pop(),tokens:metric(models.reduce((s,m)=>s+m.n,0)),estimated_credits:models.reduce((s,m)=>s+m.n,0),models:models.map(m=>({model:m.model,tokens:metric(m.n),estimated_credits:m.n}))});
 vi.mocked(fetchJSON).mockImplementation(async path=>path.endsWith('insights')?{usage:{initialized:true,checked_at:null,partial:false,error:null,timezone:'UTC',rows:[row('/work/dolphindb_manager',[{model:'small',n:9},{model:'large',n:1000}]),row('/work/other',[{model:'other-model',n:200}])]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="filtered" name="Filter" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/work/dolphindb_manager');expect(screen.getByText(/输入（未缓存）/)).toBeVisible();expect(screen.getByText(/输入（缓存）/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'筛选Working directory'}));const filter=screen.getByRole('dialog',{name:'Working directory筛选'});fireEvent.change(within(filter).getByLabelText('Working directory关键词'),{target:{value:'dolphindb_manager'}});fireEvent.click(within(filter).getByRole('button',{name:'筛选'}));
 expect(screen.queryByText('/work/other')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Total tokens排序'}));fireEvent.click(screen.getByRole('button',{name:'Total tokens排序'}));expect(screen.getByRole('columnheader',{name:'Total tokens'})).toHaveAttribute('aria-sort','descending');
 fireEvent.click(screen.getByRole('button',{name:'展开 dolphindb_manager 模型'}));const large=screen.getByText('large').closest('tr')!,small=screen.getByText('small').closest('tr')!;expect(large.compareDocumentPosition(small)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'筛选Total tokens'}));const numbers=screen.getByRole('dialog',{name:'Total tokens筛选'});fireEvent.change(within(numbers).getByLabelText('Total tokens最小值'),{target:{value:'10'}});fireEvent.click(within(numbers).getByRole('button',{name:'筛选'}));expect(screen.queryByText('small')).not.toBeInTheDocument();expect(screen.getAllByText('100.0%').length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'清除全部'}));expect(screen.getByText('/work/other')).toBeVisible();expect(screen.getByRole('columnheader',{name:'Total tokens'})).toHaveAttribute('aria-sort','none');
});
