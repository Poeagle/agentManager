import { useState } from 'react';
import type { AiAttachment } from '../lib/platform-ai';

export function AiMessageImages({attachments}: {attachments?: AiAttachment[]}) {
  if (!attachments?.length) return null;
  return <div aria-label="消息图片" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
    {attachments.map((image, index) => <Image key={image.id} image={image} index={index} />)}
  </div>;
}

function Image({image, index}: {image: AiAttachment; index: number}) {
  const [failed, setFailed] = useState(false);
  if (image.status !== 'ready') return <div className="rounded-md border p-3 text-xs" style={{borderColor: 'var(--border)', color: image.status === 'failed' ? 'var(--error)' : 'var(--text-secondary)'}}>
    图片 {index + 1}：{image.status === 'failed' ? image.error || '接收失败，请重新发送' : '正在接收…'}
  </div>;
  const url = `/api/platform-ai/attachments/${encodeURIComponent(image.id)}`;
  return <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看原图 ${index + 1}`} className="block min-w-0 rounded-md border p-2" style={{borderColor: 'var(--border)'}}>
    {failed ? <span className="text-xs">图片加载失败，点击重试查看原图</span> : <img src={url} alt={`用户发送的图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-80 max-w-full rounded object-contain" />}
    <span className="mt-1 block text-xs" style={{color: 'var(--text-secondary)'}}>图片 {index + 1} · 点击查看原图</span>
  </a>;
}
