import { fireEvent, render, screen } from '@testing-library/react';
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
