import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Plus, Trash2, Lock, RefreshCw, Loader2 } from 'lucide-react';
import { api, type SkillGroup } from '../lib/api';
import { ConfirmModal } from './ConfirmModal';
import { FileExplorer } from './FileExplorer';

interface Selected {
  groupKey: string; tool: string; scope: string;
  dirName: string; name: string; path: string; readOnly: boolean;
}

/**
 * Per-project skill manager. Lists the project's own skills
 * (<project>/.claude/skills — read/write) plus the global skill stores
 * (~/.claude/skills, ~/.codex/skills — read-only reference). Whole-skill
 * CRUD is allowed only in the project store; the files inside a skill are
 * edited via the shared FileExplorer (read-only for global skills).
 */
export function ProjectSkillsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createIn, setCreateIn] = useState<SkillGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groupsQuery = useQuery({ queryKey: ['skills', projectId], queryFn: () => api.skills.list(projectId) });
  const groups = groupsQuery.data?.groups ?? [];

  // Keep selection valid as the list refreshes (e.g. after create/delete).
  useEffect(() => {
    if (!selected) return;
    const stillThere = groups
      .find((g) => g.key === selected.groupKey)?.skills
      .some((s) => s.dirName === selected.dirName);
    if (groups.length > 0 && !stillThere) setSelected(null);
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteMutation = useMutation({
    mutationFn: () => api.skills.remove(projectId, selected!.tool, selected!.scope, selected!.dirName),
    onSuccess: () => { setConfirmDelete(false); setSelected(null); qc.invalidateQueries({ queryKey: ['skills', projectId] }); },
    onError: (e: Error) => { setConfirmDelete(false); setError(e.message); },
  });

  return (
    <div className="h-full flex" style={{ background: 'var(--bg-primary)' }}>
      {/* ---- Left: grouped skill tree ---- */}
      <aside className="w-60 shrink-0 flex flex-col border-r overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Skills</span>
          </div>
          <button onClick={() => groupsQuery.refetch()} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }} title="刷新">
            <RefreshCw className={`w-3.5 h-3.5 ${groupsQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {groupsQuery.isLoading && <div className="flex items-center gap-2 px-3 py-4 text-xs" style={{ color: 'var(--text-secondary)' }}><Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…</div>}
          {groupsQuery.isError && <div className="px-3 py-4 text-xs" style={{ color: 'var(--error)' }}>加载失败：{(groupsQuery.error as Error)?.message}</div>}
          {groups.map((g) => (
            <div key={g.key} className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 group">
                <span className="text-[11px] font-semibold uppercase tracking-wider truncate" style={{ color: 'var(--text-secondary)' }}>{g.toolLabel}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>›</span>
                <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-secondary)' }}>{g.label}</span>
                {g.readOnly && <Lock className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)', opacity: 0.7 }} />}
                {!g.readOnly && (
                  <button onClick={() => { setCreateIn(g); setError(null); }} className="ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity" style={{ color: 'var(--text-secondary)' }} title={`在 ${g.toolLabel} / ${g.label} 新建技能`}>
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {g.skills.length === 0 ? (
                <div className="px-3 pb-1.5 pl-5 text-[11px]" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>（空）</div>
              ) : (
                g.skills.map((s) => {
                  const isSel = selected?.groupKey === g.key && selected?.dirName === s.dirName;
                  return (
                    <button
                      key={s.dirName}
                      onClick={() => { setSelected({ groupKey: g.key, tool: g.tool, scope: g.scope, dirName: s.dirName, name: s.name, path: s.path, readOnly: g.readOnly }); setError(null); }}
                      className="w-full text-left flex items-start gap-2 pl-5 pr-3 py-1.5 transition-colors"
                      style={{ background: isSel ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: isSel ? 'var(--accent)' : 'var(--text-secondary)' }} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                        {s.description && <span className="block text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>{s.description}</span>}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ---- Right: the selected skill's directory, via the shared FileExplorer ---- */}
      <section className="flex-1 min-w-0 flex flex-col">
        {error && <div className="px-5 py-2 text-xs shrink-0" style={{ color: 'var(--error)', background: 'rgba(239,68,68,0.08)' }}>{error}</div>}
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <Sparkles className="w-8 h-8" style={{ opacity: 0.4 }} />
            <p className="text-sm">从左侧选择一个技能</p>
            <p className="text-xs" style={{ opacity: 0.7 }}>本项目可增删改 · 全局为只读参考</p>
          </div>
        ) : (
          <>
            {/* Skill header */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <Sparkles className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{selected.name}</h2>
                  {selected.readOnly && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                      <Lock className="w-2.5 h-2.5" /> 全局 · 只读
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>{selected.path}</div>
              </div>
              {!selected.readOnly && (
                <button onClick={() => { setConfirmDelete(true); setError(null); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0" style={{ background: 'transparent', color: 'var(--error)', border: '1px solid var(--border)' }} title="删除整个技能">
                  <Trash2 className="w-3.5 h-3.5" /> 删除技能
                </button>
              )}
            </div>

            {/* The skill's files — reuse the app's FileExplorer (read-only for global skills). */}
            <div className="flex-1 min-h-0">
              <FileExplorer
                key={selected.path}
                rootPath={selected.path}
                instanceId={`skill-${projectId}-${selected.tool}-${selected.scope}-${selected.dirName}`}
                readOnly={selected.readOnly}
              />
            </div>
          </>
        )}
      </section>

      {confirmDelete && selected && (
        <ConfirmModal
          title="删除技能"
          message={`确定删除技能 "${selected.name}"？这会移除整个技能目录（含全部文件），且不可撤销。`}
          confirmLabel={deleteMutation.isPending ? '删除中…' : '删除'}
          variant="danger"
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {createIn && (
        <NewSkillModal
          projectId={projectId}
          group={createIn}
          onClose={() => setCreateIn(null)}
          onCreated={(skill) => {
            setCreateIn(null);
            qc.invalidateQueries({ queryKey: ['skills', projectId] });
            setSelected({ groupKey: createIn.key, tool: createIn.tool, scope: createIn.scope, dirName: skill.dirName, name: skill.dirName, path: skill.path, readOnly: createIn.readOnly });
          }}
        />
      )}
    </div>
  );
}

function NewSkillModal({ projectId, group, onClose, onCreated }: {
  projectId: string;
  group: SkillGroup;
  onClose: () => void;
  onCreated: (skill: { dirName: string; path: string }) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () => api.skills.create(projectId, group.tool, group.scope, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (res) => onCreated({ dirName: res.dirName, path: res.path }),
    onError: (e: Error) => setError(e.message),
  });
  const nameValid = /^[A-Za-z0-9._-]+$/.test(name.trim()) && name.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="flex flex-col rounded-lg shadow-2xl overflow-hidden w-full" style={{ maxWidth: 440, background: 'var(--bg-primary)', border: '1px solid var(--border)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 pt-5 pb-1">
          <Plus className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>新建技能</h3>
        </div>
        <div className="px-5 py-3 space-y-3">
          <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>位置：{group.toolLabel} › {group.label}</p>
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>技能名（目录名）</label>
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="my-skill"
              className="w-full px-2.5 py-1.5 rounded-md text-xs outline-none font-mono" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} />
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>只能用字母、数字、. _ - ；会生成一个含 SKILL.md 的目录</p>
          </div>
          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>描述（可选）</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="什么时候用这个技能…" rows={2}
              className="w-full px-2.5 py-1.5 rounded-md text-xs outline-none resize-none" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} />
          </div>
          {error && <p className="text-[11px]" style={{ color: 'var(--error)' }}>{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs font-medium" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>取消</button>
          <button onClick={() => createMutation.mutate()} disabled={!nameValid || createMutation.isPending} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: '#fff' }}>
            {createMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} 创建
          </button>
        </div>
      </div>
    </div>
  );
}
