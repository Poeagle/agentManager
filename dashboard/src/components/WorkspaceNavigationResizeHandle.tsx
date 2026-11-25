import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 160;
const MAX_WIDTH = 420;

export function WorkspaceNavigationResizeHandle({ layout, storageKey }: {
  layout: RefObject<HTMLDivElement | null>;
  storageKey: string;
}) {
  const preferredWidth = useRef(DEFAULT_WIDTH);
  const gesture = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, maximum: MAX_WIDTH });

  const applyWidth = useCallback((candidate: number, save = false) => {
    const element = layout.current;
    if (!element) return;
    const maximum = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(element.clientWidth * .45)));
    const width = Math.round(Math.min(maximum, Math.max(MIN_WIDTH, candidate)));
    element.style.setProperty('--workspace-navigation-width', `${width}px`);
    setSize({ width, maximum });
    if (save) {
      preferredWidth.current = width;
      try { localStorage.setItem(storageKey, String(width)); } catch { /* Preference is optional. */ }
    }
  }, [layout, storageKey]);

  useEffect(() => {
    preferredWidth.current = DEFAULT_WIDTH;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) preferredWidth.current = saved;
    } catch { /* Preference is optional. */ }
    const resize = () => applyWidth(preferredWidth.current);
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [applyWidth, storageKey]);

  function cancelDrag() {
    if (!gesture.current) return;
    gesture.current = null;
    applyWidth(preferredWidth.current);
  }

  return <div
    className="workspace-navigation-resize"
    role="separator"
    tabIndex={0}
    aria-label="调整工作区导航宽度"
    aria-controls="workspace-navigation"
    aria-orientation="vertical"
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={size.maximum}
    aria-valuenow={size.width}
    title="拖动或按方向键调整宽度"
    onPointerDown={event => {
      if (event.button !== 0 || gesture.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      gesture.current = { pointer: event.pointerId, startX: event.clientX, startWidth: size.width };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={event => {
      const current = gesture.current;
      if (current?.pointer === event.pointerId) applyWidth(current.startWidth + event.clientX - current.startX);
    }}
    onPointerUp={event => {
      const current = gesture.current;
      if (current?.pointer !== event.pointerId) return;
      gesture.current = null;
      if (current.startX !== event.clientX) applyWidth(current.startWidth + event.clientX - current.startX, true);
    }}
    onPointerCancel={cancelDrag}
    onLostPointerCapture={cancelDrag}
    onDoubleClick={() => applyWidth(DEFAULT_WIDTH, true)}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        cancelDrag();
        return;
      }
      let next = size.width;
      switch (event.key) {
        case 'ArrowLeft': next -= 16; break;
        case 'ArrowRight': next += 16; break;
        case 'Home': next = MIN_WIDTH; break;
        case 'End': next = size.maximum; break;
        default: return;
      }
      event.preventDefault();
      applyWidth(next, true);
    }}
  />;
}
