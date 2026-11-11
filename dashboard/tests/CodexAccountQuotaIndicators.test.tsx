import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,waitFor,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentQuotaIndicators} from '../src/components/AgentQuotaIndicator';
import {api} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{const actual=await original<typeof import('../src/lib/api')>();return {...actual,api:{...actual.api,codexEnvironments:{list:vi.fn(),quota:vi.fn()},agentQuota:{read:vi.fn()}}};});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
afterEach(()=>{client.clear();vi.clearAllMocks();});
const mount=(isAdmin=true)=>render(<QueryClientProvider client={client}><AgentQuotaIndicators isAdmin={isAdmin}/></QueryClientProvider>);
it('keeps member quota visible while exposing no clickable card or refresh controls',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'member',name:'成员账号',kind:'account',auth_mode:'account',enabled:true,allowed_user_ids:null}]});
 vi.mocked(api.codexEnvironments.quota).mockResolvedValue({quota:{usedPercent:25,remainingPercent:75,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}});
 mount(false);const card=await screen.findByLabelText('codex · 成员账号 周额度剩余 75%');fireEvent.click(card);expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('button',{name:/查看.*账号详情/})).toBeNull();expect(screen.queryByRole('button',{name:/刷新.*额度/})).toBeNull();
});
it('shows the account details control to administrators',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'admin',name:'管理员账号',kind:'account',auth_mode:'account',enabled:true,allowed_user_ids:null}]});vi.mocked(api.codexEnvironments.quota).mockResolvedValue({quota:null,reason:'not_applicable'});
 mount(true);expect(await screen.findByRole('button',{name:'查看 codex · 管理员账号 账号详情'})).toBeVisible();expect(screen.getByRole('button',{name:'刷新 codex · 管理员账号 额度'})).toBeVisible();
});
it('hides Codex quota when no enabled account is available',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'native',name:'Native',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]});
 vi.mocked(api.codexEnvironments.quota).mockResolvedValue({quota:null,reason:'not_applicable'});
 const view=mount();await waitFor(()=>expect(client.getQueryData(['codex-environments'])).toBeDefined());
 await waitFor(()=>expect(view.container).toBeEmptyDOMElement());expect(api.agentQuota.read).not.toHaveBeenCalled();expect(api.codexEnvironments.quota).toHaveBeenCalledWith('native');
});
it('shows separate account names and quotas and refreshes only the selected account',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:['a','b'].map(id=>({id,name:id,kind:'account',auth_mode:'account',enabled:true,allowed_user_ids:null}))});
 vi.mocked(api.codexEnvironments.quota).mockImplementation(async id=>({quota:{usedPercent:id==='a'?20:60,remainingPercent:id==='a'?80:40,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}}));
 mount();expect(await screen.findByLabelText('codex · a 周额度剩余 80%')).toBeVisible();expect(await screen.findByLabelText('codex · b 周额度剩余 40%')).toBeVisible();
 vi.mocked(api.codexEnvironments.quota).mockClear();fireEvent.click(screen.getByRole('button',{name:'刷新 codex · b 额度'}));await waitFor(()=>expect(api.codexEnvironments.quota).toHaveBeenCalledExactlyOnceWith('b'));
});

it('includes a logged-in native account alongside configured accounts',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'native',name:'本机账号',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null},{id:'extra',name:'其他账号',kind:'account',auth_mode:'account',enabled:true,allowed_user_ids:null}]});
 vi.mocked(api.codexEnvironments.quota).mockResolvedValue({quota:{usedPercent:25,remainingPercent:75,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}});
 mount();expect(await screen.findByLabelText('codex · 本机账号 周额度剩余 75%')).toBeVisible();expect(await screen.findByLabelText('codex · 其他账号 周额度剩余 75%')).toBeVisible();
});

it('keeps the native account visible after a quota error and allows retry',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[{id:'native',name:'本机账号',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]});
 vi.mocked(api.codexEnvironments.quota).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({quota:{usedPercent:30,remainingPercent:70,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}});
 mount();expect(await screen.findByText('不可用')).toBeVisible();expect(screen.getByText('codex · 本机账号')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'刷新 codex · 本机账号 额度'}));expect(await screen.findByLabelText('codex · 本机账号 周额度剩余 70%')).toBeVisible();
});

it('updates the header name immediately after the environment list is invalidated',async()=>{
 vi.mocked(api.codexEnvironments.list).mockResolvedValueOnce({environments:[{id:'native',name:'旧名称',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]}).mockResolvedValueOnce({environments:[{id:'native',name:'新名称',kind:'native',auth_mode:'account',enabled:true,allowed_user_ids:null}]});
 vi.mocked(api.codexEnvironments.quota).mockResolvedValue({quota:{usedPercent:25,remainingPercent:75,windowDurationMins:10080,resetsAt:null,planType:null,checkedAt:'2026-11-09T00:00:00Z'}});
 mount();expect(await screen.findByLabelText('codex · 旧名称 周额度剩余 75%')).toBeVisible();
 await client.invalidateQueries({queryKey:['codex-environments']});expect(await screen.findByLabelText('codex · 新名称 周额度剩余 75%')).toBeVisible();expect(screen.queryByLabelText('codex · 旧名称 周额度剩余 75%')).not.toBeInTheDocument();
});
