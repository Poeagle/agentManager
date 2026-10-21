import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { platformAiApi, type AiChannel, type ChannelInput, type ChannelKind } from '../lib/platform-ai';

const fieldStyle = {background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)'};
const muted = {color: 'var(--text-secondary)'};
const fieldClass = 'w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1';
const buttonClass = 'rounded-md border px-3 py-2 text-sm disabled:opacity-40';
const channelFields: Record<ChannelKind, {name: string; config: Array<[string, string]>; secrets: Array<[string, string]>; hint: string}> = {
  wecom_bot: {name: '企业微信智能机器人（长连接）', config: [['bot_id', 'Bot ID']], secrets: [['bot_secret', '机器人 Secret']], hint: '选择智能机器人的 API 长连接模式。平台主动连接企业微信，无需公网回调；支持文本指令、流式回复和任务主动通知。'},
  wecom_webhook: {name: '企业微信群机器人（通知）', config: [], secrets: [['webhook_url', '群机器人 Webhook 地址']], hint: '在企业微信群中添加 Webhook 机器人并复制地址。保存后添加任务通知订阅；仅推送通知，群里发送的指令不会传入平台。'},
  wecom: {name: '企业微信自建应用', config: [['corp_id', '企业 ID'], ['agent_id', 'Agent ID']], secrets: [['app_secret', '应用 Secret'], ['token', '回调 Token'], ['aes_key', 'EncodingAESKey']], hint: '使用应用的“接收消息”API 回调，支持成员单聊和应用主动通知。需公网回调地址，并按企业微信要求配置企业可信 IP。'},
  qq: {name: 'QQ 官方机器人', config: [['app_id', 'App ID']], secrets: [['app_secret', 'App Secret']], hint: '使用官方 Webhook 回调，支持单聊和群内 @。主动通知受 QQ 平台权限与额度限制。'},
  wechat: {name: '微信公众号', config: [['app_id', 'App ID']], secrets: [['app_secret', 'App Secret'], ['token', '回调 Token'], ['aes_key', 'EncodingAESKey（加密模式填写）']], hint: '使用公众号消息回调与客服消息接口。客服回复受微信互动时限和账号权限限制。'},
  webhook: {name: '通用 Webhook / 外部网关', config: [['outbound_url', '回复接收地址']], secrets: [['signing_secret', 'HMAC 签名密钥（至少 32 字符）']], hint: '用于自有渠道适配器或外部消息网关；收发消息均使用时间戳和 HMAC 签名。'},
};

