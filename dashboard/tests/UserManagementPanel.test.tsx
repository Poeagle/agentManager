import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserManagementPanel } from '../src/components/UserManagementPanel';
import { api, type AuthUser, type MyPermissions } from '../src/lib/api';

vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: {
    ...actual.api,
    users: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    rbac: { ...actual.api.rbac, assignableRoles: vi.fn(), assignRoles: vi.fn() },
  } };
});

const admin: AuthUser = { id: 'admin', username: 'ymchen', display_name: 'ymchen', role: 'admin', role_ids: ['admin'] };
const fullPermissions: MyPermissions = { permissions: { users: 'delete', roles: 'write' }, roles: [], catalog: [] };
let users: AuthUser[];

beforeEach(() => {
  vi.clearAllMocks();
  users = [
    { ...admin },
    { id: 'member', username: 'member', display_name: '普通成员', role: 'member', role_ids: ['member'], disabled: 0, max_tabs: 10 },
    { id: 'disabled', username: 'disabled', display_name: '已禁用成员', role: 'member', role_ids: ['member'], disabled: 1, max_tabs: 10 },
    { id: 'creator', username: 'creator', display_name: '项目创建者', role: 'member', role_ids: ['member', 'project-creator'], disabled: 0 },
  ];
  vi.mocked(api.users.list).mockImplementation(async () => ({ users: users.map(user => ({ ...user })) }));
  vi.mocked(api.rbac.assignableRoles).mockResolvedValue({ roles: [
    { id: 'admin', name: '平台管理员', builtin: true },
    { id: 'member', name: '普通成员', builtin: true },
    { id: 'project-creator', name: '项目创建者', builtin: true },
  ] });
  vi.mocked(api.users.update).mockImplementation(async (id, data) => {
    users = users.map(user => user.id === id ? {
      ...user,
      ...(data.disabled !== undefined ? { disabled: Number(data.disabled) } : {}),
      ...(data.max_tabs !== undefined ? { max_tabs: data.max_tabs } : {}),
    } : user);
    return { user: users.find(user => user.id === id)! };
  });
  vi.mocked(api.users.delete).mockImplementation(async id => {
    users = users.filter(user => user.id !== id);
    return { ok: true, closed_sessions: 0 };
  });
  vi.mocked(api.rbac.assignRoles).mockResolvedValue({ ok: true });
});

async function show(permissions = fullPermissions) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><UserManagementPanel currentUser={admin} permissions={permissions} /></QueryClientProvider>);
  await screen.findByRole('button', { name: '展开用户 member', exact: true });
  return userEvent.setup();
}

function row(username: string) {
  return within(screen.getByRole('cell', { name: username, exact: true }).closest('tr')!);
}

it('adds compact row actions and never exposes self-disable or self-delete', async () => {
  await show();
  expect(screen.getByRole('columnheader', { name: '操作', exact: true })).toBeVisible();
  expect(row('member').getAllByRole('cell')).toHaveLength(7);
  for (const name of ['编辑', '重置密码', '禁用', '删除']) expect(row('member').getByRole('button', { name, exact: true })).toBeVisible();
  expect(row('disabled').getByRole('button', { name: '启用', exact: true })).toBeVisible();
  const self = within(screen.getAllByRole('cell', { name: 'ymchen', exact: true })[0].closest('tr')!);
  expect(self.queryByRole('button', { name: '禁用' })).not.toBeInTheDocument();
  expect(self.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
});

it('opens existing role and quota editing with details spanning all seven columns', async () => {
  const user = await show();
  await user.click(row('member').getByRole('button', { name: '编辑', exact: true }));
  const quota = screen.getByRole('spinbutton', { name: '最多活动标签页' });
  expect(quota.closest('td')).toHaveAttribute('colspan', '7');
  await user.clear(quota);
  await user.type(quota, '20');
  await user.click(screen.getByRole('button', { name: '保存额度' }));
  await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('member', { max_tabs: 20 }));
  await screen.findByRole('status');
  await user.click(screen.getByRole('checkbox', { name: '项目创建者' }));
  await user.click(screen.getByRole('button', { name: '保存角色分配' }));
  await waitFor(() => expect(api.rbac.assignRoles).toHaveBeenCalledWith('member', ['member', 'project-creator']));
});

