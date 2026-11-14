import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Activity, Bot, KeyRound, Settings, Users, X, FolderKey, Loader2, SlidersHorizontal } from 'lucide-react';
import type { AuthUser } from '../lib/api';
import { hasPermission, usePermissions } from '../lib/permissions';
import { ChangePassword } from './AccountModal';
import { PermissionCenter } from './PermissionCenter';
import { ApiKeys } from './ApiKeys';
import { Dialog } from './Dialog';
import './PlatformCenter.css';
import './ManagerUI.css';

const PlatformAi = lazy(() => import('./PlatformAiPanel').then((module) => ({ default: module.PlatformAiPanel })));

const SettingsPanel = lazy(() => import('./SettingsModal').then((module) => ({ default: module.SettingsModal })));
const AgentGuide = lazy(() => import('./AgentGuide').then((module) => ({ default: module.AgentGuideModal })));
const Monitor = lazy(() => import('./AdminMonitorPage').then((module) => ({ default: module.AdminMonitorPage })));
const SharedResources = lazy(() => import('./SharedResourcesPanel').then(module => ({ default: module.SharedResourcesPanel })));
const AgentManagement = lazy(() => import('./AgentManagementPanel').then(module => ({ default: module.AgentManagementPanel })));

const sections = [
  { id: 'account', label: '我的账户', group: '个人', icon: KeyRound, permission: null },
  { id: 'resources', label: '共享资源', group: '个人', icon: FolderKey, permission: null },
  { id: 'users', label: '权限管理', group: '权限中心', icon: Users, permission: 'users' },
  { id: 'monitor', label: '用户监控', group: '平台', icon: Activity, permission: 'monitor' },
  { id: 'assistant', label: '平台 AI', group: '平台', icon: Bot, permission: 'agent_api' },
  { id: 'agents', label: 'Agent 配置', group: '平台', icon: SlidersHorizontal, permission: 'settings' },
  { id: 'settings', label: '平台设置', group: '平台', icon: Settings, permission: 'settings' },
  { id: 'agent', label: 'Agent API', group: '集成', icon: Bot, permission: 'agent_api' },
] as const;
export type PlatformSection = typeof sections[number]['id'];

export function PlatformCenter({ currentUser, initialSection = 'account', onClose, onOpenSession, onLogout }: {
  currentUser: AuthUser; initialSection?: PlatformSection; onClose: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void; onLogout: () => void;
}) {
  const query = usePermissions();
  const [selected, setSelected] = useState<PlatformSection>(initialSection);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const allowed = sections.filter((section) => section.permission === null || (section.id==='users' ? ['users','roles','project_access'].some(key=>hasPermission(query.data,key)) : hasPermission(query.data, section.permission)));
  const current = allowed.find((section) => section.id === selected) ?? allowed[0];
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Nested confirmation dialogs handle their own keyboard interactions.
      if (dialogRef.current?.querySelector('.fixed.inset-0')) return;
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((control) => control.offsetParent !== null && !control.closest('fieldset:disabled'));
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [onClose]);
  return (
    <div className="manager-ui-host fixed inset-0 z-40 flex items-center justify-center p-3" style={{ background: 'rgba(0,0,0,.58)' }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="platform-center-title" className="manager-ui manager-platform flex h-[calc(100dvh-24px)] w-full max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded border" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
        <header className="manager-platform-header flex shrink-0 items-center justify-between border-b" style={{ borderColor: 'var(--border)' }}><h2 id="platform-center-title" className="text-base font-semibold">平台管理</h2><button ref={closeButtonRef} aria-label="关闭平台管理" onClick={onClose} className="rounded-md p-2 hover:opacity-70"><X className="h-5 w-5" /></button></header>
        {query.isPending ? <div className="flex flex-1 items-center justify-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在加载权限…</div> : query.error ? <div role="alert" className="p-6 text-sm">权限加载失败：{query.error.message}<button onClick={() => { void query.refetch(); }} className="ml-3 underline">重试</button></div> : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav aria-label="平台管理分类" className="manager-navigation flex shrink-0 overflow-x-auto border-b sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
              {['个人', '权限中心', '平台', '集成'].map((group) => {
                const items = allowed.filter((section) => section.group === group);
                return items.length > 0 && <div key={group} className="shrink-0"><div className="mb-2 px-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{group}</div><div className="flex gap-1 sm:flex-col">{items.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-current={item.id === current.id ? 'page' : undefined} className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-left" style={{ color: item.id === current.id ? 'var(--accent)' : 'var(--text-secondary)', background: item.id === current.id ? 'var(--bg-secondary)' : 'transparent' }}><item.icon className="h-4 w-4 shrink-0" />{item.label}</button>)}</div></div>;
              })}
            </nav>
            <div className="min-h-0 min-w-0 flex-1 flex flex-col">
              <div className="manager-section-heading shrink-0 border-b font-semibold" style={{ borderColor: 'var(--border)' }}>{current.label}</div>
              <div className="platform-center-scroll manager-content min-h-0 flex-1 overflow-y-auto">
                <Suspense fallback={<div className="p-6 text-sm">正在加载…</div>}>
                  {current.id === 'account' && <div className="page-content py-3">
                    <div className="account-overview mb-3">
                      <div className="account-identity text-sm"><span>{currentUser.display_name || currentUser.username} <span className="text-xs" style={{color:'var(--text-secondary)'}}>@{currentUser.username}</span></span>{query.data?.roles.map(role=><span key={role.id} className="rounded border px-2 py-1 text-xs" style={{borderColor:'var(--border)'}}>{role.name}</span>)}</div>
                      <div className="account-actions"><button type="button" onClick={()=>{setPasswordSaved(false);setPasswordOpen(true);}} className="rounded border px-3 py-1.5 text-xs" style={{borderColor:'var(--border)'}}>修改密码</button><button type="button" onClick={onLogout} className="rounded border px-3 py-1.5 text-xs" style={{borderColor:'var(--border)',color:'var(--text-primary)'}}>退出登录</button></div>
                    </div>
                    {passwordSaved&&<p role="status" className="mt-2 text-xs" style={{color:'var(--success)'}}>密码已修改</p>}
                    {query.data&&<ApiKeys permissions={query.data} />}
                    {passwordOpen&&<Dialog title="修改密码" appearance="manager" onClose={()=>setPasswordOpen(false)}><ChangePassword inDialog onSuccess={()=>{setPasswordOpen(false);setPasswordSaved(true);}}/></Dialog>}
                  </div>}
                  {current.id === 'resources' && <SharedResources userId={currentUser.id} />}
                  {current.id === 'users' && query.data && <PermissionCenter currentUser={currentUser} permissions={query.data} />}
                  {current.id === 'settings' && <SettingsPanel administrator={currentUser.role==='admin'} embedded onClose={onClose} readOnly={!hasPermission(query.data, 'settings', 'write')} />}
                  {current.id === 'agents' && <AgentManagement readOnly={!hasPermission(query.data, 'settings', 'write')} />}
                  {current.id === 'assistant' && query.data && <PlatformAi permissions={query.data} onOpenSession={onOpenSession} />}
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
