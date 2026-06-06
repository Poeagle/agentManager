import { useState, useEffect, useCallback } from 'react';
import { api, type AuthUser } from '../lib/api';
import { X } from 'lucide-react';

const inputCls = 'px-2.5 py-1.5 rounded-md text-sm outline-none';
const inputStyle = { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' } as const;

export function AccountModal({ currentUser, onClose }: { currentUser: AuthUser; onClose: () => void }) {
  const isAdmin = currentUser.role === 'admin';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl p-5 flex flex-col gap-5"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>账户与用户</h2>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-secondary)' }}><X className="w-4 h-4" /></button>
        </div>

        <ChangePassword />
        {isAdmin && <UserAdmin currentUserId={currentUser.id} />}
      </div>
    </div>
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
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [err, setErr] = useState('');
  const [nu, setNu] = useState({ username: '', password: '', display_name: '', role: 'member' as 'admin' | 'member' });

  const refresh = useCallback(async () => {
    try { setUsers((await api.users.list()).users); } catch (e) { setErr(e instanceof Error ? e.message : ''); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); await refresh(); } catch (e) { setErr(e instanceof Error ? e.message : '失败'); }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => { await api.users.create(nu); setNu({ username: '', password: '', display_name: '', role: 'member' }); });
  };

  return (
    <div className="flex flex-col gap-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>用户管理</h3>

      <div className="flex flex-col gap-1.5">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-2 text-sm rounded-md px-2.5 py-1.5" style={{ background: 'var(--bg-tertiary)' }}>
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
            {u.id !== currentUserId && (
              <button
                onClick={() => act(() => api.users.update(u.id, { disabled: !u.disabled }))}
                className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: u.disabled ? 'var(--success)' : 'var(--error)' }}
              >{u.disabled ? '启用' : '禁用'}</button>
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
          <button type="submit" disabled={!nu.username || !nu.password} className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>创建</button>
        </div>
      </form>

      {err && <div className="text-xs" style={{ color: 'var(--error)' }}>{err}</div>}
    </div>
  );
}
