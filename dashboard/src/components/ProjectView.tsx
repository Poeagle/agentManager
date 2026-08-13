import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, FolderTree, GitBranch, Home, Plus, X, Download, Globe, Zap, Bot, TerminalSquare, History, Sparkles, CalendarClock } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';
import { Terminal } from './Terminal';
import { FileExplorer, type FileRefreshRequest } from './FileExplorer';
import { GitPanel } from './GitPanel';
import { SessionLauncher } from './SessionLauncher';
import { WebPageView } from './WebPageView';
import { api, type ClaudeHistoryItem } from '../lib/api';
import { CloseTabModal } from './CloseTabModal';
import { SessionHistoryPanel } from './SessionHistoryPanel';
import { HistoryViewer } from './HistoryViewer';
import { ProjectSkillsPanel } from './ProjectSkillsPanel';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { LiveSessionSignalDot } from '../lib/session-signal';
import { SessionActivityAge } from '../lib/session-activity';
import { promoteWarmTerminal, TERMINAL_COLD_DELAY_MS } from '../lib/warm-terminal-pool';
import {
  reconcileHydratedTerminalInstances,
  shouldAutoRestoreSession,
  type TerminalInstance,
} from '../lib/project-session-state';
import { confirmDiscardExplorer } from '../lib/unsaved-files';

interface ProjectViewProps {
  currentUserId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  active?: boolean;
  /** When true, disconnect terminal WebSockets while a global monitor is visible. */
  terminalsSuspended?: boolean;
  /** When set, switch to this terminal session ID and clear it */
  focusSessionId?: string | null;
  onFocusSessionHandled?: () => void;
}
interface ExplorerInstance {
  id: string;
  label: string;
}

interface WebPageInstance {
  id: string;
  label: string;
  url: string;
}

type ActiveMode = 'terminal' | 'explorer' | 'events' | 'git' | 'history' | 'skills' | 'scheduled';

interface PersistedState {
  activeMode: ActiveMode;
  explorerInstances: ExplorerInstance[];
  activeExplorerId: string | null;
  terminalInstances: TerminalInstance[];
  activeTerminalId: string | null;
  /** Running sessions whose tabs the user explicitly hid without killing. */
  hiddenSessionIds?: string[];
  webPageInstances?: WebPageInstance[];
  activeWebPageId?: string | null;
  /** When true, the "new session" launcher tab is active instead of a terminal */
  showLauncher: boolean;
}

let nextExplorerSeq = 1;

function storageKey(userId: string, projectId: string) {
  return `agentmanager-project-${userId}-${projectId}`;
}

function ownsExplorerTab(userId: string, projectId: string, id: string) {
  return id.startsWith(`${userId}-${projectId}-explorer-`);
}

function ownsWebPageTab(userId: string, projectId: string, id: string) {
  return id.startsWith(`${userId}-${projectId}-webpage-`);
}

function loadPersistedState(userId: string, projectId: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(userId, projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.activeMode && Array.isArray(parsed.explorerInstances)) {
      return parsed;
    }
  } catch {
    // Ignore corrupt or unavailable local storage and use defaults.
  }
  return null;
}

function persistState(userId: string, projectId: string, state: PersistedState) {
  try {
    localStorage.setItem(storageKey(userId, projectId), JSON.stringify(state));
  } catch {
    // Persistence is best effort (for example, private browsing may reject it).
  }
}

function isLiveSessionStatus(status: string) {
  return status === 'running'
    || status === 'detached'
    || status === 'pending'
    || status === 'launching';
}

const sidebarButtons = [
  { id: 'terminal' as const, icon: Monitor, title: 'Terminal' },
  { id: 'explorer' as const, icon: FolderTree, title: 'File Explorer' },
  { id: 'git' as const, icon: GitBranch, title: 'Source Control' },
  { id: 'history' as const, icon: History, title: 'Session 历史' },
  { id: 'scheduled' as const, icon: CalendarClock, title: '定时任务' },
  { id: 'skills' as const, icon: Sparkles, title: 'Skills' },
] as const;

// Memoized so unrelated Dashboard re-renders (sessions list updates, signal
// ticks, tab switches of OTHER projects) don't re-render every mounted project
// view. Props from App are referentially stable (strings/bools + useCallback'd
// handlers), so the shallow compare holds.
export const ProjectView = memo(ProjectViewImpl);

