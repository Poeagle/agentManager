import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PlatformCenter } from '../src/components/PlatformCenter';
import type { AuthUser } from '../src/lib/api';

vi.mock('../src/lib/permissions', () => ({
  hasPermission: () => false,
  usePermissions: () => ({ data: { roles: [] }, isPending: false }),
}));
vi.mock('../src/components/ApiKeys', () => ({ ApiKeys: () => null }));

it('offers sign out inside the account page', () => {
  const logout = vi.fn();
  render(<PlatformCenter currentUser={{ username: 'member', display_name: 'Member' } as AuthUser} onClose={() => {}} onOpenSession={() => {}} onLogout={logout} />);
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  expect(logout).toHaveBeenCalledOnce();
});

it('opens password editing in a centered dialog', () => {
  render(<PlatformCenter currentUser={{ username: 'member', display_name: 'Member' } as AuthUser} onClose={() => {}} onOpenSession={() => {}} onLogout={() => {}} />);
  expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: '修改密码'}));
  const dialog=screen.getByRole('dialog',{name:'修改密码'});
  expect(within(dialog).getByLabelText('当前密码')).toBeVisible();
  expect(within(dialog).getByLabelText('新密码')).toBeVisible();
});
