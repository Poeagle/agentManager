import { useState } from 'react';
import { Dialog } from './Dialog';
import { SessionScheduleButton, SessionTabBadges, type SessionScheduleAction } from '../lib/session-activity';

export function SessionTabSwitcher({ tabs, activeId, scheduleError, onSelect, onClose }: {
  tabs: { id: string; label: string; schedule?: SessionScheduleAction; account?: string }[];
  activeId?: string | null;
  scheduleError?: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const matches = tabs.filter(tab => tab.label.toLocaleLowerCase().includes(search));

  return <Dialog title="切换会话" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      const first = matches[0];
      if (first) onSelect(first.id);
    }}>
      <input
        type="search"
        aria-label="搜索会话"
        placeholder="搜索会话名称"
        value={query}
        onChange={event => setQuery(event.target.value)}
        className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm focus-visible:outline-[var(--accent)]"
      />
    </form>
    {scheduleError && <p role="alert" className="px-2 py-1 text-xs text-[var(--error)]">{scheduleError}</p>}
    {matches.length ? <ul aria-label="已打开的会话">
      {matches.map(tab => <li key={tab.id} className="flex items-center gap-1">
        <button
          type="button"
          aria-current={tab.id === activeId ? true : undefined}
          aria-description={tab.account ? `账号：${tab.account}` : undefined}
          onClick={() => onSelect(tab.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] aria-[current=true]:font-semibold aria-[current=true]:text-[var(--accent)]"
          title={tab.label}
        ><span className="truncate">{tab.label}</span><SessionTabBadges account={tab.account} /></button>
        {tab.schedule && <SessionScheduleButton {...tab.schedule} />}
      </li>)}
    </ul> : <p role="status" className="px-3 py-2 text-sm text-[var(--text-secondary)]">没有匹配的会话</p>}
  </Dialog>;
}
