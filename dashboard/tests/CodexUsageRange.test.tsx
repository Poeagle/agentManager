import {render,screen,fireEvent,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {expect,it,vi} from 'vitest';
import {CodexAccountInsights} from '../src/components/CodexAccountInsights';
import {usageFieldDescriptions} from '../src/components/use-usage-table';
import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn()}));
const item=(date:string,cwd:string,n:number)=>({date,cwd,project_name:cwd.slice(1),estimated_credits:n,estimated_usd:n,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n},models:[{model:'fixture-model',estimated_credits:n,estimated_usd:n,tokens:{input_tokens:n,cached_input_tokens:0,output_tokens:0,total_tokens:n}}]});
const rows=[item('2026-11-08','/Before',100),item('2026-11-09','/A',90),item('2026-11-09','/B',10),item('2026-11-14','/A',10),item('2026-11-14','/B',90),item('2026-11-15','/A',20),item('2026-11-15','/B',80),item('2026-11-30','/After',100),item('2026-12-01','/December',500)];
const quota_hours=[['2026-11-08',5],['2026-11-09',1],['2026-11-14',3],['2026-11-15',2],['2026-11-30',4],['2026-12-01',7]].map(([date,quota])=>({hour:`${date}T01:00:00+08:00`,quota:Number(quota)}));
function mount(api=false,hours:typeof quota_hours|null=quota_hours){
 vi.mocked(fetchJSON).mockImplementation(async path=>path.includes('/insights')?{usage:{checked_at:'2026-12-01T08:00:00Z',initialized:true,partial:false,timezone:'Asia/Taipei',rows:hours===null?rows.map(row=>({...row,actual_quota:9,models:row.models.map(model=>({...model,actual_quota:9}))})):rows,quota_hours:hours??undefined}}:{account:{},resets:null} as any);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="range-fixture" name="Fixture" onClose={()=>{}} groupId={api?'provider-fixture':undefined}/></QueryClientProvider>);
}
const dimension=(value:string)=>fireEvent.change(screen.getByLabelText('统计维度'),{target:{value}});
function dates(){fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-14'}});fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-11-15'}});}
const project=(name:string)=>screen.getByText(name,{exact:true}).closest('tr')!;
const cell=(row:HTMLTableRowElement,key:string)=>key==='cost'?row.querySelector('.ci-usage-cost')!:Array.from(row.querySelectorAll('td')).find(value=>value.getAttribute('data-field-description')===usageFieldDescriptions[key])!;
it('uses full natural weeks and months but exact selected dates for total, with one allocation denominator',async()=>{
 mount();await screen.findByText('/December');dates();dimension('total');
 const root=screen.getByText('2026-11-14 ~ 2026-11-15',{exact:true}).closest('tr')!;
 expect(cell(root,'total')).toHaveTextContent('200');expect(cell(root,'cost')).toHaveTextContent('200.00 | 5 (40)');
 expect(cell(project('/A'),'cost')).toHaveTextContent('30.00 | 0.75 (40)');expect(cell(project('/A'),'share')).toHaveTextContent('15.0%');
 fireEvent.change(screen.getByLabelText('搜索项目或目录'),{target:{value:'A'}});expect(cell(project('/A'),'cost')).toHaveTextContent('30.00 | 0.75 (40)');expect(cell(project('/A'),'share')).toHaveTextContent('15.0%');expect(screen.getByText('2026-11-14 ~ 2026-11-15',{exact:true})).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索项目或目录'),{target:{value:''}});dimension('week');
 expect(screen.getByText('2026-11-09 ~ 2026-11-15',{exact:true})).toBeVisible();expect(screen.getByText('统计范围：2026-11-09 ~ 2026-11-15')).toBeVisible();
 expect(cell(project('/A'),'cost')).toHaveTextContent('120.00 | 2.4 (50)');expect(cell(project('/B'),'cost')).toHaveTextContent('180.00 | 3.6 (50)');expect(screen.queryByText('/Before')).toBeNull();expect(screen.queryByText('/After')).toBeNull();
 expect(screen.getByLabelText('开始日期')).toHaveValue('2026-11-14');expect(screen.getByLabelText('结束日期')).toHaveValue('2026-11-15');
 dimension('month');expect(screen.getByText('统计范围：2026-11-01 ~ 2026-11-30')).toBeVisible();expect(cell(project('/A'),'cost')).toHaveTextContent('120.00 | 3.6 (33.33)');expect(screen.getByText('/Before')).toBeVisible();expect(screen.getByText('/After')).toBeVisible();expect(screen.queryByText('/December')).toBeNull();
 dimension('total');expect(cell(project('/A'),'cost')).toHaveTextContent('30.00 | 0.75 (40)');
});
it('supports API engines with the same total and calendar ranges while keeping subscription columns hidden',async()=>{
 mount(true);await screen.findByText('/December');dates();const requests=vi.mocked(fetchJSON).mock.calls.length;dimension('total');
 const root=screen.getByText('2026-11-14 ~ 2026-11-15',{exact:true}).closest('tr')!;expect(cell(root,'total')).toHaveTextContent('200');
 expect(screen.queryByRole('columnheader',{name:'耗用额度'})).toBeNull();expect(screen.queryByRole('columnheader',{name:'耗用积分 | 额度'})).toBeNull();expect(screen.queryByRole('columnheader',{name:'占比'})).toBeNull();
 dimension('week');expect(screen.getByText('统计范围：2026-11-09 ~ 2026-11-15')).toBeVisible();expect(vi.mocked(fetchJSON).mock.calls.length).toBe(requests);
});
it('does not fabricate total quota from daily allocations when hourly observation data is absent',async()=>{
 mount(false,null);await screen.findByText('/December');dates();dimension('total');
 expect(cell(project('/A'),'cost').textContent).toBe('30.00 | — (—)');
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-16'}});dimension('week');expect(screen.getByText('所选范围暂无用量记录')).toBeVisible();
});
