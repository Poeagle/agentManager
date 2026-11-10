import { lazy, Suspense, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type FilePreviewType,type PreviewFontReport } from '../lib/api';
import { buildDrawioPreview } from '../lib/drawio-preview';
import { parseDelimitedFile, parseSpreadsheetHtml, type PreviewSheet } from '../lib/spreadsheet-preview';
import { SpreadsheetPreview } from './SpreadsheetPreview';
import { ImagePreview } from './ImagePreview';

const PdfPreview = lazy(() => import('./PdfPreview').then(module => ({ default: module.PdfPreview })));

interface Props {
  path: string;
  type: Exclude<FilePreviewType, 'text'>;
  content: string;
  filesApi: typeof api.files;
  onDownload: () => void;
}

export function DocumentPreview({ path, type, content, filesApi, onDownload }: Props) {
  const [preview, setPreview] = useState<{ url?: string; pdfData?: Uint8Array; html?: string; sheets?: PreviewSheet[]; error?: string } | null>(null);
  const [fonts,setFonts]=useState<PreviewFontReport|null>(null);
  const office = ['word', 'spreadsheet', 'presentation'].includes(type);
  useEffect(() => {
    setPreview(null);setFonts(null);
    const controller = new AbortController();
    let url: string | undefined;
    let cancelled = false;
    async function load() {
      try {
        if(type==='video'||type==='audio'){if(!cancelled)setPreview({url:filesApi.previewUrl(path)});return;}
        if (type === 'csv') {
          const sheets = parseDelimitedFile(content, path.split('/').pop() || 'CSV');
          if (!cancelled) setPreview({ sheets });
        } else if (type === 'drawio') {
          const { default: viewer } = await import('../vendor/drawio/viewer-static.min.js?raw');
          const html = buildDrawioPreview(content, viewer);
          if (!cancelled) setPreview({ html });
        } else {
          const blob = await filesApi.preview(path, controller.signal,undefined,report=>{if(!cancelled)setFonts(report);});
          if (cancelled) return;
          if (type === 'spreadsheet') {
            const sheets = parseSpreadsheetHtml(await blob.text());
            if (!cancelled) setPreview({ sheets });
            return;
          }
          if (type === 'pdf' || type === 'word' || type === 'presentation') {
            const pdfData = new Uint8Array(await blob.arrayBuffer());
            if (!cancelled) setPreview({ pdfData });
            return;
          }
          url = URL.createObjectURL(blob);
          setPreview({ url });
        }
      } catch (error) {
        if (!cancelled) setPreview({ error: error instanceof Error ? error.message : '文档预览失败' });
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, type, content, filesApi]);

  if (preview?.url && type === 'image') return <ImagePreview key={preview.url} url={preview.url} name={path.split('/').pop() ?? path} onDownload={onDownload}
    onError={() => setPreview({ error: '图片损坏或浏览器不支持该图片格式，请下载后查看' })} />;

  return <div className="flex-1 min-h-0 flex flex-col">
    <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs shrink-0" style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      <span>{type==='video'?'视频预览':type==='audio'?'音频预览':type === 'word' ? 'Word / 文本文档只读预览 · 服务器转换' : type === 'presentation' ? '演示文稿只读预览 · 按幻灯片分页' : type === 'drawio' ? 'draw.io 只读预览 · 外部链接和远程资源已禁用' : type === 'image' ? '图片预览' : type === 'csv' || type === 'spreadsheet' ? '表格只读预览 · 支持切换工作表' : 'PDF 只读预览'}</span>
      <button type="button" onClick={onDownload} className="shrink-0 hover:underline" style={{ color: 'var(--accent)' }}>下载原文件</button>
    </div>
    {office&&fonts&&(fonts.substitutions.length>0||!fonts.checked)&&<div role="status" aria-label="文档字体提示" className="px-4 py-2 text-xs shrink-0" style={{color:'var(--text-secondary)',borderBottom:'1px solid var(--border)'}}>
      {fonts.substitutions.length>0&&<details><summary className="cursor-pointer">预览字体替换：{fonts.substitutions[0].requested} → {fonts.substitutions[0].replacement}{fonts.substitutions.length+(fonts.omitted||0)>1&&` 等 ${fonts.substitutions.length+(fonts.omitted||0)} 项`}</summary><ul>{fonts.substitutions.map((entry,index)=><li key={index}>{entry.requested} → {entry.replacement}</li>)}{!!fonts.omitted&&<li>另有 {fonts.omitted} 项</li>}</ul></details>}
      <p>{!fonts.checked?'部分字体未能逐项核对。':''}预览采用服务器可用字体，替换可能影响换行和分页；原文件未修改。</p>
    </div>}
    {!preview && <div role="status" className="flex-1 flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <Loader2 className="w-4 h-4 animate-spin" />{office ? '正在服务器本地转换文档，请稍候…' : '正在加载预览…'}
    </div>}
    {preview?.error && <div role="alert" className="p-6 text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--error)' }}>{preview.error}</div>}
    {preview?.url&&type==='video'&&<video aria-label="视频预览" src={preview.url} controls playsInline preload="metadata" className="min-h-0 w-full flex-1 bg-black" onError={()=>setPreview({error:'浏览器无法解码此视频，请下载后查看'})}/>}
    {preview?.url&&type==='audio'&&<div className="flex flex-1 items-center justify-center p-6"><audio aria-label="音频预览" src={preview.url} controls preload="metadata" onError={()=>setPreview({error:'浏览器无法解码此音频，请下载后查看'})}/></div>}
    {preview?.html && <iframe title="draw.io 图表预览" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html} className="w-full flex-1 min-h-0 border-0 bg-white" />}
    {preview?.sheets && <SpreadsheetPreview sheets={preview.sheets} />}
    {preview?.pdfData && <Suspense fallback={<div role="status" className="p-6 text-sm">正在加载 PDF 渲染器…</div>}><PdfPreview data={preview.pdfData} /></Suspense>}
  </div>;
}
