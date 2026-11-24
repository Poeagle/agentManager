import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { conversationClientId } from '../lib/conversation-timeline';
import {
  HARNESS_MODEL_SETTING, HARNESS_PROVIDER_BRIDGE, type HarnessModelSelection, type HarnessProvider,
  type HarnessProviderDraft,
} from '../lib/deepseek-harness';
import { DataTable } from './table/DataTable';
import { TableActionButton } from './table/TableActions';
import { useTableModel } from './table/use-table-model';

const protocols = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Gemini API',
};

const errors: Record<string, string> = {
  invalid: '请检查 Provider ID、接入地址和模型 ID。',
  read: '无法读取 Harness 模型配置，请确认已登录 Harness 所有者账号。',
  unsupported: '当前 Harness 配置不可写。',
  duplicate: '此 Provider ID 已被 Harness 使用，请换一个 ID。',
  conflict: 'Harness 配置已变化，请重新检测后再编辑。',
  credential: 'Harness 未能保存 API Key。',
  save: 'Harness 拒绝保存 Provider，请检查接入协议和模型。',
  unknown: 'Harness 未确认保存结果，请重新检测后核对配置。',
};

interface ProviderList {
  providers: HarnessProvider[];
  revision?: number;
  canCreate: boolean;
}

function request<T>(
  target: Window | null | undefined, url: string, type: 'list' | 'save', payload = {}, signal?: AbortSignal,
): Promise<T> {
  if (!target || signal?.aborted) return Promise.reject(new Error('Harness 页面尚未就绪。'));
  const origin = new URL(url).origin;
  if (origin === window.location.origin) return Promise.reject(new Error('Harness 需要独立的浏览器来源。'));
  return new Promise((resolve, reject) => {
    const id = conversationClientId();
    let sent = false;
    const send = (message: string, fields = {}) => target.postMessage({
      channel: HARNESS_PROVIDER_BRIDGE, id, type: message, ...fields,
    }, origin);
    const cleanup = () => {
      window.clearInterval(ping);
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (message: string) => { cleanup(); reject(new Error(message)); };
    const abort = () => fail('已取消读取 Harness Provider。');
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== target || event.origin !== origin || data?.channel !== HARNESS_PROVIDER_BRIDGE || data.id !== id) return;
      if (data.type === 'ready' && !sent) {
        sent = true;
        window.clearInterval(ping);
        send(type, payload);
      } else if (sent && data.type === 'result') {
        cleanup();
        resolve(data.value);
      } else if (sent && data.type === 'error') {
        fail(Object.hasOwn(errors, data.code) ? errors[data.code] : errors.unknown);
      }
    };
    const ping = window.setInterval(() => send('hello'), 300);
    const timeout = window.setTimeout(() => fail(sent
      ? (type === 'save' ? errors.unknown : errors.read)
      : '未连接到 Harness Provider 配置。请登录 Harness 所有者账号，并确认 OctoAlly 插件已更新。'), 12_000);
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    send('hello');
  });
}

export function useHarnessProviders(url: string, active: boolean) {
  const frame = useRef<HTMLIFrameElement>(null);
  const originIsIndependent = !!url && new URL(url).origin !== window.location.origin;
  const query = useQuery({
    queryKey: ['harness-providers', url],
    queryFn: ({ signal }) => request<ProviderList>(frame.current?.contentWindow, url, 'list', {}, signal),
    enabled: originIsIndependent && active, retry: false, refetchOnWindowFocus: false, staleTime: 30_000,
  });
  return {
    query,
    save: (draft: HarnessProviderDraft, create: boolean, revision: number | undefined) =>
      request<void>(frame.current?.contentWindow, url, 'save', { draft, create, revision }),
    frame: originIsIndependent && active && <iframe key={url} ref={frame} src={url} title="Harness Provider 配置连接" hidden tabIndex={-1}
      referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" />,
  };
}

