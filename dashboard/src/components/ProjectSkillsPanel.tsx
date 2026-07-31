import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Plus, Trash2, Lock, RefreshCw, Loader2, Search, X,
  Download, ExternalLink, PackageSearch, ShieldAlert, CheckCircle2, TrendingUp,
} from 'lucide-react';
import {
  api,
  type SkillGroup,
  type SkillInstallTarget,
  type SkillInstallTargetId,
  type SkillMarketplaceResult,
  type SkillMarketplaceSearchResponse,
} from '../lib/api';
import { ConfirmModal } from './ConfirmModal';
import { FileExplorer } from './FileExplorer';

interface Selected {
  groupKey: string; tool: string; scope: string;
  dirName: string; name: string; path: string; readOnly: boolean;
}

/**
 * Per-project skill manager. Lists the project's own skills
 * for Claude Code, Codex/universal agents and OpenClaw, plus global read-only
 * references. Files inside a skill are edited via the shared FileExplorer.
 */
export function ProjectSkillsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createIn, setCreateIn] = useState<SkillGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marketVisible, setMarketVisible] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [lastInstalled, setLastInstalled] = useState<string | null>(null);
  const [installTargets, setInstallTargets] = useState<SkillInstallTargetId[]>(['claude-code', 'codex']);

  const groupsQuery = useQuery({ queryKey: ['skills', projectId], queryFn: () => api.skills.list(projectId) });
  const groups = groupsQuery.data?.groups ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const searchReady = searchQuery.length === 0 || searchQuery.length >= 2;
  const marketSearch = useQuery({
    queryKey: ['skill-marketplace', projectId, searchQuery],
    queryFn: () => api.skills.marketplaceSearch(projectId, searchQuery),
    enabled: marketVisible && searchReady,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  // Keep selection valid as the list refreshes (e.g. after create/delete).
  useEffect(() => {
    if (!selected) return;
    const stillThere = groups
      .find((g) => g.key === selected.groupKey)?.skills
      .some((s) => s.dirName === selected.dirName);
    // A refresh can remove the directory outside this component (delete, git change).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (groups.length > 0 && !stillThere) setSelected(null);
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteMutation = useMutation({
    mutationFn: () => api.skills.remove(projectId, selected!.tool, selected!.scope, selected!.dirName),
    onSuccess: () => { setConfirmDelete(false); setSelected(null); setMarketVisible(true); qc.invalidateQueries({ queryKey: ['skills', projectId] }); },
    onError: (e: Error) => { setConfirmDelete(false); setError(e.message); },
  });

  const installMutation = useMutation({
    mutationFn: ({ skill, targets }: { skill: SkillMarketplaceResult; targets: SkillInstallTargetId[] }) =>
      api.skills.marketplaceInstall(projectId, skill, targets),
    onSuccess: (_response, { skill, targets }) => {
      setError(null);
      setLastInstalled(skill.name);
      qc.setQueriesData<SkillMarketplaceSearchResponse>(
        { queryKey: ['skill-marketplace', projectId] },
        (old) => old ? {
          ...old,
          skills: old.skills.map((entry) => entry.slug === skill.slug ? {
            ...entry,
            installed: true,
            installedTargets: Array.from(new Set([...entry.installedTargets, ...targets])),
          } : entry),
        } : old,
      );
      qc.invalidateQueries({ queryKey: ['skills', projectId] });
      qc.invalidateQueries({ queryKey: ['skill-marketplace', projectId] });
    },
    onError: (e: Error) => setError(`安装失败：${e.message}`),
  });

  const selectLocalSkill = (next: Selected) => {
    setSelected(next);
    setMarketVisible(false);
    setSearchInput('');
    setSearchQuery('');
    setLastInstalled(null);
    setError(null);
  };

  return (
    <div className="h-full flex" style={{ background: 'var(--bg-primary)' }}>
      {/* ---- Left: grouped skill tree ---- */}
      <aside className="w-60 shrink-0 flex flex-col border-r overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Skills</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => { setMarketVisible(true); setSearchInput(''); setSearchQuery(''); setLastInstalled(null); setError(null); }}
              className="p-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1"
              style={{ color: marketVisible ? 'var(--accent)' : 'var(--text-secondary)' }}
              title="浏览 Skill 市场"
              aria-label="浏览 Skill 市场"
            >
              <PackageSearch className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => groupsQuery.refetch()} className="p-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1" style={{ color: 'var(--text-secondary)' }} title="刷新" aria-label="刷新技能列表">
              <RefreshCw className={`w-3.5 h-3.5 ${groupsQuery.isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
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
                      onClick={() => selectLocalSkill({ groupKey: g.key, tool: g.tool, scope: g.scope, dirName: s.dirName, name: s.name, path: s.path, readOnly: g.readOnly })}
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

      {/* ---- Right: marketplace browser or selected local skill ---- */}
      <section className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
          <button
            type="button"
            onClick={() => { setMarketVisible(true); setLastInstalled(null); }}
            className="hidden sm:flex items-center gap-1.5 text-xs font-semibold shrink-0 rounded focus-visible:outline-none focus-visible:ring-1"
            style={{ color: marketVisible ? 'var(--accent)' : 'var(--text-secondary)' }}
          >
            <PackageSearch className="w-4 h-4" /> Skill 市场
          </button>
          <div className="relative flex-1 max-w-2xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none" style={{ color: 'var(--text-secondary)' }} />
            <input
              value={searchInput}
              onFocus={() => setMarketVisible(true)}
              onChange={(event) => { setSearchInput(event.target.value); setMarketVisible(true); setLastInstalled(null); setError(null); }}
              placeholder="搜索 React、测试、设计或自动化 Skills…"
              aria-label="搜索 Skill 市场"
              className="w-full h-9 pl-9 pr-9 rounded-md text-xs outline-none focus-visible:ring-1"
              style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => { setSearchInput(''); setSearchQuery(''); setMarketVisible(true); setLastInstalled(null); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1"
                style={{ color: 'var(--text-secondary)' }}
                aria-label="清除搜索"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-5 py-2 text-xs shrink-0" style={{ color: 'var(--error)', background: 'rgba(239,68,68,0.08)' }}>
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="p-0.5 rounded hover:bg-white/10" aria-label="关闭错误提示"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {marketVisible ? (
          <MarketplaceBrowser
            query={searchQuery}
            searchReady={searchReady}
            data={marketSearch.data}
            isLoading={marketSearch.isLoading}
            error={marketSearch.error as Error | null}
            selectedTargets={installTargets}
            onToggleTarget={(targetId) => setInstallTargets((current) => current.includes(targetId)
              ? current.filter((id) => id !== targetId)
              : [...current, targetId])}
            installingId={installMutation.isPending ? installMutation.variables?.skill.id || null : null}
            installBusy={installMutation.isPending}
            lastInstalled={lastInstalled}
            onInstall={(skill) => installMutation.mutate({ skill, targets: installTargets })}
          />
        ) : !selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <Sparkles className="w-8 h-8" style={{ opacity: 0.4 }} />
            <p className="text-sm">从左侧选择一个技能</p>
            <button type="button" onClick={() => setMarketVisible(true)} className="text-xs hover:underline" style={{ color: 'var(--accent)' }}>或浏览 Skill 市场</button>
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
            setMarketVisible(false);
          }}
        />
      )}
    </div>
  );
}

const DEFAULT_INSTALL_TARGETS: SkillInstallTarget[] = [
  { id: 'claude-code', label: 'Claude Code', description: '.claude/skills' },
  { id: 'codex', label: 'Codex / 通用 Agents', description: '.agents/skills · Cursor、OpenCode 等也可读取' },
  { id: 'openclaw', label: 'OpenClaw', description: 'skills' },
];

function formatMarketCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function MarketplaceBrowser({
  query,
  searchReady,
  data,
  isLoading,
  error,
  selectedTargets,
  onToggleTarget,
  installingId,
  installBusy,
  lastInstalled,
  onInstall,
}: {
  query: string;
  searchReady: boolean;
  data?: SkillMarketplaceSearchResponse;
  isLoading: boolean;
  error: Error | null;
  selectedTargets: SkillInstallTargetId[];
  onToggleTarget: (targetId: SkillInstallTargetId) => void;
  installingId: string | null;
  installBusy: boolean;
  lastInstalled: string | null;
  onInstall: (skill: SkillMarketplaceResult) => void;
}) {
  const targets = data?.installTargets || DEFAULT_INSTALL_TARGETS;
  const targetLabels = new Map(targets.map((target) => [target.id, target.label]));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-5xl mx-auto px-5 py-5">
        <div className="flex flex-col gap-4 mb-5">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                {query ? <Search className="w-4 h-4" style={{ color: 'var(--accent)' }} /> : <TrendingUp className="w-4 h-4" style={{ color: 'var(--accent)' }} />}
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {query ? `“${query}” 的搜索结果` : '热门 Skills'}
                </h2>
                {data && <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{data.skills.length} 项</span>}
              </div>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                从公开市场查找技能，并复制到当前项目的 Agent 目录。
              </p>
            </div>
            {data?.providers && (
              <div className="flex items-center gap-1.5 flex-wrap" aria-label="技能市场来源">
                {data.providers.map((provider) => (
                  <span
                    key={provider.id}
                    title={provider.message}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px]"
                    style={{
                      color: provider.ok ? 'var(--text-primary)' : 'var(--text-secondary)',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      opacity: provider.enabled ? 1 : 0.65,
                    }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: provider.ok ? 'var(--success)' : provider.enabled ? 'var(--warning)' : 'var(--text-secondary)' }} />
                    {provider.label}{!provider.enabled ? ' · 未配置' : !provider.ok ? ' · 暂不可用' : ''}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div className="flex items-start gap-3">
              <div className="pt-0.5 shrink-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>安装到</span>
              </div>
              <div className="flex flex-wrap gap-2 flex-1">
                {targets.map((target) => {
                  const checked = selectedTargets.includes(target.id);
                  return (
                    <button
                      key={target.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => onToggleTarget(target.id)}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1"
                      style={{
                        color: checked ? 'var(--text-primary)' : 'var(--text-secondary)',
                        background: checked ? 'var(--bg-tertiary)' : 'transparent',
                        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                      }}
                    >
                      <span className="w-3.5 h-3.5 rounded-[3px] flex items-center justify-center shrink-0" style={{ background: checked ? 'var(--accent)' : 'transparent', border: checked ? 'none' : '1px solid var(--text-secondary)' }}>
                        {checked && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </span>
                      <span>
                        <span className="block text-[11px] font-medium">{target.label}</span>
                        <span className="block text-[9px] font-mono opacity-70">{target.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 px-3 py-2 rounded-md text-[10px]" style={{ color: 'var(--text-secondary)', background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.18)' }}>
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
            <span>社区技能可能包含脚本和外部指令。安装包会经过路径与体积校验，但仍建议先查看来源和 SKILL.md。</span>
          </div>

          {lastInstalled && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md text-xs" style={{ color: 'var(--success)', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)' }} role="status" aria-live="polite">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span><strong>{lastInstalled}</strong> 已安装到所选项目 Agent 目录，可在左侧查看。</span>
            </div>
          )}
        </div>

        {!searchReady ? (
          <div className="py-16 text-center">
            <Search className="w-7 h-7 mx-auto mb-2" style={{ color: 'var(--text-secondary)', opacity: 0.45 }} />
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>再输入一个字符开始搜索</p>
          </div>
        ) : isLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <Loader2 className="w-4 h-4 animate-spin" /> 正在查询 Skill 市场…
          </div>
        ) : error ? (
          <div className="py-16 text-center">
            <ShieldAlert className="w-7 h-7 mx-auto mb-2" style={{ color: 'var(--error)', opacity: 0.8 }} />
            <p className="text-xs" style={{ color: 'var(--error)' }}>市场查询失败：{error.message}</p>
          </div>
        ) : !data || data.skills.length === 0 ? (
          <div className="py-16 text-center">
            <PackageSearch className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>没有找到匹配的 Skill</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>试试更短的关键词或英文术语</p>
          </div>
        ) : (
          <ul className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
            {data.skills.map((skill) => {
              const pendingTargets = selectedTargets.filter((target) => !skill.installedTargets.includes(target));
              const allSelectedInstalled = selectedTargets.length > 0 && pendingTargets.length === 0;
              const isInstalling = installingId === skill.id;
              return (
                <li key={skill.id} className="flex flex-col md:flex-row md:items-center gap-3 px-4 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--border)' }}>
                  <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ color: 'var(--accent)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold hover:underline focus-visible:outline-none focus-visible:ring-1 rounded" style={{ color: 'var(--text-primary)' }}>
                        {skill.name}
                      </a>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>{skill.providerLabel}</span>
                      {skill.official && <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--success)', background: 'rgba(34,197,94,0.08)' }}>官方</span>}
                      {skill.featured && <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--warning)', background: 'rgba(234,179,8,0.08)' }}>精选</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] font-mono min-w-0" style={{ color: 'var(--text-secondary)' }}>
                      <span className="truncate">{skill.author ? `${skill.author}/` : ''}{skill.slug}</span>
                      <a href={skill.url} target="_blank" rel="noopener noreferrer" className="p-0.5 rounded hover:bg-white/10 shrink-0" aria-label={`打开 ${skill.name} 的市场页面`}><ExternalLink className="w-2.5 h-2.5" /></a>
                    </div>
                    {skill.description && <p className="mt-1 text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{skill.description}</p>}
                    <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                      <span className="inline-flex items-center gap-1"><Download className="w-3 h-3" /> {formatMarketCount(skill.downloads)} 次下载</span>
                      {skill.version && <span>v{skill.version}</span>}
                      {skill.installedTargets.map((target) => (
                        <span key={target} className="inline-flex items-center gap-1" style={{ color: 'var(--success)' }}>
                          <CheckCircle2 className="w-3 h-3" /> {targetLabels.get(target) || target}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onInstall(skill)}
                    disabled={installBusy || selectedTargets.length === 0 || allSelectedInstalled}
                    className="self-stretch md:self-auto min-w-28 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-semibold disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 shrink-0"
                    style={{
                      color: allSelectedInstalled ? 'var(--success)' : '#fff',
                      background: allSelectedInstalled ? 'var(--bg-tertiary)' : 'var(--accent)',
                      border: `1px solid ${allSelectedInstalled ? 'var(--border)' : 'transparent'}`,
                    }}
                  >
                    {isInstalling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : allSelectedInstalled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                    {isInstalling
                      ? '安装中…'
                      : selectedTargets.length === 0
                        ? '请选择目标'
                        : allSelectedInstalled
                          ? '所选目标已安装'
                          : pendingTargets.length > 1
                            ? `安装到 ${pendingTargets.length} 个目标`
                            : skill.installedTargets.length > 0 ? '补充安装' : '安装'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
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
