import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor,within,act} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AgentManagementPanel} from '../src/components/AgentManagementPanel';
import {api,type AgentManagementState,type AgentProviderState,type AgentModelConfig} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{const actual=await original<typeof import('../src/lib/api')>();return {...actual,api:{...actual.api,agentManagement:{...actual.api.agentManagement,list:vi.fn(),get:vi.fn(),provider:vi.fn(),modelCatalog:vi.fn(),modelConfigs:vi.fn(),updateModelConfigs:vi.fn(),updateProvider:vi.fn(),updateProviderStream:vi.fn(),detectModels:vi.fn()},codexEnvironments:{...actual.api.codexEnvironments,management:vi.fn(),usage:vi.fn(),details:vi.fn(),configFiles:vi.fn(async()=>({files:[]})),quota:vi.fn(async()=>({quota:null,reason:'not_applicable'}))}}};});
let client:QueryClient,provider:AgentProviderState,state:AgentManagementState,configs:AgentModelConfig[];
const createFixture=()=>({
 provider:{id:'fixture',name:'Fixture API',kind:'responses',enabled:true,managed:true,status:'ready',statusText:'Engine 运行中 · PID 123',authentication:{status:'authenticated',method:'加密 API Key'},models:['model-a','model-b'],defaultModel:'model-a',codexHome:'/fixture/codex',pid:123,launchCommand:'codex app-server --fixture',configFiles:[{path:'/fixture/config.toml',exists:true,format:'TOML',writable:true}],fields:[{key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://fixture.invalid/v1',required:true},{key:'envKey',label:'API Key',type:'password',value:'',configured:true,description:'密钥安全保存'},{key:'codexHome',label:'独立 CODEX_HOME',type:'text',value:'/fixture/codex'},{key:'command',label:'启动命令',type:'text',value:'codex'},{key:'launchArgs',label:'附加启动参数',type:'string-list',value:[]},{key:'models',label:'模型',type:'string-list',value:['model-a','model-b']},{key:'defaultModel',label:'默认模型',type:'text',value:'model-a'}]} as AgentProviderState,
 configs:['model-a','model-b'].map((model,i)=>({provider:'fixture',model,name:`Model ${i+1}`,contextWindow:200000,maxContextWindow:200000,effectiveContextWindowPercent:95,inputModalities:['text'],supportsImages:false,sourceFile:'/fixture/models.json'})) as AgentModelConfig[],
});
beforeEach(()=>{
 vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const fixture=createFixture();provider=fixture.provider;configs=fixture.configs;
 state={agent:{id:'codex',label:'Codex'},providers:[provider],defaults:[],providerManagement:{create:true}} as AgentManagementState;
 vi.mocked(api.agentManagement.list).mockImplementation(async()=>({agents:[{agent:state.agent,state}]} as any));vi.mocked(api.agentManagement.get).mockImplementation(async()=>({state}));vi.mocked(api.agentManagement.provider).mockImplementation(async()=>({provider}));vi.mocked(api.agentManagement.modelConfigs).mockImplementation(async()=>({models:configs}));
 vi.mocked(api.agentManagement.modelCatalog).mockImplementation(async()=>({models:provider.models.map(model=>({vendor:'OpenAI',model,providers:[provider.name],context_window:200000,api_pricing:{currency:'USD',source:'official',reference_only:true,bands:[{rates:{input:2,cached:0.2,output:8}}]}}))}));
 vi.mocked(api.agentManagement.updateModelConfigs).mockImplementation(async(_id,patches)=>{configs=configs.map(c=>({...c,...patches.find(p=>p.model===c.model)}));return {models:configs};});
 vi.mocked(api.agentManagement.detectModels).mockResolvedValue({models:['model-a','model-b'].map(model=>({model,name:model,description:'',efforts:[],defaultEffort:'',context_window:200000,input_modalities:['text']}))});
 vi.mocked(api.agentManagement.updateProvider).mockImplementation(async(_agentId,_providerId,input)=>{provider={...provider,models:input.fields?.models as string[]??provider.models,defaultModel:String(input.fields?.defaultModel??provider.defaultModel),fields:provider.fields.map(field=>({...field,value:input.fields?.[field.key]??field.value}))};state={...state,providers:[provider]};return {state} as any;});
 vi.mocked(api.agentManagement.updateProviderStream).mockImplementation(async(_id,_p,input)=>{provider={...provider,models:input.fields?.models as string[]||provider.models,fields:provider.fields.map(f=>({...f,value:input.fields?.[f.key]??f.value}))};state={...state,providers:[provider]};return {provider,state};});
 vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[],users:[]});vi.mocked(api.codexEnvironments.usage).mockResolvedValue({tabs:[],busy:false,verified:true});
});
afterEach(()=>{client.clear();vi.restoreAllMocks();});
const mount=(readOnly=false)=>render(<QueryClientProvider client={client}><AgentManagementPanel readOnly={readOnly}/></QueryClientProvider>);
const open=async (name='Fixture API',readOnly=false)=>{
 mount(readOnly);
 fireEvent.click(await screen.findByRole('button',{name:`${readOnly?'查看':'编辑'} ${name} · Codex`}));
 return screen.findByRole('dialog',{name:`${readOnly?'查看':'编辑'} Provider · ${name}`});
};
it('shows the native API engine in the Provider layout using runtime settings',async()=>{
 provider={...provider,id:'native',name:'Native API',kind:'native',fields:[
  {key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://fixture.invalid/v1'},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'codexHome',label:'CODEX_HOME',type:'text',value:'/fixture/.codex',readOnly:true},
  {key:'models',label:'模型',type:'string-list',value:['model-a']},
  {key:'defaultModel',label:'默认模型',type:'text',value:'model-a'},
  {key:'command',label:'启动命令',type:'text',value:'codex'},
 ]};state={...state,providers:[provider]};
 vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[{id:'native',name:'Native API',kind:'native',enabled:true,auth_mode:'api',allowed_user_ids:null}],users:[]});
 vi.mocked(api.codexEnvironments.details).mockResolvedValue({details:{id:'native',checked_at:'',home:'/fixture/.codex',executable:'codex',version:null,engine:{state:'connected',pid:1},authentication:{status:'authenticated',type:'apiKey',email:null,plan:null},config:{path:null,exists:true,notice:null},settings:{model:'model-a',base_url:'https://fixture.invalid/v1'},models:[{model:'model-a',name:'Model A'}]}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({auth_mode:'api',status:'available',amount:5,currency:'USD'}))));
 await open('Native API');expect(await screen.findByRole('textbox',{name:'Responses API 地址'})).toHaveValue('https://fixture.invalid/v1');
 expect(screen.queryByRole('table',{name:'Provider 模型'})).not.toBeInTheDocument();expect(screen.queryByText('CODEX 登录账号')).not.toBeInTheDocument();vi.unstubAllGlobals();
});
it('opens native API settings even while environment authentication is pending',async()=>{
 provider={...provider,id:'native',name:'Native Pending',kind:'native',authentication:{status:'authenticated',method:'API Key',mode:'api'},models:['model-a'],defaultModel:'model-a',codexHome:'/fixture/.codex',fields:[
  {key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://fixture.invalid/v1',required:true},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'codexHome',label:'CODEX_HOME',type:'text',value:'/fixture/.codex',readOnly:true},
  {key:'models',label:'模型',type:'string-list',value:['model-a'],required:true},
  {key:'defaultModel',label:'默认模型',type:'text',value:'model-a'},
  {key:'command',label:'启动命令',type:'text',value:'codex'},
 ]};state={...state,providers:[provider]};
 vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[{id:'native',name:'Native Pending',kind:'native',enabled:true,auth_mode:null,allowed_user_ids:null}],users:[]});
 vi.mocked(api.codexEnvironments.details).mockResolvedValue({details:{id:'native',checked_at:'',home:'/fixture/.codex',executable:'codex',version:null,engine:{state:'connected',pid:1},authentication:{status:'authenticated',type:'apiKey',email:null,plan:null},config:{path:null,exists:true,notice:null},settings:{model:'model-a',base_url:'https://fixture.invalid/v1'},models:[{model:'model-a',name:'Model A'}]}});
 const dialog=await open('Native Pending');
 expect(within(dialog).getByRole('textbox',{name:'Responses API 地址'})).toHaveValue('https://fixture.invalid/v1');
 expect(within(dialog).getByLabelText('API Key')).toBeVisible();
 expect(within(dialog).queryByText('账号与运行状态')).not.toBeInTheDocument();
});
it('keeps a native Codex account in the account details instead of the API form',async()=>{
 provider={...provider,id:'native',name:'Native Account',kind:'native',models:['model-a'],defaultModel:'model-a',codexHome:'/fixture/.codex',fields:[
  {key:'baseUrl',label:'Responses API 地址',type:'text',value:'',required:true},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:false},
 ]};state={...state,providers:[provider]};
 vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[{id:'native',name:'Native Account',kind:'native',enabled:true,auth_mode:'account',allowed_user_ids:null}],users:[]});
 vi.mocked(api.codexEnvironments.details).mockResolvedValue({details:{id:'native',checked_at:'',home:'/fixture/.codex',executable:'codex',version:'0.test',engine:{state:'connected',pid:1},authentication:{status:'authenticated',type:'chatgpt',email:'account@example.invalid',plan:'plus'},config:{path:'/fixture/.codex/config.toml',exists:true,notice:null},settings:{model:'model-a'},models:[{model:'model-a',name:'Model A'}]}});
 const dialog=await open('Native Account');
 expect(within(dialog).queryByRole('button',{name:'保存连接配置并重启 Engine'})).not.toBeInTheDocument();
 expect(within(dialog).queryByRole('textbox',{name:'Responses API 地址'})).not.toBeInTheDocument();
});
it('keeps existing native models selected and leaves newly detected models disabled',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));const table=await screen.findByRole('table',{name:'Provider 模型'});
 provider={...provider,id:'native',name:'Fixture API',kind:'native',models:['stale-model'],defaultModel:'stale-model',fields:[
  {key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://fixture.invalid/v1'},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'models',label:'模型',type:'string-list',value:['stale-model']},
  {key:'defaultModel',label:'默认模型',type:'text',value:'stale-model'},
 ]};
 vi.mocked(api.agentManagement.detectModels).mockResolvedValueOnce({models:[{model:'gpt-current',name:'GPT Current',description:'',efforts:[],defaultEffort:''}]});
 fireEvent.click(screen.getByRole('button',{name:'探测模型'}));
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('codex','fixture',expect.objectContaining({fields:expect.objectContaining({models:['gpt-current'],defaultModel:'gpt-current'})})));
 expect(within(table).getByRole('checkbox',{name:'启用 stale-model'})).toBeChecked();
 expect(within(table).getByRole('checkbox',{name:'启用 gpt-current'})).not.toBeChecked();
});
it('edits native Codex connection settings without exposing the stored API key',async()=>{
 provider={...createFixture().provider,id:'native',name:'Native API',kind:'native',models:['model-a'],defaultModel:'model-a',codexHome:'/fixture/.codex',fields:[
  {key:'baseUrl',label:'Responses API 地址',type:'text',value:'https://fixture.invalid/v1',required:true},
  {key:'envKey',label:'API Key',type:'password',value:'',configured:true},
  {key:'codexHome',label:'CODEX_HOME',type:'text',value:'/fixture/.codex',readOnly:true},
  {key:'models',label:'模型',type:'string-list',value:['model-a'],required:true},
  {key:'defaultModel',label:'默认模型',type:'text',value:'model-a'},
  {key:'command',label:'启动命令',type:'text',value:'codex'},
 ]};state={...state,providers:[provider]};
 vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[{id:'native',name:'Native API',kind:'native',enabled:true,auth_mode:'api',allowed_user_ids:null}],users:[]});
 vi.mocked(api.codexEnvironments.details).mockResolvedValue({details:{id:'native',checked_at:'',home:'/fixture/.codex',executable:'codex',version:null,engine:{state:'connected',pid:1},authentication:{status:'authenticated',type:'apiKey',email:null,plan:null},config:{path:null,exists:true,notice:null},settings:{model:'model-a',base_url:'https://fixture.invalid/v1'},models:[{model:'model-a',name:'Model A'}]}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({auth_mode:'api',status:'available',amount:5,currency:'USD'}))));
 const dialog=await open('Native API');
 const endpoint=within(dialog).getByRole('textbox',{name:'Responses API 地址'});
 const key=within(dialog).getByLabelText('API Key');
 expect(endpoint).not.toHaveAttribute('readonly');expect(key).toHaveValue('');
 fireEvent.change(endpoint,{target:{value:'https://replacement.invalid/v1'}});
 fireEvent.change(key,{target:{value:'sk-replacement-secret'}});
 const modelsEditor=within(dialog).getAllByLabelText('模型').at(-1)!;
 fireEvent.change(modelsEditor,{target:{value:'model-b'}});
 fireEvent.change(within(dialog).getAllByRole('textbox',{name:'默认模型'}).at(-1)!,{target:{value:'model-b'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'保存连接配置并重启 Engine'}));
 await waitFor(()=>expect(api.agentManagement.updateProviderStream).toHaveBeenCalledWith('codex','native',expect.objectContaining({
  apiKey:'sk-replacement-secret',
  fields:expect.objectContaining({baseUrl:'https://replacement.invalid/v1',models:['model-b'],defaultModel:'model-b'}),
 }),expect.any(Function)));
 vi.unstubAllGlobals();
});
it('keeps model rows out of Provider editing and places them under the Provider parent row',async()=>{
 const dialog=await open();expect(within(dialog).queryByRole('table',{name:'Provider 模型'})).not.toBeInTheDocument();expect(within(dialog).getByRole('textbox',{name:'Responses API 地址'})).toHaveValue('https://fixture.invalid/v1');
 expect(within(dialog).getByRole('button',{name:'保存并探测模型'})).toBeVisible();
 fireEvent.click(within(dialog).getByRole('button',{name:'运行信息'}));expect(screen.getByRole('dialog',{name:'Engine 运行信息'})).toHaveTextContent('codex app-server --fixture');
});
it('saves connection edits only after a successful probe and updates the model list',async()=>{
 const dialog=await open();fireEvent.change(within(dialog).getByRole('textbox',{name:'Responses API 地址'}),{target:{value:'https://new.invalid/v1'}});
 vi.mocked(api.agentManagement.detectModels).mockResolvedValueOnce({models:[{model:'new-model',name:'New',description:'',efforts:[],defaultEffort:'',context_window:500000,input_modalities:['text','image']}]});
 fireEvent.click(within(dialog).getByRole('button',{name:'保存并探测模型'}));await waitFor(()=>expect(api.agentManagement.updateProviderStream).toHaveBeenCalledTimes(1));
 expect(api.agentManagement.detectModels).toHaveBeenCalledWith('codex',{providerId:'fixture',endpoint:'https://new.invalid/v1',apiKey:undefined});
 expect(api.agentManagement.updateProviderStream).toHaveBeenCalledWith('codex','fixture',expect.objectContaining({fields:expect.objectContaining({baseUrl:'https://new.invalid/v1',models:['new-model'],defaultModel:'new-model'})}),expect.any(Function));
 expect(JSON.parse(String(vi.mocked(api.agentManagement.updateProviderStream).mock.lastCall?.[2].fields?.modelCapabilities))).toEqual({'new-model':{context_window:500000,input_modalities:['text','image']}});
});
it('does not save changed connection details if model detection fails',async()=>{
 const dialog=await open();fireEvent.change(within(dialog).getByRole('textbox',{name:'Responses API 地址'}),{target:{value:'https://invalid.invalid/v1'}});
 vi.mocked(api.agentManagement.detectModels).mockRejectedValueOnce(Error('Provider 探测失败'));fireEvent.click(within(dialog).getByRole('button',{name:'保存并探测模型'}));
 expect(await within(dialog).findByRole('alert')).toHaveTextContent('Provider 探测失败');expect(api.agentManagement.updateProviderStream).not.toHaveBeenCalled();
});
it('expands the Provider model table and probes only that Provider',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));
 const table=await screen.findByRole('table',{name:'Provider 模型'});await within(table).findByRole('checkbox',{name:'启用 model-a'});
 expect(within(table).queryByRole('radio',{name:/默认模型/})).toBeNull();
 expect(within(table).queryByRole('spinbutton',{name:'model-a 上下文长度'})).toBeNull();
 expect(within(table).getByRole('row',{name:/model-a/})).toHaveTextContent('200,000');
 expect(within(table).getByRole('row',{name:/model-a/})).toHaveTextContent('不支持');
 fireEvent.click(screen.getByRole('button',{name:'编辑模型'}));
 expect(within(table).getByRole('spinbutton',{name:'model-a 上下文长度'})).toHaveValue(200000);
 vi.mocked(api.agentManagement.detectModels).mockResolvedValueOnce({models:[{model:'model-a',name:'Model A',description:'',efforts:[],defaultEffort:'',context_window:300000},{model:'new-model',name:'New',description:'',efforts:[],defaultEffort:'',context_window:500000}]});
 fireEvent.click(screen.getByRole('button',{name:'探测模型'}));await within(table).findByRole('checkbox',{name:'启用 new-model'});
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('codex','fixture',expect.objectContaining({fields:expect.objectContaining({models:['model-a'],defaultModel:'model-a'})})));
 expect(within(table).getByRole('checkbox',{name:'启用 model-a'})).toBeChecked();expect(within(table).getByRole('checkbox',{name:'启用 new-model'})).not.toBeChecked();
});
it('edits and immediately refreshes the Provider multiplier in the parent row',async()=>{
 provider={...provider,fields:[...provider.fields,{key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text',value:'1.2'}]};state={...state,providers:[provider]};
 const invalidate=vi.spyOn(client,'invalidateQueries');
 mount();const button=await screen.findByRole('button',{name:'Fixture API 倍率 1.2×，点击编辑'});
 fireEvent.click(button);const input=screen.getByRole('textbox',{name:'Fixture API 倍率'});
 expect(input).toHaveValue('1.2');fireEvent.change(input,{target:{value:'2.5'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('codex','fixture',{fields:{providerRateMultiplier:'2.5'}}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Fixture API 倍率 2.5×，点击编辑'})).toBeVisible());
 expect(invalidate).toHaveBeenCalledWith({queryKey:['agent-model-configs']});
 expect(invalidate).toHaveBeenCalledWith({queryKey:['conversation-usage-intervals']});
});
it('rejects an invalid inline multiplier without sending a partial update',async()=>{
 provider={...provider,fields:[...provider.fields,{key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text',value:'1.2'}]};state={...state,providers:[provider]};
 mount();fireEvent.click(await screen.findByRole('button',{name:'Fixture API 倍率 1.2×，点击编辑'}));
 const input=screen.getByRole('textbox',{name:'Fixture API 倍率'});fireEvent.change(input,{target:{value:'0'}});fireEvent.keyDown(input,{key:'Enter'});
 expect(await screen.findByRole('alert')).toHaveTextContent('请输入大于 0 的倍率');expect(api.agentManagement.updateProvider).not.toHaveBeenCalled();
 fireEvent.keyDown(input,{key:'Escape'});expect(screen.getByRole('button',{name:'Fixture API 倍率 1.2×，点击编辑'})).toBeVisible();
});
it('keeps existing selections when discovery has no overlap and leaves them unchanged on probe failure',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));const table=await screen.findByRole('table',{name:'Provider 模型'});
 vi.mocked(api.agentManagement.detectModels).mockResolvedValueOnce({models:[{model:'fresh-a',name:'Fresh A',description:'',efforts:[],defaultEffort:''},{model:'fresh-b',name:'Fresh B',description:'',efforts:[],defaultEffort:''}]});
 fireEvent.click(screen.getByRole('button',{name:'探测模型'}));await within(table).findByRole('checkbox',{name:'启用 fresh-a'});
 await waitFor(()=>expect(api.agentManagement.updateProvider).toHaveBeenCalledWith('codex','fixture',expect.objectContaining({fields:expect.objectContaining({models:['model-a','model-b'],defaultModel:'model-a'})})));
 expect(within(table).getByRole('checkbox',{name:'启用 model-a'})).toBeChecked();
 expect(within(table).getByRole('checkbox',{name:'启用 fresh-a'})).not.toBeChecked();
 vi.mocked(api.agentManagement.detectModels).mockRejectedValueOnce(Error('探测失败'));vi.mocked(api.agentManagement.updateProvider).mockClear();
 fireEvent.click(screen.getByRole('button',{name:'探测模型'}));await screen.findByRole('alert');expect(api.agentManagement.updateProvider).not.toHaveBeenCalled();
});
it('isolates model settings by Provider and keeps all editing disabled in read-only mode',async()=>{
 configs.push({...configs[0],provider:'other',model:'private-other'});mount(true);fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));const table=await screen.findByRole('table',{name:'Provider 模型'});await within(table).findByText('model-a');expect(screen.queryByText('private-other')).toBeNull();expect(within(table).queryByRole('checkbox')).toBeNull();expect(within(table).queryByRole('spinbutton')).toBeNull();expect(screen.getByRole('button',{name:'探测模型'})).toBeDisabled();expect(screen.queryByRole('button',{name:'编辑模型'})).toBeNull();
});
it('shows model capabilities read-only until the explicit model edit action',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));const table=await screen.findByRole('table',{name:'Provider 模型'});await within(table).findByRole('checkbox',{name:'启用 model-a'});
 expect(within(table).queryByRole('spinbutton',{name:'model-a 上下文长度'})).toBeNull();
 expect(within(table).getByRole('row',{name:/model-a/})).toHaveTextContent('200,000');
 fireEvent.click(screen.getByRole('button',{name:'编辑模型'}));
 const context=within(table).getByRole('spinbutton',{name:'model-a 上下文长度'});fireEvent.change(context,{target:{value:'300000'}});
 fireEvent.click(screen.getByRole('button',{name:'保存并重启 Engine'}));
 await waitFor(()=>expect(api.agentManagement.updateModelConfigs).toHaveBeenCalledWith('codex',[expect.objectContaining({model:'model-a',contextWindow:300000})]));
});
it('displays the saved context window instead of stale detected metadata after restart',async()=>{
 configs=configs.map(config=>config.model==='model-a'?{...config,contextWindow:300000,maxContextWindow:300000}:config);
 vi.mocked(api.agentManagement.modelCatalog).mockImplementation(async()=>({models:provider.models.map(model=>({vendor:'OpenAI',model,providers:[provider.name],context_window:1050000,api_pricing:{currency:'USD',source:'official',reference_only:true,bands:[{rates:{input:2,cached:0.2,output:8}}]}}))}));
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));
 const table=await screen.findByRole('table',{name:'Provider 模型'});
 expect(within(table).getByRole('row',{name:/model-a/})).toHaveTextContent('300,000');
});
it('shows official image support even when stored model capability metadata is incomplete',async()=>{
 configs=configs.map(config=>({...config,inputModalities:[],supportsImages:null}));
 vi.mocked(api.agentManagement.modelConfigs).mockImplementation(async()=>({models:configs}));
 vi.mocked(api.agentManagement.modelCatalog).mockImplementation(async()=>({models:provider.models.map(model=>({vendor:'Anthropic',model,providers:[provider.name],
  context_window:200000,input_modalities:['text','image'],api_pricing:{currency:'USD',source:'official',reference_only:true,bands:[{rates:{input:2,cached:0.2,output:8}}]}}))}));
 mount();fireEvent.click(await screen.findByRole('button',{name:/展开Provider Fixture API 的模型/}));const table=await screen.findByRole('table',{name:'Provider 模型'});
 await within(table).findByText('model-a');
 expect(within(table).getByRole('row',{name:/model-a/})).toHaveTextContent('支持');
});
it('discards detected models whenever the endpoint or key changes, including late responses',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:'新增 Provider'}));
 expect(screen.getByRole('dialog',{name:'新增 Provider'})).toBeVisible();
 fireEvent.change(screen.getByLabelText('Provider ID'),{target:{value:'new'}});fireEvent.change(screen.getByLabelText('Responses API 地址'),{target:{value:'https://first.invalid/v1'}});fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'fixture'}});
 let finish!:(value:any)=>void;vi.mocked(api.agentManagement.detectModels).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));fireEvent.click(screen.getByRole('button',{name:'探测模型'}));await waitFor(()=>expect(api.agentManagement.detectModels).toHaveBeenCalled());
 fireEvent.change(screen.getByLabelText('Responses API 地址'),{target:{value:'https://second.invalid/v1'}});await act(async()=>finish({models:[{model:'stale',name:'Stale',description:'',efforts:[],defaultEffort:''}]}));expect(screen.queryByText('Stale')).toBeNull();expect(screen.getAllByRole('button',{name:'添加 Provider'}).at(-1)).toBeDisabled();
 vi.mocked(api.agentManagement.detectModels).mockResolvedValueOnce({models:[{model:'fresh',name:'Fresh',description:'',efforts:[],defaultEffort:''}]});await waitFor(()=>expect(screen.getByRole('button',{name:'探测模型'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'探测模型'}));expect((await screen.findAllByText('Fresh')).length).toBeGreaterThan(0);expect(screen.getAllByRole('button',{name:'添加 Provider'}).at(-1)).toBeEnabled();
 fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'another-fixture'}});expect(screen.queryByText('Fresh')).toBeNull();expect(screen.getAllByRole('button',{name:'添加 Provider'}).at(-1)).toBeDisabled();
});