it('opens and focuses password reset without changing it until explicitly submitted', async () => {
  const user = await show();
  await user.click(row('member').getByRole('button', { name: '重置密码' }));
  const password = screen.getByLabelText('新密码');
  expect(password).toHaveFocus();
  expect(api.users.update).not.toHaveBeenCalled();
  await user.click(screen.getByRole('spinbutton', { name: '最多活动标签页' }));
  await user.click(row('member').getByRole('button', { name: '重置密码' }));
  expect(password).toHaveFocus();
  await user.type(password, 'a-test-password');
  await user.click(within(password.closest('form')!).getByRole('button', { name: '重置密码' }));
  await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('member', { password: 'a-test-password' }));
  expect(await screen.findByText('密码已重置，现有登录和活动会话已关闭')).toBeVisible();
});

it('toggles accounts directly in the row and refreshes the status without opening details', async () => {
  const user = await show();
  await user.click(row('member').getByRole('button', { name: '禁用' }));
  await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('member', { disabled: true }));
  await waitFor(() => expect(row('member').getByRole('button', { name: '启用' })).toBeEnabled());
  expect(row('member').getByRole('cell', { name: '已禁用', exact: true })).toBeVisible();
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  await user.click(row('member').getByRole('button', { name: '启用' }));
  await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('member', { disabled: false }));
  await waitFor(() => expect(row('member').getByRole('cell', { name: '正常', exact: true })).toBeVisible());
});

it('requires deletion confirmation, supports cancellation and refreshes after deletion', async () => {
  const user = await show();
  await user.click(row('member').getByRole('button', { name: '删除' }));
  expect(screen.getByRole('heading', { name: '删除用户' })).toBeVisible();
  expect(api.users.delete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '取消', exact: true }));
  expect(api.users.delete).not.toHaveBeenCalled();
  await user.click(row('member').getByRole('button', { name: '删除' }));
  await user.click(screen.getAllByRole('button', { name: '删除', exact: true }).at(-1)!);
  await waitFor(() => expect(api.users.delete).toHaveBeenCalledWith('member'));
  await waitFor(() => expect(screen.queryByRole('cell', { name: 'member', exact: true })).not.toBeInTheDocument());
  expect(await screen.findByText('用户已删除')).toBeVisible();
});

it('only shows viewing for read-only users', async () => {
  await show({ permissions: { users: 'read' }, roles: [], catalog: [] });
  expect(row('member').getByRole('button', { name: '查看' })).toBeVisible();
  for (const name of ['编辑', '重置密码', '启用', '禁用', '删除']) expect(row('member').queryByRole('button', { name, exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '新建用户' })).not.toBeInTheDocument();
});

it('preserves role-management protection for administrators and users with additional roles', async () => {
  await show({ permissions: { users: 'delete' }, roles: [], catalog: [] });
  expect(row('member').getByRole('button', { name: '删除' })).toBeVisible();
  expect(row('creator').getByRole('button', { name: '查看' })).toBeVisible();
  for (const name of ['编辑', '重置密码', '禁用', '删除']) expect(row('creator').queryByRole('button', { name, exact: true })).not.toBeInTheDocument();
});

it('reports mutation failures and leaves the account unchanged', async () => {
  const user = await show();
  vi.mocked(api.users.update).mockRejectedValueOnce(new Error('无权修改此用户'));
  await user.click(row('member').getByRole('button', { name: '禁用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无权修改此用户');
  expect(row('member').getByRole('cell', { name: '正常', exact: true })).toBeVisible();
  expect(row('member').getByRole('button', { name: '禁用' })).toBeEnabled();
});
