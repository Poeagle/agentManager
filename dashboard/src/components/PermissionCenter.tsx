import {useState} from 'react';
import type {AuthUser,MyPermissions} from '../lib/api';
import {hasPermission} from '../lib/permissions';
import {UserManagementPanel} from './UserManagementPanel';
import {RoleManagementPanel} from './RoleManagementPanel';

/** One entry point for user grants and role definitions. */
export function PermissionCenter({currentUser,permissions}:{currentUser:AuthUser;permissions:MyPermissions}) {
 const canUsers=hasPermission(permissions,'users'),canRoles=hasPermission(permissions,'roles'),canProjects=hasPermission(permissions,'project_access');
 const [selected,setSelected]=useState<'users'|'roles'|'projects'>(canUsers?'users':canRoles?'roles':'projects');
 return <div className="flex h-full min-h-0 flex-col">
  <div className="flex flex-wrap gap-1 border-b px-3 pt-2" style={{borderColor:'var(--border)'}} aria-label="权限管理分类">
   {canUsers&&<button type="button" aria-pressed={selected==='users'} onClick={()=>setSelected('users')} className="px-3 py-2 text-xs" style={{color:selected==='users'?'var(--accent)':'var(--text-secondary)'}}>用户权限</button>}
   {canRoles&&<button type="button" aria-pressed={selected==='roles'} onClick={()=>setSelected('roles')} className="px-3 py-2 text-xs" style={{color:selected==='roles'?'var(--accent)':'var(--text-secondary)'}}>角色定义</button>}
   {!canUsers&&canProjects&&<button type="button" aria-pressed={selected==='projects'} onClick={()=>setSelected('projects')} className="px-3 py-2 text-xs" style={{color:selected==='projects'?'var(--accent)':'var(--text-secondary)'}}>项目授权</button>}
  </div>
  <div className="min-h-0 flex-1 overflow-auto">
   {selected==='users'&&canUsers&&<UserManagementPanel currentUser={currentUser} permissions={permissions}/>}
   {selected==='roles'&&canRoles&&<RoleManagementPanel permissions={permissions}/>}
   {selected==='projects'&&!canUsers&&canProjects&&<p className="page-content py-3 text-sm">查看用户项目授权还需要用户管理的查看权限。</p>}
  </div>
 </div>;
}
