import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSetting } from '../../routes/settings.js';

const execFileAsync = promisify(execFile);
export interface WorkAgent {
  cli_type: 'codex' | 'claude'; label: string;
  status: 'available' | 'unavailable' | 'unknown'; reason: string;
}
const cache = new Map<string, {expires: number; value: Promise<WorkAgent>}>();

export async function detectWorkAgent(cli: WorkAgent['cli_type'], cwd?: string, fresh = false): Promise<WorkAgent> {
  const command = getSetting(`session_${cli}_command`).trim() || cli;
  const shell = process.env.SHELL || '/bin/bash';
  const key = JSON.stringify([cli, command, shell, cwd, process.env.PATH]);
  const previous = cache.get(key);
  if (!fresh && previous && previous.expires > Date.now()) return previous.value;
  const value = (async (): Promise<WorkAgent> => {
    const label = cli === 'codex' ? 'Codex' : 'Claude';
    // Inspect the executable, never run the configured command, CLI or a development task.
    const first = command.match(/^(?:'([^']+)'|"([^"$`]+)"|([^\s'"\\$`;&|<>()]+))(?=\s|$)/);
    const executable = first?.[1] || first?.[2] || first?.[3];
    if (!executable || /[;&|<>`$()\n]/.test(command) || ['env','npx','npm','pnpm','bun','bash','sh','zsh','command','exec'].includes(executable)) {
      return {cli_type: cli, label, status: 'unknown', reason: '使用自定义包装命令，需要在启动时验证；不能仅凭包装程序存在判定 Agent 可用'};
    }
    try {
      // The session also uses an interactive shell; this sees its PATH and aliases.
      await execFileAsync(shell, ['-i', '-c', 'command -v -- "$1" >/dev/null 2>&1', 'platform-agent-probe', executable], {
        cwd, timeout: 3000, maxBuffer: 16384,
      });
      return {cli_type: cli, label, status: 'available', reason: '启动命令可找到；登录、模型权限及运行结果仍由实际启动验证'};
    } catch (error) {
      const missing = [1, 127].includes((error as {code?: number}).code || 0);
      return {cli_type: cli, label, status: missing ? 'unavailable' : 'unknown', reason: missing ? `找不到 ${label} 启动命令，请安装或在平台设置中配置正确的命令` : '命令探测超时或当前 Shell 不可用，需要在启动时验证'};
    }
  })();
  if (cache.size > 100) cache.clear();
  cache.set(key, {expires: Date.now() + 15000, value});
  return value;
}

export async function detectWorkAgents(cwd?: string): Promise<WorkAgent[]> {
  return Promise.all([detectWorkAgent('codex', cwd), detectWorkAgent('claude', cwd)]);
}
