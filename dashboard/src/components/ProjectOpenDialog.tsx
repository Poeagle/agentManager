import { useState,type ReactNode } from 'react';
import { Loader2, FolderOpen } from 'lucide-react';
import './ProjectOpenDialog.css';
import type { Project } from '../lib/api';
import { projectOpenModes } from './project-open-modes';
import { TableActionButton } from './table/TableActions';
import { Dialog } from './Dialog';

export function ProjectOpenDialog({ project, onClose, onOpen, busy = false, error, title = '打开项目',renderOptions,isChoiceReady }: {
  project: Project; onClose: () => void;
  onOpen: (mode: 'session' | 'terminal', cli?: string) => void;
  busy?: boolean; error?: string; title?: string;renderOptions?:(mode:'session'|'terminal',cli?:string)=>ReactNode;isChoiceReady?:(mode:'session'|'terminal',cli?:string)=>boolean;
}) {
  const options = projectOpenModes(project);
  const [selected, setSelected] = useState<string>(options[0]?.id ?? '');
  const choice = options.find((option) => option.id === selected);
  return <Dialog title={`${title} · ${project.name}`} onClose={onClose} busy={busy}>
    <form className="project-open-form" onSubmit={(event) => { event.preventDefault(); if (choice && !busy && (isChoiceReady?.(choice.mode,choice.cli)??true)) onOpen(choice.mode, choice.cli); }}>
      <p className="project-open-path" title={project.path}><FolderOpen size={14} aria-hidden="true"/><span>{project.path}</span></p>
      <fieldset disabled={busy} className="project-open-fieldset"><legend>选择打开方式</legend>
        <div className="project-open-options">{options.map(({ id, label, Icon }) => <label key={id} className="project-open-option" data-selected={selected === id}>
          <input type="radio" name="project-open-mode" value={id} checked={selected === id} onChange={() => setSelected(id)} />
          <Icon className="project-open-option-icon" aria-hidden="true"/><span>{label}</span>
        </label>)}</div>
        {options.length === 0 && <p className="project-open-message">该项目尚未授权任何会话打开方式。</p>}
      </fieldset>
      {choice&&renderOptions?.(choice.mode,choice.cli)}
      {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
      <footer className="project-open-footer"><TableActionButton disabled={busy} onClick={onClose}>取消</TableActionButton>
        <TableActionButton type="submit" disabled={!choice || busy||!(isChoiceReady?.(choice.mode,choice.cli)??true)} style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? '正在创建…' : '新建会话'}</TableActionButton></footer>
    </form>
  </Dialog>;
}
