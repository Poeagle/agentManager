import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

const nameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const valueSchema = z.string().max(4096).refine(value => !value.includes('\0'), '环境变量不能包含空字符');

export const agentEnvironmentUpdateSchema = z.object({
  values: z.record(nameSchema, valueSchema),
  clear: z.array(nameSchema).max(64).default([]),
}).strict();

export type AgentEnvironmentUpdate = z.infer<typeof agentEnvironmentUpdateSchema>;

function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.aigenius.agentmanager.plist');
}

function launchAgentLabel(): string {
  return 'com.aigenius.agentmanager';
}

/** Each argument is passed verbatim to Foundation, so plistlib avoids shell and
 * XML escaping mistakes while preserving the existing LaunchAgent config. */
function mutateLaunchAgent(values: Record<string, string>, clear: string[]): void {
  const path = launchAgentPath();
  if (!existsSync(path)) throw Object.assign(Error('AgentManager LaunchAgent 未安装，无法持久化环境变量'), { statusCode: 409 });
  const backup = `${path}.bak-env-${Date.now()}`;
  copyFileSync(path, backup);
  const script = [
    'import plistlib, sys',
    `path = ${JSON.stringify(path)}`,
    `values = ${JSON.stringify(values)}`,
    `clear = ${JSON.stringify(clear)}`,
    'with open(path, "rb") as handle:',
    '    data = plistlib.load(handle)',
    'env = data.setdefault("EnvironmentVariables", {})',
    'for key in clear:',
    '    env.pop(key, None)',
    'env.update(values)',
    'with open(path, "wb") as handle:',
    '    plistlib.dump(data, handle, sort_keys=False)',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    try { copyFileSync(backup, path); } catch { /* best effort */ }
    throw Object.assign(Error(result.stderr.slice(0, 500) || '写入 LaunchAgent 环境变量失败'), { statusCode: 500 });
  }
}

function launchAgentEnvironment(): Record<string, string> {
  const path = launchAgentPath();
  if (!existsSync(path)) return {};
  const script = [
    'import json, plistlib, sys',
    `with open(${JSON.stringify(path)}, "rb") as handle:`,
    '    data = plistlib.load(handle)',
    'print(json.dumps(data.get("EnvironmentVariables", {})))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) return {};
  try { return JSON.parse(result.stdout) as Record<string, string>; }
  catch { return {}; }
}

export function managedEnv(name: string): string {
  return launchAgentEnvironment()[name] || process.env[name] || '';
}

export function updateManagedEnvironment(input: unknown): Record<string, string> {
  const parsed = agentEnvironmentUpdateSchema.parse(input);
  mutateLaunchAgent(parsed.values, parsed.clear);
  return launchAgentEnvironment();
}

export function restartAgentManagerForEnvironment(): void {
  const result = spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${launchAgentLabel()}`], { encoding: 'utf8' });
  if (result.status !== 0) throw Object.assign(Error('环境变量已写入，但重启 AgentManager 失败'), { statusCode: 500 });
}

export function readManagedEnvironment(): Record<string, string> {
  return launchAgentEnvironment();
}
