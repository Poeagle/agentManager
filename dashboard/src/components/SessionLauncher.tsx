import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type ProjectAgent, type ProjectToolPermissions } from '../lib/api';
import { Play, Loader2, Bot, TerminalSquare, Globe, Users, X, FolderOpen, GitBranch, Cpu, Activity, FileText, Zap, ArrowRight, Check } from 'lucide-react';
import { ClaudeIcon, CodexIcon } from './CliIcons';

interface SessionLauncherProps {
  project: Project;
  onSessionCreated: (sessionId: string, projectName?: string, mode?: 'session' | 'terminal') => void;
  onWebPageCreated?: (url: string) => void;
}

type LaunchMode = 'session' | 'agent';

interface LaunchIntent {
  mode: LaunchMode;
  cliType: 'claude' | 'codex';
}

const CLI_RUNTIMES = [
  {
    id: 'claude' as const,
    label: 'Claude Code',
    vendor: 'Anthropic',
    accent: '#D97757',
    tint: 'rgba(217, 119, 87, 0.12)',
    border: 'rgba(217, 119, 87, 0.58)',
    Icon: ClaudeIcon,
  },
  {
    id: 'codex' as const,
    label: 'Codex',
    vendor: 'OpenAI',
    accent: '#7A9DFF',
    tint: 'rgba(122, 157, 255, 0.12)',
    border: 'rgba(122, 157, 255, 0.58)',
    Icon: CodexIcon,
  },
] as const;

