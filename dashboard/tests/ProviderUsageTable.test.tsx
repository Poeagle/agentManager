import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {ProviderUsageTable} from '../src/components/ProviderUsageTable';
import {api,type ProviderUsageTab} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{codexEnvironments:{usage:vi.fn(),closeTabs:vi.fn()}}}));
let client:QueryClient,tabs:ProviderUsageTab[];
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});tabs=['xlli','ymchen'].map((name,i)=>({id:'s'+i,user_id:name,username:name,project_id:'p',project_name:'Project',name:'Tab '+name,status:'running',native_id:'native'+i,model:'Model',busy:false}));vi.mocked(api.codexEnvironments.usage).mockImplementation(async()=>({tabs,busy:false,verified:true}));});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><ProviderUsageTable environmentId="account:fixture"/></QueryClientProvider>);
describe('all-user Provider occupancy table',()=>{
 it('lists idle tabs belonging to every user and confirms selected bulk deletion',async()=>{mount();await screen.findByRole('table',{name:'Provider 占用标签页列表'});expect(await screen.findByText('xlli')).toBeVisible();expect(screen.getByText('ymchen')).toBeVisible();fireEvent.click(screen.getByRole('checkbox',{name:'全选占用标签页'}));fireEvent.click(screen.getByRole('button',{name:'批量删除标签页（2）'}));expect(api.codexEnvironments.closeTabs).not.toHaveBeenCalled();expect(screen.getByText(/会话历史保留/)).toBeVisible();vi.mocked(api.codexEnvironments.closeTabs).mockImplementationOnce(async()=>{tabs=[];return {results:[{id:'s0',ok:true},{id:'s1',ok:true}]};});fireEvent.click(screen.getByRole('button',{name:'确认删除标签页'}));await waitFor(()=>expect(api.codexEnvironments.closeTabs).toHaveBeenCalledWith('account:fixture',['s0','s1']));expect(await screen.findByText('当前没有用户占用此 Provider。')).toBeVisible();});
 it('retains failed tabs and reports a partial failure instead of clearing the whole list',async()=>{mount();await screen.findByRole('checkbox',{name:'全选占用标签页'});fireEvent.click(screen.getByRole('checkbox',{name:'全选占用标签页'}));fireEvent.click(screen.getByRole('button',{name:'批量删除标签页（2）'}));vi.mocked(api.codexEnvironments.closeTabs).mockImplementationOnce(async()=>{tabs=tabs.slice(1);return {results:[{id:'s0',ok:true},{id:'s1',ok:false,error:'后台未停止'}]};});fireEvent.click(screen.getByRole('button',{name:'确认删除标签页'}));expect(await screen.findByRole('alert')).toHaveTextContent('后台未停止');expect(screen.getByRole('checkbox',{name:'选择标签页 Tab ymchen'})).toBeChecked();expect(screen.queryByText('Tab xlli')).not.toBeInTheDocument();});
});
