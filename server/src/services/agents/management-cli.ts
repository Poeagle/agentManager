import { execFile } from 'child_process';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { delimiter, isAbsolute, join } from 'path';

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const REDACTIONS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /((?:api[_-]?key|token|secret|authorization|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
];

export function redactOutput(value: string): string {
  return REDACTIONS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
}

export async function findExecutable(command: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._+-]+$/.test(command) && !isAbsolute(command)) return null;
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH || '').split(delimiter).filter(Boolean).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

export function runCli(
  executable: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  return new Promise(resolve => {
    execFile(executable, args, {
      timeout: options.timeout ?? 8_000,
      maxBuffer: 1024 * 1024,
      env: options.env,
      cwd: options.cwd,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const failure = error as NodeJS.ErrnoException & { code?: string | number } | null;
      resolve({
        ok: !error,
        stdout: redactOutput(String(stdout || '')).trim(),
        stderr: redactOutput(String(stderr || '')).trim(),
        code: typeof failure?.code === 'number' ? failure.code : error ? 1 : 0,
      });
    });
  });
}

export function firstVersion(value: string): string | null {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? null;
}
