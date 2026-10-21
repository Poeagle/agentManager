import { decryptFile } from '@wecom/aibot-node-sdk';
import { nanoid } from 'nanoid';
import { getDb } from '../../db/index.js';
import { openSecret, sealSecret } from './config.js';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export interface ImageSource {url: string; aesKey: string}
export interface ImageAttachment {id: string; status: string; mime: string; bytes: number; error: string | null}

export function validateImageSource(source: ImageSource): void {
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error('图片下载地址无效'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash ||
    !['qq.com', 'qpic.cn', 'qlogo.cn', 'myqcloud.com', 'work.weixin.qq.com'].some(domain => host === domain || host.endsWith('.' + domain))) {
    throw new Error('图片地址必须使用企业微信的 HTTPS 媒体服务');
  }
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(source.aesKey) || Buffer.from(source.aesKey, 'base64').length !== 32) throw new Error('图片解密参数无效');
}

/** Called in the same transaction as inbox insertion; URLs and keys stay private. */
export function storeImageSources(messageId: string, images: ImageSource[]): void {
  if (images.length > MAX_IMAGES) throw new Error(`单条消息最多支持 ${MAX_IMAGES} 张图片`);
  for (const source of images) {
    const id = nanoid(24);
    try {validateImageSource(source);}
    catch {
      getDb().prepare("INSERT INTO platform_ai_attachments (id,message_id,status,error) VALUES (?,?,'failed','图片下载地址或解密参数无效，请重新发送')").run(id, messageId);
      continue;
    }
    getDb().prepare('INSERT INTO platform_ai_attachments (id,message_id,source) VALUES (?,?,?)')
      .run(id, messageId, sealSecret(JSON.stringify(source), `attachment:${id}`));
  }
}

export function messageAttachments(messageId: string): ImageAttachment[] {
  return getDb().prepare('SELECT id,status,mime,bytes,error FROM platform_ai_attachments WHERE message_id=? ORDER BY rowid').all(messageId) as ImageAttachment[];
}

const preparations = new Map<string, Promise<void>>();
let downloads = 0;
const downloadWaiters: Array<() => void> = [];
async function withDownloadSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (downloads >= 3) await new Promise<void>(resolve => downloadWaiters.push(resolve));
  else downloads++;
  try { if (signal?.aborted) throw new Error('已取消'); return await work(); }
  finally {const next = downloadWaiters.shift(); if (next) next(); else downloads--;}
}

export function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function downloadImage(source: ImageSource, signal?: AbortSignal): Promise<Buffer> {
  validateImageSource(source);
  const response = await fetch(source.url, {redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])])});
  if (!response.ok) throw new Error('图片下载失败');
  if (Number(response.headers.get('content-length') || 0) > MAX_IMAGE_BYTES + 64) {await response.body?.cancel(); throw new Error('图片超过大小限制');}
  const reader = response.body?.getReader();
  if (!reader) throw new Error('图片响应为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_IMAGE_BYTES + 64) throw new Error('图片超过大小限制');
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  return decryptFile(Buffer.concat(chunks), source.aesKey);
}

/** The inbox is already durable before downloading temporary WeCom media. */
export function prepareImages(messageId: string, signal?: AbortSignal): Promise<void> {
  const existing = preparations.get(messageId); if (existing) return existing;
  const work = prepareImagesOnce(messageId, signal).finally(() => preparations.delete(messageId));
  preparations.set(messageId, work); return work;
}
async function prepareImagesOnce(messageId: string, signal?: AbortSignal): Promise<void> {
  const pending = getDb().prepare("SELECT id,source FROM platform_ai_attachments WHERE message_id=? AND status='pending' ORDER BY rowid").all(messageId) as Array<{id: string; source: string}>;
  for (const attachment of pending) {
    try {
      const source = JSON.parse(openSecret(attachment.source, `attachment:${attachment.id}`)) as ImageSource;
      const bytes = await withDownloadSlot(() => downloadImage(source, signal), signal);
      const mime = imageMime(bytes);
      if (!mime || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片格式或大小不受支持');
      getDb().prepare("UPDATE platform_ai_attachments SET status='ready',mime=?,bytes=?,data=?,source='',error=NULL WHERE id=?")
        .run(mime, bytes.length, bytes, attachment.id);
    } catch {
      if (signal?.aborted) throw new Error('图片接收已暂停');
      // Never retain remote exceptions: a signed download URL or AES key may be echoed.
      getDb().prepare("UPDATE platform_ai_attachments SET status='failed',source='',error='图片下载或解密失败，请重新发送（支持 PNG/JPEG/GIF/WebP，每张最多 8 MB）' WHERE id=?").run(attachment.id);
    }
  }
}

export function ownedImage(id: string, userId: string, conversationId?: string): {id: string; mime: string; data: Buffer} | undefined {
  return getDb().prepare(`SELECT a.id,a.mime,a.data FROM platform_ai_attachments a JOIN platform_ai_messages m ON m.id=a.message_id
    JOIN platform_ai_conversations c ON c.id=m.conversation_id WHERE a.id=? AND c.user_id=? AND a.status='ready'
    ${conversationId ? 'AND c.id=?' : ''}`).get(...(conversationId ? [id,userId,conversationId] : [id,userId])) as {id: string; mime: string; data: Buffer} | undefined;
}

/** Keep binary payloads out of checkpoints/history; expand only at model transport. */
export function modelImageContent(ids: string[], userId: string): Array<{type: 'image_url'; image_url: {url: string}}> {
  return ids.slice(0, MAX_IMAGES).map(id => {
    const image = ownedImage(id, userId);
    if (!image) throw new Error('图片附件不可用或无访问权限');
    return {type: 'image_url', image_url: {url: `data:${image.mime};base64,${image.data.toString('base64')}`}};
  });
}
