import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {pdfLayout,type PdfPageSize} from '../lib/pdf-layout';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  data: Uint8Array;
}

function PdfPage({ document, number, width, scrollRoot }: {
  document: PDFDocumentProxy;
  number: number;
  width: number;
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRenderRef = useRef<RenderTask | null>(null);
  const [visible, setVisible] = useState(false);
  const [loadedPage, setLoadedPage] = useState<{ document: PDFDocumentProxy; page: PDFPageProxy } | null>(null);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void document.getPage(number).then(page => {
      if (!cancelled) setLoadedPage({ document, page });
    }).catch(error => {
      if (!cancelled) setRenderError(error instanceof Error ? error.message : 'PDF 页面加载失败');
    });
    return () => { cancelled = true; };
  }, [document, number]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => setVisible(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(([entry]) => {
      const isVisible = entry.isIntersecting;
      setVisible(isVisible);
      if (!isVisible) {
        setRenderedKey(null);
        const canvas = canvasRef.current;
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }, { root: scrollRoot.current, rootMargin: '600px 0px' });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [scrollRoot]);

  const page = loadedPage?.document === document ? loadedPage.page : null;
  const viewport = useMemo(() => {
    if (!page || !width) return null;
    const base = page.getViewport({ scale: 1 });
    return page.getViewport({ scale: width / base.width });
  }, [page, width]);
  const renderKey = `${document.fingerprints[0]}:${number}:${width}`;

  useEffect(() => {
    if (!visible || !page || !viewport) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    void (async () => {
      // PDF.js cannot start a second render on the same canvas until the
      // previous task has finished cancelling (for example after fast scrolling).
      const previous = activeRenderRef.current;
      if (previous) {
        previous.cancel();
        try { await previous.promise; } catch { /* cancellation */ }
        if (activeRenderRef.current === previous) activeRenderRef.current = null;
      }
      if (cancelled) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d');
      if (!context) {
        setRenderError('无法创建 PDF 画布');
        return;
      }
      renderTask = page.render({
        canvasContext: context,
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      activeRenderRef.current = renderTask;
      try {
        await renderTask.promise;
        if (!cancelled) { setRenderError(null); setRenderedKey(renderKey); }
      } catch (error) {
        if (!cancelled && (error as Error)?.name !== 'RenderingCancelledException') {
          setRenderError(error instanceof Error ? error.message : 'PDF 页面渲染失败');
        }
      } finally {
        if (activeRenderRef.current === renderTask) activeRenderRef.current = null;
      }
    })();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [visible, page, viewport, renderKey]);

  const pageWidth = viewport?.width ?? width;
  const pageHeight = viewport?.height ?? pageWidth * 1.414;
  return <div ref={wrapperRef} data-pdf-page={number} aria-label={`PDF 第 ${number} 页容器`} className="bg-white shadow" style={{ width: pageWidth, height: pageHeight }}>
    {renderError && <div role="alert" className="p-4 text-sm text-red-700">PDF 第 {number} 页渲染失败：{renderError}</div>}
    <canvas ref={canvasRef} aria-label={`PDF 第 ${number} 页`} data-rendered={visible && renderedKey === renderKey} className="block" />
  </div>;
}

export function PdfPreview({ data }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ source: Uint8Array; document: PDFDocumentProxy; pageSize:PdfPageSize } | null>(null);
  const [loadError, setLoadError] = useState<{ source: Uint8Array; message: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [size,setSize]=useState<PdfPageSize>({width:0,height:0});
  const sizeRef=useRef(size);
  const anchor=useRef<{page:number;fraction:number}|null>(null);
  const captureAnchor=useCallback(()=>{
    const container=containerRef.current;
    if(!container)return;
    const top=container.getBoundingClientRect().top+16;
    const pages=container.querySelectorAll<HTMLElement>('[data-pdf-page]');
    const page=[...pages].find(node=>node.getBoundingClientRect().bottom>top);
    if(page) {
      const rect=page.getBoundingClientRect();
      anchor.current={page:Number(page.dataset.pdfPage),fraction:Math.max(0,(top-rect.top)/Math.max(1,rect.height))};
    }
  },[]);
  function changeZoom(delta:number) {
    captureAnchor();
    setZoom(value=>Math.max(0.5,Math.min(2.5,Math.round((value+delta)*100)/100)));
  }

  useEffect(() => {
    let cancelled = false;
    // PDF.js transfers this buffer to its worker. Keep the source supplied by
    // the parent intact in case the component remounts.
    const task = getDocument({ data: data.slice() });
    task.promise.then(async document => {
      const firstPage=await document.getPage(1);
      const viewport=firstPage.getViewport({scale:1});
      if (!cancelled) setLoaded({ source: data, document, pageSize:{width:viewport.width,height:viewport.height} });
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
    const measure=(bounds?:{width:number;height:number})=>{
      const next=bounds?{width:bounds.width,height:bounds.height}:{width:Math.max(0,container.clientWidth-32),height:Math.max(0,container.clientHeight-32)};
      if(next.width===sizeRef.current.width && next.height===sizeRef.current.height)return;
      captureAnchor();sizeRef.current=next;setSize(next);
    };
    measure();
    const observer = new ResizeObserver(entries => measure(entries[0]?.contentRect));
    observer.observe(container);
    return () => observer.disconnect();
  }, [captureAnchor]);

  const document = loaded?.source === data ? loaded.document : null;
  const layout=pdfLayout(size,loaded?.pageSize||{width:595,height:842},document?.numPages||0,zoom);
  useLayoutEffect(()=>{
    const container=containerRef.current;const saved=anchor.current;
    if(!container || !saved)return;
    const page=container.querySelector<HTMLElement>(`[data-pdf-page="${saved.page}"]`);
    if(page) {
      const rect=page.getBoundingClientRect();
      container.scrollTop+=rect.top-container.getBoundingClientRect().top-16+rect.height*saved.fraction;
      anchor.current=null;
    }
  },[layout.columns,layout.pageWidth]);

  return <div className="flex min-h-0 flex-1 flex-col bg-white text-slate-900" aria-label="PDF 预览">
    {document && <div className="flex shrink-0 items-center justify-center gap-2 border-b border-slate-200 px-3 py-1.5 text-xs">
      <span>{document.numPages} 页 · 连续滚动</span>
      <span className="text-slate-500" aria-live="polite">{layout.columns===2?'自动双页':'自动单页'}</span>
      <button type="button" onClick={() => changeZoom(-0.25)} disabled={zoom <= 0.5} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="缩小 PDF">−</button>
      <span title="以适合窗口大小为 100%">{Math.round(zoom * 100)}%</span>
      <button type="button" onClick={() => changeZoom(0.25)} disabled={zoom >= 2.5} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40" aria-label="放大 PDF">+</button>
    </div>}
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto bg-slate-200 p-4">
      {!document && loadError?.source !== data && <div role="status" className="py-8 text-center text-sm">正在解析 PDF…</div>}
      {loadError?.source === data && <div role="alert" className="py-8 text-center text-sm text-red-700">PDF 加载失败：{loadError.message}</div>}
      {document && layout.pageWidth>0 && <div className="grid gap-4" aria-label="PDF 页面" data-columns={layout.columns} style={{width:'max-content',minWidth:'100%',gridTemplateColumns:`repeat(${layout.columns}, max-content)`,justifyContent:'center',alignItems:'start'}}>
        {Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index + 1} document={document} number={index + 1} width={layout.pageWidth} scrollRoot={containerRef} />)}
      </div>}
    </div>
  </div>;
}
