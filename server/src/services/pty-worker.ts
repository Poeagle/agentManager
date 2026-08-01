/**
 * PTY Worker — runs as a separate child process per session.
 *
 * Handles all blocking PTY/tmux/pipe-pane operations so they don't
 * starve the main Fastify server's event loop.
 *
 * IPC Protocol:
 *   Parent → Worker: spawn, reconnect, input, resize, kill, replay
 *   Worker → Parent: ready, output, exit, error, replay-chunk, replay-end
 */

import * as pty from 'node-pty-prebuilt-multiarch';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync, mkdirSync, createReadStream, readFileSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { ReadStream } from 'fs';
import { buildAgentCommand, buildSessionCommand } from './cli-command.js';

const execFileAsync = promisify(execFile);

/** Build a clean env for user-facing sessions: strip server-specific vars so
 *  they don't leak into user terminals / Claude Code / dev servers.
 *  - NODE_ENV: prevents server's production mode from contaminating user shells
 *  - PORT / AGENTMANAGER_*_PORT: prevents sandbox port assignments from overriding
 *    child project .env files (dotenv won't override existing env vars) */
function sessionEnv(): Record<string, string> {
  const allowedKeys = [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'COLORTERM', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
    'NVM_BIN', 'NVM_DIR', 'FNM_DIR', 'PNPM_HOME', 'VOLTA_HOME', 'BUN_INSTALL',
    'EDITOR', 'VISUAL', 'PAGER',
  ] as const;
  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    AGENTMANAGER_SESSION: '1',
    HEADLESS_WORKERS_DISABLED: '1',
  };
}

