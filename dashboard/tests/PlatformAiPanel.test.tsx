import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAiPanel } from '../src/components/PlatformAiPanel';
import { platformAiApi } from '../src/lib/platform-ai';
import { api, type MyPermissions } from '../src/lib/api';

vi.mock('../src/lib/platform-ai', () => ({platformAiApi: {
  status: vi.fn(), config: vi.fn(), saveConfig: vi.fn(), conversations: vi.fn(), conversation: vi.fn(), send: vi.fn(),
  tasks: vi.fn(), stopTracking: vi.fn(), deliveries: vi.fn(), channels: vi.fn(), saveChannel: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), tools: vi.fn(),
  discoverModels: vi.fn(), testConnection: vi.fn(),
}}));
vi.mock('../src/lib/api', () => ({api: {users: {list: vi.fn()}}}));
let client: QueryClient;
const adminPermissions: MyPermissions = {permissions: {settings:'write',agent_api:'write',roles:'write'},roles:[],catalog:[]};

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  vi.mocked(platformAiApi.status).mockResolvedValue({enabled:true});
  vi.mocked(platformAiApi.conversations).mockResolvedValue({conversations:[]});
  vi.mocked(platformAiApi.conversation).mockResolvedValue({conversation:{id:'chat-1',title:'项目查询',channel_id:null},messages:[{id:'m1',role:'assistant',content:'有一个项目可供访问。',status:'done',error:null,created_at:'2026-10-19'}]});
  vi.mocked(platformAiApi.config).mockResolvedValue({config:{enabled:true,endpoint:'https://model.example/v1',model:'test-model',api_key_configured:true,timeout_ms:45000,max_tool_rounds:8,observation_interval_seconds:15,assessment_interval_seconds:90,notification_interval_seconds:300}});
  vi.mocked(platformAiApi.tasks).mockResolvedValue({tasks:[]});
  vi.mocked(platformAiApi.deliveries).mockResolvedValue({deliveries:[]});
  vi.mocked(platformAiApi.channels).mockResolvedValue({channels:[],bindings:[]});
  vi.mocked(api.users.list).mockResolvedValue({users:[{id:'u1',username:'member',display_name:'成员',role:'member'}]});
  vi.mocked(platformAiApi.tools).mockResolvedValue({tools:[],endpoints:[]});
});
afterEach(() => client.clear());
function mount(permissions = adminPermissions) {
  const onOpenSession = vi.fn();
  render(<QueryClientProvider client={client}><PlatformAiPanel permissions={permissions} onOpenSession={onOpenSession} /></QueryClientProvider>);
  return {onOpenSession};
}

