import { useState, useRef, useEffect } from 'react';
import { X, Loader2, ScrollText, Play } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api } from '../lib/api';
import '@xterm/xterm/css/xterm.css';

interface HistoryViewerProps {
  sessionId: string;
  onClose: () => void | Promise<void>;
  /** Show session actions in the center instead of the history toolbar. */
  ended?: boolean;
  /** Badge label (default "Viewing History"). */
  title?: string;
  /** Close-button tooltip (default "Close History (back to live terminal)"). */
  closeTitle?: string;
  /** When set, shows a "Resume" button (ended-session mode). */
  onResume?: () => void;
  resuming?: boolean;
  resumeFailed?: boolean;
}

export function HistoryViewer({ sessionId, onClose, ended = false, title, closeTitle, onResume, resuming = false, resumeFailed = false }: HistoryViewerProps) {
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closingRef = useRef(false);
  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!termContainerRef.current) return;

    setLoading(true);
    setEmpty(false);
    const controller = new AbortController();
    const frames = new Set<number>();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFrame = (callback: () => void) => {
      let frame = 0;
      frame = requestAnimationFrame(() => {
        frames.delete(frame);
        if (!controller.signal.aborted) callback();
      });
      frames.add(frame);
    };

    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 100000,
      theme: {
        background: '#0f1117',
        foreground: '#e4e8f1',
        cursor: '#0f1117',
        selectionBackground: '#3b82f680',
        black: '#1a1d27',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e8f1',
        brightBlack: '#4b5563',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f9fafb',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainerRef.current);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas2d fallback
    }

    termRef.current = term;
    fitRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      scheduleFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(termContainerRef.current);

    // Fit first so cols/rows reflect the actual container size, then fetch
    scheduleFrame(() => {
      fitAddon.fit();
      const cols = term.cols || 120;
      const rows = term.rows || 40;
      let attempts = 0;
      const load = () => {
        if (controller.signal.aborted) return;
        api.sessions.renderedOutput(sessionId, cols, rows, controller.signal).then(({ rendered }) => {
          if (controller.signal.aborted) return;
          if (!rendered) {
            // A just-ended session's final-screen snapshot may still be being
            // captured — retry once before giving up on showing anything.
            if (attempts++ < 1) { retryTimer = setTimeout(load, 700); return; }
            setEmpty(true);
            setLoading(false);
            return;
          }
          term.write(rendered);
          scheduleFrame(() => {
            term.scrollToBottom();
            setLoading(false);
          });
        }).catch((err) => {
          if (controller.signal.aborted) return;
          console.error('Failed to load rendered history:', err);
          term.write(`\x1b[31mFailed to load history: ${err.message}\x1b[0m`);
          setLoading(false);
        });
      };
      load();
    });

    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      for (const frame of frames) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  async function handleClose() {
    if (resuming || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setCloseError(null);
    try {
      await onClose();
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : '关闭会话失败，请重试');
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  }

  return (
    <div className="absolute inset-0 z-50" style={{ background: '#0f1117', borderTop: '2px solid var(--accent)' }}>
      {/* Floating toolbar */}
      {!ended && <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
          style={{ background: 'var(--accent)', color: 'white' }}
        >
          <ScrollText className="w-3 h-3" />
          {title || 'Viewing History'}
        </div>
        {onResume && (
          <button
            onClick={onResume}
            disabled={resuming}
            aria-busy={resuming}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-70 disabled:cursor-wait"
            style={{ background: 'var(--success)', color: 'white' }}
            title="Resume this session — reload the conversation and continue"
          >
            {resuming ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" /> : <Play className="w-3 h-3" />}
            {resuming ? 'Resuming…' : resumeFailed ? 'Retry Resume' : 'Resume'}
          </button>
        )}
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:opacity-80 transition-opacity"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          title={closeTitle || 'Close History (back to live terminal)'}
        >
          <X className="w-4 h-4" />
        </button>
      </div>}

      {ended && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 pointer-events-none">
          <div
            role="group"
            aria-label="会话操作"
            className="pointer-events-auto w-full max-w-sm rounded-xl border p-6 text-center shadow-xl"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          >
            <ScrollText className="mx-auto mb-3 h-7 w-7" style={{ color: 'var(--text-secondary)' }} />
            <div className="text-base font-semibold">会话已结束</div>
            <div className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {loading ? '正在加载最后的终端画面…' : empty ? '此会话没有保存的终端画面。' : '已保留最后的终端画面。'}
              {onResume ? '可以恢复会话继续工作，或关闭会话释放资源。' : '可以关闭会话释放资源。'}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={onResume}
                disabled={!onResume || resuming || closing}
                aria-busy={resuming}
                title={onResume ? '恢复会话并继续工作' : '此会话没有可恢复的对话记录'}
                className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                style={{ background: 'var(--success)', color: 'white' }}
              >
                {resuming ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Play className="h-4 w-4" />}
                {resuming ? '正在恢复…' : resumeFailed ? '重试恢复会话' : '恢复会话'}
              </button>
              <button
                onClick={() => { void handleClose(); }}
                disabled={resuming || closing}
                aria-busy={closing}
                className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                title="关闭标签页并释放会话资源"
              >
                {closing ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <X className="h-4 w-4" />}
                {closing ? '正在关闭…' : '关闭会话'}
              </button>
            </div>
            {closeError && <div role="alert" className="mt-3 text-xs" style={{ color: 'var(--error)' }}>{closeError}</div>}
          </div>
        </div>
      )}

      {loading && !ended && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ color: 'var(--text-secondary)' }}>
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading history...
        </div>
      )}

      {empty && !loading && !ended && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 px-6 text-center" style={{ color: 'var(--text-secondary)' }}>
          <ScrollText className="w-8 h-8 mb-3 opacity-40" />
          <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No saved screen for this session</div>
          <div className="text-xs max-w-sm leading-relaxed">
            Its last screen wasn't saved — it likely ended before screen restore was available (e.g. an earlier crash).
            {onResume ? ' You can still resume to reload the conversation.' : ''}
          </div>
          {onResume && (
            <button
              onClick={onResume}
              disabled={resuming}
              aria-busy={resuming}
              className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-70 disabled:cursor-wait"
              style={{ background: 'var(--success)', color: 'white' }}
            >
              {resuming ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" /> : <Play className="w-3.5 h-3.5" />}
              {resuming ? 'Resuming…' : resumeFailed ? 'Retry Resume' : 'Resume conversation'}
            </button>
          )}
        </div>
      )}

      <div
        ref={termContainerRef}
        className="h-full w-full"
        style={{ padding: '4px', opacity: loading ? 0 : 1 }}
      />
    </div>
  );
}
