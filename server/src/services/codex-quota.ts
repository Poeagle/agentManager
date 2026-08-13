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
}

// The global header polls every five seconds. Keep one shared snapshot for that
// interval so multiple open browsers do not each spawn a Codex app-server.
const CACHE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
let cached: { value: CodexWeeklyQuota; expiresAt: number } | null = null;
let pending: Promise<CodexWeeklyQuota> | null = null;

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
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

function fetchCodexWeeklyQuota(): Promise<CodexWeeklyQuota> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error, value?: CodexWeeklyQuota) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('读取 Codex 周额度超时')), REQUEST_TIMEOUT_MS);
    timer.unref();

    child.once('error', () => finish(new Error('无法启动 Codex 额度读取器')));
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex 额度读取器意外退出（${code ?? 'unknown'}）`));
    });
    // Drain stderr without exposing authentication or backend details.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send(child, { method: 'initialized' });
          send(child, { id: 2, method: 'account/rateLimits/read' });
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) {
          finish(new Error('Codex 周额度不可用，请确认服务器上的 Codex 已登录'));
          continue;
        }
        try {
          finish(undefined, codexWeeklyQuotaFromResponse(message.result));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Codex 周额度响应无效'));
        }
      }
    });

    send(child, {
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agentmanager', version: '1.0.0' } },
    });
  });
}

export async function readCodexWeeklyQuota(options?: { force?: boolean }): Promise<CodexWeeklyQuota> {
  const now = Date.now();
  if (!options?.force && cached && cached.expiresAt > now) return cached.value;
  if (pending) return pending;
  pending = fetchCodexWeeklyQuota()
    .then((value) => {
      cached = { value, expiresAt: Date.now() + CACHE_MS };
      return value;
    })
    .finally(() => { pending = null; });
  return pending;
}

export function clearCodexQuotaCache(): void {
  cached = null;
  pending = null;
}
