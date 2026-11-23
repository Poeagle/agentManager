import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { HARNESS_URL_SETTING } from '../lib/deepseek-harness';

export function DeepSeekHarnessSettings({ url, readOnly = false, onSaved, onBusyChange, onDirtyChange }: {
  url: string;
  readOnly?: boolean;
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(url);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async (input: string) => {
      if (input) {
        const target = new URL(input);
        if (target.origin === window.location.origin) throw new Error('Harness 请使用独立的浏览器来源，例如同站点的独立端口或子域名。');
      }
      return api.settings.update({ [HARNESS_URL_SETTING]: input });
    },
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    onSuccess: ({ settings }) => {
      client.setQueryData(['settings'], { settings });
      onSaved();
    },
  });
  return <form onSubmit={event => { event.preventDefault(); if (!readOnly) save.mutate(value.trim()); }}>
    <label className="agent-management-field">
      <span>Harness 网页地址</span>
      <input type="url" value={value} maxLength={2048} placeholder="https://harness.example.com/"
        readOnly={readOnly} disabled={save.isPending} onChange={event => {
          setValue(event.target.value);
          onDirtyChange(event.target.value.trim() !== url);
        }} />
    </label>
    <p className="mt-2 text-xs" style={{ color:'var(--text-secondary)' }}>
      填写 Harness 的访问地址。在 Harness 实例启用 OctoAlly 插件后，项目标签会自动打开对应工作区。
    </p>
    {save.isError && <p role="alert" className="agent-management-error-box">{save.error.message}</p>}
    {!readOnly && <div className="mt-4 flex justify-end gap-2">
      {url && <button type="button" className="agent-management-button" disabled={save.isPending}
        onClick={() => save.mutate('')}>移除接入</button>}
      <button type="submit" className="agent-management-button agent-management-button-primary"
        disabled={save.isPending || !value.trim() || value.trim() === url}>保存</button>
    </div>}
  </form>;
}