function TaskModal({
  mode,
  project,
  agents,
  codexReady,
  initialCliType,
  permissions,
  onClose,
  onLaunch,
}: {
  mode: LaunchMode;
  project: Project;
  agents: ProjectAgent[];
  codexReady: boolean;
  initialCliType: 'claude' | 'codex';
  permissions: ProjectToolPermissions;
  onClose: () => void;
  onLaunch: (task: string, agentType?: string, cliType?: 'claude' | 'codex') => void;
}) {
  const [task, setTask] = useState('');
  const [agentType, setAgentType] = useState(agents[0]?.name || 'coder');
  const [cliType, setCliType] = useState<'claude' | 'codex'>(initialCliType);
  const [sessionPrompt, setSessionPrompt] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const sessionPromptVal = (sessionPrompt ?? project.session_prompt ?? '').trim();
  const effectiveTask = task.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  const finalTask = sessionPromptVal
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${sessionPromptVal}`
    : effectiveTask;
  const selectedRuntime = CLI_RUNTIMES.find((runtime) => runtime.id === cliType) ?? CLI_RUNTIMES[0];
  const cliLabel = selectedRuntime.label;
  const cliAccent = selectedRuntime.accent;
  const modeAccent = mode === 'agent' ? '#E85D75' : cliAccent;

  const handleLaunch = () => {
    if ((cliType === 'claude' && !permissions.can_claude) || (cliType === 'codex' && !permissions.can_codex)) return;
    onLaunch(finalTask, mode === 'agent' ? agentType : undefined, cliType);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(4, 7, 14, 0.72)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative overflow-hidden rounded-2xl border shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'color-mix(in srgb, var(--border) 72%, white 8%)' }}
      >
        <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: modeAccent }} />
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-5 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
              style={{ color: modeAccent, borderColor: `${modeAccent}55`, background: `${modeAccent}16` }}
            >
              {mode === 'agent' ? <Bot className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--text-secondary)' }}>
                New AI workspace
              </p>
              <h2 className="truncate text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {mode === 'agent' ? 'Configure Agent' : 'Configure Session'}
              </h2>
            </div>
          </div>
          <button aria-label="Close launcher" onClick={onClose} className="rounded-lg p-2 transition-colors hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Agent role is the primary choice inside Agent mode. */}
          {mode === 'agent' && (
            <div>
              <div className="mb-2.5">
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Agent type</h3>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>Choose the specialist role for this task.</p>
              </div>
              <select
                aria-label="Agent type"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border text-sm outline-none"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-primary)',
                }}
              >
                {agents.length === 0 ? (
                  <option value="coder">coder — General coding agent</option>
                ) : agents.map((agent) => (
                  <option key={agent.name} value={agent.name} title={agent.description}>
                    {agent.name} — {agent.description.slice(0, 60)}{agent.description.length > 60 ? '...' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* CLI type selector */}
          <div>
            <div className="mb-2.5 flex items-end justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Runtime</h3>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>Choose which CLI runs this workspace.</p>
              </div>
              <span className="hidden text-[10px] font-mono uppercase tracking-widest sm:block" style={{ color: 'var(--text-secondary)' }}>Required</span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {CLI_RUNTIMES.map((runtime) => {
                const selected = cliType === runtime.id;
                const allowed = runtime.id === 'claude' ? permissions.can_claude : permissions.can_codex;
                const RuntimeIcon = runtime.Icon;
                return (
                  <button
                    key={runtime.id}
                    type="button"
                    aria-label={`${runtime.label}, ${runtime.vendor} CLI`}
                    onClick={() => setCliType(runtime.id)}
                    disabled={!allowed}
                    aria-pressed={selected}
                    className="flex min-h-16 items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-35"
                    style={{
                      background: selected ? runtime.tint : 'var(--bg-primary)',
                      color: selected ? runtime.accent : 'var(--text-secondary)',
                      borderColor: selected ? runtime.border : 'var(--border)',
                    }}
                  >
                    <RuntimeIcon className="w-5 h-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{runtime.label}</span>
                      <span className="block text-[11px]">{runtime.vendor} CLI</span>
                    </span>
                    {selected && <Check className="w-4 h-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Info box */}
          <div
            className="rounded-xl border p-4 space-y-2"
            style={{ background: `${modeAccent}0B`, borderColor: `${modeAccent}44` }}
          >
            {mode === 'session' ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: cliAccent }}>
                  <Zap className="w-4 h-4" />
                  {cliLabel} interactive session
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Work directly with {cliLabel} for development, debugging, and guided tasks in this project.
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium" style={{ color: modeAccent }}>
                  <Bot className="w-4 h-4" />
                  {cliLabel} specialist agent
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Assign one focused role for code review, testing, security, documentation, or another specialist task.
                </div>
              </>
            )}
          </div>

          {/* Task input */}
          <div>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Task / Objective</h3>
            <textarea
              ref={textareaRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={`Describe what you want ${mode === 'agent' ? `the ${agentType} agent` : cliLabel} to do...\n\nLeave empty to start interactively.`}
              rows={5}
              className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
                minHeight: '120px',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (cliType === 'codex' && !codexReady) return;
                  handleLaunch();
                }
              }}
            />
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Ctrl / Cmd + Enter to launch
              </p>
            </div>
          </div>

          {/* Prompt override — switches between CLAUDE.md and AGENTS.md based on CLI toggle */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'} Prompt Override
              </h3>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Prepended to task as additional instructions
              </span>
            </div>
            <textarea
              value={sessionPrompt ?? project.session_prompt ?? ''}
              onChange={(e) => setSessionPrompt(e.target.value)}
              placeholder={`Additional instructions prepended to the task (supplements your project's ${cliType === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'})...`}
              rows={2}
              className="w-full px-4 py-3 rounded-lg border text-sm outline-none resize-y"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            {sessionPrompt !== null && (
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                Modified for this session only.
              </p>
            )}
          </div>

        </div>

        {/* Persistent action bar: launch remains reachable on short screens. */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t px-6 py-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleLaunch}
            disabled={(cliType === 'codex' && (!codexReady || !permissions.can_codex)) || (cliType === 'claude' && !permissions.can_claude)}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: modeAccent, color: 'white', boxShadow: `0 8px 24px ${modeAccent}30` }}
            title={cliType === 'codex' && !codexReady ? 'Codex not initialized' : undefined}
          >
            {mode === 'agent' ? <Users className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            Launch {cliLabel} {mode === 'agent' ? 'Agent' : 'Session'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SessionLauncher({ project, onSessionCreated, onWebPageCreated }: SessionLauncherProps) {
  const [webUrl, setWebUrl] = useState('');
  const [launchIntent, setLaunchIntent] = useState<LaunchIntent | null>(null);
  const queryClient = useQueryClient();
  const permissions: ProjectToolPermissions = project.tool_access || {
    can_session: true, can_agent: true, can_terminal: true, can_claude: true, can_codex: true,
  };
  const hasCli = permissions.can_claude || permissions.can_codex;

  // Fetch available agent types for this project (reads .claude/agents/ — standard Claude Code feature)
  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', project.id],
    queryFn: () => api.projects.projectAgents(project.id),
    staleTime: 120_000,
  });
  const agents = agentsData?.agents ?? [];

  const createMutation = useMutation({
    mutationFn: (opts: { task: string; mode: 'session' | 'agent'; agentType?: string; cliType?: 'claude' | 'codex' }) => {
      return api.sessions.create({
        project_path: project.path,
        task: opts.task,
        mode: opts.mode,
        agent_type: opts.agentType,
        project_id: project.id,
        cli_type: opts.cliType,
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setLaunchIntent(null);
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'session');
      }
    },
  });

  const terminalMutation = useMutation({
    mutationFn: () => {
      return api.sessions.create({ project_path: project.path, mode: 'terminal', project_id: project.id });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      if (data.session?.id) {
        onSessionCreated(data.session.id, undefined, 'terminal');
      }
    },
  });

  const handleLaunch = (task: string, agentType?: string, cliType?: 'claude' | 'codex') => {
    const mode = agentType ? 'agent' : 'session';
    createMutation.mutate({ task, mode, agentType, cliType });
  };

  // Fetch git status for project info (may fail if not a git repo)
  const { data: gitData, isError: gitError } = useQuery({
    queryKey: ['git-status', project.path],
    queryFn: () => api.git.status(project.path),
    staleTime: 30_000,
    retry: false,
  });

  // Fetch active sessions count
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions.list(),
  });
  const activeSessions = (sessionsData?.sessions || []).filter(
    (s) => s.project_id === project.id && (s.status === 'running' || s.status === 'detached')
  );

  const preferredAgentCli: 'claude' | 'codex' = permissions.can_claude ? 'claude' : 'codex';

  return (
    <div className="h-full overflow-y-auto p-6 pt-8">
      <div className="w-full max-w-4xl mx-auto space-y-6">
        {/* Project info card */}
        <div
          className="rounded-xl border p-5"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {project.name}
              </h3>
              {project.description && (
                <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {project.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--success)' }}
              >
                <Cpu className="w-3 h-3" />
                Ready
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Path</span>
              </div>
              <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }} title={project.path}>
                {project.path.replace(/^\/home\/[^/]+/, '~')}
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Branch</span>
              </div>
              {gitError ? (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No git repo</p>
              ) : (
                <p className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                  {gitData?.branch || '...'}
                  {gitData && (gitData.ahead > 0 || gitData.behind > 0) && (
                    <span style={{ color: 'var(--warning)' }}>
                      {gitData.ahead > 0 ? ` +${gitData.ahead}` : ''}
                      {gitData.behind > 0 ? ` -${gitData.behind}` : ''}
                    </span>
                  )}
                </p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Activity className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Sessions</span>
              </div>
              <p className="text-xs" style={{ color: activeSessions.length > 0 ? 'var(--success)' : 'var(--text-primary)' }}>
                {activeSessions.length} active
              </p>
              {gitData?.files && gitData.files.length > 0 && (
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--warning)' }}>{gitData.files.length} file{gitData.files.length !== 1 ? 's' : ''} changed</p>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Agents</span>
              </div>
              <p className="text-xs" style={{ color: agents.length > 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {agents.length > 0 ? `${agents.length} available` : 'None'}
              </p>
            </div>
          </div>
        </div>

        {/* AI workspace launch rail */}
        <section
          className="overflow-hidden rounded-2xl border"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
          aria-labelledby="new-workspace-title"
        >
          <div className="flex flex-col gap-2 px-5 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--text-secondary)' }}>Launch rail</p>
              <h2 id="new-workspace-title" className="mt-1 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Choose how you want to work</h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>Choose a workspace mode first, then select its runtime and task details.</p>
            </div>
            <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>2 workspace modes</span>
          </div>

          <div className="grid gap-3 px-5 pb-5 md:grid-cols-2">
            <button
              type="button"
              aria-label="Configure Session"
              onClick={() => setLaunchIntent({ mode: 'session', cliType: preferredAgentCli })}
              disabled={createMutation.isPending || !permissions.can_session || !hasCli}
              className="group relative min-h-40 overflow-hidden rounded-xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 motion-reduce:transform-none disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'linear-gradient(145deg, rgba(96,165,250,0.13), var(--bg-primary) 62%)', borderColor: 'rgba(96,165,250,0.38)' }}
            >
              <span className="absolute inset-x-0 top-0 h-0.5 bg-[#60A5FA]" />
              <span className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border text-[#60A5FA]" style={{ borderColor: 'rgba(96,165,250,0.4)', background: 'rgba(96,165,250,0.12)' }}>
                  <Zap className="h-5 w-5" />
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Interactive</span>
              </span>
              <span className="mt-4 block text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Session</span>
              <span className="mt-1 block text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Work interactively, then choose Claude Code, Codex, or another available runtime.</span>
              <span className="mt-4 flex items-center gap-1 text-xs font-semibold text-[#60A5FA]">Configure Session <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </button>

            <button
              type="button"
              aria-label="Configure Agents"
              onClick={() => setLaunchIntent({ mode: 'agent', cliType: preferredAgentCli })}
              disabled={createMutation.isPending || !permissions.can_agent || !hasCli}
              className="group relative min-h-40 overflow-hidden rounded-xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 motion-reduce:transform-none disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'linear-gradient(145deg, rgba(232,93,117,0.13), var(--bg-primary) 62%)', borderColor: 'rgba(232,93,117,0.38)' }}
            >
              <span className="absolute inset-x-0 top-0 h-0.5 bg-[#E85D75]" />
              <span className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg border text-[#E85D75]" style={{ borderColor: 'rgba(232,93,117,0.4)', background: 'rgba(232,93,117,0.12)' }}>
                  <Bot className="h-5 w-5" />
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{agents.length || 'Custom'} roles</span>
              </span>
              <span className="mt-4 block text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Agents</span>
              <span className="mt-1 block text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Choose a specialist role and the runtime that should execute it.</span>
              <span className="mt-4 flex items-center gap-1 text-xs font-semibold text-[#E85D75]">Configure Agents <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </button>
          </div>

          <div className="flex flex-col gap-3 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg-primary) 58%, transparent)' }}>
            <div className="flex items-center gap-2.5">
              <TerminalSquare className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Need a shell instead?</p>
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>Open a plain terminal in the project directory.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => terminalMutation.mutate()}
              disabled={terminalMutation.isPending || !permissions.can_terminal}
              className="flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: 'var(--border)', color: 'var(--text-primary)', background: 'var(--bg-secondary)' }}
            >
              {terminalMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TerminalSquare className="h-3.5 w-3.5" />}
              Open terminal
            </button>
          </div>
        </section>

        {/* Web page section */}
        {onWebPageCreated && (() => {
          const defaultUrl = project.default_web_url || 'http://localhost:3000';
          const resolvedUrl = webUrl.trim() || defaultUrl;
          return (
            <div
              className="rounded-xl border p-4 space-y-3"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Open Web Page
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  placeholder={defaultUrl}
                  className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onWebPageCreated(resolvedUrl);
                      setWebUrl('');
                    }
                  }}
                />
                <button
                  onClick={() => {
                    onWebPageCreated(resolvedUrl);
                    setWebUrl('');
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  <Globe className="w-4 h-4" />
                  Open
                </button>
              </div>
            </div>
          );
        })()}

        {(createMutation.isError || terminalMutation.isError) && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            {((createMutation.error || terminalMutation.error) as Error).message}
          </p>
        )}

        {/* Task modal */}
        {launchIntent && (
          <TaskModal
            mode={launchIntent.mode}
            project={project}
            agents={agents}
            codexReady={true}
            initialCliType={launchIntent.cliType}
            permissions={permissions}
            onClose={() => setLaunchIntent(null)}
            onLaunch={handleLaunch}
          />
        )}

      </div>
    </div>
  );
}
