import { FastifyPluginAsync } from 'fastify';
import {
  attachTerminal,
  writeToSession,
  resizeSession,
  reconnectSession,
  getPendingSpawn,
  consumePendingSpawn,
  spawnSession,
  spawnTerminal,
  spawnAdopt,
  spawnAgent,
  sendReplay,
  recoverSessionOnAttach,
  getSession,
  isSessionActive,
  isValidTerminalDimensions,
  subscribeSessionLifecycle,
  waitForSessionLifecycle,
} from '../services/session-manager.js';
import { getDb } from '../db/index.js';
import { readSessionCookie, userCanUseSessionTool } from '../auth.js';
import { registerUserConnection } from '../services/user-connections.js';

const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
const MAX_TERMINAL_MESSAGE_BYTES = MAX_TERMINAL_INPUT_BYTES + 4096;
export const MAX_PENDING_TERMINAL_INPUT_BYTES = 64 * 1024;

export interface PendingTerminalInput {
  data: string;
  paste: boolean;
}

/** Small per-socket queue covering only the spawn/attach handshake window. */
export class PendingTerminalInputQueue {
  private items: PendingTerminalInput[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = MAX_PENDING_TERMINAL_INPUT_BYTES) {}

  enqueue(input: PendingTerminalInput): boolean {
    const bytes = Buffer.byteLength(input.data) + 1;
    if (bytes > this.maxBytes - this.bytes) return false;
    this.items.push(input);
    this.bytes += bytes;
    return true;
  }

  drain(): PendingTerminalInput[] {
    const items = this.items;
    this.items = [];
    this.bytes = 0;
    return items;
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }

  get byteLength(): number {
    return this.bytes;
  }
}

export type TerminalClientMessage =
  | { type: 'input'; data: string; paste: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'refresh'; history: boolean }
  | { type: 'ping' };

export type TerminalMessageParseResult =
  | { ok: true; message: TerminalClientMessage }
  | { ok: false; error: string; closeCode?: number };

/** Runtime validation for the browser-to-PTY boundary. Invalid JSON is never
 * reinterpreted as raw terminal input. */
export function parseTerminalClientMessage(raw: Buffer | string): TerminalMessageParseResult {
  const rawBytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (rawBytes > MAX_TERMINAL_MESSAGE_BYTES) {
    return { ok: false, error: 'Terminal message is too large', closeCode: 1009 };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return { ok: false, error: 'Invalid terminal message' };
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Invalid terminal message' };
  }

  const msg = value as Record<string, unknown>;
  if (msg.type === 'ping') return { ok: true, message: { type: 'ping' } };
  if (msg.type === 'refresh') {
    if (msg.history !== undefined && typeof msg.history !== 'boolean') {
      return { ok: false, error: 'Invalid refresh history flag' };
    }
    return { ok: true, message: { type: 'refresh', history: msg.history === true } };
  }
  if (msg.type === 'resize') {
    if (!isValidTerminalDimensions(msg.cols, msg.rows)) {
      return { ok: false, error: 'Invalid terminal dimensions' };
    }
    return { ok: true, message: { type: 'resize', cols: msg.cols as number, rows: msg.rows as number } };
  }
  if (msg.type === 'input') {
    if (typeof msg.data !== 'string') return { ok: false, error: 'Terminal input must be a string' };
    if (Buffer.byteLength(msg.data) > MAX_TERMINAL_INPUT_BYTES) {
      return { ok: false, error: 'Terminal input is too large', closeCode: 1009 };
    }
    if (msg.paste !== undefined && typeof msg.paste !== 'boolean') {
      return { ok: false, error: 'Invalid paste flag' };
    }
    return { ok: true, message: { type: 'input', data: msg.data, paste: msg.paste === true } };
  }
  return { ok: false, error: 'Unsupported terminal message type' };
}

function normalizeMode(mode: string | null | undefined): 'session' | 'terminal' | 'agent' {
  if (mode === 'terminal' || mode === 'agent') return mode;
  return 'session';
}

function normalizeCliType(cliType: string | null | undefined): 'claude' | 'codex' {
  return cliType === 'codex' ? 'codex' : 'claude';
}

function canAccessSession(req: { user?: { id?: string } } | undefined, sessionId: string): boolean {
  if (!req?.user?.id) return false;
  const session = getSession(sessionId);
  if (!session) return false;
  return userCanUseSessionTool(
    req.user.id,
    sessionId,
    normalizeCliType(session.cli_type),
    normalizeMode(session.mode),
  );
}

