import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,waitFor,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentQuotaIndicators} from '../src/components/AgentQuotaIndicator';
import {api} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{const actual=await original<typeof import('../src/lib/api')>();return {...actual,api:{...actual.api,codexEnvironments:{list:vi.fn(),quota:vi.fn()},agentQuota:{read:vi.fn()}}};});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
afterEach(()=>{client.clear();vi.clearAllMocks();});
const mount=()=>render(<QueryClientProvider client={client}><AgentQuotaIndicators/></QueryClientProvider>);
it('hides Codex quota when no enabled account is available',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'native',name:'Native',kind:'native',enabled:true,allowed_user_ids:null}]});
 const view=mount();await waitFor(()=>expect(client.getQueryData(['codex-environments'])).toBeDefined());
 expect(view.container).toBeEmptyDOMElement();expect(api.agentQuota.read).not.toHaveBeenCalled();expect(api.codexEnvironments.quota).not.toHaveBeenCalled();
});
it('shows separate account names and quotas and refreshes only the selected account',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:['a','b'].map(id=>({id,name:id,kind:'account',enabled:true,allowed_user_ids:null}))});
 vi.mocked(api.codexEnvironments.quota).mockImplementation(async id=>({quota:{usedPercent:id==='a'?20:60,remainingPercent:id==='a'?80:40,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}}));
 mount();expect(await screen.findByLabelText('Codex · a 周额度剩余 80%')).toBeVisible();expect(await screen.findByLabelText('Codex · b 周额度剩余 40%')).toBeVisible();
 vi.mocked(api.codexEnvironments.quota).mockClear();fireEvent.click(screen.getByRole('button',{name:'刷新 Codex · b 额度'}));await waitFor(()=>expect(api.codexEnvironments.quota).toHaveBeenCalledExactlyOnceWith('b'));
});
