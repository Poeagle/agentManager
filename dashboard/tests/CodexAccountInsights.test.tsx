import {render,screen,fireEvent,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {it,expect,vi} from 'vitest';
import {CodexAccountInsights} from '../src/components/CodexAccountInsights';
import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn()}));
it('opens a centered dialog, exposes reset expiry and expands dates into project usage',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:true,timezone:'UTC',rows:[{date:'2026-01-01',cwd:'/project',tokens:{input_tokens:10,cached_input_tokens:null,output_tokens:0,total_tokens:10}}]}}:{account:{email:'fixture@example.invalid',plan:'pro'},resets:{availableCount:2,credits:[{status:'available',expiresAt:1800000000,grantedAt:1700000000}]}} as any);
 const close=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="a" name="Fixture" onClose={close}/></QueryClientProvider>);
 expect(screen.getByRole('dialog')).toBeVisible();expect(await screen.findByText('/project')).toBeVisible();expect(screen.getAllByText('100.0%')).toHaveLength(2);expect(screen.getByText('模型明细未返回')).toBeVisible();expect(screen.queryByText('0 个模型')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/收起 2026-01-01/}));expect(screen.queryByText('/project')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/展开 2026-01-01/}));expect(screen.getByText('/project')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:/查看卡片与到期时间/}));expect(await screen.findByText('重置卡：2 张')).toBeVisible();expect(screen.getByText('服务未返回全部卡片明细。')).toBeVisible();
 fireEvent.click(screen.getByLabelText('关闭Fixture 账号详情'));expect(close).toHaveBeenCalledOnce();
});
it('switches dimensions, recomputes range shares and applies dates before grouping',async()=>{
 const item=(date:string,cwd:string,model:string,n:number)=>({date,cwd,project_name:cwd.slice(1),tokens:{input_tokens:n,cached_input_tokens:n/2,output_tokens:0,total_tokens:n},models:[{model,tokens:{input_tokens:n,cached_input_tokens:n/2,output_tokens:0,total_tokens:n}}]});
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:false,timezone:'UTC',rows:[item('2026-11-09','/Alpha','model-one',100),item('2026-11-10','/Alpha','model-two',300),item('2026-11-10','/Beta','model-one',100)]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="c" name="Dimensions" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/Alpha');const dimension=screen.getByRole('combobox',{name:'统计维度'});
 fireEvent.change(dimension,{target:{value:'week'}});expect(screen.getByText('2026-11-09 ~ 2026-11-15')).toBeVisible();expect(screen.getByText('当周占比')).toBeVisible();
 fireEvent.change(dimension,{target:{value:'month'}});expect(screen.getByText('2026-11')).toBeVisible();
 fireEvent.change(dimension,{target:{value:'project'}});expect(screen.getByText('项目 / 模型 / 日期')).toBeVisible();const alpha=screen.getByText('/Alpha').closest('tr')!;expect(within(alpha).getByText('80.0%')).toBeVisible();
 fireEvent.change(dimension,{target:{value:'model'}});expect(screen.getByText('模型 / 项目 / 日期')).toBeVisible();expect(screen.getByText('model-two')).toBeVisible();expect(screen.getAllByText('60.0%')[0]).toBeVisible();
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-10'}});expect(screen.getAllByText('75.0%')[0]).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索项目或目录'),{target:{value:'Beta'}});expect(screen.queryByText('model-two')).toBeNull();expect(screen.getByText('model-one')).toBeVisible();
});
it('expands project models and computes weighted cache rates with explicit unknown and zero handling',async()=>{
 const metrics=(input:number,cached:number|null)=>({input_tokens:input,cached_input_tokens:cached,output_tokens:0,total_tokens:input});
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:true,timezone:'UTC',progress:{files_complete:3,files_total:10,bytes_read:1048576,bytes_total:2097152},rows:[{date:'2026-01-02',cwd:'/weighted',project_name:'Weighted',tokens:metrics(1000,900),models:[{model:'model-large',tokens:metrics(900,900)},{model:'model-small',tokens:metrics(100,0)},{model:null,tokens:metrics(0,0)}]}]}}:{account:{email:null,plan:null},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="b" name="Models" onClose={()=>{}}/></QueryClientProvider>);
 await screen.findByText('/weighted');expect(screen.getByText(/已处理 3 \/ 10 个会话文件/)).toBeVisible();
 expect(screen.getAllByText('90.0%')).toHaveLength(2);expect(screen.queryByText('50.0%')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'展开 Weighted 模型'}));expect(screen.getByText('model-large')).toBeVisible();expect(screen.getByText('model-small')).toBeVisible();expect(screen.getByText('模型未记录')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'收起 Weighted 模型'}));expect(screen.queryByText('model-large')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'展开本页'}));expect(screen.getByText('model-large')).toBeVisible();
});
