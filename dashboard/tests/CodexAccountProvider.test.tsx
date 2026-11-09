import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {CodexAccountProvider} from '../src/components/CodexAccountProvider';
import {api,type CodexEnvironment,type CodexAccountDetails} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{projects:{list:vi.fn(async()=>({projects:[]}))},codexEnvironments:{details:vi.fn(),management:vi.fn(),usage:vi.fn(),save:vi.fn()}}}));
const environment:CodexEnvironment={id:'account:fixture',name:'Saved account',kind:'account',enabled:true,allowed_user_ids:[],connection:{username:'fixture_user',port:22,authMethod:'key',identityFile:'',codexCommand:'codex',codexHome:''}};
const details:CodexAccountDetails={id:environment.id,checked_at:'2026-11-09T00:00:00Z',executable:'/fixture/bin/codex',version:'codex-cli 0.fixture',home:'/fixture/.codex',engine:{state:'connected',pid:123},authentication:{status:'authenticated',type:'chatgpt',email:'fixture@example.invalid',plan:'fixture-plan'},config:{path:'/fixture/.codex/config.toml',exists:true,notice:null},settings:{model:'fixture-model',model_provider:'openai',model_reasoning_effort:'high'},models:[{model:'fixture-model',name:'Fixture model',description:'Selected user model',defaultEffort:'high'}]};
let client:QueryClient;
beforeEach(()=>{vi.clearAllMocks();client=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(api.codexEnvironments.details).mockResolvedValue({details});vi.mocked(api.codexEnvironments.management).mockResolvedValue({environments:[environment],users:[]});vi.mocked(api.codexEnvironments.usage).mockResolvedValue({tabs:[],busy:false,verified:true});vi.mocked(api.codexEnvironments.save).mockResolvedValue({environment});});
afterEach(()=>client.clear());
const mount=()=>render(<QueryClientProvider client={client}><CodexAccountProvider environment={environment}/></QueryClientProvider>);
describe('saved Codex account Provider page',()=>{
 it('loads the selected user actual account, models, defaults and paths instead of showing the edit form again',async()=>{
  mount();expect(await screen.findByText('fixture@example.invalid')).toBeVisible();expect(screen.getByText('codex-cli 0.fixture')).toBeVisible();expect(screen.getByText('/fixture/.codex')).toBeVisible();expect(screen.getByText('Fixture model')).toBeVisible();expect(api.codexEnvironments.details).toHaveBeenCalledWith(environment.id);expect(screen.queryByRole('textbox',{name:'Codex 命令'})).not.toBeInTheDocument();expect(screen.queryByRole('table',{name:'Provider 占用标签页列表'})).not.toBeInTheDocument();
 });
 it('offers editing and preserves the saved details on cancel',async()=>{
  mount();await screen.findByText('fixture@example.invalid');fireEvent.click(screen.getByRole('button',{name:'编辑配置'}));expect(screen.getByRole('textbox',{name:'Codex 命令'})).toHaveValue('codex');fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));expect(await screen.findByText('fixture@example.invalid')).toBeVisible();expect(api.codexEnvironments.save).not.toHaveBeenCalled();
 });
 it('keeps the saved Provider editable when details cannot be read',async()=>{
  vi.mocked(api.codexEnvironments.details).mockRejectedValue(Error('SSH 认证失败'));mount();expect(await screen.findByRole('alert')).toHaveTextContent('SSH 认证失败');expect(screen.getByRole('heading',{name:'Saved account'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'编辑配置'}));expect(screen.getByRole('textbox',{name:'系统用户名'})).toHaveValue('fixture_user');
 });
});
