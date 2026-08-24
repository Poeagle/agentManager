import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Clock, Filter, Loader2, Monitor, Plus, RefreshCw } from 'lucide-react';
import { api, type Session } from '../lib/api';
import { ClaudeIcon, CodexIcon } from './CliIcons';

const ACTIVE = new Set(['running', 'detached', 'pending', 'launching']);
type SortKey = 'name' | 'agent' | 'created' | 'updated' | 'summary';
type SortDirection = 'asc' | 'desc';

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionKind(session: Session): string {
  if (session.agent_type) return session.agent_type;
  if (session.cli_type === 'codex') return 'Codex';
  if (session.cli_type === 'claude') return 'Claude';
  return session.mode === 'terminal' ? '终端会话' : '会话';
}

function sessionTitle(session: Session, displayName?: string): string {
  return displayName?.trim() || session.task?.trim() || sessionKind(session);
}

function sessionSummary(session: Session): string {
  return session.content_summary?.trim() || session.task?.trim() || '暂无会话内容';
}

function sessionActivity(session: Session): string | null | undefined {
  return session.last_activity_at || session.completed_at || session.started_at || session.created_at;
}

function cleanTerminalText(value: string): string {
  return value
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))|\r/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
}

function SessionIcon({ session }: { session: Session }) {
  if (session.cli_type === 'codex') return <CodexIcon className="h-3.5 w-3.5 shrink-0" style={{ color: '#60a5fa' }} />;
  if (session.cli_type === 'claude') return <ClaudeIcon className="h-3.5 w-3.5 shrink-0" style={{ color: '#D97757' }} />;
  return <Monitor className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />;
}

function SessionDetails({ session }: { session: Session }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['project-session-detail', session.id],
    queryFn: () => api.sessions.output(session.id, { limit: 5 }),
  });
  const contents = (data?.chunks || []).map((chunk) => cleanTerminalText(chunk.data)).filter(Boolean);

  return (
    <tr style={{ background: 'color-mix(in srgb, var(--bg-tertiary) 52%, transparent)' }}>
      <td colSpan={6} className="px-8 py-3">
        <div className="rounded-md border px-3 py-2.5" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
          <p className="mb-2 text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>最近会话内容</p>
          {isLoading ? (
            <div className="flex items-center gap-2 py-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</div>
          ) : isError ? (
            <p className="text-[11px]" style={{ color: 'var(--error)' }}>无法加载会话内容。</p>
          ) : contents.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>暂无会话内容。</p>
          ) : (
            <div className="space-y-1.5">
              {contents.map((content, index) => <pre key={`${session.id}-${index}`} className="max-h-20 overflow-hidden whitespace-pre-wrap break-words rounded px-2 py-1.5 text-[11px] leading-4" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{content}</pre>)}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === activeKey;
  return <button type="button" onClick={() => onSort(sortKey)} className="flex items-center gap-1 text-left text-[10px] font-medium transition-colors hover:text-[var(--text-primary)]" style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
    {label}
    {active ? direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" /> : <ChevronDown className="h-3 w-3 opacity-30" />}
  </button>;
}

function FilterButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} title="筛选此列" aria-label="筛选此列" className="rounded p-1 transition-colors hover:bg-[var(--bg-tertiary)]" style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)', background: active ? 'var(--bg-tertiary)' : 'transparent' }}><Filter className="h-3 w-3" /></button>;
}

function TextFilter({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) {
  return <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-7 w-44 rounded border px-2 text-[11px]" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', borderColor: 'var(--border)', outline: 'none' }} />;
}

function ColumnHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  filterOpen,
  filterActive,
  onToggleFilter,
  children,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  filterOpen: boolean;
  filterActive: boolean;
  onToggleFilter: () => void;
  children: ReactNode;
}) {
  return <div className="relative flex min-w-0 items-center gap-1">
    <SortHeader label={label} sortKey={sortKey} activeKey={activeKey} direction={direction} onSort={onSort} />
    <FilterButton active={filterActive} onClick={onToggleFilter} />
    {filterOpen && <div className="absolute left-0 top-7 z-30 rounded-md border p-2 shadow-lg" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>{children}</div>}
  </div>;
}

