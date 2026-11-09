import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor,within} from '@testing-library/react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {CodexAccountProviderEditor} from '../src/components/CodexAccountProviderEditor';
import {ConversationEnvironmentSelector} from '../src/components/ConversationEnvironmentSelector';
import {ProjectSessionCreateDialog} from '../src/components/ProjectSessionCreateDialog';
import {api,type Project,type CodexEnvironment} from '../src/lib/api';
vi.mock('../src/lib/api',async original=>{const actual=await original<typeof import('../src/lib/api')>();return {...actual,api:{...actual.api,projects:{...actual.api.projects,list:vi.fn(async()=>({projects:[]}))},codexEnvironments:{management:vi.fn(),list:vi.fn(),save:vi.fn(),checkConnection:vi.fn(),preflight:vi.fn(),forSession:vi.fn(),sessionPreflight:vi.fn(),transfer:vi.fn(),usage:vi.fn(),remove:vi.fn(),closeTabs:vi.fn()},sessions:{...actual.api.sessions,create:vi.fn()}}};});
const native:CodexEnvironment={id:'native',name:'xlli 默认账号',kind:'native',enabled:true,allowed_user_ids:null};
const account:CodexEnvironment={id:'account:ymchen',name:'ymchen Codex',kind:'account',enabled:true,allowed_user_ids:['ymchen'],connection:{authMethod:'key',username:'ymchen',port:22,identityFile:'',codexCommand:'codex',codexHome:''}};
const model={model:'fixture-model',provider:'openai',name:'Fixture',description:'',efforts:[{value:'high',description:''}],defaultEffort:'high'};
let client:QueryClient;
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[native,account],users:[{id:'ymchen',username:'ymchen',display_name:null},{id:'xlli',username:'xlli',display_name:null}]});vi.mocked(api.codexEnvironments.list).mockResolvedValue({environments:[account]});vi.mocked(api.codexEnvironments.forSession).mockResolvedValue({current:'native',environments:[{...native,can_control:true},{...account,can_control:true}]});vi.mocked(api.codexEnvironments.sessionPreflight).mockResolvedValue({ok:true,checks:[{stage:'codex_authentication',ok:true,message:'已登录'}],models:[model]});vi.mocked(api.codexEnvironments.transfer).mockResolvedValue({ok:true});vi.mocked(api.codexEnvironments.usage).mockResolvedValue({tabs:[],busy:false,verified:true});vi.mocked(api.codexEnvironments.remove).mockResolvedValue({ok:true});});
afterEach(()=>client.clear());
const mount=(child:React.ReactNode)=>render(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
describe('Codex environments UI',()=>{
 it('explains executable-only input immediately and prevents misleading SSH checks with CLI flags',async()=>{
  mount(<CodexAccountProviderEditor onSaved={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'账号 Provider 名称'}),{target:{value:'Private'}});
  fireEvent.change(screen.getByRole('textbox',{name:'系统用户名'}),{target:{value:'ymchen'}});
  fireEvent.change(screen.getByRole('combobox',{name:'SSH 认证方式'}),{target:{value:'key'}});
  const command=screen.getByRole('textbox',{name:'Codex 命令'});
  fireEvent.change(command,{target:{value:'codex --dangerously-bypass-approvals-and-sandbox'}});
  expect(command).toHaveAttribute('aria-invalid','true');expect(screen.getByRole('alert')).toHaveTextContent('例如填写 codex');
  expect(screen.getByRole('button',{name:'预检连接、已有登录、模型与项目'})).toBeDisabled();expect(screen.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();
  expect(api.codexEnvironments.checkConnection).not.toHaveBeenCalled();
  fireEvent.change(command,{target:{value:'codex'}});expect(command).toHaveAttribute('aria-invalid','false');expect(screen.getByRole('button',{name:'保存账号 Provider'})).toBeEnabled();
 });
 it('keeps occupancy hidden until Delete opens a dialog and closes it without deleting anything on cancel',async()=>{
  vi.mocked(api.codexEnvironments.usage).mockResolvedValue({tabs:[{id:'s',user_id:'ymchen',username:'ymchen',project_id:'p',project_name:'Project',name:'Busy tab',status:'running',native_id:'n',model:'Model',busy:true}],busy:true,verified:true});
  mount(<CodexAccountProviderEditor environment={account} onSaved={vi.fn()}/>);
  await waitFor(()=>expect(api.codexEnvironments.usage).toHaveBeenCalled());
  expect(screen.queryByRole('table',{name:'Provider 占用标签页列表'})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'删除账号 Provider'}));
  const dialog=await screen.findByRole('dialog',{name:'删除 Provider · ymchen Codex'});
  expect(await within(dialog).findByText('Busy tab')).toBeVisible();expect(within(dialog).getByRole('button',{name:'确认删除 Provider'})).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button',{name:'取消',exact:true}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.queryByRole('table')).not.toBeInTheDocument();expect(api.codexEnvironments.remove).not.toHaveBeenCalled();
 });

 it('configures SSH password and user grants in one account Provider form using the existing Codex login',async()=>{
  const saved=vi.fn();mount(<CodexAccountProviderEditor onSaved={saved}/>);await screen.findByRole('checkbox',{name:'允许 ymchen 使用'});
  expect(screen.getByText(/已经登录/)).toBeVisible();fireEvent.change(screen.getByRole('textbox',{name:'账号 Provider 名称'}),{target:{value:'private'}});fireEvent.change(screen.getByRole('textbox',{name:'系统用户名'}),{target:{value:'ymchen'}});
  expect(screen.getByRole('button',{name:'保存账号 Provider'})).toBeDisabled();fireEvent.change(screen.getByLabelText('SSH 登录密码'),{target:{value:'dummy-test-password'}});fireEvent.click(screen.getByRole('checkbox',{name:'允许 ymchen 使用'}));
  vi.mocked(api.codexEnvironments.checkConnection).mockResolvedValueOnce({ok:false,checks:[{stage:'ssh_authentication',ok:false,message:'SSH 密码认证失败'}]});fireEvent.click(screen.getByRole('button',{name:'预检连接、已有登录、模型与项目'}));expect(await screen.findByRole('alert')).toHaveTextContent('SSH 密码认证失败');
  vi.mocked(api.codexEnvironments.save).mockResolvedValueOnce({environment:account});fireEvent.click(screen.getByRole('button',{name:'保存账号 Provider'}));await waitFor(()=>expect(saved).toHaveBeenCalledWith(account));expect(api.codexEnvironments.save).toHaveBeenCalledWith(expect.objectContaining({name:'private',allowed_user_ids:['ymchen'],connection:expect.objectContaining({username:'ymchen',authMethod:'password',password:'dummy-test-password'})}),undefined);
 });
 it('requires a successful destination preflight and retains the source selector when transfer fails',async()=>{
  mount(<ConversationEnvironmentSelector sessionId="s" busy={false}/>);const select=await screen.findByRole('combobox',{name:'选择 Codex 账号环境'});fireEvent.change(select,{target:{value:account.id}});
  const dialog=screen.getByRole('dialog');expect(within(dialog).getByRole('button',{name:'复制历史并切换'})).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button',{name:'预检连接、登录、模型与项目权限'}));await within(dialog).findByRole('combobox',{name:'目标环境模型'});
  vi.mocked(api.codexEnvironments.transfer).mockRejectedValueOnce(Error('目标恢复失败，原会话保持不变'));fireEvent.click(within(dialog).getByRole('button',{name:'复制历史并切换'}));expect(await within(dialog).findByRole('alert')).toHaveTextContent('原会话保持不变');expect(select).toHaveValue('native');
  expect(api.codexEnvironments.transfer).toHaveBeenCalledWith('s',{environment_id:account.id,provider:'openai',model:'fixture-model',effort:'high'});
 });
 it('disables account switching while a task is running',async()=>{mount(<ConversationEnvironmentSelector sessionId="s" busy/>);expect(await screen.findByRole('combobox',{name:'选择 Codex 账号环境'})).toBeDisabled();});
 it('creates a new Codex tab with the authorized account instead of falling back to native',async()=>{
  const p:Project={id:'p',name:'Project',path:'/fixture/project',description:null,session_prompt:null,openclaw_prompt:null,color:'',created_at:'',tool_access:{can_session:true,can_terminal:false,session_clients:['codex']}};
  vi.mocked(api.sessions.create).mockResolvedValueOnce({ok:true,session:{id:'s'} as any});mount(<ProjectSessionCreateDialog project={p} onClose={vi.fn()} onSessionCreated={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'新标签页 Codex 环境'})).toHaveValue(account.id));await waitFor(()=>expect(screen.getByRole('button',{name:'新建会话'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'新建会话'}));await waitFor(()=>expect(api.sessions.create).toHaveBeenCalledWith(expect.objectContaining({environment_id:account.id,cli_type:'codex'})));
 });
 it('blocks new tabs when no Codex environments are authorized',async()=>{vi.mocked(api.codexEnvironments.list).mockResolvedValueOnce({environments:[]});const ready=vi.fn();const {CodexCreateEnvironment}=await import('../src/components/CodexCreateEnvironment');mount(<CodexCreateEnvironment projectId="p" onChange={vi.fn()} onReady={ready}/>);expect(await screen.findByRole('alert')).toHaveTextContent('没有可使用');expect(ready).toHaveBeenLastCalledWith(false);});
});
