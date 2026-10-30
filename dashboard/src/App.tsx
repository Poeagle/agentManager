import { lazy, Suspense, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { connectStream, useStreamStore, setQueryClient } from './lib/websocket';
import { api, type AuthUser } from './lib/api';
import { AuthGate } from './components/AuthGate';
import { cleanupProjectStorage } from './lib/project-view-storage';
import { confirmDiscardProject } from './lib/unsaved-files';
import { X, LayoutGrid, Settings, ArrowUpCircle, LogOut, KeyRound, Plus, Bot } from 'lucide-react';
import { hasPermission, usePermissions } from './lib/permissions';
import type { PlatformSection } from './components/PlatformCenter';
import { CloseTabModal } from './components/CloseTabModal';
import { applyTheme } from './lib/themes';
import { ProjectRollupDot } from './lib/session-signal';
import { ProjectTabLabel } from './lib/session-activity';
import './workspace-chrome.css';
import { ExportTransferOverlay } from './components/ExportTransferOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CodexQuotaIndicator } from './components/CodexQuotaIndicator';
import { ServerResourceIndicator } from './components/ServerResourceIndicator';
import { moveItemByKey, orderItemsByKeys } from './lib/reorder';

const PlatformCenter = lazy(() => import('./components/PlatformCenter').then((module) => ({ default: module.PlatformCenter })));
const ProjectView = lazy(() => import('./components/ProjectView').then((module) => ({ default: module.ProjectView })));
const ProjectDashboard = lazy(() => import('./components/ProjectDashboard').then((module) => ({ default: module.ProjectDashboard })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Disable refetch-on-focus: the burst of simultaneous API calls when
      // returning from another browser tab blocks the main thread and makes
      // the terminal unresponsive for several seconds.  We already use
      // refetchInterval and WebSocket-driven invalidation for freshness.
      refetchOnWindowFocus: false,
    },
  },
});
interface ProjectTab {
  projectId: string;
  projectName: string;
  /** User-set tab label. Falls back to projectName when empty. */
  customName?: string;
}

const ACTIVE_SESSION_STATUSES = new Set(['pending', 'launching', 'running', 'detached', 'released']);

function isActiveSessionStatus(status: string): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

const APP_STATE_KEY_PREFIX = 'agentmanager-app-state-v2';
const appStateKey = (userId: string) => `${APP_STATE_KEY_PREFIX}:${userId}`;

function normalizeOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((id): id is string => {
    if (typeof id !== 'string' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function loadAppState(userId: string): { activeTab: string; projectTabs: ProjectTab[]; projectOrder?: string[] } | null {
  try {
    const raw = localStorage.getItem(appStateKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activeTab === 'string' && Array.isArray(parsed.projectTabs)) {
      return parsed;
    }
  } catch { /* corrupt or unavailable local storage */ }
  return null;
}

function saveAppState(userId: string, activeTab: string, projectTabs: ProjectTab[], projectOrder: string[]) {
  try {
    localStorage.setItem(appStateKey(userId), JSON.stringify({ activeTab, projectTabs, projectOrder }));
  } catch { /* storage quota or privacy mode */ }
}

function Dashboard({ authUser, onLogout }: { authUser: AuthUser; onLogout: () => void }) {
  const connected = useStreamStore((s) => s.connected);
  const [savedState] = useState(() => loadAppState(authUser.id));
  // 'skills' was a removed top-level tab (skills are now per-project); fall back to home.
  const [activeTabState, setActiveTab] = useState<string>(() => {
    const t = savedState?.activeTab ?? 'home';
    return t === 'skills' ? 'home' : t;
  });
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  // Stable so memo(ProjectView) isn't busted by a new function identity each render.
  const handleFocusSessionHandled = useCallback(() => setFocusSessionId(null), []);
  // Inline tab-rename: which tab is being renamed + its draft text.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  // Set when Escape cancels editing, so the input's onBlur doesn't also commit.
  const skipTabBlurCommitRef = useRef(false);
  // State (rather than a ref) guarantees the first complete post-hydration
  // snapshot is written even when nothing else changes afterward.
  const [serverHydrated, setServerHydrated] = useState(false);
  const [projectTabsState, setProjectTabs] = useState<ProjectTab[]>(() => {
    const tabs = savedState?.projectTabs ?? [];
    // Deduplicate by projectId
    const seen = new Set<string>();
    return tabs.filter((t) => {
      if (seen.has(t.projectId)) return false;
      seen.add(t.projectId);
      return true;
    });
  });
  const [projectOrder, setProjectOrder] = useState<string[]>(() => normalizeOrder(savedState?.projectOrder));
  const initialAppStateRef = useRef({ activeTab: activeTabState, projectTabs: projectTabsState, projectOrder });
  const [draggingProjectTabId, setDraggingProjectTabId] = useState<string | null>(null);
  const [projectTabDropTargetId, setProjectTabDropTargetId] = useState<string | null>(null);

  // Apply saved app font size on load
  const { data: appSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  useEffect(() => {
    const size = appSettings?.settings?.app_font_size;
    if (size) {
      document.documentElement.style.setProperty('--app-font-size', `${size}px`);
    }
    // Apply the saved UI theme (falls back to the default for unknown/empty)
    applyTheme(appSettings?.settings?.app_theme);
  }, [appSettings]);

  const queryClient = useQueryClient();

  const { data: projectsData, isSuccess: projectsLoaded } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  // Lifecycle events invalidate sessions. Codex native logs can advance while
  // the terminal stays quiet, so read their cached runtime snapshots every 5s.
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
    refetchInterval: (query) => query.state.data?.sessions.some((session) => session.cli_type === 'codex') ? 5000 : 60_000,
  });


  // Version check — poll every 30 minutes
  const { data: versionData } = useQuery({
    queryKey: ['version-check'],
    queryFn: () => api.versionCheck(),
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const projects = useMemo(() => projectsData?.projects ?? [], [projectsData]);
  const sessions = useMemo(() => sessionsData?.sessions ?? [], [sessionsData]);
  const allowedProjectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);
  const projectTabs = useMemo(
    () => projectsLoaded ? projectTabsState.filter((tab) => allowedProjectIds.has(tab.projectId)) : projectTabsState,
    [allowedProjectIds, projectTabsState, projectsLoaded],
  );
  // Tab order is user-controlled, but mounted project views may contain live
  // WebGL terminal canvases. Keep their DOM order stable so reordering a tab
  // never detaches and reinserts the underlying terminal page.
  const [projectMountOrder, setProjectMountOrder] = useState(() =>
    projectTabsState.map((tab) => tab.projectId),
  );
  useEffect(() => {
    // Project tabs can hydrate or close outside the drag handlers; preserve mounted terminal DOM order.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjectMountOrder((current) => {
      const next = orderItemsByKeys(projectTabs, current, (tab) => tab.projectId)
        .map((tab) => tab.projectId);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [projectTabs]);
  const mountedProjectTabs = useMemo(
    () => orderItemsByKeys(projectTabs, projectMountOrder, (tab) => tab.projectId),
    [projectMountOrder, projectTabs],
  );
  const activeTab = !projectsLoaded
    || activeTabState === 'home'
    || allowedProjectIds.has(activeTabState.replace(/^project-/, ''))
    ? activeTabState
    : 'home';

  // Copy update command to clipboard and show brief confirmation.
  const [updateCopied, setUpdateCopied] = useState(false);
  const triggerUpdate = useCallback(async () => {
    const cmd = 'npx -y agentmanager@latest';
    try {
      await navigator.clipboard.writeText(cmd);
      setUpdateCopied(true);
      setTimeout(() => setUpdateCopied(false), 4000);
    } catch {
      // Fallback: select from prompt
      window.prompt('Copy this command and run it in your terminal:', cmd);
    }
  }, []);

  const [platformSection, setPlatformSection] = useState<PlatformSection | null>(null);
  const permissionsQuery = usePermissions();
  const showPlatformCenter = platformSection !== null;
  const closePlatformCenter = useCallback(() => {
    setPlatformSection(null);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, []);

  useEffect(() => {
    setQueryClient(queryClient);
    connectStream();
  }, [queryClient]);

  // Persist app state to localStorage (instant-paint cache + offline fallback).
  useEffect(() => {
    saveAppState(authUser.id, activeTab, projectTabs, projectOrder);
  }, [authUser.id, activeTab, projectTabs, projectOrder]);

  // ── Cross-device sync: pull the open project tabs and active project. This
  // server-side copy is the durable fallback when browser storage is lost.
  useEffect(() => {
    let cancelled = false;
    api.userState.getAll()
      .then(({ state }) => {
        if (cancelled) return;
        const serverApp = state?.app as { projectTabs?: ProjectTab[]; activeTab?: string; projectOrder?: string[] } | undefined;
        const tabs = serverApp?.projectTabs;
        if (Array.isArray(tabs)) {
          const seen = new Set<string>();
          const deduped = tabs.filter((t) => {
            if (!t || typeof t.projectId !== 'string' || seen.has(t.projectId)) return false;
            seen.add(t.projectId);
            return true;
          });
          setProjectTabs(deduped);
          setProjectOrder(normalizeOrder(serverApp?.projectOrder));
          const serverActive = serverApp?.activeTab;
          if (
            serverActive === 'home'
            || (typeof serverActive === 'string' && deduped.some((t) => `project-${t.projectId}` === serverActive))
          ) {
            setActiveTab(serverActive);
          } else {
            // If neither server nor local selection points at an open tab,
            // recover safely to Home.
            setActiveTab((cur) =>
              cur !== 'home' && !deduped.some((t) => `project-${t.projectId}` === cur) ? 'home' : cur,
            );
          }
        } else {
          // First run for this user: seed the server from whatever we have locally.
          api.userState.set('app', initialAppStateRef.current).catch(() => {});
        }
      })
      .catch(() => { /* offline / unauthenticated: keep using localStorage */ })
      .finally(() => { if (!cancelled) setServerHydrated(true); });
    return () => { cancelled = true; };
  }, [authUser.id]);

  // Debounced write-back of the shared tab set to the server (after hydration).
  useEffect(() => {
    if (!serverHydrated) return;
    const h = setTimeout(() => {
      api.userState.set('app', { projectTabs, activeTab, projectOrder }).catch(() => {});
    }, 500);
    return () => clearTimeout(h);
  }, [serverHydrated, projectTabs, activeTab, projectOrder]);

  const reorderProjectTabs = useCallback((targetProjectId: string) => {
    if (!draggingProjectTabId || draggingProjectTabId === targetProjectId) return;
    setProjectTabs((current) => moveItemByKey(
      current,
      draggingProjectTabId,
      targetProjectId,
      (tab) => tab.projectId,
    ));
  }, [draggingProjectTabId]);

  const handleOpenProject = useCallback((
    projectId: string,
    projectName: string,
    quickLaunch?: 'session' | 'terminal',
    cliType?: 'claude' | 'codex',
  ) => {
    setPlatformSection(null);
    if (quickLaunch) {
      const access = projects.find((project) => project.id === projectId)?.tool_access;
      const modeAllowed = !access || (quickLaunch === 'terminal' ? access.can_terminal : access.can_session);
      const cliAllowed = quickLaunch === 'terminal' || !access || access.session_clients.includes(cliType ?? 'claude');
      if (!modeAllowed || !cliAllowed) return;
    }
    setProjectTabs((prev) => prev.some((tab) => tab.projectId === projectId)
      ? prev
      : [...prev, { projectId, projectName }]);
    setActiveTab(`project-${projectId}`);
    if (quickLaunch) {
      const suffix = cliType && cliType !== 'claude' ? `_${cliType}` : '';
      setFocusSessionId(`__voice_create_${quickLaunch}${suffix}`);
    }
  }, [projects]);

  const [confirmClose, setConfirmClose] = useState<{ projectId: string; count: number } | null>(null);

  const closeProjectTab = useCallback(async (projectId: string) => {
    // Fetch fresh session list — cached data may be stale (e.g. right after quick-launch)
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && isActiveSessionStatus(s.status)
    );
    try {
      const fresh = await api.sessions.list();
      runningSessions = (fresh.sessions || []).filter(
        (s) => s.project_id === projectId && isActiveSessionStatus(s.status)
      );
    } catch { /* cached sessions remain the fallback */ }

    if (runningSessions.length > 0) {
      setConfirmClose({ projectId, count: runningSessions.length });
      return;
    }

    const projectPath = projects.find((project) => project.id === projectId)?.path;
    if (projectPath && !confirmDiscardProject(projectPath)) return;

    cleanupProjectStorage(authUser.id, projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) {
      setActiveTab('home');
    }
  }, [activeTab, authUser.id, projects, sessions]);

  // ── Inline tab rename ──────────────────────────────────────────────
  const beginTabRename = useCallback((tab: ProjectTab) => {
    setEditingTabId(tab.projectId);
    setEditingTabValue(tab.customName?.trim() || tab.projectName);
  }, []);

  const commitTabRename = useCallback((projectId: string) => {
    setProjectTabs((prev) =>
      prev.map((t) =>
        t.projectId === projectId
          ? { ...t, customName: editingTabValue.trim() || undefined }
          : t,
      ),
    );
    setEditingTabId(null);
    setEditingTabValue('');
  }, [editingTabValue]);

  const cancelTabRename = useCallback(() => {
    setEditingTabId(null);
    setEditingTabValue('');
  }, []);

  async function confirmCloseProject() {
    if (!confirmClose) return;
    const { projectId } = confirmClose;
    const projectPath = projects.find((project) => project.id === projectId)?.path;
    if (projectPath && !confirmDiscardProject(projectPath)) return;

    // Fetch fresh state and stop every process-bearing session before unmounting
    // the project. A failed stop leaves the tab open and visible.
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && isActiveSessionStatus(s.status)
    );
    try {
      const fresh = await api.sessions.list();
      const freshRunning = (fresh.sessions || []).filter(
        (s) => s.project_id === projectId && isActiveSessionStatus(s.status)
      );
      runningSessions = freshRunning;
    } catch { /* cached sessions remain the fallback */ }

    try {
      await Promise.all(runningSessions.map((s) => api.sessions.kill(s.id)));
    } catch {
      window.alert('One or more sessions could not be stopped. The project tab was kept open.');
      return;
    }
    cleanupProjectStorage(authUser.id, projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) setActiveTab('home');
    setConfirmClose(null);
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <header
        className="workspace-header flex items-center justify-between border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div className="flex shrink-0 items-center gap-2">
          <h1 className="workspace-brand font-bold">
            <span style={{ color: '#ef4444' }}>Agent</span><span style={{ color: 'var(--text-primary)' }}>Manager</span>
          </h1>
        </div>
        <div className="workspace-header-tools flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0">
          <CodexQuotaIndicator />
          {hasPermission(permissionsQuery.data, 'monitor') && <ServerResourceIndicator />}
          {hasPermission(permissionsQuery.data, 'agent_api') && <button
            onClick={() => setPlatformSection('assistant')}
            className="workspace-header-button border"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
            title="平台 AI"
            aria-label="平台 AI"
          ><Bot className="h-3.5 w-3.5" /><span className="hidden sm:inline">平台 AI</span></button>}
          <button
            onClick={() => setPlatformSection(hasPermission(permissionsQuery.data, 'monitor') ? 'monitor' : 'account')}
            className="workspace-header-button border font-medium hover:opacity-80"
            style={{ borderColor: 'var(--border)', color: showPlatformCenter ? 'var(--accent)' : 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
            title="平台管理"
            aria-label="平台管理"
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">平台管理</span>
          </button>
          <div className="workspace-connection" role="status" aria-label={connected ? 'Connected' : 'Disconnected'} title={connected ? 'Connected · 实时连接正常' : 'Disconnected · 实时连接已断开，正在重连'}>
            <div
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: connected ? 'var(--success)' : 'var(--error)' }}
            />
            {!connected && <span style={{ color: 'var(--error)' }}>连接已断开</span>}
          </div>
          <div className="workspace-account pl-1" style={{ borderLeft: '1px solid var(--border)' }}>
            <button
              onClick={() => setPlatformSection('account')}
              className="workspace-header-button font-medium transition-colors hover:opacity-80"
              style={{ color: 'var(--text-secondary)' }}
              title="我的账户"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span className="workspace-account-name">{authUser.display_name || authUser.username}</span>
            </button>
            <button
              onClick={onLogout}
              className="workspace-header-button transition-colors hover:opacity-80"
              style={{ color: 'var(--text-secondary)', background: 'transparent' }}
              title="登出"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Update available banner */}
      {versionData?.updateAvailable && !updateDismissed && (
        <div
          className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
          style={{ background: 'rgba(96, 165, 250, 0.1)', borderBottom: '1px solid rgba(96, 165, 250, 0.2)' }}
        >
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="w-3.5 h-3.5 shrink-0" style={{ color: '#60a5fa' }} />
            <span style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>AgentManager v{versionData.latest}</strong>
              {versionData.prerelease && <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(250, 204, 21, 0.15)', color: '#facc15' }}>pre-release</span>}
              {' '}is available
              {versionData.name && <span> &mdash; {versionData.name}</span>}
            </span>
            <button
              onClick={() => triggerUpdate()}
              className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors hover:brightness-110"
              style={{ background: 'rgba(96, 165, 250, 0.2)', color: '#60a5fa' }}
            >
              {updateCopied ? 'Copied — paste in terminal!' : 'Copy Update Command'}
            </button>
            {versionData.url && (
              <a
                href={versionData.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-0.5 rounded text-[10px] font-medium"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}
              >
                Release Notes
              </a>
            )}
          </div>
          <button
            onClick={() => setUpdateDismissed(true)}
            className="p-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Tab bar */}
      <nav
        aria-label="项目标签"
        className="workspace-tab-strip border-b shrink-0 overflow-x-auto"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        {/* Home tab */}
        <button
          onClick={() => { setActiveTab('home'); setPlatformSection(null); }}
          className="workspace-tab-button workspace-tab-standalone rounded shrink-0"
          style={{
            background: activeTab === 'home' ? 'var(--bg-tertiary)' : 'transparent',
            color: activeTab === 'home' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Projects
        </button>

        {/* Divider */}
        {projectTabs.length > 0 && (
          <div
            className="w-px h-5 mx-1 shrink-0"
            style={{ background: 'var(--border)' }}
          />
        )}

        {/* Project tabs */}
        {projectTabs.map((tab) => {
          const tabId = `project-${tab.projectId}`;
          const isActive = activeTab === tabId;
          const tabSessions = sessions.filter((session) => session.project_id === tab.projectId);
          const project = projects.find((candidate) => candidate.id === tab.projectId);

          return (
            <div
              key={tab.projectId}
              draggable={editingTabId !== tab.projectId}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.projectId);
                setDraggingProjectTabId(tab.projectId);
              }}
              onDragEnd={() => {
                setDraggingProjectTabId(null);
                setProjectTabDropTargetId(null);
              }}
              className="workspace-tab group touch-none"
              data-active={isActive}
              onDragOver={(event) => {
                if (!draggingProjectTabId || draggingProjectTabId === tab.projectId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setProjectTabDropTargetId(tab.projectId);
              }}
              onDrop={(event) => {
                event.preventDefault();
                reorderProjectTabs(tab.projectId);
                setDraggingProjectTabId(null);
                setProjectTabDropTargetId(null);
              }}
              style={{
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                outline: projectTabDropTargetId === tab.projectId ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              <ProjectRollupDot
                sessions={tabSessions}
                active={isActive}
                size={6}
              />
              {editingTabId === tab.projectId ? (
                <div className="workspace-tab-button">
                  <input
                    autoFocus
                    value={editingTabValue}
                    onChange={(e) => setEditingTabValue(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => {
                      if (skipTabBlurCommitRef.current) { skipTabBlurCommitRef.current = false; return; }
                      commitTabRename(tab.projectId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                      else if (e.key === 'Escape') { e.preventDefault(); skipTabBlurCommitRef.current = true; cancelTabRename(); }
                    }}
                    className="bg-transparent outline-none border-b text-xs font-medium w-[120px]"
                    style={{ color: 'var(--text-primary)', borderColor: 'var(--accent)' }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => { setActiveTab(tabId); setPlatformSection(null); }}
                  onDoubleClick={() => beginTabRename(tab)}
                  className="workspace-tab-button"
                  style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  title="双击重命名标签"
                >
                  <ProjectTabLabel label={tab.customName?.trim() || tab.projectName} sessions={tabSessions} fallbackAt={project?.updated_at ?? project?.created_at} />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeProjectTab(tab.projectId);
                }}
                className="workspace-tab-close"
                style={{ color: 'var(--text-secondary)' }}
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        {/* New-project "+" — jump home to add a project */}
        {hasPermission(permissionsQuery.data, 'projects_create', 'write') && <button
          onClick={() => { setActiveTab('home'); setPlatformSection(null); window.dispatchEvent(new CustomEvent('agentmanager:add-project')); }}
          className="flex items-center justify-center rounded-md shrink-0 transition-colors ml-0.5"
          style={{ width: 26, height: 26, color: 'var(--text-secondary)', background: 'transparent' }}
          title="添加项目"
        >
          <Plus className="w-4 h-4" />
        </button>}
      </nav>

      {/* Content — all project tabs stay mounted to preserve terminal state */}
      <main className="flex-1 min-h-0 overflow-hidden relative isolate">
        <div
          className="h-full"
          style={{ display: activeTab === 'home' ? 'block' : 'none' }}
        >
          <ErrorBoundary label="Projects">
            <Suspense fallback={<div className="h-full" style={{ background: 'var(--bg-primary)' }} />}>
              <ProjectDashboard
                onOpenProject={handleOpenProject}
                onOpenSession={(projectId, sessionId) => {
                  const project = projects.find((item) => item.id === projectId);
                  if (!project) return;
                  handleOpenProject(projectId, project.name);
                  setFocusSessionId(sessionId);
                }}
                projectOrder={projectOrder}
                onProjectOrderChange={setProjectOrder}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
        {mountedProjectTabs.map((tab) => {
          const tabId = `project-${tab.projectId}`;
          const isActive = activeTab === tabId;
          const project = projects.find((p) => p.id === tab.projectId);
          const projectPath = project?.path || '';
          const projectName = tab?.projectName || project?.name || 'Project';

          return (
            <div
              key={tab.projectId}
              className="h-full"
              style={{ display: isActive ? 'block' : 'none' }}
            >
              {!projectPath ? (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Loading project...
                  </p>
                </div>
              ) : (
                <ErrorBoundary label={projectName}>
                  <Suspense fallback={<div className="h-full" style={{ background: 'var(--bg-primary)' }} />}>
                    <ProjectView
                      currentUserId={authUser.id}
                      projectId={tab.projectId}
                      projectPath={projectPath}
                      projectName={projectName}
                      active={isActive && !showPlatformCenter}
                      terminalsSuspended={showPlatformCenter}
                      focusSessionId={isActive ? focusSessionId : null}
                      onFocusSessionHandled={handleFocusSessionHandled}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          );
        })}
      </main>

      {confirmClose && (
        <CloseTabModal
          label={projectTabs.find((t) => t.projectId === confirmClose.projectId)?.projectName || 'Project'}
          type="project"
          sessionCount={confirmClose.count}
          onHide={() => {
            // Hide the project tab but keep sessions running
            const { projectId } = confirmClose;
            const projectPath = projects.find((project) => project.id === projectId)?.path;
            if (projectPath && !confirmDiscardProject(projectPath)) return;
            cleanupProjectStorage(authUser.id, projectId);
            setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
            if (activeTab === `project-${projectId}`) {
              setActiveTab('home');
            }
            setConfirmClose(null);
          }}
          onKill={() => confirmCloseProject()}
          onCancel={() => setConfirmClose(null)}
        />
      )}

      <Suspense fallback={null}>
        {platformSection && <PlatformCenter currentUser={authUser} initialSection={platformSection} onClose={closePlatformCenter} onOpenSession={(projectId, sessionId) => {
          const project = projects.find((value) => value.id === projectId);
          if (!project) return;
          handleOpenProject(projectId, project.name);
          setFocusSessionId(sessionId);
          closePlatformCenter();
        }} /> }
      </Suspense>
      <ExportTransferOverlay />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="AgentManager">
        <AuthGate>
          {(user, logout) => <Dashboard authUser={user} onLogout={logout} />}
        </AuthGate>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
