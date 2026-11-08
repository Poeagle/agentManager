import { spawnSync } from 'child_process';

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function processGroupId(pid: number): number | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' });
  const group = Number(result.stdout?.trim());
  return Number.isInteger(group) && group > 0 ? group : null;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  const group = processGroupId(pid);
  if (group === pid) {
    try { process.kill(-pid, signal); } catch { /* process group already exited */ }
  }
  try { process.kill(pid, signal); } catch { /* process already exited */ }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

/**
 * Codex app-server owns a managed-daemon control socket outside the requested
 * `--listen` path. Terminating only the PID can unlink the public socket while
 * leaving the process group and control socket alive. The next Engine then
 * fails to start with "control socket is already in use".
 */
export async function terminateDetachedProcess(
  pid: number,
  label: string,
  timeoutMs = 2_500,
): Promise<void> {
  if (!processAlive(pid)) return;
  signalProcess(pid, 'SIGTERM');
  if (await waitForExit(pid, timeoutMs)) return;
  signalProcess(pid, 'SIGKILL');
  if (await waitForExit(pid, 2_000)) return;
  throw Object.assign(
    Error(`${label} 进程 ${pid} 未能退出，已停止启动新 Engine`),
    { statusCode: 409 },
  );
}
