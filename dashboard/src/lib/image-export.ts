export type ImageExportFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'original';
const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };

export function isSvgImage(image: { src: string; name: string; mimeType?: string }): boolean {
  return image.mimeType?.split(';')[0] === 'image/svg+xml' || /^data:image\/svg\+xml[;,]/i.test(image.src) || /\.svg(?:$|[?#&])/i.test(image.src) || /\.svg$/i.test(image.name);
}
export function imageExportName(name: string, format: ImageExportFormat, sourceType?: string): string {
  const safe = name.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '') || 'image';
  const originalExtension = /\.([a-z0-9]{1,8})$/i.exec(safe)?.[1];
  if(format==='original'&&originalExtension&&!extension[sourceType?.split(';')[0]||''])return safe;
  const suffix = format === 'original' ? extension[sourceType?.split(';')[0] || ''] || originalExtension : format === 'jpeg' ? 'jpg' : format;
  if (!suffix) return safe;
  return `${safe.replace(/\.(?:png|jpe?g|webp|svg|gif|avif|bmp|ico)$/i, '')}.${suffix}`;
}

function loadImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('图片无法转换，请尝试下载原图或 SVG。')); };
    image.src = src;
  });
}

/** Export original pixels/vector data, independent of the preview's zoom. */
export async function imageExportBlob(image: { src: string; name: string; mimeType?: string }, format: ImageExportFormat, options: { signal?: AbortSignal; background?: string } = {}): Promise<Blob> {
  const response = await fetch(image.src, { credentials: 'same-origin', signal: options.signal });
  if (!response.ok) throw new Error('图片读取失败，无法下载。');
  const source = await response.blob();
  const vector = isSvgImage(image) || source.type.split(';')[0] === 'image/svg+xml';
  if (format === 'original') return source;
  if (format === 'svg') {
    if (!vector) throw new Error('仅矢量图片支持 SVG；普通图片请选择 PNG、JPEG、WebP 或原图。');
    return source.type === mime.svg ? source : new Blob([source], { type: mime.svg });
  }
  const url = URL.createObjectURL(source);
  try {
    const loaded = await loadImage(url, options.signal);
    const width = loaded.naturalWidth, height = loaded.naturalHeight;
    if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) throw new Error('图片尺寸过大，请下载原图或 SVG。');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器暂不支持图片转换，请下载原图。');
      if (vector || format === 'jpeg') { context.fillStyle = options.background || '#ffffff'; context.fillRect(0, 0, width, height); }
      context.drawImage(loaded, 0, 0, width, height);
      options.signal?.throwIfAborted();
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
        if (!blob || blob.type !== mime[format]) reject(new Error('浏览器不支持所选格式，请选择 PNG 或原图。'));
        else resolve(blob);
      }, mime[format], .95));
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { URL.revokeObjectURL(url); }
}
