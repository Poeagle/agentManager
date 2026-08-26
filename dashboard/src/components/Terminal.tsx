import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  RotateCcw,
  ExternalLink,
  ZoomIn,
  ZoomOut,
  Loader2,
  Check,
  AlertCircle,
  Paperclip,
  Copy,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { TerminalInputBuffer } from '../lib/terminal-input-buffer';
import { extractComposerDraft, NativePromptBridge } from '../lib/native-prompt-bridge';
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
  const focusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text, focusTarget));
    return;
  }
  fallbackCopy(text, focusTarget);
}
function fallbackCopy(text: string, focusTarget: HTMLElement | null) {
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
  } catch { /* nothing more we can do */ }
  finally {
    ta.remove();
    focusTarget?.focus({ preventScroll: true });
  }
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

const WRITE_CHUNK_SIZE = 64 * 1024;
// Recovery snapshots can include the same 10,000 lines that xterm retains as
// scrollback. Keep this above the server's bounded 4 MiB capture so restoring
// history never evicts the leading clear/style state from the parser queue.
const MAX_QUEUED_OUTPUT = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;

function sanitizeTerminalOutput(data: string) {
  let sanitized = data;
  for (const mode of ['1000', '1001', '1002', '1003']) {
    sanitized = sanitized.split(`\u001b[?${mode}h`).join('');
  }
  return sanitized
    .split('\u001b[?1004h').join('')
    .split('\u001b[?1004l').join('');
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

type PromptEnhancementPhase = 'preparing' | 'requesting' | 'applying' | 'complete' | 'error';

interface PromptEnhancementProgress {
  phase: PromptEnhancementPhase;
  message: string;
}

interface PromptEnhancementPreview {
  original: string;
  generated: string;
  enhanced: string;
  sourceVersion: number;
  applying: boolean;
  error?: string;
}

interface PromptReplacementBackup {
  original: string;
  appliedVersion: number;
  restoring: boolean;
  error?: string;
}

interface PromptReplacementResult {
  ok: boolean;
  message?: string;
}

interface PromptInputSelection {
  text: string;
  version: number;
  applying: boolean;
  error?: string;
}

const PROMPT_ENHANCEMENT_STEPS: Array<{ phase: Exclude<PromptEnhancementPhase, 'complete' | 'error'>; label: string }> = [
  { phase: 'preparing', label: '读取当前输入' },
  { phase: 'requesting', label: '请求优化模型' },
  { phase: 'applying', label: '替换终端输入' },
];

interface TerminalProps {
  sessionId: string;
  visible?: boolean;
  /** When true, disconnect the WebSocket and stop receiving data.
   *  Used to yield the session while a global monitor owns the foreground. */
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
  const nativePromptRef = useRef(new NativePromptBridge());
  const enhanceNativePromptRef = useRef<(() => void) | null>(null);
  const replacePromptInputRef = useRef<(data: string) => Promise<PromptReplacementResult>>(
    async () => ({ ok: false, message: '终端尚未连接' }),
  );
  const previewCancelButtonRef = useRef<HTMLButtonElement>(null);
  const previewEditorRef = useRef<HTMLTextAreaElement>(null);
  const [promptEnhancementProgress, setPromptEnhancementProgress] = useState<PromptEnhancementProgress | null>(null);
  const [promptEnhancementPreview, setPromptEnhancementPreview] = useState<PromptEnhancementPreview | null>(null);
  const [promptReplacementBackup, setPromptReplacementBackup] = useState<PromptReplacementBackup | null>(null);
  const [promptInputSelection, setPromptInputSelection] = useState<PromptInputSelection | null>(null);
  const promptInputSelectionRef = useRef<PromptInputSelection | null>(null);
  const promptEnhancementPreviewOpen = promptEnhancementPreview !== null;
  const promptPreviewOpenRef = useRef(false);
  promptPreviewOpenRef.current = promptEnhancementPreviewOpen;

  const updatePromptInputSelection = useCallback((selection: PromptInputSelection | null) => {
    promptInputSelectionRef.current = selection;
    setPromptInputSelection(selection);
  }, []);

  // Read terminal font size from settings
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 30_000,
  });
  const configuredFontSize = Number(settingsData?.settings?.terminal_font_size) || 12;
  const initialFontSizeRef = useRef(configuredFontSize);
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
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const lastSentSizeRef = useRef<{ socket: WebSocket; cols: number; rows: number } | null>(null);
  const appliedCursorRef = useRef<number | null>(null);
  const lastVisibleSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Debounce fresh-screen snapshots when a terminal becomes visible. Hidden
  // WebGL canvases can lose their painted texture, and a truncated raw replay
  // can contain only a TUI's latest status-line redraw.
  const displayRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  isSuspendedRef.current = suspended;

  const sendCurrentSize = useCallback(() => {
    if (passiveResizeRef.current) return;
    const socket = wsRef.current;
    const term = termRef.current;
    if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;

    const previous = lastSentSizeRef.current;
    if (previous?.socket === socket && previous.cols === term.cols && previous.rows === term.rows) return;
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    lastSentSizeRef.current = { socket, cols: term.cols, rows: term.rows };
  }, []);

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
      sendCurrentSize();
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'refresh', history: true }));
      }, 300);
      return;
    }

    if (hideCursorRef.current) {
      // Claude session/agent: match the PTY to our width first and let tmux +
      // Claude reflow, THEN clear and SIGWINCH-toggle so the clean redraw lands
      // in an already-reset buffer. Resetting up-front (the old order) left a
      // gap where the freshly-resized redraw streamed into a buffer we were
      // about to clear — racing the grid's initial resize and re-garbling.
      sendCurrentSize();
      setTimeout(() => {
        if (w.readyState !== WebSocket.OPEN) return;
        term.reset();
        w.send(JSON.stringify({ type: 'refresh', history: true }));
      }, 150);
      return;
    }

    // Plain terminal — reconnect for a fresh server replay.
    term.reset();
    disconnectFnRef.current?.();
    setTimeout(() => connectFnRef.current?.(), 50);
  }, [sendCurrentSize]);

  const closePromptEnhancementPreview = useCallback(() => {
    setPromptEnhancementPreview((preview) => preview?.applying ? preview : null);
    requestAnimationFrame(() => termRef.current?.focus());
  }, []);

  const applyPromptEnhancement = useCallback(async () => {
    const preview = promptEnhancementPreview;
    if (!preview || preview.applying) return;
    if (!preview.enhanced.trim()) {
      setPromptEnhancementPreview({ ...preview, error: '优化结果不能为空，请编辑后再确认替换。' });
      return;
    }
    const current = nativePromptRef.current.snapshot();
    if (!current || current.version !== preview.sourceVersion) {
      setPromptEnhancementPreview({ ...preview, error: '原输入已发生变化，请关闭预览后重新优化。' });
      return;
    }

    setPromptEnhancementPreview({ ...preview, applying: true, error: undefined });
    const result = await replacePromptInputRef.current(preview.enhanced);
    if (!result.ok) {
      setPromptEnhancementPreview((latest) => latest ? {
        ...latest,
        applying: false,
        error: result.message || '替换失败，原输入仍保留。',
      } : latest);
      return;
    }

    nativePromptRef.current.replace(preview.enhanced);
    const applied = nativePromptRef.current.snapshot();
    setPromptReplacementBackup(applied ? {
      original: preview.original,
      appliedVersion: applied.version,
      restoring: false,
    } : null);
    setPromptEnhancementPreview(null);
    setPromptEnhancementProgress(null);
    requestAnimationFrame(() => termRef.current?.focus());
  }, [promptEnhancementPreview]);

  const restoreOriginalPrompt = useCallback(async () => {
    const backup = promptReplacementBackup;
    if (!backup || backup.restoring) return;
    const current = nativePromptRef.current.snapshot();
    if (!current || current.version !== backup.appliedVersion) {
      setPromptReplacementBackup({ ...backup, error: '输入已被继续编辑，无法安全地自动恢复。' });
      return;
    }

    setPromptReplacementBackup({ ...backup, restoring: true, error: undefined });
    const result = await replacePromptInputRef.current(backup.original);
    if (!result.ok) {
      setPromptReplacementBackup((latest) => latest ? {
        ...latest,
        restoring: false,
        error: result.message || '恢复失败，当前输入未改变。',
      } : latest);
      return;
    }

    nativePromptRef.current.replace(backup.original);
    setPromptReplacementBackup(null);
    setPromptEnhancementProgress({ phase: 'complete', message: '原输入已恢复。' });
    requestAnimationFrame(() => termRef.current?.focus());
  }, [promptReplacementBackup]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontSize: initialFontSizeRef.current,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      scrollback: 10000,
      // xterm deliberately skips the cursor's logical line during resize by
      // default because classic shells usually redraw it themselves. Codex's
      // composer does not always redraw on SIGWINCH, so a long in-progress
      // prompt could keep its old width and disappear past the right edge
      // after a tab/layout resize. Reflow it with the rest of the buffer.
      reflowCursorLine: true,
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

    // Input can arrive immediately after selecting a cold tab, before its
    // reconnect/resize/replay handshake reaches `ready`. Keep it locally and
    // flush exactly once when the socket becomes writable.
    let protocolReady = false;
    const pendingTerminalInput = new TerminalInputBuffer();
    let pendingPromptReplacement: {
      requestId: string;
      timeout: ReturnType<typeof setTimeout>;
      resolve: (result: PromptReplacementResult) => void;
    } | null = null;

    const finishPromptReplacement = (result: PromptReplacementResult, requestId?: string) => {
      if (!pendingPromptReplacement || (requestId && pendingPromptReplacement.requestId !== requestId)) return;
      clearTimeout(pendingPromptReplacement.timeout);
      const { resolve } = pendingPromptReplacement;
      pendingPromptReplacement = null;
      resolve(result);
    };

    replacePromptInputRef.current = (data: string) => new Promise((resolve) => {
      const socket = wsRef.current;
      if (!visibleRef.current || isSuspendedRef.current || !protocolReady
        || !socket || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, message: '终端尚未就绪，原输入未改变。' });
        return;
      }
      if (pendingPromptReplacement) {
        resolve({ ok: false, message: '已有输入替换正在进行，请稍候。' });
        return;
      }

      const requestId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        finishPromptReplacement({ ok: false, message: '终端未确认替换，原输入状态未知，请勿直接提交。' }, requestId);
      }, 8_000);
      pendingPromptReplacement = { requestId, timeout, resolve };
      try {
        socket.send(JSON.stringify({
          type: 'replace-input',
          requestId,
          data,
          clearMode: cliTypeRef.current === 'codex' || cliTypeRef.current === 'claude' ? 'composer' : 'shell',
        }));
      } catch {
        finishPromptReplacement({ ok: false, message: '终端连接已断开，原输入状态未知，请检查输入框。' }, requestId);
      }
    });

    const sendTerminalInput = (data: string, paste = false): boolean => {
      if (!data) return true;
      const w = wsRef.current;
      if (w?.readyState === WebSocket.OPEN) {
        try {
          // The server has its own bounded pre-ready queue, so an OPEN socket
          // can safely accept input while resize/recovery is completing.
          w.send(JSON.stringify({ type: 'input', data, ...(paste ? { paste: true } : {}) }));
          return true;
        } catch {
          // Preserve the input locally if the socket closed between the state
          // check and send(). It will flush after the next ready message.
        }
      }
      // A hidden terminal must never receive a paste left over from stale DOM
      // focus. The newly visible terminal will own the next browser event.
      if (!visibleRef.current) return false;
      return pendingTerminalInput.enqueue({ data, paste });
    };
    const sendTrackedTerminalInput = (data: string, paste = false): boolean => {
      const sent = sendTerminalInput(data, paste);
      if (sent) {
        nativePromptRef.current.record(data, paste);
      } else {
        nativePromptRef.current.invalidate();
      }
      return sent;
    };

    const captureNativePrompt = () => {
      const snapshot = nativePromptRef.current.snapshot();
      if (snapshot || (cliTypeRef.current !== 'codex' && cliTypeRef.current !== 'claude')) return snapshot;

      const buffer = term.buffer?.active;
      const currentRow = buffer && Number.isInteger(buffer.baseY) && Number.isInteger(buffer.cursorY)
        ? buffer.baseY + buffer.cursorY
        : null;
      if (currentRow === null) return null;

      let firstRow = currentRow;
      while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow--;
      const rows: string[] = [];
      for (let row = firstRow; row <= currentRow; row++) {
        const line = buffer.getLine(row);
        if (!line) break;
        rows.push(line.translateToString(true));
      }
      const recovered = extractComposerDraft(rows);
      if (!recovered) return null;
      nativePromptRef.current.replace(recovered);
      return nativePromptRef.current.snapshot();
    };

    let queuedInputAfterPromptReplacement: Array<{ data: string; paste: boolean }> = [];

    const selectAllNativePrompt = (): boolean => {
      if (promptInputSelectionRef.current?.applying) return true;
      const snapshot = captureNativePrompt();
      if (!snapshot) return false;
      queuedInputAfterPromptReplacement = [];
      updatePromptInputSelection({
        text: snapshot.text,
        version: snapshot.version,
        applying: false,
      });
      term.clearSelection();
      return true;
    };

    const replaceSelectedNativePrompt = (replacement: string, paste = false): boolean => {
      const selection = promptInputSelectionRef.current;
      if (!selection) return false;
      if (selection.applying) {
        if (replacement) queuedInputAfterPromptReplacement.push({ data: replacement, paste });
        return true;
      }

      const current = nativePromptRef.current.snapshot();
      if (!current || current.version !== selection.version) {
        updatePromptInputSelection(null);
        return false;
      }

      updatePromptInputSelection({ ...selection, applying: true, error: undefined });
      void replacePromptInputRef.current(replacement).then((result) => {
        if (!result.ok) {
          queuedInputAfterPromptReplacement = [];
          updatePromptInputSelection({
            ...selection,
            applying: false,
            error: result.message || '操作失败，请检查当前输入。',
          });
          return;
        }
        nativePromptRef.current.replace(replacement);
        updatePromptInputSelection(null);
        const queuedInput = queuedInputAfterPromptReplacement;
        queuedInputAfterPromptReplacement = [];
        for (const input of queuedInput) sendTrackedTerminalInput(input.data, input.paste);
        requestAnimationFrame(() => term.focus());
      });
      return true;
    };

    let enhancementAbort: AbortController | null = null;
    const enhanceNativePrompt = async () => {
      if (!visibleRef.current || isSuspendedRef.current) return;
      if (promptInputSelectionRef.current?.applying) return;
      updatePromptInputSelection(null);
      setPromptEnhancementProgress({ phase: 'preparing', message: '正在读取当前终端输入…' });
      const snapshot = captureNativePrompt();
      if (!snapshot) {
        setPromptEnhancementProgress({ phase: 'error', message: '无法确认当前输入；请先重新输入要优化的内容。' });
        return;
      }
      const controller = new AbortController();
      enhancementAbort?.abort();
      enhancementAbort = controller;
      setPromptEnhancementProgress({ phase: 'requesting', message: '正在请求优化模型…' });
      try {
        const result = await api.promptEnhancer.enhance({ session_id: sessionId, prompt: snapshot.text }, controller.signal);
        const current = nativePromptRef.current.snapshot();
        if (!current || current.version !== snapshot.version) {
          setPromptEnhancementProgress({ phase: 'error', message: '输入已变化，未替换结果。' });
          return;
        }
        if (!result.prompt.trim()) {
          setPromptEnhancementProgress({ phase: 'error', message: '优化模型返回了空内容，原输入未改变。' });
          return;
        }
        setPromptEnhancementProgress(null);
        setPromptEnhancementPreview({
          original: snapshot.text,
          generated: result.prompt,
          enhanced: result.prompt,
          sourceVersion: snapshot.version,
          applying: false,
        });
        term.blur();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setPromptEnhancementProgress({ phase: 'error', message: error instanceof Error ? error.message : '提示词优化失败' });
        }
      } finally {
        if (enhancementAbort === controller) enhancementAbort = null;
      }
    };
    enhanceNativePromptRef.current = () => { void enhanceNativePrompt(); };

    // Give Ctrl+A browser-style semantics for the current CLI composer. The
    // PTY itself only understands Ctrl+A as "move to start", so the browser
    // keeps a short-lived full-draft selection and applies the next edit as one
    // atomic replacement.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const modifier = (e.ctrlKey || e.metaKey) && !e.altKey;
      const key = e.key.toLowerCase();
      if (e.type !== 'keydown') return true;

      if (modifier && !e.shiftKey && key === 'a' && selectAllNativePrompt()) {
        e.preventDefault();
        return false;
      }

      const promptSelection = promptInputSelectionRef.current;
      if (promptSelection && modifier && key === 'c') {
        writeClipboard(promptSelection.text);
        e.preventDefault();
        return false;
      }
      if (promptSelection && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        if (promptSelection.applying) {
          queuedInputAfterPromptReplacement.push({ data: '\x7f', paste: false });
        } else {
          replaceSelectedNativePrompt('');
        }
        return false;
      }
      if (promptSelection && e.key === 'Escape') {
        if (promptSelection.applying) {
          queuedInputAfterPromptReplacement.push({ data: '\x1b', paste: false });
          e.preventDefault();
          return false;
        }
        updatePromptInputSelection(null);
      }

      // Intercept Ctrl+Shift+C to copy xterm's ordinary mouse selection.
      if (e.ctrlKey && e.shiftKey && key === 'c') {
        const terminalSelection = term.getSelection();
        if (terminalSelection) writeClipboard(terminalSelection);
        e.preventDefault();
        queueMicrotask(() => term.focus());
        return false;
      }
      // Text has exactly one delivery path: the browser's native `paste`
      // event below. Reading navigator.clipboard from a zero-delay fallback as
      // well can race Chromium's paste event and submit the same text twice.
      if (modifier && key === 'v') {
        // Returning false keeps xterm from interpreting the key while leaving
        // the browser default intact, so text and files reach pasteHandler.
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
    // becomes part of the tracked native input so the active CLI can inspect it.
    const injectPath = (p?: string) => {
      if (!p) return;
      const needsQuote = /[\s"\\]/.test(p);
      const q = needsQuote ? `"${p.replace(/(["\\])/g, '\\$1')}"` : p;
      if (!replaceSelectedNativePrompt(`${q} `, true)) sendTrackedTerminalInput(`${q} `, true);
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
      if (!visibleRef.current) return;

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
        files.forEach((file) => uploadFile(file));
        return;
      }

      const text = ce.clipboardData?.getData('text/plain') || ce.clipboardData?.getData('text');
      if (text) {
        if (!replaceSelectedNativePrompt(text, true)) sendTrackedTerminalInput(text, true);
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
        Array.from(files).forEach((file) => uploadFile(file));
      }
    };
    dropEl.addEventListener('dragover', dragOverHandler);
    dropEl.addEventListener('drop', dropHandler);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Write a small chunk per frame and wait for xterm's parser callback before
    // scheduling the next one. The bounded queue prevents a noisy background
    // process from turning one frame into a multi-megabyte synchronous parse.
    const writeQueue: Array<{ data: string; cursor?: number }> = [];
    let queuedOutputSize = 0;
    let writeInProgress = false;
    let writeFrame: number | null = null;
    let outputWasDropped = false;
    let disposed = false;

    function scheduleNextWrite() {
      if (disposed || writeInProgress || writeFrame !== null) return;
      if (writeQueue.length === 0) {
        if (outputWasDropped) {
          outputWasDropped = false;
          const socket = wsRef.current;
          if (socket?.readyState === WebSocket.OPEN && visibleRef.current) {
            socket.send(JSON.stringify({ type: 'refresh', history: true }));
          }
        }
        return;
      }

      writeFrame = requestAnimationFrame(() => {
        writeFrame = null;
        if (disposed) return;
        const chunk = writeQueue.shift();
        if (!chunk) return;
        queuedOutputSize -= chunk.data.length;
        writeInProgress = true;
        term.write(chunk.data, () => {
          if (chunk.cursor !== undefined) appliedCursorRef.current = chunk.cursor;
          writeInProgress = false;
          scheduleNextWrite();
        });
      });
    }

    function enqueueOutput(rawData: string, cursor?: number) {
      const data = sanitizeTerminalOutput(rawData);
      if (!data && cursor !== undefined) {
        appliedCursorRef.current = cursor;
        return;
      }
      for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_SIZE) {
        const chunkData = data.slice(offset, offset + WRITE_CHUNK_SIZE);
        const isLastChunk = offset + WRITE_CHUNK_SIZE >= data.length;
        while (queuedOutputSize + chunkData.length > MAX_QUEUED_OUTPUT && writeQueue.length > 0) {
          const dropped = writeQueue.shift();
          if (dropped) queuedOutputSize -= dropped.data.length;
          outputWasDropped = true;
          appliedCursorRef.current = null;
        }
        writeQueue.push({ data: chunkData, ...(isLastChunk && cursor !== undefined ? { cursor } : {}) });
        queuedOutputSize += chunkData.length;
      }
      scheduleNextWrite();
    }

    // Send user input to server
    // Filter out xterm.js focus reporting sequences (\x1b[I = focus in, \x1b[O = focus out)
    // These get sent when terminal gains/loses focus and Claude Code's TUI interprets them as input
    term.onData((data: string) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      const promptSelection = promptInputSelectionRef.current;
      if (promptSelection?.applying) {
        if (data) queuedInputAfterPromptReplacement.push({ data, paste: false });
        return;
      }
      if (promptSelection) {
        // Printable input replaces the full selection, matching a regular text
        // box. Navigation/terminal control sequences cancel the virtual
        // selection and retain their native behavior.
        const hasControlCharacter = Array.from(data).some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
        });
        if (!hasControlCharacter) {
          replaceSelectedNativePrompt(data);
          return;
        }
        updatePromptInputSelection(null);
      }
      sendTrackedTerminalInput(data);
    });

    term.onBinary((data: string) => {
      nativePromptRef.current.invalidate();
      sendTerminalInput(data);
    });

    // WebSocket connection with auto-reconnect
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let intentionalClose = false;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    const quietCloseSockets = new WeakSet<WebSocket>();

    function stopHeartbeat() {
      if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
      if (heartbeatTimeout !== null) clearTimeout(heartbeatTimeout);
      heartbeatInterval = null;
      heartbeatTimeout = null;
    }

    function markSocketAlive(ws: WebSocket) {
      if (wsRef.current !== ws) return;
      if (heartbeatTimeout !== null) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }

    function startHeartbeat(ws: WebSocket) {
      stopHeartbeat();
      heartbeatInterval = setInterval(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN || isSuspendedRef.current) return;
        if (heartbeatTimeout !== null) return;
        ws.send(JSON.stringify({ type: 'ping' }));
        heartbeatTimeout = setTimeout(() => {
          heartbeatTimeout = null;
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) ws.close();
        }, HEARTBEAT_TIMEOUT_MS);
      }, HEARTBEAT_INTERVAL_MS);
    }

    function connectWs() {
      if (disposed || isSuspendedRef.current) return;

      // Close any existing connection first
      const old = wsRef.current;
      if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) {
        quietCloseSockets.add(old);
        old.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (passiveResizeRef.current) params.set('passive', '1');
      params.set('attempt', String(reconnectAttempts));
      if (appliedCursorRef.current !== null) params.set('cursor', String(appliedCursorRef.current));
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal/${sessionId}?${params}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws || disposed) return;
        protocolReady = false;
        setConnected(false);
        startHeartbeat(ws);
        fitAddon.fit();
        // The measured size starts/attaches the server PTY. The connection is
        // usable only after the server's explicit ready acknowledgement.
        sendCurrentSize();
      };

      function markProtocolReady() {
        if (protocolReady || wsRef.current !== ws || disposed) return;
        protocolReady = true;
        reconnectAttempts = 0;
        setConnected(true);
        fitAddon.fit();
        sendCurrentSize();
        if (visibleRef.current && !promptPreviewOpenRef.current) term.focus();
        const bufferedInput = pendingTerminalInput.drain();
        for (let index = 0; index < bufferedInput.length; index++) {
          const input = bufferedInput[index];
          if (ws.readyState !== WebSocket.OPEN) {
            for (const remaining of bufferedInput.slice(index)) pendingTerminalInput.enqueue(remaining);
            break;
          }
          try {
            ws.send(JSON.stringify({
              type: 'input',
              data: input.data,
              ...(input.paste ? { paste: true } : {}),
            }));
          } catch {
            for (const remaining of bufferedInput.slice(index)) pendingTerminalInput.enqueue(remaining);
            break;
          }
        }
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
            sendCurrentSize();
          });
        }
      }

      ws.onmessage = (event) => {
        markSocketAlive(ws);
        try {
          const msg = JSON.parse(event.data);
          switch (msg.type) {
            case 'pong':
              break;
            case 'ready':
              markProtocolReady();
              break;
            case 'input-replaced':
              finishPromptReplacement({ ok: true }, msg.requestId);
              break;
            case 'input-replace-error':
              finishPromptReplacement({ ok: false, message: msg.message || '终端拒绝了输入替换。' }, msg.requestId);
              break;
            case 'output':
              enqueueOutput(msg.data, Number.isSafeInteger(msg.cursor) ? msg.cursor : undefined);
              break;
            case 'recovery':
              if (msg.mode === 'full') {
                writeQueue.length = 0;
                queuedOutputSize = 0;
                appliedCursorRef.current = null;
                term.reset();
              }
              break;
            case 'exit':
              if (msg.reason === 'popped-out') {
                enqueueOutput(`\r\n\x1b[36m[Popped out to system terminal]\x1b[0m\r\n`);
              } else {
                enqueueOutput(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
              }
              intentionalClose = true;
              onExitRef.current?.(msg.exitCode);
              break;
            case 'error':
              finishPromptReplacement({ ok: false, message: msg.message || '终端输入替换失败。' });
              enqueueOutput(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
              protocolReady = false;
              setConnected(false);
              intentionalClose = true;
              break;
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        const isCurrentSocket = wsRef.current === ws;
        if (isCurrentSocket) {
          finishPromptReplacement({ ok: false, message: '终端连接已断开，请检查输入框内容。' });
          wsRef.current = null;
          stopHeartbeat();
          protocolReady = false;
          setConnected(false);
        }
        if (disposed || quietCloseSockets.has(ws) || !isCurrentSocket) return;
        if (intentionalClose) {
          enqueueOutput('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
          return;
        }

        // Exponential backoff reconnect
        if (reconnectAttempts < 30) {
          const delay = Math.min(100 * Math.pow(1.5, reconnectAttempts), 5000);
          reconnectAttempts++;
          if (!passiveResizeRef.current) {
            enqueueOutput(`\r\n\x1b[90m[Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/30)...]\x1b[0m\r\n`);
          }
          reconnectTimer = setTimeout(() => {
            term.clear();
            connectWs();
          }, delay);
        } else {
          enqueueOutput('\r\n\x1b[31m[Connection lost — max reconnect attempts reached]\x1b[0m\r\n');
        }
      };
    }

    function disconnectWs() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      writeQueue.length = 0;
      finishPromptReplacement({ ok: false, message: '终端连接已断开，请检查输入框内容。' });
      queuedOutputSize = 0;
      outputWasDropped = false;
      if (writeFrame !== null) {
        cancelAnimationFrame(writeFrame);
        writeFrame = null;
      }
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        quietCloseSockets.add(ws);
        ws.close();
      }
      stopHeartbeat();
      protocolReady = false;
      setConnected(false);
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
        sendCurrentSize();
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
      disposed = true;
      intentionalClose = true;
      serverAliveListeners.delete(onServerAlive);
      connectFnRef.current = null;
      disconnectFnRef.current = null;
      if (writeFrame !== null) cancelAnimationFrame(writeFrame);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      stopHeartbeat();
      resizeObserver.disconnect();
      pendingTerminalInput.clear();
      enhancementAbort?.abort();
      enhanceNativePromptRef.current = null;
      replacePromptInputRef.current = async () => ({ ok: false, message: '终端尚未连接' });
      finishPromptReplacement({ ok: false, message: '终端已关闭，请检查输入框内容。' });
      pasteTarget.removeEventListener('paste', pasteHandler, { capture: true } as EventListenerOptions);
      if (uploadFileRef.current === uploadFile) uploadFileRef.current = () => {};
      dropEl.removeEventListener('dragover', dragOverHandler);
      dropEl.removeEventListener('drop', dropHandler);
      const socket = wsRef.current;
      if (socket) {
        quietCloseSockets.add(socket);
        socket.close();
      }
      wsRef.current = null;
      term.dispose();
    };
  }, [sendCurrentSize, sessionId, updatePromptInputSelection]);

  // Suspension effect: cold terminals disconnect their transport but retain
  // the painted xterm buffer. Reconnect supplies only the missing display
  // stream when its cursor and geometry are still valid.
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
      connectFnRef.current?.();
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
    if (!term) return;
    if (term.options.fontSize !== configuredFontSize) {
      term.options.fontSize = configuredFontSize;
      fit?.fit();
      sendCurrentSize();
    }
  }, [configuredFontSize, sendCurrentSize]);

  // Re-focus and refit terminal when it becomes visible.
  // Single RAF + short delay ensures DOM layout is settled before measuring.
  useEffect(() => {
    if (visible && !suspended && termRef.current) {
      termRef.current.scrollToBottom();
      if (!promptPreviewOpenRef.current) termRef.current.focus();
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const fit = fitRef.current;
        const term = termRef.current;
        const w = wsRef.current;
        if (fit && term) {
          const previousSize = lastVisibleSizeRef.current;
          fit.fit();
          const geometryChanged = !!previousSize
            && (previousSize.cols !== term.cols || previousSize.rows !== term.rows);
          lastVisibleSizeRef.current = { cols: term.cols, rows: term.rows };
          // WebGL may discard a hidden canvas texture. Repaint the complete
          // local buffer immediately instead of waiting for the next changed row.
          term.refresh(0, term.rows - 1);
          if (!passiveResizeRef.current && w && w.readyState === WebSocket.OPEN) {
            sendCurrentSize();
            // Codex needs a viewport snapshot after an actual geometry change,
            // but a same-size warm tab switch can repaint entirely from xterm's
            // retained local buffer with no server round-trip.
            if (cliTypeRef.current === 'codex' && geometryChanged) {
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
          if (!promptPreviewOpenRef.current) term.focus();
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
  }, [sendCurrentSize, visible, suspended]);

  // Re-focus terminal when returning from a different browser tab
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && visible && !suspended && termRef.current) {
        const term = termRef.current;
        if (!promptPreviewOpenRef.current) term.focus();
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          sendCurrentSize();
          term.refresh(0, term.rows - 1);
          term.scrollToBottom();
          if (!promptPreviewOpenRef.current) term.focus();
        });
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [sendCurrentSize, visible, suspended]);


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

  // The project rail owns the visible ✨ action; this terminal owns the
  // session-specific draft bridge and the safe native replacement.
  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== sessionId) return;
      enhanceNativePromptRef.current?.();
    };
    window.addEventListener('agentmanager:enhance-native-prompt', handler);
    return () => window.removeEventListener('agentmanager:enhance-native-prompt', handler);
  }, [sessionId]);

  useEffect(() => {
    if (!promptEnhancementProgress || (promptEnhancementProgress.phase !== 'complete' && promptEnhancementProgress.phase !== 'error')) return;
    const timeout = setTimeout(() => setPromptEnhancementProgress(null), 4_000);
    return () => clearTimeout(timeout);
  }, [promptEnhancementProgress]);

  useEffect(() => {
    if (!promptEnhancementPreviewOpen) return;
    termRef.current?.blur();
    const frame = requestAnimationFrame(() => {
      const editor = previewEditorRef.current;
      if (editor) {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      } else {
        previewCancelButtonRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [promptEnhancementPreviewOpen]);

  // Focus terminal on demand (e.g. switching from grid to single view)
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId } = (e as CustomEvent).detail;
      if (targetId !== sessionId) return;
      const term = termRef.current;
      if (term) {
        term.scrollToBottom();
        if (!promptPreviewOpenRef.current) term.focus();
      }
    };
    window.addEventListener('agentmanager:focus-terminal', handler);
    return () => window.removeEventListener('agentmanager:focus-terminal', handler);
  }, [sessionId]);

  return (
    <div className="h-full relative group/terminal" onClick={() => {
      if (promptInputSelectionRef.current && !promptInputSelectionRef.current.applying) {
        updatePromptInputSelection(null);
      }
      if (!promptPreviewOpenRef.current) termRef.current?.focus();
    }}>
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
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current > 6) {
                  term.options.fontSize = current - 1;
                  fit?.fit();
                  sendCurrentSize();
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
                if (!term) return;
                const current = term.options.fontSize || 13;
                if (current < 32) {
                  term.options.fontSize = current + 1;
                  fit?.fit();
                  sendCurrentSize();
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
        className="h-full w-full overflow-hidden"
        style={{
          padding: '4px',
          background: '#0f1117',
        }}
      />
      {promptInputSelection && visible && !promptEnhancementPreview && (
        <div
          className="absolute left-3 top-3 z-20 max-w-[min(520px,calc(100%-96px))] rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid rgba(167, 139, 250, 0.5)' }}
          onClick={(event) => event.stopPropagation()}
          role="status"
        >
          <div className="flex items-center gap-2">
            {promptInputSelection.applying
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: '#c4b5fd' }} />
              : promptInputSelection.error
                ? <AlertCircle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--error)' }} />
                : <Check className="h-3.5 w-3.5 shrink-0" style={{ color: '#c4b5fd' }} />}
            <span className="font-medium">
              {promptInputSelection.applying ? '正在更新输入…' : `已全选当前输入（${promptInputSelection.text.length} 字符）`}
            </span>
            {!promptInputSelection.applying && (
              <span className="hidden opacity-70 sm:inline">输入可覆盖，Backspace / Delete 可清空</span>
            )}
            <button
              type="button"
              onClick={() => updatePromptInputSelection(null)}
              disabled={promptInputSelection.applying}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 disabled:opacity-30"
              aria-label="取消全选"
              title="取消全选（Esc）"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {promptInputSelection.error && (
            <div className="mt-1.5" style={{ color: 'var(--error)' }} role="alert">{promptInputSelection.error}</div>
          )}
        </div>
      )}
      {promptEnhancementPreview && visible && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center p-4 sm:p-6"
          style={{ background: 'rgba(8, 10, 15, 0.86)', backdropFilter: 'blur(3px)' }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !promptEnhancementPreview.applying) {
              event.preventDefault();
              closePromptEnhancementPreview();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-enhancement-preview-title"
            className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl shadow-2xl"
            style={{ background: 'var(--bg-secondary)', border: '1px solid #7c3aed' }}
          >
            <header className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="prompt-enhancement-preview-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    提示词优化预览
                  </h2>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ color: '#c4b5fd', background: 'rgba(124, 58, 237, 0.16)', border: '1px solid rgba(167, 139, 250, 0.35)' }}
                  >
                    <ShieldCheck className="h-3 w-3" /> 原输入尚未修改
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  请先比较内容，确认后才会替换终端输入框。
                </p>
              </div>
              <button
                ref={previewCancelButtonRef}
                type="button"
                onClick={closePromptEnhancementPreview}
                disabled={promptEnhancementPreview.applying}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                title="关闭预览（Esc）"
                aria-label="关闭提示词优化预览"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-auto md:grid-cols-2" style={{ background: 'var(--border)' }}>
              <div className="flex min-h-[180px] flex-col p-4" style={{ background: 'var(--bg-secondary)' }}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>原输入</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{promptEnhancementPreview.original.length} 字符</span>
                    <button
                      type="button"
                      onClick={() => writeClipboard(promptEnhancementPreview.original)}
                      className="inline-flex items-center gap-1 text-[10px] opacity-70 hover:opacity-100"
                      style={{ color: 'var(--text-secondary)' }}
                      title="复制原输入"
                    >
                      <Copy className="h-3 w-3" /> 复制
                    </button>
                  </div>
                </div>
                <pre
                  className="min-h-0 flex-1 whitespace-pre-wrap break-words rounded-lg p-3 text-xs leading-5"
                  style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontFamily: 'inherit' }}
                >{promptEnhancementPreview.original}</pre>
              </div>
              <div className="flex min-h-[180px] flex-col p-4" style={{ background: 'var(--bg-secondary)' }}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#c4b5fd' }}>优化结果</span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px] font-medium"
                      style={{ color: '#c4b5fd', background: 'rgba(124, 58, 237, 0.14)', border: '1px solid rgba(167, 139, 250, 0.3)' }}
                    >
                      可编辑
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {promptEnhancementPreview.enhanced !== promptEnhancementPreview.generated && (
                      <button
                        type="button"
                        onClick={() => setPromptEnhancementPreview((preview) => preview ? {
                          ...preview,
                          enhanced: preview.generated,
                          error: undefined,
                        } : preview)}
                        disabled={promptEnhancementPreview.applying}
                        className="inline-flex items-center gap-1 text-[10px] opacity-70 hover:opacity-100 disabled:opacity-40"
                        style={{ color: '#c4b5fd' }}
                        title="撤销手动编辑，恢复模型生成的内容"
                      >
                        <Undo2 className="h-3 w-3" /> 恢复模型结果
                      </button>
                    )}
                    <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>{promptEnhancementPreview.enhanced.length} 字符</span>
                  </div>
                </div>
                <textarea
                  ref={previewEditorRef}
                  value={promptEnhancementPreview.enhanced}
                  onChange={(event) => setPromptEnhancementPreview((preview) => preview ? {
                    ...preview,
                    enhanced: event.target.value,
                    error: undefined,
                  } : preview)}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void applyPromptEnhancement();
                    }
                  }}
                  disabled={promptEnhancementPreview.applying}
                  spellCheck={false}
                  aria-label="编辑优化后的提示词"
                  className="min-h-[180px] flex-1 resize-none whitespace-pre-wrap break-words rounded-lg p-3 text-xs leading-5 outline-none transition-shadow focus:ring-1 focus:ring-violet-500 disabled:cursor-wait disabled:opacity-70"
                  style={{
                    background: 'rgba(124, 58, 237, 0.08)',
                    color: 'var(--text-primary)',
                    border: '1px solid rgba(167, 139, 250, 0.45)',
                    fontFamily: 'inherit',
                    caretColor: '#c4b5fd',
                  }}
                />
                <div className="mt-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  可在此补充或删改内容 · Ctrl / ⌘ + Enter 确认替换
                </div>
              </div>
            </div>

            <footer className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="min-h-4 text-xs" style={{ color: 'var(--error)' }} role="alert">
                {promptEnhancementPreview.error || ''}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => writeClipboard(promptEnhancementPreview.enhanced)}
                  disabled={promptEnhancementPreview.applying}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: 'var(--text-primary)', border: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}
                >
                  <Copy className="h-3.5 w-3.5" /> 复制结果
                </button>
                <button
                  type="button"
                  onClick={closePromptEnhancementPreview}
                  disabled={promptEnhancementPreview.applying}
                  className="h-8 rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  保留原输入
                </button>
                <button
                  type="button"
                  onClick={() => { void applyPromptEnhancement(); }}
                  disabled={promptEnhancementPreview.applying}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold text-white transition-colors disabled:cursor-wait disabled:opacity-70"
                  style={{ background: '#7c3aed', border: '1px solid #8b5cf6' }}
                >
                  {promptEnhancementPreview.applying
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在替换…</>
                    : <><Check className="h-3.5 w-3.5" /> 确认替换</>}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
      {promptReplacementBackup && visible && (
        <div
          className="absolute bottom-3 left-3 z-20 max-w-[min(560px,calc(100%-24px))] rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid rgba(167, 139, 250, 0.45)' }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--success)' }} />
            <span className="font-medium">优化结果已替换</span>
            <button
              type="button"
              onClick={() => { void restoreOriginalPrompt(); }}
              disabled={promptReplacementBackup.restoring}
              className="ml-1 inline-flex items-center gap-1 rounded px-2 py-1 font-medium disabled:cursor-wait disabled:opacity-60"
              style={{ color: '#c4b5fd', border: '1px solid rgba(167, 139, 250, 0.4)' }}
            >
              {promptReplacementBackup.restoring
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Undo2 className="h-3 w-3" />}
              恢复原文
            </button>
            <button
              type="button"
              onClick={() => writeClipboard(promptReplacementBackup.original)}
              disabled={promptReplacementBackup.restoring}
              className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium opacity-75 hover:opacity-100 disabled:opacity-30"
              style={{ color: 'var(--text-secondary)' }}
              title="复制原文"
            >
              <Copy className="h-3 w-3" /> 复制原文
            </button>
            <button
              type="button"
              onClick={() => setPromptReplacementBackup(null)}
              disabled={promptReplacementBackup.restoring}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded opacity-60 hover:opacity-100 disabled:opacity-30"
              aria-label="关闭恢复提示"
              title="关闭"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {promptReplacementBackup.error && (
            <div className="mt-1.5" style={{ color: 'var(--error)' }} role="alert">{promptReplacementBackup.error}</div>
          )}
        </div>
      )}
      {promptEnhancementProgress && visible && (() => {
        const activeStep = PROMPT_ENHANCEMENT_STEPS.findIndex((step) => step.phase === promptEnhancementProgress.phase);
        const isFinal = promptEnhancementProgress.phase === 'complete' || promptEnhancementProgress.phase === 'error';
        const tone = promptEnhancementProgress.phase === 'complete'
          ? 'var(--success)'
          : promptEnhancementProgress.phase === 'error'
            ? 'var(--error)'
            : '#c4b5fd';
        const content = <>
          <div className="flex items-center gap-2">
            {promptEnhancementProgress.phase === 'complete' ? <Check className="h-3.5 w-3.5 shrink-0" />
              : promptEnhancementProgress.phase === 'error' ? <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
            <span className="font-medium">提示词优化</span>
            <span className="opacity-80">{promptEnhancementProgress.message}</span>
          </div>
          {!isFinal && <div className="mt-2 flex items-center gap-1">
            {PROMPT_ENHANCEMENT_STEPS.map((step, index) => <div key={step.phase} className="flex min-w-0 flex-1 items-center gap-1">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: index <= activeStep ? tone : 'var(--border)' }} />
              <span className="truncate text-[10px]" style={{ color: index <= activeStep ? tone : 'var(--text-secondary)' }}>{step.label}</span>
            </div>)}
          </div>}
        </>;
        const sharedClassName = "absolute bottom-3 left-3 z-20 max-w-[min(560px,calc(100%-24px))] rounded-md px-3 py-2 text-xs shadow-lg";
        const sharedStyle = { background: 'var(--bg-tertiary)', color: tone, border: '1px solid var(--border)' };
        return isFinal ? <button type="button" onClick={() => setPromptEnhancementProgress(null)} title="点击关闭提示" className={sharedClassName} style={sharedStyle}>{content}</button>
          : <div className={sharedClassName} style={sharedStyle}>{content}</div>;
      })()}
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
