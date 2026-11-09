import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import WebSocket from 'ws';
import { config } from '../../../config.js';
import { findExecutable } from '../management-cli.js';
import type { AgentOperationReporter } from '../types.js';
import { nativeEngineConfig } from './native-engine-config.js';
import { processAlive, resolveUnixSocketPath, terminateDetachedProcess } from './process-lifecycle.js';

export interface NativeCodexEngineState {
  socket: string;
  pid: number | null;
  startedAt: string | null;
  status: 'ready' | 'warning' | 'error' | 'unavailable';
  statusText: string;
  managed: boolean;
}

interface EngineMetadata {
  owner: 'agentmanager';
  pid: number;
  socket: string;
  startedAt: string;
  executable: string;
}

const legacyNativeLabel = 'com.ymchen.codex-engine';
const shouldTakeOverLaunchAgents = () => !config.isDev && config.takeoverCodexLaunchAgents;

export function nativeCodexEngineSocket(): string {
  return process.env.AGENTMANAGER_CODEX_STREAM_SOCKET?.trim() || config.nativeCodexSocket;
}

function engineDirectory(): string {
  return dirname(nativeCodexEngineSocket());
}

function metadataPath(): string {
  return join(engineDirectory(), 'engine.json');
}

function logPath(): string {
  return join(engineDirectory(), 'engine.log');
}

function readMetadata(): EngineMetadata | null {
  try {
    const value = JSON.parse(readFileSync(metadataPath(), 'utf8')) as Partial<EngineMetadata>;
    return value.owner === 'agentmanager'
      && Number.isInteger(value.pid)
      && typeof value.socket === 'string'
      && typeof value.startedAt === 'string'
      && typeof value.executable === 'string'
      ? value as EngineMetadata
      : null;
  } catch {
    return null;
  }
}

