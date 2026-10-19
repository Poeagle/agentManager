import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, MessageSquare, Plus, Send } from 'lucide-react';
import { AiReply } from './AiReply';
import { api, type MyPermissions } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { platformAiApi, type AiChannel, type AiMessage, type ChannelInput, type ChannelKind, type ModelProbeResult, type PlatformAiConfig } from '../lib/platform-ai';

const fieldStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)' };
const muted = { color: 'var(--text-secondary)' };
const fieldClass = 'w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1';
const buttonClass = 'rounded-md border px-3 py-2 text-sm disabled:opacity-40';
const statusLabels: Record<string, string> = {
  running: '执行中', blocked: '等待处理', uncertain: '结果待核对', reported_complete: 'Agent 已报告完成',
  superseded: '已由后续指令替代', failed: '失败', cancelled: '已停止跟踪', suspended: '跟踪已暂停', pending: '待投递', sending: '投递中', sent: '已投递',
  queued: '排队中', processing: '处理中', done: '已处理',
};

export function PlatformAiPanel({ permissions, onOpenSession }: {permissions: MyPermissions; onOpenSession: (projectId: string, sessionId: string) => void}) {
  const [tab, setTab] = useState('chat');
  const canConfigure = hasPermission(permissions, 'settings', 'write');
  const canSend = hasPermission(permissions, 'agent_api', 'write');
  const status = useQuery({ queryKey: ['platform-ai-status'], queryFn: platformAiApi.status, refetchInterval: 15000 });
  const tabs = [{id: 'chat', label: '对话'}, {id: 'tasks', label: '任务跟踪'}, {id: 'deliveries', label: '通知记录'}, {id: 'tools', label: '平台能力'}, ...(canConfigure ? [{id: 'config', label: '模型配置'}] : []), ...(canConfigure && hasPermission(permissions, 'roles', 'write') ? [{id: 'channels', label: '渠道与用户映射'}] : [])];
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3" style={{borderColor: 'var(--border)'}}>
      <div className="flex items-center gap-2 text-sm"><Bot className="h-4 w-4" style={{color: 'var(--accent)'}} /><span>平台 AI</span><span className="text-xs" style={muted}>{status.data?.enabled ? '已启用' : '尚未启用'}</span></div>
      <nav aria-label="平台 AI 功能" className="flex flex-wrap gap-1">{tabs.map(item => <button key={item.id} onClick={() => setTab(item.id)} className="rounded px-3 py-1.5 text-xs" aria-current={tab === item.id ? 'page' : undefined} style={{color: tab === item.id ? 'var(--accent)' : 'var(--text-secondary)', background: tab === item.id ? 'var(--bg-tertiary)' : 'transparent'}}>{item.label}</button>)}</nav>
    </div>
    {status.error && <p role="alert" className="px-5 pt-3 text-sm text-red-400">{status.error.message}</p>}
    <div className="min-h-0 flex-1 overflow-auto">
      {tab === 'chat' && <AiChat enabled={!!status.data?.enabled} canSend={canSend} />}
      {tab === 'tasks' && <AiTasks onOpenSession={onOpenSession} canWrite={canSend} />}
      {tab === 'deliveries' && <AiDeliveries />}
      {tab === 'tools' && <AiTools />}
      {tab === 'config' && canConfigure && <AiConfiguration />}
      {tab === 'channels' && canConfigure && <AiChannels />}
    </div>
  </div>;
}

