import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {CodexEngineBalanceGroup,CodexEngineBalanceIndicator} from '../src/components/CodexEngineBalance';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn(async(url:string)=>url.endsWith('/balance')?{auth_mode:'api',status:'stale',amount:42,currency:'USD',todayActualCost:1.25,error:'timeout'}:{usage:{rows:[],partial:false,initialized:true,checked_at:null}})}));
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
 expect(await screen.findByText('$42.00')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'查看 Host 上游余额详情'}));
 expect(screen.getByRole('dialog',{name:'Host 上游详情'})).toBeVisible();expect(screen.getByText('API A')).toBeVisible();expect(screen.getByRole('navigation',{name:'上游详情栏目'})).toHaveTextContent('合并会话用量');expect(screen.queryByText('重置卡')).not.toBeInTheDocument();view.unmount();client.clear();
});