function ProjectSessionRow({
  session,
  isOpen,
  displayName,
  expanded,
  onToggle,
  onOpen,
}: {
  session: Session;
  isOpen: boolean;
  displayName?: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (session: Session) => void;
}) {
  const active = ACTIVE.has(session.status);
  const activity = sessionActivity(session);
  const summary = sessionSummary(session);

  return <>
    <tr className="group h-10 transition-colors hover:bg-[var(--bg-tertiary)]" style={{ background: isOpen ? 'var(--bg-tertiary)' : 'transparent', boxShadow: isOpen ? 'inset 2px 0 0 var(--accent)' : 'inset 2px 0 0 transparent' }}>
      <td className="w-8 px-2 text-center">
        <button type="button" onClick={onToggle} className="rounded p-0.5 transition-colors hover:bg-[var(--bg-primary)]" style={{ color: 'var(--text-secondary)' }} title={expanded ? '收起详情' : '展开详情'}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
      </td>
      <td className="px-3 py-1.5 align-middle">
        <button type="button" onClick={() => onOpen(session)} className="flex min-w-0 max-w-full items-center gap-2 text-left" title={isOpen ? '跳转到该标签页' : '打开该会话标签页'}>
          <span className="relative flex shrink-0 items-center justify-center"><SessionIcon session={session} /><span className="absolute -right-1 -bottom-0.5 rounded-full" style={{ width: 6, height: 6, background: active ? '#3b82f6' : 'var(--border)', boxShadow: active ? '0 0 5px #3b82f6' : 'none' }} /></span>
          <span className="truncate text-xs font-semibold transition-colors group-hover:text-[var(--accent)]" style={{ color: 'var(--text-primary)' }}>{sessionTitle(session, displayName)}</span>
        </button>
      </td>
      <td className="px-3 py-1.5 align-middle text-[11px]" style={{ color: 'var(--text-secondary)' }}><span className="block truncate">{sessionKind(session)}</span><span className="block text-[10px]" style={{ color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>{active ? '运行中' : session.status}</span></td>
      <td className="whitespace-nowrap px-3 py-1.5 align-middle text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtDateTime(session.created_at)}</td>
      <td className="whitespace-nowrap px-3 py-1.5 align-middle text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{fmtDateTime(activity)}</td>
      <td className="px-3 py-1.5 align-middle text-[11px]" style={{ color: 'var(--text-secondary)' }}><span className="block truncate" title={summary}>{summary}</span></td>
    </tr>
    {expanded && <SessionDetails session={session} />}
  </>;
}

export function SessionHistoryPanel({
  projectId,
  openTabIds,
  displayNames = {},
  onOpen,
}: {
  projectId: string;
  openTabIds: Set<string>;
  displayNames?: Record<string, string>;
  onOpen: (session: Session) => void;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['project-sessions', projectId], queryFn: () => api.sessions.list(undefined, projectId), staleTime: 10_000 });
  const sessions = data?.sessions ?? [];
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [nameFilter, setNameFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState<ReadonlySet<string>>(() => new Set());
  const [createdFilter, setCreatedFilter] = useState('');
  const [updatedFilter, setUpdatedFilter] = useState('');
  const [summaryFilter, setSummaryFilter] = useState('');
  const [openFilter, setOpenFilter] = useState<SortKey | null>(null);

  const agentOptions = useMemo(() => [...new Set(sessions.map(sessionKind))].sort((a, b) => a.localeCompare(b)), [sessions]);
  const visibleSessions = useMemo(() => {
    const includes = (value: string, query: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const matching = sessions.filter((session) => {
      const name = sessionTitle(session, displayNames[session.id]);
      return includes(name, nameFilter)
        && (agentFilter.size === 0 || agentFilter.has(sessionKind(session)))
        && includes(fmtDateTime(session.created_at), createdFilter)
        && includes(fmtDateTime(sessionActivity(session)), updatedFilter)
        && includes(sessionSummary(session), summaryFilter);
    });
    const valueFor = (session: Session): string => {
      if (sortKey === 'name') return sessionTitle(session, displayNames[session.id]);
      if (sortKey === 'agent') return sessionKind(session);
      if (sortKey === 'created') return session.created_at || '';
      if (sortKey === 'updated') return sessionActivity(session) || '';
      return sessionSummary(session);
    };
    return matching.sort((a, b) => valueFor(a).localeCompare(valueFor(b), undefined, { numeric: true }) * (sortDirection === 'asc' ? 1 : -1));
  }, [sessions, displayNames, nameFilter, agentFilter, createdFilter, updatedFilter, summaryFilter, sortKey, sortDirection]);

  const toggleExpanded = (id: string) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAgent = (agent: string) => setAgentFilter((current) => {
    const next = new Set(current);
    if (next.has(agent)) next.delete(agent); else next.add(agent);
    return next;
  });
  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDirection('asc'); }
  };
  const toggleFilter = (key: SortKey) => setOpenFilter((current) => current === key ? null : key);

  return <div className="flex h-full flex-col" style={{ background: 'var(--bg-secondary)' }}>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <Clock className="h-4 w-4" style={{ color: 'var(--accent)' }} />
      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>项目会话</span>
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{visibleSessions.length}/{sessions.length}</span>
      <button onClick={() => refetch()} title="刷新" className="ml-auto rounded p-1 hover:opacity-80" style={{ color: 'var(--text-secondary)' }}><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} /></button>
    </div>
    <div className="flex-1 overflow-auto">
      {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--text-secondary)' }} /></div>
        : isError ? <div className="py-8 text-center text-xs" style={{ color: 'var(--error)' }}>加载失败: {(error as Error)?.message || '未知错误'}</div>
          : sessions.length === 0 ? <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>这个项目还没有会话</div>
            : <table className="min-w-[1040px] w-full table-fixed border-collapse text-left">
              <colgroup><col className="w-8" /><col className="w-[23%]" /><col className="w-[13%]" /><col className="w-[17%]" /><col className="w-[17%]" /><col className="w-[30%]" /></colgroup>
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                <tr>
                  <th className="px-2 py-2" />
                  <th className="px-3 py-2"><ColumnHeader label="会话名称" sortKey="name" activeKey={sortKey} direction={sortDirection} onSort={toggleSort} filterOpen={openFilter === 'name'} filterActive={!!nameFilter} onToggleFilter={() => toggleFilter('name')}><TextFilter value={nameFilter} onChange={setNameFilter} placeholder="输入名称" /></ColumnHeader></th>
                  <th className="px-3 py-2"><ColumnHeader label="Agent 类型" sortKey="agent" activeKey={sortKey} direction={sortDirection} onSort={toggleSort} filterOpen={openFilter === 'agent'} filterActive={agentFilter.size > 0} onToggleFilter={() => toggleFilter('agent')}><div className="w-44 space-y-1">{agentOptions.map((option) => <label key={option} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-primary)' }}><input type="checkbox" checked={agentFilter.has(option)} onChange={() => toggleAgent(option)} className="accent-violet-500" /><span className="truncate">{option}</span></label>)}</div></ColumnHeader></th>
                  <th className="px-3 py-2"><ColumnHeader label="创建时间" sortKey="created" activeKey={sortKey} direction={sortDirection} onSort={toggleSort} filterOpen={openFilter === 'created'} filterActive={!!createdFilter} onToggleFilter={() => toggleFilter('created')}><TextFilter value={createdFilter} onChange={setCreatedFilter} placeholder="输入时间" /></ColumnHeader></th>
                  <th className="px-3 py-2"><ColumnHeader label="最近更新" sortKey="updated" activeKey={sortKey} direction={sortDirection} onSort={toggleSort} filterOpen={openFilter === 'updated'} filterActive={!!updatedFilter} onToggleFilter={() => toggleFilter('updated')}><TextFilter value={updatedFilter} onChange={setUpdatedFilter} placeholder="输入时间" /></ColumnHeader></th>
                  <th className="px-3 py-2"><ColumnHeader label="会话概要" sortKey="summary" activeKey={sortKey} direction={sortDirection} onSort={toggleSort} filterOpen={openFilter === 'summary'} filterActive={!!summaryFilter} onToggleFilter={() => toggleFilter('summary')}><TextFilter value={summaryFilter} onChange={setSummaryFilter} placeholder="输入概要" /></ColumnHeader></th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
                {visibleSessions.map((session) => <ProjectSessionRow key={session.id} session={session} isOpen={openTabIds.has(session.id)} displayName={displayNames[session.id]} expanded={expandedIds.has(session.id)} onToggle={() => toggleExpanded(session.id)} onOpen={onOpen} />)}
              </tbody>
            </table>}
    </div>
  </div>;
}
