import { useEffect, useState, useCallback, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc, createTRPCClient } from './lib/trpc';
import { connectStream, useStreamStore, setQueryClient } from './lib/websocket';
import { api, type AuthUser } from './lib/api';
import { AuthGate } from './components/AuthGate';
import { AccountModal } from './components/AccountModal';
import { ProjectDashboard } from './components/ProjectDashboard';
import { ProjectView, cleanupProjectStorage } from './components/ProjectView';
import { X, LayoutGrid, FolderOpen, Monitor, Settings, ArrowUpCircle, LogOut, Users, Plus, Sparkles } from 'lucide-react';
import { AgentGuideButton } from './components/AgentGuide';
import { SkillsManager } from './components/SkillsManager';
import { CloseTabModal } from './components/CloseTabModal';
import { SettingsModal } from './components/SettingsModal';
import { ActiveTerminals } from './components/ActiveTerminals';
import { installShortcutDispatcher, useShortcut, useShortcutStore, markKeyboardNav } from './lib/shortcuts';
import { applyTheme } from './lib/themes';
import { signalForSession, rollupSignal, SessionSignalDot } from './lib/session-signal';

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
const trpcClient = createTRPCClient();

interface ProjectTab {
  projectId: string;
  projectName: string;
  /** User-set tab label. Falls back to projectName when empty. */
  customName?: string;
}

const APP_STATE_KEY_PREFIX = 'agentmanager-app-state-v2';
const appStateKey = (userId: string) => `${APP_STATE_KEY_PREFIX}:${userId}`;

