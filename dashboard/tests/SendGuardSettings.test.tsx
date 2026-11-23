import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,expect,it,vi} from 'vitest';
import {SendGuardSettings} from '../src/components/SendGuardSettings';
import {api} from '../src/lib/api';
const value=JSON.stringify({enabled:true,conditions:{operator:'or',conditions:[{type:'context_percent',value:80},{operator:'and',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:30}]}]}});
afterEach(()=>vi.restoreAllMocks());
function mount(canEdit:boolean,settings=value){const client=new QueryClient();return render(<QueryClientProvider client={client}><SendGuardSettings value={settings} canEdit={canEdit}/></QueryClientProvider>);}
it('edits reminder branches from the shared table and saves their independent AND/OR operators',async()=>{
 const save=vi.spyOn(api.settings,'update').mockImplementation(async settings=>({ok:true,settings}));
 mount(true);
 const table=within(screen.getByRole('table',{name:'发送保护规则'}));
 expect(screen.getAllByRole('table')).toHaveLength(1);
 expect(table.getAllByRole('row')).toHaveLength(3);
 expect(table.getAllByRole('cell',{name:'发送提醒'})).toHaveLength(2);
 expect(screen.queryByLabelText('触发条件 1数值')).not.toBeInTheDocument();
 expect(screen.getByLabelText('提醒条件组合')).toHaveValue('or');

 fireEvent.click(table.getByRole('button',{name:/编辑提醒条件 2/}));
 let editor=within(screen.getByRole('dialog',{name:'编辑提醒条件 2'}));
 expect(editor.getByRole('button',{name:'触发条件组合方式'})).toHaveTextContent('且');
 fireEvent.click(editor.getByRole('button',{name:'触发条件连接方式'}));
 fireEvent.click(editor.getByRole('button',{name:'应用到表格'}));
 expect(table.getAllByRole('row')[2]).toHaveTextContent('窗口占用率 ≥ 50% 或 闲置时间 ≥ 30 分钟');

 fireEvent.click(table.getByRole('button',{name:/编辑提醒条件 1/}));
 editor=within(screen.getByRole('dialog',{name:'编辑提醒条件 1'}));
 fireEvent.change(editor.getByLabelText('触发条件 1数值'),{target:{value:'85'}});
 fireEvent.click(editor.getByRole('button',{name:'应用到表格'}));
 fireEvent.change(screen.getByLabelText('提醒条件组合'),{target:{value:'and'}});
 fireEvent.click(screen.getByRole('button',{name:'保存发送保护规则'}));
 await waitFor(()=>expect(save).toHaveBeenCalledOnce());
 expect(JSON.parse(save.mock.calls[0][0].conversation_send_guard).conditions).toEqual({
  operator:'and',conditions:[{type:'context_percent',value:85},{operator:'or',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:30}]}],
 });
});

it('allows members to read reminder rows in the same editor at their existing permission level',()=>{
 mount(false);
 expect(screen.getByRole('button',{name:'保存发送保护规则'})).toBeDisabled();
 expect(screen.getByLabelText('提醒条件组合')).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:/查看提醒条件 1/}));
 expect(within(screen.getByRole('dialog',{name:'查看提醒条件 1'})).getByLabelText('触发条件 1数值')).toBeDisabled();
});

it('adds a reminder condition group as one row and keeps the last reminder condition available',()=>{
 mount(true);
 const table=within(screen.getByRole('table',{name:'发送保护规则'}));
 fireEvent.click(table.getByRole('button',{name:'删除提醒条件 2'}));
 expect(table.getByRole('button',{name:'删除提醒条件 1'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'添加提醒条件'}));
 const editor=within(screen.getByRole('dialog',{name:'添加提醒条件'}));
 fireEvent.click(editor.getByRole('button',{name:'触发条件添加条件'}));
 fireEvent.change(editor.getByLabelText('触发条件 2',{exact:true}),{target:{value:'idle_minutes'}});
 fireEvent.click(editor.getByRole('button',{name:'应用到表格'}));
 expect(table.getAllByRole('row')).toHaveLength(3);
 expect(table.getAllByRole('row')[2]).toHaveTextContent('窗口占用率 ≥ 80% 且 闲置时间 ≥ 30 分钟');
});

