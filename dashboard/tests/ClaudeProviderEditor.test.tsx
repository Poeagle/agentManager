import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {ClaudeProviderEditor} from '../src/components/ClaudeProviderEditor';
import {AgentManagementPanel} from '../src/components/AgentManagementPanel';
import {api,type AgentProviderState} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{
 const actual=await original<typeof import('../src/lib/api')>();
 return {...actual,api:{...actual.api,agentManagement:{...actual.api.agentManagement,list:vi.fn(),get:vi.fn(),detectModels:vi.fn(),createProvider:vi.fn(),updateProvider:vi.fn(),deleteProvider:vi.fn(),providerAction:vi.fn()}}};
});
let client:QueryClient,provider:AgentProviderState;
beforeEach(()=>{
 client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.clearAllMocks();
 provider={id:'gateway',name:'Gateway',kind:'anthropic-compatible',enabled:true,managed:true,status:'ready',statusText:'可安全注入独立 SDK 会话',authentication:{status:'authenticated',method:'ANTHROPIC_AUTH_TOKEN'},models:['claude-a','claude-b'],defaultModel:'claude-a',fields:[
  {key:'baseUrl',label:'API 地址',type:'text',value:'https://gateway.example'},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'models',label:'模型',type:'string-list',value:['claude-a','claude-b']},
  {key:'defaultModel',label:'默认模型',type:'text',value:'claude-a'},
  {key:'contextWindow',label:'上下文窗口',type:'text',value:'200000'},
  {key:'maxOutputTokens',label:'最大输出 Token',type:'text',value:''},
 ]};
});
const mount=(props:Partial<Parameters<typeof ClaudeProviderEditor>[0]>={})=>render(<QueryClientProvider client={client}><ClaudeProviderEditor provider={provider} readOnly={false} onSaved={vi.fn()} {...props}/></QueryClientProvider>);
it('keeps a configured key masked and saves only a replacement value',async()=>{
 vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 mount();const key=screen.getByLabelText('Claude API Key');expect(key).toHaveValue('');expect(key).toHaveAttribute('placeholder','留空保持不变');expect(screen.getByText('已配置')).toBeVisible();
 fireEvent.change(screen.getByLabelText('Claude Provider 名称'),{target:{value:'Gateway updated'}});fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',expect.objectContaining({name:'Gateway updated'})));
 expect(vi.mocked(api.agentManagement.updateProvider).mock.calls[0][2]).not.toHaveProperty('apiKey');
});
it('discovers models in place and adds only the selected result without dropping existing models',async()=>{
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:[{model:'claude-c',name:'Claude C',description:''}]});
 mount();fireEvent.change(screen.getByLabelText('Claude API Key'),{target:{value:'new-token'}});fireEvent.click(screen.getByRole('button',{name:'探测模型'}));
 const option=await screen.findByRole('checkbox',{name:'启用模型 claude-c'});expect(option).toBeChecked();expect(screen.getByText('已探测 3 个，勾选此 Provider 可用的模型。')).toBeVisible();
 expect(api.agentManagement.detectModels).toHaveBeenCalledWith('claude',{endpoint:'https://gateway.example',apiKey:'new-token',providerId:'gateway'});
});
it('creates a Provider from one page and uses a fixed primary action',async()=>{
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:[{model:'claude-a',name:'Claude A',description:''}]});
 vi.mocked(api.agentManagement.createProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 const onSaved=vi.fn();render(<QueryClientProvider client={client}><ClaudeProviderEditor readOnly={false} onSaved={onSaved}/></QueryClientProvider>);
 fireEvent.change(screen.getByLabelText('Claude Provider ID'),{target:{value:'second'}});fireEvent.change(screen.getByLabelText('Claude Provider 名称'),{target:{value:'Second'}});fireEvent.change(screen.getByLabelText('Claude API 地址'),{target:{value:'https://second.example'}});fireEvent.change(screen.getByLabelText('Claude API Key'),{target:{value:'secret'}});
 expect(screen.getByRole('button',{name:'添加 Provider'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'探测模型'}));await screen.findByRole('checkbox',{name:'启用模型 claude-a'});fireEvent.click(screen.getByRole('button',{name:'添加 Provider'}));
 await waitFor(()=>expect(api.agentManagement.createProvider).toHaveBeenCalledWith('claude',expect.objectContaining({id:'second',name:'Second',apiKey:'secret',fields:expect.objectContaining({baseUrl:'https://second.example',models:['claude-a']})})));
 expect(onSaved).toHaveBeenCalledWith('second');
});
it('confirms destructive deletion instead of deleting on first click',async()=>{
 mount();fireEvent.click(screen.getByRole('button',{name:'删除'}));expect(screen.getByText('确定彻底删除？')).toBeVisible();expect(api.agentManagement.deleteProvider).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(screen.queryByText('确定彻底删除？')).toBeNull();
});
it('uses the same editable Provider form for the native Anthropic environment',async()=>{
 const native:AgentProviderState={...provider,id:'anthropic',name:'Anthropic',kind:'official',enabled:true,managed:true,statusText:'原生配置可切换',authentication:{status:'authenticated',method:'原生配置'},models:['default','sonnet','opus','haiku'],defaultModel:'opus',fields:[
  {key:'baseUrl',label:'API 地址',type:'text',value:'https://gateway.example'},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'models',label:'模型',type:'string-list',value:['default','sonnet','opus','haiku']},
  {key:'defaultModel',label:'默认模型',type:'text',value:'opus'},
 ]};
 const state={agent:{id:'claude',label:'Claude'},providers:[native],defaults:[],providerManagement:{create:true},installation:{status:'ready',executable:'/fixture/claude',version:'1.0',latestVersion:null,updateAvailable:false,installCommand:'',updateCommand:''},authentication:{status:'unknown',method:'fixture',detail:'原生配置'},environment:[],configFiles:[],diagnostics:[],actions:[],applySemantics:{settings:'new_session',providers:'new_session',detail:'fixture'},checkedAt:new Date().toISOString()} as any;
 vi.mocked(api.agentManagement.list).mockResolvedValue({agents:[{agent:state.agent,state}]} as any);vi.mocked(api.agentManagement.get).mockResolvedValue({state});
 render(<QueryClientProvider client={client}><AgentManagementPanel/></QueryClientProvider>);
 expect(await screen.findByRole('heading',{name:'Anthropic'})).toBeVisible();
 expect(screen.getByLabelText('Claude API 地址')).toHaveValue('https://gateway.example');
 expect(screen.getByLabelText('Claude API Key')).toHaveValue('');
 expect(screen.getByLabelText('Claude Provider 默认模型')).toHaveValue('opus');
 expect(screen.getByRole('button',{name:'保存 Provider'})).toBeDisabled();
 expect(screen.queryByRole('button',{name:'删除'})).toBeNull();
 expect(screen.queryByRole('button',{name:'停用'})).toBeNull();
 expect(screen.queryByText('环境变量')).toBeNull();
 expect(screen.queryByText('grok-4.6')).toBeNull();
});
