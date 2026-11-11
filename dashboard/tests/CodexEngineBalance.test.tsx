import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,within} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {CodexEngineBalanceGroup,CodexEngineBalanceIndicator} from '../src/components/CodexEngineBalance';
import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn(async(url:string)=>url.endsWith('/balance')?{auth_mode:'api',status:'stale',amount:42,currency:'USD',todayActualCost:1.25,error:'timeout',checkedAt:'2026-01-01T00:00:00Z',origin:'https://api.example.invalid'}:{usage:{rows:[],partial:false,initialized:true,checked_at:null}})}));
it('opens a wallet with actual cost, stale status and a clear error',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><CodexEngineBalanceIndicator id="native" name="Engine"/></QueryClientProvider>);
 expect(await screen.findByText('$42.00')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看 Engine API 余额详情'}));
 expect(screen.getByRole('dialog',{name:'Engine API 详情'})).toBeVisible();expect(screen.getByText('$1.25')).toBeVisible();expect(screen.getByText('余额查询超时')).toBeVisible();expect(screen.getByText('上次成功数据 · 已过期')).toBeVisible();
 view.unmount();client.clear();
});
it('opens one upstream detail for multiple providers with the common statistics view',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const view=render(<QueryClientProvider client={client}><CodexEngineBalanceGroup group="group" members={[{id:'native',name:'Host'},{id:'provider:a',name:'API A'}]}/></QueryClientProvider>);
 expect(await screen.findByText('$42.00')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看 API A 上游余额详情'}));
 const dialog=screen.getByRole('dialog',{name:'API A 上游详情'});expect(dialog).toBeVisible();expect(within(dialog).getAllByRole('link',{name:'https://api.example.invalid'})).toHaveLength(2);for(const link of within(dialog).getAllByRole('link',{name:'https://api.example.invalid'})){expect(link).toHaveAttribute('href','https://api.example.invalid/');expect(link).toHaveAttribute('target','_blank');expect(link).toHaveAttribute('rel','noopener noreferrer');}expect(within(dialog).getByRole('table',{name:'Provider 钱包与实际扣费'})).toHaveTextContent('Provider 数量');expect(within(dialog).getAllByText(/\$42\.00/)).toHaveLength(2);expect(screen.queryByText('重置卡')).not.toBeInTheDocument();view.unmount();client.clear();
});
it('shows each balance when providers disagree',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async(url:string)=>url.endsWith('/balance')?{auth_mode:'api',status:'available',amount:url.includes('provider%3Aa')?18:42,currency:'USD'} as any:{usage:{rows:[],partial:false}} as any);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><CodexEngineBalanceGroup group="group" members={[{id:'native',name:'Host'},{id:'provider:a',name:'API A'}]}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'查看 API A 上游余额详情'}));const dialog=await screen.findByRole('dialog',{name:'API A 上游详情'});expect(within(dialog).getAllByText(/余额不一致/)).toHaveLength(2);expect(within(dialog).getByText(/\$42\.00/)).toBeVisible();expect(within(dialog).getByText(/\$18\.00/)).toBeVisible();view.unmount();client.clear();vi.restoreAllMocks();
});

it('does not turn an unsafe upstream URL into a link',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async(url:string)=>url.endsWith('/balance')?{auth_mode:'api',status:'available',amount:42,currency:'USD',origin:'javascript:alert(1)'} as any:{usage:{rows:[],partial:false}} as any);
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><CodexEngineBalanceGroup group="group" members={[{id:'native',name:'Host'}]}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'查看 Host 上游余额详情'}));const dialog=await screen.findByRole('dialog',{name:'Host 上游详情'});expect(within(dialog).queryByRole('link',{name:'javascript:alert(1)'})).not.toBeInTheDocument();expect(dialog).toHaveTextContent('未提供');view.unmount();client.clear();
});
