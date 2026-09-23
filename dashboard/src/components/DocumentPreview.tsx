import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type FilePreviewType } from '../lib/api';
import { buildDrawioPreview } from '../lib/drawio-preview';
import { parseDelimitedFile, parseSpreadsheetHtml, type PreviewSheet } from '../lib/spreadsheet-preview';
import { SpreadsheetPreview } from './SpreadsheetPreview';

interface Props {
  path: string;
  type: Exclude<FilePreviewType, 'text'>;
  content: string;
  filesApi: typeof api.files;
  onDownload: () => void;
}

export function DocumentPreview({ path, type, content, filesApi, onDownload }: Props) {
  const [preview, setPreview] = useState<{ url?: string; html?: string; sheets?: PreviewSheet[]; error?: string } | null>(null);
  const office = ['word', 'spreadsheet', 'presentation'].includes(type);
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    let cancelled = false;
    async function load() {
      try {
        if (type === 'csv') {
          const sheets = parseDelimitedFile(content, path.split('/').pop() || 'CSV');
          if (!cancelled) setPreview({ sheets });
        } else if (type === 'drawio') {
          const { default: viewer } = await import('../vendor/drawio/viewer-static.min.js?raw');
          const html = buildDrawioPreview(content, viewer);
          if (!cancelled) setPreview({ html });
        } else {
          const blob = await filesApi.preview(path, controller.signal);
          if (cancelled) return;
          if (type === 'spreadsheet') {
            const sheets = parseSpreadsheetHtml(await blob.text());
            if (!cancelled) setPreview({ sheets });
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

  return <div className="flex-1 min-h-0 flex flex-col">
    <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs shrink-0" style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
      <span>{type === 'word' ? 'Word / 文本文档只读预览 · 保留分页与排版' : type === 'presentation' ? '演示文稿只读预览 · 按幻灯片分页' : type === 'drawio' ? 'draw.io 只读预览 · 外部链接和远程资源已禁用' : type === 'image' ? '图片预览' : type === 'csv' || type === 'spreadsheet' ? '表格只读预览 · 支持切换工作表' : 'PDF 只读预览'}</span>
      <button type="button" onClick={onDownload} className="shrink-0 hover:underline" style={{ color: 'var(--accent)' }}>下载原文件</button>
    </div>
    {!preview && <div role="status" className="flex-1 flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <Loader2 className="w-4 h-4 animate-spin" />{office ? '正在服务器本地转换文档，请稍候…' : '正在加载预览…'}
    </div>}
    {preview?.error && <div role="alert" className="p-6 text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--error)' }}>{preview.error}</div>}
    {preview?.html && <iframe title="draw.io 图表预览" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.html} className="w-full flex-1 min-h-0 border-0 bg-white" />}
    {preview?.sheets && <SpreadsheetPreview sheets={preview.sheets} />}
    {preview?.url && type === 'image' && <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4" style={{ background: 'var(--bg-secondary)' }}>
      <img src={preview.url} alt={path.split('/').pop()} className="max-w-full max-h-full object-contain" onError={() => setPreview({ error: '图片损坏或浏览器不支持该图片格式，请下载后查看' })} />
    </div>}
    {preview?.url && type !== 'image' && <>
      <iframe title={type === 'word' ? 'Word 文档预览' : type === 'presentation' ? '演示文稿预览' : 'PDF 文档预览'} src={preview.url} className="w-full flex-1 min-h-0 border-0 bg-white" />
      <div className="px-4 py-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>支持浏览器内的分页、缩放与查找；若浏览器不支持 PDF 显示，请下载原文件查看。</div>
    </>}
  </div>;
}
