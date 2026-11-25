import {AgentIcon} from './AgentIcon';
import {sessionAgent,agentNativeId,agentSupports} from '../lib/agents';
import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { Monitor, FolderTree, GitBranch, Plus, X, Download, TerminalSquare, History, Sparkles, CalendarClock, Globe, Trash2, Loader2, List, PanelLeft, Search, CornerDownRight } from 'lucide-react';
import { Terminal } from './Terminal';
import { SessionWorkspacePane } from './SessionWorkspacePane';
import { SessionTabSwitcher } from './SessionTabSwitcher';
import { FileExplorer, type FileRefreshRequest } from './FileExplorer';
import { droppedFiles, isFileDrag, type FileUploadRequest } from '../lib/file-upload';
import { GitPanel } from './GitPanel';
import { DeepSeekHarnessFrame } from './DeepSeekHarnessFrame';
import type { HarnessModelSelection } from '../lib/deepseek-harness';
import { ProjectSessionCreateDialog } from './ProjectSessionCreateDialog';
import { projectOpenModes } from './project-open-modes';
import { api, type Session } from '../lib/api';
import { CloseTabModal } from './CloseTabModal';
import { ConfirmModal } from './ConfirmModal';
import { SessionHistoryPanel } from './SessionHistoryPanel';
import { HistoryViewer } from './HistoryViewer';
import { SessionResumeFeedback } from './SessionResumeFeedback';
import { useSessionResume } from '../lib/use-session-resume';
import { ProjectSkillsPanel } from './ProjectSkillsPanel';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { LiveSessionSignalDot } from '../lib/session-signal';
import { SessionTabBadges, SessionTabLabel } from '../lib/session-activity';
import { sessionActivityMs } from '../lib/session-activity-model';
import { sessionTabTree } from '../lib/session-tab-tree';
import { useStreamStore } from '../lib/websocket';
import { promoteWarmTerminal, TERMINAL_COLD_DELAY_MS } from '../lib/warm-terminal-pool';
import {
  reconcileHydratedTerminalInstances, uniqueTabName, nextDefaultTabName, automaticSessionTabName, applySessionTabTasks,
  type TerminalInstance,
} from '../lib/project-session-state';
import { moveItemByKey, orderItemsByKeys } from '../lib/reorder';
import type {ConversationFocus} from '../lib/notifications';

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
  configuredHarnessUrl?: string;
  configuredHarnessModel?: HarnessModelSelection;
  focusHarness?: boolean;
  onFocusHarnessHandled?: () => void;
  conversationTarget?:{sessionId:string;focus:ConversationFocus}|null;
  notificationUnread?:Record<string,number>;
  toolbarHost?: HTMLElement | null;
  sessionNavigationHost?: HTMLElement | null;
  sessionNavigationExpanded?: boolean;
  onSetSessionNavigationExpanded?: (projectId: string, expanded: boolean) => void;
  onActivateProject?: (projectId: string) => void;
}

const SESSION_PREVIEW_LIMIT = 5;
const SESSION_ORDER_REFRESH_MS = 60_000;
/** A restored tab can load independently of expensive list/history enrichment. */
function RestoreSessionRecord({sessionId,projectId,onRestore}:{sessionId:string;projectId:string;onRestore:(session:Session)=>void}) {
  const query=useQuery({queryKey:['session-record',sessionId],queryFn:()=>api.sessions.get(sessionId),retry:false});
  useEffect(()=>{
    const session=query.data?.session;
    if(!session||session.project_id!==projectId)return;
    onRestore(session);
  },[query.data,onRestore,projectId]);
  const failed=query.isError||query.isSuccess;
  return <div role={failed?'alert':'status'} className="flex h-full items-center justify-center gap-2 p-3 text-xs" style={{color:'var(--text-secondary)'}}>
    {failed?<><span>会话暂不可用</span><button type="button" disabled={query.isFetching} onClick={()=>void query.refetch()}>重试</button></>:<><Loader2 size={16} className="animate-spin"/>Loading session…</>}
  </div>;
}

interface ExplorerInstance {
  id: string;
  label: string;
}

type ActiveMode = 'terminal' | 'explorer' | 'events' | 'git' | 'history' | 'skills' | 'scheduled' | 'harness';

const HARNESS_TAB = { id: 'deepseek-harness', label: 'DeepSeek Harness' };

interface HarnessTabState {
  customLabel?: string;
  followingSessionIds?: string[];
}

interface PersistedState {
  activeMode: ActiveMode;
  showAllSessions?: boolean;
  fileTreeOpen?: boolean;
  harnessOpen?: boolean;
  harnessTab?: HarnessTabState;
  explorerInstances: ExplorerInstance[];
  activeExplorerId: string | null;
  terminalInstances: TerminalInstance[];
  activeTerminalId: string | null;
  /** Running sessions whose tabs the user explicitly hid without killing. */
  hiddenSessionIds?: string[];
}

let nextExplorerSeq = 1;

function storageKey(userId: string, projectId: string) {
  return `agentmanager-project-${userId}-${projectId}`;
}

function ownsExplorerTab(userId: string, projectId: string, id: string) {
  return id.startsWith(`${userId}-${projectId}-explorer-`);
}

function sessionTabKind(session: Session): 'session' | 'terminal' {
  if (session.mode === 'terminal' || session.task === 'Terminal') return 'terminal';
  return 'session';
}

