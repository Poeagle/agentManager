import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Shared centered frame for workspace forms. */
export function Dialog({ title, children, onClose, busy = false, size = 'md', initialFocus }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; size?: 'md' | 'lg' | 'image';initialFocus?:RefObject<HTMLElement|null>;
}) {
  const titleId = useId();
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = frame.current;
    const first = initialFocus?.current ?? node?.querySelector<HTMLElement>('input:checked')
      ?? node?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      ?? node;
    first?.focus();
    return () => { if (previous?.isConnected) previous.focus({preventScroll:true}); };
  }, [initialFocus]);
  useEffect(() => {
    if (busy && !frame.current?.contains(document.activeElement)) frame.current?.focus();
  }, [busy]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const node = frame.current;
      if (!node || !node.contains(event.target as Node)) return;
      if((event.ctrlKey||event.metaKey)&&['w','s'].includes(event.key.toLowerCase())) {event.preventDefault();event.stopPropagation();if(event.key.toLowerCase()==='w'&&!busy)onClose();return;}
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!busy) onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
        .filter((control) => !control.closest('[hidden]') && getComputedStyle(control).display !== 'none');
      if (!controls.length) { event.preventDefault(); node.focus(); }
      else if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === node)) {
        event.preventDefault(); controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault(); controls[0].focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [busy, onClose]);
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgb(0 0 0 / 45%)' }}
    onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={frame} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className={`flex w-full min-h-0 flex-col overflow-hidden rounded-lg border ${size === 'image' ? '' : size === 'lg' ? 'max-w-4xl' : 'max-w-md'}`}
      style={{ maxHeight: 'calc(100dvh - 32px)', maxWidth: size==='image'?'min(92vw,1600px)':undefined, background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 pb-3">
        <h3 id={titleId} className="text-base font-semibold">{title}</h3>
        <button type="button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose} className="shrink-0 disabled:opacity-40"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
    </div>
  </div>, document.body);
}