function writeMetadata(value: EngineMetadata | null): void {
  if (!value) {
    try { unlinkSync(metadataPath()); } catch { /* metadata already absent */ }
    return;
  }
  mkdirSync(engineDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(metadataPath(), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function socketPid(socket: string): number | null {
  const resolved = resolveUnixSocketPath(socket);
  if (!resolved) return null;
  const result = spawnSync('lsof', ['-nP', '-Fp', resolved], { encoding: 'utf8' });
  const pid = Number(result.stdout?.match(/^p(\d+)$/m)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processPidForSocket(socket: string): number | null {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  const expectedListen = `--listen unix://${socket}`;
  const line = (result.stdout || '').split('\n').find(item =>
    item.includes(' app-server ')
    && item.includes(expectedListen));
  const pid = Number(line?.trim().split(/\s+/, 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function currentEnginePid(): number | null {
  const socket = nativeCodexEngineSocket();
  return socketPid(socket)
    || processPidForSocket(socket)
    || (() => {
      const pid = readMetadata()?.pid;
      return pid && processAlive(pid) ? pid : null;
    })();
}

function socketReady(socket: string): Promise<boolean> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws+unix://${socket}:/`, { handshakeTimeout: 1000 });
    ws.once('open', () => {
      ws.close();
      resolve(true);
    });
    ws.once('error', () => resolve(false));
  });
}

async function waitForSocket(socket: string, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketReady(socket)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function launchAgentLoaded(label: string): boolean {
  if (process.platform !== 'darwin') return false;
  const target = `gui/${process.getuid?.() ?? ''}/${label}`;
  return spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
}

/** An AgentManager-owned Engine must never lose ownership to launchd KeepAlive. */
function disableLegacyLaunchAgent(label: string): void {
  if (process.platform !== 'darwin') return;
  const target = `gui/${process.getuid?.() ?? ''}/${label}`;
  spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
  spawnSync('launchctl', ['disable', target], { stdio: 'ignore' });
}

export function disableLegacyCodexLaunchAgents(providerIds: string[] = []): void {
  const labels = new Set([
    legacyNativeLabel,
    ...providerIds.map(providerId => `com.ymchen.codex-engine-${providerId}`),
  ]);
  for (const label of labels) disableLegacyLaunchAgent(label);
}

function stateFromProcess(pid: number, metadata: EngineMetadata | null): NativeCodexEngineState {
  const startedAt = metadata?.pid === pid ? metadata.startedAt : null;
  return {
    socket: nativeCodexEngineSocket(),
    pid,
    startedAt,
    status: 'ready',
    statusText: metadata?.pid === pid
      ? `Engine 运行中 · PID ${pid} · 由 AgentManager 管理`
      : `Engine 运行中 · PID ${pid} · 等待 AgentManager 接管`,
    managed: metadata?.pid === pid,
  };
}

export function inspectNativeCodexEngine(): NativeCodexEngineState {
  const socket = nativeCodexEngineSocket();
  const socketOwner = socketPid(socket);
  const pid = socketOwner || processPidForSocket(socket);
  const metadata = readMetadata();
  if (socketOwner && processAlive(socketOwner)) return stateFromProcess(socketOwner, metadata);
  if (metadata?.socket === socket && processAlive(metadata.pid) && resolveUnixSocketPath(socket)) {
    return stateFromProcess(metadata.pid, metadata);
  }
  if (!config.isDev && config.takeoverCodexLaunchAgents && launchAgentLoaded(legacyNativeLabel)) {
    return {
      socket,
      pid,
      startedAt: null,
      status: 'warning',
      statusText: '检测到旧的 Codex LaunchAgent，AgentManager 启动时将接管 Engine',
      managed: false,
    };
  }
  return {
    socket,
    pid,
    startedAt: null,
    status: pid ? 'warning' : 'unavailable',
    statusText: pid ? `Engine 进程 PID ${pid} 存在但 Socket 未就绪` : 'Engine 尚未启动',
    managed: false,
  };
}

async function adoptRunningEngine(): Promise<NativeCodexEngineState> {
  const socket = nativeCodexEngineSocket();
  const pid = socketPid(socket);
  if (!pid || !processAlive(pid) || !(await socketReady(socket))) {
    return inspectNativeCodexEngine();
  }
  const previous = readMetadata();
  if (previous?.pid !== pid || previous.socket !== socket) {
    const command = nativeEngineConfig().command;
    const executable = await findExecutable(command);
    if (!executable) throw Error(`Codex Engine 命令不可执行：${command}`);
    writeMetadata({
      owner: 'agentmanager',
      pid,
      socket,
      startedAt: new Date().toISOString(),
      executable,
    });
  }
  return stateFromProcess(pid, readMetadata());
}

async function terminateEngine(pid: number | null): Promise<void> {
  if (pid) await terminateDetachedProcess(pid, '原生 Codex Engine');
  try { unlinkSync(nativeCodexEngineSocket()); } catch { /* socket already absent */ }
  writeMetadata(null);
}

async function launchEngine(report?: AgentOperationReporter): Promise<NativeCodexEngineState> {
  const launch = nativeEngineConfig();
  report?.({ stage: 'command', message: `校验启动命令：${launch.command}`, progress: 15 });
  const executable = await findExecutable(launch.command);
  if (!executable) throw Object.assign(Error(`Codex Engine 命令不可执行：${launch.command}`), { statusCode: 409 });
  const socket = nativeCodexEngineSocket();
  const stalePid = currentEnginePid();
  if (stalePid) {
    report?.({ stage: 'cleanup', message: `清理未就绪的 Engine 进程 PID ${stalePid}`, progress: 25 });
    await terminateEngine(stalePid);
  }
  report?.({ stage: 'prepare', message: '准备 socket、CODEX_HOME 与启动参数', progress: 30 });
  mkdirSync(engineDirectory(), { recursive: true, mode: 0o700 });
  try { unlinkSync(socket); } catch { /* stale socket absent */ }
  const log = openSync(logPath(), 'a', 0o600);
  const args = [
    'app-server',
    '--listen',
    `unix://${socket}`,
    '--disable',
    'plugins',
    '-c',
    'analytics.enabled=false',
    ...launch.extraArgs,
  ];
  report?.({ stage: 'spawn', message: '启动 Codex app-server', progress: 50 });
  const child = spawn(executable, args, {
    cwd: homedir(),
    env: {
      ...process.env,
      CODEX_HOME: process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
    },
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.unref();
  if (!child.pid) throw Object.assign(Error('Codex Engine 启动失败'), { statusCode: 502 });
  report?.({ stage: 'socket', message: '等待 Engine socket 就绪', progress: 75 });
  const ready = await waitForSocket(socket);
  if (!ready) {
    await terminateEngine(child.pid);
    throw Object.assign(Error(`Codex Engine 未创建可连接的 socket。启动日志：${logPath()}`), { statusCode: 502 });
  }
  const pid = socketPid(socket) || child.pid;
  report?.({ stage: 'confirm', message: '记录 PID 并确认 Engine 状态', progress: 95 });
  writeMetadata({
    owner: 'agentmanager',
    pid,
    socket,
    startedAt: new Date().toISOString(),
    executable,
  });
  child.once('exit', () => {
    const current = readMetadata();
    if (current?.pid === pid || current?.pid === child.pid) writeMetadata(null);
  });
  return stateFromProcess(pid, readMetadata());
}

export async function ensureNativeCodexEngine(
  migrateLegacy = shouldTakeOverLaunchAgents(),
  report?: AgentOperationReporter,
): Promise<NativeCodexEngineState> {
  report?.({ stage: 'inspect', message: '检查现有 Engine 进程与 socket', progress: 5 });
  if (migrateLegacy) {
    report?.({ stage: 'migrate', message: '解除旧的 Codex LaunchAgent', progress: 10 });
    disableLegacyCodexLaunchAgents();
  }
  const current = inspectNativeCodexEngine();
  if (current.status === 'ready') {
    report?.({ stage: 'adopt', message: '接管仍在运行的 Engine', progress: 60 });
    const adopted = await adoptRunningEngine();
    report?.({ stage: 'complete', message: 'Engine 已就绪', progress: 100 });
    return adopted;
  }
  return launchEngine(report);
}

export async function restartNativeCodexEngine(report?: AgentOperationReporter): Promise<NativeCodexEngineState> {
  report?.({ stage: 'inspect', message: '检查当前 Engine 进程', progress: 5 });
  if (shouldTakeOverLaunchAgents()) disableLegacyCodexLaunchAgents();
  report?.({ stage: 'stop', message: '停止当前 Engine', progress: 20 });
  await terminateEngine(currentEnginePid());
  return launchEngine(progress => report?.({ ...progress, progress: 25 + progress.progress * 0.75 }));
}

export function nativeEngineLaunchDescription(): { command: string; args: string[] } {
  const launch = nativeEngineConfig();
  const args = [
    'app-server',
    '--listen',
    `unix://${nativeCodexEngineSocket()}`,
    '--disable',
    'plugins',
    '-c',
    'analytics.enabled=false',
    ...launch.extraArgs,
  ];
  return { command: launch.command, args };
}

export async function stopNativeCodexEngine(report?: AgentOperationReporter): Promise<NativeCodexEngineState> {
  report?.({ stage: 'inspect', message: '检查当前 Engine 进程', progress: 10 });
  if (shouldTakeOverLaunchAgents()) disableLegacyCodexLaunchAgents();
  report?.({ stage: 'stop', message: '停止 Codex app-server', progress: 35 });
  await terminateEngine(currentEnginePid());
  report?.({ stage: 'cleanup', message: '清理 socket 与进程元数据', progress: 85 });
  return inspectNativeCodexEngine();
}
