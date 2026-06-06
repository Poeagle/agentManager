import { useState, useRef, useCallback } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, X, ExternalLink } from 'lucide-react';

interface WebPageViewProps {
  url: string;
  visible?: boolean;
  onUrlChange?: (url: string) => void;
}

export function WebPageView({ url, visible = true, onUrlChange }: WebPageViewProps) {
  const [inputUrl, setInputUrl] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Manual history tracking for back/forward.
  const [history, setHistory] = useState<string[]>([url]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  function normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  }

  const navigate = useCallback((newUrl: string) => {
    const normalized = normalizeUrl(newUrl);
    if (!normalized) return;
    setCurrentUrl(normalized);
    setInputUrl(normalized);
    setLoading(true);
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, normalized];
    });
    setHistoryIndex((prev) => prev + 1);
    onUrlChange?.(normalized);
  }, [historyIndex, onUrlChange]);

  function goBack() {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    const prevUrl = history[newIndex];
    setCurrentUrl(prevUrl);
    setInputUrl(prevUrl);
    setLoading(true);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    const nextUrl = history[newIndex];
    setCurrentUrl(nextUrl);
    setInputUrl(nextUrl);
    setLoading(true);
  }

  function stop() {
    setLoading(false);
  }

  function refresh() {
    setLoading(true);
    if (iframeRef.current) {
      iframeRef.current.src = currentUrl;
    }
  }

  function openExternal() {
    window.open(currentUrl, '_blank');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(inputUrl);
    (e.target as HTMLFormElement).querySelector('input')?.blur();
  }

  return (
    <div className="h-full flex flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      {/* Browser toolbar */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 shrink-0"
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}
      >
        <button
          onClick={goBack}
          disabled={!canGoBack && !loading}
          className="flex items-center justify-center rounded transition-colors disabled:opacity-30"
          style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
          title="Go back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          className="flex items-center justify-center rounded transition-colors disabled:opacity-30"
          style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
          title="Go forward"
        >
          <ArrowRight className="w-4 h-4" />
        </button>

        {loading ? (
          <button
            onClick={stop}
            className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
            title="Stop loading"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={refresh}
            className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
            title="Refresh"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        )}

        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setInputUrl(currentUrl)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setInputUrl(currentUrl);
                e.currentTarget.blur();
              }
            }}
            placeholder="Enter URL..."
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3 py-1 rounded-md text-xs outline-none"
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          />
        </form>

        <button
          onClick={openExternal}
          className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
          style={{ width: 28, height: 28, color: 'var(--text-secondary)' }}
          title="Open in browser"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 relative">
        <iframe
          ref={iframeRef}
          src={currentUrl}
          className="w-full h-full border-0"
          style={{ background: 'white' }}
          onLoad={() => setLoading(false)}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