function loadAppState(userId: string): { activeTab: string; projectTabs: ProjectTab[] } | null {
  try {
    const raw = localStorage.getItem(appStateKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.activeTab === 'string' && Array.isArray(parsed.projectTabs)) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveAppState(userId: string, activeTab: string, projectTabs: ProjectTab[]) {
  try {
    localStorage.setItem(appStateKey(userId), JSON.stringify({ activeTab, projectTabs }));
  } catch {}
}

function Dashboard({ authUser, onLogout }: { authUser: AuthUser; onLogout: () => void }) {
  const connected = useStreamStore((s) => s.connected);
  const liveStates = useStreamStore((s) => s.liveStates);
  const [savedState] = useState(() => loadAppState(authUser.id));
  const [activeTab, setActiveTab] = useState<string>(savedState?.activeTab ?? 'home');
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  // Inline tab-rename: which tab is being renamed + its draft text.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  // Set when Escape cancels editing, so the input's onBlur doesn't also commit.
  const skipTabBlurCommitRef = useRef(false);
  const [projectTabs, setProjectTabs] = useState<ProjectTab[]>(() => {
    const tabs = savedState?.projectTabs ?? [];
    // Deduplicate by projectId
    const seen = new Set<string>();
    return tabs.filter((t) => {
      if (seen.has(t.projectId)) return false;
      seen.add(t.projectId);
      return true;
    });
  });

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
    // Hydrate shortcut bindings as soon as settings arrive
    const bindingsRaw = appSettings?.settings?.shortcut_bindings;
    if (bindingsRaw !== undefined) {
      useShortcutStore.getState().hydrate(bindingsRaw);
    }
  }, [appSettings]);

  // Install the global keydown dispatcher once
  useEffect(() => {
    const uninstall = installShortcutDispatcher();
    return () => uninstall();
  }, []);

  // Track hidden session IDs reported by each ProjectView
  const hiddenSessionIdsRef = useRef<Map<string, string[]>>(new Map());
  const [hiddenSessionIds, setHiddenSessionIds] = useState<string[]>([]);
  const handleHiddenSessionsChange = useCallback((projectId: string, sessionIds: string[]) => {
    hiddenSessionIdsRef.current.set(projectId, sessionIds);
    const all: string[] = [];
    for (const ids of hiddenSessionIdsRef.current.values()) all.push(...ids);
    setHiddenSessionIds(all);
  }, []);
  // Stable per-project callbacks to avoid inline arrow re-creation on every render
  const hiddenSessionsCallbacksRef = useRef<Map<string, (ids: string[]) => void>>(new Map());
  const getHiddenSessionsCallback = useCallback((projectId: string) => {
    let cb = hiddenSessionsCallbacksRef.current.get(projectId);
    if (!cb) {
      cb = (ids: string[]) => handleHiddenSessionsChange(projectId, ids);
      hiddenSessionsCallbacksRef.current.set(projectId, cb);
    }
    return cb;
  }, [handleHiddenSessionsChange]);

  const queryClient = useQueryClient();

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });

  // Sessions — driven by WebSocket invalidation (websocket.ts invalidates on session.* events).
  // Long fallback interval for stale-data recovery only.
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
    refetchInterval: 60_000,
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

  const projects = projectsData?.projects || [];
  const sessions = sessionsData?.sessions || [];

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

  const activeSessionCount = sessions.filter(
    (s) => s.status === 'running' || s.status === 'detached'
  ).length;
  const [showActiveTerminals, setShowActiveTerminals] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const dismissActiveTerminals = useCallback(() => {
    setShowActiveTerminals(false);
    // Fire a resize event so terminals re-fit to their restored container size
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, []);

  useEffect(() => {
    setQueryClient(queryClient);
    connectStream();
  }, []);

  // Persist app state
  useEffect(() => {
    saveAppState(authUser.id, activeTab, projectTabs);
  }, [activeTab, projectTabs]);

  // Tab navigation shortcuts — cycle across 'home' + open project tabs.
  // markKeyboardNav() raises a short-lived flag so the newly visible
  // terminal doesn't auto-focus (which would trap the user). Click-to-switch
  // doesn't set the flag, so clicks keep the current focus-terminal behavior.
  const cycleTab = useCallback((delta: number) => {
    const order: string[] = ['home', ...projectTabs.map((t) => `project-${t.projectId}`)];
    if (order.length <= 1) return;
    const idx = order.indexOf(activeTab);
    const next = order[((idx === -1 ? 0 : idx) + delta + order.length) % order.length];
    markKeyboardNav();
    // Blur whatever has focus (usually the terminal helper textarea) so focus
    // doesn't stay "inside" the previous tab after we switch.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setActiveTab(next);
  }, [activeTab, projectTabs]);

  useShortcut('nav.nextTab', () => cycleTab(1));
  useShortcut('nav.prevTab', () => cycleTab(-1));
  useShortcut('nav.goHome', () => setActiveTab('home'));

  // Launch shortcuts — resolve "current project" as (a) the active project
  // tab, or (b) the selected card on the home page. ProjectDashboard reports
  // its current selection via onSelectedProjectChange into the ref.
  const homeSelectedProjectIdRef = useRef<string | null>(null);
  const resolveCurrentProjectId = useCallback((): string | null => {
    if (activeTab.startsWith('project-')) return activeTab.slice('project-'.length);
    if (activeTab === 'home') return homeSelectedProjectIdRef.current;
    return null;
  }, [activeTab]);
  const launchForCurrent = useCallback((quickLaunch: 'session' | 'terminal', cliType?: 'claude' | 'codex') => {
    const pid = resolveCurrentProjectId();
    if (!pid) return;
    const project = projects.find((p) => p.id === pid);
    if (!project) return;
    handleOpenProject(pid, project.name, quickLaunch, cliType);
  }, [projects, resolveCurrentProjectId]);
  useShortcut('session.launchClaude', () => launchForCurrent('session', 'claude'));
  useShortcut('session.launchCodex', () => launchForCurrent('session', 'codex'));
  useShortcut('session.launchTerminal', () => launchForCurrent('terminal'));

  // Release focus from any input/terminal — gives users a way to "escape" the
  // terminal input back to a no-focus state. Unbound by default.
  useShortcut('nav.blurInput', () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
  });

  function handleOpenProject(projectId: string, projectName: string, quickLaunch?: 'session' | 'agent' | 'terminal', cliType?: 'claude' | 'codex') {
    setProjectTabs((prev) => {
      if (prev.find((t) => t.projectId === projectId)) return prev;
      return [...prev, { projectId, projectName }];
    });
    setActiveTab(`project-${projectId}`);
    if (quickLaunch) {
      const suffix = cliType && cliType !== 'claude' ? `_${cliType}` : '';
      setFocusSessionId(`__voice_create_${quickLaunch}${suffix}`);
    }
  }

  const [confirmClose, setConfirmClose] = useState<{ projectId: string; count: number } | null>(null);

  const closeProjectTab = useCallback(async (projectId: string) => {
    // Fetch fresh session list — cached data may be stale (e.g. right after quick-launch)
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
    );
    if (runningSessions.length === 0) {
      try {
        const fresh = await api.sessions.list();
        runningSessions = (fresh.sessions || []).filter(
          (s: any) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
        );
      } catch {}
    }

    if (runningSessions.length > 0) {
      setConfirmClose({ projectId, count: runningSessions.length });
      return;
    }

    cleanupProjectStorage(projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) {
      setActiveTab('home');
    }
  }, [sessions, activeTab]);

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

    // Close tab immediately
    cleanupProjectStorage(projectId);
    setProjectTabs((prev) => prev.filter((t) => t.projectId !== projectId));
    if (activeTab === `project-${projectId}`) {
      setActiveTab('home');
    }
    setConfirmClose(null);

    // Kill sessions in the background — fetch fresh list to catch recently created ones
    let runningSessions = sessions.filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
    );
    try {
      const fresh = await api.sessions.list();
      const freshRunning = (fresh.sessions || []).filter(
        (s: any) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached')
      );
      if (freshRunning.length > runningSessions.length) {
        runningSessions = freshRunning;
      }
    } catch {}

    Promise.all(runningSessions.map((s) => api.sessions.kill(s.id).catch(() => {})))
      .then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }));
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold">
            <span style={{ color: '#ef4444' }}>Agent</span><span style={{ color: 'var(--text-primary)' }}>Manager</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowActiveTerminals(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Active Sessions</span>
            {activeSessionCount > 0 && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {activeSessionCount}
              </span>
            )}
          </button>
          <AgentGuideButton />
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-md transition-colors hover:opacity-80"
            style={{ color: 'var(--text-secondary)', background: 'transparent' }}
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: connected ? 'var(--success)' : 'var(--error)' }}
            />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 pl-2 ml-0.5" style={{ borderLeft: '1px solid var(--border)' }}>
            <button
              onClick={() => setShowAccount(true)}
              className="flex items-center gap-1 text-xs font-medium transition-colors hover:opacity-80"
              style={{ color: 'var(--text-secondary)' }}
              title={`账户设置${authUser.role === 'admin' ? ' · 用户管理' : ''}`}
            >
              {authUser.role === 'admin' && <Users className="w-3.5 h-3.5" />}
              {authUser.display_name || authUser.username}
            </button>
            <button
              onClick={onLogout}
              className="p-1.5 rounded-md transition-colors hover:opacity-80"
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
        className="flex items-center gap-0.5 px-2 py-1 border-b shrink-0 overflow-x-auto"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
      >
        {/* Home tab */}
        <button
          onClick={() => { setActiveTab('home'); dismissActiveTerminals(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0"
          style={{
            background: activeTab === 'home' ? 'var(--bg-tertiary)' : 'transparent',
            color: activeTab === 'home' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Projects
        </button>

        {/* Skills tab */}
        <button
          onClick={() => { setActiveTab('skills'); dismissActiveTerminals(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0"
          style={{
            background: activeTab === 'skills' ? 'var(--bg-tertiary)' : 'transparent',
            color: activeTab === 'skills' ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Skills
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
          // Aggregate signal across the project's *currently relevant* sessions
          // (live, or active by status, or a recent failure) so a project tab
          // reflects what needs attention now — not stale completed history.
          const rollup = rollupSignal(
            sessions
              .filter((s) => {
                if (s.project_id !== tab.projectId) return false;
                if (liveStates[s.id]) return true;
                if (s.status === 'running' || s.status === 'pending' || s.status === 'detached') return true;
                if (s.status === 'failed' && s.completed_at) {
                  const t = Date.parse(s.completed_at + (s.completed_at.endsWith('Z') ? '' : 'Z'));
                  if (!Number.isNaN(t) && Date.now() - t < 10 * 60 * 1000) return true;
                }
                return false;
              })
              .map((s) => signalForSession(s, liveStates))
          );

          return (
            <div
              key={tab.projectId}
              className="flex items-center gap-1 rounded-md shrink-0 group"
              style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
            >
              {rollup && (
                <span className="pl-2 flex items-center">
                  <SessionSignalDot signal={rollup} active={isActive} size={6} />
                </span>
              )}
              {editingTabId === tab.projectId ? (
                <div className="flex items-center gap-1.5 pl-3 pr-1 py-1.5 max-w-[180px]">
                  <FolderOpen className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
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
                  onClick={() => { setActiveTab(tabId); dismissActiveTerminals(); }}
                  onDoubleClick={() => beginTabRename(tab)}
                  className="flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-xs font-medium transition-colors max-w-[180px]"
                  style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  title="双击重命名标签"
                >
                  <FolderOpen className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                  <span className="truncate">{tab.customName?.trim() || tab.projectName}</span>
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeProjectTab(tab.projectId);
                }}
                className="p-1 rounded hover:opacity-100 opacity-0 group-hover:opacity-60 transition-opacity mr-1"
                style={{ color: 'var(--text-secondary)' }}
                title="Close tab"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        {/* New-project "+" — jump home to add a project */}
        <button
          onClick={() => { setActiveTab('home'); dismissActiveTerminals(); window.dispatchEvent(new CustomEvent('agentmanager:add-project')); }}
          className="flex items-center justify-center rounded-md shrink-0 transition-colors ml-0.5"
          style={{ width: 26, height: 26, color: 'var(--text-secondary)', background: 'transparent' }}
          title="添加项目"
        >
          <Plus className="w-4 h-4" />
        </button>
      </nav>

      {/* Content — all project tabs stay mounted to preserve terminal state */}
      <main className="flex-1 min-h-0 overflow-hidden relative">
        {showActiveTerminals && (
          <div className="absolute inset-0 z-20">
            <ActiveTerminals
              onBack={dismissActiveTerminals}
              openProjectIds={projectTabs.map((t) => t.projectId)}
              hiddenSessionIds={hiddenSessionIds}
              onGoToSession={(projectId, sessionId) => {
                const tab = projectTabs.find((t) => t.projectId === projectId);
                if (tab) {
                  setActiveTab(`project-${projectId}`);
                } else {
                  const project = projects.find((p) => p.id === projectId);
                  if (project) handleOpenProject(projectId, project.name);
                }
                if (sessionId) setFocusSessionId(sessionId);
                dismissActiveTerminals();
              }}
            />
          </div>
        )}
        <div
          className="h-full"
          style={{ display: activeTab === 'home' ? 'block' : 'none' }}
        >
          <ProjectDashboard
            onOpenProject={handleOpenProject}
            active={activeTab === 'home'}
            onSelectedProjectChange={(id) => { homeSelectedProjectIdRef.current = id; }}
          />
        </div>
        <div
          className="h-full"
          style={{ display: activeTab === 'skills' ? 'block' : 'none' }}
        >
          <SkillsManager active={activeTab === 'skills'} />
        </div>
        {projectTabs.map((tab) => {
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
                <ProjectView
                  projectId={tab.projectId}
                  projectPath={projectPath}
                  projectName={projectName}
                  active={isActive && !showActiveTerminals}
                  terminalsSuspended={showActiveTerminals}
                  focusSessionId={isActive ? focusSessionId : null}
                  onFocusSessionHandled={() => setFocusSessionId(null)}
                  onHiddenSessionsChange={getHiddenSessionsCallback(tab.projectId)}
                />
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
            cleanupProjectStorage(projectId);
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

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showAccount && <AccountModal currentUser={authUser} onClose={() => setShowAccount(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          {(user, logout) => <Dashboard authUser={user} onLogout={logout} />}
        </AuthGate>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
