import { TableActionButton } from './table/TableActions';
import { useTableModel } from './table/use-table-model';
import { DataTable } from './table/DataTable';
import { useState, useEffect, useCallback } from 'react';
import { api, type AuthUser, type Project, type ProjectToolPermissions, type SessionClient, type ProjectUserAccess } from '../lib/api';
import { Check, X } from 'lucide-react';

const inputCls = 'px-2.5 py-1.5 rounded-md text-sm outline-none';
const inputStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' } as const;

export function AccountModal({ currentUser, onClose }: { currentUser: AuthUser; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[88vh] overflow-y-auto rounded-xl p-5 flex flex-col gap-5"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>我的账户 · {currentUser.display_name || currentUser.username}</h2>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-secondary)' }}><X className="w-4 h-4" /></button>
        </div>

        <ChangePassword />
      </div>
    </div>
  );
}

const EMPTY_ACCESS: ProjectToolPermissions = { can_session: false, can_terminal: false, session_clients: [] };

export function ProjectAccessAdmin({ readOnly = false }: { readOnly?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [projectId, setProjectId] = useState('');
  const [grants, setGrants] = useState<Record<string, ProjectUserAccess>>({});
  const [drafts, setDrafts] = useState<Record<string, ProjectToolPermissions>>({});
  const [clients, setClients] = useState<SessionClient[]>([]);
  const [openClients, setOpenClients] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api.projects.list(), api.users.list()]).then(([p, u]) => {
      setProjects(p.projects); setUsers(u.users); setProjectId(p.projects[0]?.id ?? '');
    }).catch((failure) => setError(failure.message)).finally(() => setLoading(false));
  }, []);
  const loadAccess = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true); setError(''); setOpenClients(null);
    try {
      const data = await api.projects.access(id);
      setClients(data.clients);
      const next = Object.fromEntries(data.access.map((row) => [row.user_id, row]));
      setGrants(next);
      setDrafts(Object.fromEntries(users.map((user) => [user.id, next[user.id] ? {
        can_session: next[user.id].can_session, can_terminal: next[user.id].can_terminal,
        session_clients: next[user.id].session_clients,
      } : { ...EMPTY_ACCESS }])));
    } catch (failure) { setError(failure instanceof Error ? failure.message : '加载权限失败'); }
    finally { setLoading(false); }
  }, [users]);
  useEffect(() => { if (projectId && users.length) void loadAccess(projectId); }, [projectId, users.length, loadAccess]);
  function toggleClient(userId: string, clientId: string) {
    setDrafts((current) => {
      const value = current[userId] ?? EMPTY_ACCESS;
      const selected = value.session_clients.includes(clientId) ? value.session_clients.filter((id) => id !== clientId) : [...value.session_clients, clientId];
      return { ...current, [userId]: { ...value, can_session: selected.length > 0, session_clients: selected } };
    });
  }
  async function save(userId: string) {
    setBusyUser(userId); setError('');
    try {
      const value = drafts[userId] ?? EMPTY_ACCESS;
      if (!value.can_session && !value.can_terminal) { if (grants[userId]) await api.projects.removeAccess(projectId, userId); }
      else await api.projects.setAccess(projectId, userId, value);
      await loadAccess(projectId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存权限失败'); }
    finally { setBusyUser(null); }
  }
  const accessTable = useTableModel(users, [
    { key: 'user', title: '用户', value: (user) => `${user.display_name || user.username} @${user.username}` },
    { key: 'session', title: 'Session', value: (user) => (user.role === 'admin' ? clients.map((client) => client.id) : drafts[user.id]?.session_clients ?? []).map((id) => clients.find((client) => client.id === id)?.label ?? id).join('、') || '未授权' },
    { key: 'terminal', title: 'Terminal', value: (user) => user.role === 'admin' || !!drafts[user.id]?.can_terminal },
  ]);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3"><label className="text-xs" htmlFor="access-project">项目</label><select id="access-project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className={inputCls} style={inputStyle}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.owner ? ` · ${project.owner.username}` : ''}</option>)}</select><p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Session 可选择客户端；Terminal 单独授权。</p></div>
      <DataTable label="项目授权" model={accessTable} minWidth={560} actions loading={loading} empty={projects.length === 0 || accessTable.rows.length === 0} emptyMessage={projects.length ? '没有匹配的用户' : '请先创建项目。'}>{accessTable.rows.map((user) => {
        const value = drafts[user.id] ?? EMPTY_ACCESS;
        const original = grants[user.id] ?? EMPTY_ACCESS;
        const changed = value.can_terminal !== original.can_terminal || value.can_session !== original.can_session || [...value.session_clients].sort().join(',') !== [...original.session_clients].sort().join(',');
        const disabled = readOnly || user.role === 'admin' || !!user.disabled || busyUser === user.id;
        const selected = user.role === 'admin' ? clients.map((client) => client.id) : value.session_clients;
        return <tr key={user.id}>
          <td><span>{user.display_name || user.username}</span><span className="ml-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>@{user.username}</span>{user.role === 'admin' && <span className="ml-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>管理员</span>}</td>
          <td><TableActionButton disabled={disabled} aria-expanded={openClients === user.id} aria-label={`配置 ${user.username} 的 Session 客户端`} onClick={() => setOpenClients(openClients === user.id ? null : user.id)}  style={{ color: selected.length ? 'var(--accent)' : 'var(--text-secondary)' }}>{selected.length ? selected.map((id) => clients.find((client) => client.id === id)?.label ?? id).join('、') : '选择客户端'}</TableActionButton>{openClients === user.id && <fieldset aria-label={`${user.username} 的 Session 客户端`} disabled={disabled} className="mt-2 flex flex-wrap gap-3 py-1">{clients.map((client) => <label key={client.id} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={selected.includes(client.id)} onChange={() => toggleClient(user.id, client.id)} />{client.label}</label>)}</fieldset>}</td>
          <td><input type="checkbox" aria-label={`允许 ${user.username} 使用 Terminal`} disabled={disabled} checked={user.role === 'admin' || value.can_terminal} onChange={(event) => setDrafts((current) => ({ ...current, [user.id]: { ...(current[user.id] ?? EMPTY_ACCESS), can_terminal: event.target.checked } }))} /></td>
          <td>{user.role !== 'admin' && <TableActionButton disabled={disabled || !changed} onClick={() => { void save(user.id); }} ><Check className="h-3 w-3" />{busyUser === user.id ? '保存中…' : '保存'}</TableActionButton>}</td>
        </tr>;
      })}</DataTable>
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
    </section>
  );
}

export function ChangePassword() {
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
