import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AuthUser, type Project, type ProjectToolPermissions, type ProjectUserAccess } from '../lib/api';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';

const inputCls = 'px-2.5 py-1.5 rounded-md text-sm outline-none';
const inputStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' } as const;

export function AccountModal({ currentUser, onClose }: { currentUser: AuthUser; onClose: () => void }) {
  const isAdmin = currentUser.role === 'admin';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[88vh] overflow-y-auto rounded-xl p-5 flex flex-col gap-5"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>账户与用户</h2>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-secondary)' }}><X className="w-4 h-4" /></button>
        </div>

        <ChangePassword />
        {isAdmin && <UserAdmin currentUserId={currentUser.id} />}
        {isAdmin && <ProjectAccessAdmin />}
      </div>
    </div>
  );
}

const EMPTY_ACCESS: ProjectToolPermissions = {
  can_session: false,
  can_agent: false,
  can_terminal: false,
  can_claude: false,
  can_codex: false,
};

const ACCESS_COLUMNS: Array<{ key: keyof ProjectToolPermissions; label: string; hint: string }> = [
  { key: 'can_session', label: 'Session', hint: '交互会话' },
  { key: 'can_agent', label: 'Agent', hint: '任务代理' },
  { key: 'can_terminal', label: 'Terminal', hint: '命令行终端' },
  { key: 'can_claude', label: 'Claude', hint: 'Claude Code' },
  { key: 'can_codex', label: 'Codex', hint: 'Codex' },
];

