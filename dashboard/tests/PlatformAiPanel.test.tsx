import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAiPanel } from '../src/components/PlatformAiPanel';
import { platformAiApi } from '../src/lib/platform-ai';
import { api, type MyPermissions } from '../src/lib/api';

vi.mock('../src/lib/platform-ai', () => ({platformAiApi: {
  status: vi.fn(), agents: vi.fn(), config: vi.fn(), saveConfig: vi.fn(), conversations: vi.fn(), conversation: vi.fn(), send: vi.fn(),
  tasks: vi.fn(), stopTracking: vi.fn(), deliveries: vi.fn(), channels: vi.fn(), saveChannel: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), tools: vi.fn(),
  discoverModels: vi.fn(), testConnection: vi.fn(),
  testChannel: vi.fn(), reconnectChannel: vi.fn(), saveNotificationTarget: vi.fn(), deleteNotificationTarget: vi.fn(), deleteChannel: vi.fn(),
  projectNotifications: vi.fn(), saveProjectNotification: vi.fn(), deleteProjectNotification: vi.fn(),
}}));
vi.mock('../src/lib/api', () => ({api: {users: {list: vi.fn()}}}));
let client: QueryClient;
const adminPermissions: MyPermissions = {permissions: {settings:'write',agent_api:'write',roles:'write'},roles:[],catalog:[]};

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  vi.mocked(platformAiApi.status).mockResolvedValue({enabled:true});
  vi.mocked(platformAiApi.agents).mockResolvedValue({agents:[{cli_type:'codex',label:'Codex',status:'available',reason:'命令可找到'},{cli_type:'claude',label:'Claude',status:'unavailable',reason:'未找到命令'}]});
  vi.mocked(platformAiApi.conversations).mockResolvedValue({conversations:[]});
  vi.mocked(platformAiApi.conversation).mockResolvedValue({conversation:{id:'chat-1',title:'项目查询',channel_id:null},messages:[{id:'m1',role:'assistant',content:'有一个项目可供访问。',status:'done',error:null,created_at:'2026-10-19'}]});
  vi.mocked(platformAiApi.config).mockResolvedValue({config:{enabled:true,endpoint:'https://model.example/v1',model:'test-model',api_key_configured:true,timeout_ms:45000,max_tool_rounds:8,observation_interval_seconds:15,assessment_interval_seconds:90,notification_interval_seconds:300}});
  vi.mocked(platformAiApi.tasks).mockResolvedValue({tasks:[]});
  vi.mocked(platformAiApi.deliveries).mockResolvedValue({deliveries:[]});
  vi.mocked(platformAiApi.channels).mockResolvedValue({channels:[],bindings:[]});
  vi.mocked(api.users.list).mockResolvedValue({users:[{id:'u1',username:'member',display_name:'成员',role:'member'}]});
  vi.mocked(platformAiApi.tools).mockResolvedValue({tools:[],endpoints:[]});
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });
function mount(permissions = adminPermissions) {
  const onOpenSession = vi.fn();
  render(<QueryClientProvider client={client}><PlatformAiPanel permissions={permissions} onOpenSession={onOpenSession} /></QueryClientProvider>);
  return {onOpenSession};
}

