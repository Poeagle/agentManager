import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,expect,it,vi} from 'vitest';
import {SendGuardSettings} from '../src/components/SendGuardSettings';
import {api} from '../src/lib/api';
const value=JSON.stringify({enabled:true,conditions:{operator:'or',conditions:[{type:'context_percent',value:80},{operator:'and',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:30}]}]}});
afterEach(()=>vi.restoreAllMocks());
function mount(canEdit:boolean){const client=new QueryClient();return render(<QueryClientProvider client={client}><SendGuardSettings value={value} canEdit={canEdit}/></QueryClientProvider>);}
it('edits nested AND/OR conditions and persists a policy in platform settings',async()=>{
 const save=vi.spyOn(api.settings,'update').mockImplementation(async settings=>({ok:true,settings}));mount(true);
 const group=screen.getByRole('region',{name:'发送提醒条件 2分组'});fireEvent.change(within(group).getByRole('combobox',{name:'发送提醒条件 2分组组合方式'}),{target:{value:'or'}});fireEvent.change(screen.getByLabelText('发送提醒条件 1数值'),{target:{value:'85'}});fireEvent.click(screen.getByRole('button',{name:'保存发送保护规则'}));await waitFor(()=>expect(save).toHaveBeenCalledOnce());const policy=JSON.parse(save.mock.calls[0][0].conversation_send_guard);expect(policy.conditions.conditions[0].value).toBe(85);expect(policy.conditions.conditions[1].operator).toBe('or');
});
it('renders rules read-only for members',()=>{mount(false);expect(screen.getByRole('button',{name:'保存发送保护规则'})).toBeDisabled();expect(screen.getByLabelText('发送提醒条件 1数值')).toBeDisabled();});
