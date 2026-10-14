import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  data: Uint8Array;
}

export function PdfPreview({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<{ source: Uint8Array; document: PDFDocumentProxy } | null>(null);
  const [loadError, setLoadError] = useState<{ source: Uint8Array; message: string } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState<{ source: Uint8Array; key: string } | null>(null);
  const [renderError, setRenderError] = useState<{ source: Uint8Array; key: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // PDF.js transfers this buffer to its worker. Keep the source supplied by
    // the parent intact in case the component remounts.
    const task = getDocument({ data: data.slice() });
    task.promise.then(document => {
      if (cancelled) return;
      setLoaded({ source: data, document });
    }).catch(error => {
      if (!cancelled) setLoadError({ source: data, message: error instanceof Error ? error.message : 'PDF 加载失败' });
    });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      setWidth(entries[0]?.contentRect.width || container.clientWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const document = loaded?.source === data ? loaded.document : null;
  const safePage = document ? Math.min(pageNumber, document.numPages) : pageNumber;
  const renderKey = `${safePage}:${width}:${zoom}`;

  useEffect(() => {
    if (!document || !width) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    void document.getPage(safePage).then(page => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(0.25, Math.min(3, (width - 32) / base.width)) * zoom;
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建 PDF 画布');
      renderTask = page.render({
        canvasContext: context,
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      return renderTask.promise;
    }).then(() => {
      if (!cancelled) setRendered({ source: data, key: renderKey });
    }).catch(error => {
      if (!cancelled && error?.name !== 'RenderingCancelledException') {
        setRenderError({ source: data, key: renderKey, message: error instanceof Error ? error.message : 'PDF 页面渲染失败' });
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, data, safePage, width, zoom, renderKey]);

  return <div className="flex min-h-0 flex-1 flex-col bg-white text-slate-900" aria-label="PDF 预览">
    {document && <div className="flex shrink-0 items-center justify-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs">
      <button type="button" onClick={() => setPageNumber(page => Math.max(1, page - 1))} disabled={safePage <= 1} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="上一页">上一页</button>
      <span aria-label="页码">{safePage} / {document.numPages}</span>
      <button type="button" onClick={() => setPageNumber(page => Math.min(document.numPages, page + 1))} disabled={safePage >= document.numPages} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="下一页">下一页</button>
      <button type="button" onClick={() => setZoom(value => Math.max(0.5, Math.round((value - 0.25) * 100) / 100))} disabled={zoom <= 0.5} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="缩小 PDF">−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => setZoom(value => Math.min(2.5, Math.round((value + 0.25) * 100) / 100))} disabled={zoom >= 2.5} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="放大 PDF">+</button>
    </div>}
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto bg-slate-200 p-4 text-center">
      {!document && loadError?.source !== data && <div role="status" className="py-8 text-sm">正在解析 PDF…</div>}
      {loadError?.source === data && <div role="alert" className="py-8 text-sm text-red-700">PDF 加载失败：{loadError.message}</div>}
      {renderError?.source === data && renderError.key === renderKey && <div role="alert" className="py-8 text-sm text-red-700">PDF 页面渲染失败：{renderError.message}</div>}
      {document && <canvas ref={canvasRef} aria-label={`PDF 第 ${safePage} 页`} data-rendered={rendered?.source === data && rendered.key === renderKey} className="mx-auto bg-white shadow" />}
    </div>
  </div>;
}
