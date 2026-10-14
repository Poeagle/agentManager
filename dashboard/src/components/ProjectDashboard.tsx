import { TableActionButton, TableActions } from './table/TableActions';
import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project } from '../lib/api';
import { hasPermission, usePermissions } from '../lib/permissions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Plus,
  FolderOpen,
  ChevronRight,
  ArrowUp,

  Trash2,
  X,
  Pencil,
  Save,
  Loader2,
  Folder,
  Eye,
  RefreshCw,
  GitBranch,
  ChevronDown,
  Lock,
  Globe,
  Github,
  Search,
  GripVertical,
} from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { ConfirmModal } from './ConfirmModal';
import { StatuslinePromptModal } from './StatuslinePromptModal';
import { moveItemByKey, orderItemsByKeys } from '../lib/reorder';
import { useTableModel } from './table/use-table-model';
import { DataTable, TableExpandButton, TableDetailRow } from './table/DataTable';
import { RowActionsMenu } from './table/RowActionsMenu';
import { ProjectSessionCreateDialog } from './ProjectSessionCreateDialog';
import { projectOpenModes } from './project-open-modes';
import { ProjectSessionTable } from './ProjectSessionTable';
import { Dialog } from './Dialog';

interface ProjectDashboardProps {
  onOpenProject: (projectId: string, projectName: string, quickLaunch?: 'session' | 'terminal', cliType?: 'claude' | 'codex') => void;
  onOpenSession?: (projectId: string, sessionId: string) => void;
  projectOrder: string[];
  onProjectOrderChange: (order: string[]) => void;
}

type ViewState = { mode: 'list' } | { mode: 'add' } | { mode: 'edit'; project: Project };

