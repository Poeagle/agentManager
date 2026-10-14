import { TableActionButton } from './TableActions';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export function RowActionsMenu({ label, actions }: { label: string; actions: Array<{ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean }> }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
      if (event.type === 'mousedown' && event.target instanceof Node && (menu.current?.contains(event.target) || button.current?.contains(event.target))) return;
      if (event.type === 'keydown') { event.preventDefault(); event.stopPropagation(); button.current?.focus(); }
      setPosition(null);
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close); window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', close); };
  }, [position]);
  if (!actions.length) return null;
  return <><TableActionButton ref={button} type="button"  aria-label={label} aria-expanded={!!position} aria-haspopup="menu" onClick={() => {
    if (position) { setPosition(null); return; }
    const rect = button.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.right - 160, window.innerWidth - 168)), top: Math.min(rect.bottom + 4, window.innerHeight - actions.length * 34 - 16) });
  }}>更多<ChevronDown className="h-3 w-3" /></TableActionButton>
    {position && createPortal(<div ref={menu} role="menu" aria-label={label} className="fixed z-[80] min-w-40 rounded-md border p-1 shadow-lg"
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = items.findIndex((item) => item === document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
      style={{ ...position, background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
      {actions.map((action) => <button key={action.label} type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-[var(--bg-tertiary)]"
        style={{ color: action.danger ? 'var(--error)' : 'var(--text-primary)' }} onClick={() => { setPosition(null); action.onClick(); }}>{action.icon}{action.label}</button>)}
    </div>, document.body)}
  </>;
}
