import { TableActionButton } from './table/TableActions';
import { useTableModel } from './table/use-table-model';
import { DataTable, TableExpandButton, TableDetailRow } from './table/DataTable';
import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type MyPermissions, type PermissionDefinition, type PermissionGrants, type PermissionLevel, type PlatformRole } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { ConfirmModal } from './ConfirmModal';

const fieldStyle = { background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)' };
const levelLabels = { read: '查看', write: '修改', delete: '删除' };

export function RoleManagementPanel({ permissions }: { permissions: MyPermissions }) {
  const query = useQuery({ queryKey: ['rbac-roles'], queryFn: api.rbac.roles });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const roles = query.data?.roles ?? [];
  const rolesTable = useTableModel(roles, [
    { key: 'name', title: '角色名称', value: (role) => role.name },
    { key: 'description', title: '说明', value: (role) => role.description },
    { key: 'type', title: '类型', value: (role) => role.builtin ? '内置' : '自定义' },
    { key: 'members', title: '成员', value: (role) => role.member_count },
  ]);
  async function onSaved(id: string) { await query.refetch(); setSelected(id); setNotice('角色已保存'); }
  async function onDeleted() { await query.refetch(); setSelected(null); setNotice('角色已删除'); }
  return <div className="page-content h-full overflow-auto py-3">
    <div className="mb-3 flex items-center justify-between"><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>共 {roles.length} 个角色</span>{hasPermission(permissions, 'roles', 'write') && <TableActionButton  aria-label="新建角色" onClick={() => { setSelected('new'); setNotice(''); }}><Plus className="h-3.5 w-3.5" />新建角色</TableActionButton>}</div>
    {notice && <p role="status" className="mb-3 text-xs" style={{ color: 'var(--success)' }}>{notice}</p>}
    <DataTable label="角色列表" model={rolesTable} minWidth={480} expandable loading={query.isPending}
      error={query.error?.message} onRetry={() => { void query.refetch(); }}
      empty={rolesTable.rows.length === 0 && selected !== 'new'} emptyMessage="没有匹配的角色">
      {rolesTable.rows.map((role) => <Fragment key={role.id}><tr><td><TableExpandButton expanded={selected === role.id} label={`角色 ${role.name}`} onClick={() => { setSelected(selected === role.id ? null : role.id); setNotice(''); }} /></td><td className="font-medium">{role.name}</td><td>{role.description}</td><td>{role.builtin ? '内置' : '自定义'}</td><td>{role.member_count}</td></tr>
        {selected === role.id && <TableDetailRow columnCount={5}><RoleEditor role={role} catalog={query.data?.catalog ?? []} permissions={permissions} onSaved={onSaved} onDeleted={onDeleted} /></TableDetailRow>}
      </Fragment>)}
      {selected === 'new' && <TableDetailRow columnCount={5}><RoleEditor key="new" catalog={query.data?.catalog ?? []} permissions={permissions} onSaved={onSaved} onDeleted={onDeleted} /></TableDetailRow>}
    </DataTable>
  </div>;
}

function RoleEditor({ role, catalog, permissions, onSaved, onDeleted }: {
  role?: PlatformRole; catalog: PermissionDefinition[]; permissions: MyPermissions;
  onSaved: (id: string) => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [grants, setGrants] = useState<PermissionGrants>(role?.permissions ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !!role?.builtin || !hasPermission(permissions, 'roles', 'write');
  const grantsTable = useTableModel(catalog, [
    { key: 'feature', title: '平台功能', value: (item) => item.label },
    { key: 'grant', title: '授权级别', value: (item) => grants[item.key] ? levelLabels[grants[item.key]!] : '无权限' },
  ]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || readOnly) return;
    setBusy(true); setError('');
    try {
      const data = { name, description, permissions: grants };
      const result = role ? await api.rbac.updateRole(role.id, data) : await api.rbac.createRole(data);
      await onSaved(result.role.id);
      await client.invalidateQueries({ queryKey: ['rbac-me'] });
      await client.invalidateQueries({ queryKey: ['rbac-assignable-roles'] });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存角色失败'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!role || busy) return;
    setBusy(true); setError('');
    try { await api.rbac.deleteRole(role.id); await onDeleted(); await client.invalidateQueries({ queryKey: ['rbac-assignable-roles'] }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '删除角色失败'); }
    finally { setBusy(false); setConfirmDelete(false); }
  }
  return (
    <form onSubmit={(event) => { void save(event); }} className="compact-form w-full space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div><h3 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-5 w-5" style={{ color: 'var(--accent)' }} />{role ? role.name : '新建角色'}</h3><p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{role?.builtin ? '内置角色保持固定。需要不同权限时，新建自定义角色并分配给用户。' : '用户可拥有多个角色，权限取各角色的最高授权级别。'}</p></div>
        {role && !role.builtin && hasPermission(permissions, 'roles', 'delete') && <button type="button" disabled={busy || role.member_count > 0} title={role.member_count ? '请先解除成员分配' : '删除角色'} className="rounded p-2 disabled:opacity-40" style={{ color: 'var(--error)' }} onClick={() => setConfirmDelete(true)} aria-label="删除角色"><Trash2 className="h-4 w-4" /></button>}
      </div>
      <div className="space-y-3">
        <div className="field-grid">
        <label className="block text-xs">角色名称<input disabled={readOnly || busy} required maxLength={64} value={name} onChange={(event) => { setName(event.target.value); }} className="mt-2 block w-full rounded-md px-3 py-2 text-sm" style={fieldStyle} /></label>
        <label className="block text-xs">说明<input disabled={readOnly || busy} maxLength={500} value={description} onChange={(event) => { setDescription(event.target.value); }} className="mt-2 block w-full rounded-md px-3 py-2 text-sm" style={fieldStyle} /></label>
        </div>
        <DataTable label="角色授权" model={grantsTable} minWidth={320} empty={grantsTable.rows.length === 0} emptyMessage="暂无权限项">{grantsTable.rows.map((item) => <tr key={item.key}  ><td >{item.label}</td><td ><select disabled={readOnly || busy} aria-label={`${item.label}授权级别`} value={grants[item.key] ?? ''} onChange={(event) => { const next = { ...grants }; if (event.target.value) next[item.key] = event.target.value as PermissionLevel; else delete next[item.key]; setGrants(next); }} className="w-32 rounded-md px-2 py-1.5 text-xs" style={fieldStyle}><option value="">无权限</option>{item.levels.map((level) => <option key={level} value={level}>{levelLabels[level]}{level !== 'read' && item.levels.includes('read') ? '（含查看）' : ''}</option>)}</select></td></tr>)}</DataTable>
      </div>
      {!readOnly && <button disabled={busy || !name.trim()} className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>{busy ? '保存中…' : '保存角色'}</button>}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
      {confirmDelete && <ConfirmModal title="删除角色" message={`确定删除“${role?.name}”吗？`} confirmLabel="删除" cancelLabel="取消" variant="danger" onConfirm={() => { void remove(); }} onCancel={() => setConfirmDelete(false)} />}
    </form>
  );
}