export function HarnessProviderEditor({ provider, connection, selection, onSaved, onDirtyChange, onBusyChange }: {
  provider?: HarnessProvider;
  connection: ReturnType<typeof useHarnessProviders>;
  selection?: HarnessModelSelection;
  onSaved: () => void;
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const [openedRevision] = useState(connection.query.data?.revision);
  const [draft, setDraft] = useState({
    id: provider?.id ?? '', name: provider?.name ?? '', baseUrl: provider?.baseUrl ?? '',
    protocol: provider?.protocol ?? 'openai-responses', models: provider?.models.map(model => model.id).join('\n') ?? '', apiKey: '',
  });
  const models = [...new Set(draft.models.split(/\r?\n/u).map(value => value.trim()).filter(Boolean))];
  const save = useMutation({
    mutationFn: () => connection.save({ ...draft, id: draft.id.trim(), name: draft.name.trim() || draft.id.trim(),
      baseUrl: draft.baseUrl.trim(), models }, !provider, openedRevision),
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    onSuccess: async () => {
      setDraft(value => ({ ...value, apiKey: '' }));
      onSaved();
      await connection.query.refetch();
    },
  });
  const blocked = selection?.provider === provider?.id && !!selection && !models.includes(selection.model);
  const locked = save.isPending;
  const edit = (field: keyof typeof draft, value: string) => {
    setDraft(current => ({ ...current, [field]: value }));
    onDirtyChange(true);
  };
  return <form onSubmit={event => { event.preventDefault(); if (!locked && !blocked) save.mutate(); }}>
    <div className="agent-provider-dialog-options">
      <label className="agent-management-field"><span>Provider ID</span>
        <input value={draft.id} required maxLength={64} readOnly={locked || !!provider} pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
          onChange={event => edit('id', event.target.value)} /></label>
      <label className="agent-management-field"><span>Provider 名称</span>
        <input value={draft.name} maxLength={128} readOnly={locked} onChange={event => edit('name', event.target.value)} /></label>
      <label className="agent-management-field"><span>API 协议</span>
        <select value={draft.protocol} disabled={locked} onChange={event => edit('protocol', event.target.value)}>
          {Object.entries(protocols).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
    </div>
    <label className="agent-management-field"><span>API 基础地址</span>
      <input type="url" value={draft.baseUrl} required maxLength={2048} readOnly={locked} onChange={event => edit('baseUrl', event.target.value)} /></label>
    <label className="agent-management-field mt-2"><span>API Key</span>
      <input type="password" value={draft.apiKey} maxLength={4096} autoComplete="new-password" disabled={locked}
        placeholder={provider ? '留空保留现有密钥' : '按上游要求填写'} onChange={event => edit('apiKey', event.target.value)} /></label>
    <label className="agent-management-field mt-2"><span>模型 ID（每行一个）</span>
      <textarea value={draft.models} rows={5} maxLength={25700} required readOnly={locked} onChange={event => edit('models', event.target.value)} /></label>
    {blocked && <p role="alert" className="agent-management-error-box">请先更改或清除当前默认模型 {selection.model}。</p>}
    {save.isError && <p role="alert" className="agent-management-error-box">{save.error.message}</p>}
    <div className="mt-4 flex justify-end">
      <button type="submit" className="agent-management-button agent-management-button-primary" disabled={locked || blocked || !models.length || openedRevision === undefined}>保存</button>
    </div>
  </form>;
}

export function useHarnessDefaultModel(url: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (selection: HarnessModelSelection | null) =>
      api.settings.update({ [HARNESS_MODEL_SETTING]: selection ? JSON.stringify({ url, ...selection }) : '' }),
    onSuccess: ({ settings }) => client.setQueryData(['settings'], { settings }),
  });
}

export function HarnessModels({ provider, selection, readOnly, setDefault }: {
  provider: HarnessProvider;
  selection?: HarnessModelSelection;
  readOnly: boolean;
  setDefault: ReturnType<typeof useHarnessDefaultModel>;
}) {
  const table = useTableModel(provider.models, [
    { key: 'id', title: '模型 ID', value: model => model.id },
    { key: 'name', title: '模型名称', value: model => model.name },
    { key: 'available', title: '状态', value: model => model.available ? '可选' : '待 Harness 确认' },
  ]);
  return <DataTable label={`Provider ${provider.name} 的模型`} model={table} minWidth={450} actions empty={!table.rows.length} emptyMessage="暂无模型">
    {table.rows.map(model => {
      const isDefault = selection?.provider === provider.id && selection.model === model.id;
      return <tr key={model.id}>
        <td><code>{model.id}</code></td>
        <td>{model.name || '—'}</td>
        <td>{model.available ? '可选' : '待 Harness 确认'}</td>
        <td>{isDefault ? '新标签页默认' : !readOnly && <TableActionButton
          disabled={!model.available || setDefault.isPending}
          onClick={() => setDefault.mutate({ provider: provider.id, model: model.id })}>设为新标签页默认</TableActionButton>}</td>
      </tr>;
    })}
  </DataTable>;
}
