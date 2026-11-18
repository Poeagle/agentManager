import {useEffect, useRef, useState, type RefObject} from 'react';

const DEFAULT_WIDTH = 290;
const MIN_WIDTH = 220;
const STACKED_WIDTH = 760;

export function ConversationBatchResizeHandle({layout, active, storageKey}: {
  layout: RefObject<HTMLDivElement | null>; active: boolean; storageKey: string;
}) {
  const [size, setSize] = useState({width: DEFAULT_WIDTH, maximum: DEFAULT_WIDTH});
  const preference = useRef<number | null>(null);
  const gesture = useRef<{origin: number; base: number; pointer: number; element: HTMLElement} | null>(null);
  const publish = useRef<(value: number | null) => number>(() => DEFAULT_WIDTH);
  const commit = useRef<(value: number | null) => void>(() => {});
  const cancel = useRef(() => {});

  useEffect(() => {
    const element = layout.current;
    if (!element) return;
    try {
      const stored = localStorage.getItem(storageKey), parsed = Number(stored);
      preference.current = stored !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch { preference.current = null; }
    publish.current = value => {
      const maximum = Math.max(MIN_WIDTH, Math.min(element.clientWidth * .6, element.clientWidth - 360));
      const width = Math.max(MIN_WIDTH, Math.min(maximum, value ?? DEFAULT_WIDTH));
      element.style.setProperty('--chat-batch-width', `${width}px`);
      setSize({width, maximum});
      return width;
    };
    commit.current = value => {
      const width = publish.current(value);
      preference.current = value === null ? null : width;
      try {
        if (preference.current === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(preference.current));
      } catch { /* Width preferences are optional. */ }
    };
    cancel.current = () => {
      const current = gesture.current;
      gesture.current = null;
      if (current?.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer);
      delete element.dataset.batchResize;
      publish.current(preference.current);
    };
    const resize = () => cancel.current();
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', resize);
      cancel.current();
      element.style.removeProperty('--chat-batch-width');
    };
  }, [layout, storageKey]);
  useEffect(() => { if (!active) cancel.current(); }, [active]);

  return <div className="session-batch-resize-handle" role="separator" tabIndex={0}
    aria-label="调整批量待发区宽度" aria-orientation="vertical"
    aria-valuemin={MIN_WIDTH} aria-valuemax={Math.round(size.maximum)} aria-valuenow={Math.round(size.width)}
    title="左右拖动调整宽度；双击恢复默认；方向键微调"
    onPointerDown={event => {
      const element = layout.current;
      if (!active || event.button !== 0 || gesture.current || !element || element.clientWidth <= STACKED_WIDTH) return;
      event.preventDefault();
      event.currentTarget.focus();
      gesture.current = {origin: event.clientX, base: size.width, pointer: event.pointerId, element: event.currentTarget};
      event.currentTarget.setPointerCapture?.(event.pointerId);
      element.setAttribute('data-batch-resize', 'true');
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (current?.pointer === event.pointerId) publish.current(current.base + current.origin - event.clientX);
    }}
    onPointerUp={event => {
      const current = gesture.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (current.origin !== event.clientX) commit.current(current.base + current.origin - event.clientX);
      cancel.current();
    }}
    onPointerCancel={() => cancel.current()}
    onLostPointerCapture={() => { if (gesture.current) cancel.current(); }}
    onDoubleClick={() => commit.current(null)}
    onKeyDown={event => {
      if (!active) return;
      let next: number | null;
      if (event.key === 'ArrowLeft') next = size.width + 32;
      else if (event.key === 'ArrowRight') next = size.width - 32;
      else if (event.key === 'Home') next = MIN_WIDTH;
      else if (event.key === 'End') next = size.maximum;
      else if (event.key === 'Enter') next = null;
      else if (event.key === 'Escape') { cancel.current(); return; }
      else return;
      event.preventDefault();
      commit.current(next);
    }}
  />;
}