const TIMING_LOG = process.env.AGENTMANAGER_TIMING_LOG?.trim() || null;
function tlog(s: string): void {
  if (!TIMING_LOG) return;
  try { appendFileSync(TIMING_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}

/* ================================================================
   Types
   ================================================================ */

interface SpawnMessage {
  type: 'spawn';
  sessionId: string;
  projectPath: string;
  task: string;
  mode: 'session' | 'terminal' | 'agent';
  agentType?: string;
  sessionCommand?: string;
  cliType?: 'claude' | 'codex';
  /** When set, resume this CLI's native conversation instead of launching a
   *  new one: Claude uses `--resume`, Codex uses `resume <uuid>`. */
  resumeSessionId?: string;
  /** When set (fresh Claude launch), pass `--session-id <uuid>` so the server
   *  assigns the conversation id up front instead of guessing it afterwards. */
  assignSessionId?: string;
  /** Durable file written by Codex's SessionStart hook. Its payload contains
   *  the native Codex conversation UUID for this AgentManager session. */
  codexBindingPath?: string;
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
  workingDir?: string;
  /** Project roots this member is not allowed to see. Linux systemd masks
   *  these paths inside the spawned terminal/agent mount namespace. */
  inaccessiblePaths?: string[];
  /** Members must always use the explicit systemd sandbox, even when there are
   * currently no other registered project roots to mask. */
  sandboxRequired?: boolean;
}

interface ReconnectMessage {
  type: 'reconnect';
  sessionId: string;
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
}

interface AdoptMessage {
  type: 'adopt';
  sessionId: string;
  socketPath: string;
  projectPath: string;
  cols: number;
  rows: number;
  useTmux: boolean;
}

type ParentMessage =
  | SpawnMessage
  | ReconnectMessage
  | AdoptMessage
  | { type: 'input'; data: string; bracketedPaste?: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'capture' }
  | { type: 'kill' }
  | { type: 'release' };

/* ================================================================
   tmux helpers (same as session-manager but local to worker)
   ================================================================ */

const TMUX_SERVER = 'agentmanager';
const tmuxBaseArgs = ['-L', TMUX_SERVER];

function tmuxSessionName(sessionId: string): string {
  return `of-${sessionId}`;
}

function sandboxUnitName(sessionId: string): string {
  return `agentmanager-sandbox-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
}

export function buildSandboxCommand(
  sessionId: string,
  projectPath: string,
  program: string,
  args: string[],
  inaccessiblePaths: string[] = [],
  sandboxRequired = false,
): { program: string; args: string[] } {
  if (!sandboxRequired) return { program, args };
  const properties = inaccessiblePaths.flatMap((path) => ['-p', `InaccessiblePaths=${path}`]);
  return {
    program: 'systemd-run',
    args: [
      '--user', '--quiet', '--wait', '--collect', '--pty', '--service-type=exec',
      `--unit=${sandboxUnitName(sessionId)}`,
      `--working-directory=${projectPath}`,
      '-p', 'NoNewPrivileges=yes',
      '-p', 'PrivateTmp=yes',
      '-p', 'PrivateDevices=yes',
      '-p', 'ProtectKernelTunables=yes',
      '-p', 'ProtectKernelModules=yes',
      '-p', 'ProtectControlGroups=yes',
      ...properties,
      '--', program, ...args,
    ],
  };
}

async function stopSandbox(sessionId: string): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'stop', `${sandboxUnitName(sessionId)}.service`]).catch(() => {});
}

/** Find which tmux server hosts a session (checks legacy servers too) */
function findTmuxServer(sessionId: string): string | null {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return server;
    } catch { /* try next */ }
  }
  return null;
}

function tmuxExists(sessionId: string): boolean {
  return findTmuxServer(sessionId) !== null;
}

async function tmuxCreate(
  sessionId: string,
  projectPath: string,
  cols: number,
  rows: number,
  command?: string,
  inaccessiblePaths: string[] = [],
  sandboxRequired = false,
): Promise<void> {
  const name = tmuxSessionName(sessionId);
  if (tmuxExists(sessionId)) {
    try { execFileSync('tmux', [...tmuxBaseArgs, 'kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  const shell = process.env.SHELL || '/bin/bash';
  // Wrap the shell invocation with env -u to strip server-specific vars before
  // the shell starts — tmux new-session -d inherits from the tmux server's env,
  // not the client's, so the env option on execFileAsync alone isn't enough.
  const envCmd = 'env';
  // Disable Claude Code's mouse mode (added in 2.1.18x). Otherwise a mouse
  // drag-select in the browser xterm is delivered to Claude (it enables xterm
  // mouse tracking), which treats it as its own selection and copies it via
  // `tmux load-buffer -w -` — flashing "copied N chars to tmux buffer" and never
  // reaching the user's clipboard — instead of being a native xterm selection the
  // user can highlight and Ctrl+Shift+C out. Any non-empty value disables it.
  const envArgs = ['-u', 'NODE_ENV', '-u', 'PORT', '-u', 'AGENTMANAGER_API_PORT', '-u', 'AGENTMANAGER_DASH_PORT', 'CLAUDE_CODE_DISABLE_MOUSE=1'];
  const baseRunArgs = command
    ? [envCmd, ...envArgs, shell, '-i', '-c', command]
    : [envCmd, ...envArgs, shell, '-i'];
  await stopSandbox(sessionId);
  const sandboxed = buildSandboxCommand(sessionId, projectPath, baseRunArgs[0], baseRunArgs.slice(1), inaccessiblePaths, sandboxRequired);

  await execFileAsync('tmux', [
    ...tmuxBaseArgs, 'new-session', '-d', '-s', name,
    '-x', String(cols), '-y', String(rows),
    sandboxed.program, ...sandboxed.args,
  ], {
    cwd: projectPath,
    env: sessionEnv(),
  });

  // Strip server-specific vars from tmux global env for any future windows/panes
  for (const varName of ['NODE_ENV', 'PORT', 'AGENTMANAGER_API_PORT', 'AGENTMANAGER_DASH_PORT']) {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-environment', '-g', '-u', varName]).catch(() => {});
  }

  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-s', 'terminal-overrides', 'xterm-256color:smcup@:rmcup@']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'status', 'off']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'history-limit', '50000']);
  } catch { /* best effort */ }
}

async function tmuxKill(sessionId: string): Promise<void> {
  const name = tmuxSessionName(sessionId);
  // Kill on whichever server hosts it (may be legacy)
  for (const server of [TMUX_SERVER]) {
    try {
      await execFileAsync('tmux', ['-L', server, 'kill-session', '-t', name]);
      await stopSandbox(sessionId);
      return;
    } catch { /* try next */ }
  }
  await stopSandbox(sessionId);
}

/* ================================================================
   dtach helpers
   ================================================================ */

function dtachSocket(sessionId: string): string {
  return `/tmp/agentmanager-${sessionId}.sock`;
}

function dtachExists(sessionId: string): boolean {
  const sock = dtachSocket(sessionId);
  if (!existsSync(sock)) return false;
  try {
    const stdout = execFileSync('fuser', [sock], { encoding: 'utf8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function dtachCreate(sessionId: string, projectPath: string, command: string, inaccessiblePaths: string[] = [], sandboxRequired = false): Promise<void> {
  const sock = dtachSocket(sessionId);
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch { /* ignore */ }
  }
  const shell = process.env.SHELL || '/bin/bash';
  await stopSandbox(sessionId);
  const sandboxed = buildSandboxCommand(sessionId, projectPath, shell, ['-i', '-c', command], inaccessiblePaths, sandboxRequired);
  await execFileAsync('dtach', [
    '-n', sock, '-Ez', sandboxed.program, ...sandboxed.args,
  ], {
    cwd: projectPath,
    env: sessionEnv(),
  });
}

async function dtachKill(sessionId: string): Promise<void> {
  const sock = dtachSocket(sessionId);
  try {
    const { stdout } = await execFileAsync('fuser', [sock]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
    }
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
      }
    }, 2000);
  } catch { /* fuser failed */ }
  try { unlinkSync(sock); } catch { /* ignore */ }
  await stopSandbox(sessionId);
}

function spawnDirect(msg: SpawnMessage, program: string, args: string[]): pty.IPty {
  const sandboxed = buildSandboxCommand(msg.sessionId, msg.projectPath, program, args, msg.inaccessiblePaths, msg.sandboxRequired);
  return pty.spawn(sandboxed.program, sandboxed.args, {
    name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
    env: sessionEnv(),
  });
}

/* ================================================================
   pipe-pane: capture raw application output via FIFO
   ================================================================ */

const PIPE_PANE_DIR = join(tmpdir(), 'agentmanager-pipes');
mkdirSync(PIPE_PANE_DIR, { recursive: true });

function setupPipePane(sessionId: string, server?: string): { stream: ReadStream; fifoPath: string } | null {
  const name = tmuxSessionName(sessionId);
  const serverArgs = ['-L', server || TMUX_SERVER];
  const fifoPath = join(PIPE_PANE_DIR, `${sessionId}.fifo`);

  try {
    try { unlinkSync(fifoPath); } catch { /* doesn't exist */ }
    execFileSync('mkfifo', [fifoPath]);
    const stream = createReadStream(fifoPath, { encoding: 'utf8' });
    execFileSync('tmux', [...serverArgs, 'pipe-pane', '-O', '-t', name, `cat > ${fifoPath}`]);
    return { stream, fifoPath };
  } catch (err) {
    console.error(`[PTY-WORKER] pipe-pane setup failed for ${sessionId}:`, err);
    try { unlinkSync(fifoPath); } catch { /* ignore */ }
    return null;
  }
}

function cleanupPipePane(sessionId: string, fifoPath?: string): void {
  const name = tmuxSessionName(sessionId);
  const server = findTmuxServer(sessionId) || TMUX_SERVER;
  try { execFileSync('tmux', ['-L', server, 'pipe-pane', '-t', name]); } catch { /* ignore */ }
  const path = fifoPath || join(PIPE_PANE_DIR, `${sessionId}.fifo`);
  try { unlinkSync(path); } catch { /* ignore */ }
}

/* ================================================================
   Terminal response filter
   ================================================================ */

const TERMINAL_RESPONSE_RE = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+n|\x1b\[\d+;\d+R/g;

// Focus reporting sequences — strip from PTY output so TUI programs (Codex)
// can't enable focus reporting on xterm.js.  When focus reporting is active,
// xterm.js sends \x1b[I / \x1b[O on focus/blur, which causes rendering
// corruption when switching terminal tabs or toggling grid/single view.
const FOCUS_REPORT_RE = /\x1b\[\?1004[hl]/g;

/* ================================================================
   Worker state
   ================================================================ */

let ptyProcess: pty.IPty | null = null;
let pipePaneStream: ReadStream | null = null;
let pipePaneFifo: string | null = null;
let currentSessionId: string | null = null;
let hasPipePane = false;
let useTmux = false;
let useDtach = false;
let currentCols = 0;
let currentRows = 0;
let ipcBackpressured = false;
const MAX_WORKER_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_WORKER_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 2;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

interface QueuedWorkerInput {
  data: string;
  bracketedPaste: boolean;
}

export class PendingWorkerControls {
  private inputs: QueuedWorkerInput[] = [];
  private inputBytes = 0;
  private resize: { cols: number; rows: number } | null = null;
  private closeAction: 'kill' | 'release' | null = null;

  constructor(private readonly maxInputBytes = MAX_PENDING_WORKER_INPUT_BYTES) {}

  enqueueInput(data: string, bracketedPaste = false): boolean {
    if (typeof data !== 'string') return false;
    const bytes = Buffer.byteLength(data) + 1;
    if (bytes > this.maxInputBytes - this.inputBytes) return false;
    this.inputs.push({ data, bracketedPaste });
    this.inputBytes += bytes;
    return true;
  }

  setResize(cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)
      || cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) return false;
    this.resize = { cols, rows };
    return true;
  }

  takeResize(): { cols: number; rows: number } | null {
    const resize = this.resize;
    this.resize = null;
    return resize;
  }

  drainInputs(): QueuedWorkerInput[] {
    const inputs = this.inputs;
    this.inputs = [];
    this.inputBytes = 0;
    return inputs;
  }

  clear(): void {
    this.inputs = [];
    this.inputBytes = 0;
    this.resize = null;
    this.closeAction = null;
  }

  requestClose(action: 'kill' | 'release'): void {
    this.inputs = [];
    this.inputBytes = 0;
    this.resize = null;
    if (action === 'kill' || this.closeAction === null) this.closeAction = action;
  }

  get byteLength(): number { return this.inputBytes; }
  get requestedClose(): 'kill' | 'release' | null { return this.closeAction; }
}

interface PausableOutputSource {
  pause(): void;
  resume(): void;
}

export function setOutputSourcePaused(
  paused: boolean,
  hasPipe: boolean,
  pipeSource: PausableOutputSource | null,
  directSource: PausableOutputSource | null,
): void {
  const source = hasPipe ? pipeSource : directSource;
  if (paused) source?.pause();
  else source?.resume();
}

function send(msg: Record<string, unknown>): boolean {
  if (!process.send) return false;
  // State tracking is best-effort during IPC congestion. Display output is
  // preserved; pausing pipe-pane prevents its queue from growing further.
  if (ipcBackpressured && msg.type === 'pty-data') return false;
  try {
    let queuedBehindBackpressure = false;
    const writable = process.send(msg, (err) => {
      if (!queuedBehindBackpressure) return;
      ipcBackpressured = false;
      if (!err) setOutputSourcePaused(false, hasPipePane, pipePaneStream, ptyProcess);
    });
    queuedBehindBackpressure = !writable;
    if (!writable) {
      ipcBackpressured = true;
      setOutputSourcePaused(true, hasPipePane, pipePaneStream, ptyProcess);
    }
    return writable;
  } catch {
    return false;
  }
}

function wireOutput(): void {
  if (!ptyProcess) return;

  ptyProcess.onData((data: string) => {
    if (hasPipePane) {
      // pipe-pane is the display stream; the attached PTY is used only for
      // best-effort process-state tracking.
      send({ type: 'pty-data', data });
    } else {
      // No pipe-pane: PTY output IS the display output.
      // Strip focus reporting sequences so TUIs can't enable focus events on the client xterm.
      const filtered = data.replace(FOCUS_REPORT_RE, '');
      if (filtered) send({ type: 'output', data: filtered, track: true });
    }
  });

  if (pipePaneStream) {
    pipePaneStream.on('data', (chunk: string | Buffer) => {
      const raw = typeof chunk === 'string' ? chunk : chunk.toString();
      const data = raw.replace(FOCUS_REPORT_RE, '');
      if (data) send({ type: 'output', data });
    });

    pipePaneStream.on('error', (err) => {
      console.error(`[PTY-WORKER] pipe-pane stream error:`, err.message);
    });

    pipePaneStream.on('end', () => {
      // pipe-pane writer disconnected — the tmux session may have ended
    });
  }

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      if (currentSessionId) cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
    send({ type: 'exit', exitCode, signal });
    // Give parent time to process the exit message before dying
    setTimeout(() => process.exit(0), 500);
  });
}

/* ================================================================
   Spawn handlers
   ================================================================ */

interface LifecycleReady {
  pid: number;
  tmux?: boolean;
}

async function handleSpawn(msg: SpawnMessage): Promise<LifecycleReady> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;
  currentCols = msg.cols;
  currentRows = msg.rows;
  const shell = process.env.SHELL || '/bin/bash';
  const sessionCmd = msg.sessionCommand || 'claude';
  const cliType = msg.cliType || 'claude';

  try {
    if (msg.mode === 'terminal') {
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, undefined, msg.inaccessiblePaths, msg.sandboxRequired);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, shell, msg.inaccessiblePaths, msg.sandboxRequired);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        ptyProcess = spawnDirect(msg, shell, ['-i']);
      }
    } else if (msg.mode === 'agent' && msg.agentType) {
      // agent mode — launch CLI with --agent flag
      const command = buildAgentCommand(msg.agentType, msg.task, msg.useTmux, sessionCmd, cliType, msg.assignSessionId, msg.codexBindingPath);
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command, msg.inaccessiblePaths, msg.sandboxRequired);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, command, msg.inaccessiblePaths, msg.sandboxRequired);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        ptyProcess = spawnDirect(msg, shell, ['-i', '-c', command]);
      }
    } else {
      // session mode
      if (msg.useTmux) {
        const command = buildSessionCommand(msg.task, true, sessionCmd, cliType, msg.resumeSessionId, msg.assignSessionId, msg.codexBindingPath);
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command, msg.inaccessiblePaths, msg.sandboxRequired);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else if (msg.useDtach) {
        const command = buildSessionCommand(msg.task, false, sessionCmd, cliType, msg.resumeSessionId, msg.assignSessionId, msg.codexBindingPath);
        await dtachCreate(msg.sessionId, msg.projectPath, command, msg.inaccessiblePaths, msg.sandboxRequired);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: sessionEnv(),
        });
      } else {
        const command = buildSessionCommand(msg.task, false, sessionCmd, cliType, msg.resumeSessionId, msg.assignSessionId, msg.codexBindingPath);
        ptyProcess = spawnDirect(msg, shell, ['-i', '-c', command]);
      }
    }

    wireOutput();
    return { pid: ptyProcess.pid };
  } catch (err: any) {
    throw new Error(`Spawn failed: ${err.message}`);
  }
}

async function handleReconnect(msg: ReconnectMessage): Promise<LifecycleReady> {
  const t0 = Date.now();
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;
  currentCols = msg.cols;
  currentRows = msg.rows;

  try {
    const hasTmuxSession = msg.useTmux && tmuxExists(msg.sessionId);
    const hasDtachSession = msg.useDtach && dtachExists(msg.sessionId);
    const log = (s: string) => tlog(s);
    log(`[PTY-WORKER] ${msg.sessionId}: exists_check=${Date.now()-t0}ms`);

    if (!hasTmuxSession && !hasDtachSession) {
      throw new Error('No tmux or dtach session found to reconnect');
    }

    if (hasTmuxSession) {
      const t2 = Date.now();
      const actualServer = findTmuxServer(msg.sessionId) || TMUX_SERVER;
      const serverArgs = ['-L', actualServer];
      const pp = setupPipePane(msg.sessionId, actualServer);
      log(`[PTY-WORKER] ${msg.sessionId}: pipe_pane=${Date.now()-t2}ms (server=${actualServer})`);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      const t3 = Date.now();
      ptyProcess = pty.spawn('tmux', [...serverArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: sessionEnv(),
      });
      log(`[PTY-WORKER] ${msg.sessionId}: pty_spawn=${Date.now()-t3}ms`);
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: sessionEnv(),
      });
    }

    wireOutput();
    console.log(`[PTY-WORKER] ${msg.sessionId}: total_reconnect=${Date.now()-t0}ms`);
    return { pid: ptyProcess.pid, tmux: hasTmuxSession };
  } catch (err: any) {
    console.log(`[PTY-WORKER] ${msg.sessionId}: reconnect_failed=${Date.now()-t0}ms err=${err.message}`);
    throw new Error(`Reconnect failed: ${err.message}`);
  }
}

async function handleAdopt(msg: AdoptMessage): Promise<LifecycleReady> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  currentCols = msg.cols;
  currentRows = msg.rows;

  try {
    // Use -r none on initial attach — the browser's resize will trigger SIGWINCH
    // naturally through tmux, causing the app to redraw at the correct size.
    if (msg.useTmux) {
      await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, `dtach -a ${msg.socketPath} -r none -Ez`);
      await new Promise(r => setTimeout(r, 100));
      const pp = setupPipePane(msg.sessionId);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: sessionEnv(),
      });
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${msg.socketPath} -r none -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: sessionEnv(),
      });
    }

    wireOutput();
    return { pid: ptyProcess.pid };
  } catch (err: any) {
    throw new Error(`Adopt failed: ${err.message}`);
  }
}

function handleInput(data: string, isBracketedPaste = false): void {
  if (!ptyProcess || typeof data !== 'string' || Buffer.byteLength(data) > MAX_WORKER_INPUT_BYTES) return;
  const cleaned = data.replace(TERMINAL_RESPONSE_RE, '');
  if (!cleaned) return;
  if (isBracketedPaste) {
    // Wrap in bracketed paste escape sequences so the shell/readline treats
    // the entire block as pasted text rather than executing each line
    ptyProcess.write(`\x1b[200~${cleaned}\x1b[201~`);
  } else {
    ptyProcess.write(cleaned);
  }
}

function handleResize(cols: number, rows: number): void {
  if (!ptyProcess) return;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || cols < MIN_COLS || cols > MAX_COLS || rows < MIN_ROWS || rows > MAX_ROWS) return;
  if (cols === currentCols && rows === currentRows) return;
  try {
    ptyProcess.resize(cols, rows);
    currentCols = cols;
    currentRows = rows;
  } catch (err) {
    send({ type: 'error', message: `Resize failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

/** Capture the current tmux pane content (with escape sequences) and send via IPC.
 *  This runs in the worker process so the blocking execFileSync doesn't affect
 *  the main server event loop. */
function handleCapture(): void {
  const t0 = Date.now();
  tlog(`[WORKER-CAPTURE] ${currentSessionId}: start`);
  if (!currentSessionId || !useTmux) {
    send({ type: 'capture', data: null });
    return;
  }

  // Pause pipe-pane stream to stop new output messages from entering IPC.
  if (pipePaneStream) pipePaneStream.pause();

  // Wait for any already-queued IPC writes to flush, then send capture.
  // Without this, the parent receives capture ~2.5s late due to output message flood.
  setImmediate(() => {
    const name = tmuxSessionName(currentSessionId!);
    try {
      const output = execFileSync('tmux', [
        ...tmuxBaseArgs, 'capture-pane', '-t', name, '-p', '-e', '-T',
      ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: tmux=${Date.now()-t0}ms, bytes=${output.length}`);
      send({ type: 'capture', data: output });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: sent, total=${Date.now()-t0}ms`);
    } catch {
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: failed, total=${Date.now()-t0}ms`);
      send({ type: 'capture', data: null });
    }

    // Resume pipe-pane after capture is queued
    setImmediate(() => {
      if (pipePaneStream) pipePaneStream.resume();
    });
  });
}

async function handleKill(): Promise<void> {
  // Kill PTY process tree
  if (ptyProcess) {
    const pid = ptyProcess.pid;
    try {
      // Kill descendants first
      try {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
        const children = stdout.trim().split('\n').filter(Boolean).map(Number);
        for (const child of children) {
          try { process.kill(child, 'SIGTERM'); } catch { /* dead */ }
        }
      } catch { /* no children */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* dead */ }
    } catch { /* already dead */ }
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Kill tmux/dtach sessions
  if (currentSessionId) {
    if (useTmux) {
      await tmuxKill(currentSessionId).catch(() => {});
    }
    if (useDtach) {
      await dtachKill(currentSessionId).catch(() => {});
    }
    // Clean up pipe-pane
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/**
 * Release: detach the worker from the tmux/dtach session without killing it.
 * Used by pop-out so an external terminal can attach to the still-running session.
 */
async function handleRelease(): Promise<void> {
  // Kill the PTY process (our tmux attach client / dtach -a client) — this just detaches,
  // the tmux session / dtach master keeps running
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Clean up pipe-pane (external terminal doesn't need it)
  if (currentSessionId && pipePaneStream) {
    pipePaneStream.destroy();
    cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/* ================================================================
   Main IPC message handler
   ================================================================ */

type WorkerPhase = 'idle' | 'starting' | 'ready' | 'closing' | 'closed';
let workerPhase: WorkerPhase = 'idle';
let closeAction: 'kill' | 'release' = 'kill';
const pendingControls = new PendingWorkerControls();

async function startLifecycle(msg: SpawnMessage | ReconnectMessage | AdoptMessage): Promise<void> {
  workerPhase = 'starting';
  try {
    const ready = msg.type === 'spawn'
      ? await handleSpawn(msg)
      : msg.type === 'reconnect'
        ? await handleReconnect(msg)
        : await handleAdopt(msg);

    // A kill/release received while creation was blocked must run against the
    // newly-created PTY/session before this worker exits.
    if ((workerPhase as WorkerPhase) === 'closing') {
      const startupClose = pendingControls.requestedClose || closeAction;
      pendingControls.clear();
      if (startupClose === 'release') await handleRelease();
      else await handleKill();
      workerPhase = 'closed';
      return;
    }

    const resize = pendingControls.takeResize();
    if (resize) handleResize(resize.cols, resize.rows);
    workerPhase = 'ready';
    send({ type: 'ready', ...ready });
    for (const input of pendingControls.drainInputs()) {
      handleInput(input.data, input.bracketedPaste);
    }
  } catch (err) {
    pendingControls.clear();
    workerPhase = 'closing';
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    await handleKill().catch(() => {});
    workerPhase = 'closed';
    setTimeout(() => process.exit(1), 50);
  }
}

function receiveParentMessage(msg: ParentMessage): void {
  if (workerPhase === 'closed') return;

  if (workerPhase === 'idle') {
    if (msg.type === 'spawn' || msg.type === 'reconnect' || msg.type === 'adopt') {
      void startLifecycle(msg);
    } else if (msg.type === 'kill' || msg.type === 'release') {
      workerPhase = 'closed';
      send({ type: 'killed' });
      setTimeout(() => process.exit(0), 50);
    }
    return;
  }

  if (workerPhase === 'starting') {
    if (msg.type === 'input') {
      if (!pendingControls.enqueueInput(msg.data, msg.bracketedPaste)) {
        pendingControls.requestClose('kill');
        workerPhase = 'closing';
        closeAction = 'kill';
        send({ type: 'error', message: 'Pending worker input is too large' });
      }
    } else if (msg.type === 'resize') {
      pendingControls.setResize(msg.cols, msg.rows);
    } else if (msg.type === 'kill' || msg.type === 'release') {
      pendingControls.requestClose(msg.type);
      workerPhase = 'closing';
      closeAction = msg.type;
    } else if (msg.type === 'capture') {
      send({ type: 'capture', data: null });
    }
    return;
  }

  if (workerPhase === 'closing') {
    if (msg.type === 'kill') {
      closeAction = 'kill';
      pendingControls.requestClose('kill');
    }
    return;
  }

  switch (msg.type) {
    case 'input':
      handleInput(msg.data, msg.bracketedPaste);
      break;
    case 'resize':
      handleResize(msg.cols, msg.rows);
      break;
    case 'capture':
      handleCapture();
      break;
    case 'kill':
      workerPhase = 'closing';
      closeAction = 'kill';
      void handleKill().finally(() => { workerPhase = 'closed'; });
      break;
    case 'release':
      workerPhase = 'closing';
      closeAction = 'release';
      void handleRelease().finally(() => { workerPhase = 'closed'; });
      break;
    case 'spawn':
    case 'reconnect':
    case 'adopt':
      send({ type: 'error', message: 'PTY lifecycle is already initialized' });
      break;
  }
}

process.on('message', receiveParentMessage);

// If the parent dies, clean up and exit
process.on('disconnect', () => {
  if (workerPhase === 'starting' || workerPhase === 'closing') {
    pendingControls.requestClose('kill');
    closeAction = 'kill';
    workerPhase = 'closing';
    return;
  }
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }
  if (currentSessionId) {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }
  process.exit(0);
});

// Signal the parent that this worker is ready for messages
send({ type: 'worker-ready' });
