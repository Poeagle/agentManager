import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {ProviderDeleteDialog} from '../src/components/ProviderDeleteDialog';
import {api,type ProviderUsageTab} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{codexEnvironments:{usage:vi.fn(),closeTabs:vi.fn()}}}));
let client:QueryClient,tabs:ProviderUsageTab[];
const remove=vi.fn(),cancel=vi.fn();
function mount(){return render(<QueryClientProvider client={client}><ProviderDeleteDialog environmentId="provider:fixture" name="Fixture" message="关闭占用后才能删除。" onDelete={remove} onCancel={cancel}/></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});tabs=['xlli','ymchen'].map((name,i)=>({id:'s'+i,user_id:name,username:name,project_id:'p',project_name:'Project',name:'Tab '+name,status:'cancelled',native_id:null,model:null,busy:false}));vi.mocked(api.codexEnvironments.usage).mockImplementation(async()=>({tabs,busy:false,verified:true}));remove.mockResolvedValue({ok:true});});
afterEach(()=>client.clear());
describe('Provider deletion dialog',()=>{
 it('requires all users to release tabs, then enables explicit Provider deletion after bulk close',async()=>{
  mount();await screen.findByRole('checkbox',{name:'全选占用标签页'});expect(screen.getByRole('button',{name:'确认删除 Provider'})).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:'全选占用标签页'}));fireEvent.click(screen.getByRole('button',{name:'批量删除标签页（2）'}));
  vi.mocked(api.codexEnvironments.closeTabs).mockImplementationOnce(async()=>{tabs=[];return {results:[{id:'s0',ok:true},{id:'s1',ok:true}]};});
  fireEvent.click(screen.getByRole('button',{name:'确认删除标签页'}));await screen.findByText('当前没有用户占用此 Provider。');
  expect(remove).not.toHaveBeenCalled();await waitFor(()=>expect(screen.getByRole('button',{name:'确认删除 Provider'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'确认删除 Provider'}));await waitFor(()=>expect(remove).toHaveBeenCalledOnce());expect(cancel).toHaveBeenCalled();
 });
 it('cancels only the nested tab confirmation on Escape and preserves the Provider dialog',async()=>{
  mount();await screen.findByRole('checkbox',{name:'全选占用标签页'});fireEvent.click(screen.getByRole('checkbox',{name:'全选占用标签页'}));fireEvent.click(screen.getByRole('button',{name:'批量删除标签页（2）'}));
  expect(screen.getByRole('dialog',{name:'删除占用标签页'})).toBeVisible();fireEvent.keyDown(window,{key:'Escape'});
  expect(screen.queryByRole('dialog',{name:'删除占用标签页'})).not.toBeInTheDocument();expect(screen.getByRole('dialog',{name:'删除 Provider · Fixture'})).toBeVisible();expect(cancel).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
 });
 it('blocks deletion when occupancy cannot be read',async()=>{
  vi.mocked(api.codexEnvironments.usage).mockRejectedValue(Error('unavailable'));mount();expect(await screen.findByRole('alert')).toHaveTextContent('无法读取占用情况');expect(screen.getByRole('button',{name:'确认删除 Provider'})).toBeDisabled();expect(remove).not.toHaveBeenCalled();
 });
 it('keeps the dialog open and refreshes occupancy when a new tab races with deletion',async()=>{
  const occupied=[...tabs];tabs=[];mount();await screen.findByText('当前没有用户占用此 Provider。');
  remove.mockImplementationOnce(async()=>{tabs=occupied;throw Error('其他用户刚刚打开了标签页，请先关闭占用');});
  fireEvent.click(screen.getByRole('button',{name:'确认删除 Provider'}));expect(await screen.findByRole('alert')).toHaveTextContent('其他用户刚刚打开');
  const dialog=screen.getByRole('dialog',{name:'删除 Provider · Fixture'});expect(await within(dialog).findByText('Tab ymchen')).toBeVisible();expect(screen.getByRole('button',{name:'确认删除 Provider'})).toBeDisabled();expect(cancel).not.toHaveBeenCalled();
 });
});
