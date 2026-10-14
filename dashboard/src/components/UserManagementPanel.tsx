import { TableActionButton } from './table/TableActions';
import { useTableModel } from './table/use-table-model';
import { DataTable, TableExpandButton, TableDetailRow } from './table/DataTable';
import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { api, type AuthUser, type MyPermissions } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { ConfirmModal } from './ConfirmModal';

const fieldStyle = { background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)' };

export function UserManagementPanel({ currentUser, permissions }: { currentUser: AuthUser; permissions: MyPermissions }) {
  const query = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const rolesQuery = useQuery({ queryKey: ['rbac-assignable-roles'], queryFn: api.rbac.assignableRoles });
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const users = query.data?.users ?? [];
  const roles = rolesQuery.data?.roles ?? [];
  const usersTable = useTableModel(users.filter((user) => `${user.username} ${user.display_name}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [
    { key: 'username', title: '用户名', value: (user) => user.username },
    { key: 'display', title: '显示名称', value: (user) => user.display_name || user.username },
    { key: 'roles', title: '角色', value: (user) => (user.role_ids ?? [user.role]).map((id) => roles.find((role) => role.id === id)?.name ?? id).join('、') || '无角色' },
    { key: 'status', title: '状态', value: (user) => user.disabled ? '已禁用' : '正常' },
    { key: 'quota', title: '会话额度', value: (user) => user.role === 'admin' ? '不限' : user.max_tabs ?? 10 },
  ]);
  const error = query.error ?? rolesQuery.error;
  async function onSaved(id: string | null) { await query.refetch(); setSelected(id); setNotice(id ? '用户信息已保存' : '用户已删除'); }
  return <div className="page-content h-full overflow-auto py-3">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><label className="flex items-center gap-2 rounded px-2 py-1.5" style={fieldStyle}><Search className="h-3.5 w-3.5" /><input aria-label="搜索用户" placeholder="搜索用户" value={search} onChange={(event) => setSearch(event.target.value)} className="bg-transparent text-xs outline-none" /></label>{hasPermission(permissions, 'users', 'write') && <TableActionButton  aria-label="新建用户" onClick={() => { setSelected('new'); setNotice(''); }}><Plus className="h-3.5 w-3.5" />新建用户</TableActionButton>}</div>
    {notice && <p role="status" className="mb-3 text-xs" style={{ color: 'var(--success)' }}>{notice}</p>}
    <DataTable label="用户列表" model={usersTable} minWidth={640} expandable loading={query.isPending || rolesQuery.isPending}
      error={error?.message} onRetry={() => { void query.refetch(); void rolesQuery.refetch(); }}
      empty={usersTable.rows.length === 0 && selected !== 'new'} emptyMessage="没有匹配的用户">
      {usersTable.rows.map((user) => <Fragment key={user.id}><tr><td><TableExpandButton expanded={selected === user.id} label={`用户 ${user.username}`} onClick={() => { setSelected(selected === user.id ? null : user.id); setNotice(''); }} /></td><td>{user.username}</td><td>{user.display_name || user.username}</td><td>{(user.role_ids ?? [user.role]).map((id) => roles.find((role) => role.id === id)?.name ?? id).join('、') || '无角色'}</td><td>{user.disabled ? '已禁用' : '正常'}</td><td>{user.role === 'admin' ? '不限' : user.max_tabs ?? 10}</td></tr>
        {selected === user.id && <TableDetailRow columnCount={6}><UserDetails key={`${user.id}:${user.disabled}:${user.max_tabs}:${user.role_ids?.join(',')}`} user={user} currentUser={currentUser} permissions={permissions} roles={roles} onSaved={onSaved} /></TableDetailRow>}
      </Fragment>)}
      {selected === 'new' && <TableDetailRow columnCount={6}><UserDetails key="new" currentUser={currentUser} permissions={permissions} roles={roles} onSaved={onSaved} /></TableDetailRow>}
    </DataTable>
  </div>;
}

function UserDetails({ user, currentUser, permissions, roles, onSaved }: {
  user?: AuthUser; currentUser: AuthUser; permissions: MyPermissions;
  roles: Array<{ id: string; name: string }>;
  onSaved: (id: string | null) => Promise<void>;
}) {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [maxTabs, setMaxTabs] = useState(user?.max_tabs ?? 10);
  const [roleIds, setRoleIds] = useState(user?.role_ids ?? [user?.role ?? 'member']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState('');
  const canRoles = hasPermission(permissions, 'roles', 'write');
  const protectedUser = !!user && (user.role === 'admin' || user.role_ids?.some((id) => id !== 'member'));
  const canWrite = hasPermission(permissions, 'users', 'write') && (!protectedUser || canRoles);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await client.invalidateQueries({ queryKey: ['rbac-me'] }); await client.invalidateQueries({ queryKey: ['rbac-roles'] }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败'); }
    finally { setBusy(false); }
  }
  const rolesTable = useTableModel(roles, [
    { key: 'selected', title: '选择', value: (role) => roleIds.includes(role.id) },
    { key: 'role', title: '角色', value: (role) => role.name },
  ]);
  if (!user) return (
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = await api.users.create({ username, display_name: displayName, password, max_tabs: maxTabs }); await onSaved(result.user.id); }); }} className="w-full space-y-4">
      <h3 className="text-base font-semibold">新建用户</h3>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>新用户默认是普通成员，创建后可以分配角色和项目访问权限。</p>
      <fieldset disabled={busy || !canWrite} className="space-y-4">
        <label className="block text-xs">用户名<input required maxLength={64} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 block w-full rounded-md px-3 py-2 text-sm" style={fieldStyle} /></label>
        <label className="block text-xs">显示名称<input maxLength={64} value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 block w-full rounded-md px-3 py-2 text-sm" style={fieldStyle} /></label>
        <label className="block text-xs">初始密码<input required type="password" minLength={6} maxLength={256} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 block w-full rounded-md px-3 py-2 text-sm" style={fieldStyle} /></label>
        <button className="rounded-md px-4 py-2 text-sm" style={{ background: 'var(--accent)', color: 'white' }}>创建用户</button>
      </fieldset>
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
    </form>
  );
  return (
    <div className="w-full space-y-3">
      <div className="flex items-start justify-between gap-4"><div><h3 className="text-base font-semibold">{user.display_name || user.username}</h3><p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>@{user.username} · {user.disabled ? '已禁用' : '正常'}{user.id === currentUser.id ? ' · 当前账户' : ''}</p></div>{user.id !== currentUser.id && canWrite && <button disabled={busy} onClick={() => { void run(async () => { await api.users.update(user.id, { disabled: !user.disabled }); await onSaved(user.id); }); }} className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border)', color: user.disabled ? 'var(--success)' : 'var(--error)' }}>{user.disabled ? '启用账户' : '禁用账户'}</button>}</div>
      <section className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <h4 className="text-sm font-semibold">分配角色</h4>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>平台功能权限来自角色。项目目录和工具使用范围在“项目授权”中配置。</p>
        <DataTable label="用户角色分配" model={rolesTable} minWidth={320} columnWidths={['w-28', '']} empty={rolesTable.rows.length === 0} emptyMessage="暂无可分配角色">{rolesTable.rows.map((role) => <tr key={role.id}><td><input disabled={!canRoles || busy} type="checkbox" aria-label={role.name} checked={roleIds.includes(role.id)} onChange={(event) => setRoleIds(event.target.checked ? [...roleIds, role.id] : roleIds.filter((id) => id !== role.id))} /></td><td>{role.name}</td></tr>)}</DataTable>
        {canRoles && <button disabled={busy} onClick={() => { void run(async () => { await api.rbac.assignRoles(user.id, roleIds); await onSaved(user.id); }); }} className="rounded-md px-3 py-2 text-xs disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>保存角色分配</button>}
      </section>
      <section className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}><h4 className="text-sm font-semibold">会话额度</h4><form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.users.update(user.id, { max_tabs: maxTabs }); await onSaved(user.id); }); }} className="flex items-center gap-3"><label className="flex items-center gap-2 text-xs">最多活动标签页<input aria-label="最多活动标签页" type="number" min={0} max={100} disabled={!canWrite || busy || user.role === 'admin'} value={maxTabs} onChange={(event) => setMaxTabs(Number(event.target.value))} className="w-20 rounded px-2 py-1.5" style={fieldStyle} /></label>{canWrite && user.role !== 'admin' && <button disabled={busy} className="text-xs underline">保存额度</button>}</form><p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{user.role === 'admin' ? '管理员不受标签页额度限制。' : '0 表示禁止创建会话。'}</p></section>
      {canWrite && <section className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}><h4 className="text-sm font-semibold">重置密码</h4><form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.users.update(user.id, { password }); setPassword(''); setNotice('密码已重置，现有登录和活动会话已关闭'); }); }} className="flex flex-wrap gap-3"><input aria-label="新密码" type="password" minLength={6} maxLength={256} required autoComplete="new-password" placeholder="新密码（至少 6 位）" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm" style={fieldStyle} /><button disabled={busy} className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)' }}>重置密码</button></form></section>}
      {user.id !== currentUser.id && hasPermission(permissions, 'users', 'delete') && (!protectedUser || canRoles) && <button disabled={busy} onClick={() => setConfirmDelete(true)} className="text-xs underline" style={{ color: 'var(--error)' }}>删除账户</button>}
      {notice && <p role="status" className="text-xs" style={{ color: 'var(--success)' }}>{notice}</p>}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
      {confirmDelete && <ConfirmModal title="删除用户" message={`确定删除“${user.display_name || user.username}”吗？该用户的活动会话会关闭，历史记录会保留。`} confirmLabel="删除" cancelLabel="取消" variant="danger" onCancel={() => setConfirmDelete(false)} onConfirm={() => { setConfirmDelete(false); void run(async () => { await api.users.delete(user.id); await onSaved(null); }); }} />}
    </div>
  );
}