function FolderBrowser({ onSelect }: { onSelect: (path: string, folderName: string) => void }) {
  const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ['browse', browsePath],
    queryFn: () => api.projects.browse(browsePath),
  });

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
      >
        {data?.parent && (
          <button
            onClick={() => setBrowsePath(data.parent!)}
            className="p-0.5 rounded hover:bg-white/10"
            title="Go up"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="truncate font-mono">{data?.path || '~'}</span>
        <button
          onClick={() => {
            if (data?.path) onSelect(data.path, data.folderName);
          }}
          className="ml-auto px-2 py-1 rounded text-xs font-medium shrink-0"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          Select This Folder
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent)' }} />
          </div>
        ) : data?.dirs.length === 0 ? (
          <div className="py-4 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
            No subdirectories
          </div>
        ) : (
          data?.dirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => setBrowsePath(dir.path)}
              onDoubleClick={() => onSelect(dir.path, dir.name)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-white/5 text-left"
              style={{ color: 'var(--text-primary)' }}
            >
              <FolderOpen className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
              <span className="truncate">{dir.name}</span>
              {dir.hasChildren && (
                <ChevronRight className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--text-secondary)' }} />
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function prevFolderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const inputStyle = {
  background: 'var(--bg-tertiary)',
  borderColor: 'var(--border)',
  color: 'var(--text-primary)',
};

const inputClass = 'w-full px-2.5 py-1.5 rounded-md border text-[13px] outline-none';

function ProjectForm({
  mode,
  project,
  onSubmit,
  onCancel,
}: {
  mode: 'add' | 'edit';
  project?: Project;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(project?.name || '');
  const [path, setPath] = useState(project?.path || '');
  const [description, setDescription] = useState(project?.description || '');
  const [projectColor, setProjectColor] = useState(project?.color || '');
  const [sessionPrompt, setSessionPrompt] = useState(project?.session_prompt || '');
  const [openclawPrompt, setOpenclawPrompt] = useState(project?.openclaw_prompt || '');
  const [claudeMd, setClaudeMd] = useState('');
  const [agentsMd, setAgentsMd] = useState('');
  const [settingsJson, setSettingsJson] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [claudeMdPreview, setClaudeMdPreview] = useState(false);
  const [agentsMdPreview, setAgentsMdPreview] = useState(false);
  const [error, setError] = useState('');

  // Track initial loaded values to detect changes
  const [initialClaudeMd, setInitialClaudeMd] = useState('');
  const [initialAgentsMd, setInitialAgentsMd] = useState('');
  const [initialSettingsJson, setInitialSettingsJson] = useState('');

  const projectPath = mode === 'edit' ? project!.path : path;

  // Load CLAUDE.md (edit mode only)
  const claudeMdQuery = useQuery({
    queryKey: ['file-read', projectPath, 'CLAUDE.md'],
    queryFn: () => api.files.read(`${projectPath}/CLAUDE.md`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Load AGENTS.md (edit mode only — Codex config)
  const agentsMdQuery = useQuery({
    queryKey: ['file-read', projectPath, 'AGENTS.md'],
    queryFn: () => api.files.read(`${projectPath}/AGENTS.md`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Load .claude/settings.json (edit mode only)
  const settingsQuery = useQuery({
    queryKey: ['file-read', projectPath, '.claude/settings.json'],
    queryFn: () => api.files.read(`${projectPath}/.claude/settings.json`),
    enabled: !!projectPath && mode === 'edit',
    retry: false,
  });

  // Sync loaded file contents into state
  useEffect(() => {
    if (claudeMdQuery.isSuccess) {
      setClaudeMd(claudeMdQuery.data.content);
      setInitialClaudeMd(claudeMdQuery.data.content);
    } else if (claudeMdQuery.isError) {
      setClaudeMd('');
      setInitialClaudeMd('');
    }
  }, [claudeMdQuery.isSuccess, claudeMdQuery.isError, claudeMdQuery.data?.content]);

  useEffect(() => {
    if (agentsMdQuery.isSuccess) {
      setAgentsMd(agentsMdQuery.data.content);
      setInitialAgentsMd(agentsMdQuery.data.content);
    } else if (agentsMdQuery.isError) {
      setAgentsMd('');
      setInitialAgentsMd('');
    }
  }, [agentsMdQuery.isSuccess, agentsMdQuery.isError, agentsMdQuery.data?.content]);

  useEffect(() => {
    if (settingsQuery.isSuccess) {
      setSettingsJson(settingsQuery.data.content);
      setInitialSettingsJson(settingsQuery.data.content);
    } else if (settingsQuery.isError) {
      setSettingsJson('');
      setInitialSettingsJson('');
    }
  }, [settingsQuery.isSuccess, settingsQuery.isError, settingsQuery.data?.content]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.projects.create({ name, path, description, color: projectColor || undefined }),
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onSubmit();
      if (data.project?.id) {
        setTimeout(() => {
          const openEvent = new CustomEvent('agentmanager:open-project', {
            detail: { id: data.project.id, name: data.project.name },
          });
          window.dispatchEvent(openEvent);
        }, 0);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      const fields: Parameters<typeof api.projects.update>[1] = {};
      if (name !== project!.name) fields.name = name;
      if (description !== (project!.description || '')) fields.description = description;
      if (sessionPrompt !== (project!.session_prompt || ''))
        fields.session_prompt = sessionPrompt || null;
      if (openclawPrompt !== (project!.openclaw_prompt || ''))
        fields.openclaw_prompt = openclawPrompt || null;
      // Always send color to ensure save works even if only color changed
      fields.color = projectColor || '';
      return api.projects.update(project!.id, fields);
    },
    onSuccess: async () => {
      const savePath = project!.path;
      try {
        if (claudeMd !== initialClaudeMd) await api.files.write(`${savePath}/CLAUDE.md`, claudeMd);
        if (agentsMd !== initialAgentsMd) await api.files.write(`${savePath}/AGENTS.md`, agentsMd);
        if (settingsJson !== initialSettingsJson)
          await api.files.write(`${savePath}/.claude/settings.json`, settingsJson);
      } catch {
        // best-effort file writes
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onSubmit();
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSave = async () => {
    setError('');
    if (mode === 'edit') { updateMutation.mutate(); return; }
    createMutation.mutate();
  };

  const handleFolderSelect = (selectedPath: string, folderName: string) => {
    setPath(selectedPath);
    if (!name || name === prevFolderName(path)) setName(folderName);
    setShowBrowser(false);
  };

  const filesLoading = mode === 'edit' && (!!projectPath) && (claudeMdQuery.isLoading || agentsMdQuery.isLoading || settingsQuery.isLoading);

  const isPending = createMutation.isPending || updateMutation.isPending;

  const [createRepo, setCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [repoBranch, setRepoBranch] = useState('main');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoCreating, setRepoCreating] = useState(false);
  const [repoResult, setRepoResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['gh-accounts'],
    queryFn: () => api.git.ghAccounts(),
  });
  const ghAccounts = useMemo(() => accountsData?.accounts ?? [], [accountsData?.accounts]);

  // Auto-set repo name and owner when path changes
  useEffect(() => {
    if (projectPath) {
      const folder = projectPath.split('/').pop() || '';
      if (!repoName) setRepoName(folder);
    }
  }, [projectPath, repoName]);

  useEffect(() => {
    if (ghAccounts.length > 0 && !repoOwner) setRepoOwner(ghAccounts[0]);
  }, [ghAccounts, repoOwner]);

  // Check git status for the project path
  const { data: gitStatusData } = useQuery({
    queryKey: ['git-status', projectPath],
    queryFn: () => api.git.status(projectPath).catch(() => null),
    enabled: !!projectPath,
    retry: false,
  });

  const hasGitRepo = gitStatusData !== null && gitStatusData !== undefined;
  const hasRemote = hasGitRepo && !!gitStatusData?.remoteUrl;

  return (
    <Dialog title={mode === 'add' ? '新增项目' : `编辑项目 · ${project!.name}`} onClose={onCancel} busy={isPending || repoCreating} size="lg">
    <div className="compact-form">
      <div className="w-full">
        <div
          className="rounded-lg border p-3"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <div className="flex flex-col gap-4">
            {/* Folder Path — add mode only */}
            {mode === 'add' && (
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Folder Path</label>
                <div className="flex gap-2">
                  <input
                    aria-label="项目路径"
                    value={path}
                    onChange={(e) => {
                      const val = e.target.value;
                      const folderName = prevFolderName(val);
                      setPath(val);
                      if (!name || name === prevFolderName(path)) setName(folderName);
                    }}
                    placeholder="/home/user/projects/myapp"
                    className="flex-1 px-4 py-2.5 rounded-lg border text-sm outline-none font-mono"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => setShowBrowser(!showBrowser)}
                    className="px-3 py-2.5 rounded-lg border text-sm flex items-center gap-1.5"
                    style={{
                      background: showBrowser ? 'var(--accent)' : 'var(--bg-tertiary)',
                      borderColor: 'var(--border)',
                      color: showBrowser ? 'white' : 'var(--text-secondary)',
                    }}
                  >
                    <FolderOpen className="w-4 h-4" />
                    Browse
                  </button>
                </div>
              </div>
            )}

            {/* Folder Browser */}
            {mode === 'add' && showBrowser && (
              <div>
                <FolderBrowser onSelect={handleFolderSelect} />
              </div>
            )}

            {/* Edit mode: show path as read-only */}
            {mode === 'edit' && (
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Path</label>
                <div
                  className="px-4 py-2.5 rounded-lg border text-sm font-mono"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                >
                  {project!.path}
                </div>
              </div>
            )}

            {/* Row: Name + Description side by side */}
            <div className="field-grid">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Project Name</label>
                <input
                  aria-label="项目名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Project"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Description</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of this project"
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
            </div>

            {/* Card Color */}
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Card Color</label>
              <div className="flex items-center gap-2">
                {['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'].map((c) => {
                  const defaultColors = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'];
                  const hash = name.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
                  const isActive = projectColor ? projectColor === c : c === defaultColors[hash % defaultColors.length];
                  return (
                    <button
                      key={c}
                      onClick={() => setProjectColor(c)}
                      className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        background: c,
                        borderColor: isActive ? 'white' : 'transparent',
                        boxShadow: isActive ? `0 0 0 2px ${c}` : 'none',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* GitHub Repository */}
            <div
              className="rounded-lg border p-4 flex flex-col gap-3"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
                <div className="flex items-center gap-2">
                  <Github className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>GitHub Repository</span>
                </div>

                {!projectPath ? (
                  <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                    Select a folder path first.
                  </p>
                ) : hasRemote ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: '#22c55e' }}>
                      <GitBranch className="w-3 h-3" />
                      <span className="font-medium">{gitStatusData!.branch}</span>
                    </div>
                    <p className="text-[10px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                      {gitStatusData!.remoteUrl}
                    </p>
                  </div>
                ) : hasGitRepo ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: '#f59e0b' }}>
                      <GitBranch className="w-3 h-3" />
                      <span className="font-medium">{gitStatusData!.branch}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>(local only)</span>
                    </div>
                    {!createRepo && (
                      <button
                        onClick={() => setCreateRepo(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                        style={{ background: '#3b82f622', color: '#3b82f6', border: '1px solid #3b82f644' }}
                      >
                        <Github className="w-3 h-3" /> Create GitHub Remote
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                      No git repository found. Create one with a GitHub remote.
                    </p>
                    {!createRepo && (
                      <button
                        onClick={() => setCreateRepo(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium"
                        style={{ background: '#3b82f622', color: '#3b82f6', border: '1px solid #3b82f644' }}
                      >
                        <Github className="w-3 h-3" /> Create Repository
                      </button>
                    )}
                  </>
                )}

                {createRepo && (
                  <div className="flex flex-col gap-2.5 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Account</label>
                      {ghAccounts.length === 0 ? (
                        <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                          No accounts. Run <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', fontSize: '9px' }}>gh auth login</code>
                        </p>
                      ) : (
                        <select
                          value={repoOwner}
                          onChange={(e) => setRepoOwner(e.target.value)}
                          className="w-full px-2 py-1.5 rounded text-xs"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                        >
                          {ghAccounts.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      )}
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Repository Name</label>
                      <input
                        value={repoName}
                        onChange={(e) => setRepoName(e.target.value)}
                        className="w-full px-2 py-1.5 rounded text-xs"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Default Branch</label>
                      <input
                        value={repoBranch}
                        onChange={(e) => setRepoBranch(e.target.value)}
                        className="w-full px-2 py-1.5 rounded text-xs"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Visibility</label>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setRepoPrivate(true)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] font-medium flex-1 justify-center"
                          style={{
                            background: repoPrivate ? '#f59e0b22' : 'var(--bg-tertiary)',
                            color: repoPrivate ? '#f59e0b' : 'var(--text-secondary)',
                            border: `1px solid ${repoPrivate ? '#f59e0b44' : 'var(--border)'}`,
                          }}
                        >
                          <Lock className="w-3 h-3" /> Private
                        </button>
                        <button
                          onClick={() => setRepoPrivate(false)}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[10px] font-medium flex-1 justify-center"
                          style={{
                            background: !repoPrivate ? '#22c55e22' : 'var(--bg-tertiary)',
                            color: !repoPrivate ? '#22c55e' : 'var(--text-secondary)',
                            border: `1px solid ${!repoPrivate ? '#22c55e44' : 'var(--border)'}`,
                          }}
                        >
                          <Globe className="w-3 h-3" /> Public
                        </button>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!projectPath || repoCreating || !repoName.trim()) return;
                        setRepoCreating(true);
                        setRepoResult(null);
                        try {
                          await api.git.createRepo({
                            path: projectPath,
                            name: repoName.trim(),
                            owner: repoOwner || undefined,
                            private: repoPrivate,
                            defaultBranch: repoBranch.trim() || 'main',
                          });
                          setRepoResult({ ok: true, message: 'Repository created successfully!' });
                          queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
                          setCreateRepo(false);
                        } catch (err: unknown) {
                          setRepoResult({ ok: false, message: errorMessage(err, 'Failed to create repository') });
                        } finally {
                          setRepoCreating(false);
                        }
                      }}
                      disabled={repoCreating || !repoName.trim() || ghAccounts.length === 0}
                      className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium w-full"
                      style={{
                        background: repoCreating ? '#3b82f680' : '#3b82f6',
                        color: '#fff',
                        opacity: (!repoName.trim() || ghAccounts.length === 0) ? 0.5 : 1,
                      }}
                    >
                      {repoCreating ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating...</>
                      ) : (
                        <><Github className="w-3.5 h-3.5" /> Create Repository</>
                      )}
                    </button>
                    <button
                      onClick={() => setCreateRepo(false)}
                      className="text-[10px] text-center"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {repoResult && (
                  <div
                    className="text-[10px] px-2 py-1.5 rounded"
                    style={{
                      background: repoResult.ok ? '#22c55e15' : '#ef444415',
                      color: repoResult.ok ? '#22c55e' : '#ef4444',
                      border: `1px solid ${repoResult.ok ? '#22c55e33' : '#ef444433'}`,
                    }}
                  >
                    {repoResult.message}
                  </div>
                )}
            </div>

            {/* ===== Edit mode: Prompts + Files section ===== */}
            {mode === 'edit' && (
              <div className="flex flex-col gap-4 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Row 1: Session prompts — 2 columns */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col">
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Session Prompt</label>
                    <textarea
                      value={sessionPrompt}
                      onChange={(e) => setSessionPrompt(e.target.value)}
                      placeholder="System instructions prepended to every task for this project..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '80px' }}
                    />
                  </div>
                  <div className="flex flex-col">
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>OpenClaw Session Prompt</label>
                    <textarea
                      value={openclawPrompt}
                      onChange={(e) => setOpenclawPrompt(e.target.value)}
                      placeholder="Additional instructions included when running via OpenClaw..."
                      className={`${inputClass} resize-y flex-1`}
                      style={{ ...inputStyle, minHeight: '80px' }}
                    />
                  </div>
                </div>

                {/* Row 2: CLAUDE.md + AGENTS.md — side by side */}
                <div className="grid grid-cols-2 gap-4">
                  {/* CLAUDE.md */}
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                        <ClaudeIcon className="w-3 h-3" style={{ color: '#D97757' }} />
                        CLAUDE.md <span className="font-normal opacity-60">(Claude instructions)</span>
                        {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                      </label>
                      {projectPath && claudeMd && (
                        <button
                          type="button"
                          onClick={() => setClaudeMdPreview(true)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Preview rendered markdown"
                        >
                          <Eye className="w-3 h-3" />
                          Preview
                        </button>
                      )}
                    </div>
                    <textarea
                      value={claudeMd}
                      onChange={(e) => setClaudeMd(e.target.value)}
                      placeholder="Claude Code project instructions — file will be created on save"
                      className={`${inputClass} resize-y font-mono text-xs flex-1`}
                      style={{ ...inputStyle, minHeight: '220px' }}
                    />
                    {claudeMdPreview && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center p-8"
                        style={{ background: 'rgba(0,0,0,0.6)' }}
                        onClick={() => setClaudeMdPreview(false)}
                      >
                        <div
                          className="w-full rounded-xl border flex flex-col"
                          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', maxWidth: '900px', height: 'calc(100vh - 80px)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>CLAUDE.md Preview</span>
                            <button onClick={() => setClaudeMdPreview(false)} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 overflow-y-auto px-8 py-6">
                            <div className="markdown-preview" style={{ color: 'var(--text-primary)' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{claudeMd || '*No content*'}</ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* AGENTS.md */}
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                        <CodexIcon className="w-3 h-3" style={{ color: '#7A9DFF' }} />
                        AGENTS.md <span className="font-normal opacity-60">(Codex instructions)</span>
                        {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                      </label>
                      {projectPath && agentsMd && (
                        <button
                          type="button"
                          onClick={() => setAgentsMdPreview(true)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-white/10"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Preview rendered markdown"
                        >
                          <Eye className="w-3 h-3" />
                          Preview
                        </button>
                      )}
                    </div>
                    <textarea
                      value={agentsMd}
                      onChange={(e) => setAgentsMd(e.target.value)}
                      placeholder="Codex project instructions — file will be created on save"
                      className={`${inputClass} resize-y font-mono text-xs flex-1`}
                      style={{ ...inputStyle, minHeight: '220px' }}
                    />
                    {agentsMdPreview && (
                      <div
                        className="fixed inset-0 z-50 flex items-center justify-center p-8"
                        style={{ background: 'rgba(0,0,0,0.6)' }}
                        onClick={() => setAgentsMdPreview(false)}
                      >
                        <div
                          className="w-full rounded-xl border flex flex-col"
                          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', maxWidth: '900px', height: 'calc(100vh - 80px)' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>AGENTS.md Preview</span>
                            <button onClick={() => setAgentsMdPreview(false)} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex-1 overflow-y-auto px-8 py-6">
                            <div className="markdown-preview" style={{ color: 'var(--text-primary)' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{agentsMd || '*No content*'}</ReactMarkdown>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Row 3: .claude/settings.json — full width */}
                <div className="flex flex-col">
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    .claude/settings.json
                    {filesLoading && <Loader2 className="w-3 h-3 inline ml-1 animate-spin" />}
                  </label>
                  <textarea
                    value={settingsJson}
                    onChange={(e) => setSettingsJson(e.target.value)}
                    placeholder="File will be created on save"
                    className={`${inputClass} resize-y font-mono text-xs`}
                    style={{ ...inputStyle, minHeight: '180px' }}
                  />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSave}
                disabled={isPending || !name || (mode === 'add' && !path)}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                <Save className="w-4 h-4" />
                {isPending ? '保存中…' : mode === 'add' ? '新增项目' : '保存更改'}
              </button>
              <button
                onClick={onCancel}
                disabled={isPending || repoCreating}
                className="px-6 py-2.5 rounded-lg border text-sm font-medium"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                取消
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
    </Dialog>
  );
}

function GitInfoBadge({ projectPath }: { projectPath: string }) {
  const queryClient = useQueryClient();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<{ name: string; isRemote: boolean } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  // Position the portal dropdown under the button
  const updatePos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    updatePos();
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [dropdownOpen, updatePos]);

  const { data: gitStatus } = useQuery({
    queryKey: ['git-status', projectPath],
    queryFn: () => api.git.status(projectPath).catch(() => null),
    staleTime: 30_000,
    retry: false,
  });

  const { data: branchData } = useQuery({
    queryKey: ['git-branches', projectPath],
    queryFn: () => api.git.branches(projectPath),
    enabled: dropdownOpen && gitStatus !== null,
    staleTime: 10_000,
  });

  // gitStatus is null = not a git repo, undefined = still loading
  if (gitStatus === undefined) return null;

  if (gitStatus === null) {
    return (
      <>
        <button
          onClick={() => setCreateRepoOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] w-full"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
        >
          <Github className="w-3 h-3 shrink-0" style={{ opacity: 0.5 }} />
          <span className="truncate">No git repo</span>
          <Plus className="w-3 h-3 ml-auto shrink-0" style={{ opacity: 0.7 }} />
        </button>
        {createRepoOpen && (
          <CreateRepoModal
            projectPath={projectPath}
            onClose={() => setCreateRepoOpen(false)}
            onCreated={() => {
              setCreateRepoOpen(false);
              queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
            }}
          />
        )}
      </>
    );
  }

  const remoteUrl = gitStatus.remoteUrl;
  const repoParts = remoteUrl
    ? remoteUrl.replace(/.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, '$1').split('/')
    : null;
  const owner = repoParts?.[0] || null;
  const repo = repoParts?.[1] || null;

  const localBranches = (branchData?.branches || []).filter(b => !b.remote && b.name !== gitStatus.branch);
  const remoteBranches = (branchData?.branches || []).filter(b => b.remote && b.name !== `origin/${gitStatus.branch}`);

  return (
    <>
      <TableActionButton ref={buttonRef} onClick={() => setDropdownOpen(!dropdownOpen)}  title={`${owner ? `${owner}/${repo} · ` : ''}${gitStatus.branch}`}>
        <GitBranch className="h-3 w-3 shrink-0" style={{ color: 'var(--success)' }} />
        <span className="truncate">{gitStatus.branch}</span><ChevronDown className="ml-auto h-3 w-3 shrink-0" />
      </TableActionButton>

      {/* Portal dropdown for branch switching */}
      {dropdownOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed rounded-lg border shadow-xl overflow-hidden"
          style={{
            background: 'var(--bg-primary)',
            borderColor: 'var(--border)',
            maxHeight: '280px',
            overflowY: 'auto',
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: Math.max(dropdownPos.width, 220),
            zIndex: 9999,
          }}
        >
          {/* Current branch */}
          <div className="px-3 py-1.5 text-[10px] font-semibold" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
            Current: {gitStatus.branch}
          </div>

          {!branchData ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--text-secondary)' }} />
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[9px] font-semibold uppercase" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                    Local
                  </div>
                  {localBranches.map(b => (
                    <button
                      key={b.name}
                      onClick={() => { setSwitchTarget({ name: b.name, isRemote: false }); setDropdownOpen(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <GitBranch className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                      <span className="truncate">{b.name}</span>
                    </button>
                  ))}
                </>
              )}
              {remoteBranches.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[9px] font-semibold uppercase" style={{ color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                    Remote
                  </div>
                  {remoteBranches.map(b => (
                    <button
                      key={b.name}
                      onClick={() => { setSwitchTarget({ name: b.name, isRemote: true }); setDropdownOpen(false); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <GitBranch className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                      <span className="truncate">{b.name}</span>
                    </button>
                  ))}
                </>
              )}
              {localBranches.length === 0 && remoteBranches.length === 0 && (
                <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  No other branches
                </div>
              )}
            </>
          )}

          {!remoteUrl && (
            <>
              <div style={{ borderTop: '1px solid var(--border)' }} />
              <button
                onClick={() => { setCreateRepoOpen(true); setDropdownOpen(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full text-left hover:bg-white/5"
                style={{ color: 'var(--accent)' }}
              >
                <Github className="w-3 h-3 shrink-0" />
                <span>Create GitHub repo</span>
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Branch switch confirmation */}
      {switchTarget && (
        <ConfirmModal
          title="Switch Branch"
          message={`Switch to branch "${switchTarget.name}"? Make sure you have no uncommitted changes that could be lost.`}
          confirmLabel={switching ? 'Switching...' : 'Switch'}
          variant="warning"
          onConfirm={async () => {
            setSwitching(true);
            try {
              await api.git.checkout(projectPath, switchTarget.name, switchTarget.isRemote);
              queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
              queryClient.invalidateQueries({ queryKey: ['git-branches', projectPath] });
            } catch (err: unknown) {
              alert('Branch switch failed: ' + errorMessage(err, 'Unknown error'));
            } finally {
              setSwitching(false);
              setSwitchTarget(null);
            }
          }}
          onCancel={() => setSwitchTarget(null)}
        />
      )}

      {/* Create repo modal (for local-only repos) */}
      {createRepoOpen && (
        <CreateRepoModal
          projectPath={projectPath}
          onClose={() => setCreateRepoOpen(false)}
          onCreated={() => {
            setCreateRepoOpen(false);
            queryClient.invalidateQueries({ queryKey: ['git-status', projectPath] });
          }}
        />
      )}
    </>
  );
}

function CreateRepoModal({ projectPath, onClose, onCreated }: {
  projectPath: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [repoName, setRepoName] = useState(projectPath.split('/').pop() || '');
  const [isPrivate, setIsPrivate] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [selectedOwner, setSelectedOwner] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: accountsData } = useQuery({
    queryKey: ['gh-accounts'],
    queryFn: () => api.git.ghAccounts(),
  });

  const accounts = useMemo(() => accountsData?.accounts ?? [], [accountsData?.accounts]);

  // Auto-select first account
  useEffect(() => {
    if (accounts.length > 0 && !selectedOwner) setSelectedOwner(accounts[0]);
  }, [accounts, selectedOwner]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleCreate = async () => {
    if (!repoName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.git.createRepo({
        path: projectPath,
        name: repoName.trim(),
        owner: selectedOwner || undefined,
        private: isPrivate,
        defaultBranch: defaultBranch.trim() || 'main',
      });
      onCreated();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to create repository'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{ width: '100%', maxWidth: '420px', background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-2">
          <div className="flex items-center justify-center w-9 h-9 rounded-full shrink-0" style={{ background: '#3b82f620' }}>
            <Github className="w-5 h-5" style={{ color: '#3b82f6' }} />
          </div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Create GitHub Repository</h3>
        </div>

        <div className="px-5 py-3 flex flex-col gap-3">
          {/* Owner */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Account</label>
            {accounts.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                No GitHub accounts found. Run <code className="px-1 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-tertiary)' }}>gh auth login</code> first.
              </p>
            ) : (
              <select
                value={selectedOwner}
                onChange={(e) => setSelectedOwner(e.target.value)}
                className="w-full px-2 py-1.5 rounded text-xs"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                {accounts.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
          </div>

          {/* Repo name */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Repository Name</label>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>

          {/* Branch name */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Default Branch</label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>

          {/* Visibility */}
          <div>
            <label className="text-[10px] font-semibold uppercase mb-1 block" style={{ color: 'var(--text-secondary)' }}>Visibility</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPrivate(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium flex-1 justify-center"
                style={{
                  background: isPrivate ? '#f59e0b22' : 'var(--bg-tertiary)',
                  color: isPrivate ? '#f59e0b' : 'var(--text-secondary)',
                  border: `1px solid ${isPrivate ? '#f59e0b44' : 'var(--border)'}`,
                }}
              >
                <Lock className="w-3 h-3" /> Private
              </button>
              <button
                onClick={() => setIsPrivate(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium flex-1 justify-center"
                style={{
                  background: !isPrivate ? '#22c55e22' : 'var(--bg-tertiary)',
                  color: !isPrivate ? '#22c55e' : 'var(--text-secondary)',
                  border: `1px solid ${!isPrivate ? '#22c55e44' : 'var(--border)'}`,
                }}
              >
                <Globe className="w-3 h-3" /> Public
              </button>
            </div>
          </div>

          {error && (
            <p className="text-xs px-2 py-1.5 rounded" style={{ background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444' }}>
              {error}
            </p>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !repoName.trim() || accounts.length === 0}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: creating ? '#3b82f680' : '#3b82f6', color: '#fff', border: 'none', opacity: (!repoName.trim() || accounts.length === 0) ? 0.5 : 1 }}
          >
            {creating ? 'Creating...' : 'Create Repository'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectDashboard({ onOpenProject, onOpenSession, projectOrder, onProjectOrderChange }: ProjectDashboardProps) {
  const [view, setView] = useState<ViewState>({ mode: 'list' });
  const queryClient = useQueryClient();
  const { data: authStatus } = useQuery({ queryKey: ['auth-status'], queryFn: () => api.auth.status(), staleTime: 60_000 });
  const isAdmin = authStatus?.user?.role === 'admin';
  const permissionsQuery = usePermissions();
  const canCreateProjects = hasPermission(permissionsQuery.data, 'projects_create', 'write');

  // Listen for open-project events from the form's create success handler
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id && detail?.name) onOpenProject(detail.id, detail.name);
    };
    window.addEventListener('agentmanager:open-project', handler);
    return () => window.removeEventListener('agentmanager:open-project', handler);
  }, [onOpenProject]);

  // Listen for "add project" requests (from the project-tab "+" button)
  useEffect(() => {
    const handler = () => { if (canCreateProjects) setView({ mode: 'add' }); };
    window.addEventListener('agentmanager:add-project', handler);
    return () => window.removeEventListener('agentmanager:add-project', handler);
  }, [canCreateProjects]);

  const { data: projectsData, isLoading: loadingProjects, error: projectsError } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  const allProjects = useMemo(() => projectsData?.projects ?? [], [projectsData?.projects]);
  const [searchQuery, setSearchQuery] = useState('');
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDropTargetId, setProjectDropTargetId] = useState<string | null>(null);
  const orderedProjects = useMemo(
    () => orderItemsByKeys(allProjects, projectOrder, (project) => project.id),
    [allProjects, projectOrder],
  );


  const projects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return orderedProjects;
    return orderedProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.owner && `${p.owner.username} ${p.owner.display_name}`.toLowerCase().includes(q))
    );
  }, [orderedProjects, searchQuery]);
  // Statusline prompt — ask once if user wants to install custom status bar
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 60_000,
  });
  const [statuslinePromptDismissed, setStatuslinePromptDismissed] = useState(false);
  const showStatuslinePrompt = !statuslinePromptDismissed
    && isAdmin
    && settingsData?.settings?.statusline_prompted === 'false';

  // Sessions — driven by WebSocket invalidation, no polling needed
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });

  const activeSessionsByProject = useMemo(() => {
    const map: Record<string, { session: number; terminal: number; total: number }> = {};
    for (const s of sessionsData?.sessions || []) {
      if (s.project_id && ['running', 'detached', 'pending', 'launching', 'released'].includes(s.status)) {
        if (!map[s.project_id]) map[s.project_id] = { session: 0, terminal: 0, total: 0 };
        const entry = map[s.project_id];
        entry.total++;
        if (s.task === 'Terminal') entry.terminal++;
        else entry.session++;
      }
    }
    return map;
  }, [sessionsData]);

  const gitQueries = useQueries({ queries: allProjects.map((project) => ({
    queryKey: ['git-status', project.path], queryFn: () => api.git.status(project.path).catch(() => null),
    enabled: projectOpenModes(project).length > 0, staleTime: 30_000, retry: false,
  })) });
  const gitById = new Map(allProjects.map((project, index) => [project.id, gitQueries[index]?.data]));
  const projectTable = useTableModel(projects, [
    { key: 'name', title: '项目', value: (project) => `${project.name} ${project.description ?? ''}`.trim() },
    { key: 'owner', title: '所属用户', value: (project) => project.owner ? `${project.owner.display_name || project.owner.username} @${project.owner.username}` : '未分配' },
    { key: 'path', title: '路径', value: (project) => project.path },
    { key: 'git', title: 'Git', value: (project) => projectOpenModes(project).length === 0 ? '未授权'
      : gitById.get(project.id) === null ? '无 Git 仓库' : gitById.get(project.id) ? `${gitById.get(project.id)?.branch ?? ''} ${gitById.get(project.id)?.remoteUrl ?? 'local only'}` : null },
    { key: 'sessions', title: '活动会话', value: (project) => activeSessionsByProject[project.id]?.total ?? 0 },
  ]);
  const canReorderProjects = !searchQuery.trim() && !projectTable.active;
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [openProject, setOpenProject] = useState<Project | null>(null);
  const closeOpenProject = useCallback(() => setOpenProject(null), []);

  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err: Error) => {
      console.error('Failed to delete project:', err.message);
      alert(`Failed to remove project: ${err.message}`);
    },
  });

  return (
    <div className="h-full flex flex-col">
      <div className="w-full flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {/* Sticky Header */}
        <div className="page-content sticky top-0 z-10 py-3" style={{ background: 'var(--bg-primary)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                项目
              </h2>
              <button
                onClick={() => {
                  setRefreshing(true);
                  Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['projects'] }),
                    queryClient.invalidateQueries({ queryKey: ['sessions'] }),
                    queryClient.invalidateQueries({ queryKey: ['project-sessions'] }),
                    queryClient.invalidateQueries({ queryKey: ['git-status'] }),
                  ]).finally(() => {
                    setLastRefreshed(new Date());
                    setRefreshing(false);
                  });
                }}
                title="Refresh project data"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'transparent' }}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </button>
            </div>
            {canCreateProjects && <button
              onClick={() => setView({ mode: 'add' })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Plus className="w-4 h-4" />
              新增项目
            </button>}
          </div>
          {/* Search / filter bar */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="筛选项目..."
              className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border)')}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
                style={{ color: 'var(--text-secondary)' }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Project table */}
        <div className="pb-6">
        <div className="page-content">
          <div className="space-y-2">
            {projectTable.active && <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span>{projectTable.rows.length} / {projects.length} 个项目</span><TableActionButton  onClick={projectTable.reset}>清除排序和筛选</TableActionButton>
            </div>}
            <DataTable label="项目列表" model={projectTable} minWidth={1100} expandable actions columnWidths={['w-56', 'w-40', '', 'w-56', 'w-32']}
              loading={loadingProjects} error={projectsError?.message} onRetry={() => { void queryClient.invalidateQueries({ queryKey: ['projects'] }); }}
              empty={projectTable.rows.length === 0} emptyMessage={searchQuery || projectTable.active ? '没有匹配的项目' : canCreateProjects ? '暂无项目，添加项目目录后即可开始。' : '你目前没有被分配任何项目，请联系管理员。'}>{projectTable.rows.map((project) => {
                  const expanded = expandedProjects.has(project.id);
                  return <Fragment key={project.id}><tr data-project-id={project.id}
                    style={{ opacity: draggingProjectId === project.id ? .65 : 1, outline: projectDropTargetId === project.id ? '1px solid var(--accent)' : undefined }}
                    onDragOver={(event) => { if (canReorderProjects && draggingProjectId && draggingProjectId !== project.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setProjectDropTargetId(project.id); } }}
                    onDrop={(event) => { event.preventDefault(); if (canReorderProjects && draggingProjectId && draggingProjectId !== project.id) onProjectOrderChange(moveItemByKey(orderedProjects, draggingProjectId, project.id, (item) => item.id).map((item) => item.id)); setDraggingProjectId(null); setProjectDropTargetId(null); }}>
                    <td><TableExpandButton expanded={expanded} label={`项目 ${project.name} 的会话`} onClick={() => setExpandedProjects((current) => { const next = new Set(current); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; })} /></td>
                    <td><div className="flex items-center gap-2">
                      {canReorderProjects && <span draggable title="拖动调整项目顺序" aria-label={`拖动 ${project.name} 排序`} className="cursor-grab"
                        onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', project.id); setDraggingProjectId(project.id); }}
                        onDragEnd={() => { setDraggingProjectId(null); setProjectDropTargetId(null); }}><GripVertical className="h-3 w-3" /></span>}
                      <button className="flex max-w-52 items-center gap-2 text-left font-medium" onClick={() => onOpenProject(project.id, project.name)}><Folder className="h-3.5 w-3.5 shrink-0" style={{ color: project.color || 'var(--accent)' }} /><span className="truncate">{project.name}</span></button>
                    </div>{project.description && <div className="mt-1 max-w-56 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }} title={project.description}>{project.description}</div>}</td>
                    <td className="whitespace-nowrap">{project.owner ? <><span>{project.owner.display_name || project.owner.username}</span><span className="ml-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>@{project.owner.username}</span></> : '未分配'}</td>
                    <td><div className="max-w-96 truncate" title={project.path}>{project.path}</div></td>
                    <td className="w-56">{projectOpenModes(project).length ? <GitInfoBadge projectPath={project.path} /> : '未授权'}</td>
                    <td>{activeSessionsByProject[project.id]?.total ?? 0}</td>
                    <td><TableActions>
                      <TableActionButton  aria-label={`打开项目 ${project.name}`} disabled={projectOpenModes(project).length === 0} onClick={() => { setOpenProject(project); }}>打开</TableActionButton>
                      <RowActionsMenu label={`${project.name} 的更多操作`} actions={[
                        ...((isAdmin || (!!authStatus?.user?.id && project.owner_id === authStatus.user.id)) ? [
                          { label: '编辑项目', icon: <Pencil className="h-3.5 w-3.5" />, onClick: () => setView({ mode: 'edit', project }) },
                          { label: '移除项目', icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setConfirmDeleteId(project.id) },
                        ] : []),
                      ]} />
                    </TableActions></td>
                  </tr>{expanded && <TableDetailRow columnCount={7}><ProjectSessionTable projectId={project.id}
                    onOpen={(sessionId) => { if (onOpenSession) onOpenSession(project.id, sessionId); else onOpenProject(project.id, project.name); }} /></TableDetailRow>}</Fragment>;
                })}
                </DataTable>
          </div>

        </div>
        </div>
      </div>

      {(view.mode === 'edit' || (view.mode === 'add' && canCreateProjects)) && <ProjectForm
        key={view.mode === 'edit' ? view.project.id : 'add'} mode={view.mode}
        project={view.mode === 'edit' ? view.project : undefined}
        onSubmit={() => setView({ mode: 'list' })} onCancel={() => setView({ mode: 'list' })} />}

      {openProject && <ProjectSessionCreateDialog key={openProject.id} project={allProjects.find((project) => project.id === openProject.id) ?? openProject}
        onClose={closeOpenProject} onSessionCreated={(session) => {
          if (onOpenSession) onOpenSession(openProject.id, session.id);
          else onOpenProject(openProject.id, openProject.name);
        }} />}

      {confirmDeleteId && (
        <ConfirmModal
          title="Remove Project"
          message="This will remove the project from the dashboard. Project files on disk will not be deleted."
          confirmLabel="Remove"
          variant="danger"
          onConfirm={() => {
            deleteProjectMutation.mutate(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {isAdmin && showStatuslinePrompt && (
        <StatuslinePromptModal
          onClose={() => setStatuslinePromptDismissed(true)}
        />
      )}

    </div>
  );
}