function ProjectAccessAdmin() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [projectId, setProjectId] = useState('');
  const [grants, setGrants] = useState<Record<string, ProjectUserAccess>>({});
  const [drafts, setDrafts] = useState<Record<string, ProjectToolPermissions>>({});
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    Promise.all([api.projects.list(), api.users.list()])
      .then(([p, u]) => {
        setProjects(p.projects);
        setUsers(u.users);
        setProjectId((current) => current || p.projects[0]?.id || '');
      })
      .catch((e) => setErr(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const loadAccess = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true); setErr('');
    try {
      const rows = (await api.projects.access(id)).access;
      const nextGrants = Object.fromEntries(rows.map((row) => [row.user_id, row]));
      setGrants(nextGrants);
      setDrafts(Object.fromEntries(users.map((user) => {
        const row = nextGrants[user.id];
        return [user.id, row ? {
          can_session: row.can_session,
          can_agent: row.can_agent,
          can_terminal: row.can_terminal,
          can_claude: row.can_claude,
          can_codex: row.can_codex,
        } : { ...EMPTY_ACCESS }];
      })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载权限失败');
    } finally { setLoading(false); }
  }, [users]);

  useEffect(() => { if (projectId && users.length) loadAccess(projectId); }, [projectId, users.length, loadAccess]);

  const toggle = (userId: string, key: keyof ProjectToolPermissions) => {
    setDrafts((prev) => ({
      ...prev,
      [userId]: { ...(prev[userId] || EMPTY_ACCESS), [key]: !(prev[userId] || EMPTY_ACCESS)[key] },
    }));
  };

  const save = async (userId: string) => {
    setBusyUser(userId); setErr('');
    try {
      const value = drafts[userId] || EMPTY_ACCESS;
      if (Object.values(value).every((allowed) => !allowed)) {
        if (grants[userId]) await api.projects.removeAccess(projectId, userId);
      } else {
        await api.projects.setAccess(projectId, userId, value);
      }
      await loadAccess(projectId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存权限失败');
    } finally { setBusyUser(null); }
  };

  return (
    <section className="flex flex-col gap-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            <ShieldCheck className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            项目与工具权限
          </h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            先选项目，再勾选每位用户能使用的入口。全部不勾选表示看不到该项目。
          </p>
        </div>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`${inputCls} min-w-52`} style={inputStyle}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent)' }} /></div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg px-3 py-4 text-xs" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>请先创建项目。</div>
      ) : (
        <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
          <table className="w-full min-w-[690px] text-xs">
            <thead style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
              <tr>
                <th className="px-3 py-2 text-left font-medium">用户</th>
                {ACCESS_COLUMNS.map((col) => <th key={col.key} className="px-2 py-2 text-center font-medium" title={col.hint}>{col.label}</th>)}
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const value = drafts[user.id] || EMPTY_ACCESS;
                const original = grants[user.id];
                const changed = ACCESS_COLUMNS.some(({ key }) => value[key] !== (original?.[key] ?? false));
                return (
                  <tr key={user.id} style={{ borderTop: '1px solid var(--border)', opacity: user.disabled ? 0.55 : 1 }}>
                    <td className="px-3 py-2">
                      <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{user.display_name || user.username}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>@{user.username}{user.role === 'admin' ? ' · 管理员默认全权限' : ''}</div>
                    </td>
                    {ACCESS_COLUMNS.map(({ key, hint }) => (
                      <td key={key} className="px-2 py-2 text-center">
                        <button
                          type="button"
                          disabled={user.role === 'admin' || !!user.disabled}
                          onClick={() => toggle(user.id, key)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md disabled:cursor-not-allowed"
                          style={{
                            background: (user.role === 'admin' || value[key]) ? 'var(--accent)' : 'var(--bg-tertiary)',
                            color: (user.role === 'admin' || value[key]) ? 'white' : 'transparent',
                            border: `1px solid ${(user.role === 'admin' || value[key]) ? 'var(--accent)' : 'var(--border)'}`,
                          }}
                          title={hint}
                        ><Check className="w-3.5 h-3.5" /></button>
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      {user.role !== 'admin' && (
                        <button
                          type="button"
                          disabled={!changed || busyUser === user.id}
                          onClick={() => save(user.id)}
                          className="rounded-md px-2.5 py-1 font-medium disabled:opacity-35"
                          style={{ background: 'var(--accent)', color: 'white' }}
                        >{busyUser === user.id ? '保存中' : '保存'}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {err && <div className="text-xs" style={{ color: 'var(--error)' }}>{err}</div>}
    </section>
  );
}

function ChangePassword() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api.auth.changePassword({ current_password: cur, new_password: next });
      setMsg({ ok: true, text: '密码已修改' });
      setCur(''); setNext('');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '失败' });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>修改我的密码</h3>
      <div className="flex flex-col sm:flex-row gap-2">
        <input type="password" placeholder="当前密码" value={cur} onChange={(e) => setCur(e.target.value)} className={`${inputCls} flex-1`} style={inputStyle} autoComplete="current-password" />
        <input type="password" placeholder="新密码(≥6位)" value={next} onChange={(e) => setNext(e.target.value)} className={`${inputCls} flex-1`} style={inputStyle} autoComplete="new-password" />
        <button type="submit" disabled={busy || !cur || !next} className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>保存</button>
      </div>
      {msg && <div className="text-xs" style={{ color: msg.ok ? 'var(--success)' : 'var(--error)' }}>{msg.text}</div>}
    </form>
  );
}

function UserAdmin({ currentUserId }: { currentUserId: string }) {
  const [err, setErr] = useState('');
  const [nu, setNu] = useState({ username: '', password: '', display_name: '', role: 'member' as 'admin' | 'member', max_tabs: 10, can_create_projects: false });

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: api.users.list,
  });
  const users = usersQuery.data?.users ?? [];
  const displayedError = err || (usersQuery.error instanceof Error ? usersQuery.error.message : '');

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); await usersQuery.refetch(); } catch (e) { setErr(e instanceof Error ? e.message : '失败'); }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => { await api.users.create(nu); setNu({ username: '', password: '', display_name: '', role: 'member', max_tabs: 10, can_create_projects: false }); });
  };

  const removeUser = (user: AuthUser) => {
    const confirmed = window.confirm(
      `确定删除用户“${user.display_name || user.username}”吗？\n\n该用户的所有活动会话会立即关闭；已结束的会话记录会保留。`,
    );
    if (confirmed) act(() => api.users.delete(user.id));
  };

  return (
    <div className="flex flex-col gap-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>用户管理</h3>

      <div className="flex flex-col gap-1.5">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 text-sm rounded-md px-2.5 py-1.5" style={{ background: 'var(--bg-tertiary)' }}>
            <span className="flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
              {u.display_name || u.username}
              <span className="ml-1 text-xs" style={{ color: 'var(--text-secondary)' }}>@{u.username}</span>
              {u.disabled ? <span className="ml-1 text-xs" style={{ color: 'var(--error)' }}>(已禁用)</span> : null}
            </span>
            <button
              onClick={() => act(() => api.users.update(u.id, { role: u.role === 'admin' ? 'member' : 'admin' }))}
              className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: u.role === 'admin' ? 'var(--accent)' : 'var(--text-secondary)' }}
              title="切换管理员"
            >{u.role}</button>
            <button
              onClick={() => { const p = prompt(`为 ${u.username} 设置新密码(≥6位)`); if (p) act(() => api.users.update(u.id, { password: p })); }}
              className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            >重置密码</button>
            {u.role !== 'admin' && (
              <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={u.can_create_projects === 1} onChange={(e) => act(() => api.users.update(u.id, { can_create_projects: e.target.checked }))} aria-label={`允许 ${u.username} 添加项目`} />
                允许添加项目
              </label>
            )}
            {u.role !== 'admin' && (
              <TabLimitInput key={`${u.id}:${u.max_tabs ?? 10}`} value={u.max_tabs ?? 10} onSave={(max_tabs) => act(() => api.users.update(u.id, { max_tabs }))} />
            )}
            {u.id !== currentUserId && (
              <>
                <button
                  onClick={() => act(() => api.users.update(u.id, { disabled: !u.disabled }))}
                  className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: u.disabled ? 'var(--success)' : 'var(--error)' }}
                >{u.disabled ? '启用' : '禁用'}</button>
                <button
                  onClick={() => removeUser(u)}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(239,68,68,.12)', color: 'var(--error)' }}
                  title="永久删除用户账户"
                >删除</button>
              </>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={create} className="flex flex-col gap-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>新建用户</span>
        <div className="flex flex-wrap gap-2">
          <input placeholder="用户名" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} className={`${inputCls} flex-1 min-w-[100px]`} style={inputStyle} />
          <input type="password" placeholder="密码(≥6位)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} className={`${inputCls} flex-1 min-w-[100px]`} style={inputStyle} />
          <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as 'admin' | 'member' })} className={inputCls} style={inputStyle}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          {nu.role === 'member' && (
            <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={nu.can_create_projects} onChange={(e) => setNu({ ...nu, can_create_projects: e.target.checked })} />
              允许添加项目
            </label>
          )}
          {nu.role === 'member' && (
            <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              标签上限
              <input
                type="number"
                min="0"
                max="100"
                value={nu.max_tabs}
                onChange={(e) => setNu({ ...nu, max_tabs: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                className={`${inputCls} w-16`}
                style={inputStyle}
                title="最多活动会话标签数；0 表示禁止创建"
                aria-label="最多活动标签页"
              />
            </label>
          )}
          <button type="submit" disabled={!nu.username || !nu.password} className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>创建</button>
        </div>
      </form>

      {displayedError && <div className="text-xs" style={{ color: 'var(--error)' }}>{displayedError}</div>}
    </div>
  );
}

function TabLimitInput({ value, onSave }: { value: number; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }} title="最多活动会话标签数；0 表示禁止创建">
      上限
      <input
        type="number"
        min="0"
        max="100"
        value={draft}
        onChange={(e) => setDraft(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
        onBlur={() => { if (draft !== value) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-14 rounded px-1.5 py-0.5 text-xs outline-none"
        style={inputStyle}
      />
    </label>
  );
}
