import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  limitId?: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

export interface CodexWeeklyQuota {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
  planType: string | null;
  checkedAt: string;
  stale?: boolean;
}

const CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 1024 * 1024;
let cached: { value: CodexWeeklyQuota; expiresAt: number } | null = null;
let pending: Promise<CodexWeeklyQuota> | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
let initializing: Promise<void> | null = null;
let nextId = 0;
let failures = 0;
let retryAt = 0;
let lastError: Error | null = null;
const requests = new Map<number, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function stopReader(error: Error): void {
  const previous = child;
  child = null;
  initializing = null;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  requests.clear();
  if (previous && previous.exitCode === null) {
    previous.kill();
    const forceKill = setTimeout(() => {
      if (previous.exitCode === null && previous.signalCode === null) previous.kill('SIGKILL');
    }, 1000);
    forceKill.unref();
    previous.once('close', () => clearTimeout(forceKill));
  }
}

function sendRequest(process: ChildProcessWithoutNullStreams, method: string, params?: unknown): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child === process) stopReader(new Error('读取 Codex 周额度超时'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    requests.set(id, { resolve, reject, timer });
    process.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
      if (error && child === process) stopReader(new Error('Codex 额度读取器连接已关闭'));
    });
  });
}

async function getReader(): Promise<ChildProcessWithoutNullStreams> {
  if (!child) {
    // This reader only needs account APIs. Avoid plugin catalog downloads and
    // telemetry on startup, without changing the user's interactive Codex config.
    const process = spawn('codex', [
      'app-server', '--stdio', '--disable', 'plugins', '--disable', 'apps',
      '-c', 'analytics.enabled=false',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: globalThis.process.env });
    child = process;
    let stdout = '';
    const fail = (message: string) => {
      if (child === process) stopReader(new Error(message));
    };
    process.once('error', () => fail('无法启动 Codex 额度读取器'));
    process.once('close', () => fail('Codex 额度读取器已退出'));
    process.stdin.on('error', () => fail('Codex 额度读取器连接已关闭'));
    process.stderr.resume();
    process.stdout.on('data', (chunk: Buffer) => {
      if (child !== process) return;
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_FRAME_BYTES) {
        fail('Codex 额度响应过大');
        return;
      }
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        const request = requests.get(message.id);
        if (!request) continue; // Ignore notifications and responses to cancelled requests.
        requests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error('Codex 周额度不可用，请确认服务器上的 Codex 已登录'));
        else request.resolve(message.result);
      }
    });
    initializing = sendRequest(process, 'initialize', {
      clientInfo: { name: 'agentmanager-quota', version: '1.0.0' },
    }).then(() => {
      if (child !== process) throw new Error('Codex 额度读取器已退出');
      process.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    });
  }
  const process = child;
  await initializing;
  if (child !== process || !process) throw new Error('Codex 额度读取器已退出');
  return process;
}

function chooseWeeklyWindow(snapshot: RateLimitSnapshot): RateLimitWindow {
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindow => !!window && Number.isFinite(window.usedPercent));
  const exact = windows.find((window) => window.windowDurationMins === 10_080);
  if (exact) return exact;
  const longest = windows
    .filter((window) => (window.windowDurationMins ?? 0) >= 6 * 24 * 60)
    .sort((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0))[0];
  if (!longest) throw new Error('Codex 未返回周额度窗口');
  return longest;
}

export function codexWeeklyQuotaFromResponse(result: any, checkedAt = new Date().toISOString()): CodexWeeklyQuota {
  const snapshot = (result?.rateLimitsByLimitId?.codex ?? result?.rateLimits) as RateLimitSnapshot | undefined;
  if (!snapshot) throw new Error('Codex 未返回额度信息');
  const weekly = chooseWeeklyWindow(snapshot);
  const usedPercent = Math.max(0, Math.min(100, Math.round(weekly.usedPercent)));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: weekly.windowDurationMins!,
    resetsAt: weekly.resetsAt,
    planType: snapshot.planType ?? null,
    checkedAt,
  };
}

export async function readCodexWeeklyQuota(options?: { force?: boolean }): Promise<CodexWeeklyQuota> {
  const now = Date.now();
  if (!options?.force && cached && cached.expiresAt > now) return cached.value;
  if (pending) return pending;
  if (now < retryAt) {
    if (cached) return { ...cached.value, stale: true };
    throw lastError || new Error('Codex 额度读取器正在等待重试');
  }
  pending = (async () => {
    try {
      const process = await getReader();
      const value = codexWeeklyQuotaFromResponse(await sendRequest(process, 'account/rateLimits/read'));
      cached = { value, expiresAt: Date.now() + CACHE_MS };
      failures = 0;
      retryAt = 0;
      lastError = null;
      return value;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Codex 周额度读取失败');
      retryAt = Date.now() + Math.min(CACHE_MS, 30_000 * 2 ** Math.min(failures++, 4));
      stopReader(lastError);
      if (cached) cached.expiresAt = 0;
      if (cached) return { ...cached.value, stale: true };
      throw lastError;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Clear data only; refreshing must not restart the shared reader. */
export function clearCodexQuotaCache(): void {
  cached = null;
}

/** Cancel outstanding reads and stop the subprocess during server shutdown. */
export function shutdownCodexQuotaReader(): void {
  stopReader(new Error('Codex 额度读取器已关闭'));
}
