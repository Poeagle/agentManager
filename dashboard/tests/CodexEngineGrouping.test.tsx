import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {CodexAccountQuotaIndicators} from '../src/components/CodexAccountQuotaIndicators';
vi.mock('../src/lib/api',()=>({api:{codexEnvironments:{list:vi.fn(async()=>({environments:[{id:'native',name:'host',enabled:true,auth_mode:'api',balance_group:'same'},{id:'provider:x',name:'second',enabled:true,auth_mode:'api',balance_group:'same'},{id:'provider:y',name:'different',enabled:true,auth_mode:'api',balance_group:'different'}]}))}}}));
vi.mock('../src/components/CodexEngineBalance',()=>({CodexEngineBalanceIndicator:({name}:{name:string})=><span>single {name}</span>,CodexEngineBalanceGroup:({members}:{members:Array<{name:string}>})=><span>group {members.map(m=>m.name).join(',')}</span>}));
vi.mock('../src/components/AgentQuotaIndicator',()=>({AgentQuotaIndicator:()=>null}));
vi.mock('../src/components/CodexAccountInsights',()=>({CodexAccountInsights:()=>null}));
it('shows one card for each upstream group',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={client}><CodexAccountQuotaIndicators agent={{id:'codex',label:'Codex'} as any} isAdmin/></QueryClientProvider>);
 expect(await screen.findByText('group host,second')).toBeVisible();expect(screen.getByText('group different')).toBeVisible();expect(screen.queryByText('single second')).not.toBeInTheDocument();view.unmount();client.clear();
});
