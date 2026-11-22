import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentModelInformation} from '../src/components/AgentModelInformation';
import {api} from '../src/lib/api';

vi.mock('../src/lib/api',async original=>{
 const actual=await original<typeof import('../src/lib/api')>();
 return {...actual,api:{...actual.api,agentManagement:{...actual.api.agentManagement,modelCatalog:vi.fn()}}};
});

afterEach(()=>vi.clearAllMocks());

it('shows the vendor, release, context, and separated official token rates in one table',async()=>{
 vi.mocked(api.agentManagement.modelCatalog).mockResolvedValue({models:[{
  vendor:'DeepSeek',model:'deepseek-v4.1-flash',providers:['DeepSeek API'],release_date:'2026-10-17',context_window:1_000_000,
  api_pricing:{currency:'CNY',source:'official',peak:{input:2,cached:0.04,output:8},off_peak:{input:1,cached:0.02,output:4},timezone:'Asia/Shanghai'},
 }]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><AgentModelInformation/></QueryClientProvider>);
 const table=await screen.findByRole('table',{name:'模型资料'});await within(table).findByText('deepseek-v4.1-flash');const row=within(table).getByRole('row',{name:/DeepSeek/});
 expect(row).toHaveTextContent('deepseek-v4.1-flash');expect(row).toHaveTextContent('2026-10-17');expect(row).toHaveTextContent('1,000,000');
 expect(row).toHaveTextContent('高峰 CNY 2.00 · 空闲 CNY 1.00');
 expect(row).toHaveTextContent('高峰 CNY 8.00 · 空闲 CNY 4.00');
 expect(row).toHaveTextContent('高峰 CNY 0.04 · 空闲 CNY 0.02');
 client.clear();
});

it('shows every official context pricing band for GPT models in the catalog table',async()=>{
 vi.mocked(api.agentManagement.modelCatalog).mockResolvedValue({models:[{
  vendor:'OpenAI',model:'gpt-6.2-sol',providers:['OpenAI API'],release_date:'2026-11-17',context_window:1_050_000,
  api_pricing:{currency:'USD',source:'official',bands:[
   {label:'≤ 272K 输入 Token',min_input_tokens:0,rates:{input:2,cached:0.1,output:10}},
   {label:'> 272K 输入 Token',min_input_tokens:272_001,rates:{input:4,cached:0.2,output:15}},
  ]},
 }]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><AgentModelInformation/></QueryClientProvider>);
 const table=await screen.findByRole('table',{name:'模型资料'});
 await within(table).findByText('gpt-6.2-sol');
 const row=within(table).getByRole('row',{name:/gpt-6\.2-sol/});
 expect(row).toHaveTextContent('≤ 272K 输入 Token USD 2.00');
 expect(row).toHaveTextContent('> 272K 输入 Token USD 4.00');
 expect(row).toHaveTextContent('≤ 272K 输入 Token USD 10.00');
 expect(row).toHaveTextContent('> 272K 输入 Token USD 15.00');
 expect(row).toHaveTextContent('≤ 272K 输入 Token USD 0.10');
 expect(row).toHaveTextContent('> 272K 输入 Token USD 0.20');
 client.clear();
});

it('keeps missing official prices explicit instead of displaying a fabricated value',async()=>{
 vi.mocked(api.agentManagement.modelCatalog).mockResolvedValue({models:[{vendor:'其他',model:'private-model',providers:['Custom API']}]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><AgentModelInformation/></QueryClientProvider>);
 const table=await screen.findByRole('table',{name:'模型资料'});await within(table).findByText('private-model');const row=within(table).getByRole('row',{name:/private-model/});
 expect(row).toHaveTextContent('未提供');
 client.clear();
});

it('shows verified Claude context and release metadata from the official catalog',async()=>{
 vi.mocked(api.agentManagement.modelCatalog).mockResolvedValue({models:[{
  vendor:'Anthropic',model:'claude-sonnet-5-5',providers:['Anthropic'],release_date:'2026-09-28',
  official_context_window:1_000_000,context_window:1_000_000,input_modalities:['text','image'],
  api_pricing:{currency:'USD',source:'official',bands:[{rates:{input:2,cached:0.1,output:10}}]},
 }]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><AgentModelInformation/></QueryClientProvider>);
 const table=await screen.findByRole('table',{name:'模型资料'});
 const row=await within(table).findByRole('row',{name:/claude-sonnet-5-5/});
 expect(row).toHaveTextContent('2026-09-28');
 expect(row).toHaveTextContent('1,000,000');
 expect(row).toHaveTextContent('USD 2.00');
 client.clear();
});
