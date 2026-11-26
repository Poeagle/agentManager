import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, FolderOpen } from 'lucide-react';
import './ProjectOpenDialog.css';
import type { Project } from '../lib/api';
import { projectOpenModes, type ProjectOpenMode } from './project-open-modes';
import { TableActionButton } from './table/TableActions';
import { Dialog } from './Dialog';

export function ProjectOpenDialog({ project, onClose, onOpen, busy = false, error, title = '打开项目',renderOptions,isChoiceReady,harnessUrl,onModeChange }: {
  project: Project; onClose: () => void;
  onOpen: (mode: ProjectOpenMode, cli?: string) => void;
  busy?: boolean; error?: string; title?: string; harnessUrl?: string;
  onModeChange?: () => void;
  renderOptions?: (mode: ProjectOpenMode, cli?: string) => ReactNode;
  isChoiceReady?: (mode: ProjectOpenMode, cli?: string) => boolean;
}) {
  const modeId = useId();
  const options = projectOpenModes(project, harnessUrl);
  const [selected, setSelected] = useState<string>(options[0]?.id ?? '');
  const choice = options.find((option) => option.id === selected) ?? options[0];
  return <Dialog title={`${title} · ${project.name}`} onClose={onClose} busy={busy}>
    <form className="project-open-form" onSubmit={(event) => { event.preventDefault(); if (choice && !busy && (isChoiceReady?.(choice.mode,choice.cli)??true)) onOpen(choice.mode, choice.cli); }}>
      <p className="project-open-path" title={project.path}><FolderOpen size={14} aria-hidden="true"/><span>{project.path}</span></p>
      <div className="project-open-mode">
        <label htmlFor={modeId}>选择打开方式</label>
        <div className="project-open-select-wrap">
          <select
            id={modeId}
            value={choice?.id ?? ''}
            disabled={busy || !choice}
            onChange={event => {
              const next = event.currentTarget.value;
              if (next === choice?.id) return;
              onModeChange?.();
              setSelected(next);
            }}
          >
            {!choice && <option value="">暂无可用方式</option>}
            {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </div>
      </div>
      {!choice && <p className="project-open-message">该项目尚未授权任何会话打开方式。</p>}
      {choice&&renderOptions?.(choice.mode,choice.cli)}
      {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
      <footer className="project-open-footer"><TableActionButton disabled={busy} onClick={onClose}>取消</TableActionButton>
        <TableActionButton type="submit" disabled={!choice || busy||!(isChoiceReady?.(choice.mode,choice.cli)??true)} style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? '正在创建…' : choice?.mode === 'deepseek-harness' ? '打开标签页' : '新建会话'}</TableActionButton></footer>
    </form>
  </Dialog>;
}
