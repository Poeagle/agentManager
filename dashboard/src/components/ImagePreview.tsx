import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { TableActionButton } from './table/TableActions';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

export function ImagePreview({ url, name, onDownload, onError }: {
  url: string; name: string; onDownload: () => void; onError: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const anchor = useRef<{ x: number; y: number; viewportX: number; viewportY: number } | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  // null follows the viewport size; a number is a user-selected zoom level.
  const [zoom, setZoom] = useState<number | null>(null);
  const fit = dimensions && available.width && available.height
    ? Math.min(1, Math.max(1, available.width - 32) / dimensions.width, Math.max(1, available.height - 32) / dimensions.height) : 1;
  const scale = zoom ?? fit;

  useEffect(() => {
    const element = viewport.current!;
    const measure = () => setAvailable({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const changeZoom = useCallback((next: number, point?: { x: number; y: number }) => {
    if (!dimensions || !viewport.current || !img.current) return;
    const pane = viewport.current.getBoundingClientRect();
    const image = img.current.getBoundingClientRect();
    const x = point?.x ?? pane.left + viewport.current.clientWidth / 2;
    const y = point?.y ?? pane.top + viewport.current.clientHeight / 2;
    anchor.current = { x: (x - image.left) / scale, y: (y - image.top) / scale, viewportX: x - pane.left, viewportY: y - pane.top };
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, [dimensions, scale]);

  useLayoutEffect(() => {
    const point = anchor.current, element = viewport.current;
    if (!point || !element || !img.current) return;
    const pane = element.getBoundingClientRect(), image = img.current.getBoundingClientRect();
    element.scrollLeft += image.left - pane.left + point.x * scale - point.viewportX;
    element.scrollTop += image.top - pane.top + point.y * scale - point.viewportY;
    anchor.current = null;
  }, [scale]);

  useEffect(() => {
    const element = viewport.current!;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
      event.preventDefault();
      changeZoom(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [changeZoom, scale]);

  function fitToWindow() {
    anchor.current = null;
    setZoom(null);
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
      <span className="mr-1">图片预览</span>
      <div role="group" aria-label="图片缩放" className="flex items-center gap-1">
        <TableActionButton aria-label="缩小图片" title="缩小" disabled={!dimensions || scale <= MIN_ZOOM} onClick={() => changeZoom(scale / 1.2)}><ZoomOut className="h-3.5 w-3.5" /></TableActionButton>
        <output aria-label="图片缩放比例" className="w-12 text-center tabular-nums">{dimensions ? `${Math.round(scale * 100)}%` : '…'}</output>
        <TableActionButton aria-label="放大图片" title="放大" disabled={!dimensions || scale >= MAX_ZOOM} onClick={() => changeZoom(scale * 1.2)}><ZoomIn className="h-3.5 w-3.5" /></TableActionButton>
        <TableActionButton disabled={!dimensions} onClick={() => changeZoom(1)}>100%</TableActionButton>
        <TableActionButton disabled={!dimensions} onClick={fitToWindow} title="适应窗口"><Maximize className="h-3.5 w-3.5" />适应窗口</TableActionButton>
      </div>
      <button type="button" className="ml-auto shrink-0 hover:underline" style={{ color: 'var(--accent)' }} onClick={onDownload}>下载原文件</button>
    </div>
    <div ref={viewport} role="region" aria-label="图片预览画布" tabIndex={0} className="min-h-0 flex-1 overflow-auto" style={{ background: 'var(--bg-secondary)' }}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(scale * 1.2); }
        if (event.key === '-') { event.preventDefault(); changeZoom(scale / 1.2); }
        if (event.key === '0') { event.preventDefault(); fitToWindow(); }
      }}>
      <div className="flex items-center justify-center" style={{ width: Math.max(available.width, (dimensions?.width ?? 0) * scale + 32), height: Math.max(available.height, (dimensions?.height ?? 0) * scale + 32) }}>
        <img ref={img} src={url} alt={name} draggable={false} className="block shrink-0" style={{ width: dimensions ? dimensions.width * scale : undefined, height: dimensions ? dimensions.height * scale : undefined, maxWidth: 'none', maxHeight: 'none' }}
          onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onDoubleClick={() => zoom === null ? changeZoom(1) : fitToWindow()} onError={onError} title="Ctrl / ⌘ + 滚轮缩放；双击切换原始尺寸与适应窗口" />
      </div>
    </div>
  </div>;
}
