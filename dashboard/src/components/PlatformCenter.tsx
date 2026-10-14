import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Activity, Bot, KeyRound, Settings, ShieldCheck, Users, X, FolderKey, Loader2 } from 'lucide-react';
import type { AuthUser } from '../lib/api';
import { hasPermission, usePermissions } from '../lib/permissions';
import { ChangePassword, ProjectAccessAdmin } from './AccountModal';
import { RoleManagementPanel } from './RoleManagementPanel';
import { UserManagementPanel } from './UserManagementPanel';

const SettingsPanel = lazy(() => import('./SettingsModal').then((module) => ({ default: module.SettingsModal })));
const AgentGuide = lazy(() => import('./AgentGuide').then((module) => ({ default: module.AgentGuideModal })));
const Monitor = lazy(() => import('./AdminMonitorPage').then((module) => ({ default: module.AdminMonitorPage })));

const sections = [
  { id: 'account', label: '我的账户', group: '个人', icon: KeyRound, permission: null },
  { id: 'users', label: '用户管理', group: '权限中心', icon: Users, permission: 'users' },
  { id: 'roles', label: '角色与权限', group: '权限中心', icon: ShieldCheck, permission: 'roles' },
  { id: 'projects', label: '项目授权', group: '权限中心', icon: FolderKey, permission: 'project_access' },
  { id: 'monitor', label: '用户监控', group: '平台', icon: Activity, permission: 'monitor' },
  { id: 'settings', label: '平台设置', group: '平台', icon: Settings, permission: 'settings' },
  { id: 'agent', label: 'Agent API', group: '集成', icon: Bot, permission: 'agent_api' },
] as const;
export type PlatformSection = typeof sections[number]['id'];

export function PlatformCenter({ currentUser, initialSection = 'account', onClose, onOpenSession }: {
  currentUser: AuthUser; initialSection?: PlatformSection; onClose: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
}) {
  const query = usePermissions();
  const [selected, setSelected] = useState<PlatformSection>(initialSection);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const allowed = sections.filter((section) => section.permission === null || hasPermission(query.data, section.permission));
  const current = allowed.find((section) => section.id === selected) ?? allowed[0];
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Nested confirmation dialogs handle their own keyboard interactions.
      if (dialogRef.current?.querySelector('.fixed.inset-0')) return;
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((control) => control.offsetParent !== null && !control.closest('fieldset:disabled'));
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-6" style={{ background: 'rgba(0,0,0,.58)' }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="platform-center-title" className="flex h-[92vh] w-full flex-col overflow-hidden rounded-xl border shadow-2xl" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
        <header className="flex shrink-0 items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5" style={{ color: 'var(--accent)' }} /><div><h2 id="platform-center-title" className="text-base font-semibold">平台管理</h2><p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>账户、授权、监控与配置</p></div></div><button ref={closeButtonRef} aria-label="关闭平台管理" onClick={onClose} className="rounded-md p-2 hover:opacity-70"><X className="h-5 w-5" /></button></header>
        {query.isPending ? <div className="flex flex-1 items-center justify-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在加载权限…</div> : query.error ? <div role="alert" className="p-6 text-sm">权限加载失败：{query.error.message}<button onClick={() => { void query.refetch(); }} className="ml-3 underline">重试</button></div> : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav aria-label="平台管理分类" className="flex shrink-0 gap-3 overflow-x-auto border-b p-3 sm:w-44 sm:flex-col sm:gap-4 sm:overflow-y-auto sm:border-r sm:border-b-0" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              {['个人', '权限中心', '平台', '集成'].map((group) => {
                const items = allowed.filter((section) => section.group === group);
                return items.length > 0 && <div key={group} className="shrink-0"><div className="mb-2 px-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{group}</div><div className="flex gap-1 sm:flex-col">{items.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-current={item.id === current.id ? 'page' : undefined} className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-left" style={{ color: item.id === current.id ? 'var(--accent)' : 'var(--text-secondary)', background: item.id === current.id ? 'var(--bg-secondary)' : 'transparent' }}><item.icon className="h-4 w-4 shrink-0" />{item.label}</button>)}</div></div>;
              })}
            </nav>
            <div className="min-h-0 min-w-0 flex-1 flex flex-col">
              <div className="shrink-0 border-b px-5 py-3 text-sm font-semibold" style={{ borderColor: 'var(--border)' }}>{current.label}</div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<div className="p-6 text-sm">正在加载…</div>}>
                  {current.id === 'account' && <div className="page-content py-4 sm:py-6"><p className="mb-5 text-sm">{currentUser.display_name || currentUser.username} <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>@{currentUser.username}</span></p><div className="mb-6 flex flex-wrap gap-2">{query.data?.roles.map((role) => <span key={role.id} className="rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--border)' }}>{role.name}</span>)}</div><ChangePassword /></div>}
                  {current.id === 'users' && query.data && <UserManagementPanel currentUser={currentUser} permissions={query.data} />}
                  {current.id === 'roles' && query.data && <RoleManagementPanel permissions={query.data} />}
                  {current.id === 'projects' && <div className="page-content h-full overflow-auto py-4 sm:py-6"><ProjectAccessAdmin readOnly={!hasPermission(query.data, 'project_access', 'write')} /></div>}
                  {current.id === 'settings' && <SettingsPanel embedded onClose={onClose} readOnly={!hasPermission(query.data, 'settings', 'write')} />}
                  {current.id === 'agent' && <AgentGuide embedded onClose={onClose} />}
                  {current.id === 'monitor' && <Monitor onBack={onClose} onOpenSession={onOpenSession} canWrite={hasPermission(query.data, 'monitor', 'write')} canDelete={hasPermission(query.data, 'monitor', 'delete')} canOpenSessions={currentUser.role === 'admin'} />}
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