it('saves automatic actions with their own conditions in priority order',async()=>{
 const save=vi.spyOn(api.settings,'update').mockImplementation(async settings=>({ok:true,settings}));mount(true);
 const add=screen.getByRole('button',{name:'添加自动规则'});
 fireEvent.click(add);
 let editor=within(screen.getByRole('dialog',{name:'添加自动规则'}));
 fireEvent.change(editor.getByLabelText('执行动作'),{target:{value:'new'}});
 fireEvent.change(editor.getByLabelText('触发条件 1数值'),{target:{value:'95'}});
 fireEvent.click(editor.getByRole('button',{name:'应用到表格'}));
 fireEvent.click(add);
 editor=within(screen.getByRole('dialog',{name:'添加自动规则'}));
 fireEvent.change(editor.getByLabelText('执行动作'),{target:{value:'compact'}});
 fireEvent.click(editor.getByRole('button',{name:'应用到表格'}));
 const table=within(screen.getByRole('table',{name:'发送保护规则'}));
 expect(table.getAllByRole('row')).toHaveLength(5);
 expect(table.getAllByRole('row')[1]).toHaveTextContent('窗口占用率 ≥ 95%');
 expect(table.getAllByRole('row')[1]).toHaveTextContent('新开会话');
 fireEvent.click(table.getByRole('button',{name:'上移自动规则 2'}));
 expect(table.getAllByRole('row')[1]).toHaveTextContent('原生压缩');
 expect(save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'保存发送保护规则'}));
 await waitFor(()=>expect(save).toHaveBeenCalledOnce());
 const policy=JSON.parse(save.mock.calls[0][0].conversation_send_guard);
 expect(policy.conditions).toEqual(JSON.parse(value).conditions);
 expect(policy.automatic_rules).toEqual([
  {action:'compact',conditions:{operator:'and',conditions:[{type:'context_percent',value:80}]}},
  {action:'new',conditions:{operator:'and',conditions:[{type:'context_percent',value:95}]}},
 ]);
});


const nestedRule={action:'brief',target:'available_account',conditions:{operator:'or',conditions:[
 {type:'account_remaining_percent',value:0},
 {operator:'and',conditions:[{type:'context_percent',value:60},{type:'idle_minutes',value:10}]},
]}};

it('opens the selected row and discards changes on cancel',()=>{
 mount(true,JSON.stringify({...JSON.parse(value),automatic_rules:[nestedRule]}));
 const table=within(screen.getByRole('table',{name:'发送保护规则'}));
 expect(table.getByRole('row',{name:/账号额度剩余/})).toHaveTextContent('账号额度剩余 ≤ 0% 或 （窗口占用率 ≥ 60% 且 闲置时间 ≥ 10 分钟）');
 fireEvent.click(table.getByRole('button',{name:/编辑自动规则 1/}));
 const editor=within(screen.getByRole('dialog',{name:'编辑自动规则 1'}));
 expect(editor.getByLabelText('换到有剩余额度的账号')).toBeChecked();
 fireEvent.change(editor.getByLabelText('触发条件 2分组 2数值'),{target:{value:'23'}});
 fireEvent.click(editor.getByRole('button',{name:'取消'}));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(table.getByRole('row',{name:/账号额度剩余/})).toHaveTextContent('闲置时间 ≥ 10 分钟');
});

it('allows members to inspect all conditions without editing them',()=>{
 mount(false,JSON.stringify({...JSON.parse(value),automatic_rules:[nestedRule]}));
 fireEvent.click(screen.getByRole('button',{name:/查看自动规则 1/}));
 const editor=within(screen.getByRole('dialog',{name:'查看自动规则 1'}));
 expect(editor.getByLabelText('触发条件 2分组 2数值')).toBeDisabled();
 expect(editor.queryByRole('button',{name:'应用到表格'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'添加自动规则'})).toBeDisabled();
});
