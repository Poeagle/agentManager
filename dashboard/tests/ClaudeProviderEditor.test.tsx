import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {ClaudeProviderEditor} from '../src/components/ClaudeProviderEditor';
import {AgentManagementPanel} from '../src/components/AgentManagementPanel';
import {api,type AgentProviderState} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{
 const actual=await original<typeof import('../src/lib/api')>();
 return {...actual,api:{...actual.api,agentManagement:{...actual.api.agentManagement,list:vi.fn(),get:vi.fn(),detectModels:vi.fn(),modelConfigs:vi.fn(async()=>({models:[]})),createProvider:vi.fn(),updateProvider:vi.fn(),deleteProvider:vi.fn(),providerAction:vi.fn()}}};
});
let client:QueryClient,provider:AgentProviderState;
beforeEach(()=>{
 client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.clearAllMocks();
 provider={id:'gateway',name:'Gateway',kind:'anthropic-compatible',enabled:true,managed:true,status:'ready',statusText:'可安全注入独立 SDK 会话',authentication:{status:'authenticated',method:'ANTHROPIC_AUTH_TOKEN'},models:['claude-a','claude-b'],defaultModel:'claude-a',fields:[
  {key:'baseUrl',label:'API 地址',type:'text',value:'https://gateway.example'},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'models',label:'模型',type:'string-list',value:['claude-a','claude-b']},
  {key:'defaultModel',label:'默认模型',type:'text',value:'claude-a'},
  {key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text',value:'1.2'},
  {key:'contextWindow',label:'上下文窗口',type:'text',value:'200000'},
  {key:'maxOutputTokens',label:'最大输出 Token',type:'text',value:''},
  {key:'haikuModel',label:'Haiku 模型',type:'text',value:''},
  {key:'subagentModel',label:'子 Agent 模型',type:'text',value:''},
  {key:'effort',label:'Effort 等级',type:'text',value:''},
  {key:'autoCompactWindow',label:'自动压缩窗口',type:'text',value:''},
 ]};
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:provider.models.map(model=>({model,name:model,description:'',efforts:[],defaultEffort:''}))});
});
const mount=(props:Partial<Parameters<typeof ClaudeProviderEditor>[0]>={})=>render(<QueryClientProvider client={client}><ClaudeProviderEditor provider={provider} readOnly={false} onSaved={vi.fn()} {...props}/></QueryClientProvider>);
it('saves model-specific Claude Code routing controls',async()=>{
  vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
  mount();
  expect(screen.getByLabelText('Claude Haiku 模型')).not.toBeVisible();
  fireEvent.click(screen.getByText('Claude Code 设置',{exact:true}));
  fireEvent.change(screen.getByLabelText('Provider 计费倍率'),{target:{value:'1.3'}});
  fireEvent.change(screen.getByLabelText('Claude Haiku 模型'),{target:{value:'deepseek-flash'}});
  fireEvent.change(screen.getByLabelText('Claude 子 Agent 模型'),{target:{value:'deepseek-flash'}});
  fireEvent.change(screen.getByLabelText('Claude Effort 等级'),{target:{value:'max'}});
  fireEvent.change(screen.getByLabelText('Claude 自动压缩窗口'),{target:{value:'786432'}});
  fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
  await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',expect.objectContaining({fields:expect.objectContaining({
    providerRateMultiplier:'1.3',haikuModel:'deepseek-flash',subagentModel:'deepseek-flash',effort:'max',autoCompactWindow:'786432',
  })})));
});
it('saves just the multiplier without detecting models',async()=>{
 vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 mount();
 fireEvent.click(screen.getByText('Claude Code 设置',{exact:true}));
 fireEvent.change(screen.getByLabelText('Provider 计费倍率'),{target:{value:'2.5'}});
 fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',{fields:{providerRateMultiplier:'2.5'}}));
 expect(api.agentManagement.detectModels).not.toHaveBeenCalled();
});
it('keeps a configured key masked and saves only a replacement value',async()=>{
 vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 mount();const key=screen.getByLabelText('Claude API Key');expect(key).toHaveValue('');expect(key).toHaveAttribute('placeholder','留空保持不变');expect(screen.getByText('已配置')).toBeVisible();
 fireEvent.change(screen.getByLabelText('Claude Provider 名称'),{target:{value:'Gateway updated'}});fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',expect.objectContaining({name:'Gateway updated'})));
 expect(vi.mocked(api.agentManagement.updateProvider).mock.calls[0][2]).not.toHaveProperty('apiKey');
});
it('reuses the configured key, probes without re-entry, and replaces stale aliases',async()=>{
 provider={...provider,models:['grok-4.5','opus','sonnet','haiku'],defaultModel:'opus'};
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:[{model:'claude-fable-5',name:'Claude Fable',description:''},{model:'claude-fable-5-1',name:'Claude Fable 1',description:''}]});
 vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 mount();
 fireEvent.click(screen.getByRole('button',{name:'探测模型'}));
 await screen.findByText('Claude Fable');
 fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',expect.objectContaining({fields:expect.objectContaining({models:['claude-fable-5','claude-fable-5-1'],defaultModel:'claude-fable-5'})})));
 expect(screen.getByRole('table',{name:'Provider 模型'})).toBeVisible();
 expect(api.agentManagement.detectModels).toHaveBeenCalledWith('claude',{endpoint:'https://gateway.example',apiKey:undefined,providerId:'gateway'});
 expect(vi.mocked(api.agentManagement.updateProvider).mock.calls[0][2]).not.toHaveProperty('apiKey');
});
it('saves only the models checked in the model table',async()=>{
 provider={...provider,models:['claude-fable-5','claude-haiku-4-5','claude-opus-5-5','claude-sonnet-5-5'],defaultModel:'claude-sonnet-5-5'};
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:provider.models.map(model=>({model,name:model,description:'',efforts:[],defaultEffort:''}))});
 vi.mocked(api.agentManagement.updateProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 mount();
 fireEvent.click(screen.getByRole('button',{name:'编辑模型'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'启用 claude-fable-5'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'启用 claude-haiku-4-5'}));
 fireEvent.click(screen.getByRole('button',{name:'保存 Provider'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('claude','gateway',expect.objectContaining({fields:expect.objectContaining({models:['claude-opus-5-5','claude-sonnet-5-5'],defaultModel:'claude-sonnet-5-5'})})));
});
it('creates a Provider from one page and uses a fixed primary action',async()=>{
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:[{model:'claude-a',name:'Claude A',description:'',efforts:[],defaultEffort:'',context_window:500000,input_modalities:['text','image']}]});
 vi.mocked(api.agentManagement.createProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 const onSaved=vi.fn();render(<QueryClientProvider client={client}><ClaudeProviderEditor readOnly={false} onSaved={onSaved}/></QueryClientProvider>);
 fireEvent.change(screen.getByLabelText('Claude Provider ID'),{target:{value:'second'}});fireEvent.change(screen.getByLabelText('Claude Provider 名称'),{target:{value:'Second'}});fireEvent.change(screen.getByLabelText('Claude API 地址'),{target:{value:'https://second.example'}});fireEvent.change(screen.getByLabelText('Claude API Key'),{target:{value:'secret'}});
 expect(screen.getByRole('button',{name:'添加 Provider'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'探测模型'}));const modelToggle=await screen.findByRole('checkbox',{name:'启用 claude-a'});expect(modelToggle).toBeEnabled();expect(screen.getByRole('status')).toHaveTextContent('模型编辑已开启');expect(screen.getByRole('button',{name:'完成编辑'})).toHaveAttribute('aria-pressed','true');expect(screen.getByRole('button',{name:'添加 Provider'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'添加 Provider'}));
 await waitFor(()=>expect(api.agentManagement.createProvider).toHaveBeenCalledWith('claude',expect.objectContaining({id:'second',name:'Second',apiKey:'secret',fields:expect.objectContaining({baseUrl:'https://second.example',models:['claude-a']})})));
 expect(screen.getByRole('row',{name:/claude-a/})).toHaveTextContent('500,000');
 expect(screen.getByRole('row',{name:/claude-a/})).toHaveTextContent('支持');
 expect(JSON.parse(String(vi.mocked(api.agentManagement.createProvider).mock.lastCall?.[1].fields?.modelCapabilities))).toEqual({'claude-a':{context_window:500000,input_modalities:['text','image']}});
 expect(onSaved).toHaveBeenCalledWith('second');
});
it('adds a manually entered model when the provider has no catalog endpoint',async()=>{
 vi.mocked(api.agentManagement.detectModels).mockRejectedValue(new Error('此地址没有提供 /models 目录。Anthropic 兼容 Provider 可手工填写模型 ID，保存后会用 Messages 请求验证。'));
 vi.mocked(api.agentManagement.createProvider).mockResolvedValue({state:{agent:{id:'claude',label:'Claude'},providers:[provider]} as any});
 render(<QueryClientProvider client={client}><ClaudeProviderEditor readOnly={false} onSaved={vi.fn()}/></QueryClientProvider>);
 fireEvent.change(screen.getByLabelText('Claude Provider ID'),{target:{value:'deepseek'}});fireEvent.change(screen.getByLabelText('Claude API 地址'),{target:{value:'https://api.deepseek.com/anthropic'}});fireEvent.change(screen.getByLabelText('Claude API Key'),{target:{value:'secret'}});fireEvent.click(screen.getByRole('button',{name:'探测模型'}));
 expect(await screen.findByText(/没有提供 \/models 目录/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'填写模型'}));
 fireEvent.click(screen.getByText('手工添加模型',{exact:true}));
 fireEvent.change(screen.getByLabelText('手工添加 Claude 模型'),{target:{value:'deepseek-chat'}});fireEvent.click(screen.getByRole('button',{name:'添加'}));
 expect(screen.getByRole('checkbox',{name:'启用 deepseek-chat'})).toBeChecked();expect(screen.getByRole('button',{name:'添加 Provider'})).toBeEnabled();
 fireEvent.click(screen.getByRole('button',{name:'添加 Provider'}));await waitFor(()=>expect(api.agentManagement.createProvider).toHaveBeenCalledWith('claude',expect.objectContaining({id:'deepseek',fields:expect.objectContaining({models:['deepseek-chat'],defaultModel:'deepseek-chat'})})));
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
 fireEvent.click(await screen.findByRole('button',{name:'编辑 Anthropic · Claude'}));
 expect(await screen.findByRole('dialog',{name:'编辑 Provider · Anthropic'})).toBeVisible();
 expect(screen.getByLabelText('Claude API 地址')).toHaveValue('https://gateway.example');
 expect(screen.getByLabelText('Claude API Key')).toHaveValue('');
 expect(screen.getByRole('table',{name:'Provider 模型'})).toBeVisible();
 expect(screen.getByRole('button',{name:'保存 Provider'})).toBeDisabled();
 expect(screen.queryByRole('button',{name:'删除'})).toBeNull();
 expect(screen.queryByRole('button',{name:'停用'})).toBeNull();
 expect(screen.queryByText('环境变量')).toBeNull();
 expect(screen.queryByText('grok-4.6')).toBeNull();
});