function ProjectViewImpl({ currentUserId, projectId, projectPath, active = true, terminalsSuspended = false, focusSessionId, onFocusSessionHandled }: ProjectViewProps) {
  const queryClient = useQueryClient();

  // Fetch project data for SessionLauncher
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });
  const project = projectsData?.projects.find((p) => p.id === projectId);

  // Fetch running sessions for this project
  // No refetchInterval — driven by WebSocket invalidation (websocket.ts).
  const { data: sessionsData, isSuccess: sessionsLoaded } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const projectSessions = useMemo(
    () => (sessionsData?.sessions || []).filter(
      (s) => s.project_id === projectId && (s.status === 'running' || s.status === 'detached' || s.status === 'pending')
    ),
    [sessionsData, projectId]
  );

  // Lookup map for session metadata (cli_type, task, etc.) — used in tab rendering
  const sessionLookup = useMemo(
    () => new Map(projectSessions.map((s) => [s.id, s])),
    [projectSessions]
  );

  // All sessions (any status) keyed by id — for tab signal lights, which must
  // also reflect completed/failed sessions that `projectSessions` filters out.
  const allSessionLookup = useMemo(
    () => new Map((sessionsData?.sessions || []).map((s) => [s.id, s])),
    [sessionsData]
  );
  // Which Claude history conversation (uuid) is currently being resumed.
  const [resumingUuid, setResumingUuid] = useState<string | null>(null);

  // Initialize from persisted state or defaults
  const [initialized] = useState(() => {
    const saved = loadPersistedState(currentUserId, projectId);
    if (saved) {
      for (const e of saved.explorerInstances) {
        const match = e.id.match(/-explorer-(\d+)$/);
        if (match) nextExplorerSeq = Math.max(nextExplorerSeq, parseInt(match[1]) + 1);
      }
    }
    return saved;
  });

  // id → custom terminal-tab name: the cross-device-shareable slice of
  // terminalInstances. Seeded from the local cache, merged with server state on
  // mount, and consulted by the session-sync reconciliation below so a custom
  // name survives even when a tab is re-derived from a live session.
  const terminalLabelsRef = useRef<Record<string, string>>(
    Object.fromEntries(
      (initialized?.terminalInstances ?? [])
        .filter((t) => t.customLabel?.trim())
        .map((t) => [t.id, t.customLabel!.trim()]),
    ),
  );
  // State guarantees the first complete post-hydration tab snapshot is
  // written even when nothing else changes afterward.
  const [projHydrated, setProjHydrated] = useState(false);

  const [activeMode, setActiveMode] = useState<ActiveMode>(
    initialized?.activeMode ?? 'terminal'
  );

  // Discover external sessions available for adoption (on-demand only, no polling)
  const { data: discoverableData, refetch: refetchDiscoverable } = useQuery({
    queryKey: ['discoverable-sessions', projectPath],
    queryFn: () => api.sessions.discoverable(projectPath),
    enabled: false, // on-demand only — triggered by user clicking "Scan"
  });
  const discoverableSessions = discoverableData?.sessions || [];

  // Terminal instances — restored from persisted state + synced with server sessions
  const [terminalInstances, setTerminalInstances] = useState<TerminalInstance[]>(
    initialized?.terminalInstances ?? []
  );
  const locallyCreatedSessionIds = useRef(new Set<string>());
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(
    initialized?.activeTerminalId ?? null
  );
  // Set once server project state has been read. Ended sessions may auto-resume
  // only when the authoritative state says their tab was still open.
  const canonicalOpenSessionIdsRef = useRef<Set<string> | null>(null);
  // Hydration runs once, so read the latest live-session set through a ref when
  // its request resolves instead of capturing the first render's empty query.
  const activeProjectSessionIdsRef = useRef(new Set<string>());
  activeProjectSessionIdsRef.current = new Set(projectSessions.map((session) => session.id));

  // Server/browser state written before per-user isolation may contain another
  // account's session IDs. A local ended tab is valid only when it is also in
  // the authoritative server project state; live and just-created tabs remain.
  useEffect(() => {
    if (!sessionsLoaded) return;
    const knownSessionIds = new Set((sessionsData?.sessions || []).map((session) => session.id));
    const allowed = new Set(
      (sessionsData?.sessions || [])
        .filter((session) => isLiveSessionStatus(session.status))
        .map((session) => session.id),
    );
    for (const id of canonicalOpenSessionIdsRef.current ?? []) {
      if (knownSessionIds.has(id)) allowed.add(id);
    }
    for (const id of locallyCreatedSessionIds.current) {
      if (knownSessionIds.has(id)) locallyCreatedSessionIds.current.delete(id);
    }
    setTerminalInstances((prev) => {
      const next = prev.filter((tab) => allowed.has(tab.id) || locallyCreatedSessionIds.current.has(tab.id));
      return next.length === prev.length ? prev : next;
    });
    setActiveTerminalId((prev) => prev && !allowed.has(prev) && !locallyCreatedSessionIds.current.has(prev) ? null : prev);
  }, [sessionsLoaded, sessionsData, projHydrated]);
  const autoResumeAttemptsRef = useRef(new Set<string>());

  // ── Inline session-tab rename ──────────────────────────────────────
  // ProjectView refocuses the active terminal (xterm) on session updates / tab
  // clicks via the `agentmanager:focus-terminal` event, which steals focus from a
  // rename <input> and would dismiss it on blur. So we never commit on blur —
  // blur just grabs focus back. Commit = Enter or a real outside mousedown;
  // cancel = Escape.
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [editingTerminalValue, setEditingTerminalValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const beginTerminalRename = useCallback((inst: TerminalInstance) => {
    setEditingTerminalId(inst.id);
    setEditingTerminalValue(inst.customLabel?.trim() || inst.label);
  }, []);
  const commitTerminalRename = useCallback((id: string) => {
    const v = editingTerminalValue.trim();
    // Keep the synced label map in lockstep so reconciliation can re-apply it.
    if (v) terminalLabelsRef.current[id] = v;
    else delete terminalLabelsRef.current[id];
    setTerminalInstances((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, customLabel: v || undefined } : t,
      ),
    );
    setEditingTerminalId(null);
    setEditingTerminalValue('');
  }, [editingTerminalValue]);
  const cancelTerminalRename = useCallback(() => {
    setEditingTerminalId(null);
    setEditingTerminalValue('');
  }, []);
  // Commit when the user mousedowns anywhere outside the rename input.
  useEffect(() => {
    if (editingTerminalId === null) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (renameInputRef.current && !renameInputRef.current.contains(e.target as Node)) {
        commitTerminalRename(editingTerminalId);
      }
    };
    document.addEventListener('mousedown', onDocPointerDown, true);
    return () => document.removeEventListener('mousedown', onDocPointerDown, true);
  }, [editingTerminalId, commitTerminalRename]);

  const [showLauncher, setShowLauncher] = useState(
    initialized?.showLauncher ?? true
  );
  // Lazy-mount: only create xterm instances for terminals the user has actually viewed.
  // Prevents 8+ xterm instances from initializing simultaneously on page refresh.
  const mountedTerminals = useRef(new Set<string>());

  // Web page instances
  const [webPageInstances, setWebPageInstances] = useState<WebPageInstance[]>(() =>
    (initialized?.webPageInstances ?? []).filter((tab) =>
      ownsWebPageTab(currentUserId, projectId, tab.id),
    ),
  );
  const [activeWebPageId, setActiveWebPageId] = useState<string | null>(
    initialized?.activeWebPageId
      && ownsWebPageTab(currentUserId, projectId, initialized.activeWebPageId)
      ? initialized.activeWebPageId
      : null,
  );

  // Keep the three most recently used terminals hot. Older terminals retain
  // their painted xterm buffer for a grace period, then disconnect and resume
  // incrementally from a display cursor the next time they are selected.
  const initialWarmTerminalId = active && !showLauncher && !activeWebPageId ? activeTerminalId : null;
  const [warmTerminalIds, setWarmTerminalIds] = useState<Set<string>>(
    () => new Set(initialWarmTerminalId ? [initialWarmTerminalId] : []),
  );
  const warmTerminalIdsRef = useRef(warmTerminalIds);
  const recentWarmTerminalIdsRef = useRef<string[]>(initialWarmTerminalId ? [initialWarmTerminalId] : []);
  const coolingTimersRef = useRef(new Map<string, number>());
  const foregroundTerminalIdRef = useRef<string | null>(initialWarmTerminalId);

  const updateWarmTerminalIds = useCallback((update: (current: Set<string>) => Set<string>) => {
    setWarmTerminalIds((current) => {
      const next = update(current);
      warmTerminalIdsRef.current = next;
      return next;
    });
  }, []);

  const scheduleTerminalCooling = useCallback((terminalId: string, forceWhenBackground = false) => {
    const existing = coolingTimersRef.current.get(terminalId);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      coolingTimersRef.current.delete(terminalId);
      if (foregroundTerminalIdRef.current === terminalId) return;
      if (!forceWhenBackground && recentWarmTerminalIdsRef.current.includes(terminalId)) return;
      updateWarmTerminalIds((current) => {
        if (!current.has(terminalId)) return current;
        const next = new Set(current);
        next.delete(terminalId);
        return next;
      });
    }, TERMINAL_COLD_DELAY_MS);
    coolingTimersRef.current.set(terminalId, timer);
  }, [updateWarmTerminalIds]);

  const keepTerminalWarm = useCallback((terminalId: string) => {
    const cooling = coolingTimersRef.current.get(terminalId);
    if (cooling !== undefined) {
      window.clearTimeout(cooling);
      coolingTimersRef.current.delete(terminalId);
    }
    const promoted = promoteWarmTerminal(recentWarmTerminalIdsRef.current, terminalId);
    recentWarmTerminalIdsRef.current = promoted.recent;
    updateWarmTerminalIds((current) => {
      if (current.has(terminalId)) return current;
      const next = new Set(current);
      next.add(terminalId);
      return next;
    });
    for (const coolingId of promoted.cooling) scheduleTerminalCooling(coolingId);
  }, [scheduleTerminalCooling, updateWarmTerminalIds]);

  useEffect(() => {
    const foregroundId = active
      && activeMode === 'terminal'
      && !showLauncher
      && !activeWebPageId
      ? activeTerminalId
      : null;
    foregroundTerminalIdRef.current = foregroundId;
    if (foregroundId) {
      keepTerminalWarm(foregroundId);
      return;
    }
    for (const terminalId of warmTerminalIdsRef.current) {
      scheduleTerminalCooling(terminalId, true);
    }
  }, [active, activeMode, activeTerminalId, activeWebPageId, keepTerminalWarm, scheduleTerminalCooling, showLauncher]);

  useEffect(() => {
    const existingIds = new Set(terminalInstances.map((terminal) => terminal.id));
    recentWarmTerminalIdsRef.current = recentWarmTerminalIdsRef.current.filter((id) => existingIds.has(id));
    for (const [id, timer] of coolingTimersRef.current) {
      if (existingIds.has(id)) continue;
      window.clearTimeout(timer);
      coolingTimersRef.current.delete(id);
    }
    updateWarmTerminalIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [terminalInstances, updateWarmTerminalIds]);

  useEffect(() => () => {
    for (const timer of coolingTimersRef.current.values()) window.clearTimeout(timer);
    coolingTimersRef.current.clear();
  }, []);

  // Close-tab confirmation modal state
  const [closeConfirm, setCloseConfirm] = useState<{
    id: string;
    label: string;
    type: 'session' | 'terminal' | 'agent';
  } | null>(null);

  // Track sessions the user explicitly closed so the sync effect doesn't re-add them
  const closedSessionIds = useRef(new Set<string>(initialized?.hiddenSessionIds ?? []));

  // Keep an affected user's already-open page in sync when an administrator
  // renames or removes one of their session tabs from the monitor page.
  useEffect(() => {
    const handleAdminTabState = (event: Event) => {
      const detail = (event as CustomEvent<{
        targetUserId?: string;
        projectId?: string;
        sessionId?: string;
        action?: 'rename' | 'delete';
        name?: string;
      }>).detail;
      if (detail?.targetUserId !== currentUserId || detail.projectId !== projectId || !detail.sessionId) return;
      if (detail.action === 'rename' && detail.name) {
        terminalLabelsRef.current[detail.sessionId] = detail.name;
        setTerminalInstances((prev) => prev.map((tab) => (
          tab.id === detail.sessionId ? { ...tab, customLabel: detail.name } : tab
        )));
        return;
      }
      if (detail.action === 'delete') {
        closedSessionIds.current.add(detail.sessionId);
        canonicalOpenSessionIdsRef.current?.delete(detail.sessionId);
        locallyCreatedSessionIds.current.delete(detail.sessionId);
        delete terminalLabelsRef.current[detail.sessionId];
        setClosedIdsVersion((value) => value + 1);
        setTerminalInstances((prev) => prev.filter((tab) => tab.id !== detail.sessionId));
        setActiveTerminalId((activeId) => activeId === detail.sessionId ? null : activeId);
        if (activeTerminalId === detail.sessionId) setShowLauncher(false);
      }
    };
    window.addEventListener('agentmanager:user-tab-state', handleAdminTabState);
    return () => window.removeEventListener('agentmanager:user-tab-state', handleAdminTabState);
  }, [activeTerminalId, currentUserId, projectId]);
  // Counter to force re-render when closedSessionIds changes (refs don't trigger re-renders)
  const [closedIdsVersion, setClosedIdsVersion] = useState(0);

  // Sync terminal instances with server sessions (auto-detect running sessions)
  const syncedRef = useRef(false);
  useEffect(() => {
    if (projectSessions.length === 0 && syncedRef.current) return;
    if (projectSessions.length === 0 && !syncedRef.current) {
      syncedRef.current = true;
      return;
    }
    syncedRef.current = true;

    // Prune closed IDs that are no longer alive on the server (kill completed)
    const allAliveIds = new Set(
      (sessionsData?.sessions || [])
        .filter((session) => session.status === 'running' || session.status === 'detached' || session.status === 'pending')
        .map((session) => session.id)
    );
    let pruned = false;
    for (const id of closedSessionIds.current) {
      if (!allAliveIds.has(id)) {
        closedSessionIds.current.delete(id);
        pruned = true;
      }
    }
    if (pruned) setClosedIdsVersion((v) => v + 1);

    // Build a lookup of session type by ID
    const sessionById = new Map(projectSessions.map((s) => [s.id, s]));

    setTerminalInstances((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const aliveIds = new Set(projectSessions.map((s) => s.id));
      // Build set of all session IDs the server knows about (any status)
      const allServerIds = new Set((sessionsData?.sessions || []).map((session) => session.id));
      // Sessions the server reports as ended — kept as tabs (in an ended state)
      // so the user can view the last screen / resume, instead of being evicted.
      const endedIds = new Set(
        (sessionsData?.sessions || [])
          .filter((session) => session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled')
          .map((session) => session.id)
      );

      // Keep a tab if its session is still alive, ended (view/resume), or not yet
      // seen by the server (just created locally, not in the poll response yet).
      const filtered = prev.filter((t) => aliveIds.has(t.id) || endedIds.has(t.id) || (!sessionsLoaded && !allServerIds.has(t.id)));

      // Relabel existing instances based on actual session data.
      // This fixes tabs restored from localStorage with stale labels.
      let sessionCount = 0;
      let terminalCount = 0;
      let agentCount = 0;
      const relabeled = filtered.map((t) => {
        // Restore a synced custom name if one arrived from the server after this
        // instance was first created locally.
        const synced = terminalLabelsRef.current[t.id];
        const withCustom = synced && synced !== t.customLabel ? { ...t, customLabel: synced } : t;
        const session = sessionById.get(t.id);
        if (!session) return withCustom; // not yet known — keep as-is
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const num = isTerminal ? ++terminalCount : isAgent ? ++agentCount : ++sessionCount;
        const newLabel = `${prefix} ${num}`;
        return newLabel !== withCustom.label ? { ...withCustom, label: newLabel } : withCustom;
      });

      // Add new sessions not yet tracked (skip user-closed sessions)
      const newTerminals: TerminalInstance[] = [];
      for (const s of projectSessions) {
        if (!existingIds.has(s.id) && !closedSessionIds.current.has(s.id)) {
          const isTerminal = s.task === 'Terminal';
          const isAgent = s.task.startsWith('Agent (');
          const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
          const num = isTerminal ? ++terminalCount : isAgent ? ++agentCount : ++sessionCount;
          newTerminals.push({ id: s.id, label: `${prefix} ${num}`, customLabel: terminalLabelsRef.current[s.id] });
        }
      }

      const result = [...relabeled, ...newTerminals];
      // Sort: session first, then agent, then terminal
      const sortOrder = (label: string) => label.startsWith('Session') ? 0 : label.startsWith('Agent') ? 1 : 2;
      result.sort((a, b) => {
        const diff = sortOrder(a.label) - sortOrder(b.label);
        if (diff !== 0) return diff;
        return 0; // preserve relative order within each group
      });
      // Check if anything actually changed
      if (result.length === prev.length && newTerminals.length === 0 && result.every((t, i) => t.id === prev[i]?.id && t.label === prev[i]?.label && t.customLabel === prev[i]?.customLabel)) return prev;

      return result;
    });
  }, [projectSessions, sessionsLoaded, sessionsData]);

  // If terminals appeared and launcher was showing, switch to terminal
  // (but not if the user explicitly navigated to the Home/launcher tab)
  useEffect(() => {
    if (terminalInstances.length > 0 && !activeTerminalId && !activeWebPageId && !showLauncher) {
      setActiveTerminalId(terminalInstances[0].id);
    }
  }, [terminalInstances, activeTerminalId, activeWebPageId, showLauncher]);

  // Focus a specific session when requested (e.g. from the admin monitor or a quick-launch command)
  useEffect(() => {
    if (!focusSessionId) return;

    // Voice command / quick-launch: create new terminal, session, or agent (optionally with cli type)
    const createMatch = focusSessionId.match(/^__voice_create_(terminal|session|agent)(?:_(claude|codex))?$/);
    if (createMatch) {
      const type = createMatch[1] as 'terminal' | 'session' | 'agent';
      const cliType = (createMatch[2] as 'claude' | 'codex' | undefined) || 'claude';
      console.log(`[QuickLaunch] Creating new ${type} (${cliType})`);
      if (type === 'terminal') {
        api.sessions.create({ project_path: projectPath, mode: 'terminal', project_id: projectId })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session.id, undefined, 'terminal');
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create terminal:`, err));
      } else {
        const cfPrompt = (project?.session_prompt ?? '').trim();
        const defaultTask = 'Start up and ask me what I want you to do and NOTHING ELSE';
        const task = cfPrompt
          ? `${defaultTask}\n\n---\nAdditional Instructions:\n${cfPrompt}`
          : defaultTask;
        api.sessions.create({
          project_path: projectPath,
          task,
          mode: type === 'agent' ? 'agent' : 'session',
          agent_type: type === 'agent' ? 'coder' : undefined,
          project_id: projectId,
          cli_type: cliType,
        })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session.id, undefined, 'session');
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create ${type}:`, err));
      }
      onFocusSessionHandled?.();
      return;
    }

    // Regular session ID focus
    if (!terminalInstances.some((tab) => tab.id === focusSessionId)) {
      const target = (sessionsData?.sessions || []).find((session) => session.id === focusSessionId && session.project_id === projectId);
      if (target) {
        closedSessionIds.current.delete(focusSessionId);
        canonicalOpenSessionIdsRef.current?.add(focusSessionId);
        setClosedIdsVersion((value) => value + 1);
        const prefix = target.task === 'Terminal' ? 'Terminal' : target.task?.startsWith('Agent (') ? 'Agent' : 'Session';
        const count = terminalInstances.filter((tab) => tab.label.startsWith(prefix)).length + 1;
        setTerminalInstances((prev) => [...prev, { id: focusSessionId, label: `${prefix} ${count}` }]);
        setActiveTerminalId(focusSessionId);
        setActiveWebPageId(null);
        setShowLauncher(false);
        setActiveMode('terminal');
        return;
      }
    }
    if (terminalInstances.some((t) => t.id === focusSessionId)) {
      setActiveTerminalId(focusSessionId);
      setActiveWebPageId(null);
      setShowLauncher(false);
      setActiveMode('terminal');
      onFocusSessionHandled?.();
      focusTerminalById(focusSessionId);
    }
  }, [focusSessionId, onFocusSessionHandled, project?.session_prompt, projectId, projectPath, queryClient, sessionsData, terminalInstances]);

  // Explorer instances
  const [explorerInstances, setExplorerInstances] = useState<ExplorerInstance[]>(() => {
    const owned = (initialized?.explorerInstances ?? []).filter((tab) =>
      ownsExplorerTab(currentUserId, projectId, tab.id),
    );
    if (owned.length) return owned;
    const id = `${currentUserId}-${projectId}-explorer-${nextExplorerSeq++}`;
    return [{ id, label: 'Explorer 1' }];
  });

  const [activeExplorerId, setActiveExplorerId] = useState(() =>
    initialized?.activeExplorerId
      && explorerInstances.some((tab) => tab.id === initialized.activeExplorerId)
      ? initialized.activeExplorerId
      : explorerInstances[0].id,
  );

  // Persist state to localStorage (instant-paint cache + offline fallback).
  useEffect(() => {
    persistState(currentUserId, projectId, {
      activeMode,
      explorerInstances,
      activeExplorerId,
      terminalInstances,
      activeTerminalId,
      hiddenSessionIds: [...closedSessionIds.current],
      webPageInstances,
      activeWebPageId,
      showLauncher,
    });
  }, [currentUserId, projectId, activeMode, explorerInstances, activeExplorerId, terminalInstances, activeTerminalId, closedIdsVersion, webPageInstances, activeWebPageId, showLauncher]);

  // ── Cross-device sync: the terminal tab list uses stable AgentManager
  // session IDs. Persisting it (plus hidden/active IDs) makes the tab-to-native
  // conversation mapping survive browser, service and machine restarts.
  useEffect(() => {
    let cancelled = false;
    api.userState.getAll()
      .then(({ state }) => {
        if (cancelled) return;
        const ps = state?.[`project:${projectId}`] as {
          terminalLabels?: Record<string, string>;
          terminalInstances?: TerminalInstance[];
          activeTerminalId?: string | null;
          hiddenSessionIds?: string[];
          explorerInstances?: ExplorerInstance[];
          webPageInstances?: WebPageInstance[];
        } | undefined;
        if (!ps) {
          // First run for this project: seed the server from local state.
          canonicalOpenSessionIdsRef.current = new Set(terminalInstances.map((terminal) => terminal.id));
          api.userState.set(`project:${projectId}`, {
            terminalLabels: terminalLabelsRef.current,
            terminalInstances,
            activeTerminalId,
            hiddenSessionIds: [...closedSessionIds.current],
            explorerInstances,
            webPageInstances,
          }).catch(() => {});
          return;
        }
        if (ps.terminalLabels) {
          terminalLabelsRef.current = { ...terminalLabelsRef.current, ...ps.terminalLabels };
          setTerminalInstances((prev) =>
            prev.map((t) => {
              const cl = terminalLabelsRef.current[t.id];
              return cl && cl !== t.customLabel ? { ...t, customLabel: cl } : t;
            }),
          );
        }
        if (Array.isArray(ps.hiddenSessionIds)) {
          closedSessionIds.current = new Set(ps.hiddenSessionIds);
          setClosedIdsVersion((v) => v + 1);
        }
        if (Array.isArray(ps.terminalInstances)) {
          canonicalOpenSessionIdsRef.current = new Set(
            ps.terminalInstances
              .filter((terminal) => !closedSessionIds.current.has(terminal.id))
              .map((terminal) => terminal.id),
          );
          setTerminalInstances((prev) => {
            const retainLocalIds = new Set(activeProjectSessionIdsRef.current);
            for (const id of locallyCreatedSessionIds.current) retainLocalIds.add(id);
            return reconcileHydratedTerminalInstances(
              prev,
              ps.terminalInstances!,
              closedSessionIds.current,
              retainLocalIds,
            );
          });
        } else if (closedSessionIds.current.size > 0) {
          canonicalOpenSessionIdsRef.current = new Set(
            terminalInstances
              .filter((terminal) => !closedSessionIds.current.has(terminal.id))
              .map((terminal) => terminal.id),
          );
          setTerminalInstances((prev) => prev.filter((t) => !closedSessionIds.current.has(t.id)));
        } else {
          // Legacy server state without a tab list: preserve the local snapshot
          // once, then the next write upgrades it to the canonical format.
          canonicalOpenSessionIdsRef.current = new Set(terminalInstances.map((terminal) => terminal.id));
        }
        if (
          ps.activeTerminalId
          && !closedSessionIds.current.has(ps.activeTerminalId)
        ) {
          setActiveTerminalId(ps.activeTerminalId);
          setShowLauncher(false);
        }
        // Web-page and explorer tabs aren't derived from sessions, so merge the
        // server's set in (union by id, server wins) to restore them on a new device.
        if (Array.isArray(ps.webPageInstances) && ps.webPageInstances.length) {
          const ownedWebPages = ps.webPageInstances.filter((tab) =>
            ownsWebPageTab(currentUserId, projectId, tab.id),
          );
          setWebPageInstances((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            for (const w of ownedWebPages) byId.set(w.id, w);
            return [...byId.values()];
          });
        }
        if (Array.isArray(ps.explorerInstances) && ps.explorerInstances.length) {
          const ownedExplorers = ps.explorerInstances.filter((tab) =>
            ownsExplorerTab(currentUserId, projectId, tab.id),
          );
          setExplorerInstances((prev) => {
            const byId = new Map(prev.map((e) => [e.id, e]));
            for (const e of ownedExplorers) byId.set(e.id, e);
            return [...byId.values()];
          });
        }
      })
      .catch(() => { /* offline / unauthenticated: keep localStorage state */ })
      .finally(() => { if (!cancelled) setProjHydrated(true); });
    return () => { cancelled = true; };
    // This is a one-time hydration for a project. Including the hydrated state
    // itself would turn the server read into a write/read feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, projectId]);

  // Debounced write-back after hydration. The backend session row remains the
  // source of truth for whether a CLI exists; this state preserves presentation
  // order, active selection and explicit hidden tabs.
  useEffect(() => {
    if (!projHydrated) return;
    const h = setTimeout(() => {
      const terminalLabels: Record<string, string> = {};
      for (const t of terminalInstances) {
        const cl = t.customLabel?.trim();
        if (cl) terminalLabels[t.id] = cl;
      }
      api.userState.set(`project:${projectId}`, {
        terminalLabels,
        terminalInstances,
        activeTerminalId,
        hiddenSessionIds: [...closedSessionIds.current],
        explorerInstances,
        webPageInstances,
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(h);
  }, [projHydrated, projectId, terminalInstances, activeTerminalId, closedIdsVersion, explorerInstances, webPageInstances]);

  // An open tab is a durable promise to the user: if its terminal container
  // vanished while the dashboard/server was unavailable, reopen the exact
  // native Claude/Codex conversation as soon as project state is hydrated.
  // Cancelled sessions are excluded because cancellation is an explicit stop.
  useEffect(() => {
    if (!projHydrated || !sessionsData) return;
    const canonicalOpenIds = canonicalOpenSessionIdsRef.current;
    if (!canonicalOpenIds) return;
    const openIds = new Set(terminalInstances.map((terminal) => terminal.id));
    for (const session of sessionsData.sessions) {
      if (!shouldAutoRestoreSession(session, projectId, openIds, canonicalOpenIds)) continue;
      if (autoResumeAttemptsRef.current.has(session.id)) continue;
      autoResumeAttemptsRef.current.add(session.id);
      api.sessions.resume(session.id, true)
        .then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }))
        .catch((err) => console.error(`Failed to auto-restore session ${session.id}:`, err));
    }
  }, [projHydrated, projectId, sessionsData, terminalInstances, queryClient]);

  function handleSessionCreated(sessionId: string, _projectName?: string, mode?: 'session' | 'terminal') {
    locallyCreatedSessionIds.current.add(sessionId);
    canonicalOpenSessionIdsRef.current?.add(sessionId);
    const isTerminal = mode === 'terminal';
    setTerminalInstances((prev) => {
      if (prev.some((t) => t.id === sessionId)) return prev;
      const prefix = isTerminal ? 'Terminal' : 'Session';
      const count = prev.filter(t => t.label.startsWith(prefix)).length + 1;
      return [...prev, { id: sessionId, label: `${prefix} ${count}` }];
    });
    setActiveTerminalId(sessionId);
    setActiveWebPageId(null);
    setShowLauncher(false);
  }

  // Open a Claude history conversation: jump to / open its live session if one
  // is currently running, otherwise resume from the conversation log.
  async function handleOpenHistorySession(item: ClaudeHistoryItem) {
    if (item.liveSessionId && ['running', 'detached', 'pending'].includes(item.liveStatus || '')) {
      const id = item.liveSessionId;
      if (terminalInstances.some((t) => t.id === id)) {
        setActiveTerminalId(id);
        setShowLauncher(false);
        setActiveWebPageId(null);
        setActiveMode('terminal');
        focusTerminalById(id);
      } else {
        unhideSession(id);
        setActiveMode('terminal');
      }
      return;
    }
    // Resume from the on-disk conversation log → fresh live session.
    try {
      setResumingUuid(item.uuid);
      const res = await api.sessions.resumeClaude({ project_id: projectId, claude_session_id: item.uuid, title: item.title });
      const newId = res.session?.id;
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['claude-history', projectId] });
      if (newId) {
        handleSessionCreated(newId, undefined, 'session');
        setActiveMode('terminal');
      }
    } catch (err) {
      console.error('Failed to resume Claude session:', err);
      alert(`续上失败: ${(err as Error).message}`);
    } finally {
      setResumingUuid(null);
    }
  }

  async function handleDeleteHistorySession(item: ClaudeHistoryItem) {
    try {
      await api.sessions.deleteClaudeHistory(item.uuid, projectId);
      queryClient.invalidateQueries({ queryKey: ['claude-history', projectId] });
    } catch (err) {
      console.error('Failed to delete Claude history:', err);
      alert(`删除失败: ${(err as Error).message}`);
    }
  }

  // Track when an adopt is in flight to suppress the hidden list during the race
  const adoptingRef = useRef(false);

  // Compute hidden sessions (user hid the tab but process is still running)
  // Use all sessions (not projectSessions) because project_id filtering may not match
  // closedSessionIds is already scoped to this ProjectView instance
  const hiddenSessions = useMemo(() => {
    void closedIdsVersion; // depend on version counter so this recomputes when sessions are hidden/unhidden
    // Suppress hidden list while adopt is in flight (avoids race with SSE-driven refetch)
    if (adoptingRef.current) return [];
    if (closedSessionIds.current.size === 0) return [];
    // Only show hidden sessions for this project, and exclude sessions with open tabs
    const openTabIds = new Set(terminalInstances.map((t) => t.id));
    return projectSessions.filter((session) =>
      closedSessionIds.current.has(session.id) &&
      !openTabIds.has(session.id)
    );
  }, [projectSessions, closedIdsVersion, terminalInstances]);

  // Recently-ended sessions for this project that aren't already open as tabs —
  // reopening one restores its last screen (from the snapshot) and offers Resume.
  const endedSessions = useMemo(() => {
    const openTabIds = new Set(terminalInstances.map((t) => t.id));
    return (sessionsData?.sessions || [])
      .filter((session) =>
        session.project_id === projectId &&
        (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') &&
        !openTabIds.has(session.id)
      )
      .sort((a, b) => (b.completed_at || b.created_at || '').localeCompare(a.completed_at || a.created_at || ''))
      .slice(0, 12);
  }, [sessionsData, projectId, terminalInstances]);

  function unhideSession(id: string) {
    closedSessionIds.current.delete(id);
    setClosedIdsVersion((v) => v + 1);

    // Find the session data to determine its type and re-add the tab
    const allSessions = sessionsData?.sessions || [];
    const session = allSessions.find((candidate) => candidate.id === id);
    if (session) {
      setTerminalInstances((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task?.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const count = prev.filter((t) => t.label.startsWith(prefix)).length + 1;
        const result = [...prev, { id, label: `${prefix} ${count}` }];
        const order = (l: string) => l.startsWith('Session') ? 0 : l.startsWith('Agent') ? 1 : 2;
        result.sort((a, b) => order(a.label) - order(b.label));
        return result;
      });
      setActiveTerminalId(id);
      setShowLauncher(false);
    }

    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    setShowAdoptMenu(false);
  }

  function unhideAll() {
    const ids = [...closedSessionIds.current];
    closedSessionIds.current.clear();
    setClosedIdsVersion((v) => v + 1);

    const allSessions = sessionsData?.sessions || [];
    setTerminalInstances((prev) => {
      const updated = [...prev];
      for (const id of ids) {
        if (updated.some((t) => t.id === id)) continue;
        const session = allSessions.find((candidate) => candidate.id === id && (candidate.status === 'running' || candidate.status === 'detached'));
        if (!session) continue;
        const isTerminal = session.task === 'Terminal';
        const isAgent = session.task?.startsWith('Agent (');
        const prefix = isTerminal ? 'Terminal' : isAgent ? 'Agent' : 'Session';
        const count = updated.filter((t) => t.label.startsWith(prefix)).length + 1;
        updated.push({ id, label: `${prefix} ${count}` });
      }
      const order = (l: string) => l.startsWith('Session') ? 0 : l.startsWith('Agent') ? 1 : 2;
      updated.sort((a, b) => order(a.label) - order(b.label));
      return updated;
    });

    setShowLauncher(false);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
    setShowAdoptMenu(false);
  }

  // Permanently delete an ended session record (row + events + snapshot).
  async function deleteEndedSession(id: string) {
    try {
      await api.sessions.deleteRecord(id);
    } catch (err) {
      console.error('Failed to delete session record:', err);
    }
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  const [showAdoptMenu, setShowAdoptMenu] = useState(false);
  const adoptMenuRef = useRef<HTMLDivElement>(null);
  const adoptDropdownRef = useRef<HTMLDivElement>(null);

  // Close adopt menu on outside click
  useEffect(() => {
    if (!showAdoptMenu) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (adoptMenuRef.current?.contains(target)) return;
      if (adoptDropdownRef.current?.contains(target)) return;
      setShowAdoptMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAdoptMenu]);

  async function handleAdoptSession(socketPath: string) {
    setShowAdoptMenu(false);
    adoptingRef.current = true;
    try {
      const result = await api.sessions.adopt(socketPath, projectId);
      const sid = result.session.id;

      // Clear from hidden sessions so it doesn't show up in the adopt dropdown
      closedSessionIds.current.delete(sid);
      setClosedIdsVersion((v) => v + 1);

      // Refresh sessions data so projectSessions includes the re-adopted session
      // (needed for hideCursor prop which enables the force-resize redraw trick)
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['discoverable-sessions'] });

      // If the tab already exists (re-adopting a popped-out session),
      // force remount the Terminal component to reset its WebSocket state
      const existing = terminalInstances.find((t) => t.id === sid);
      if (existing) {
        setTerminalInstances((prev) =>
          prev.map((t) => (t.id === sid ? { ...t, id: sid + '_readopting' } : t))
        );
        setTimeout(() => {
          setTerminalInstances((prev) =>
            prev.map((t) => (t.id === sid + '_readopting' ? { ...t, id: sid } : t))
          );
          setActiveTerminalId(sid);
        }, 100);
      } else {
        handleSessionCreated(sid, undefined, 'session');
      }
    } catch (err) {
      console.error('Failed to adopt session:', err);
    } finally {
      adoptingRef.current = false;
      setClosedIdsVersion((v) => v + 1); // force recompute now that adopt is done
    }
  }

  function removeTerminalTabFromState(id: string) {
    const remaining = terminalInstances.filter((terminal) => terminal.id !== id);
    const nextActiveTerminalId = activeTerminalId === id
      ? remaining[0]?.id ?? null
      : activeTerminalId;
    const nextShowLauncher = activeTerminalId === id && remaining.length === 0
      ? true
      : activeTerminalId === id
        ? false
        : showLauncher;

    closedSessionIds.current.add(id);
    canonicalOpenSessionIdsRef.current?.delete(id);
    locallyCreatedSessionIds.current.delete(id);
    delete terminalLabelsRef.current[id];
    setClosedIdsVersion((v) => v + 1);
    setTerminalInstances(remaining);
    setActiveTerminalId(nextActiveTerminalId);
    setShowLauncher(nextShowLauncher);

    // A process/browser crash must not let the previous local or server
    // snapshot resurrect this tab on the next startup. Persist this user action
    // immediately; the normal debounced writer will still reconcile later UI.
    const hiddenSessionIds = [...closedSessionIds.current];
    const terminalLabels: Record<string, string> = {};
    for (const terminal of remaining) {
      const customLabel = terminal.customLabel?.trim();
      if (customLabel) terminalLabels[terminal.id] = customLabel;
    }
    persistState(currentUserId, projectId, {
      activeMode,
      explorerInstances,
      activeExplorerId,
      terminalInstances: remaining,
      activeTerminalId: nextActiveTerminalId,
      hiddenSessionIds,
      webPageInstances,
      activeWebPageId,
      showLauncher: nextShowLauncher,
    });
    api.userState.set(`project:${projectId}`, {
      terminalLabels,
      terminalInstances: remaining,
      activeTerminalId: nextActiveTerminalId,
      hiddenSessionIds,
      explorerInstances,
      webPageInstances,
    }).catch((err) => console.error('Failed to persist closed terminal tab:', id, err));
  }

  function closeTerminal(id: string) {
    removeTerminalTabFromState(id);
    api.sessions.kill(id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['sessions'] }))
      .catch((err) => console.error('Failed to kill session:', id, err));
  }

  function closeTerminalTab(id: string) {
    removeTerminalTabFromState(id);
    queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  async function reconnectTerminal(oldId: string) {
    try {
      const { session: oldSession } = await api.sessions.get(oldId).catch(() => ({ session: null }));
      if (oldSession?.status === 'detached') {
        await api.sessions.reconnect(oldId);
        setTerminalInstances((prev) =>
          prev.map((t) => (t.id === oldId ? { ...t, id: oldId + '_reconnecting' } : t))
        );
        setTimeout(() => {
          setTerminalInstances((prev) =>
            prev.map((t) => (t.id === oldId + '_reconnecting' ? { ...t, id: oldId } : t))
          );
          setActiveTerminalId(oldId);
        }, 50);
        return;
      }

      // Ended session (completed/failed/cancelled): resume it in place — reuses
      // the same id and reloads the native Claude/Codex conversation. Once it's running again,
      // the tab re-renders from the ended (HistoryViewer) view to a live Terminal.
      if (oldSession && ['completed', 'failed', 'cancelled'].includes(oldSession.status)) {
        const resumable = oldSession.cli_type === 'codex'
          ? !!oldSession.codex_session_id
          : !!oldSession.claude_session_id;
        if (resumable) {
          await api.sessions.resume(oldId);
          setActiveTerminalId(oldId);
          queryClient.invalidateQueries({ queryKey: ['sessions'] });
          return;
        }
        // Not resumable (plain terminal or an old uncaptured CLI session) —
        // fall through to a fresh session.
      }

      const result = await api.sessions.create({
        project_path: projectPath,
        task: 'Interactive session',
      });
      const newId = result.session.id;
      setTerminalInstances((prev) =>
        prev.map((t) => (t.id === oldId ? { ...t, id: newId } : t))
      );
      setActiveTerminalId(newId);
    } catch (err) {
      console.error('Failed to reconnect terminal:', err);
    }
  }

  function addExplorer() {
    const id = `${currentUserId}-${projectId}-explorer-${nextExplorerSeq++}`;
    const label = `Explorer ${explorerInstances.length + 1}`;
    setExplorerInstances((prev) => [...prev, { id, label }]);
    setActiveExplorerId(id);
  }

  function closeExplorer(id: string) {
    if (explorerInstances.length <= 1) return;
    if (!confirmDiscardExplorer(id)) return;
    setExplorerInstances((prev) => prev.filter((e) => e.id !== id));
    if (activeExplorerId === id) {
      setActiveExplorerId(explorerInstances[0].id === id ? explorerInstances[1]?.id : explorerInstances[0].id);
    }
  }

  let nextWebPageSeq = webPageInstances.length + 1;

  function addWebPage(url: string) {
    const id = `${currentUserId}-${projectId}-webpage-${Date.now()}`;
    const label = `Web ${nextWebPageSeq++}`;
    setWebPageInstances((prev) => [...prev, { id, label, url }]);
    setActiveWebPageId(id);
    setShowLauncher(false);
  }

  function closeWebPage(id: string) {
    setWebPageInstances((prev) => prev.filter((w) => w.id !== id));
    if (activeWebPageId === id) {
      const remaining = webPageInstances.filter((w) => w.id !== id);
      if (remaining.length > 0) {
        setActiveWebPageId(remaining[0].id);
      } else {
        setActiveWebPageId(null);
        // If no terminals either, show launcher
        if (terminalInstances.length === 0) {
          setShowLauncher(true);
        }
      }
    }
  }

  // Focus a terminal's xterm textarea after switching views
  function focusTerminalById(sessionId: string) {
    // Terminals stay mounted, sized and connected, so switching only needs to wait
    // for the visibility flip to commit before focusing — one frame, not a fixed 100ms.
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('agentmanager:focus-terminal', {
        detail: { sessionId },
      }));
    });
  }

  function handleWebPageCreated(url: string) {
    addWebPage(url);
  }

  // Cross-tab refresh coordination
  const [gitSavedFile, setGitSavedFile] = useState<FileRefreshRequest | null>(null);
  const [explorerSavedFile, setExplorerSavedFile] = useState<string | null>(null);

  const handleGitFileSaved = useCallback((filePath: string) => {
    setGitSavedFile((previous) => ({ path: filePath, revision: (previous?.revision ?? 0) + 1 }));
  }, []);

  const handleExplorerFileSaved = useCallback((filePath: string) => {
    setExplorerSavedFile(filePath);
  }, []);

  // "Reveal in explorer" — switch mode and tell the active explorer to open the file
  const [openInExplorerRequest, setOpenInExplorerRequest] = useState<{ path: string; key: number } | null>(null);
  const handleOpenInExplorer = useCallback((filePath: string) => {
    setActiveMode('explorer');
    setOpenInExplorerRequest({ path: filePath, key: Date.now() });
  }, []);

  const prevMode = useRef(activeMode);
  useEffect(() => {
    if (activeMode === 'git' && prevMode.current !== 'git' && explorerSavedFile) {
      setExplorerSavedFile(null);
    }
    prevMode.current = activeMode;
  }, [activeMode, explorerSavedFile]);

  // Sub-tab bar for terminal and explorer modes
  const showSubTabs = activeMode === 'terminal' || activeMode === 'explorer';

  return (
    <div className="h-full flex">
      {/* Icon sidebar */}
      <div
        className="flex flex-col items-center py-2 gap-1 shrink-0"
        style={{
          width: 48,
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border)',
        }}
      >
        {sidebarButtons.map(({ id, icon: Icon, title }) => {
          const isActive = activeMode === id;
          return (
            <button
              key={id}
              onClick={() => setActiveMode(id)}
              title={title}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: 36,
                height: 36,
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              <Icon className="w-5 h-5" />
            </button>
          );
        })}

      </div>

      {/* Main content area */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Sub-tab bar */}
        {showSubTabs && (
          <div
            className="flex items-center gap-0.5 px-2 py-1 shrink-0 overflow-x-auto"
            style={{
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
            }}
          >
            {activeMode === 'terminal' && (
              <>
                {/* Home tab — always first */}
                <button
                  onClick={() => { setShowLauncher(true); setActiveWebPageId(null); }}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md shrink-0 transition-colors text-xs font-medium"
                  style={{
                    color: showLauncher ? 'var(--accent)' : 'var(--text-secondary)',
                    background: showLauncher ? 'var(--bg-tertiary)' : 'transparent',
                  }}
                >
                  <Home className="w-3 h-3" />
                  Home
                </button>

                {/* Terminal session sub-tabs */}
                {terminalInstances.map((inst) => {
                  const isActive = !showLauncher && !activeWebPageId && inst.id === activeTerminalId;
                  const session = sessionLookup.get(inst.id);
                  // Status signal light — a leaf component subscribes to just this
                  // session's live state, so a state tick doesn't re-render the view.
                  const sigSession = allSessionLookup.get(inst.id);
                  const isTerminal = inst.label.startsWith('Terminal');
                  const isAgent = inst.label.startsWith('Agent');
                  const isCodex = session?.cli_type === 'codex';
                  const tabIcon = isTerminal ? (
                    <TerminalSquare className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />
                  ) : (
                    <>
                      {isCodex ? (
                        <CodexIcon className="w-3 h-3 shrink-0" style={{ color: '#7A9DFF' }} />
                      ) : (
                        <ClaudeIcon className="w-3 h-3 shrink-0" style={{ color: '#D97757' }} />
                      )}
                      {isAgent ? (
                        <Bot className="w-3 h-3 shrink-0" style={{ color: '#ef4444' }} />
                      ) : (
                        <Zap className="w-3 h-3 shrink-0" style={{ color: '#60a5fa' }} />
                      )}
                    </>
                  );
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      {sigSession && (
                        <span className="pl-2 flex items-center">
                          <LiveSessionSignalDot session={sigSession} active={isActive} />
                        </span>
                      )}
                      {editingTerminalId === inst.id ? (
                        <div className="flex items-center gap-1.5 pl-3 pr-1 py-1">
                          {tabIcon}
                          <input
                            ref={renameInputRef}
                            autoFocus
                            value={editingTerminalValue}
                            onChange={(e) => setEditingTerminalValue(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onBlur={() => {
                              // Terminals steal focus on session updates — grab it back if we're
                              // still editing. Real exits go through Enter / Esc / outside-mousedown.
                              requestAnimationFrame(() => renameInputRef.current?.focus());
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitTerminalRename(inst.id); }
                              else if (e.key === 'Escape') { e.preventDefault(); cancelTerminalRename(); }
                            }}
                            className="bg-transparent outline-none border-b text-xs font-medium w-[110px]"
                            style={{ color: 'var(--text-primary)', borderColor: 'var(--accent)' }}
                          />
                        </div>
                      ) : (
                        <button
                          onClick={(e) => {
                            if (e.detail > 1) return; // 2nd click of a double-click → that's a rename
                            setActiveTerminalId(inst.id);
                            setActiveWebPageId(null);
                            setShowLauncher(false);
                            // Focus the terminal after switching tabs.
                            focusTerminalById(inst.id);
                          }}
                          onDoubleClick={() => beginTerminalRename(inst)}
                          className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                          style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                          title="双击重命名"
                        >
                          {tabIcon}
                          <span className="truncate">{inst.customLabel?.trim() || inst.label}</span>
                          <SessionActivityAge session={sigSession} />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const type = inst.label.startsWith('Terminal') ? 'terminal'
                            : inst.label.startsWith('Agent') ? 'agent'
                            : 'session';
                          setCloseConfirm({ id: inst.id, label: inst.label, type });
                        }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                        style={{ color: 'var(--text-secondary)' }}
                        title="Close session"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}

                {/* New session/agent/terminal — opens the existing launcher panel */}
                <button
                  onClick={() => { setShowLauncher(true); setActiveWebPageId(null); setActiveTerminalId(null); }}
                  className="flex items-center justify-center rounded-md shrink-0 transition-colors"
                  style={{ width: 28, height: 28, color: 'var(--text-secondary)', background: 'transparent' }}
                  title="新建 Session / Agent / Terminal"
                >
                  <Plus className="w-4 h-4" />
                </button>

                {/* Adopt external session button — on-demand scan */}
                <div ref={adoptMenuRef}>
                  <button
                    onClick={async () => {
                      if (showAdoptMenu) {
                        setShowAdoptMenu(false);
                      } else {
                        await refetchDiscoverable();
                        setShowAdoptMenu(true);
                      }
                    }}
                    className="flex items-center gap-1 px-2 rounded-md shrink-0 transition-colors text-xs"
                    title={hiddenSessions.length > 0 ? `${hiddenSessions.length} hidden session(s) — click to restore` : endedSessions.length > 0 ? `${endedSessions.length} recent ended session(s) — click to reopen` : 'Scan for external sessions to adopt'}
                    style={{
                      height: 28,
                      color: hiddenSessions.length > 0 ? '#f59e0b' : showAdoptMenu ? 'var(--warning, #f59e0b)' : 'var(--text-secondary)',
                      background: showAdoptMenu ? 'var(--bg-tertiary)' : 'transparent',
                    }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    {hiddenSessions.length > 0 && (
                      <span
                        className="text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center"
                        style={{ background: '#f59e0b', color: '#000' }}
                      >
                        {hiddenSessions.length}
                      </span>
                    )}
                  </button>

                  {showAdoptMenu && createPortal(
                    <div
                      ref={adoptDropdownRef}
                      className="fixed rounded-lg shadow-lg border z-[9999] min-w-[280px] max-w-[400px] py-1"
                      style={{
                        background: 'var(--bg-primary)',
                        borderColor: 'var(--border)',
                        top: (adoptMenuRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                        left: adoptMenuRef.current?.getBoundingClientRect().left ?? 0,
                      }}
                    >
                      {/* Hidden sessions (tabs the user hid but processes still running) */}
                      {hiddenSessions.length > 0 && (
                        <>
                          <div className="flex items-center justify-between px-3 py-1.5">
                            <span
                              className="text-[10px] font-semibold uppercase tracking-wider"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              Hidden
                            </span>
                            {hiddenSessions.length > 1 && (
                              <button
                                onClick={unhideAll}
                                className="text-[10px] font-medium px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                style={{ color: 'var(--accent)', background: 'var(--bg-tertiary)' }}
                              >
                                Restore All
                              </button>
                            )}
                          </div>
                          {hiddenSessions.map((s) => {
                            const isTerminal = s.task === 'Terminal';
                            const isAgent = s.task?.startsWith('Agent (');
                            const isCodex = s.cli_type === 'codex';
                            const cliLabel = isCodex ? 'Codex' : 'Claude';
                            const typeLabel = isTerminal ? 'Terminal' : `${cliLabel} ${isAgent ? 'Agent' : 'Session'}`;
                            const typeColor = isTerminal ? '#f59e0b' : isCodex ? '#10b981' : isAgent ? '#ef4444' : '#60a5fa';
                            return (
                              <button
                                key={s.id}
                                onClick={() => unhideSession(s.id)}
                                className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                                    style={{ background: `${typeColor}20`, color: typeColor }}
                                  >
                                    {typeLabel}
                                  </span>
                                  <span className="truncate">{s.task === 'Terminal' ? 'Interactive shell' : s.task?.slice(0, 50)}</span>
                                </div>
                                <div className="truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                  {s.status} · {s.created_at ? new Date(s.created_at + (s.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString() : 'unknown'}
                                </div>
                              </button>
                            );
                          })}
                        </>
                      )}

                      {/* Divider between sections */}
                      {hiddenSessions.length > 0 && discoverableSessions.length > 0 && (
                        <div className="mx-3 my-1" style={{ height: 1, background: 'var(--border)' }} />
                      )}

                      {/* External sessions (tmux sessions not tracked by AgentManager) */}
                      <div
                        className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        External
                      </div>
                      {discoverableSessions.length === 0 ? (
                        <div
                          className="px-3 py-2 text-xs"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          No external sessions found
                        </div>
                      ) : (
                        discoverableSessions.map((s) => {
                          const isTerminal = !s.task || s.task === 'Terminal';
                          const isAgent = s.task?.startsWith('Agent (');
                          const cliLabel = s.cliType === 'codex' ? 'Codex' : s.cliType === 'claude' ? 'Claude' : '';
                          const typeLabel = isTerminal ? 'Terminal' : `${cliLabel ? cliLabel + ' ' : ''}${isAgent ? 'Agent' : 'Session'}`;
                          const typeColor = isTerminal ? '#f59e0b' : s.cliType === 'codex' ? '#7A9DFF' : '#60a5fa';
                          return (
                            <button
                              key={s.socketPath}
                              onClick={() => handleAdoptSession(s.socketPath)}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors"
                              style={{ color: 'var(--text-primary)' }}
                            >
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                                  style={{ background: `${typeColor}20`, color: typeColor }}
                                >
                                  {typeLabel}
                                </span>
                                <span className="truncate">{s.task?.slice(0, 60) || 'Session'}</span>
                              </div>
                              <div className="truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                {s.startedAt ? new Date(s.startedAt + (String(s.startedAt).endsWith('Z') ? '' : 'Z')).toLocaleString() : 'unknown time'}
                              </div>
                            </button>
                          );
                        })
                      )}

                      {/* Ended / recent sessions — reopen to restore the last screen + resume */}
                      {endedSessions.length > 0 && (
                        <>
                          <div className="mx-3 my-1" style={{ height: 1, background: 'var(--border)' }} />
                          <div
                            className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            Ended / Recent
                          </div>
                          {endedSessions.map((s) => {
                            const isTerminal = s.task === 'Terminal';
                            const isAgent = s.task?.startsWith('Agent (');
                            const isCodex = s.cli_type === 'codex';
                            const cliLabel = isCodex ? 'Codex' : 'Claude';
                            const typeLabel = isTerminal ? 'Terminal' : `${cliLabel} ${isAgent ? 'Agent' : 'Session'}`;
                            const typeColor = isTerminal ? '#f59e0b' : isCodex ? '#10b981' : isAgent ? '#ef4444' : '#60a5fa';
                            const when = s.completed_at || s.created_at;
                            return (
                              <div key={s.id} className="flex items-center group/ended hover:bg-[var(--bg-tertiary)] transition-colors">
                                <button
                                  onClick={() => unhideSession(s.id)}
                                  className="flex-1 min-w-0 text-left px-3 py-2 text-xs"
                                  style={{ color: 'var(--text-primary)' }}
                                  title="Reopen — restore the last screen and resume"
                                >
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
                                      style={{ background: `${typeColor}20`, color: typeColor }}
                                    >
                                      {typeLabel}
                                    </span>
                                    <span className="truncate">{isTerminal ? 'Interactive shell' : (s.task?.slice(0, 50) || 'Session')}</span>
                                  </div>
                                  <div className="truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                                    {s.status} · {when ? new Date(when + (when.endsWith('Z') ? '' : 'Z')).toLocaleString() : 'unknown'}
                                  </div>
                                </button>
                                <button
                                  onClick={() => deleteEndedSession(s.id)}
                                  className="px-2 self-stretch opacity-0 group-hover/ended:opacity-70 hover:!opacity-100 transition-opacity"
                                  style={{ color: 'var(--error)' }}
                                  title="Delete from history"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>,
                    document.body
                  )}
                </div>

                {/* Web page tabs — shown alongside terminal tabs */}
                {webPageInstances.length > 0 && (
                  <div
                    className="mx-1 self-stretch"
                    style={{ width: 1, background: 'var(--border)' }}
                  />
                )}
                {webPageInstances.map((inst) => {
                  const isActive = !showLauncher && activeWebPageId === inst.id && !activeTerminalId;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <button
                        onClick={() => {
                          setActiveWebPageId(inst.id);
                          setActiveTerminalId(null);
                          setShowLauncher(false);
                        }}
                        className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                        style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        <Globe className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                        <span className="truncate max-w-[120px]">{inst.label}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          closeWebPage(inst.id);
                        }}
                        className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                        style={{ color: 'var(--text-secondary)' }}
                        title="Close web page"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </>
            )}

            {activeMode === 'explorer' && (
              <>
                {explorerInstances.map((inst) => {
                  const isActive = inst.id === activeExplorerId;
                  const canClose = explorerInstances.length > 1;
                  return (
                    <div
                      key={inst.id}
                      className="flex items-center gap-0.5 rounded-md shrink-0 group"
                      style={{ background: isActive ? 'var(--bg-tertiary)' : 'transparent' }}
                    >
                      <button
                        onClick={() => setActiveExplorerId(inst.id)}
                        className="flex items-center gap-1.5 pl-3 pr-1 py-1 text-xs font-medium transition-colors"
                        style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      >
                        <FolderTree className="w-3 h-3 shrink-0" style={{ color: 'var(--accent)' }} />
                        <span className="truncate">{inst.label}</span>
                      </button>
                      {canClose && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeExplorer(inst.id);
                          }}
                          className="p-0.5 rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity mr-1"
                          style={{ color: 'var(--text-secondary)' }}
                          title="Close"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  onClick={addExplorer}
                  className="flex items-center justify-center rounded-md shrink-0 transition-colors"
                  title="New Explorer"
                  style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Panel content */}
        <div className="flex-1 min-h-0 relative">
          {/* Terminal mode */}
          {activeMode === 'terminal' && (
            <>
              {/* Show launcher when requested or no sessions */}
              {(showLauncher || (terminalInstances.length === 0 && webPageInstances.length === 0)) && project && (
                <div className="h-full absolute inset-0">
                  <SessionLauncher
                    project={project}
                    onSessionCreated={handleSessionCreated}
                    onWebPageCreated={handleWebPageCreated}
                  />
                </div>
              )}

              {/* Terminal instances stay mounted so tab switches preserve terminal state. */}
              <div className="h-full absolute inset-0" style={{ pointerEvents: 'none' }}>
                {terminalInstances.map((term) => {
                  const isSingleActive = !showLauncher && !activeWebPageId && activeTerminalId === term.id;
                  const termVisible = isSingleActive && active;

                  if (termVisible) mountedTerminals.current.add(term.id);
                  const shouldMount = mountedTerminals.current.has(term.id);

                  const endedSession = allSessionLookup.get(term.id);
                  const isEnded = !!endedSession && (
                    endedSession.status === 'completed'
                    || endedSession.status === 'failed'
                    || endedSession.status === 'cancelled'
                  );
                  const canResume = isEnded && (endedSession!.cli_type === 'codex'
                    ? !!endedSession!.codex_session_id
                    : !!endedSession!.claude_session_id);

                  return (
                    <div
                      key={term.id}
                      className="h-full absolute inset-0"
                      style={{
                        visibility: isSingleActive ? 'visible' : 'hidden',
                        pointerEvents: isSingleActive ? 'auto' : 'none',
                        zIndex: isSingleActive ? 1 : 0,
                      }}
                    >
                      {shouldMount && (isEnded ? (
                        <div className="relative h-full w-full">
                          <HistoryViewer
                            sessionId={term.id}
                            title="Session ended — last screen"
                            closeTitle="Close tab"
                            onResume={canResume ? () => reconnectTerminal(term.id) : undefined}
                            onClose={() => closeTerminalTab(term.id)}
                          />
                        </div>
                      ) : (
                        <Terminal
                          sessionId={term.id}
                          visible={termVisible}
                          suspended={terminalsSuspended || !warmTerminalIds.has(term.id)}
                          hideCursor={projectSessions.find((session) => session.id === term.id)?.task !== 'Terminal' && projectSessions.some((session) => session.id === term.id)}
                          cliType={sessionLookup.get(term.id)?.cli_type as 'claude' | 'codex' | undefined}
                          onReconnect={() => reconnectTerminal(term.id)}
                          onPopOut={() => closeTerminalTab(term.id)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Web page instances */}
          {activeMode === 'terminal' && webPageInstances.map((wp) => {
            const isActiveWP = activeWebPageId === wp.id && !showLauncher;
            return (
              <div
                key={wp.id}
                className="h-full absolute inset-0"
                style={{
                  visibility: isActiveWP ? 'visible' : 'hidden',
                  pointerEvents: isActiveWP ? 'auto' : 'none',
                  zIndex: isActiveWP ? 2 : 0,
                }}
              >
                <WebPageView
                  url={wp.url}
                  visible={isActiveWP && active}
                  onUrlChange={(newUrl) => {
                    setWebPageInstances((prev) =>
                      prev.map((w) => (w.id === wp.id ? { ...w, url: newUrl } : w))
                    );
                  }}
                />
              </div>
            );
          })}

          {/* Explorer instances */}
          {explorerInstances.map((expl) => (
            <div
              key={expl.id}
              className="h-full absolute inset-0"
              style={{
                display: activeMode === 'explorer' && activeExplorerId === expl.id ? 'block' : 'none',
              }}
            >
              <FileExplorer
                rootPath={projectPath}
                instanceId={expl.id}
                active={active && activeMode === 'explorer' && activeExplorerId === expl.id}
                refreshFileRequest={gitSavedFile}
                openFileRequest={expl.id === activeExplorerId ? openInExplorerRequest : null}
                onFileSaved={handleExplorerFileSaved}
              />
            </div>
          ))}

          {/* Events panel */}
          {/* Git panel */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'git' ? 'block' : 'none' }}
          >
            <GitPanel projectPath={projectPath} isVisible={activeMode === 'git'} onFileSaved={handleGitFileSaved} onOpenInExplorer={handleOpenInExplorer} />
          </div>

          {/* Session history panel */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'history' ? 'block' : 'none' }}
          >
            {activeMode === 'history' && (
              <SessionHistoryPanel
                projectId={projectId}
                openTabIds={new Set(terminalInstances.map((t) => t.id))}
                busyUuid={resumingUuid}
                onOpen={handleOpenHistorySession}
                onDelete={handleDeleteHistorySession}
              />
            )}
          </div>

          {/* Project skills panel */}
          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'skills' ? 'block' : 'none' }}
          >
            {activeMode === 'skills' && (
              <ProjectSkillsPanel projectId={projectId} />
            )}
          </div>

          <div
            className="h-full absolute inset-0"
            style={{ display: activeMode === 'scheduled' ? 'block' : 'none' }}
          >
            {activeMode === 'scheduled' && <ScheduledTasksPanel projectId={projectId} sessionTabs={terminalInstances} />}
          </div>
        </div>
      </div>

      {/* Close tab confirmation modal */}
      {closeConfirm && (
        <CloseTabModal
          label={closeConfirm.label}
          type={closeConfirm.type}
          onHide={() => {
            closeTerminalTab(closeConfirm.id);
            setCloseConfirm(null);
          }}
          onKill={() => {
            closeTerminal(closeConfirm.id);
            setCloseConfirm(null);
          }}
          onCancel={() => setCloseConfirm(null)}
        />
      )}
    </div>
  );
}