function socketIsOpen(socket: { readyState: number }): boolean {
  return socket.readyState === 1;
}

function sendJson(socket: { readyState: number; send(data: string): void }, value: unknown): boolean {
  if (!socketIsOpen(socket)) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function protocolError(
  socket: { readyState: number; send(data: string): void; close(code?: number, reason?: string): void },
  error: string,
  closeCode?: number,
): void {
  sendJson(socket, { type: 'error', message: error });
  if (closeCode) {
    try { socket.close(closeCode, error.slice(0, 120)); } catch { /* already closed */ }
  }
}

function markSpawnFailed(sessionId: string): void {
  try {
    getDb().prepare(`
      UPDATE sessions SET status = 'failed', exit_code = -1,
        completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'launching', 'detached')
    `).run(sessionId);
  } catch { /* the route still reports the spawn error */ }
}

async function ensureSessionActive(sessionId: string): Promise<boolean> {
  if (isSessionActive(sessionId)) return true;
  await reconnectSession(sessionId);
  if (isSessionActive(sessionId)) return true;
  return recoverSessionOnAttach(sessionId);
}

/**
 * Terminal WebSocket route. Active clients are not subscribed until their
 * first validated resize has established the browser's real dimensions.
 */
export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Params: { sessionId: string };
    Querystring: { passive?: string; attempt?: string };
  }>('/terminal/:sessionId', { websocket: true }, (socket, req) => {
    const { sessionId } = req.params;
    if (!req.user?.id || !registerUserConnection(req.user.id, readSessionCookie(req), socket)) return;
    if (!canAccessSession(req, sessionId)) {
      try { socket.close(1008, 'Unauthorized'); } catch { /* ignore */ }
      return;
    }

    const isPassive = req.query.passive === '1';
    const pending = getPendingSpawn(sessionId);

    // A passive/grid socket is strictly read-only. It may request a fresh
    // snapshot or perform a liveness ping, but never writes or resizes the PTY.
    if (isPassive) {
      let attached = false;
      let closed = false;
      let unsubscribeLifecycle: (() => void) | null = null;
      socket.once('close', () => {
        closed = true;
        unsubscribeLifecycle?.();
        unsubscribeLifecycle = null;
      });

      socket.on('message', (raw: Buffer | string) => {
        const parsed = parseTerminalClientMessage(raw);
        if (!parsed.ok) return protocolError(socket, parsed.error, parsed.closeCode);
        if (parsed.message.type === 'ping') {
          sendJson(socket, { type: 'pong' });
        } else if (parsed.message.type === 'refresh' && attached) {
          sendReplay(sessionId, socket, true);
        } else if (parsed.message.type === 'input' || parsed.message.type === 'resize') {
          protocolError(socket, 'Passive terminal is read-only');
        }
      });

      const attachPassive = (): boolean => {
        if (closed || !socketIsOpen(socket) || !isSessionActive(sessionId)) return false;
        // A raw replay may start halfway through a TUI control sequence after
        // the bounded journal has rolled over. Subscribe first, then recover
        // from the authoritative current pane whenever tmux is available.
        attached = attachTerminal(sessionId, socket, { skipReplay: true });
        if (attached) sendReplay(sessionId, socket, true, 'screen');
        return attached;
      };

      // A passive thumbnail cannot spawn a pending PTY because it has no real
      // dimensions. Subscribe once and attach when the active socket finishes
      // that session's lifecycle.
      if (pending) {
        unsubscribeLifecycle = subscribeSessionLifecycle(sessionId, (ready) => {
          unsubscribeLifecycle = null;
          if (closed || !socketIsOpen(socket)) return;
          if (!ready) {
            protocolError(socket, 'Session failed to start', 1011);
            return;
          }
          if (!attachPassive()) {
            protocolError(socket, 'Failed to attach terminal', 1011);
            return;
          }
          sendJson(socket, { type: 'ready', sessionId, passive: true });
        });
        sendJson(socket, { type: 'connected', sessionId, awaitingReady: true });
        return;
      }

      void ensureSessionActive(sessionId).then((ready) => {
        if (!ready || closed || !socketIsOpen(socket)) throw new Error('Session not found or not running');
        if (!attachPassive()) throw new Error('Failed to attach terminal');
        sendJson(socket, { type: 'connected', sessionId });
        sendJson(socket, { type: 'ready', sessionId, passive: true });
      }).catch((err) => {
        if (!socketIsOpen(socket)) return;
        markSpawnFailed(sessionId);
        protocolError(socket, err instanceof Error ? err.message : 'Session not found or not running', 1011);
      });
      return;
    }

    let attached = false;
    let attachPromise: Promise<boolean> | null = null;
    const pendingInputs = new PendingTerminalInputQueue();
    socket.once('close', () => pendingInputs.clear());

    const attachAfterFirstResize = (cols: number, rows: number): Promise<boolean> => {
      if (attachPromise) return attachPromise;
      attachPromise = (async () => {
        const info = consumePendingSpawn(sessionId);
        if (info) {
          if (info.mode === 'adopt' && info.socketPath) {
            await spawnAdopt(sessionId, info.socketPath, info.projectPath, info.task, cols, rows);
          } else if (info.mode === 'terminal') {
            await spawnTerminal(sessionId, info.projectPath, cols, rows);
          } else if (info.mode === 'agent' && info.agentType) {
            await spawnAgent(sessionId, info.projectPath, info.task, info.agentType, cols, rows, info.cliType);
          } else {
            await spawnSession(sessionId, info.projectPath, info.task, cols, rows, info.cliType);
          }
        } else if (pending) {
          // Another WebSocket consumed the same pending spawn. Wait for its
          // single-flight operation instead of becoming a permanently blank tab.
          await waitForSessionLifecycle(sessionId);
        } else if (!(await ensureSessionActive(sessionId))) {
          throw new Error('Session not found or not running');
        }

        if (!socketIsOpen(socket)) return false;
        if (!isSessionActive(sessionId)) throw new Error('Session failed to start');

        // For a newly spawned PTY these dimensions are already current, making
        // resizeSession a true no-op. Existing sessions resize before subscribing,
        // so their resize redraw cannot race ahead of the initial replay.
        if (!resizeSession(sessionId, cols, rows)) throw new Error('Failed to resize terminal');
        // Reattaching after a hidden page must start from a complete rendered
        // pane, not the tail of the raw output journal. This applies equally to
        // explicit sessions and to Claude/Codex launched inside Terminal tabs.
        attached = attachTerminal(sessionId, socket, { skipReplay: true });
        if (!attached) throw new Error('Failed to attach terminal');
        sendReplay(sessionId, socket, true, 'history');

        // This ack is the only point at which the browser may enable keyboard
        // input. Inputs that raced with async spawn/attach are flushed in order.
        if (!sendJson(socket, { type: 'ready', sessionId })) {
          pendingInputs.clear();
          return false;
        }
        for (const input of pendingInputs.drain()) {
          if (!writeToSession(sessionId, input.data, input.paste)) {
            throw new Error('Failed to flush pending terminal input');
          }
        }
        return true;
      })().catch((err) => {
        pendingInputs.clear();
        markSpawnFailed(sessionId);
        if (socketIsOpen(socket)) {
          protocolError(socket, err instanceof Error ? err.message : 'Failed to attach terminal', 1011);
        }
        return false;
      });
      return attachPromise;
    };

    socket.on('message', (raw: Buffer | string) => {
      const parsed = parseTerminalClientMessage(raw);
      if (!parsed.ok) return protocolError(socket, parsed.error, parsed.closeCode);
      const msg = parsed.message;

      if (msg.type === 'ping') {
        sendJson(socket, { type: 'pong' });
        return;
      }

      if (msg.type === 'resize') {
        if (!attached) {
          void attachAfterFirstResize(msg.cols, msg.rows);
        } else {
          resizeSession(sessionId, msg.cols, msg.rows);
        }
        return;
      }

      if (msg.type === 'input') {
        if (attached) {
          writeToSession(sessionId, msg.data, msg.paste);
        } else if (!pendingInputs.enqueue({ data: msg.data, paste: msg.paste })) {
          pendingInputs.clear();
          protocolError(socket, 'Pending terminal input is too large', 1009);
        }
        return;
      }

      if (!attached) {
        protocolError(socket, 'Initial terminal resize is required');
      } else if (msg.type === 'refresh') {
        // Routine tab/display refreshes repaint only the viewport so the
        // browser's existing scrollback survives. Full history replacement is
        // reserved for explicit recovery after a local reset or dropped data.
        sendReplay(sessionId, socket, true, msg.history ? 'history' : 'screen');
      }
    });

    // The browser sends its measured resize immediately after open. This
    // handshake only confirms the protocol; it does not subscribe prematurely.
    sendJson(socket, { type: 'connected', sessionId, awaitingResize: true });
  });
};
