import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PlatformCenter } from '../src/components/PlatformCenter';
import type { AuthUser } from '../src/lib/api';

vi.mock('../src/lib/permissions', () => ({
  hasPermission: (_data:unknown,key:string) => ['users','roles','project_access'].includes(key),
  usePermissions: () => ({ data: { roles: [], permissions: { users:'read',roles:'read',project_access:'read' } }, isPending: false }),
}));
vi.mock('../src/components/PermissionCenter', () => ({PermissionCenter:()=> <div>Unified permissions</div>}));
vi.mock('../src/components/ApiKeys', () => ({ApiKeys:()=>null}));

it('provides one permission-management navigation entry', () => {
 render(<PlatformCenter currentUser={{username:'member',display_name:'Member'} as AuthUser} onClose={()=>{}} onOpenSession={()=>{}} onLogout={()=>{}} />);
 const nav=screen.getByRole('navigation',{name:'平台管理分类'});
 expect(nav).toHaveTextContent('权限管理');
 expect(nav).not.toHaveTextContent('角色与权限');
 expect(nav).not.toHaveTextContent('项目授权');
 fireEvent.click(screen.getByRole('button',{name:'权限管理'}));
 expect(screen.getByText('Unified permissions')).toBeVisible();
});