export function PlatformAiChannels() {
  const client = useQueryClient();
  const query = useQuery({queryKey: ['platform-ai-channels'], queryFn: platformAiApi.channels, refetchInterval: 5000});
  const users = useQuery({queryKey: ['users'], queryFn: api.users.list});
  const [selected, setSelected] = useState<AiChannel | null | undefined>(undefined);
  const [channelId, setChannelId] = useState('');
  const [externalId, setExternalId] = useState('');
  const [userId, setUserId] = useState('');
  const [targetChannel, setTargetChannel] = useState('');
  const [targetUser, setTargetUser] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const channels = query.data?.channels || [];
  const activeUsers = users.data?.users.filter(user => !user.disabled) || [];
  const invalidate = () => client.invalidateQueries({queryKey: ['platform-ai-channels']});
  async function action(key: string, work: () => Promise<unknown>) {
    setBusy(key); setError(''); setNotice('');
    try {await work(); await invalidate();}
    catch (failure) {setError(failure instanceof Error ? failure.message : '操作失败');}
    finally {setBusy('');}
  }
  return <div className="space-y-6 p-5">
    <div className="flex items-center justify-between gap-3"><p className="text-sm" style={muted}>外部身份绑定到平台用户后，使用该用户的项目和工具权限。</p><button className={buttonClass + ' shrink-0'} style={fieldStyle} onClick={() => setSelected(null)}>添加渠道</button></div>
    {(error || query.error || users.error) && <p role="alert" className="text-sm text-red-400">{error || query.error?.message || users.error?.message}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {channels.map(channel => <section key={channel.id} aria-label={channel.name} className="space-y-3 rounded-lg border p-4" style={{borderColor: 'var(--border)'}}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="text-sm">{channel.name} <span className="text-xs" style={muted}>{channelFields[channel.kind].name} · {channel.enabled ? '已启用' : '未启用'}</span></div>
        <div className="flex flex-wrap gap-3 text-xs">
          <button disabled={!!busy} className="underline disabled:opacity-40" onClick={() => setSelected(channel)}>编辑</button>
          <button disabled={!!busy || !channel.enabled} className="underline disabled:opacity-40" onClick={() => {void action(`test:${channel.id}`, async () => {
            const result = await platformAiApi.testChannel(channel.id);
            if (!result.ok) throw new Error(result.message);
            setNotice(`${channel.name}：${result.message}`);
          });}}>{busy === `test:${channel.id}` ? '测试中…' : ['wecom_webhook', 'webhook'].includes(channel.kind) ? '发送测试通知' : '测试连接'}</button>
          {channel.kind === 'wecom_bot' && <button disabled={!!busy || !channel.enabled} className="underline disabled:opacity-40" onClick={() => {void action(`reconnect:${channel.id}`, async () => {await platformAiApi.reconnectChannel(channel.id); setNotice('已开始重新连接');});}}>重新连接</button>}
        </div>
      </div>
      {channel.connection && <p className={'text-xs ' + (channel.connection.state === 'connected' ? 'text-green-500' : '')}>连接状态：{channel.connection.message}</p>}
      {channel.callback_path ? <p className="break-all text-xs" style={muted}>回调路径：{channel.callback_path}</p> : <p className="text-xs" style={muted}>{channel.kind === 'wecom_bot' ? '平台主动建立长连接，无需公网回调地址。' : '仅发送通知；请在下方添加任务通知订阅。'}</p>}
    </section>)}
    {selected !== undefined && <ChannelForm key={selected?.id || 'new'} channel={selected || undefined} onClose={() => setSelected(undefined)} onSaved={() => {setSelected(undefined); void invalidate();}} />}
    <section aria-label="外部用户映射" className="space-y-4 rounded-lg border p-4" style={{borderColor: 'var(--border)'}}>
      <h3 className="text-sm font-medium">外部用户映射</h3>
      <p className="text-xs leading-6" style={muted}>先给机器人发一条文字，再从下方未绑定身份中选择。未绑定用户的指令不会交给 AI 执行。</p>
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={event => {event.preventDefault(); void action('bind', async () => {await platformAiApi.saveBinding({channel_id: channelId, external_user_id: externalId.trim(), user_id: userId}); setExternalId('');});}}>
        <label className="text-xs">渠道<select required aria-label="映射渠道" className={fieldClass + ' mt-2'} style={fieldStyle} value={channelId} onChange={event => {setChannelId(event.target.value); setExternalId('');}}><option value="">请选择渠道</option>{channels.filter(channel => channel.kind !== 'wecom_webhook').map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
        <label className="text-xs">外部用户 ID<input required maxLength={256} className={fieldClass + ' mt-2'} style={fieldStyle} value={externalId} onChange={event => setExternalId(event.target.value)} placeholder="成员 ID / OpenID / 网关用户 ID" /></label>
        <label className="text-xs">平台用户<select required aria-label="映射平台用户" className={fieldClass + ' mt-2'} style={fieldStyle} value={userId} onChange={event => setUserId(event.target.value)}><option value="">请选择用户</option>{activeUsers.map(user => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label>
        <button disabled={!!busy} className={buttonClass + ' justify-self-start'} style={fieldStyle}>{busy === 'bind' ? '保存中…' : '保存用户映射'}</button>
      </form>
      {!!query.data?.senders?.length && <div className="space-y-2"><h4 className="text-xs" style={muted}>最近收到的未绑定身份</h4>{query.data.senders.map(sender => <div key={`${sender.channel_id}:${sender.external_user_id}`} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="break-all">{channels.find(channel => channel.id === sender.channel_id)?.name} · {sender.external_user_id}</span><button className="underline" onClick={() => {setChannelId(sender.channel_id); setExternalId(sender.external_user_id);}}>填入映射</button></div>)}</div>}
      {query.data?.bindings.map(binding => <div key={binding.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs" style={{borderColor: 'var(--border)'}}><span className="break-all">{channels.find(channel => channel.id === binding.channel_id)?.name} · {binding.external_user_id} → {binding.display_name || binding.username}</span><button disabled={!!busy} className="underline" onClick={() => {void action(`unbind:${binding.id}`, () => platformAiApi.deleteBinding(binding.id));}}>解除映射</button></div>)}
    </section>
    <section aria-label="任务通知订阅" className="space-y-4 rounded-lg border p-4" style={{borderColor: 'var(--border)'}}>
      <h3 className="text-sm font-medium">任务通知订阅</h3>
      <p className="text-xs leading-6" style={muted}>将指定平台用户的任务进展、待处理问题和结果发送到企业微信群。群成员都能看到这些通知；普通对话回复仍在原会话中。</p>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {event.preventDefault(); void action('subscribe', () => platformAiApi.saveNotificationTarget({channel_id: targetChannel, user_id: targetUser}));}}>
        <label className="text-xs">通知渠道<select required aria-label="通知渠道" className={fieldClass + ' mt-2'} style={fieldStyle} value={targetChannel} onChange={event => setTargetChannel(event.target.value)}><option value="">请选择群机器人</option>{channels.filter(channel => channel.kind === 'wecom_webhook').map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
        <label className="text-xs">订阅用户<select required aria-label="订阅用户" className={fieldClass + ' mt-2'} style={fieldStyle} value={targetUser} onChange={event => setTargetUser(event.target.value)}><option value="">请选择平台用户</option>{activeUsers.map(user => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label>
        <button disabled={!!busy} className={buttonClass + ' justify-self-start'} style={fieldStyle}>添加通知订阅</button>
      </form>
      {query.data?.notification_targets?.map(target => <div key={target.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs" style={{borderColor: 'var(--border)'}}><span>{target.display_name || target.username} → {channels.find(channel => channel.id === target.channel_id)?.name}</span><button disabled={!!busy} className="underline" onClick={() => {void action(`unsubscribe:${target.id}`, () => platformAiApi.deleteNotificationTarget(target.id));}}>取消订阅</button></div>)}
    </section>
  </div>;
}

function ChannelForm({channel, onClose, onSaved}: {channel?: AiChannel; onClose: () => void; onSaved: () => void}) {
  const [value, setValue] = useState<ChannelInput>({name: channel?.name || '', kind: channel?.kind || 'wecom_bot', enabled: !!channel?.enabled, config: channel?.config || {}, secrets: {}});
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
    <fieldset disabled={busy} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">渠道名称<input required className={fieldClass + ' mt-2'} style={fieldStyle} value={value.name} onChange={event => setValue({...value, name: event.target.value})} /></label><label className="text-sm">渠道类型<select aria-label="渠道类型" disabled={!!channel} className={fieldClass + ' mt-2'} style={fieldStyle} value={value.kind} onChange={event => setValue({...value, kind: event.target.value as ChannelKind, config: {}, secrets: {}})}>{Object.entries(channelFields).map(([kind, info]) => <option key={kind} value={kind}>{info.name}</option>)}</select></label></div>
      <p className="text-xs leading-6" style={muted}>{fields.hint}</p>
      <div className="grid gap-4 sm:grid-cols-2">{fields.config.map(([key, label]) => <label key={key} className="text-sm">{label}<input required={value.enabled} className={fieldClass + ' mt-2'} style={fieldStyle} value={value.config[key] || ''} onChange={event => setValue({...value, config: {...value.config, [key]: event.target.value}})} /></label>)}{fields.secrets.map(([key, label]) => <label key={key} className="text-sm">{label}<input type="password" autoComplete="new-password" className={fieldClass + ' mt-2'} style={fieldStyle} value={value.secrets[key] || ''} placeholder={channel?.secret_fields_configured.includes(key) ? '已配置，留空保留' : '输入凭据'} onChange={event => setValue({...value, secrets: {...value.secrets, [key]: event.target.value}})} /></label>)}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={event => setValue({...value, enabled: event.target.checked})} />启用此渠道</label>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}<div className="flex gap-2"><button className={buttonClass} style={fieldStyle}>{busy ? '保存中…' : '保存渠道'}</button><button type="button" className={buttonClass} style={fieldStyle} onClick={onClose}>取消</button></div>
    </fieldset>
  </form>;
}
