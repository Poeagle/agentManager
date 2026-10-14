import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Project } from '../lib/api';
import { projectOpenModes } from './project-open-modes';
import { TableActionButton } from './table/TableActions';
import { Dialog } from './Dialog';

export function ProjectOpenDialog({ project, onClose, onOpen, busy = false, error, title = '打开项目' }: {
  project: Project; onClose: () => void;
  onOpen: (mode: 'session' | 'terminal', cli?: 'claude' | 'codex') => void;
  busy?: boolean; error?: string; title?: string;
}) {
  const options = projectOpenModes(project);
  const [selected, setSelected] = useState<string>(options[0]?.id ?? '');
  const choice = options.find((option) => option.id === selected);
  return <Dialog title={`${title} · ${project.name}`} onClose={onClose} busy={busy}>
    <form onSubmit={(event) => { event.preventDefault(); if (choice && !busy) onOpen(choice.mode, choice.cli); }}>
      <p className="mb-4 break-all text-xs" style={{ color: 'var(--text-secondary)' }}>{project.path}</p>
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>选择新会话的打开方式</legend>
        {options.map(({ id, label, Icon }) => <label key={id} className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2"
          style={{ borderColor: selected === id ? 'var(--accent)' : 'var(--border)' }}>
          <input type="radio" name="project-open-mode" value={id} checked={selected === id} onChange={() => setSelected(id)} style={{ accentColor: 'var(--accent)' }} />
          <Icon className="h-4 w-4" /><span className="text-sm">{label}</span>
        </label>)}
        {options.length === 0 && <p className="text-xs">该项目尚未授权任何会话打开方式。</p>}
      </fieldset>
      {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
      <footer className="mt-4 flex justify-end gap-2"><TableActionButton disabled={busy} onClick={onClose}>取消</TableActionButton>
        <TableActionButton type="submit" disabled={!choice || busy} style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? '正在创建…' : '新建会话'}</TableActionButton></footer>
    </form>
  </Dialog>;
}