function nextSessionTabLabel(session: Session, tabs: TerminalInstance[]): string {
  if(session.native_title?.trim())return uniqueTabName(session.native_title.trim(),tabs,session.id);
  const kind = sessionTabKind(session);
  const taskName = kind === 'session' ? automaticSessionTabName(session.task,tabs,session.id) : null;
  if (taskName) return taskName;
  const prefix = kind === 'terminal' ? 'Terminal' : 'Session';
  return nextDefaultTabName(prefix, tabs);
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

const projectToolButtons = [
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

function ProjectViewImpl({ currentUserId, projectId, projectPath, active = true, terminalsSuspended = false, focusSessionId, onFocusSessionHandled, configuredHarnessUrl = '', configuredHarnessModel, focusHarness, onFocusHarnessHandled, conversationTarget, notificationUnread, toolbarHost, sessionNavigationHost, sessionNavigationExpanded, onSetSessionNavigationExpanded, onActivateProject }: ProjectViewProps) {
  const queryClient = useQueryClient();
  const sessionResume = useSessionResume(projectId);
  const [terminalConnectionVersions, setTerminalConnectionVersions] = useState<Record<string, number>>({});

  // Share project data with the creation dialog.
  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects.list(),
  });
  const project = projectsData?.projects.find((p) => p.id === projectId);
  const harnessUrl = project && project.tool_access !== null && (project.tool_access?.can_session ?? true)
    ? configuredHarnessUrl : '';

  const [restoredRecords,setRestoredRecords]=useState<Record<string,Session>>({});
  const restoreRecord=useCallback((session:Session)=>setRestoredRecords(current=>({...current,[session.id]:session})),[]);

  // Fetch running sessions for this project
  // No refetchInterval — driven by WebSocket invalidation (websocket.ts).
  const { data: sessionsData, isSuccess: sessionsLoaded, dataUpdatedAt: sessionsUpdatedAt } = useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => api.sessions.list(undefined, undefined, signal),
  });
  // Keep the complete project record set available for the project sessions
  // view and for naming/restoring older tabs beyond the global history window.
  const { data: projectHistoryData, isSuccess: projectHistoryLoaded, isFetched: projectHistorySettled, dataUpdatedAt: projectHistoryUpdatedAt } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: ({ signal }) => api.sessions.list(undefined, projectId, signal),
    refetchInterval:(query)=>active && query.state.data?.sessions.some(session=>agentSupports(session,'runtime')) ? 5000 : false,
  });
  // A newly launched session first appears as pending in the global cache.
  // Let the most recently fetched snapshot supply its native binding/status.
  const allSessionLookup = useMemo(() => {
    const global=sessionsData?.sessions||[],project=projectHistoryData?.sessions||[];
    return new Map([...(!projectHistoryLoaded?Object.values(restoredRecords):[]),...(projectHistoryUpdatedAt>=sessionsUpdatedAt?[...global,...project]:[...project,...global])].map(session=>[session.id,session]));
  },[sessionsData,projectHistoryData,sessionsUpdatedAt,projectHistoryUpdatedAt,restoredRecords,projectHistoryLoaded]);
  const projectSessions = useMemo(
    () => [...allSessionLookup.values()].filter(s=>s.project_id===projectId&&isLiveSessionStatus(s.status)),
    [allSessionLookup,projectId],
  );

  // Lookup map for session metadata (cli_type, task, etc.) — used in tab rendering
  const sessionLookup = useMemo(
    () => new Map(projectSessions.map((s) => [s.id, s])),
    [projectSessions]
  );

  const [confirmBulkDeleteEnded, setConfirmBulkDeleteEnded] = useState(false);
  const [bulkDeletingEnded, setBulkDeletingEnded] = useState(false);
  const [bulkDeleteEndedError, setBulkDeleteEndedError] = useState<string | null>(null);

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
  const [showAllSessions, setShowAllSessions] = useState(initialized?.showAllSessions === true);

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
  const [harnessOpen, setHarnessOpen] = useState(initialized?.harnessOpen === true);
  const [harnessTab, setHarnessTab] = useState<HarnessTabState>(initialized?.harnessTab ?? {});
  const openHarness = useCallback(() => {
    setHarnessOpen(true);
    setActiveMode('harness');
  }, []);
  useEffect(() => {
    if (!projHydrated || !focusHarness || !project || !harnessUrl) return;
    openHarness();
    onFocusHarnessHandled?.();
  }, [projHydrated, focusHarness, project, harnessUrl, openHarness, onFocusHarnessHandled]);
  const [fileTreeOpen,setFileTreeOpen]=useState(initialized?.fileTreeOpen ?? initialized?.activeMode==='explorer');
  const [fileTreeHost,setFileTreeHost]=useState<HTMLDivElement|null>(null);
  const [fileTabsHost,setFileTabsHost]=useState<HTMLDivElement|null>(null);

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
  const workspaceTabs = useMemo(() => {
    if (!harnessOpen) return terminalInstances;
    // Anchor to the first surviving tab on the right so closing a neighbor
    // leaves the Harness in place relative to the other open tabs.
    const followingIds = new Set(harnessTab.followingSessionIds);
    const next = terminalInstances.findIndex(tab => followingIds.has(tab.id));
    const index = next === -1 ? terminalInstances.length : next;
    return [
      ...terminalInstances.slice(0, index),
      { ...HARNESS_TAB, customLabel: harnessTab.customLabel },
      ...terminalInstances.slice(index),
    ];
  }, [harnessOpen, harnessTab, terminalInstances]);
  const workspaceActivity = useStreamStore(useShallow(state => workspaceTabs.map(tab => {
    const session = allSessionLookup.get(tab.id);
    return session ? sessionActivityMs(session, state.activityAt[tab.id]) : null;
  })));
  const [sortActivityById, setSortActivityById] = useState(() => new Map<string, number | null>());
  const latestActivity = useRef({ tabs: workspaceTabs, times: workspaceActivity });
  useEffect(() => {
    latestActivity.current = { tabs: workspaceTabs, times: workspaceActivity };
    if (!projHydrated || !projectHistorySettled) return;
    // Capture new tabs as they appear without moving earlier entries.
    setSortActivityById(previous => {
      if (previous.size === workspaceTabs.length && workspaceTabs.every(tab => previous.has(tab.id))) return previous;
      return new Map(workspaceTabs.map((tab, index) => {
        const captured = previous.get(tab.id);
        return [tab.id, captured === undefined ? workspaceActivity[index] : captured];
      }));
    });
  }, [projHydrated, projectHistorySettled, workspaceTabs, workspaceActivity]);
  useEffect(() => {
    if (!projHydrated || !projectHistorySettled || (!active && !sessionNavigationExpanded)) return;
    const timer = window.setInterval(() => {
      const { tabs, times } = latestActivity.current;
      setSortActivityById(previous => {
        if (previous.size === tabs.length && tabs.every((tab, index) => previous.get(tab.id) === times[index])) return previous;
        return new Map(tabs.map((tab, index) => [tab.id, times[index]]));
      });
    }, SESSION_ORDER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, projHydrated, projectHistorySettled, sessionNavigationExpanded]);
  const sortedWorkspaceTabs = useMemo(() => workspaceTabs
    .map((tab, index) => ({ tab, index, sortAt: sortActivityById.get(tab.id) ?? null }))
    .sort((a, b) => {
      if (a.sortAt === b.sortAt) return 0;
      return (b.sortAt ?? -Infinity) - (a.sortAt ?? -Infinity);
    }), [workspaceTabs, sortActivityById]);
  useEffect(() => {
    setTerminalInstances(previous => {
      const seen: TerminalInstance[] = [];
      let changed = false;
      for (const tab of previous) {
        const name = tab.customLabel?.trim() || tab.label;
        const unique = uniqueTabName(name, seen, tab.id);
        if (unique !== name) {
          changed = true;
          if(tab.customLabel?.trim()){terminalLabelsRef.current[tab.id] = unique;seen.push({ ...tab, customLabel: unique });}
          else seen.push({ ...tab, label: unique });
        } else seen.push(tab);
      }
      return changed ? seen : previous;
    });
  }, [terminalInstances]);
  // Reordering the tab strip must not reorder the mounted xterm DOM nodes.
  // Moving a live WebGL canvas through the DOM can invalidate its painted
  // surface, leaving only the terminal background visible.
  const [terminalMountOrder, setTerminalMountOrder] = useState(() =>
    (initialized?.terminalInstances ?? []).map((terminal) => terminal.id),
  );
  useEffect(() => {
    setTerminalMountOrder((current) => {
      const next = orderItemsByKeys(terminalInstances, current, (terminal) => terminal.id)
        .map((terminal) => terminal.id);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [terminalInstances]);
  const mountedTerminalInstances = useMemo(
    () => orderItemsByKeys(terminalInstances, terminalMountOrder, (terminal) => terminal.id),
    [terminalInstances, terminalMountOrder],
  );
  const sessionDisplayNames = useMemo(() => {
    const labels = { ...terminalLabelsRef.current };
    for (const terminal of terminalInstances) {
      labels[terminal.id] = terminal.customLabel?.trim() || terminal.label;
    }
    return labels;
  }, [terminalInstances]);
  const locallyCreatedSessionIds = useRef(new Set<string>());
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(
    initialized?.activeTerminalId ?? null
  );
  // Set once server project state has been read. Persisted tabs show history
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
    if (!sessionsLoaded || !projectHistoryLoaded || !projHydrated) return;
    const knownSessionIds = new Set(allSessionLookup.keys());
    const allowed = new Set(
      [...allSessionLookup.values()]
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
  }, [sessionsLoaded, projectHistoryLoaded, sessionsData, allSessionLookup, projHydrated]);

  // ── Inline tab rename ──────────────────────────────────────────────
  // ProjectView refocuses the active terminal (xterm) on session updates / tab
  // clicks via the `agentmanager:focus-terminal` event, which steals focus from a
  // rename <input> and would dismiss it on blur. So we never commit on blur —
  // blur just grabs focus back. Commit = Enter or a real outside mousedown;
  // cancel = Escape.
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDropTargetId, setTabDropTargetId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const beginTabRename = useCallback((tab: TerminalInstance) => {
    setEditingTabId(tab.id);
    setEditingTabValue(tab.customLabel?.trim() || tab.label);
  }, []);
  const cancelTabRename = useCallback(() => {
    setEditingTabId(null);
    setEditingTabValue('');
  }, []);
  const commitTabRename = useCallback((id: string) => {
    const currentTab = workspaceTabs.find(tab => tab.id === id);
    if (currentTab) {
      const customLabel = uniqueTabName(editingTabValue.trim() || currentTab.label, workspaceTabs, id);
      if (id === HARNESS_TAB.id) {
        setHarnessTab(current => ({ ...current, customLabel }));
      } else {
        // Keep the synced label map in lockstep so reconciliation can re-apply it.
        if (customLabel) terminalLabelsRef.current[id] = customLabel;
        else delete terminalLabelsRef.current[id];
        setTerminalInstances(current => current.map(tab => tab.id === id
          ? { ...tab, customLabel: customLabel || undefined }
          : tab));
      }
    }
    cancelTabRename();
  }, [editingTabValue, workspaceTabs, cancelTabRename]);
  const reorderTabs = useCallback((targetId: string) => {
    if (!draggingTabId || draggingTabId === targetId) return;
    if (sortedWorkspaceTabs.find(({ tab }) => tab.id === draggingTabId)?.sortAt !== null
      || sortedWorkspaceTabs.find(({ tab }) => tab.id === targetId)?.sortAt !== null) return;
    const next = moveItemByKey(workspaceTabs, draggingTabId, targetId, tab => tab.id);
    const harnessIndex = next.findIndex(tab => tab.id === HARNESS_TAB.id);
    if (harnessIndex !== -1) {
      const followingSessionIds = next.slice(harnessIndex + 1).map(tab => tab.id);
      setHarnessTab(current => ({ ...current, followingSessionIds }));
    }
    const sessionOrder = next.filter(tab => tab.id !== HARNESS_TAB.id).map(tab => tab.id);
    setTerminalInstances(current => {
      const ordered = orderItemsByKeys(current, sessionOrder, tab => tab.id);
      return ordered.every((tab, index) => tab === current[index]) ? current : ordered;
    });
  }, [draggingTabId, sortedWorkspaceTabs, workspaceTabs]);
  // Commit when the user mousedowns anywhere outside the rename input.
  useEffect(() => {
    if (editingTabId === null) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (renameInputRef.current && !renameInputRef.current.contains(e.target as Node)) {
        commitTabRename(editingTabId);
      }
    };
    document.addEventListener('mousedown', onDocPointerDown, true);
    return () => document.removeEventListener('mousedown', onDocPointerDown, true);
  }, [editingTabId, commitTabRename]);

  const [showNewSession, setShowNewSession] = useState(false);
  const closeNewSession = useCallback(() => setShowNewSession(false), []);
  // Lazy-mount: only create xterm instances for terminals the user has actually viewed.
  // Prevents 8+ xterm instances from initializing simultaneously on page refresh.
  const mountedTerminals = useRef(new Set<string>());

  // Keep the three most recently used terminals hot. Older terminals retain
  // their painted xterm buffer for a grace period, then disconnect and resume
  // incrementally from a display cursor the next time they are selected.
  const initialWarmTerminalId = active ? activeTerminalId : null;
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
  }, [active, activeMode, activeTerminalId, keepTerminalWarm, scheduleTerminalCooling]);

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
    type: 'session' | 'terminal';
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
    if(!projHydrated||!projectHistoryLoaded)return;
    if (projectSessions.length === 0 && syncedRef.current) return;
    if (projectSessions.length === 0 && !syncedRef.current) {
      syncedRef.current = true;
      return;
    }
    syncedRef.current = true;

    // Prune closed IDs that are no longer alive on the server (kill completed)
    const allAliveIds = new Set(
      [...allSessionLookup.values()]
        .filter((session) => isLiveSessionStatus(session.status))
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

    setTerminalInstances((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const aliveIds = new Set(projectSessions.map((s) => s.id));
      // Build set of all session IDs the server knows about (any status)
      const knownSessions = [
        ...(sessionsData?.sessions || []),
        ...(projectHistoryData?.sessions || []),
      ];
      const allServerIds = new Set(knownSessions.map((session) => session.id));
      // Sessions the server reports as ended — kept as tabs (in an ended state)
      // so the user can view the last screen / resume, instead of being evicted.
      const endedIds = new Set(
        knownSessions
          .filter((session) => session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled')
          .map((session) => session.id)
      );

      // Keep a tab if its session is still alive, ended (view/resume), or not yet
      // seen by the server (just created locally, not in the poll response yet).
      const filtered = prev.filter((t) => aliveIds.has(t.id) || endedIds.has(t.id) || (!sessionsLoaded && !allServerIds.has(t.id)));

      // Explicit user names win. Native titles update only automatic labels.
      const customTabs = filtered.map((t) => {
        // Restore a synced custom name if one arrived from the server after this
        // instance was first created locally.
        const synced = terminalLabelsRef.current[t.id];
        const withCustom = synced && synced !== t.customLabel ? { ...t, customLabel: synced } : t;
        return withCustom;
      });

      const nativeTitles=Object.fromEntries(knownSessions.map(s=>[s.id,s.native_title]));
      const relabeled=applySessionTabTasks(
        customTabs,
        Object.fromEntries(knownSessions.map(s=>[s.id,s.task])),
        nativeTitles,
      );

      // Add new sessions not yet tracked (skip user-closed sessions)
      const newTerminals: TerminalInstance[] = [];
      for (const s of projectSessions) {
        if (!existingIds.has(s.id) && !closedSessionIds.current.has(s.id)) {
          newTerminals.push({ id: s.id, label: nextSessionTabLabel(s, [...relabeled, ...newTerminals]), customLabel: terminalLabelsRef.current[s.id] });
        }
      }

      const result = [...relabeled, ...newTerminals];
      // Check if anything actually changed
      if (result.length === prev.length && newTerminals.length === 0 && result.every((t, i) => t.id === prev[i]?.id && t.label === prev[i]?.label && t.customLabel === prev[i]?.customLabel)) return prev;

      return result;
    });
  }, [projectSessions, sessionsLoaded, sessionsData, projectHistoryData, allSessionLookup,projHydrated,projectHistoryLoaded]);

  // Select an existing terminal when no session is active.
  useEffect(() => {
    if (terminalInstances.length > 0 && (!activeTerminalId || projHydrated&&projectHistoryLoaded&&!terminalInstances.some(tab=>tab.id===activeTerminalId))) {
      setActiveTerminalId(terminalInstances[0].id);
    }
  }, [terminalInstances, activeTerminalId,projHydrated,projectHistoryLoaded]);

  // Focus a specific session when requested (e.g. from the admin monitor or a quick-launch command)
  useEffect(() => {
    if (!focusSessionId) return;

    // Voice command / quick-launch: create new terminal or session (optionally with cli type)
    const createMatch = focusSessionId.match(/^__voice_create_(terminal|session)(?:_([a-z][a-z0-9_-]{0,63}))?$/);
    if (createMatch) {
      const type = createMatch[1] as 'terminal' | 'session';
      const cliType = (createMatch[2] as string | undefined) || 'claude';
      console.log(`[QuickLaunch] Creating new ${type} (${cliType})`);
      if (type === 'terminal') {
        api.sessions.create({ project_path: projectPath, mode: 'terminal', project_id: projectId })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session);
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create terminal:`, err));
      } else {
        api.sessions.create({
          project_path: projectPath,
          mode: 'session',
          project_id: projectId,
          cli_type: cliType,
        })
          .then((data) => {
            if (data.session?.id) {
              handleSessionCreated(data.session);
              queryClient.invalidateQueries({ queryKey: ['sessions'] });
            }
          })
          .catch((err) => console.error(`[QuickLaunch] Failed to create ${type}:`, err));
      }
      onFocusSessionHandled?.();
      return;
    }

    // Regular session ID focus
    // Apply explicit navigation after the saved tab state has been restored,
    // so hydration cannot replace the tab that the user just chose to open.
    if (!projHydrated) return;
    if (!terminalInstances.some((tab) => tab.id === focusSessionId)) {
      const target = allSessionLookup.get(focusSessionId);
      if (target?.project_id === projectId) {
        closedSessionIds.current.delete(focusSessionId);
        canonicalOpenSessionIdsRef.current?.add(focusSessionId);
        setClosedIdsVersion((value) => value + 1);
        setTerminalInstances((prev) => prev.some(tab=>tab.id===focusSessionId)?prev:[...prev, { id: focusSessionId, label: nextSessionTabLabel(target, prev), customLabel: terminalLabelsRef.current[focusSessionId] }]);
        setActiveTerminalId(focusSessionId);

        setActiveMode('terminal');
        return;
      }
    }
    if (terminalInstances.some((t) => t.id === focusSessionId)) {
      setActiveTerminalId(focusSessionId);

      setActiveMode('terminal');
      onFocusSessionHandled?.();
      focusTerminalById(focusSessionId);
    }
  }, [focusSessionId, onFocusSessionHandled, projectId, projectPath, queryClient, allSessionLookup, terminalInstances, projHydrated]);

  // Explorer instances
  const [explorerInstances, setExplorerInstances] = useState<ExplorerInstance[]>(() => {
    const owned = (initialized?.explorerInstances ?? []).filter((tab) =>
      ownsExplorerTab(currentUserId, projectId, tab.id),
    );
    if (owned.length) return owned;
    const id = `${currentUserId}-${projectId}-explorer-${nextExplorerSeq++}`;
    return [{ id, label: 'Explorer 1' }];
  });
  const [explorerMountOrder, setExplorerMountOrder] = useState(() =>
    explorerInstances.map((explorer) => explorer.id),
  );
  useEffect(() => {
    setExplorerMountOrder((current) => {
      const next = orderItemsByKeys(explorerInstances, current, (explorer) => explorer.id)
        .map((explorer) => explorer.id);
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [explorerInstances]);
  const mountedExplorerInstances = useMemo(
    () => orderItemsByKeys(explorerInstances, explorerMountOrder, (explorer) => explorer.id),
    [explorerInstances, explorerMountOrder],
  );

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
      showAllSessions,
      harnessOpen,
      harnessTab,
      fileTreeOpen,
      explorerInstances,
      activeExplorerId,
      terminalInstances,
      activeTerminalId,
      hiddenSessionIds: [...closedSessionIds.current],
    });
  }, [currentUserId, projectId, activeMode, showAllSessions, harnessOpen, harnessTab, fileTreeOpen, explorerInstances, activeExplorerId, terminalInstances, activeTerminalId, closedIdsVersion]);

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
    if (!projHydrated||!projectHistoryLoaded) return;
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
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(h);
  }, [projHydrated, projectHistoryLoaded, projectId, terminalInstances, activeTerminalId, closedIdsVersion, explorerInstances]);

  function handleSessionCreated(session: Session) {
    // Creation already returned authoritative metadata. Do not wait for history
    // enrichment before mounting the new session (which may have no messages).
    for (const queryKey of [['sessions'], ['project-sessions', projectId]]) {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData<{ sessions: Session[] }>(queryKey, current => ({
        sessions: [session, ...(current?.sessions || []).filter(item => item.id !== session.id)],
      }));
    }
    locallyCreatedSessionIds.current.add(session.id);
    canonicalOpenSessionIdsRef.current?.add(session.id);
    setTerminalInstances((prev) => {
      if (prev.some((t) => t.id === session.id)) return prev;
      return [...prev, { id: session.id, label: nextSessionTabLabel(session, prev), customLabel: terminalLabelsRef.current[session.id] }];
    });
    setActiveTerminalId(session.id);
  }

  function handleOpenProjectSession(session: Session) {
    queryClient.setQueryData<{ sessions: Session[] }>(['sessions'], (current) => ({
      sessions: [session, ...(current?.sessions || []).filter((item) => item.id !== session.id)],
    }));
    unhideSession(session.id, session);
    setActiveMode('terminal');
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

  function unhideSession(id: string, knownSession?: Session) {
    closedSessionIds.current.delete(id);
    setClosedIdsVersion((v) => v + 1);

    // Find the session data to determine its type and re-add the tab
    const allSessions = sessionsData?.sessions || [];
    const session = knownSession || allSessions.find((candidate) => candidate.id === id);
    if (session) {
      setTerminalInstances((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [...prev, { id, label: nextSessionTabLabel(session, prev), customLabel: terminalLabelsRef.current[id] }];
      });
      setActiveTerminalId(id);

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
        updated.push({ id, label: nextSessionTabLabel(session, updated), customLabel: terminalLabelsRef.current[id] });
      }
      return updated;
    });


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

  async function deleteAllEndedSessions() {
    if (bulkDeletingEnded) return;
    setBulkDeletingEnded(true);
    setBulkDeleteEndedError(null);
    try {
      const result = await api.sessions.deleteEndedRecords(projectId);
      if (result.failed > 0) throw new Error(`${result.failed} record(s) could not be deleted`);
      setConfirmBulkDeleteEnded(false);
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      console.error('Failed to delete ended session records:', err);
      setBulkDeleteEndedError((err as Error).message || 'Delete failed');
    } finally {
      setBulkDeletingEnded(false);
    }
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

      // If an adopted session already has a tab,
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
        handleSessionCreated(result.session);
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
    closedSessionIds.current.add(id);
    canonicalOpenSessionIdsRef.current?.delete(id);
    locallyCreatedSessionIds.current.delete(id);
    mountedTerminals.current.delete(id);
    sessionResume.forget(id);
    setTerminalConnectionVersions((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    delete terminalLabelsRef.current[id];
    setClosedIdsVersion((v) => v + 1);
    setTerminalInstances(remaining);
    setActiveTerminalId(nextActiveTerminalId);

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
      harnessOpen,
      harnessTab,
      explorerInstances,
      activeExplorerId,
      terminalInstances: remaining,
      activeTerminalId: nextActiveTerminalId,
      hiddenSessionIds,
    });
    api.userState.set(`project:${projectId}`, {
      terminalLabels,
      terminalInstances: remaining,
      activeTerminalId: nextActiveTerminalId,
      hiddenSessionIds,
      explorerInstances,
    }).catch((err) => console.error('Failed to persist closed terminal tab:', id, err));
  }

  async function closeTerminal(id:string,removeRecord=false) {
    if(removeRecord)await api.sessions.queueRecordDeletion(id);else await api.sessions.kill(id);
    removeTerminalTabFromState(id);
    setCloseConfirm(null);
    void queryClient.invalidateQueries({queryKey:['sessions']});
    void queryClient.invalidateQueries({queryKey:['project-sessions',projectId]});
  }

  async function closeEndedSession(id: string) {
    // Keep the tab and surface an error if the server cannot release resources.
    await api.sessions.kill(id);
    removeTerminalTabFromState(id);
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
  }

  async function reconnectTerminal(oldId: string) {
    try {
      const { session: oldSession } = await api.sessions.get(oldId).catch(() => ({ session: null }));
      // A restored CLI may already be running while its browser connection
      // failed. Reattach the same session instead of launching another CLI.
      if (oldSession && ['running', 'pending', 'launching'].includes(oldSession.status)) {
        setTerminalConnectionVersions((current) => ({ ...current, [oldId]: (current[oldId] ?? 0) + 1 }));
        return;
      }
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
        const resumable=agentSupports(oldSession,'resume')&&!!agentNativeId(oldSession);
        if (resumable) {
          await sessionResume.resume(oldId);
          setActiveTerminalId(oldId);
          return;
        }
        // Not resumable (plain terminal or an old uncaptured CLI session) —
        // fall through to a fresh session.
      }

      const result = await api.sessions.create({
        project_path: projectPath,
        project_id: projectId,
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

  // Cross-tab refresh coordination
  const [gitSavedFile, setGitSavedFile] = useState<FileRefreshRequest | null>(null);
  const [explorerSavedFile, setExplorerSavedFile] = useState<string | null>(null);
  const [explorerUploadRequest, setExplorerUploadRequest] = useState<(FileUploadRequest & { explorerId: string }) | null>(null);

  const handleGitFileSaved = useCallback((filePath: string) => {
    setGitSavedFile((previous) => ({ path: filePath, revision: (previous?.revision ?? 0) + 1 }));
  }, []);

  const handleExplorerFileSaved = useCallback((filePath: string) => {
    setExplorerSavedFile(filePath);
  }, []);

  // File links open in the shared workspace without replacing its tab strip.
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

  // The file tree belongs to the shared session and document workspace.
  const showSessionWorkspace = activeMode === 'terminal' || activeMode === 'explorer' || activeMode === 'harness';
  const [sessionControlsHost,setSessionControlsHost]=useState<HTMLDivElement|null>(null);
  const [showTabSwitcher, setShowTabSwitcher] = useState(false);
  const [localSessionSidebarOpen, setLocalSessionSidebarOpen] = useState(true);
  const [showSessionSearch, setShowSessionSearch] = useState(false);
  const nestedSessionNavigation = sessionNavigationExpanded !== undefined;
  const sessionSidebarOpen = sessionNavigationExpanded ?? localSessionSidebarOpen;
  const [sessionSearch, setSessionSearch] = useState('');
  const sessionSearchToggle = useRef<HTMLButtonElement>(null);
  const sessionTabList = useRef<HTMLElement>(null);
  const sessionFilter = sessionSearch.trim().toLocaleLowerCase();
  const activeWorkspaceTab = activeMode === 'harness' ? HARNESS_TAB.id : activeMode === 'terminal' ? activeTerminalId : null;
  const tabBranches = useMemo(() => sessionTabTree(
    sortedWorkspaceTabs, id => allSessionLookup.get(id)?.parent_session_id,
  ), [sortedWorkspaceTabs, allSessionLookup]);
  const previewTabs = tabBranches.flatMap((branch, index) =>
    index < SESSION_PREVIEW_LIMIT || branch.some(({ tab }) => (active && tab.id === activeWorkspaceTab) || tab.id === editingTabId)
      ? branch : [],
  );
  const remainingSessions = workspaceTabs.length - previewTabs.length;
  const visibleWorkspaceTabs = sessionFilter
    ? tabBranches.flatMap(branch => {
      const matching = new Set(branch.filter(({ tab }) =>
        (tab.customLabel?.trim() || tab.label).toLocaleLowerCase().includes(sessionFilter),
      ).map(({ tab }) => tab.id));
      for (const { tab, depth } of [...branch].reverse()) {
        if (depth && matching.has(tab.id)) {
          const parent = allSessionLookup.get(tab.id)?.parent_session_id;
          if (parent) matching.add(parent);
        }
      }
      return branch.filter(({ tab }) => matching.has(tab.id));
    })
    : nestedSessionNavigation && !showAllSessions ? previewTabs : tabBranches.flat();
  const { data: scheduledData } = useQuery({
    queryKey: ['scheduled-tasks', projectId],
    queryFn: () => api.scheduledTasks.list(projectId),
    enabled: (active || !!sessionNavigationExpanded) && workspaceTabs.length > 0,
    retry: false,
  });
  const scheduledSessionIds = useMemo(() => new Set(
    scheduledData?.tasks.flatMap(task => task.target_type === 'existing' && task.target_session_id ? [task.target_session_id] : []),
  ), [scheduledData]);

  useEffect(() => {
    if (!active || !sessionSidebarOpen || sessionFilter || !activeWorkspaceTab) return;
    const revealActive = () => {
      const list = sessionTabList.current;
      const current = list?.querySelector<HTMLElement>('[data-active="true"]');
      const scroller = nestedSessionNavigation ? list?.closest<HTMLElement>('.workspace-project-tabs') : list;
      if (!scroller?.clientHeight || !current) return;
      const bounds = scroller.getBoundingClientRect();
      const row = current.getBoundingClientRect();
      if (row.top < bounds.top) scroller.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) scroller.scrollTop += row.bottom - bounds.bottom;
    };
    revealActive();
    window.addEventListener('resize', revealActive);
    return () => window.removeEventListener('resize', revealActive);
  }, [active, activeWorkspaceTab, nestedSessionNavigation, sessionFilter, sessionSidebarOpen, sessionNavigationHost, visibleWorkspaceTabs.length]);

  function selectWorkspaceTab(id: string) {
    setSessionSearch('');
    setShowSessionSearch(false);
    onActivateProject?.(projectId);
    if (id === HARNESS_TAB.id) {
      openHarness();
      return;
    }
    setActiveTerminalId(id);
    setActiveMode('terminal');
    focusTerminalById(id);
  }

  const adoptAnchor = showAdoptMenu ? adoptMenuRef.current?.getBoundingClientRect() : undefined;
  const adoptWidth = showAdoptMenu ? Math.min(360, window.innerWidth - 16) : 0;
  const adoptRight = adoptAnchor ? Math.min(window.innerWidth - 8, adoptAnchor.right) : 8;

  const projectToolbar = (
    <div className="workspace-project-toolbar">
      <button
        type="button"
        className="workspace-subtab-action workspace-session-sidebar-toggle"
        aria-label={sessionSidebarOpen ? '收起会话列表' : '展开会话列表'}
        aria-expanded={sessionSidebarOpen}
        aria-controls={nestedSessionNavigation ? `project-session-branch-${projectId}` : `project-session-sidebar-${projectId}`}
        title={sessionSidebarOpen ? '收起会话列表' : '展开会话列表'}
        onClick={() => {
          if (onSetSessionNavigationExpanded) onSetSessionNavigationExpanded(projectId, !sessionSidebarOpen);
          else setLocalSessionSidebarOpen(open => !open);
        }}
      >
        <PanelLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      {workspaceTabs.length > 0 && <button
        type="button"
        className="workspace-subtab-action workspace-compact-session-switcher"
        aria-label="切换会话"
        aria-haspopup="dialog"
        title="切换会话"
        onClick={() => setShowTabSwitcher(true)}
      >
        <List className="h-4 w-4" aria-hidden="true" />
      </button>}
      <div role="toolbar" aria-label="项目工具栏" className="workspace-project-tools">
        {projectToolButtons.map(({ id, icon: Icon, title }) => {
          const isActive = id==='explorer'?fileTreeOpen && showSessionWorkspace:activeMode === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if(id==='explorer') {
                  setFileTreeOpen(open=>!open);
                  if(!showSessionWorkspace)setActiveMode('terminal');
                } else {
                  setActiveMode(id);
                  if(id==='terminal' && activeTerminalId)focusTerminalById(activeTerminalId);
                }
              }}
              aria-expanded={id==='explorer'?fileTreeOpen && showSessionWorkspace:undefined}
              aria-controls={id==='explorer'?`project-file-tree-${projectId}`:undefined}
              onDragOver={id === 'explorer' ? (event) => {
                if (!isFileDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setFileTreeOpen(true);
                if(!showSessionWorkspace)setActiveMode('terminal');
              } : undefined}
              onDrop={id === 'explorer' ? (event) => {
                if (!isFileDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                setFileTreeOpen(true);
                if(!showSessionWorkspace)setActiveMode('terminal');
                const files = droppedFiles(event.dataTransfer);
                setExplorerUploadRequest((previous) => ({ ...files, explorerId: activeExplorerId, key: (previous?.key ?? 0) + 1 }));
              } : undefined}
              aria-label={title}
              aria-pressed={id === 'explorer' ? undefined : isActive}
              title={title}
              className="workspace-project-tool flex items-center justify-center rounded transition-colors"
              style={{
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              <Icon className="w-4 h-4" />
            </button>
          );
        })}
      </div>
      <div className="workspace-session-actions">
        {/* Create directly through the same dialog as the project list. */}
        <button
          type="button"
          onClick={() => setShowNewSession(true)}
          disabled={!project || projectOpenModes(project, harnessUrl).length === 0}
          className="workspace-subtab-action"
          title="新建会话"
          aria-label="新建会话"
        >
          <Plus className="w-4 h-4" />
        </button>

        {/* Adopt external session button — on-demand scan */}
        <div ref={adoptMenuRef}>
          <button
            type="button"
            aria-label="恢复或接管会话"
            aria-expanded={showAdoptMenu}
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
              height: 24,
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
              className="fixed z-[9999] max-h-[60dvh] overflow-y-auto rounded-lg border py-1 shadow-lg"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border)',
                top: (adoptAnchor?.bottom ?? 0) + 4,
                width: adoptWidth,
                left: Math.max(8, adoptRight - adoptWidth),
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
                    const cliLabel=sessionAgent(s).label;
                    const typeLabel = isTerminal ? 'Terminal' : `${cliLabel} Session`;
                    const typeColor = isTerminal?'#f59e0b':sessionAgent(s).presentation.color;
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
                  const descriptor=project?.agent_catalog?.find(agent=>agent.id===s.cliType)??sessionAgent({cli_type:s.cliType});
                  const cliLabel=descriptor.label;
                  const typeLabel = isTerminal ? 'Terminal' : `${cliLabel ? cliLabel + ' ' : ''}Session`;
                  const typeColor=isTerminal?'#f59e0b':descriptor.presentation.color;
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
                    className="flex items-center justify-between gap-3 px-3 py-1.5"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider">Ended / Recent</span>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setBulkDeleteEndedError(null);
                        setConfirmBulkDeleteEnded(true);
                        setShowAdoptMenu(false);
                      }}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-red-500/10"
                      style={{ color: 'var(--error)' }}
                      title="Delete all ended session records for this project"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete all
                    </button>
                  </div>
                  {endedSessions.map((s) => {
                    const isTerminal = s.task === 'Terminal';
                    const cliLabel=sessionAgent(s).label;
                    const typeLabel = isTerminal ? 'Terminal' : `${cliLabel} Session`;
                    const typeColor = isTerminal?'#f59e0b':sessionAgent(s).presentation.color;
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

      </div>
      {activeMode === 'terminal' && <div ref={setSessionControlsHost} className="session-pane-controls-slot" />}
    </div>
  );

  const sessionNavigation = (
    <aside id={`project-session-sidebar-${projectId}`} className="workspace-session-sidebar" aria-label="会话列表" hidden={!sessionSidebarOpen}>
      {(!nestedSessionNavigation || showSessionSearch) && <form className="workspace-session-search" onSubmit={event => {
        event.preventDefault();
        const match = visibleWorkspaceTabs[0];
        if (match) selectWorkspaceTab(match.tab.id);
      }}>
        <input
          type="search"
          autoFocus={nestedSessionNavigation}
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={sessionSearch}
          onChange={event => setSessionSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            setSessionSearch('');
            if (nestedSessionNavigation) {
              setShowSessionSearch(false);
              sessionSearchToggle.current?.focus();
            }
          }}
        />
      </form>}
      <nav ref={sessionTabList} aria-label="会话标签" className="workspace-session-list">
        {visibleWorkspaceTabs.map(({ tab: inst, index, sortAt, depth }) => {
          const activityAt = workspaceActivity[index];
          const isHarness = inst.id === HARNESS_TAB.id;
          const isActive = (!nestedSessionNavigation || active) && inst.id === activeWorkspaceTab;
          const label = inst.customLabel?.trim() || inst.label;
          const session = sessionLookup.get(inst.id) || allSessionLookup.get(inst.id);
          const account = session?.agent_account_label;
          // Status signal light — a leaf component subscribes to just this
          // session's live state, so a state tick doesn't re-render the view.
          const sigSession = allSessionLookup.get(inst.id);
          const tabKind = session ? sessionTabKind(session) : 'session';
          const isTerminal = tabKind === 'terminal';
          const iconClass = 'workspace-tab-icon w-3 h-3 shrink-0';
          const tabIcon = isHarness ? <Globe className={iconClass} aria-hidden="true" />
            : isTerminal ? <TerminalSquare className={iconClass} style={{ color: '#f59e0b' }} />
            : <AgentIcon session={session || {}} className={iconClass} />;
          return (
            <div
              key={inst.id}
              draggable={sortAt === null && editingTabId !== inst.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', inst.id);
                setDraggingTabId(inst.id);
              }}
              onDragEnd={() => {
                setDraggingTabId(null);
                setTabDropTargetId(null);
              }}
              className="workspace-tab group"
              data-session-id={isHarness ? undefined : inst.id}
              data-active={isActive}
              data-parent-session-id={session?.parent_session_id || undefined}
              onDragOver={(event) => {
                if (sortAt !== null || !draggingTabId || draggingTabId === inst.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setTabDropTargetId(inst.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                reorderTabs(inst.id);
                setDraggingTabId(null);
                setTabDropTargetId(null);
              }}
              style={{
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                marginInlineStart: depth ? Math.min(depth, 4) * 12 : undefined,
                outline: tabDropTargetId === inst.id ? '1px solid var(--accent)' : '1px solid transparent',
              }}
            >
              {session?.parent_session_id && <span
                className="workspace-tab-parent-link"
                title={depth ? '由上级标签页创建' : '由其他标签页创建，上级当前未打开'}
              ><CornerDownRight size={12} aria-hidden="true" /></span>}
              {sigSession && (
                <span className="workspace-tab-signal">
                  <LiveSessionSignalDot session={sigSession} active={isActive} />
                  {!!notificationUnread?.[inst.id]&&<span className="notification-tab-count" aria-label={`${notificationUnread[inst.id]} 条未读通知`}>{notificationUnread[inst.id]}</span>}
                </span>
              )}
              {editingTabId === inst.id ? (
                <div className="workspace-tab-button">
                  {tabIcon}
                  <input
                    ref={renameInputRef}
                    aria-label="标签名称"
                    autoFocus
                    value={editingTabValue}
                    onChange={(e) => setEditingTabValue(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => {
                      // Terminals steal focus on session updates — grab it back if we're
                      // still editing. Real exits go through Enter / Esc / outside-mousedown.
                      requestAnimationFrame(() => renameInputRef.current?.focus());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitTabRename(inst.id); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelTabRename(); }
                    }}
                    className="bg-transparent outline-none border-b text-xs font-medium w-[110px]"
                    style={{ color: 'var(--text-primary)', borderColor: 'var(--accent)' }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  aria-current={isActive ? true : undefined}
                  aria-description={account ? `账号：${account}` : undefined}
                  onClick={(e) => {
                    if (e.detail > 1) return; // 2nd click of a double-click → that's a rename
                    selectWorkspaceTab(inst.id);
                  }}
                  onDoubleClick={() => beginTabRename(inst)}
                  onKeyDown={(event) => {
                    if (event.key !== 'F2') return;
                    event.preventDefault();
                    beginTabRename(inst);
                  }}
                  className="workspace-tab-button"
                  style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  title={isHarness ? `${label} · 双击或按 F2 重命名` : '双击重命名'}
                >
                  {tabIcon}
                  {isHarness ? <span className="truncate">{label}</span>
                    : <SessionTabLabel session={sigSession} label={label} detail={`${isTerminal ? 'Terminal' : 'Session'} · ${sessionAgent(session || {}).label}`} activityAt={activityAt} />}
                  {!isHarness && <SessionTabBadges account={account} scheduled={scheduledSessionIds.has(inst.id)} activityAt={nestedSessionNavigation ? activityAt : null} />}
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isHarness) {
                    setHarnessOpen(false);
                    setActiveMode(mode => mode === 'harness' ? 'terminal' : mode);
                    return;
                  }
                  setCloseConfirm({ id: inst.id, label, type: tabKind });
                }}
                className="workspace-tab-close"
                style={{ color: 'var(--text-secondary)' }}
                aria-label={isHarness ? `关闭 ${label}` : undefined}
                title={isHarness ? undefined : 'Close session'}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        {sessionFilter && visibleWorkspaceTabs.length === 0 && <p className="workspace-session-empty" role="status">没有匹配的会话</p>}
        {nestedSessionNavigation && projHydrated && projectHistoryLoaded && workspaceTabs.length === 0 && <p className="workspace-session-empty">暂无会话</p>}
      </nav>
      {nestedSessionNavigation && (workspaceTabs.length > SESSION_PREVIEW_LIMIT || showSessionSearch) && (
        <div className="workspace-session-navigation-actions">
          {!sessionFilter && remainingSessions > 0 && (
            <button type="button" className="workspace-session-more" aria-expanded={showAllSessions} onClick={() => setShowAllSessions(open => !open)}>
              {showAllSessions ? '收起其余会话' : `展开其余 ${remainingSessions} 个会话`}
            </button>
          )}
          <button
            ref={sessionSearchToggle}
            type="button"
            className="workspace-subtab-action workspace-session-search-toggle"
            aria-label={showSessionSearch ? '关闭会话搜索' : '搜索会话'}
            aria-expanded={showSessionSearch}
            title={showSessionSearch ? '关闭会话搜索' : '搜索会话'}
            onClick={() => {
              setShowSessionSearch(open => !open);
              setSessionSearch('');
            }}
          >
            <Search size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </aside>
  );

  return (
    <div className="workspace-project h-full flex flex-col">
      {toolbarHost === undefined ? projectToolbar : toolbarHost && createPortal(projectToolbar, toolbarHost)}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="workspace-project-body flex flex-1 min-h-0 min-w-0">
          {sessionNavigationHost === undefined ? sessionNavigation : sessionNavigationHost && sessionSidebarOpen && createPortal(sessionNavigation, sessionNavigationHost)}
          <aside id={`project-file-tree-${projectId}`} aria-label="项目文件树"
            className="workspace-file-tree" style={{display:fileTreeOpen && showSessionWorkspace?'flex':'none'}}>
            <div ref={setFileTreeHost} className="workspace-file-tree-host"/>
          </aside>

          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div ref={setFileTabsHost} className="workspace-file-tabs-host" aria-label="打开的文件标签" style={{display:fileTreeOpen && showSessionWorkspace?undefined:'none'}}/>

        {/* Panel content */}
        <div className="flex-1 min-h-0 relative">
          {/* Terminal mode */}
          <div className="h-full absolute inset-0" style={{visibility:activeMode==='terminal'?'visible':'hidden',pointerEvents:activeMode==='terminal'?'auto':'none'}}>
              {terminalInstances.length === 0 && <div className="flex h-full items-center justify-center text-xs" style={{ color: 'var(--text-secondary)' }}>暂无打开的会话，点击上方「＋」新建。</div>}

              {/* Terminal instances stay mounted so tab switches preserve terminal state. */}
              <div className="h-full absolute inset-0" style={{ pointerEvents: 'none' }}>
                {mountedTerminalInstances.map((term) => {
                  const isSingleActive = activeMode==='terminal' && activeTerminalId === term.id;
                  const termVisible = isSingleActive && active;

                  if (termVisible) mountedTerminals.current.add(term.id);
                  const shouldMount = mountedTerminals.current.has(term.id);

                  const endedSession = allSessionLookup.get(term.id);
                  const resumeState = sessionResume.states[term.id];
                  const resuming = resumeState?.phase === 'starting' || resumeState?.phase === 'connecting';
                  const isEnded = !!endedSession && (
                    endedSession.status === 'completed'
                    || endedSession.status === 'failed'
                    || endedSession.status === 'cancelled'
                  );
                  const canResume=isEnded&&agentSupports(endedSession!,'resume')&&!!agentNativeId(endedSession!);

                  const renderTerminal = (rawVisible: boolean, chatSuspended: boolean, markReady: () => void) => (
                    (isEnded || resumeState?.phase === 'starting') ? (
                        <div className="relative h-full w-full">
                          <HistoryViewer
                            sessionId={term.id}
                            ended
                            onResume={canResume || resuming ? () => { void sessionResume.resume(term.id); } : undefined}
                            resuming={resuming}
                            resumeFailed={resumeState?.phase === 'error'}
                            onClose={() => closeEndedSession(term.id)}
                          />
                        </div>
                      ) : (
                        <Terminal
                          key={terminalConnectionVersions[term.id] ?? 0}
                          sessionId={term.id}
                          visible={rawVisible}
                          suspended={terminalsSuspended || !warmTerminalIds.has(term.id) || chatSuspended}
                          hideCursor={projectSessions.find((session) => session.id === term.id)?.task !== 'Terminal' && projectSessions.some((session) => session.id === term.id)}
                          cliType={sessionLookup.get(term.id)?.cli_type as string | undefined}
                          agent={sessionLookup.get(term.id)?.agent}
                          onExit={() => {
                            sessionResume.terminalExited(term.id);
                            // The terminal socket reports its exit immediately, while the
                            // cached session query otherwise still renders the dead xterm.
                            // Refresh both sources so an ended native conversation switches
                            // to HistoryViewer and exposes its in-place Resume action.
                            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
                            void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
                          }}
                          onReady={(id) => { sessionResume.terminalReady(id); markReady(); }}
                          onConnectionError={(id, message) => {
                            sessionResume.terminalFailed(id, message);
                            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
                            void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
                          }}
                          onReconnect={resuming ? undefined : () => reconnectTerminal(term.id)}
                        />
                      )
                  );

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
                      {shouldMount && (endedSession ? <SessionWorkspacePane
                        session={endedSession} userId={currentUserId} active={termVisible}
                        focusTarget={conversationTarget?.sessionId===term.id?conversationTarget.focus:null}
                        controlsHost={sessionControlsHost}
                        projectPath={projectPath} onOpenFile={handleOpenInExplorer}
                        renderTerminal={renderTerminal} resuming={resuming} resumeFailed={resumeState?.phase==='error'}
                        onResume={canResume || resuming ? () => { void sessionResume.resume(term.id); } : undefined}
                        onNewConversation={agentSupports(endedSession,'newConversation')&&agentNativeId(endedSession)?async(preference,expectedNativeId,environmentId)=>{const nativeId=await sessionResume.newConversation(term.id,preference,expectedNativeId,environmentId);setTerminalConnectionVersions(current=>({...current,[term.id]:(current[term.id]??0)+1}));return nativeId;}:undefined}
                        onReload={agentSupports(endedSession,'newConversation')&&agentNativeId(endedSession)?async()=>{await sessionResume.reload(term.id);setTerminalConnectionVersions(current=>({...current,[term.id]:(current[term.id]??0)+1}));}:undefined}
                        onClose={isEnded ? () => closeEndedSession(term.id) : undefined}
                      /> : <RestoreSessionRecord sessionId={term.id} projectId={projectId} onRestore={restoreRecord}/>)}
                      {shouldMount && resumeState && <SessionResumeFeedback state={resumeState} onDismiss={() => sessionResume.forget(term.id)} />}
                    </div>
                  );
                })}
              </div>
          </div>

          {harnessOpen && <div className="absolute inset-0" hidden={activeMode !== 'harness'}>
            {harnessUrl && project
              ? <DeepSeekHarnessFrame key={harnessUrl + project.path} url={harnessUrl} path={project.path} model={configuredHarnessModel} />
              : <p role="status" className="p-3 text-sm">DeepSeek Harness 接入或项目访问当前不可用。</p>}
          </div>}

          {/* Explorer instances retain edits while their trees/tabs are docked. */}
          {mountedExplorerInstances.map((expl) => (
            <div
              key={expl.id}
              className="h-full absolute inset-0"
              style={{
                display: activeMode === 'explorer' && activeExplorerId === expl.id ? 'block' : 'none',
              }}
            >
              <FileExplorer
                rootPath={projectPath}
                projectId={projectId}
                instanceId={expl.id}
                active={active && activeExplorerId === expl.id && (activeMode === 'explorer' || fileTreeOpen && showSessionWorkspace)}
                workspace={{
                  treeHost:activeExplorerId===expl.id?fileTreeHost:null,
                  tabsHost:fileTabsHost,
                  editorActive:active && activeMode==='explorer' && activeExplorerId===expl.id,
                  onActivate:()=>{
                    setActiveExplorerId(expl.id);setActiveMode('explorer');
                    if(window.matchMedia?.('(max-width: 639px)').matches)setFileTreeOpen(false);
                  },
                  onEmpty:()=>{setActiveMode('terminal');if(activeTerminalId)focusTerminalById(activeTerminalId);},
                }}
                refreshFileRequest={gitSavedFile}
                openFileRequest={expl.id === activeExplorerId ? openInExplorerRequest : null}
                onFileSaved={handleExplorerFileSaved}
                uploadRequest={explorerUploadRequest?.explorerId === expl.id ? explorerUploadRequest : null}
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
                projectId={projectId} projectPath={projectPath}
                openTabIds={new Set(terminalInstances.map((t) => t.id))}
                displayNames={sessionDisplayNames}
                onOpen={handleOpenProjectSession}
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
        </div>
      </div>

      {active && showTabSwitcher && <SessionTabSwitcher
        tabs={sortedWorkspaceTabs.map(({ tab }) => ({
          id: tab.id,
          label: tab.customLabel?.trim() || tab.label,
          scheduled: scheduledSessionIds.has(tab.id),
          account: allSessionLookup.get(tab.id)?.agent_account_label,
        }))}
        activeId={activeWorkspaceTab}
        onSelect={id => {
          setShowTabSwitcher(false);
          selectWorkspaceTab(id);
        }}
        onClose={() => setShowTabSwitcher(false)}
      />}
      {showNewSession && project && <ProjectSessionCreateDialog project={project} title="新建会话" onClose={closeNewSession} onSessionCreated={handleSessionCreated} harnessUrl={harnessUrl} onHarnessOpen={openHarness} />}

      {/* Close tab confirmation modal */}
      {closeConfirm && (
        <CloseTabModal
          label={closeConfirm.label}
          type={closeConfirm.type}
          onStop={()=>closeTerminal(closeConfirm.id)}
          onDelete={()=>closeTerminal(closeConfirm.id,true)}
          onCancel={() => setCloseConfirm(null)}
        />
      )}

      {confirmBulkDeleteEnded && (
        <ConfirmModal
          title="Delete all ended sessions?"
          message="This permanently deletes all completed, cancelled, and failed session records owned by your account in this project. Running sessions are not affected. Saved screens and the associated Agent conversation files are also permanently deleted."
          confirmLabel={bulkDeletingEnded ? 'Deleting…' : 'Delete all'}
          onConfirm={() => { void deleteAllEndedSessions(); }}
          onCancel={() => {
            if (bulkDeletingEnded) return;
            setConfirmBulkDeleteEnded(false);
            setBulkDeleteEndedError(null);
          }}
        >
          {bulkDeleteEndedError && (
            <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {bulkDeleteEndedError}
            </p>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}
