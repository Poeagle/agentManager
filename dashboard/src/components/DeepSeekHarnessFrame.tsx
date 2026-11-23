import { useEffect, useRef, useState } from 'react';
import { HARNESS_BRIDGE } from '../lib/deepseek-harness';
import { conversationClientId } from '../lib/conversation-timeline';

type Connection = { phase: 'connecting' | 'ready' | 'failed'; message?: string };

export function DeepSeekHarnessFrame({ url, path }: { url: string; path: string }) {
  const [attempt, setAttempt] = useState(0);
  const target = new URL(url);
  if (target.origin === window.location.origin) {
    return <p role="alert" className="p-3 text-sm">Harness 需要独立的浏览器来源，请在 Agent 设置中修改地址。</p>;
  }
  return <HarnessConnection key={attempt} url={target.href} origin={target.origin} path={path}
    onRetry={() => setAttempt(value => value + 1)} />;
}

function HarnessConnection({ url, origin, path, onRetry }: {
  url: string; origin: string; path: string; onRetry: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Connection>({ phase: 'connecting' });

  useEffect(() => {
    const id = conversationClientId();
    let requested = false;
    const send = (type: string, payload = {}) =>
      frame.current?.contentWindow?.postMessage({ channel: HARNESS_BRIDGE, type, id, ...payload }, origin);
    const finish = (next: Connection) => {
      window.clearInterval(ping);
      window.clearTimeout(timeout);
      window.removeEventListener('message', receive);
      setStatus(next);
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.origin !== origin || event.source !== frame.current?.contentWindow
        || data?.channel !== HARNESS_BRIDGE || data.id !== id) return;
      if (data.type === 'ready' && !requested) {
        requested = true;
        window.clearInterval(ping);
        send('open', { path });
      } else if (data.type === 'opened' && requested) {
        finish({ phase: 'ready' });
      } else if (data.type === 'failed' && requested) {
        finish({ phase: 'failed', message: data.error === 'invalid-path'
          ? 'Harness 无法读取项目目录，请检查两端的目录映射和文件权限。'
          : 'Harness 工作区打开失败，请检查 Harness 实例的会话和访问权限。' });
      }
    };
    window.addEventListener('message', receive);
    const ping = window.setInterval(() => send('hello'), 300);
    const timeout = window.setTimeout(() => finish({
      phase: 'failed',
      message: requested ? 'Harness 打开工作区超时。' : '未连接到 Harness，请先登录实例，并检查 OctoAlly 插件和来源配置。',
    }), 20_000);
    send('hello');
    return () => {
      window.removeEventListener('message', receive);
      window.clearInterval(ping);
      window.clearTimeout(timeout);
    };
  }, [origin, path]);

  return <div className="h-full min-h-0 flex flex-col">
    {status.phase !== 'ready' && <div className="flex flex-1 flex-wrap content-center items-center justify-center gap-3 p-3 text-sm">
      <span role={status.phase === 'failed' ? 'alert' : 'status'}>
        {status.phase === 'failed' ? status.message : '正在打开 DeepSeek Harness 工作区…'}
      </span>
      <a className="underline" href={url} target="_blank" rel="noreferrer">在新标签页打开 Harness</a>
      {status.phase === 'failed' && <button type="button" className="underline" onClick={onRetry}>重试</button>}
    </div>}
    <iframe ref={frame} title="DeepSeek Harness" src={url} className="w-full min-h-0 flex-1 border-0"
      style={{ display: status.phase === 'ready' ? 'block' : 'none' }} referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" />
  </div>;
}
