import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RotateCcw, ExternalLink, ZoomIn, ZoomOut, Loader2, Check, AlertCircle, Paperclip } from 'lucide-react';
import { isKeyboardNavActive } from '../lib/shortcuts';
import { api } from '../lib/api';
import { HistoryViewer } from './HistoryViewer';
import '@xterm/xterm/css/xterm.css';

// Global event: when any terminal connects, notify all others to retry immediately.
// This prevents staggered reconnects after a server restart.
const serverAliveListeners = new Set<() => void>();
function notifyServerAlive() {
  for (const fn of serverAliveListeners) fn();
}

// Copy text to the clipboard with a fallback for non-secure contexts.
// navigator.clipboard is only exposed over HTTPS or http://localhost; when the
// dashboard is opened via a LAN IP over plain HTTP (e.g. http://192.168.x.x:port)
// it's undefined, so writeText() would throw and copy silently fails. Fall back
// to a hidden <textarea> + execCommand('copy'), which works without a secure context.
function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}
function fallbackCopy(text: string) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { /* nothing more we can do */ }
}

function openTerminalLink(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  const confirmed = window.confirm(
    `Do you want to navigate to ${parsed.href}?\n\nWARNING: This link could potentially be dangerous`,
  );
  if (!confirmed) return;

  // In a regular browser this opens a real tab. The Tauri-only interceptor in
  // main.tsx routes it through the host when running inside the desktop webview.
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

// Strip mouse-tracking enable sequences (DECSET 1000/1001/1002/1003) from terminal
// output so the browser xterm never enters mouse-reporting mode. Otherwise a TUI
// that turns on mouse tracking (e.g. Claude Code 2.1.18x) captures the user's
// drag-select and copies it into the tmux buffer via an OSC52 the browser can't
// reach ("copied N chars to tmux buffer"), instead of letting xterm do a native
// selection the user can Ctrl+Shift+C out. Belt-and-suspenders with the server's
// CLAUDE_CODE_DISABLE_MOUSE=1 — and the only thing that fixes already-running
// sessions (they re-assert mouse mode on redraw) without restarting them.
const MOUSE_ENABLE_RE = /\x1b\[\?100[0123]h/g;


// Global terminal connection tracking — lets App.tsx show a "connecting" indicator
const pendingTerminals = new Set<string>();
const connectionListeners = new Set<() => void>();
export function getPendingTerminalCount() { return pendingTerminals.size; }
export function onTerminalConnectionChange(fn: () => void) {
  connectionListeners.add(fn);
  return () => { connectionListeners.delete(fn); };
}
function notifyConnectionChange() {
  for (const fn of connectionListeners) fn();
}

// Live progress for a pasted/dropped file being shared with the session.
interface UploadItem {
  id: number;
  name: string;
  phase: 'reading' | 'uploading' | 'done' | 'error';
  percent: number;      // 0..100, meaningful when `determinate`
  determinate: boolean; // false → render an indeterminate (animated) bar
  error?: string;
}

interface TerminalProps {
  sessionId: string;
  visible?: boolean;
  /** When true, disconnect the WebSocket and stop receiving data.
   *  Used to yield the session to another Terminal (e.g. ActiveTerminals grid). */
  suspended?: boolean;
  /** When true, don't send resize commands to the server PTY.
   *  Grid/thumbnail views use this to avoid corrupting the PTY column width
   *  that the main terminal depends on. */
  passiveResize?: boolean;
  /** Hide the xterm.js cursor. Used for sessions where the CLI renders its own cursor. */
  hideCursor?: boolean;
  /** CLI type — Codex sessions need capture-pane refresh on tab switch/resize */
  cliType?: 'claude' | 'codex';
  onExit?: (exitCode: number) => void;
  onReconnect?: () => void;
  onPopOut?: () => void;
}

export function Terminal({ sessionId, visible = true, suspended = false, passiveResize = false, hideCursor = false, cliType, onExit, onReconnect, onPopOut }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);
  // Progress of in-flight pasted/dropped file uploads (rendered as an overlay).
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadSeqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFileRef = useRef<(file: File) => void>(() => {});

  // Read terminal font size from settings
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  const configuredFontSize = Number(settingsData?.settings?.terminal_font_size) || 12;
  const [showHistory, setShowHistory] = useState(false);

  // Expose connect/disconnect so the suspension effect can control it
  const connectFnRef = useRef<(() => void) | null>(null);
  const disconnectFnRef = useRef<(() => void) | null>(null);
  const isSuspendedRef = useRef(suspended);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const passiveResizeRef = useRef(passiveResize);
  passiveResizeRef.current = passiveResize;
  const hideCursorRef = useRef(hideCursor);
  hideCursorRef.current = hideCursor;
  const cliTypeRef = useRef(cliType);
  cliTypeRef.current = cliType;
  // Debounce fresh-screen snapshots when a terminal becomes visible. Hidden
  // WebGL canvases can lose their painted texture, and a truncated raw replay
  // can contain only a TUI's latest status-line redraw.
  const displayRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  isSuspendedRef.current = suspended;

  // Hard refresh — the dedicated "screen is messed up, fix it" path. Always
  // clears the xterm buffer first so stale stacked renders are discarded,
  // then forces the CLI to redraw into the clean buffer. Intentionally heavier
  // than the passive refit that tab switches / visibility changes use.
  const hardRefresh = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const fit = fitRef.current;
    const w = wsRef.current;
    if (fit) fit.fit();

    if (!w || w.readyState !== WebSocket.OPEN) {
      // WebSocket not open — full reconnect, server will replay into clean buffer
      term.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
      return;
    }

    if (cliTypeRef.current === 'codex') {
      // Codex doesn't redraw on SIGWINCH. Send resize so tmux pane matches
      // our width, then clear and request a capture-pane refresh.
      w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'refresh' }));
      }, 300);
      return;
    }

    if (hideCursorRef.current) {
      // Claude session/agent: match the PTY to our width first and let tmux +
      // Claude reflow, THEN clear and SIGWINCH-toggle so the clean redraw lands
      // in an already-reset buffer. Resetting up-front (the old order) left a
      // gap where the freshly-resized redraw streamed into a buffer we were
      // about to clear — racing the grid's initial resize and re-garbling.
      const cols = term.cols;
      const rows = term.rows;
      w.send(JSON.stringify({ type: 'resize', cols, rows }));
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
        setTimeout(() => {
          if (w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }, 80);
      }, 150);
      return;
    }

    // Plain terminal — reconnect for a fresh server replay.
    term.reset();
    disconnectFnRef.current?.();
    setTimeout(() => connectFnRef.current?.(), 50);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontSize: configuredFontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10000,
      allowProposedApi: true,
      linkHandler: {
        activate: (event, url) => {
          event.preventDefault();
          openTerminalLink(url);
        },
      },
      theme: {
        background: '#0f1117',
        foreground: '#e4e8f1',
        cursor: '#3b82f6',
        cursorAccent: '#0f1117',
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
    term.open(containerRef.current);

    // WebGL renderer — faster glyph rendering via GPU. Causes ~10% idle CPU
    // in Tauri/WebKitGTK (compositor polls GL surfaces at vsync), but
    // Chromium (Electron/browser) handles idle GL contexts properly.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas2d renderer is the default fallback
    }

    // Make plain-text URLs clickable. OSC 8 links use the linkHandler above.
    term.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      console.log('[agentmanager] Link clicked in terminal:', url);
      openTerminalLink(url);
    }));

    // Fit after a small delay to ensure container is sized
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // Incremented whenever the browser emits a real paste event. Ctrl+Shift+V
    // uses it to decide whether its text-only compatibility fallback is needed.
    let pasteEventSequence = 0;

    // Intercept Ctrl+Shift+C to copy selection
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) writeClipboard(sel);
        e.preventDefault();
        return false;
      }
      // Let the browser perform both its regular paste (Ctrl+V) and terminal-
      // style paste (Ctrl+Shift+V). Chromium treats the latter as plain-text
      // paste, so pasteHandler also recovers images from the Clipboard API when
      // that event arrives without clipboard data.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v' && e.type === 'keydown') {
        const sequenceBeforeKey = pasteEventSequence;
        setTimeout(() => {
          if (pasteEventSequence !== sequenceBeforeKey) return;
          if (navigator.clipboard?.readText && window.isSecureContext) {
            navigator.clipboard.readText().then(text => {
              if (text) {
                const w = wsRef.current;
                if (w && w.readyState === WebSocket.OPEN) {
                  w.send(JSON.stringify({ type: 'input', data: text, paste: true }));
                }
              }
            }).catch(() => {});
          }
        }, 0);
        // Keep xterm from consuming the keydown. The browser can then perform
        // its default paste action and expose image/file ClipboardItems.
        return false;
      }
      return true;
    });

    // Capture on the stable terminal container, before xterm's hidden textarea
    // handles the event. The textarea can be recreated as xterm changes state.
    const pasteTarget = containerRef.current;
    const dropEl = containerRef.current;

    // The server-side CLI can't see the browser clipboard / OS drag, so any
    // pasted or dropped file is uploaded, saved into the project, and its path
    // injected into the terminal so the active Claude or Codex CLI can inspect it.
    const injectPath = (p?: string) => {
      const ww = wsRef.current;
      if (!p || !ww || ww.readyState !== WebSocket.OPEN) return;
      const needsQuote = /[\s"\\]/.test(p);
      const q = needsQuote ? `"${p.replace(/(["\\])/g, '\\$1')}"` : p;
      ww.send(JSON.stringify({ type: 'input', data: `${q} `, paste: true }));
    };
    const uploadFile = (file: File) => {
      const uid = ++uploadSeqRef.current;
      const isImage = file.type.startsWith('image/');
      const name = file.name || (isImage ? 'pasted image' : 'file');
      setUploads(prev => [...prev, { id: uid, name, phase: 'reading', percent: 0, determinate: false }]);
      const patch = (u: Partial<UploadItem>) =>
        setUploads(prev => prev.map(it => (it.id === uid ? { ...it, ...u } : it)));
      const dismissAfter = (ms: number) =>
        setTimeout(() => setUploads(prev => prev.filter(it => it.id !== uid)), ms);

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const dataUrl = reader.result as string;
          patch({ phase: 'uploading', percent: 0, determinate: false });
          const onProgress = (f: number) =>
            patch({ phase: 'uploading', percent: Math.round(f * 100), determinate: true });
          // The image endpoint validates formats that Codex/Claude can inspect
          // directly. Other image formats still use the generic file endpoint.
          const usesImageEndpoint = /^(image\/(png|jpeg|jpg|gif|webp))$/i.test(file.type);
          const res = usesImageEndpoint
            ? await api.sessions.pasteImage(sessionId, dataUrl, onProgress)
            : await api.sessions.pasteFile(sessionId, dataUrl, file.name, onProgress);
          injectPath(res?.path);
          patch({ phase: 'done', percent: 100, determinate: true });
          dismissAfter(1800);
        } catch (err) {
          console.error('[paste-file] upload failed:', err);
          patch({ phase: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
          dismissAfter(6000);
        }
      };
      reader.onerror = () => {
        patch({ phase: 'error', error: 'Failed to read file' });
        dismissAfter(6000);
      };
      reader.readAsDataURL(file);
    };
    uploadFileRef.current = uploadFile;

    const pasteHandler = (ev: Event) => {
      const ce = ev as ClipboardEvent;
      const w = wsRef.current;
      pasteEventSequence++;

      // A pasted file (image or any document) takes precedence over text.
      const files = Array.from(ce.clipboardData?.files || []);
      const items = ce.clipboardData?.items;
      if (!files.length && items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            const f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length) {
        ce.preventDefault();
        ce.stopImmediatePropagation();
        files.forEach(uploadFile);
        return;
      }

      const text = ce.clipboardData?.getData('text');
      if (text && w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data: text, paste: true }));
        ce.preventDefault();
        ce.stopImmediatePropagation();
        return;
      }

      // Chromium exposes an image as an empty ClipboardEvent for
      // Ctrl+Shift+V ("paste as plain text"). Recover it explicitly in secure
      // contexts. On plain LAN HTTP the attachment button remains available.
      if (navigator.clipboard?.read && window.isSecureContext) {
        ce.preventDefault();
        ce.stopImmediatePropagation();
        navigator.clipboard.read().then(items => {
          for (const item of items) {
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (!imageType) continue;
            item.getType(imageType).then(blob => {
              const subtype = imageType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
              uploadFile(new File([blob], `clipboard.${subtype}`, { type: imageType }));
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    };
    pasteTarget.addEventListener('paste', pasteHandler, { capture: true });

    // Drag-and-drop onto the terminal — the reliable path for non-image files,
    // since browsers don't always expose pasted file bytes but drop always does.
    const dragOverHandler = (ev: DragEvent) => {
      if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
    };
    const dropHandler = (ev: DragEvent) => {
      const files = ev.dataTransfer?.files;
      if (files && files.length) {
        ev.preventDefault();
        ev.stopPropagation();
        Array.from(files).forEach(uploadFile);
      }
    };
    dropEl.addEventListener('dragover', dragOverHandler);
    dropEl.addEventListener('drop', dropHandler);

    termRef.current = term;
    fitRef.current = fitAddon;

    // RAF-based write batching — accumulate WS data and flush once per frame
    let pendingData = '';
    let rafId: number | null = null;

    function flushWrite() {
      rafId = null;
      if (pendingData) {
        const data = pendingData.replace(MOUSE_ENABLE_RE, '');
        pendingData = '';
        term.write(data);
      }
    }

    // Send user input to server
    // Filter out xterm.js focus reporting sequences (\x1b[I = focus in, \x1b[O = focus out)
    // These get sent when terminal gains/loses focus and Claude Code's TUI interprets them as input
    term.onData((data: string) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onBinary((data: string) => {
      const w = wsRef.current;
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // WebSocket connection with auto-reconnect
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let intentionalClose = false;
    // Suspension: close without showing disconnect messages or triggering reconnect
    let suspendedClose = false;
    // Set when doResize wanted to send but WS wasn't open yet
    let pendingResize = false;
    function connectWs() {
      if (isSuspendedRef.current) return;

      // Close any existing connection first
      const old = wsRef.current;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        old.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (passiveResizeRef.current) params.set('passive', '1');
      params.set('attempt', String(reconnectAttempts));
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal/${sessionId}?${params}`);
      wsRef.current = ws;
      pendingTerminals.add(sessionId);
      notifyConnectionChange();

      ws.onopen = () => {
        setConnected(true);
        pendingTerminals.delete(sessionId);
        notifyConnectionChange();
        reconnectAttempts = 0;
        // If a resize was missed while WS was connecting, send it now.
        if (pendingResize) {
          pendingResize = false;
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
        term.focus();
        notifyServerAlive();

        // A project switch reconnects the socket after the visible effect has
        // already run (while readyState was still CONNECTING). Complete the
        // repaint/snapshot path here as well so the active tab cannot get stuck
        // showing only the tail of the raw replay.
        if (visibleRef.current && !passiveResizeRef.current) {
          requestAnimationFrame(() => {
            if (ws.readyState !== WebSocket.OPEN || !visibleRef.current) return;
            fitAddon.fit();
            term.refresh(0, term.rows - 1);
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            // Codex needs a rendered tmux snapshot after a tab switch because
            // it does not redraw on SIGWINCH. Claude and plain terminals must
            // keep the original PTY cursor state; capture-pane has no cursor
            // metadata and would move xterm's cursor to the replay tail.
            if (cliTypeRef.current === 'codex') {
              if (displayRefreshTimer.current) clearTimeout(displayRefreshTimer.current);
              displayRefreshTimer.current = setTimeout(() => {
                displayRefreshTimer.current = null;
                if (ws.readyState === WebSocket.OPEN && visibleRef.current) {
                  ws.send(JSON.stringify({ type: 'refresh' }));
                }
              }, 500);
            }
          });
        }

        // Force tmux reflow: resize to cols-1 then back to correct width.
        // Only for sessions (hideCursor=true) where CLI redraws
        // on SIGWINCH. Plain terminals (bash) don't redraw old output, so
        // force-resize just corrupts the tmux pane history via lossy reflow.
        // SKIP for Codex: Codex TUI redraws accumulate in tmux scrollback,
        // causing capture-pane to show duplicate output.
        if (!passiveResizeRef.current && hideCursorRef.current && cliTypeRef.current !== 'codex') {
          const cols = term.cols;
          const rows = term.rows;
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
                }
              }, 100);
            }
          }, 200);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'output':
              reconnectAttempts = 0;
              // Defense-in-depth: strip focus reporting enable/disable sequences
              // so xterm.js never enters sendFocusMode (which causes focus/blur
              // events to be sent as input, corrupting Codex TUI rendering)
              pendingData += msg.data.replace(/\x1b\[\?1004[hl]/g, '');
              if (rafId === null) {
                rafId = requestAnimationFrame(flushWrite);
              }
              break;
            case 'exit':
              if (msg.reason === 'popped-out') {
                term.write(`\r\n\x1b[36m[Popped out to system terminal]\x1b[0m\r\n`);
              } else {
                term.write(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
              }
              intentionalClose = true;
              onExit?.(msg.exitCode);
              break;
            case 'error':
              term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              intentionalClose = true;
              break;
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (suspendedClose) {
          suspendedClose = false;
          return;
        }
        if (intentionalClose) {
          term.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
          return;
        }

        // Exponential backoff reconnect
        if (reconnectAttempts < 30) {
          const delay = Math.min(100 * Math.pow(1.5, reconnectAttempts), 5000);
          reconnectAttempts++;
          if (!passiveResizeRef.current) {
            term.write(`\r\n\x1b[90m[Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/30)...]\x1b[0m\r\n`);
          }
          reconnectTimer = setTimeout(() => {
            term.clear();
            connectWs();
          }, delay);
        } else {
          term.write('\r\n\x1b[31m[Connection lost — max reconnect attempts reached]\x1b[0m\r\n');
        }
      };
    }

    function disconnectWs() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        suspendedClose = true;
        ws.close();
      }
      wsRef.current = null;
    }

    // When another terminal connects, immediately retry if we're stuck in backoff.
    // Don't touch terminals that are already OPEN or CONNECTING — interrupting
    // a CONNECTING socket causes a cascade of reconnections.
    function onServerAlive() {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      // Only act if we're waiting on a backoff timer
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
        term.clear();
        connectWs();
      }
    }
    serverAliveListeners.add(onServerAlive);

    // Expose to the suspension effect
    connectFnRef.current = connectWs;
    disconnectFnRef.current = disconnectWs;

    // Initial connection (unless suspended)
    if (!isSuspendedRef.current) {
      connectWs();
    }

    // Handle resize — debounced
    let lastCols = term.cols;
    let lastRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let firstResize = true;

    function doResize(initial = false) {
      fitAddon.fit();
      // The first resize follows the initial replay. For TUIs, that replay is
      // only a transitional stream at the old pane width; clear it before the
      // real-size snapshot arrives so its final newline cannot leave xterm's
      // cursor stranded in the lower-right corner.
      if (initial && (hideCursorRef.current || cliTypeRef.current === 'codex')) {
        term.reset();
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (!passiveResizeRef.current) {
          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            }));
            // Force PTY redraw via SIGWINCH toggle. Skip for Codex: it doesn't
            // redraw on SIGWINCH and the extra resize just stacks duplicate
            // output in tmux scrollback (cleaned up later via capture-pane).
            if (cliTypeRef.current !== 'codex') {
              const cols = term.cols;
              const rows = term.rows;
              setTimeout(() => {
                if (w.readyState === WebSocket.OPEN) {
                  w.send(JSON.stringify({ type: 'resize', cols: cols - 1, rows }));
                  setTimeout(() => {
                    if (w.readyState === WebSocket.OPEN) {
                      w.send(JSON.stringify({ type: 'resize', cols, rows }));
                    }
                  }, 50);
                }
              }, 50);
            }
          } else {
            // WS not open yet — send when it connects
            pendingResize = true;
          }
        }
      }
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && (entry.contentRect.width < 10 || entry.contentRect.height < 10)) return;

      if (firstResize) {
        // Send first resize immediately (triggers server replay + spawn)
        firstResize = false;
        doResize(true);
        return;
      }

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doResize, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      intentionalClose = true;
      pendingTerminals.delete(sessionId);
      notifyConnectionChange();
      serverAliveListeners.delete(onServerAlive);
      connectFnRef.current = null;
      disconnectFnRef.current = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      pasteTarget.removeEventListener('paste', pasteHandler, { capture: true } as EventListenerOptions);
      if (uploadFileRef.current === uploadFile) uploadFileRef.current = () => {};
      dropEl.removeEventListener('dragover', dragOverHandler);
      dropEl.removeEventListener('drop', dropHandler);
      wsRef.current?.close();
      term.dispose();
    };
  }, [sessionId, onExit]);

  // Suspension effect: disconnect WebSocket when suspended, reconnect when resumed.
  // This ensures only one Terminal connects to a given session at a time.
  // Skip the initial mount — the main effect already handles the first connection.
  const suspendInitRef = useRef(true);
  useEffect(() => {
    if (suspendInitRef.current) {
      suspendInitRef.current = false;
      return;
    }
    if (suspended) {
      disconnectFnRef.current?.();
    } else {
      // Resume — full reset of xterm (clears viewport + scrollback) then
      // reconnect so the server replay renders into a completely clean terminal.
      if (termRef.current && connectFnRef.current) {
        termRef.current.reset();
        connectFnRef.current();
      }
    }
  }, [suspended]);

  // When passiveResize changes from true→false (grid→full terminal), the
  // replayed output is at the wrong (narrow grid) width. Clear the terminal
  // and reconnect so the server sends a fresh replay at the correct width
  // and the resize goes through to the PTY.
  const prevPassiveRef = useRef(passiveResize);
  useEffect(() => {
    const wasPassive = prevPassiveRef.current;
    prevPassiveRef.current = passiveResize;

    if (wasPassive && !passiveResize && !suspended && termRef.current) {
      // Switching from passive (grid) to active (full) — clear and reconnect
      termRef.current.reset();
      disconnectFnRef.current?.();
      setTimeout(() => connectFnRef.current?.(), 50);
    }
  }, [passiveResize, suspended]);

  // Update font size when setting changes (without recreating the terminal)
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const w = wsRef.current;
    if (!term) return;
    if (term.options.fontSize !== configuredFontSize) {
      term.options.fontSize = configuredFontSize;
      fit?.fit();
      // Notify PTY of new dimensions and force redraw via SIGWINCH toggle
      if (w && w.readyState === WebSocket.OPEN) {
        w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        setTimeout(() => {
          w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
          setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
        }, 50);
      }
    }
  }, [configuredFontSize]);

  // Reactively hide/show the xterm.js cursor when hideCursor prop changes
  // (e.g. when session data loads after mount)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Only Codex renders its own cursor — hide xterm's there to avoid a double
    // cursor. Claude positions the real terminal cursor at its input box and
    // relies on it, and plain shells obviously need it, so both keep a visible
    // blinking cursor (the app's own DECTCEM still drives show/hide, so there's
    // no double cursor if Claude ever decides to draw its own).
    // Full-screen CLIs render and position their own input cursor. xterm's
    // independent cursor can be left at the last cell after a resize/replay,
    // producing a misleading second cursor in the lower-right corner.
    const forceHide = hideCursor;
    if (forceHide) {
      // DECTCEM: hide cursor at VT level + make cursor transparent
      term.write('\x1b[?25l');
      term.options.cursorBlink = false;
      term.options.cursorInactiveStyle = 'none';
    } else {
      term.write('\x1b[?25h');
      term.options.cursorBlink = true;
      term.options.cursorStyle = 'block';
      term.options.cursorInactiveStyle = 'outline';
    }
  }, [hideCursor, cliType]);

  // Re-focus and refit terminal when it becomes visible.
  // Single RAF + short delay ensures DOM layout is settled before measuring.
  // Skip auto-focus when the tab change came from a keyboard shortcut —
  // otherwise the user gets trapped in the terminal and can't keep navigating.
  useEffect(() => {
    if (visible && !suspended && termRef.current) {
      const skipFocus = isKeyboardNavActive();
      termRef.current.scrollToBottom();
      if (!skipFocus) termRef.current.focus();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const fit = fitRef.current;
        const term = termRef.current;
        const w = wsRef.current;
        if (fit && term) {
          fit.fit();
          // WebGL may discard a hidden canvas texture. Repaint the complete
          // local buffer immediately instead of waiting for the next changed row.
          term.refresh(0, term.rows - 1);
          if (!passiveResizeRef.current && w && w.readyState === WebSocket.OPEN) {
            w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            // A terminal tab can contain a full-screen TUI even when the
            // session metadata says "Terminal". Its bounded raw replay may end
            // with only a spinner/status-line update, so request a rendered tmux
            // snapshot for every visible tab. Do not clear locally first: the
            // server snapshot carries its own clear sequence, while a failed or
            // unavailable capture leaves the existing screen intact.
            if (cliTypeRef.current === 'codex') {
              if (displayRefreshTimer.current) clearTimeout(displayRefreshTimer.current);
              displayRefreshTimer.current = setTimeout(() => {
                displayRefreshTimer.current = null;
                if (!cancelled && w.readyState === WebSocket.OPEN) {
                  w.send(JSON.stringify({ type: 'refresh' }));
                }
              }, 500);
            }
          }
          term.scrollToBottom();
          if (!skipFocus) term.focus();
        }
      });
      return () => {
        cancelled = true;
        if (displayRefreshTimer.current) {
          clearTimeout(displayRefreshTimer.current);
          displayRefreshTimer.current = null;
        }
      };
    }
  }, [visible, suspended]);

  // Re-focus terminal when returning from a different browser tab
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && visible && !suspended && termRef.current) {
        const term = termRef.current;
        term.focus();
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          term.refresh(0, term.rows - 1);
          term.scrollToBottom();
          term.focus();
        });
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [visible, suspended]);


  // Voice command / external refresh event — shares the hardRefresh path so
  // voice "refresh terminal" and the refresh button behave identically.
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      hardRefresh();
    };
    window.addEventListener('agentmanager:refresh-terminal', handler);
    return () => window.removeEventListener('agentmanager:refresh-terminal', handler);
  }, [sessionId, hardRefresh]);

  // Focus terminal on demand (e.g. switching from grid to single view)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      const term = termRef.current;
      if (term) {
        term.scrollToBottom();
        term.focus();
      }
    };
    window.addEventListener('agentmanager:focus-terminal', handler);
    return () => window.removeEventListener('agentmanager:focus-terminal', handler);
  }, [sessionId]);

  return (
    <div className="h-full relative group/terminal" onClick={() => termRef.current?.focus()}>
      <div className="absolute top-2 right-5 z-10 flex items-center gap-2">
        {connected && !suspended && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                Array.from(e.currentTarget.files || []).forEach(file => uploadFileRef.current(file));
                e.currentTarget.value = '';
              }}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Attach images or files"
              aria-label="Attach images or files"
            >
              <Paperclip className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current > 6) {
                  term.options.fontSize = current - 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    // Force PTY redraw via SIGWINCH toggle
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom out"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                const term = termRef.current;
                const fit = fitRef.current;
                const w = wsRef.current;
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current < 32) {
                  term.options.fontSize = current + 1;
                  fit?.fit();
                  if (w && w.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                    setTimeout(() => {
                      w.send(JSON.stringify({ type: 'resize', cols: term.cols - 1, rows: term.rows }));
                      setTimeout(() => w.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })), 50);
                    }, 50);
                  }
                }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              title="Zoom in"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={async () => {
                try {
                  const result = await api.sessions.popOut(sessionId);
                  if (result.ok) onPopOut?.();
                } catch { /* ignore */ }
              }}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--accent)', color: 'white' }}
              title="Pop out to system terminal"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
            <button
              onClick={hardRefresh}
              className="flex items-center gap-1 px-1.5 py-1 rounded text-xs transition-all opacity-70 hover:!opacity-100"
              style={{ background: 'var(--accent)', color: 'white' }}
              title="Refresh terminal display"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </>
        )}
        {!connected && !suspended && (
          <>
            {onReconnect && (
              <button onClick={onReconnect}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors"
                style={{ background: 'var(--accent)', color: 'white' }}>
                <RotateCcw className="w-3 h-3" /> Reconnect
              </button>
            )}
            <div className="px-2 py-1 rounded text-xs" style={{ background: 'var(--error)', color: 'white' }}>
              Disconnected
            </div>
          </>
        )}
      </div>
      <div
        ref={containerRef}
        className={`h-full w-full overflow-hidden${hideCursor && cliType === 'codex' ? ' hide-xterm-cursor' : ''}`}
        style={{
          padding: '4px',
          background: '#0f1117',
        }}
      />
      {uploads.length > 0 && (
        <div className="absolute bottom-3 right-3 z-20 flex flex-col gap-2 pointer-events-none" style={{ maxWidth: '260px' }}>
          {uploads.map(u => (
            <div
              key={u.id}
              className="rounded-md px-3 py-2 shadow-lg text-xs"
              style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            >
              <div className="flex items-center gap-2">
                {u.phase === 'done' ? (
                  <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--success)' }} />
                ) : u.phase === 'error' ? (
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--error)' }} />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                )}
                <span className="truncate flex-1" title={u.name}>{u.name}</span>
                {u.phase === 'uploading' && u.determinate && (
                  <span className="tabular-nums opacity-70">{u.percent}%</span>
                )}
              </div>
              {u.phase === 'error' ? (
                <div className="mt-1 text-[11px]" style={{ color: 'var(--error)' }}>{u.error || 'Upload failed'}</div>
              ) : (
                <>
                  <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                    <div
                      className={`h-full rounded-full${!u.determinate && u.phase !== 'done' ? ' upload-indeterminate' : ''}`}
                      style={{
                        width: u.phase === 'done' ? '100%' : u.determinate ? `${u.percent}%` : '40%',
                        background: u.phase === 'done' ? 'var(--success)' : 'var(--accent)',
                        transition: 'width 0.15s ease-out',
                      }}
                    />
                  </div>
                  <div className="mt-1 text-[11px] opacity-60">
                    {u.phase === 'reading' ? 'Preparing…' : u.phase === 'uploading' ? 'Uploading…' : 'Shared with the session'}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {showHistory && (
        <HistoryViewer sessionId={sessionId} onClose={() => setShowHistory(false)} />
      )}
    </div>
  );
}
