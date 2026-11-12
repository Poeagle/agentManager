import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {CodexAccountProvider} from '../src/components/CodexAccountProvider';
import {api,type CodexEnvironment,type CodexAccountDetails} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn(async()=>({auth_mode:'api',status:'available',amount:66.81,currency:'USD',todayActualCost:1.25})),api:{projects:{list:vi.fn(async()=>({projects:[]}))},codexEnvironments:{details:vi.fn(),quota:vi.fn(async()=>({quota:null,reason:'not_applicable'})),configFiles:vi.fn(async()=>({files:[{id:'config',path:'/fixture/.codex/config.toml',exists:true,label:'Codex 配置',description:'模型配置',format:'TOML'},{id:'credentials',path:'/fixture/.codex/auth.json',exists:true,label:'Codex 凭据文件',description:'仅显示文件状态',format:'JSON',sensitive:true}]})),readConfigFile:vi.fn(async()=>({content:'model = \"test\"',revision:'version',exists:true})),writeConfigFile:vi.fn(async(_id,_file,content)=>({content,revision:'next',exists:true})),management:vi.fn(),usage:vi.fn(),save:vi.fn()}}}));
const environment:CodexEnvironment={id:'account:fixture',name:'Saved account',kind:'account',enabled:true,allowed_user_ids:[],connection:{username:'fixture_user',port:22,authMethod:'key',identityFile:'',codexCommand:'codex',codexHome:''}};
const details:CodexAccountDetails={id:environment.id,checked_at:'2026-11-09T00:00:00Z',executable:'/fixture/bin/codex',version:'codex-cli 0.fixture',home:'/fixture/.codex',engine:{state:'connected',pid:123},authentication:{status:'authenticated',type:'chatgpt',email:'fixture@example.invalid',plan:'fixture-plan'},config:{path:'/fixture/.codex/config.toml',exists:true,notice:null},settings:{model:'fixture-model',model_provider:'openai',model_reasoning_effort:'high'},models:[{model:'fixture-model',name:'Fixture model',description:'Selected user model',defaultEffort:'high'}]};
let client:QueryClient;
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(api.codexEnvironments.details).mockResolvedValue({details});vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[environment],users:[]});vi.mocked(api.codexEnvironments.usage).mockResolvedValue({tabs:[],busy:false,verified:true});vi.mocked(api.codexEnvironments.save).mockResolvedValue({environment});});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><CodexAccountProvider environment={environment}/></QueryClientProvider>);
describe('saved Codex account Provider page',()=>{
 it('labels a native API key engine as API and shows wallet information without account quota',async()=>{
  vi.mocked(api.codexEnvironments.details).mockResolvedValue({details:{...details,authentication:{status:'authenticated',type:'apiKey',email:null,plan:null}}});
  render(<QueryClientProvider client={client}><CodexAccountProvider environment={{id:'native',name:'Native',kind:'native',auth_mode:'api',enabled:true,allowed_user_ids:null}}/></QueryClientProvider>);
  expect(await screen.findByText('CODEX API')).toBeVisible();expect(await screen.findByText(/66\.81/)).toBeVisible();expect(screen.queryByText('CODEX 登录账号')).not.toBeInTheDocument();expect(screen.queryByText('周额度剩余')).not.toBeInTheDocument();expect(screen.getByText('此认证方式不提供订阅额度')).toBeVisible();
 });
 it('loads the selected user actual account, models, defaults and paths instead of showing the edit form again',async()=>{
  mount();expect(await screen.findByText('fixture@example.invalid')).toBeVisible();expect(screen.getByText('codex-cli 0.fixture')).toBeVisible();expect(screen.getByText('/fixture/.codex')).toBeVisible();expect(screen.getByText('Fixture model')).toBeVisible();expect(api.codexEnvironments.details).toHaveBeenCalledWith(environment.id);expect(screen.queryByRole('textbox',{name:'Codex 命令'})).not.toBeInTheDocument();expect(screen.queryByRole('table',{name:'Provider 占用标签页列表'})).not.toBeInTheDocument();
 });
 it('shows credential file status without requesting or exposing credential contents',async()=>{
  mount();const credential=await screen.findByRole('button',{name:/Codex 凭据文件/});expect(credential).toHaveTextContent('已存在 · 受保护');fireEvent.click(credential);expect(screen.getByRole('dialog',{name:'Codex 凭据文件'})).toHaveTextContent('凭据内容受保护');expect(api.codexEnvironments.readConfigFile).not.toHaveBeenCalled();
 });
 it('uses the same details layout and fields for native and SSH accounts',async()=>{
  const view=mount();await screen.findByText('fixture@example.invalid');const fields=['登录状态','账号身份','登录方式 / 套餐','Codex 引擎','周额度剩余','额度重置时间','执行用户','Codex 版本','默认模型','模型 Provider','默认推理强度','执行确认策略','沙箱模式','本机连接'];
  for(const field of fields)expect(screen.getByText(field,{exact:true})).toBeVisible();view.unmount();
  render(<QueryClientProvider client={client}><CodexAccountProvider environment={{id:'native',name:'Native',kind:'native',enabled:true,allowed_user_ids:null}} onNativeEdit={()=>{}}/></QueryClientProvider>);
  await screen.findByText('fixture@example.invalid');for(const field of fields)expect(screen.getByText(field,{exact:true})).toBeVisible();expect(screen.getByText('本机直接运行')).toBeVisible();expect(screen.queryByRole('table',{name:'Provider 占用标签页列表'})).not.toBeInTheDocument();
 });
 it('opens the selected account configuration in a centered dialog and saves edits',async()=>{
  mount();fireEvent.click(await screen.findByRole('button',{name:/Codex 配置/}));const editor=await screen.findByRole('textbox',{name:'Codex 配置 内容'});fireEvent.change(editor,{target:{value:'model = "updated"'}});fireEvent.click(screen.getByRole('button',{name:'保存文件'}));await waitFor(()=>expect(api.codexEnvironments.writeConfigFile).toHaveBeenCalledWith(environment.id,'config','model = "updated"','version'));
 });
 it('offers editing and preserves the saved details on cancel',async()=>{
  mount();await screen.findByText('fixture@example.invalid');fireEvent.click(screen.getByRole('button',{name:'编辑配置'}));expect(screen.getByRole('textbox',{name:'Codex 命令'})).toHaveValue('codex');fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect(await screen.findByText('fixture@example.invalid')).toBeVisible();expect(api.codexEnvironments.save).not.toHaveBeenCalled();
 });
 it('keeps the saved Provider editable when details cannot be read',async()=>{
  vi.mocked(api.codexEnvironments.details).mockRejectedValue(Error('SSH 认证失败'));mount();expect(await screen.findByRole('alert')).toHaveTextContent('SSH 认证失败');expect(screen.getByRole('heading',{name:'Saved account'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'编辑配置'}));expect(screen.getByRole('textbox',{name:'系统用户名'})).toHaveValue('fixture_user');
 });
});