describe('platform AI user flows', () => {
  it('sends a natural-language request and opens the persisted conversation', async () => {
    vi.mocked(platformAiApi.send).mockResolvedValue({conversation_id:'chat-1',message_id:'m1',duplicate:false});
    mount();
    fireEvent.change(screen.getByLabelText('发送给平台 AI 的消息'),{target:{value:'列出我能访问的项目'}});
    await waitFor(() => expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await screen.findByText('有一个项目可供访问。');
    expect(platformAiApi.send).toHaveBeenCalledWith(expect.objectContaining({content:'列出我能访问的项目',request_id:expect.any(String)}));
    expect(screen.getByLabelText('发送给平台 AI 的消息')).toHaveValue('');
  });
  it('reuses the same request id after an ambiguous network failure', async () => {
    vi.mocked(platformAiApi.send).mockRejectedValueOnce(new Error('Network failure')).mockResolvedValueOnce({conversation_id:'chat-1',message_id:'m1',duplicate:true});
    mount();
    fireEvent.change(screen.getByLabelText('发送给平台 AI 的消息'),{target:{value:'实现一个功能'}});
    await waitFor(() => expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await screen.findByText('有一个项目可供访问。');
    expect(vi.mocked(platformAiApi.send).mock.calls[0][0].request_id).toBe(vi.mocked(platformAiApi.send).mock.calls[1][0].request_id);
  });
  it('hides configuration and blocks sending for a read-only user', async () => {
    mount({permissions:{agent_api:'read'},roles:[],catalog:[]});
    expect(screen.queryByRole('button',{name:'模型配置'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'渠道与用户映射'})).not.toBeInTheDocument();
    expect(screen.getByLabelText('发送给平台 AI 的消息')).toBeDisabled();
  });
  it('saves model changes without resubmitting or exposing a saved API key', async () => {
    vi.mocked(platformAiApi.saveConfig).mockResolvedValue({config:{enabled:true,endpoint:'https://model.example/v1',model:'changed-model',api_key_configured:true,timeout_ms:45000,max_tool_rounds:8,observation_interval_seconds:15,assessment_interval_seconds:90,notification_interval_seconds:300}});
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    const model=await screen.findByLabelText('模型名称');
    fireEvent.change(model,{target:{value:'changed-model'}});
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button',{name:'保存模型配置'}));
    await screen.findByRole('status');
    expect(platformAiApi.saveConfig).toHaveBeenCalledWith(expect.objectContaining({model:'changed-model'}));
    expect(vi.mocked(platformAiApi.saveConfig).mock.calls[0][0]).not.toHaveProperty('api_key');
    expect(vi.mocked(platformAiApi.saveConfig).mock.calls[0][0]).not.toHaveProperty('api_key_configured');
  });
  it('discovers models from the current draft and selects one without saving first', async () => {
    vi.mocked(platformAiApi.discoverModels).mockResolvedValue({models:['alpha-model','tools-model']});
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    fireEvent.change(await screen.findByLabelText('模型 API 地址'),{target:{value:'https://new.example/v1'}});
    fireEvent.change(screen.getByLabelText('API Key'),{target:{value:'unsaved-key'}});
    fireEvent.click(screen.getByRole('button',{name:'获取模型列表'}));
    const select = await screen.findByLabelText('选择探测到的模型');
    fireEvent.change(select,{target:{value:'tools-model'}});
    expect(screen.getByLabelText('模型名称')).toHaveValue('tools-model');
    expect(platformAiApi.discoverModels).toHaveBeenCalledWith(expect.objectContaining({endpoint:'https://new.example/v1',api_key:'unsaved-key'}));
    expect(platformAiApi.saveConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('模型 API 地址'),{target:{value:'https://other.example/v1'}});
    expect(screen.queryByLabelText('选择探测到的模型')).not.toBeInTheDocument();
  });
  it('keeps manual model input available if the provider has no model listing endpoint', async () => {
    vi.mocked(platformAiApi.discoverModels).mockRejectedValue(new Error('模型请求失败 (HTTP 404)'));
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    fireEvent.click(await screen.findByRole('button',{name:'获取模型列表'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('可手动填写模型名称');
    fireEvent.change(screen.getByLabelText('模型名称'),{target:{value:'manual-model'}});
    expect(screen.getByRole('button',{name:'测试连通性'})).toBeEnabled();
  });
  it('tests with a stored key, displays each check and clears stale results when the model changes', async () => {
    vi.mocked(platformAiApi.testConnection).mockResolvedValue({ok:true,model:'test-model',elapsed_ms:250,checks:{connection:{status:'passed',message:'接口可达'},response:{status:'passed',message:'回复有效'},tools:{status:'passed',message:'结构化调用有效'}}});
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    fireEvent.click(await screen.findByRole('button',{name:'测试连通性'}));
    expect(await screen.findByRole('status')).toHaveTextContent('测试通过');
    expect(screen.getByText('接口连接：通过')).toBeVisible();
    expect(screen.getByText('模型响应：通过')).toBeVisible();
    expect(screen.getByText('工具调用：通过')).toBeVisible();
    expect(platformAiApi.testConnection).toHaveBeenCalledWith({endpoint:'https://model.example/v1',model:'test-model',timeout_ms:45000});
    expect(platformAiApi.saveConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('模型名称'),{target:{value:'other-model'}});
    expect(screen.queryByRole('region',{name:'模型连通性测试结果'})).not.toBeInTheDocument();
  });
  it('reports unsupported tools separately and does not claim the model is ready', async () => {
    vi.mocked(platformAiApi.testConnection).mockResolvedValue({ok:false,model:'test-model',elapsed_ms:250,checks:{connection:{status:'passed',message:'接口可达'},response:{status:'passed',message:'回复有效'},tools:{status:'failed',message:'不支持工具调用'}}});
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    fireEvent.click(await screen.findByRole('button',{name:'测试连通性'}));
    expect(await screen.findByRole('status')).toHaveTextContent('测试未全部通过');
    expect(screen.getByText('模型响应：通过')).toBeVisible();
    expect(screen.getByText('工具调用：失败')).toBeVisible();
  });
  it('prevents duplicate requests and configuration changes while a test is running', async () => {
    let finish!: () => void;
    vi.mocked(platformAiApi.discoverModels).mockImplementation(() => new Promise(resolve => {finish = () => resolve({models:[]});}));
    mount();fireEvent.click(screen.getByRole('button',{name:'模型配置'}));
    fireEvent.click(await screen.findByRole('button',{name:'获取模型列表'}));
    expect(screen.getByRole('button',{name:'正在获取模型…'})).toBeDisabled();
    expect(screen.getByLabelText('模型 API 地址')).toBeDisabled();
    expect(screen.getByRole('button',{name:'测试连通性'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'保存模型配置'})).toBeDisabled();
    finish();
    await screen.findByText('接口返回的模型列表为空，可手动填写模型名称。');
    expect(screen.getByLabelText('模型 API 地址')).toBeEnabled();
  });
  it('creates a channel and binds its external identity to a selected platform user', async () => {
    const channel={id:'channel-1',name:'团队企业微信',kind:'wecom' as const,enabled:0,config:{},secret_fields_configured:[],callback_path:'/api/platform-ai/callbacks/channel-1'};
    vi.mocked(platformAiApi.saveChannel).mockImplementation(async () => {
      vi.mocked(platformAiApi.channels).mockResolvedValue({channels:[channel],bindings:[]});return {channel};
    });
    vi.mocked(platformAiApi.saveBinding).mockResolvedValue({ok:true});
    mount();fireEvent.click(screen.getByRole('button',{name:'渠道与用户映射'}));
    fireEvent.click(await screen.findByRole('button',{name:'添加渠道'}));
    fireEvent.change(screen.getByLabelText('渠道名称'),{target:{value:'团队企业微信'}});
    fireEvent.click(screen.getByRole('button',{name:'保存渠道'}));
    await screen.findByRole('option',{name:'团队企业微信'});
    fireEvent.change(screen.getByLabelText('映射渠道'),{target:{value:'channel-1'}});
    fireEvent.change(screen.getByLabelText('外部用户 ID'),{target:{value:'wecom-member'}});
    fireEvent.change(screen.getByLabelText('映射平台用户'),{target:{value:'u1'}});
    fireEvent.click(screen.getByRole('button',{name:'保存用户映射'}));
    await waitFor(() => expect(platformAiApi.saveBinding).toHaveBeenCalledWith({channel_id:'channel-1',external_user_id:'wecom-member',user_id:'u1'}));
  });
  it('shows completion evidence and opens the corresponding project session', async () => {
    vi.mocked(platformAiApi.tasks).mockResolvedValue({tasks:[{id:'task-1',conversation_id:'chat-1',session_id:'session-1',project_id:'p1',requirement:'实现导出',status:'reported_complete',summary:'实现完成，测试未执行。',evidence:'已完成导出功能',updated_at:'2026-10-19'}]});
    const {onOpenSession}=mount();fireEvent.click(screen.getByRole('button',{name:'任务跟踪'}));
    await screen.findByText('实现完成，测试未执行。');
    expect(screen.getByText(/task-1.*Agent 已报告完成/)).toBeVisible();
    fireEvent.click(screen.getByText('查看判断依据'));
    expect(screen.getByText('已完成导出功能')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'打开会话'}));
    expect(onOpenSession).toHaveBeenCalledWith('p1','session-1');
  });
});
