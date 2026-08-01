import dotenv from 'dotenv';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
dotenv.config();

/** Check whether a binary is installed and usable */
function binaryAvailable(name: string): boolean {
  try {
    execFileSync(name, ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    // --help may exit non-zero but the binary exists
    try {
      execFileSync('which', [name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

const wantDtach = process.env.AGENTMANAGER_USE_DTACH !== 'false';
const hasDtach = binaryAvailable('dtach');
const wantTmux = process.env.AGENTMANAGER_USE_TMUX !== 'false';
const hasTmux = binaryAvailable('tmux');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Keep the server loopback-only unless LAN access is explicitly requested. */
export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOST?.trim()) return env.HOST.trim();
  return env.AGENTMANAGER_ALLOW_LAN === 'true' ? '::' : '127.0.0.1';
}

if (wantDtach && !hasDtach) {
  console.warn('  dtach not found — falling back to direct mode. Install with: sudo apt install dtach');
}
if (wantTmux && !hasTmux) {
  console.warn('  tmux not found — plain terminals will use dtach/direct mode. Install with: sudo apt install tmux');
}

export const config = {
  port: parseInt(process.env.PORT || '42010', 10),
  host: resolveListenHost(),
  isDev: process.env.NODE_ENV !== 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
  authToken: process.env.AGENTMANAGER_TOKEN || null,
  secureCookies: process.env.AGENTMANAGER_HTTPS === 'true',
  hookSecret: process.env.AGENTMANAGER_HOOK_SECRET?.trim() || null,
  allowLegacyLocalHooks: process.env.AGENTMANAGER_ALLOW_LEGACY_LOCAL_HOOKS !== 'false',
  loginRateLimitMax: positiveInt(process.env.AGENTMANAGER_LOGIN_RATE_LIMIT_MAX, 5),
  loginRateLimitWindowMs: positiveInt(process.env.AGENTMANAGER_LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  loginBlockMs: positiveInt(process.env.AGENTMANAGER_LOGIN_BLOCK_MS, 60 * 1000),
  eventRateLimitPerMinute: positiveInt(process.env.AGENTMANAGER_EVENT_RATE_LIMIT_PER_MINUTE, 300),
  eventRetentionMax: positiveInt(process.env.AGENTMANAGER_EVENT_RETENTION_MAX, 50_000),
  eventRetentionDays: positiveInt(process.env.AGENTMANAGER_EVENT_RETENTION_DAYS, 30),
  dbPath: process.env.AGENTMANAGER_DB_PATH || (() => {
    const dir = join(homedir(), '.agentmanager');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, 'agentmanager.db');
  })(),
  /** Use dtach to persist sessions across server restarts. Enabled by default, set AGENTMANAGER_USE_DTACH=false to disable. */
  useDtach: wantDtach && hasDtach,
  /** Use tmux for plain terminal sessions. Provides proper resize/reflow handling
   *  and scrollback preservation. Enabled by default, set AGENTMANAGER_USE_TMUX=false to disable. */
  useTmux: wantTmux && hasTmux,
};