function AiChat({enabled, canSend}: {enabled: boolean; canSend: boolean}) {
  const client = useQueryClient();
  const conversations = useQuery({queryKey: ['platform-ai-conversations'], queryFn: platformAiApi.conversations, refetchInterval: 5000});
  const agents = useQuery({queryKey: ['platform-ai-agents'], queryFn: platformAiApi.agents, refetchInterval: 15000});
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const pendingRequest = useRef<{content: string; conversation: string | null; id: string} | null>(null);
  const messages = useQuery({queryKey: ['platform-ai-conversation', selected], queryFn: () => platformAiApi.conversation(selected!), enabled: !!selected, refetchInterval: 2000});
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView?.({block: 'nearest'}); }, [messages.data]);
  useEffect(() => {
    if (!selected || typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/platform-ai/conversations/${encodeURIComponent(selected)}/events`);
    const refresh = () => {
      void client.invalidateQueries({queryKey: ['platform-ai-conversation', selected]});
      void client.invalidateQueries({queryKey: ['platform-ai-conversations']});
    };
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = event => {
      try {
        const update = JSON.parse(event.data) as {type: string; message?: AiMessage};
        if (update.type === 'refresh') {refresh(); return;}
        const message = update.message;
        if (update.type !== 'message' || !message?.id) return;
        client.setQueryData<Awaited<ReturnType<typeof platformAiApi.conversation>>>(['platform-ai-conversation', selected], previous => {
          if (!previous) return previous;
          const exists = previous.messages.some(item => item.id === message.id);
          return {...previous, messages: exists ? previous.messages.map(item => item.id === message.id ? message : item) : [...previous.messages, message].slice(-100)};
        });
        if (message.status === 'done' || message.status === 'failed') refresh();
      } catch { /* A reconnect plus the REST snapshot recovers malformed/interrupted events. */ }
    };
    return () => source.close();
  }, [selected, client]);
  async function send() {
    const content = draft.trim();
    if (!content || busy || !enabled || !canSend) return;
    setBusy(true); setError('');
    try {
      const previous = pendingRequest.current;
      // getRandomValues is also available on LAN HTTP origins, unlike randomUUID.
      const request = previous?.content === content && previous.conversation === selected ? previous : {
        content, conversation: selected,
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
      };
      pendingRequest.current = request;
      const result = await platformAiApi.send({content, request_id: request.id, ...(selected ? {conversation_id: selected} : {})});
      setSelected(result.conversation_id); setDraft(''); pendingRequest.current = null;
      await client.invalidateQueries({queryKey: ['platform-ai-conversations']});
      await client.invalidateQueries({queryKey: ['platform-ai-conversation']});
    } catch (failure) { setError(failure instanceof Error ? failure.message : '发送失败'); }
    finally { setBusy(false); }
  }
  const queryError = conversations.error || messages.error;
  return <div className="flex h-full min-h-[400px] flex-col sm:flex-row">
    <aside className="flex w-full shrink-0 flex-col border-b p-3 sm:w-56 sm:border-r sm:border-b-0" style={{borderColor: 'var(--border)'}}>
      <button className={buttonClass + ' mb-3 flex items-center justify-center gap-2'} style={fieldStyle} onClick={() => { setSelected(null); setError(''); }}><Plus className="h-4 w-4" />新对话</button>
      <div className="flex gap-2 overflow-auto sm:flex-col">{conversations.data?.conversations.map(conversation => <button key={conversation.id} onClick={() => {setSelected(conversation.id); setError('');}} className="shrink-0 rounded-md p-2 text-left text-xs sm:shrink" style={{background: selected === conversation.id ? 'var(--bg-tertiary)' : 'transparent'}}><span className="block truncate">{conversation.title || '新对话'}</span><span style={muted}>{conversation.channel_name || '平台网页'}</span></button>)}</div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2 text-xs" style={{...muted, borderColor:'var(--border)'}}><span>工作 Agent</span>{agents.data?.agents.map(agent => <span key={agent.cli_type} title={agent.reason} style={{color: agent.status === 'available' ? 'var(--success)' : 'var(--text-secondary)'}}>{agent.label} · {({available:'命令可用',unavailable:'未找到',unknown:'待验证'})[agent.status]}</span>)}{agents.isPending && <span>正在探测…</span>}{agents.error && <span>探测暂不可用</span>}{selected && <span className="ml-auto">{live ? '实时更新中' : '连接恢复中，暂用定时更新'}</span>}</div>
      <div aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        {!selected && <div className="mx-auto mt-12 max-w-xl text-center"><MessageSquare className="mx-auto mb-4 h-8 w-8" style={{color: 'var(--accent)'}} /><p className="text-base">直接告诉平台 AI 你想做什么</p><p className="mt-3 text-sm leading-7" style={muted}>例如：列出我能访问的项目；让某个项目的 Codex 实现一个功能；查询执行进展；创建每天运行的定时任务。</p></div>}
        {messages.data?.messages.map(message => <article key={message.id} className={'min-w-0 max-w-3xl rounded-lg border p-4 ' + (message.role === 'user' ? 'ml-auto' : '')} style={{borderColor: 'var(--border)', background: message.role === 'user' ? 'var(--bg-tertiary)' : 'var(--bg-primary)'}}><div className="mb-2 flex items-center justify-between gap-4 text-xs" style={muted}><span>{message.role === 'user' ? '你' : message.role === 'notice' ? '任务通知' : '平台 AI'}</span><span>{message.status !== 'done' ? statusLabels[message.status] || message.status : ''}</span></div><div className="text-sm leading-7">{message.role === 'user' ? <div className="whitespace-pre-wrap break-words">{message.content}</div> : <AiReply content={message.content} />}</div>{message.error && <p role="alert" className="mt-2 text-xs text-red-400">{message.error}</p>}</article>)}
        {messages.data?.messages.filter(message => message.role === 'user' && ['queued','processing'].includes(message.status)).map(message => <article key={`live-${message.id}`} aria-label="平台 AI 处理进度" className="min-w-0 max-w-3xl space-y-3 rounded-lg border p-4" style={{borderColor:'var(--border)',background:'var(--bg-primary)'}}><div className="flex items-center gap-2 text-xs" style={muted}><Loader2 className="h-3 w-3 animate-spin" /><span>{message.progress || (message.status === 'queued' ? '消息已接收，等待处理…' : '正在处理…')}</span></div>{message.partial_content && <AiReply content={message.partial_content} />}</article>)}
        <div ref={bottom} />
      </div>
      <div className="shrink-0 border-t p-4" style={{borderColor: 'var(--border)'}}>
        {(error || queryError) && <p role="alert" className="mb-2 text-sm text-red-400">{error || queryError?.message}</p>}
        {!enabled && <p className="mb-2 text-xs" style={muted}>管理员配置并启用模型后，即可使用平台 AI。</p>}
        {messages.data?.conversation.channel_id && <p className="mb-2 text-xs" style={muted}>此对话关联外部渠道，回复和任务通知会发送到原渠道。</p>}
        <div className="flex items-end gap-2"><textarea aria-label="发送给平台 AI 的消息" className={fieldClass + ' min-h-20 min-w-0 flex-1 resize-none'} style={fieldStyle} value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入需求，Enter 发送，Shift+Enter 换行" maxLength={24000} disabled={!canSend || busy} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); void send();}}} /><button aria-label="发送消息" disabled={!enabled || !canSend || busy || !draft.trim()} onClick={() => void send()} className={buttonClass + ' flex h-10 shrink-0 items-center gap-2 whitespace-nowrap'} style={fieldStyle}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}发送</button></div>
      </div>
    </div>
  </div>;
}

function AiTasks({onOpenSession, canWrite}: {onOpenSession: (projectId: string, sessionId: string) => void; canWrite: boolean}) {
  const client = useQueryClient();
  const query = useQuery({queryKey: ['platform-ai-tasks'], queryFn: platformAiApi.tasks, refetchInterval: 5000});
  const [error, setError] = useState('');
  return <div className="space-y-3 p-5"><p className="text-xs" style={muted}>平台主动读取会话状态与输出。“Agent 已报告完成”表示会话提供了结果依据，验证情况以任务说明为准。</p>{(error || query.error) && <p role="alert" className="text-sm text-red-400">{error || query.error?.message}</p>}{query.data?.tasks.length === 0 && <p className="py-8 text-sm" style={muted}>暂无跟踪任务。向平台 AI 下发开发需求后，任务会显示在这里。</p>}{query.data?.tasks.map(task => <article key={task.id} className="rounded-lg border p-4" style={{borderColor: 'var(--border)'}}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs" style={muted}>{task.id} · {statusLabels[task.status] || task.status}</span><div className="flex gap-2">{task.project_id && <button className="text-xs underline" onClick={() => onOpenSession(task.project_id!, task.session_id)}>打开会话</button>}{canWrite && ['running','blocked','uncertain','suspended'].includes(task.status) && <button className="text-xs underline" onClick={() => {void platformAiApi.stopTracking(task.id).then(() => client.invalidateQueries({queryKey: ['platform-ai-tasks']})).catch(failure => setError(failure.message));}}>停止跟踪</button>}</div></div><p className="mt-3 whitespace-pre-wrap text-sm">{task.requirement}</p><p className="mt-3 whitespace-pre-wrap text-sm" style={muted}>{task.summary || '等待首次状态更新…'}</p>{task.evidence && <details className="mt-3 text-xs"><summary className="cursor-pointer">查看判断依据</summary><pre className="mt-2 whitespace-pre-wrap break-words rounded p-3" style={fieldStyle}>{task.evidence}</pre></details>}</article>)}</div>;
}

function AiDeliveries() {
  const query = useQuery({queryKey: ['platform-ai-deliveries'], queryFn: platformAiApi.deliveries, refetchInterval: 10000});
  return <div className="space-y-3 p-5"><p className="text-xs" style={muted}>外部通知失败后会自动重试；网页对话的回复直接保留在对话记录中。</p>{query.error && <p role="alert" className="text-red-400">{query.error.message}</p>}{query.data?.deliveries.length === 0 && <p className="py-8 text-sm" style={muted}>暂无通知记录。</p>}{query.data?.deliveries.map(item => <div key={item.id} className="rounded border p-3 text-sm" style={{borderColor: 'var(--border)'}}><div className="flex flex-wrap justify-between gap-2"><span>{statusLabels[item.status] || item.status} · 尝试 {item.attempts} 次</span><span className="text-xs" style={muted}>{item.created_at}</span></div>{item.error && <p className="mt-2 text-xs text-red-400">{item.error}</p>}</div>)}</div>;
}

function AiTools() {
  const query = useQuery({queryKey: ['platform-ai-tools'], queryFn: platformAiApi.tools, staleTime: 60000});
  return <div className="space-y-3 p-5"><p className="text-sm" style={muted}>平台 AI 根据当前能力目录调用接口。每次操作均使用发起用户的身份，并经过平台原有权限检查。</p>{query.error && <p role="alert" className="text-red-400">{query.error.message}</p>}{query.data?.endpoints.map(item => <div key={item.endpoint_id} className="rounded border p-3" style={{borderColor: 'var(--border)'}}><code className="break-all text-xs">{item.endpoint_id}</code><p className="mt-1 text-xs" style={muted}>{item.description}</p></div>)}</div>;
}

function AiConfiguration() {
  const query = useQuery({queryKey: ['platform-ai-config'], queryFn: platformAiApi.config});
  if (query.error) return <p role="alert" className="p-5 text-red-400">{query.error.message}</p>;
  if (!query.data) return <p className="p-5 text-sm">正在加载配置…</p>;
  return <AiConfigForm initial={query.data.config} />;
}

function AiConfigForm({initial}: {initial: PlatformAiConfig}) {
  const client = useQueryClient();
  const [config, setConfig] = useState(initial);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'models' | 'test' | 'save' | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  function updateConnection(patch: Partial<PlatformAiConfig>) {
    setConfig({...config, ...patch}); setProbe(null); setNotice(''); setError('');
    if ('endpoint' in patch) setModels(null);
  }
  async function check(action: 'models' | 'test') {
    if (busy) return;
    setBusy(action); setError(''); setNotice(''); setProbe(null);
    if (action === 'models') setModels(null);
    const draft = {endpoint: config.endpoint.trim(), model: config.model.trim(), timeout_ms: config.timeout_ms, ...(key ? {api_key: key} : {})};
    try {
      if (action === 'models') setModels((await platformAiApi.discoverModels(draft)).models);
      else setProbe(await platformAiApi.testConnection(draft));
    } catch (failure) {
      setError((failure instanceof Error ? failure.message : '请求失败') + (action === 'models' ? '。可手动填写模型名称，再测试连通性。' : ''));
    } finally {setBusy(null);}
  }
  async function save() {
    if (busy) return;
    setBusy('save'); setNotice(''); setError(''); setProbe(null);
    try {
      const values: Partial<PlatformAiConfig> = {...config};
      delete values.api_key_configured;
      const result = await platformAiApi.saveConfig({...values, ...(key ? {api_key: key} : {})});
      setConfig(result.config); setKey(''); setNotice('配置已保存');
      await client.invalidateQueries({queryKey: ['platform-ai-status']});
    } catch (failure) {setError(failure instanceof Error ? failure.message : '保存失败');}
    finally {setBusy(null);}
  }
  return <form className="max-w-3xl space-y-5 p-5" onSubmit={event => {event.preventDefault(); void save();}}>
    <p className="text-sm leading-6" style={muted}>配置支持工具调用的模型 API。平台 AI 使用此模型理解需求和调度；项目内 Codex/Claude 保持各自的模型配置。</p>
    <fieldset disabled={!!busy} className="min-w-0 space-y-5">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={event => setConfig({...config, enabled: event.target.checked})} />启用平台 AI</label>
    <label className="block text-sm">模型 API 地址<input className={fieldClass + ' mt-2'} style={fieldStyle} value={config.endpoint} onChange={event => updateConnection({endpoint: event.target.value})} placeholder="https://provider.example/v1" /></label>
    <label className="block text-sm">API Key<input type="password" autoComplete="new-password" className={fieldClass + ' mt-2'} style={fieldStyle} value={key} onChange={event => {setKey(event.target.value); setModels(null); setProbe(null); setNotice(''); setError('');}} placeholder={config.api_key_configured ? '已配置，留空保留' : '输入 API Key'} /></label>
    <div className="space-y-3">
      <button type="button" disabled={!config.endpoint.trim() || (!key && !config.api_key_configured)} className={buttonClass} style={fieldStyle} onClick={() => void check('models')}>{busy === 'models' ? '正在获取模型…' : '获取模型列表'}</button>
      <p className="text-xs leading-6" style={muted}>填写地址和 Key 后即可探测，无需先保存或启用。使用兼容接口的 /models 列表；列表中的模型仍需测试是否支持工具调用。</p>
      {models !== null && (models.length ? <label className="block text-sm">选择探测到的模型<select className={fieldClass + ' mt-2'} style={fieldStyle} value={models.includes(config.model) ? config.model : ''} onChange={event => {if (event.target.value) updateConnection({model: event.target.value});}}><option value="">已发现 {models.length} 个模型，请选择</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label> : <p className="text-xs" style={muted}>接口返回的模型列表为空，可手动填写模型名称。</p>)}
    </div>
    <label className="block text-sm">模型名称<input className={fieldClass + ' mt-2'} style={fieldStyle} value={config.model} onChange={event => updateConnection({model: event.target.value})} placeholder="从上方列表选择，也可手动输入" /></label>
    <div className="space-y-3">
      <button type="button" disabled={!config.endpoint.trim() || !config.model.trim() || (!key && !config.api_key_configured)} className={buttonClass} style={fieldStyle} onClick={() => void check('test')}>{busy === 'test' ? '正在测试…' : '测试连通性'}</button>
      <p className="text-xs leading-6" style={muted}>向所选模型发送两次小型请求，分别检查普通回复和结构化工具调用，可能产生少量 API 费用。测试不会派发开发任务。</p>
    </div>
    {probe && <section aria-label="模型连通性测试结果" className="space-y-3 rounded-md border p-4 text-sm" style={{borderColor: 'var(--border)'}}><p role="status" style={{color: probe.ok ? 'var(--success)' : 'var(--text-primary)'}}>{probe.ok ? '测试通过，可用于平台 AI' : '测试未全部通过'} · {probe.model} · {(probe.elapsed_ms / 1000).toFixed(1)} 秒</p>{([['connection','接口连接'],['response','模型响应'],['tools','工具调用']] as const).map(([id,label]) => <div key={id}><span>{label}：{({passed: '通过', failed: '失败', skipped: '未测试'})[probe.checks[id].status]}</span><p className="mt-1 text-xs leading-6" style={muted}>{probe.checks[id].message}</p></div>)}</section>}
    <div className="grid gap-4 sm:grid-cols-2">{([
      ['timeout_ms', '单次模型超时（毫秒）', 1000, 120000], ['max_tool_rounds', '每轮最多工具调用轮数', 1, 16],
      ['observation_interval_seconds', '活跃输出读取最小间隔（秒）', 5, 300], ['assessment_interval_seconds', 'AI 进度分析最小间隔（秒）', 30, 1800],
      ['notification_interval_seconds', '常规进度汇报间隔（秒）', 60, 3600],
    ] as const).map(([name,label,min,max]) => <label key={name} className="block text-sm">{label}<input type="number" min={min} max={max} required className={fieldClass + ' mt-2'} style={fieldStyle} value={config[name]} onChange={event => updateConnection({[name]: Number(event.target.value)})} /></label>)}</div>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}{notice && <p role="status" className="text-sm" style={{color: 'var(--success)'}}>{notice}</p>}
    <button className={buttonClass} style={fieldStyle}>{busy === 'save' ? '保存中…' : '保存模型配置'}</button>
    </fieldset>
  </form>;
}

const channelFields: Record<ChannelKind, {name: string; config: Array<[string,string]>; secrets: Array<[string,string]>; hint: string}> = {
  wecom: {name: '企业微信自建应用', config: [['corp_id','企业 ID'],['agent_id','Agent ID']], secrets: [['app_secret','应用 Secret'],['token','回调 Token'],['aes_key','EncodingAESKey']], hint: '使用应用的“接收消息”API 回调，支持成员单聊和应用主动通知。'},
  qq: {name: 'QQ 官方机器人', config: [['app_id','App ID']], secrets: [['app_secret','App Secret']], hint: '使用官方 Webhook 回调，支持单聊和群内 @。主动通知受 QQ 平台权限与额度限制。'},
  wechat: {name: '微信公众号', config: [['app_id','App ID']], secrets: [['app_secret','App Secret'],['token','回调 Token'],['aes_key','EncodingAESKey（加密模式填写）']], hint: '使用公众号消息回调与客服消息接口。客服回复受微信互动时限和账号权限限制。'},
  webhook: {name: '通用 Webhook / 外部网关', config: [['outbound_url','回复接收地址']], secrets: [['signing_secret','HMAC 签名密钥（至少 32 字符）']], hint: '用于自有渠道适配器或外部消息网关；收发消息均使用时间戳和 HMAC 签名。'},
};

function AiChannels() {
  const client = useQueryClient();
  const query = useQuery({queryKey: ['platform-ai-channels'], queryFn: platformAiApi.channels});
  const users = useQuery({queryKey: ['users'], queryFn: api.users.list});
  const [selected, setSelected] = useState<AiChannel | null | undefined>(undefined);
  const [channelId, setChannelId] = useState('');
  const [externalId, setExternalId] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function bind() {
    setBusy(true); setError('');
    try {await platformAiApi.saveBinding({channel_id: channelId, external_user_id: externalId.trim(), user_id: userId}); setExternalId(''); await client.invalidateQueries({queryKey: ['platform-ai-channels']});}
    catch (failure) {setError(failure instanceof Error ? failure.message : '绑定失败');}
    finally {setBusy(false);}
  }
  return <div className="space-y-6 p-5"><div className="flex items-center justify-between gap-3"><p className="text-sm" style={muted}>外部身份绑定到平台用户后，使用该用户的项目和工具权限。</p><button className={buttonClass + ' shrink-0'} style={fieldStyle} onClick={() => setSelected(null)}>添加渠道</button></div>
    {(error || query.error || users.error) && <p role="alert" className="text-sm text-red-400">{error || query.error?.message || users.error?.message}</p>}
    {query.data?.channels.map(channel => <div key={channel.id} className="rounded-lg border p-4" style={{borderColor: 'var(--border)'}}><div className="flex items-center justify-between gap-2"><div className="text-sm">{channel.name} <span className="text-xs" style={muted}>{channelFields[channel.kind].name} · {channel.enabled ? '已启用' : '未启用'}</span></div><button className="text-xs underline" onClick={() => setSelected(channel)}>编辑</button></div><div className="mt-2 break-all text-xs" style={muted}>回调路径：{channel.callback_path}</div></div>)}
    {selected !== undefined && <ChannelForm key={selected?.id || 'new'} channel={selected || undefined} onClose={() => setSelected(undefined)} onSaved={() => {setSelected(undefined); void client.invalidateQueries({queryKey: ['platform-ai-channels']});}} />}
    <section className="rounded-lg border p-4" style={{borderColor: 'var(--border)'}}><h3 className="mb-4 text-sm font-medium">外部用户映射</h3><form className="grid gap-3 sm:grid-cols-3" onSubmit={event => {event.preventDefault(); void bind();}}><label className="text-xs">渠道<select required aria-label="映射渠道" className={fieldClass + ' mt-2'} style={fieldStyle} value={channelId} onChange={event => setChannelId(event.target.value)}><option value="">请选择渠道</option>{query.data?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label><label className="text-xs">外部用户 ID<input required maxLength={256} className={fieldClass + ' mt-2'} style={fieldStyle} value={externalId} onChange={event => setExternalId(event.target.value)} placeholder="成员 ID / OpenID / 网关用户 ID" /></label><label className="text-xs">平台用户<select required aria-label="映射平台用户" className={fieldClass + ' mt-2'} style={fieldStyle} value={userId} onChange={event => setUserId(event.target.value)}><option value="">请选择用户</option>{users.data?.users.filter(user => !user.disabled).map(user => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label><button disabled={busy} className={buttonClass + ' justify-self-start'} style={fieldStyle}>{busy ? '保存中…' : '保存用户映射'}</button></form><div className="mt-4 space-y-2">{query.data?.bindings.map(binding => <div key={binding.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs" style={{borderColor: 'var(--border)'}}><span className="break-all">{query.data.channels.find(channel => channel.id === binding.channel_id)?.name} · {binding.external_user_id} → {binding.display_name || binding.username}</span><button className="underline" onClick={() => {void platformAiApi.deleteBinding(binding.id).then(() => client.invalidateQueries({queryKey: ['platform-ai-channels']})).catch(failure => setError(failure.message));}}>解除映射</button></div>)}</div></section>
  </div>;
}

function ChannelForm({channel, onClose, onSaved}: {channel?: AiChannel; onClose: () => void; onSaved: () => void}) {
  const [value, setValue] = useState<ChannelInput>({name: channel?.name || '', kind: channel?.kind || 'wecom', enabled: !!channel?.enabled, config: channel?.config || {}, secrets: {}});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = channelFields[value.kind];
  async function save() {
    setBusy(true); setError('');
    try {await platformAiApi.saveChannel(value, channel?.id); onSaved();}
    catch (failure) {setError(failure instanceof Error ? failure.message : '保存失败');}
    finally {setBusy(false);}
  }
  return <form aria-label="渠道配置" className="space-y-4 rounded-lg border p-4" style={{borderColor: 'var(--border)'}} onSubmit={event => {event.preventDefault(); void save();}}>
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">渠道名称<input required className={fieldClass + ' mt-2'} style={fieldStyle} value={value.name} onChange={event => setValue({...value, name: event.target.value})} /></label><label className="text-sm">渠道类型<select aria-label="渠道类型" disabled={!!channel} className={fieldClass + ' mt-2'} style={fieldStyle} value={value.kind} onChange={event => setValue({...value, kind: event.target.value as ChannelKind, config: {}, secrets: {}})}>{Object.entries(channelFields).map(([kind,info]) => <option key={kind} value={kind}>{info.name}</option>)}</select></label></div>
    <p className="text-xs leading-6" style={muted}>{fields.hint}</p>
    <div className="grid gap-4 sm:grid-cols-2">{fields.config.map(([key,label]) => <label key={key} className="text-sm">{label}<input className={fieldClass + ' mt-2'} style={fieldStyle} value={value.config[key] || ''} onChange={event => setValue({...value, config: {...value.config, [key]: event.target.value}})} /></label>)}{fields.secrets.map(([key,label]) => <label key={key} className="text-sm">{label}<input type="password" autoComplete="new-password" className={fieldClass + ' mt-2'} style={fieldStyle} value={value.secrets[key] || ''} placeholder={channel?.secret_fields_configured.includes(key) ? '已配置，留空保留' : '输入凭据'} onChange={event => setValue({...value, secrets: {...value.secrets, [key]: event.target.value}})} /></label>)}</div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={event => setValue({...value, enabled: event.target.checked})} />启用此渠道</label>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}<div className="flex gap-2"><button disabled={busy} className={buttonClass} style={fieldStyle}>{busy ? '保存中…' : '保存渠道'}</button><button type="button" className={buttonClass} style={fieldStyle} onClick={onClose}>取消</button></div>
  </form>;
}