describe('platform AI user flows', () => {
  it('shows received images, pending downloads and failed media while keeping image URLs authenticated', async () => {
    vi.mocked(platformAiApi.conversations).mockResolvedValue({conversations: [{id: 'chat-1', title: '截图需求', channel_id: 'bot-1'}]});
    vi.mocked(platformAiApi.conversation).mockResolvedValue({conversation: {id: 'chat-1', title: '截图需求', channel_id: 'bot-1'}, messages: [{
      id: 'image-message', role: 'user', content: '请根据截图修复', status: 'done', error: null, created_at: '', attachments: [
        {id: 'image-1', status: 'ready', mime: 'image/png', bytes: 100, error: null},
        {id: 'image-2', status: 'pending', mime: '', bytes: 0, error: null},
        {id: 'image-3', status: 'failed', mime: '', bytes: 0, error: '图片下载失败，请重新发送'},
      ],
    }]});
    mount(); fireEvent.click(await screen.findByRole('button', {name: /截图需求/}));
    const image = await screen.findByRole('img', {name: '用户发送的图片 1'});
    expect(image).toHaveAttribute('src', '/api/platform-ai/attachments/image-1');
    expect(screen.getByRole('link', {name: '查看原图 1'})).toHaveAttribute('href', '/api/platform-ai/attachments/image-1');
    expect(screen.getByText('图片 2：正在接收…')).toBeVisible();
    expect(screen.getByText('图片 3：图片下载失败，请重新发送')).toBeVisible();
    fireEvent.error(image);
    expect(screen.getByText('图片加载失败，点击重试查看原图')).toBeVisible();
  });
  it('renders AI Markdown tables, emphasis and code while preserving literal user messages', async () => {
    const content = '当前账户下可见的项目有 **1 个**：\n\n| 项目 | 路径 | 可用客户端 |\n| --- | --- | --- |\n| xeleQuote | `/home/xlli/ymchen/xeleQuote` | **Codex** |\n\n- 只读分析\n\n```sh\ncodex --version\n```';
    vi.mocked(platformAiApi.conversations).mockResolvedValue({conversations:[{id:'chat-1',title:'项目列表',channel_id:null}]});
    vi.mocked(platformAiApi.conversation).mockResolvedValue({conversation:{id:'chat-1',title:'项目列表',channel_id:null},messages:[
      {id:'u1',role:'user',content:'保留原文 **项目**',status:'done',error:null,created_at:'2026-10-19'},
      {id:'a1',role:'assistant',content,status:'done',error:null,created_at:'2026-10-19'},
    ]});
    mount();fireEvent.click(await screen.findByRole('button',{name:/项目列表/}));
    expect(await screen.findByRole('table')).toBeVisible();
    expect(screen.getByRole('columnheader',{name:'项目'})).toBeVisible();
    expect(screen.getByRole('cell',{name:'xeleQuote'})).toBeVisible();
    expect(screen.getByText('1 个').tagName).toBe('STRONG');
    expect(screen.getByText('Codex',{exact:true}).tagName).toBe('STRONG');
    expect(screen.getByText('codex --version').closest('pre')).not.toBeNull();
    expect(screen.getByRole('region',{name:'横向滚动表格'})).toHaveClass('overflow-x-auto');
    expect(screen.getByText('保留原文 **项目**')).toBeVisible();
  });
  it('shows discovered agents and streams progress and partial text into the current conversation', async () => {
    const sources: Array<{url: string; onopen: (()=>void) | null; onerror: (()=>void) | null; onmessage: ((event: {data: string})=>void) | null; close: ReturnType<typeof vi.fn>}> = [];
    vi.stubGlobal('EventSource', class {
      url: string;
      onopen: (()=>void) | null = null;
      onerror: (()=>void) | null = null;
      onmessage: ((event: {data: string})=>void) | null = null;
      close = vi.fn();
      constructor(url: string) {this.url=url;sources.push(this);}
    });
    const userMessage={id:'user-1',role:'user' as const,content:'列出项目',status:'processing',error:null,created_at:'2026-10-19',progress:'正在等待模型回复…',partial_content:''};
    vi.mocked(platformAiApi.conversation).mockResolvedValue({conversation:{id:'chat-1',title:'项目查询',channel_id:null},messages:[userMessage]});
    vi.mocked(platformAiApi.send).mockResolvedValue({conversation_id:'chat-1',message_id:'user-1',duplicate:false});
    mount();
    expect(await screen.findByText('Codex · 命令可用')).toBeVisible();
    expect(screen.getByText('Claude · 未找到')).toBeVisible();
    fireEvent.change(screen.getByLabelText('发送给平台 AI 的消息'),{target:{value:'列出项目'}});
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await screen.findByText('正在等待模型回复…');
    expect(sources[0].url).toBe('/api/platform-ai/conversations/chat-1/events');
    act(()=>{
      sources[0].onopen?.();
      sources[0].onmessage?.({data:JSON.stringify({type:'message',message:{...userMessage,progress:'正在生成回复…',partial_content:'**当前有两个**'}})});
    });
    expect(await screen.findByText('当前有两个')).toBeVisible();
    expect(screen.getByText('当前有两个').tagName).toBe('STRONG');
    expect(screen.getByText('实时更新中')).toBeVisible();
    act(()=>{sources[0].onerror?.();});
    expect(screen.getByText('连接恢复中，暂用定时更新')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'任务跟踪'}));
    expect(sources[0].close).toHaveBeenCalledTimes(1);
  });
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
  it('sends on a LAN HTTP origin where randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto)});
    expect(typeof crypto.randomUUID).toBe('undefined');
    vi.mocked(platformAiApi.send).mockResolvedValue({conversation_id:'chat-1',message_id:'m1',duplicate:false});
    mount();
    fireEvent.change(screen.getByLabelText('发送给平台 AI 的消息'),{target:{value:'你好'}});
    await waitFor(() => expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    await screen.findByText('有一个项目可供访问。');
    expect(platformAiApi.send).toHaveBeenCalledWith(expect.objectContaining({content:'你好',request_id:expect.stringMatching(/^[a-f0-9]{32}$/)}));
    expect(screen.getByLabelText('发送给平台 AI 的消息')).toHaveValue('');
    expect(screen.getByLabelText('发送给平台 AI 的消息')).toBeEnabled();
  });
  it('recovers the send button and preserves the draft if request preparation fails', async () => {
    vi.spyOn(crypto,'getRandomValues').mockImplementationOnce(() => {throw new Error('生成请求编号失败');});
    mount();
    fireEvent.change(screen.getByLabelText('发送给平台 AI 的消息'),{target:{value:'保留这条消息'}});
    await waitFor(() => expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('生成请求编号失败');
    expect(platformAiApi.send).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled();
    expect(screen.getByLabelText('发送给平台 AI 的消息')).toHaveValue('保留这条消息');
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
    fireEvent.change(screen.getByLabelText('渠道类型'),{target:{value:'wecom'}});
    fireEvent.click(screen.getByRole('button',{name:'保存渠道'}));
    await screen.findByRole('option',{name:'团队企业微信'});
    fireEvent.change(screen.getByLabelText('映射渠道'),{target:{value:'channel-1'}});
    fireEvent.change(screen.getByLabelText('外部用户 ID'),{target:{value:'wecom-member'}});
    fireEvent.change(screen.getByLabelText('映射平台用户'),{target:{value:'u1'}});
    fireEvent.click(screen.getByRole('button',{name:'保存用户映射'}));
    await waitFor(() => expect(platformAiApi.saveBinding).toHaveBeenCalledWith({channel_id:'channel-1',external_user_id:'wecom-member',user_id:'u1'}));
  });
  it('configures a long-connection bot, shows its state and tests the existing connection', async () => {
    const channel = {id: 'bot-1', name: '开发机器人', kind: 'wecom_bot' as const, enabled: 1, config: {bot_id: 'wx-bot'}, secret_fields_configured: ['bot_secret'], callback_path: null, connection: {state: 'connected', message: '已连接并通过认证', updated_at: ''}};
    vi.mocked(platformAiApi.channels).mockResolvedValue({channels: [channel], bindings: [], senders: [{channel_id: 'bot-1', external_user_id: 'encrypted-member', last_chat_id: 'chat', last_seen_at: ''}]});
    vi.mocked(platformAiApi.testChannel).mockResolvedValue({ok: true, message: '长连接认证通过'});
    vi.mocked(platformAiApi.reconnectChannel).mockResolvedValue({ok: true});
    mount(); fireEvent.click(screen.getByRole('button', {name: '渠道与用户映射'}));
    expect(await screen.findByText('连接状态：已连接并通过认证')).toBeVisible();
    expect(screen.getByText('平台主动建立长连接，无需公网回调地址。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: '测试连接'}));
    expect(await screen.findByRole('status')).toHaveTextContent('长连接认证通过');
    expect(platformAiApi.testChannel).toHaveBeenCalledWith('bot-1');
    fireEvent.click(screen.getByRole('button', {name: '填入映射'}));
    expect(screen.getByLabelText('映射渠道')).toHaveValue('bot-1');
    expect(screen.getByLabelText('外部用户 ID')).toHaveValue('encrypted-member');
    fireEvent.click(screen.getByRole('button', {name: '重新连接'}));
    await waitFor(() => expect(platformAiApi.reconnectChannel).toHaveBeenCalledWith('bot-1'));
    fireEvent.click(screen.getByRole('button', {name: '添加渠道'}));
    expect(screen.getByLabelText('渠道类型')).toHaveValue('wecom_bot');
    expect(screen.getByLabelText('Bot ID')).toBeVisible();
    expect(screen.getByLabelText('机器人 Secret')).toHaveAttribute('type', 'password');
  });
  it('subscribes group notifications separately from inbound identity bindings', async () => {
    const channel = {id: 'group-1', name: '开发通知群', kind: 'wecom_webhook' as const, enabled: 1, config: {}, secret_fields_configured: ['webhook_url'], callback_path: null};
    vi.mocked(platformAiApi.channels).mockResolvedValue({channels: [channel], bindings: [], notification_targets: [{id: 'target-1', channel_id: 'group-1', user_id: 'u1', username: 'member', display_name: '成员'}]});
    vi.mocked(platformAiApi.saveNotificationTarget).mockResolvedValue({ok: true});
    vi.mocked(platformAiApi.deleteNotificationTarget).mockResolvedValue({ok: true});
    vi.mocked(platformAiApi.testChannel).mockResolvedValue({ok: true, message: '测试通知已获确认'});
    mount(); fireEvent.click(screen.getByRole('button', {name: '渠道与用户映射'}));
    await screen.findByRole('button', {name: '发送测试通知'});
    expect(screen.getByLabelText('映射渠道').querySelectorAll('option')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('通知渠道'), {target: {value: 'group-1'}});
    fireEvent.change(screen.getByLabelText('订阅用户'), {target: {value: 'u1'}});
    fireEvent.click(screen.getByRole('button', {name: '添加通知订阅'}));
    await waitFor(() => expect(platformAiApi.saveNotificationTarget).toHaveBeenCalledWith({channel_id: 'group-1', user_id: 'u1'}));
    fireEvent.click(screen.getByRole('button', {name: '取消订阅'}));
    await waitFor(() => expect(platformAiApi.deleteNotificationTarget).toHaveBeenCalledWith('target-1'));
    fireEvent.click(screen.getByRole('button', {name: '发送测试通知'}));
    expect(await screen.findByRole('status')).toHaveTextContent('测试通知已获确认');
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
