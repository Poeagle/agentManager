import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SendGuardSettings} from '../src/components/SendGuardSettings';
import {api} from '../src/lib/api';
import type {SendGuardGroup} from '../../server/src/shared/send-guard';

const legacyConditions:SendGuardGroup={operator:'or',conditions:[
 {type:'context_percent',value:80},
 {operator:'and',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:30}]},
]};
const value=JSON.stringify({enabled:true,conditions:legacyConditions});
const table=()=>within(screen.getByRole('table',{name:'发送保护规则'}));
const editor=(name:string)=>within(screen.getByRole('dialog',{name,exact:true}));
const apply=(dialog:ReturnType<typeof within>)=>fireEvent.click(dialog.getByRole('button',{name:'应用到表格'}));
const saveSettings=()=>vi.spyOn(api.settings,'update').mockImplementation(async settings=>({ok:true,settings}));

beforeEach(()=>{
 vi.spyOn(api.agentManagement,'list').mockResolvedValue({
  agents:[
   {agent:{id:'codex',label:'Codex'},state:{providers:[{id:'one',name:'Provider A'},{id:'two',name:'Provider B'}]}},
   {agent:{id:'claude',label:'Claude'},state:{providers:[{id:'one',name:'Provider A'}]}},
  ],
 } as Awaited<ReturnType<typeof api.agentManagement.list>>);
});
afterEach(()=>vi.restoreAllMocks());
function mount(canEdit:boolean,settings=value){
 const client=new QueryClient();
 return render(<QueryClientProvider client={client}><SendGuardSettings value={settings} canEdit={canEdit}/></QueryClientProvider>);
}

it('keeps the entire legacy reminder expression in one row and edits it for multiple Providers',async()=>{
 const save=saveSettings();
 mount(true);
 expect(table().getAllByRole('row')).toHaveLength(2);
 expect(table().getByRole('cell',{name:'全部 Provider'})).toBeInTheDocument();
 expect(table().getByRole('row',{name:/窗口占用率/})).toHaveTextContent('窗口占用率 ≥ 80% 或 （窗口占用率 ≥ 50% 且 闲置时间 ≥ 30 分钟）');
 expect(screen.queryByLabelText('触发条件 1数值')).not.toBeInTheDocument();
 fireEvent.click(table().getByRole('button',{name:/编辑规则 1/}));
 const dialog=editor('编辑规则 1');
 expect(dialog.getByRole('button',{name:'触发条件组合方式'})).toHaveTextContent('或');
 expect(dialog.getByRole('button',{name:'触发条件 2分组组合方式'})).toHaveTextContent('且');
 fireEvent.change(dialog.getByLabelText('触发条件 2分组 2数值'),{target:{value:'15'}});
 fireEvent.change(dialog.getByLabelText('Provider 范围'),{target:{value:'selected'}});
 expect(dialog.getByRole('button',{name:'应用到表格'})).toBeDisabled();
 fireEvent.click(await dialog.findByLabelText('Codex · Provider A'));
 fireEvent.click(dialog.getByLabelText('Claude · Provider A'));
 apply(dialog);
 expect(table().getByRole('cell',{name:/Codex · Provider A、Claude · Provider A/})).toBeInTheDocument();
 expect(save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'保存发送保护规则'}));
 await waitFor(()=>expect(save).toHaveBeenCalledOnce());
 expect(JSON.parse(save.mock.calls[0][0].conversation_send_guard)).toEqual({
  enabled:true,rules:[{action:'remind',provider_ids:['codex:one','claude:one'],conditions:{operator:'or',conditions:[
   {type:'context_percent',value:80},
   {operator:'and',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:15}]},
  ]}}],
 });
});

it('saves automatic actions with their own conditions in priority order, before the complete legacy reminder',async()=>{
 const save=saveSettings();
 mount(true);
 for(const action of ['new','compact']){
  fireEvent.click(screen.getByRole('button',{name:'添加规则'}));
  const dialog=editor('添加规则');
  fireEvent.change(dialog.getByLabelText('执行动作'),{target:{value:action}});
  apply(dialog);
 }
 expect(table().getAllByRole('row')).toHaveLength(4);
 fireEvent.click(table().getByRole('button',{name:'上移规则 2'}));
 expect(table().getAllByRole('row')[1]).toHaveTextContent('原生压缩');
 fireEvent.click(screen.getByRole('button',{name:'保存发送保护规则'}));
 await waitFor(()=>expect(save).toHaveBeenCalledOnce());
 const group={operator:'and',conditions:[{type:'context_percent',value:80}]};
 expect(JSON.parse(save.mock.calls[0][0].conversation_send_guard).rules).toEqual([
  {action:'compact',conditions:group},{action:'new',conditions:group},{action:'remind',conditions:legacyConditions},
 ]);
});

const configuredRule={action:'brief',provider_ids:['codex:one'],target:'available_account',conditions:legacyConditions};
const scopedValue=JSON.stringify({enabled:true,rules:[configuredRule]});

it('opens a configured rule and discards draft conditions and Provider scope changes on cancel',async()=>{
 mount(true,scopedValue);
 fireEvent.click(table().getByRole('button',{name:/编辑规则 1/}));
 const dialog=editor('编辑规则 1');
 expect(dialog.getByLabelText('换到有剩余额度的账号')).toBeChecked();
 expect(await dialog.findByLabelText('Codex · Provider A')).toBeChecked();
 fireEvent.click(dialog.getByLabelText('Codex · Provider A'));
 fireEvent.change(dialog.getByLabelText('触发条件 2分组 2数值'),{target:{value:'23'}});
 fireEvent.click(dialog.getByRole('button',{name:'取消'}));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(table().getAllByRole('row')[1]).toHaveTextContent('闲置时间 ≥ 30 分钟');
 expect(table().getAllByRole('row')[1]).toHaveTextContent('Codex · Provider A');
});

it('lets members inspect a complete rule without enabling editing',()=>{
 mount(false,scopedValue);
 expect(screen.getByRole('button',{name:'保存发送保护规则'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'添加规则'})).toBeDisabled();
 fireEvent.click(table().getByRole('button',{name:/查看规则 1/}));
 const dialog=editor('查看规则 1');
 expect(dialog.getByLabelText('Provider 范围')).toBeDisabled();
 expect(dialog.getByLabelText('触发条件 2分组 2数值')).toBeDisabled();
 expect(dialog.queryByRole('button',{name:'应用到表格'})).not.toBeInTheDocument();
});
