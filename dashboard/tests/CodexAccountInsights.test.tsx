import {render,screen,fireEvent} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {it,expect,vi} from 'vitest';
import {CodexAccountInsights} from '../src/components/CodexAccountInsights';
import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn()}));
it('opens a centered dialog, exposes reset expiry and expands dates into project usage',async()=>{
 vi.mocked(fetchJSON).mockImplementation(async(path)=>path.endsWith('insights')?{usage:{checked_at:null,error:null,partial:true,timezone:'UTC',rows:[{date:'2026-01-01',cwd:'/project',tokens:{input_tokens:10,cached_input_tokens:null,output_tokens:0,total_tokens:10}}]}}:{account:{email:'fixture@example.invalid',plan:'pro'},resets:{availableCount:2,credits:[{status:'available',expiresAt:1800000000,grantedAt:1700000000}]}} as any);
 const close=vi.fn();render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CodexAccountInsights id="a" name="Fixture" onClose={close}/></QueryClientProvider>);
 expect(screen.getByRole('dialog')).toBeVisible();expect(await screen.findByText('/project')).toBeVisible();expect(screen.getByText('100.0%')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:/收起 2026-01-01/}));expect(screen.queryByText('/project')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/展开 2026-01-01/}));expect(screen.getByText('/project')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:/查看卡片与到期时间/}));expect(await screen.findByText('重置卡：2 张')).toBeVisible();expect(screen.getByText('服务未返回全部卡片明细。')).toBeVisible();
 fireEvent.click(screen.getByLabelText('关闭Fixture 账号详情'));expect(close).toHaveBeenCalledOnce();
});
